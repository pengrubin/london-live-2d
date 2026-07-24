// COPY of frontend/src/realtime/geometry.ts — keep in sync manually.
// Copied (not cross-imported) because the backend tsc config enables
// noUncheckedIndexedAccess; the only deltas are non-null assertions on
// index accesses whose bounds are already loop-guaranteed.
//
// Planar helpers for positioning trains along baked track polylines.
// Equirectangular approximation is accurate to well under a metre at London scale.

const M_PER_DEG_LAT = 110540;
const M_PER_DEG_LON = 111320 * Math.cos((51.5 * Math.PI) / 180);

export type LngLat = [number, number];

export function metersBetween(a: LngLat, b: LngLat): number {
  const dx = (a[0] - b[0]) * M_PER_DEG_LON;
  const dy = (a[1] - b[1]) * M_PER_DEG_LAT;
  return Math.hypot(dx, dy);
}

export function polylineLength(pts: LngLat[]): number {
  let len = 0;
  for (let i = 0; i < pts.length - 1; i++) len += metersBetween(pts[i]!, pts[i + 1]!);
  return len;
}

export interface PointOnLine {
  lngLat: LngLat;
  bearing: number;
}

/** Point at `frac` (0..1) of the polyline's arc length, with local bearing. */
export function pointAtFraction(pts: LngLat[], frac: number): PointOnLine {
  const total = polylineLength(pts);
  const clamped = Math.max(0, Math.min(1, frac));
  if (total === 0 || pts.length < 2) {
    return { lngLat: pts[0] ?? [0, 0], bearing: 0 };
  }
  let target = clamped * total;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const seg = metersBetween(a, b);
    if (target <= seg || i === pts.length - 2) {
      const t = seg === 0 ? 0 : Math.min(1, target / seg);
      const lngLat: LngLat = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      return { lngLat, bearing: bearingBetween(a, b) };
    }
    target -= seg;
  }
  return { lngLat: pts[pts.length - 1]!, bearing: 0 };
}

const toMeters = (p: LngLat): [number, number] => [
  p[0] * M_PER_DEG_LON,
  p[1] * M_PER_DEG_LAT,
];

/** Arc-length fraction (0..1) of the point on the polyline nearest to `pt`. */
export function projectFraction(pts: LngLat[], pt: LngLat): number {
  const total = polylineLength(pts);
  if (total === 0 || pts.length < 2) return 0;
  const [px, py] = toMeters(pt);
  let best = Infinity;
  let bestArc = 0;
  let arcBefore = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay] = toMeters(pts[i]!);
    const [bx, by] = toMeters(pts[i + 1]!);
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const segLen = Math.sqrt(len2);
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
    const d = Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
    if (d < best) {
      best = d;
      bestArc = arcBefore + segLen * t;
    }
    arcBefore += segLen;
  }
  return bestArc / total;
}

export function bearingBetween(a: LngLat, b: LngLat): number {
  const dx = (b[0] - a[0]) * M_PER_DEG_LON;
  const dy = (b[1] - a[1]) * M_PER_DEG_LAT;
  return ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
}
