// COPY of the pure inference core of frontend/src/realtime/nr-trains.ts —
// keep in sync manually. Copied (not cross-imported) because the backend tsc
// config enables noUncheckedIndexedAccess, which the frontend sources are not
// written for. Deltas from the frontend original:
//   • parseTime resolves "HH:mm" against the Europe/London wall clock — the
//     frontend can rely on the viewer's browser timezone, the server cannot.
//   • no map/rendering code: just board→train merging, the Dijkstra rail
//     graph, and clock-driven position evaluation.
//
// A National Rail train's calling points (with estimated/actual times) are
// interpolated along the baked station-to-station rail graph. Positions are
// pure functions of the clock, so evaluating them at each sample tick yields
// smooth, plausible travel distances.

import type { NrBoard } from '../darwin-client';
import { pointAtFraction, polylineLength, type LngLat } from './geometry';

export interface NrStation {
  crs: string;
  name: string;
  lat: number;
  lon: number;
}

export interface NrSegment {
  a: string;
  b: string;
  lenM: number;
  poly: LngLat[];
}

export interface NrTimedStop {
  crs: string;
  name: string;
  /** epoch ms */
  time: number;
}

export interface NrTrackedTrain {
  rid: string;
  operator: string;
  destination: string;
  stops: NrTimedStop[];
}

const HALF_DAY_MS = 12 * 3600_000;
const DAY_MS = 24 * 3600_000;
/** Trains whose final stop passed this long ago are pruned. */
const FINISHED_GRACE_MS = 120_000;
/** Dijkstra gives up beyond this path length (matches the frontend). */
const MAX_PATH_M = 60_000;
const PATH_CACHE_MAX = 300;

// ── Europe/London wall-clock parsing ──

const LONDON_OFFSET_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/London',
  timeZoneName: 'longOffset',
});

/** Europe/London UTC offset (ms) at the given instant (handles GMT/BST). */
function londonOffsetMs(at: number): number {
  const name =
    LONDON_OFFSET_FMT.formatToParts(at).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  if (!m) return 0;
  const sign = m[1] === '-' ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3])) * 60_000;
}

/** London-wall-clock "HH:mm" → epoch ms nearest to now (handles midnight wrap). */
export function parseTime(hhmm: string, now: number): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const offset = londonOffsetMs(now);
  // Work in "London wall time as pseudo-UTC", then shift back to real epoch.
  const wall = new Date(now + offset);
  wall.setUTCHours(Number(m[1]), Number(m[2]), 0, 0);
  let t = wall.getTime() - offset;
  if (t - now > HALF_DAY_MS) t -= DAY_MS;
  if (now - t > HALF_DAY_MS) t += DAY_MS;
  return t;
}

/** best known time for a stop: actual > parseable estimate > scheduled */
export function stopTime(p: { st: string; et?: string; at?: string }, now: number): number | null {
  return (
    (p.at ? parseTime(p.at, now) : null) ??
    (p.et ? parseTime(p.et, now) : null) ??
    parseTime(p.st, now)
  );
}

// ── rail graph (adjacency + Dijkstra pathing between calling points) ──

export class NrRailGraph {
  readonly stations: Map<string, NrStation>;
  private readonly neighbours = new Map<string, { crs: string; lenM: number }[]>();
  private readonly segByPair = new Map<string, NrSegment>();
  /** shortest station-graph path A→B as one concatenated polyline (cached) */
  private readonly pathCache = new Map<string, LngLat[] | null>();

  constructor(stations: NrStation[], segments: NrSegment[]) {
    this.stations = new Map(stations.map((s) => [s.crs, s]));
    for (const seg of segments) {
      this.segByPair.set(`${seg.a}>${seg.b}`, seg);
      this.segByPair.set(`${seg.b}>${seg.a}`, seg);
      let a = this.neighbours.get(seg.a);
      if (!a) {
        a = [];
        this.neighbours.set(seg.a, a);
      }
      a.push({ crs: seg.b, lenM: seg.lenM });
      let b = this.neighbours.get(seg.b);
      if (!b) {
        b = [];
        this.neighbours.set(seg.b, b);
      }
      b.push({ crs: seg.a, lenM: seg.lenM });
    }
  }

  private cachePath(key: string, value: LngLat[] | null): void {
    if (this.pathCache.size >= PATH_CACHE_MAX) {
      const oldest = this.pathCache.keys().next().value;
      if (oldest !== undefined) this.pathCache.delete(oldest);
    }
    this.pathCache.set(key, value);
  }

  railPath(a: string, b: string): LngLat[] | null {
    const key = `${a}>${b}`;
    const cached = this.pathCache.get(key);
    if (cached !== undefined) return cached;
    // Dijkstra over the ~431-node station graph
    const dist = new Map<string, number>([[a, 0]]);
    const prev = new Map<string, string>();
    const visited = new Set<string>();
    for (;;) {
      let cur: string | null = null;
      let curD = Infinity;
      for (const [crs, d] of dist) {
        if (!visited.has(crs) && d < curD) {
          cur = crs;
          curD = d;
        }
      }
      if (cur === null || curD > MAX_PATH_M) {
        this.cachePath(key, null);
        return null;
      }
      if (cur === b) break;
      visited.add(cur);
      for (const n of this.neighbours.get(cur) ?? []) {
        const nd = curD + n.lenM;
        if (nd < (dist.get(n.crs) ?? Infinity)) {
          dist.set(n.crs, nd);
          prev.set(n.crs, cur);
        }
      }
    }
    const chain: string[] = [b];
    while (chain[0] !== a) chain.unshift(prev.get(chain[0]!)!);
    const poly: LngLat[] = [];
    for (let i = 0; i < chain.length - 1; i++) {
      const seg = this.segByPair.get(`${chain[i]!}>${chain[i + 1]!}`);
      if (!seg) {
        this.cachePath(key, null);
        return null;
      }
      const pts = seg.a === chain[i] ? seg.poly : [...seg.poly].reverse();
      poly.push(...(i === 0 ? pts : pts.slice(1)));
    }
    this.cachePath(key, poly);
    return poly;
  }
}

// ── board → rid-keyed train timelines ──

/**
 * Merges one departure board's services into the rid-keyed train table,
 * keeping the sighting with the longest calling pattern (earliest board).
 */
export function mergeBoard(
  trains: Map<string, NrTrackedTrain>,
  board: NrBoard,
  stations: ReadonlyMap<string, NrStation>,
  now: number,
): void {
  for (const svc of board.services ?? []) {
    if (!svc.rid || svc.cancelled) continue;
    const boardStation = stations.get(board.crs);
    const first: NrTimedStop[] = boardStation
      ? [
          {
            crs: board.crs,
            name: boardStation.name,
            time: stopTime({ st: svc.std, ...(svc.etd !== undefined ? { et: svc.etd } : {}) }, now) ?? 0,
          },
        ]
      : [];
    const rest: NrTimedStop[] = svc.callingPoints
      .filter((p) => stations.has(p.crs))
      .map((p) => ({ crs: p.crs, name: p.name, time: stopTime(p, now) ?? 0 }))
      .filter((p) => p.time > 0);
    const stops = [...first, ...rest].filter((p) => p.time > 0);
    if (stops.length < 2) continue;
    const existing = trains.get(svc.rid);
    if (existing && existing.stops.length >= stops.length) continue;
    trains.set(svc.rid, {
      rid: svc.rid,
      operator: svc.operator ?? '',
      destination: svc.destination,
      stops,
    });
  }
}

/** Drops journeys whose final stop is comfortably in the past. */
export function pruneTrains(trains: Map<string, NrTrackedTrain>, now: number): void {
  for (const [rid, t] of trains) {
    const lastStop = t.stops[t.stops.length - 1];
    if (!lastStop || lastStop.time < now - FINISHED_GRACE_MS) trains.delete(rid);
  }
}

/**
 * The train's position at `now` along the rail graph between its bracketing
 * calling points (time-ratio along the Dijkstra path), or null when the train
 * has not yet entered / has already left our coverage.
 */
export function trainPositionAt(
  train: NrTrackedTrain,
  now: number,
  graph: NrRailGraph,
): LngLat | null {
  const { stops } = train;
  const firstStop = stops[0];
  if (!firstStop || firstStop.time > now) return null; // not yet departed our coverage
  let i = 0;
  while (i < stops.length - 1 && stops[i + 1]!.time <= now) i++;
  if (i >= stops.length - 1) return null; // journey finished
  const from = stops[i]!;
  const to = stops[i + 1]!;
  const path = graph.railPath(from.crs, to.crs);
  if (!path || polylineLength(path) === 0) return null;
  const span = to.time - from.time;
  const frac = span <= 0 ? 0 : Math.min(1, (now - from.time) / span);
  return pointAtFraction(path, frac).lngLat;
}
