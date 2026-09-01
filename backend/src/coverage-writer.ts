// Bus-coverage flow-map artifact — road-segment corridors carrying the TOTAL
// journeys/day of every route traversing them, prebuilt so the frontend
// fetches ONE cacheable GeoJSON instead of ~1800 learned-route files.
//
// Everything here is derived from data already on disk (learned polylines +
// daily rollups), so regeneration is seconds of pure local CPU with zero
// network egress. That is why the schedule needs no staleness dance: build on
// boot only when the artifact is missing, then every 6 h unconditionally — the
// rolling window simply advances as new rollup days complete.
//
// Weights are a ROLLING mean: per-route journeys/day averaged over the newest
// up to 7 COMPLETED rollup days (the current UTC day is skipped — its trace is
// still growing). Days where a route is absent count as 0 (sum is divided by
// the full window length), which smooths weekday/weekend swings instead of
// hiding them.
//
// Assembly is a corridor merge (prototype-validated at STEP=25 m, MATCH=18 m):
// routes are walked busiest-first, each polyline resampled to 25 m pieces; a
// piece landing within 18 m of an already-emitted piece with a compatible
// bearing (same road, either direction) ADDS its route's mean to that piece
// instead of drawing a second line. Same-owner consecutive pieces then merge
// into LineString runs, split where the summed total crosses a bucket edge.
// Buckets are ABSOLUTE journeys/day lower bounds — a corridor's colour means
// the same service level on every rebuild, unlike quantile edges which would
// recolour untouched corridors whenever unrelated routes shift.

import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Simplification tolerance chosen by the prototype: run weights are fixed
 * before simplification, so 5 m only shaves bytes, never changes j/b. */
export const COVERAGE_TOLERANCE_M = 5;
export const COVERAGE_WINDOW_DAYS = 7;
/** Absolute bucket lower bounds in journeys/day (b = index 0..5). */
export const COVERAGE_BUCKET_EDGES = [0, 10, 30, 75, 150, 300] as const;
const COORD_DECIMALS = 4;
/** The inputs are completed daily rollups averaged over a rolling week, so the
 * output cannot change more than once a day. Rebuilding four times a day only
 * bought staleness that did not exist — and each build is the process's
 * largest memory peak, which Railway bills for long after it subsides. */
const REGEN_INTERVAL_MS = 24 * 60 * 60_000;
const ROLLUP_FILE_RE = /^\d{4}-\d{2}-\d{2}\.json$/;
/** Metres per degree of latitude (equirectangular; fine at route scale). */
const M_PER_DEG = 111_320;
// Corridor matching runs in ONE shared equirectangular projection so pieces
// from different routes land in the same metric plane. Its reference latitude
// is derived from the data itself (see buildCoverageArtifact), not hardcoded:
// a fixed 51.5° would distort east-west distances ~45% for a ~25°N deployment
// like Dubai and silently corrupt the 18 m matching there.

// Corridor-merge parameters, fixed by the measured prototype (report-25-18):
// 25 m pieces + 18 m match keep p99 match distance under the carriageway
// width while a 30 m grid bounds each query to a 3×3 neighbourhood.
const STEP_M = 25;
const MATCH_DIST_M = 18;
const BEARING_TOL_DEG = 25; // <=25° same direction, >=155° antiparallel
const CELL_M = 30;

/** Matches the learner's key→filename mapping (learn-bus-routes.mjs), so
 * rollup keys (raw `TFLO:88:outbound`) join learned filenames. */
const sanitizeKey = (key: string): string => key.replace(/[^A-Za-z0-9_.-]/g, '_');

export type LonLat = readonly [number, number];

interface CoverageFeature {
  type: 'Feature';
  /** j: rounded total journeys/day on the corridor; b: bucket index 0..5.
   * The frontend interpolates on `b`, so it MUST stay numeric. */
  properties: { j: number; b: number };
  geometry: { type: 'LineString'; coordinates: Array<[number, number]> };
}

export interface CoverageArtifact {
  type: 'FeatureCollection';
  /** Foreign members: newest completed rollup day + how many days averaged. */
  day: string;
  windowDays: number;
  features: CoverageFeature[];
}

/** Distance from p to the SEGMENT a→b (not the infinite line), in the same
 * planar units as the inputs. */
function segmentDistance(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Douglas-Peucker with a metric tolerance. Endpoints are always preserved.
 * Iterative (explicit stack) so pathological inputs cannot blow the call
 * stack; projection is local equirectangular, accurate at route scale. */
export function simplifyPolyline(poly: readonly LonLat[], toleranceM: number): LonLat[] {
  if (poly.length <= 2) return poly.map(([lon, lat]) => [lon, lat]);
  const meanLatRad =
    (poly.reduce((sum, p) => sum + p[1], 0) / poly.length) * (Math.PI / 180);
  const lonScale = Math.cos(meanLatRad) * M_PER_DEG;
  const px = poly.map((p) => p[0] * lonScale);
  const py = poly.map((p) => p[1] * M_PER_DEG);

  const keep = new Array<boolean>(poly.length).fill(false);
  keep[0] = true;
  keep[poly.length - 1] = true;
  const stack: Array<readonly [number, number]> = [[0, poly.length - 1]];
  while (stack.length > 0) {
    const span = stack.pop();
    if (span === undefined) break;
    const [a, b] = span;
    let maxDist = 0;
    let maxIdx = -1;
    for (let i = a + 1; i < b; i += 1) {
      const d = segmentDistance(
        px[i] ?? 0,
        py[i] ?? 0,
        px[a] ?? 0,
        py[a] ?? 0,
        px[b] ?? 0,
        py[b] ?? 0,
      );
      if (d > maxDist) {
        maxDist = d;
        maxIdx = i;
      }
    }
    if (maxIdx !== -1 && maxDist > toleranceM) {
      keep[maxIdx] = true;
      stack.push([a, maxIdx], [maxIdx, b]);
    }
  }
  return poly.filter((_, i) => keep[i]).map(([lon, lat]) => [lon, lat]);
}

/** 4-decimal quantization: a 0.0001° grid is ≤ ~5.6 m of latitude error —
 * on par with the 5 m simplification tolerance and required to keep the
 * corridor artifact inside its ~1.6 MB brotli budget (5 decimals put the
 * prototype at 3.1 MB). */
export function quantizePolyline(poly: readonly LonLat[]): Array<[number, number]> {
  const factor = 10 ** COORD_DECIMALS;
  return poly.map(([lon, lat]) => [
    Math.round(lon * factor) / factor,
    Math.round(lat * factor) / factor,
  ]);
}

/** Largest bucket whose absolute lower bound the corridor total meets. */
export function assignBucket(total: number): number {
  for (let b = COVERAGE_BUCKET_EDGES.length - 1; b > 0; b -= 1) {
    if (total >= (COVERAGE_BUCKET_EDGES[b] ?? Infinity)) return b;
  }
  return 0;
}

/** Newest up to 7 COMPLETED rollup days, ascending. Today's stamp is excluded
 * defensively — the rollup writer never emits it, but a clock skew must not
 * let a half-day drag the mean down. */
export function selectWindowDays(fileNames: readonly string[], nowMs: number): string[] {
  const today = new Date(nowMs).toISOString().slice(0, 10);
  return fileNames
    .filter((name) => ROLLUP_FILE_RE.test(name))
    .map((name) => name.slice(0, 10))
    .filter((day) => day < today)
    .sort()
    .slice(-COVERAGE_WINDOW_DAYS);
}

/** Rolling mean journeys/day per (sanitized) route key. Absent days count as
 * 0: the sum is divided by the FULL window length, not the days seen. */
export function computeRollingMeans(
  perDayJourneys: ReadonlyArray<ReadonlyMap<string, number>>,
): Map<string, number> {
  const sums = new Map<string, number>();
  for (const day of perDayJourneys) {
    for (const [key, journeys] of day) {
      sums.set(key, (sums.get(key) ?? 0) + journeys);
    }
  }
  const means = new Map<string, number>();
  for (const [key, sum] of sums) {
    means.set(key, sum / perDayJourneys.length);
  }
  return means;
}

// --- corridor piece store -------------------------------------------------
//
// Parallel typed arrays instead of an array of objects, and a single
// last-contributor slot instead of a per-piece Set of route indices: the
// prototype's ~440k Sets cost ~800 MB RSS, while routes are processed one at
// a time, so "the last route to touch this piece" is exactly equivalent to
// full membership for the only question asked ("did THIS route already add
// to THIS piece?").
//
// The guard is deliberately PER PIECE, not per neighbourhood. Consecutive
// 25 m route pieces walking a shared road routinely see the previous piece's
// matched corridor piece still inside the 18 m radius (phase offset < 18 m of
// the 25 m step) alongside the NEXT corridor piece — suppressing the add
// whenever any nearby piece was already touched would therefore skip roughly
// every other piece on shared roads, systematically undercounting exactly the
// corridors this artifact exists to measure. The cost of per-piece scope: a
// route whose own polyline revisits a junction (terminus loops, gyratories)
// can add to a second distinct piece there — which matches the product
// semantics anyway, because those buses really do pass that road twice per
// journey. Peak RSS stays well under 200 MB.

interface PieceStore {
  count: number;
  mx: Float64Array; // piece midpoint, metres (fixed London projection)
  my: Float64Array;
  bearingDeg: Float64Array;
  total: Float64Array; // summed journeys/day of all matched routes
  p0lon: Float64Array; // piece endpoints, degrees
  p0lat: Float64Array;
  p1lon: Float64Array;
  p1lat: Float64Array;
  seq: Int32Array; // walk position within the owner route (run-gap detection)
  lastRoute: Int32Array; // last contributing route index (double-add guard)
}

function makePieceStore(): PieceStore {
  const capacity = 1 << 16;
  return {
    count: 0,
    mx: new Float64Array(capacity),
    my: new Float64Array(capacity),
    bearingDeg: new Float64Array(capacity),
    total: new Float64Array(capacity),
    p0lon: new Float64Array(capacity),
    p0lat: new Float64Array(capacity),
    p1lon: new Float64Array(capacity),
    p1lat: new Float64Array(capacity),
    seq: new Int32Array(capacity),
    lastRoute: new Int32Array(capacity),
  };
}

/** Double every array in place (field reassignment) once count hits
 * capacity. Mutation is deliberate here: the store is function-local to one
 * build and copying ~440k-piece arrays per push would be quadratic. */
function growPieceStore(store: PieceStore): void {
  const capacity = store.mx.length * 2;
  const growF = (old: Float64Array): Float64Array => {
    const next = new Float64Array(capacity);
    next.set(old);
    return next;
  };
  const growI = (old: Int32Array): Int32Array => {
    const next = new Int32Array(capacity);
    next.set(old);
    return next;
  };
  store.mx = growF(store.mx);
  store.my = growF(store.my);
  store.bearingDeg = growF(store.bearingDeg);
  store.total = growF(store.total);
  store.p0lon = growF(store.p0lon);
  store.p0lat = growF(store.p0lat);
  store.p1lon = growF(store.p1lon);
  store.p1lat = growF(store.p1lat);
  store.seq = growI(store.seq);
  store.lastRoute = growI(store.lastRoute);
}

/** Same road iff bearings agree within tolerance in EITHER direction —
 * inbound/outbound pairs of one street must merge, not double-draw. */
function bearingOk(b1: number, b2: number): boolean {
  let d = Math.abs(b1 - b2) % 360;
  if (d > 180) d = 360 - d;
  return d <= BEARING_TOL_DEG || d >= 180 - BEARING_TOL_DEG;
}

/** Numeric grid key: the walk queries 9 cells per piece (~10M lookups per
 * build), and string keys would allocate a temp string for every one of
 * them. The +65536 bias keeps both axes positive out to ±1966 km — far
 * beyond any learned route. */
const cellKey = (gx: number, gy: number): number => (gx + 65_536) * 131_072 + (gy + 65_536);

/** Resample a projected polyline to ~STEP_M point spacing, keeping the true
 * endpoint so the tail piece is never dropped. */
function resampleMetres(xs: Float64Array, ys: Float64Array): { rx: number[]; ry: number[] } {
  const rx: number[] = [xs[0] ?? 0];
  const ry: number[] = [ys[0] ?? 0];
  let carry = 0;
  for (let i = 1; i < xs.length; i += 1) {
    const x0 = xs[i - 1] ?? 0;
    const y0 = ys[i - 1] ?? 0;
    const dx = (xs[i] ?? 0) - x0;
    const dy = (ys[i] ?? 0) - y0;
    const segLen = Math.hypot(dx, dy);
    if (segLen === 0) continue;
    let along = STEP_M - carry;
    while (along < segLen) {
      const t = along / segLen;
      rx.push(x0 + dx * t);
      ry.push(y0 + dy * t);
      along += STEP_M;
    }
    carry = segLen - (along - STEP_M);
  }
  const endX = xs[xs.length - 1] ?? 0;
  const endY = ys[ys.length - 1] ?? 0;
  if (Math.hypot(endX - (rx[rx.length - 1] ?? 0), endY - (ry[ry.length - 1] ?? 0)) > 1) {
    rx.push(endX);
    ry.push(endY);
  }
  return { rx, ry };
}

/** Walk one route's resampled pieces against the corridor store: match →
 * add the route mean once, no match → emit a new owned piece. Returns the
 * emitted piece indices (walk-ordered) for the run-merge phase. */
function walkRoute(
  store: PieceStore,
  grid: Map<number, number[]>,
  routeIdx: number,
  poly: readonly LonLat[],
  mean: number,
  mPerDegLon: number,
): number[] {
  const xs = new Float64Array(poly.length);
  const ys = new Float64Array(poly.length);
  for (let i = 0; i < poly.length; i += 1) {
    xs[i] = (poly[i]?.[0] ?? 0) * mPerDegLon;
    ys[i] = (poly[i]?.[1] ?? 0) * M_PER_DEG;
  }
  const { rx, ry } = resampleMetres(xs, ys);
  const owned: number[] = [];

  for (let i = 1, seq = 0; i < rx.length; i += 1, seq += 1) {
    const x0 = rx[i - 1] ?? 0;
    const y0 = ry[i - 1] ?? 0;
    const x1 = rx[i] ?? 0;
    const y1 = ry[i] ?? 0;
    const dx = x1 - x0;
    const dy = y1 - y0;
    if (Math.hypot(dx, dy) === 0) continue;
    const mx = (x0 + x1) / 2;
    const my = (y0 + y1) / 2;
    const bearing = (Math.atan2(dx, dy) * 180) / Math.PI;

    // nearest matchable piece in the 3×3 cell neighbourhood
    const cx = Math.floor(mx / CELL_M);
    const cy = Math.floor(my / CELL_M);
    let best = -1;
    let bestD = Infinity;
    let alreadyCounted = false; // this route contributed to a corridor here
    for (let gx = cx - 1; gx <= cx + 1; gx += 1) {
      for (let gy = cy - 1; gy <= cy + 1; gy += 1) {
        const cell = grid.get(cellKey(gx, gy));
        if (cell === undefined) continue;
        for (const pi of cell) {
          const d = Math.hypot((store.mx[pi] ?? 0) - mx, (store.my[pi] ?? 0) - my);
          if (d > MATCH_DIST_M) continue;
          if (!bearingOk(store.bearingDeg[pi] ?? 0, bearing)) continue;
          if (store.lastRoute[pi] === routeIdx) {
            alreadyCounted = true; // guard: a route must never add twice
          } else if (d < bestD) {
            bestD = d;
            best = pi;
          }
        }
      }
    }

    if (best >= 0) {
      store.total[best] = (store.total[best] ?? 0) + mean;
      store.lastRoute[best] = routeIdx;
    } else if (!alreadyCounted) {
      // emit a new corridor piece owned by this route
      if (store.count === store.mx.length) growPieceStore(store);
      const pi = store.count;
      store.count += 1;
      store.mx[pi] = mx;
      store.my[pi] = my;
      store.bearingDeg[pi] = bearing;
      store.total[pi] = mean;
      store.p0lon[pi] = x0 / mPerDegLon;
      store.p0lat[pi] = y0 / M_PER_DEG;
      store.p1lon[pi] = x1 / mPerDegLon;
      store.p1lat[pi] = y1 / M_PER_DEG;
      store.seq[pi] = seq;
      store.lastRoute[pi] = routeIdx;
      const ck = cellKey(cx, cy);
      const cell = grid.get(ck);
      if (cell === undefined) grid.set(ck, [pi]);
      else cell.push(pi);
      owned.push(pi);
    }
    // else: the corridor already counted this route on this stretch —
    // emitting a duplicate line or adding again would both be wrong.
  }
  return owned;
}

/** Emit one run of same-owner consecutive same-bucket pieces as a feature.
 * j/b are fixed BEFORE geometry post-processing, so simplify + quantize can
 * only shave bytes, never change what the feature claims. */
function emitRun(store: PieceStore, run: readonly number[], out: CoverageFeature[]): void {
  const first = run[0];
  if (first === undefined) return;
  let totalSum = 0;
  const coords: LonLat[] = [[store.p0lon[first] ?? 0, store.p0lat[first] ?? 0]];
  for (const pi of run) {
    totalSum += store.total[pi] ?? 0;
    coords.push([store.p1lon[pi] ?? 0, store.p1lat[pi] ?? 0]);
  }
  const quantized = quantizePolyline(simplifyPolyline(coords, COVERAGE_TOLERANCE_M));
  // 4-decimal rounding can collapse a short tail piece onto its neighbour;
  // GeoJSON LineStrings must not carry repeated positions, so drop them.
  const line = quantized.filter(
    (p, i) => i === 0 || p[0] !== quantized[i - 1]?.[0] || p[1] !== quantized[i - 1]?.[1],
  );
  if (line.length < 2) return;
  out.push({
    type: 'Feature',
    properties: {
      // j is the run MEAN — pieces in one run share a bucket, so the true
      // per-point total varies at most within that bucket's bounds. Any
      // future tap-to-inspect UI should present it as "~j/day", not exact.
      j: Math.round(totalSum / run.length),
      b: assignBucket(store.total[first] ?? 0),
    },
    geometry: { type: 'LineString', coordinates: line },
  });
}

/** Split one owner route's emitted pieces into runs: break on a walk gap
 * (matched pieces in between) or a bucket change, then emit each run. */
function emitOwnerRuns(store: PieceStore, owned: readonly number[], out: CoverageFeature[]): void {
  let runStart = 0;
  for (let i = 1; i <= owned.length; i += 1) {
    const prev = owned[i - 1];
    const cur = owned[i];
    const breaks =
      cur === undefined ||
      prev === undefined ||
      (store.seq[cur] ?? 0) !== (store.seq[prev] ?? 0) + 1 ||
      assignBucket(store.total[cur] ?? 0) !== assignBucket(store.total[prev] ?? 0);
    if (breaks) {
      emitRun(store, owned.slice(runStart, i), out);
      runStart = i;
    }
  }
}

/** How many routes to process between event-loop yields. The corridor walk
 * is heavier per route than the old per-route Douglas-Peucker, so the stride
 * is smaller — chunks stay tens of milliseconds. */
const YIELD_EVERY_ROUTES = 50;

/** Assemble the corridor artifact. Routes with a zero rolling mean carry no
 * journeys in the window and are DROPPED (drawing them would claim service
 * that does not exist). The rest are walked busiest-first so each corridor's
 * canonical geometry comes from the busiest route through it. Async because
 * the full walk over ~1800 routes would stall the event loop this process
 * also serves live traffic from — it yields every YIELD_EVERY_ROUTES. */
export async function buildCoverageArtifact(
  polylines: ReadonlyMap<string, readonly LonLat[]>,
  means: ReadonlyMap<string, number>,
  day: string,
  windowDays: number,
): Promise<CoverageArtifact> {
  const routes: Array<{ key: string; poly: readonly LonLat[]; mean: number }> = [];
  for (const [key, poly] of polylines) {
    const mean = means.get(key) ?? 0;
    if (mean > 0 && poly.length >= 2) routes.push({ key, poly, mean });
  }
  // Busiest first; key tiebreak → byte-identical artifacts for equal inputs.
  routes.sort((a, b) => b.mean - a.mean || a.key.localeCompare(b.key));

  // Projection reference latitude from the data itself (mean of route first
  // vertices) — see the note by BEARING_TOL_DEG: a hardcoded latitude would
  // silently corrupt matching for regions far from London.
  const latSum = routes.reduce((sum, r) => sum + (r.poly[0]?.[1] ?? 0), 0);
  const meanLat = routes.length > 0 ? latSum / routes.length : 0;
  const mPerDegLon = M_PER_DEG * Math.cos((meanLat * Math.PI) / 180);

  const store = makePieceStore();
  const grid = new Map<number, number[]>();
  const ownedByRoute: number[][] = [];
  for (let ri = 0; ri < routes.length; ri += 1) {
    const route = routes[ri];
    ownedByRoute.push(
      route === undefined ? [] : walkRoute(store, grid, ri, route.poly, route.mean, mPerDegLon),
    );
    if (ri % YIELD_EVERY_ROUTES === YIELD_EVERY_ROUTES - 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  const features: CoverageFeature[] = [];
  for (let ri = 0; ri < ownedByRoute.length; ri += 1) {
    emitOwnerRuns(store, ownedByRoute[ri] ?? [], features);
    if (ri % YIELD_EVERY_ROUTES === YIELD_EVERY_ROUTES - 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  return { type: 'FeatureCollection', day, windowDays, features };
}

/** Missing, unreadable, or last built at least one cycle ago. The mtime check
 * is what makes a 24 h cycle safe across restarts: the interval timer restarts
 * with the process, so a deploy would otherwise push the next rebuild a full
 * cycle further out and could leave a two-day-old artifact serving. */
export async function olderThanOneCycle(path: string, nowMs: number): Promise<boolean> {
  try {
    const info = await stat(path);
    return nowMs - info.mtimeMs >= REGEN_INTERVAL_MS;
  } catch {
    return true;
  }
}

/** learned/<sanitized key>.json → polyline, best-effort per file. */
async function loadLearnedPolylines(learnedDir: string): Promise<Map<string, LonLat[]>> {
  const out = new Map<string, LonLat[]>();
  let names: string[];
  try {
    names = (await readdir(learnedDir)).filter((n) => !n.startsWith('.') && n.endsWith('.json'));
  } catch {
    return out; // learner hasn't produced anything yet
  }
  for (const name of names) {
    try {
      const parsed = JSON.parse(await readFile(join(learnedDir, name), 'utf8')) as {
        poly?: unknown;
      };
      const poly = parsed.poly;
      const isValid =
        Array.isArray(poly) &&
        poly.length >= 2 &&
        poly.every(
          (p) => Array.isArray(p) && typeof p[0] === 'number' && typeof p[1] === 'number',
        );
      if (isValid) out.set(name.slice(0, -'.json'.length), poly as LonLat[]);
    } catch {
      // one unreadable learned file must not sink the artifact
    }
  }
  return out;
}

/** One Map<sanitizedKey, journeys> per window day. Distinct raw keys that
 * sanitize identically (the go2/Go2 case split) are summed, not clobbered. */
async function loadWindowJourneys(
  rollupsDir: string,
  days: readonly string[],
  log: (msg: string) => void = () => {},
): Promise<Array<Map<string, number>>> {
  const perDay: Array<Map<string, number>> = [];
  for (const day of days) {
    const journeys = new Map<string, number>();
    try {
      const parsed = JSON.parse(await readFile(join(rollupsDir, `${day}.json`), 'utf8')) as {
        routes?: Record<string, { journeys?: unknown }>;
      };
      for (const [rawKey, stats] of Object.entries(parsed.routes ?? {})) {
        // Optional-chain: a null/malformed ENTRY must only lose itself, never
        // throw and void every valid route in the same day file.
        const value = (stats as { journeys?: unknown } | null)?.journeys;
        if (typeof value !== 'number' || !Number.isFinite(value)) continue;
        const key = sanitizeKey(rawKey);
        journeys.set(key, (journeys.get(key) ?? 0) + value);
      }
    } catch {
      log(`coverage: rollup day ${day} unreadable — counted as zeros`);
      // the window still averages over it so one bad file cannot inflate
      // every route's mean
    }
    perDay.push(journeys);
  }
  return perDay;
}

/** Full disk-to-disk rebuild. Skips (with a log line) until both inputs
 * exist; writes tmp + rename so a crash mid-write never truncates the
 * artifact readers are serving. */
export async function generateCoverage(
  baseDir: string,
  log: (msg: string) => void,
): Promise<void> {
  const rollupsDir = join(baseDir, 'bus-rollups');
  const learnedDir = join(baseDir, 'bus-routes', 'learned');
  let rollupNames: string[];
  try {
    rollupNames = await readdir(rollupsDir);
  } catch {
    rollupNames = [];
  }
  const days = selectWindowDays(rollupNames, Date.now());
  if (days.length === 0) {
    log('coverage: no completed rollup days yet — skipped');
    return;
  }
  const polylines = await loadLearnedPolylines(learnedDir);
  if (polylines.size === 0) {
    log('coverage: no learned routes yet — skipped');
    return;
  }
  const means = computeRollingMeans(await loadWindowJourneys(rollupsDir, days, log));
  const newestDay = days[days.length - 1] ?? '';
  const artifact = await buildCoverageArtifact(polylines, means, newestDay, days.length);

  const coverageDir = join(baseDir, 'coverage');
  await mkdir(coverageDir, { recursive: true });
  const outPath = join(coverageDir, 'latest.json');
  const tmpPath = `${outPath}.tmp`;
  await writeFile(tmpPath, JSON.stringify(artifact), 'utf8');
  await rename(tmpPath, outPath);
  log(
    `coverage: wrote day=${newestDay} window=${days.length}d — ` +
      `${polylines.size} routes into ${artifact.features.length} corridor features`,
  );
}

/** Boot build when the artifact is missing or a cycle old, then every
 * REGEN_INTERVAL_MS regardless — the recompute is pure local-disk work, so
 * unconditional beats tracking which rollup day it last saw. `baseDir` is the
 * resolved bus data dir. */
export function startCoverageWriter(
  baseDir: string,
  log: (msg: string) => void,
): { stop: () => void } {
  let running = false;
  const run = async (): Promise<void> => {
    if (running) return; // re-entrancy guard, mirrors RollupWriter.catchUp
    running = true;
    try {
      await generateCoverage(baseDir, log);
    } catch (err) {
      // leave the previous artifact serving; the 6 h cycle retries
      log(`coverage: generation failed (will retry): ${String(err)}`);
    } finally {
      running = false;
    }
  };
  void (async () => {
    if (await olderThanOneCycle(join(baseDir, 'coverage', 'latest.json'), Date.now())) await run();
  })();
  const timer = setInterval(() => void run(), REGEN_INTERVAL_MS);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
