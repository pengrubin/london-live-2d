// Pure geometry for bus-diversion detection: project GPS fixes onto learned
// route polylines by arc length, and slice a polyline between two arc lengths.
//
// buildRouteIndex(poly).projectFix(lon, lat) returns
//   s : along-route metres from the polyline start (arc length of the nearest
//       point on the nearest segment)
//   d : SIGNED cross-track metres; positive = fix to the LEFT of the travel
//       direction. Use Math.abs(d) for excursion magnitude.
//
// Geometry is a local equirectangular frame at the polyline's mean latitude —
// error well under 0.1% at route scale (<70 km), far below the ≥50 m
// excursion thresholds this feeds. A uniform grid over segment bounding boxes
// with an expanding-ring search keeps projection ~O(1) per fix; fixes far
// off-route never crash — the ring search is capped and falls back to a
// brute-force scan, returning a genuinely large d.
//
// Ported from the validated prototype (projection-engine.cjs, audit gate
// 8/10 confirmed / 0 garage artifacts) — the algorithm is intentionally
// byte-for-byte equivalent so the online detector inherits its calibration.

const METRES_PER_DEG_LAT = 110_540; // mean; good enough at city latitudes
const METRES_PER_DEG_LON_EQUATOR = 111_320;
const DEFAULT_CELL_SIZE_M = 500;
const MAX_RING_CELLS = 40; // 20 km at 500 m cells before brute-force fallback

export type LonLat = readonly [number, number];

export interface RouteProjection {
  s: number;
  d: number;
}

export interface RouteIndex {
  readonly totalLengthM: number;
  readonly nSegments: number;
  /**
   * Project one fix. The returned object is a SHARED SCRATCH reused between
   * calls (this runs for every vehicle on every poll — per-call allocation
   * would be pure GC pressure): copy `s`/`d` out before the next call.
   */
  projectFix(lon: number, lat: number): RouteProjection;
}

interface BestMatch {
  dist2: number;
  seg: number;
  t: number;
  sign: number;
}

export function buildRouteIndex(poly: readonly LonLat[], cellSizeM?: number): RouteIndex {
  if (!Array.isArray(poly) || poly.length < 2) {
    throw new Error(`buildRouteIndex: polyline needs >= 2 points, got ${poly?.length}`);
  }
  const cellSize = cellSizeM ?? DEFAULT_CELL_SIZE_M;

  // --- local equirectangular frame ---
  let latSum = 0;
  for (const p of poly) latSum += p[1];
  const meanLat = latSum / poly.length;
  const kx = METRES_PER_DEG_LON_EQUATOR * Math.cos((meanLat * Math.PI) / 180);
  const ky = METRES_PER_DEG_LAT;
  const lon0 = poly[0]?.[0] ?? 0;
  const lat0 = poly[0]?.[1] ?? 0;

  // --- segment arrays ---
  const nSeg = poly.length - 1;
  const ax = new Float64Array(nSeg);
  const ay = new Float64Array(nSeg);
  const dx = new Float64Array(nSeg);
  const dy = new Float64Array(nSeg);
  const len = new Float64Array(nSeg);
  const cum = new Float64Array(nSeg); // arc length at segment start

  let running = 0;
  let px = 0;
  let py = 0;
  for (let i = 0; i <= nSeg; i++) {
    const x = ((poly[i]?.[0] ?? 0) - lon0) * kx;
    const y = ((poly[i]?.[1] ?? 0) - lat0) * ky;
    if (i > 0) {
      const j = i - 1;
      ax[j] = px;
      ay[j] = py;
      dx[j] = x - px;
      dy[j] = y - py;
      len[j] = Math.hypot(dx[j] ?? 0, dy[j] ?? 0);
      cum[j] = running;
      running += len[j] ?? 0;
    }
    px = x;
    py = y;
  }
  const totalLengthM = running;

  // --- uniform grid over segment bboxes ---
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < nSeg; i++) {
    const x1 = ax[i] ?? 0;
    const y1 = ay[i] ?? 0;
    const x2 = x1 + (dx[i] ?? 0);
    const y2 = y1 + (dy[i] ?? 0);
    if (Math.min(x1, x2) < minX) minX = Math.min(x1, x2);
    if (Math.min(y1, y2) < minY) minY = Math.min(y1, y2);
    if (Math.max(x1, x2) > maxX) maxX = Math.max(x1, x2);
    if (Math.max(y1, y2) > maxY) maxY = Math.max(y1, y2);
  }
  const gridW = Math.max(1, Math.ceil((maxX - minX) / cellSize));
  const gridH = Math.max(1, Math.ceil((maxY - minY) / cellSize));
  const cells = new Map<number, number[]>(); // cellIdx → segment indices

  const cellOf = (cx: number, cy: number): number => cy * gridW + cx;
  const clampCx = (cx: number): number => (cx < 0 ? 0 : cx >= gridW ? gridW - 1 : cx);
  const clampCy = (cy: number): number => (cy < 0 ? 0 : cy >= gridH ? gridH - 1 : cy);

  for (let i = 0; i < nSeg; i++) {
    const x1 = ax[i] ?? 0;
    const y1 = ay[i] ?? 0;
    const x2 = x1 + (dx[i] ?? 0);
    const y2 = y1 + (dy[i] ?? 0);
    const cx1 = clampCx(Math.floor((Math.min(x1, x2) - minX) / cellSize));
    const cx2 = clampCx(Math.floor((Math.max(x1, x2) - minX) / cellSize));
    const cy1 = clampCy(Math.floor((Math.min(y1, y2) - minY) / cellSize));
    const cy2 = clampCy(Math.floor((Math.max(y1, y2) - minY) / cellSize));
    for (let cy = cy1; cy <= cy2; cy++) {
      for (let cx = cx1; cx <= cx2; cx++) {
        const key = cellOf(cx, cy);
        const list = cells.get(key);
        if (list === undefined) cells.set(key, [i]);
        else list.push(i);
      }
    }
  }

  // Scratch result reused between calls — see the projectFix doc comment.
  const result: RouteProjection = { s: 0, d: 0 };

  function testSegment(i: number, fx: number, fy: number, best: BestMatch): void {
    const ddx = dx[i] ?? 0;
    const ddy = dy[i] ?? 0;
    const rx = fx - (ax[i] ?? 0);
    const ry = fy - (ay[i] ?? 0);
    const len2 = ddx * ddx + ddy * ddy;
    let t = 0;
    if (len2 > 0) {
      t = (rx * ddx + ry * ddy) / len2;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
    }
    const qx = rx - t * ddx;
    const qy = ry - t * ddy;
    const dist2 = qx * qx + qy * qy;
    if (dist2 < best.dist2) {
      best.dist2 = dist2;
      best.seg = i;
      best.t = t;
      // cross-product sign: >0 means the fix is left of the travel direction
      best.sign = ddx * ry - ddy * rx >= 0 ? 1 : -1;
    }
  }

  function projectFix(lon: number, lat: number): RouteProjection {
    const fx = (lon - lon0) * kx;
    const fy = (lat - lat0) * ky;
    const best: BestMatch = { dist2: Infinity, seg: 0, t: 0, sign: 1 };

    const ccx = clampCx(Math.floor((fx - minX) / cellSize));
    const ccy = clampCy(Math.floor((fy - minY) / cellSize));

    // How far outside the grid is the fix? Rings closer than that are useless.
    const gxDist = Math.max(minX - fx, fx - (minX + gridW * cellSize), 0);
    const gyDist = Math.max(minY - fy, fy - (minY + gridH * cellSize), 0);
    const outside = Math.hypot(gxDist, gyDist);
    const maxRing = Math.max(gridW, gridH);

    let resolved = false;
    if (outside <= MAX_RING_CELLS * cellSize) {
      for (let r = 0; r <= maxRing; r++) {
        // Every cell in ring r is at least (r-1)*cellSize metres from the fix
        // (conservative), so once best is closer than that we can stop.
        if (best.dist2 < Infinity) {
          const ringMin = (r - 1) * cellSize;
          if (ringMin > 0 && ringMin * ringMin > best.dist2) {
            resolved = true;
            break;
          }
        }
        if (r > MAX_RING_CELLS && best.dist2 === Infinity) break; // fall back
        const cx1 = ccx - r;
        const cx2 = ccx + r;
        const cy1 = ccy - r;
        const cy2 = ccy + r;
        for (let cy = cy1; cy <= cy2; cy++) {
          if (cy < 0 || cy >= gridH) continue;
          const onYEdge = cy === cy1 || cy === cy2;
          for (let cx = cx1; cx <= cx2; cx++) {
            if (cx < 0 || cx >= gridW) continue;
            if (!onYEdge && cx !== cx1 && cx !== cx2) continue; // ring only
            const list = cells.get(cellOf(cx, cy));
            if (list === undefined) continue;
            for (let li = 0; li < list.length; li++) {
              testSegment(list[li] ?? 0, fx, fy, best);
            }
          }
        }
        if (r === maxRing && best.dist2 < Infinity) resolved = true;
      }
    }

    if (!resolved && best.dist2 === Infinity) {
      // Far off-route (or ring search exhausted): brute-force every segment.
      for (let i = 0; i < nSeg; i++) testSegment(i, fx, fy, best);
    }

    result.s = (cum[best.seg] ?? 0) + best.t * (len[best.seg] ?? 0);
    result.d = best.sign * Math.sqrt(best.dist2);
    return result;
  }

  return { projectFix, totalLengthM, nSegments: nSeg };
}

/**
 * Slice of a polyline between two arc lengths (metres), endpoints
 * interpolated. Used to cut the bypassed [s_exit, s_rejoin] bracket out of a
 * learned polyline for the frontend's red diversion highlight. Arc lengths
 * are measured in the same equirectangular frame as buildRouteIndex, so a
 * bracket produced by projectFix slices back to the matching geometry.
 */
export function slicePolyline(
  poly: readonly LonLat[],
  s0: number,
  s1: number,
): Array<[number, number]> {
  if (poly.length < 2) return [];
  let latSum = 0;
  for (const p of poly) latSum += p[1];
  const kx = METRES_PER_DEG_LON_EQUATOR * Math.cos(((latSum / poly.length) * Math.PI) / 180);
  const ky = METRES_PER_DEG_LAT;

  const cum = new Float64Array(poly.length);
  for (let i = 1; i < poly.length; i++) {
    const ddx = ((poly[i]?.[0] ?? 0) - (poly[i - 1]?.[0] ?? 0)) * kx;
    const ddy = ((poly[i]?.[1] ?? 0) - (poly[i - 1]?.[1] ?? 0)) * ky;
    cum[i] = (cum[i - 1] ?? 0) + Math.hypot(ddx, ddy);
  }
  const total = cum[poly.length - 1] ?? 0;
  const a = Math.max(0, Math.min(s0, s1));
  const b = Math.min(total, Math.max(s0, s1));
  if (b - a < 1e-9) return [];

  const pointAt = (s: number): [number, number] => {
    let lo = 0;
    let hi = poly.length - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if ((cum[mid] ?? 0) <= s) lo = mid;
      else hi = mid;
    }
    const segLen = (cum[hi] ?? 0) - (cum[lo] ?? 0);
    const t = segLen > 0 ? (s - (cum[lo] ?? 0)) / segLen : 0;
    const p0 = poly[lo] ?? [0, 0];
    const p1 = poly[hi] ?? [0, 0];
    return [p0[0] + t * (p1[0] - p0[0]), p0[1] + t * (p1[1] - p0[1])];
  };

  const out: Array<[number, number]> = [pointAt(a)];
  for (let i = 0; i < poly.length; i++) {
    const s = cum[i] ?? 0;
    if (s > a && s < b) {
      const p = poly[i] ?? [0, 0];
      out.push([p[0], p[1]]);
    }
  }
  out.push(pointAt(b));
  return out;
}
