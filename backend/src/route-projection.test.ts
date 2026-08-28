import { describe, expect, test } from 'vitest';
import { buildRouteIndex, slicePolyline, type LonLat } from './route-projection';

// Metric frame helpers matching the engine's equirectangular constants, so
// offsets have a known size in metres.
const LAT0 = 51.5;
const LON0 = -0.1;
const M_PER_DEG_LAT = 110_540;
const mPerDegLon = (meanLat: number): number => 111_320 * Math.cos((meanLat * Math.PI) / 180);

const latAt = (metres: number): number => LAT0 + metres / M_PER_DEG_LAT;

/** Straight north-south line from s=0 to s=lengthM at LON0. */
const nsLine = (lengthM: number): LonLat[] => [
  [LON0, latAt(0)],
  [LON0, latAt(lengthM)],
];

/** Brute-force reference: project against every segment in the same frame
 * the index uses (mean-lat equirectangular anchored at the first vertex). */
function bruteProject(poly: readonly LonLat[], lon: number, lat: number): { s: number; d: number } {
  const meanLat = poly.reduce((sum, p) => sum + p[1], 0) / poly.length;
  const kx = mPerDegLon(meanLat);
  const ky = M_PER_DEG_LAT;
  const lon0 = poly[0]?.[0] ?? 0;
  const lat0 = poly[0]?.[1] ?? 0;
  const fx = (lon - lon0) * kx;
  const fy = (lat - lat0) * ky;
  let cum = 0;
  let best = { dist2: Infinity, s: 0, sign: 1 };
  for (let i = 0; i < poly.length - 1; i++) {
    const ax = ((poly[i]?.[0] ?? 0) - lon0) * kx;
    const ay = ((poly[i]?.[1] ?? 0) - lat0) * ky;
    const bx = ((poly[i + 1]?.[0] ?? 0) - lon0) * kx;
    const by = ((poly[i + 1]?.[1] ?? 0) - lat0) * ky;
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy);
    const len2 = dx * dx + dy * dy;
    let t = 0;
    if (len2 > 0) t = Math.max(0, Math.min(1, ((fx - ax) * dx + (fy - ay) * dy) / len2));
    const qx = fx - (ax + t * dx);
    const qy = fy - (ay + t * dy);
    const dist2 = qx * qx + qy * qy;
    if (dist2 < best.dist2) {
      best = {
        dist2,
        s: cum + t * len,
        sign: dx * (fy - ay) - dy * (fx - ax) >= 0 ? 1 : -1,
      };
    }
    cum += len;
  }
  return { s: best.s, d: best.sign * Math.sqrt(best.dist2) };
}

/** Deterministic LCG so the exactness sweep is reproducible. */
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

describe('buildRouteIndex', () => {
  test('matches brute force exactly on a zigzag polyline', () => {
    // Hand zigzag: north, east, north, west — corners exercise clamped
    // segment-end projections and sign flips.
    const poly: LonLat[] = [
      [LON0, latAt(0)],
      [LON0, latAt(2000)],
      [LON0 + 1500 / mPerDegLon(51.51), latAt(2000)],
      [LON0 + 1500 / mPerDegLon(51.51), latAt(4000)],
      [LON0, latAt(4000)],
    ];
    const index = buildRouteIndex(poly);
    const rng = makeRng(42);

    for (let i = 0; i < 300; i++) {
      const lon = LON0 - 0.02 + rng() * 0.06;
      const lat = latAt(-500 + rng() * 5000);
      const got = index.projectFix(lon, lat);
      const want = bruteProject(poly, lon, lat);
      expect(Math.abs(got.s - want.s)).toBeLessThan(1e-6);
      expect(Math.abs(got.d - want.d)).toBeLessThan(1e-6);
    }
  });

  test('s progresses monotonically along the route', () => {
    const index = buildRouteIndex(nsLine(10_000));
    let prev = -1;
    for (let s = 0; s <= 10_000; s += 500) {
      const got = index.projectFix(LON0, latAt(s));
      expect(got.s).toBeGreaterThan(prev);
      expect(Math.abs(got.s - s)).toBeLessThan(1); // metre-accurate arc length
      prev = got.s;
    }
  });

  test('d is signed: left of northbound travel is positive', () => {
    const index = buildRouteIndex(nsLine(10_000));
    const west = index.projectFix(LON0 - 100 / mPerDegLon(51.545), latAt(5000));
    expect(west.d).toBeGreaterThan(99);
    expect(west.d).toBeLessThan(101);
    const east = index.projectFix(LON0 + 100 / mPerDegLon(51.545), latAt(5000));
    expect(east.d).toBeLessThan(-99);
  });

  test('a fix 50 km off-route never crashes and reports a genuinely large d', () => {
    const index = buildRouteIndex(nsLine(10_000));
    const got = index.projectFix(LON0 + 0.72, latAt(5000)); // ~50 km east
    expect(Number.isFinite(got.d)).toBe(true);
    expect(Math.abs(got.d)).toBeGreaterThan(49_000);
    const want = bruteProject(nsLine(10_000), LON0 + 0.72, latAt(5000));
    expect(Math.abs(Math.abs(got.d) - Math.abs(want.d))).toBeLessThan(1e-6);
  });

  test('beyond-terminus fixes clamp to s=0 and s=totalLengthM', () => {
    const index = buildRouteIndex(nsLine(10_000));
    expect(index.projectFix(LON0, latAt(-800)).s).toBe(0);
    const past = index.projectFix(LON0, latAt(10_800));
    expect(Math.abs(past.s - index.totalLengthM)).toBeLessThan(1e-9);
  });

  test('rejects a degenerate polyline', () => {
    expect(() => buildRouteIndex([[LON0, LAT0]])).toThrow(/>= 2 points/);
  });
});

describe('slicePolyline', () => {
  test('cuts a metre-addressed slice with interpolated endpoints', () => {
    const slice = slicePolyline(nsLine(10_000), 1000, 2000);
    expect(slice.length).toBe(2);
    const first = slice[0] ?? [0, 0];
    const last = slice[slice.length - 1] ?? [0, 0];
    expect(Math.abs((first[1] - LAT0) * M_PER_DEG_LAT - 1000)).toBeLessThan(1);
    expect(Math.abs((last[1] - LAT0) * M_PER_DEG_LAT - 2000)).toBeLessThan(1);
  });

  test('keeps interior vertices inside the span', () => {
    const poly: LonLat[] = [
      [LON0, latAt(0)],
      [LON0, latAt(1000)],
      [LON0, latAt(2000)],
      [LON0, latAt(3000)],
    ];
    const slice = slicePolyline(poly, 500, 2500);
    // interpolated start + vertices at 1000/2000 + interpolated end
    expect(slice.length).toBe(4);
  });

  test('clamps to the polyline extent', () => {
    const slice = slicePolyline(nsLine(1000), -500, 5000);
    const last = slice[slice.length - 1] ?? [0, 0];
    expect(Math.abs((last[1] - LAT0) * M_PER_DEG_LAT - 1000)).toBeLessThan(1);
  });

  test('returns [] for an empty or inverted-then-empty span', () => {
    expect(slicePolyline(nsLine(1000), 700, 700)).toEqual([]);
    expect(slicePolyline([], 0, 100)).toEqual([]);
  });
});
