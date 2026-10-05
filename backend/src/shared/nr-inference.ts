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
  /** undirected reference length — station-graph Dijkstra weight */
  lenM: number;
  /** track for travel a→b */
  poly: LngLat[];
  /**
   * track for travel b→a, already oriented b→a; absent where both directions
   * share one track (single line, or no second track in OSM) and in files
   * baked before per-direction tracks — then b→a is `poly` reversed.
   */
  polyRev?: LngLat[];
}

/** The segment's polyline for travel starting at `from` (one of its ends). */
export function segmentPolyFrom(seg: NrSegment, from: string): LngLat[] {
  if (seg.a === from) return seg.poly;
  return seg.polyRev ?? [...seg.poly].reverse();
}

const samePoint = (p: LngLat | undefined, q: LngLat | undefined): boolean =>
  p !== undefined && q !== undefined && p[0] === q[0] && p[1] === q[1];

/** Precedence of a stop time's source: actual > estimate > scheduled. */
export type NrTimeRank = 0 | 1 | 2;
export const NR_RANK_SCHEDULED: NrTimeRank = 0;
export const NR_RANK_ESTIMATE: NrTimeRank = 1;
export const NR_RANK_ACTUAL: NrTimeRank = 2;

export interface NrTimedStop {
  crs: string;
  name: string;
  /** epoch ms */
  time: number;
  /** what `time` came from — a later sighting only overrides at >= precedence */
  rank: NrTimeRank;
  /** epoch ms of the sighting `time` came from (board generatedAt, else arrival) */
  seenAt: number;
}

export interface NrTrackedTrain {
  rid: string;
  operator: string;
  destination: string;
  stops: NrTimedStop[];
}

// ── gateway stations (fast / express fix) ─────────────────────────────────
// Fast trains leave a London terminus and their FIRST calling point lies
// OUTSIDE the in-box station graph (e.g. Euston→Milton Keynes, Paddington→
// Reading). After filtering calling points to in-box stations only the origin
// survives → no segment pair → the train never renders even while physically
// crossing visible London track. Each gateway maps a first-out-of-box
// calling-point CRS to `snap`: the outermost in-box station on the SAME line of
// route (a real rail-graph node). origin→snap then gives a segment pair along
// the true corridor (WCML/GWML/ECML/MML/GEML/…) out to the bbox edge, where the
// train correctly leaves view. lat/lon are the gateway's real coordinates
// (verified against data/osm-cache/uk-stations.json); positioning uses the snap
// node's baked coordinates. KEEP IN SYNC with frontend/src/realtime/nr-trains.ts.
export interface NrGateway {
  crs: string;
  name: string;
  lat: number;
  lon: number;
  /** outermost in-box station on the same line of route (a rail-graph node) */
  snap: string;
}
export const NR_GATEWAYS: NrGateway[] = [
  // West Coast Main Line (Euston) → Kings Langley
  { crs: 'MKC', name: 'Milton Keynes Central', lat: 52.03436, lon: -0.77341, snap: 'KGL' },
  { crs: 'TRI', name: 'Tring', lat: 51.80033, lon: -0.62225, snap: 'KGL' },
  // Great Western Main Line (Paddington) → Langley
  { crs: 'RDG', name: 'Reading', lat: 51.45877, lon: -0.97217, snap: 'LNY' },
  { crs: 'SLO', name: 'Slough', lat: 51.51192, lon: -0.5918, snap: 'LNY' },
  { crs: 'MAI', name: 'Maidenhead', lat: 51.5186, lon: -0.72246, snap: 'LNY' },
  { crs: 'TWY', name: 'Twyford', lat: 51.47561, lon: -0.86389, snap: 'LNY' },
  // East Coast Main Line / Great Northern (King's Cross) → Potters Bar
  { crs: 'SVG', name: 'Stevenage', lat: 51.89903, lon: -0.20644, snap: 'PBR' },
  { crs: 'HIT', name: 'Hitchin', lat: 51.95291, lon: -0.2625, snap: 'PBR' },
  { crs: 'WGC', name: 'Welwyn Garden City', lat: 51.80096, lon: -0.20308, snap: 'PBR' },
  { crs: 'PBO', name: 'Peterborough', lat: 52.57495, lon: -0.24981, snap: 'PBR' },
  // Midland Main Line / Thameslink (St Pancras) → Radlett
  { crs: 'LUT', name: 'Luton', lat: 51.88223, lon: -0.41488, snap: 'RDT' },
  { crs: 'LTN', name: 'Luton Airport Parkway', lat: 51.87116, lon: -0.39348, snap: 'RDT' },
  { crs: 'SAC', name: 'St Albans City', lat: 51.74883, lon: -0.32684, snap: 'RDT' },
  { crs: 'BDM', name: 'Bedford', lat: 52.13618, lon: -0.47945, snap: 'RDT' },
  // Great Eastern Main Line (Liverpool St) → Shenfield
  { crs: 'CHM', name: 'Chelmsford', lat: 51.7366, lon: 0.46932, snap: 'SNF' },
  { crs: 'COL', name: 'Colchester', lat: 51.90048, lon: 0.89409, snap: 'SNF' },
  // West Anglia Main Line (Liverpool St) → Cheshunt
  { crs: 'HWN', name: 'Harlow Town', lat: 51.78164, lon: 0.0948, snap: 'CHN' },
  { crs: 'BIS', name: 'Bishops Stortford', lat: 51.86669, lon: 0.16557, snap: 'CHN' },
  { crs: 'SSD', name: 'Stansted Airport', lat: 51.88898, lon: 0.26162, snap: 'CHN' },
  // c2c (Fenchurch St) → West Horndon
  { crs: 'BSO', name: 'Basildon', lat: 51.56867, lon: 0.45731, snap: 'WHR' },
  // Chiltern Main Line (Marylebone) → Denham Golf Club
  { crs: 'HWY', name: 'High Wycombe', lat: 51.62979, lon: -0.74514, snap: 'DGC' },
  { crs: 'GER', name: 'Gerrards Cross', lat: 51.58888, lon: -0.55537, snap: 'DGC' },
  // South West Main Line (Waterloo) → West Byfleet / Clandon
  { crs: 'WOK', name: 'Woking', lat: 51.31847, lon: -0.55781, snap: 'WBY' },
  { crs: 'BSK', name: 'Basingstoke', lat: 51.26804, lon: -1.0869, snap: 'WBY' },
  { crs: 'GLD', name: 'Guildford', lat: 51.23691, lon: -0.58041, snap: 'CLA' },
  // South Eastern Main Line (Charing Cross) → Sevenoaks
  { crs: 'TON', name: 'Tonbridge', lat: 51.19113, lon: 0.26971, snap: 'SEV' },
  // Brighton Main Line (Victoria / London Bridge) → Merstham
  { crs: 'RDH', name: 'Redhill', lat: 51.24012, lon: -0.16485, snap: 'MHM' },
  { crs: 'GTW', name: 'Gatwick Airport', lat: 51.15642, lon: -0.16102, snap: 'MHM' },
];
/** gateway CRS → snap-node CRS (outermost in-box station on its line) */
const NR_GATEWAY_SNAP = new Map<string, string>(NR_GATEWAYS.map((g) => [g.crs, g.snap]));

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
  return rankedStopTime(p, now)?.time ?? null;
}

/** stopTime plus the precedence of the source the time came from. */
export function rankedStopTime(
  p: { st: string; et?: string; at?: string },
  now: number,
): { time: number; rank: NrTimeRank } | null {
  const actual = p.at ? parseTime(p.at, now) : null;
  if (actual !== null) return { time: actual, rank: NR_RANK_ACTUAL };
  const estimate = p.et ? parseTime(p.et, now) : null;
  if (estimate !== null) return { time: estimate, rank: NR_RANK_ESTIMATE };
  const scheduled = parseTime(p.st, now);
  if (scheduled === null) return null;
  // "On time" is Darwin's estimate that the schedule holds: rank it as an
  // estimate so it can supersede an older delay estimate the train recovered
  // from. "Delayed" (no figure) stays scheduled-rank and cannot erase one.
  return { time: scheduled, rank: p.et?.trim() === 'On time' ? NR_RANK_ESTIMATE : NR_RANK_SCHEDULED };
}

// ── rail graph (adjacency + Dijkstra pathing between calling points) ──

export class NrRailGraph {
  readonly stations: Map<string, NrStation>;
  private readonly neighbours = new Map<string, { crs: string; lenM: number }[]>();
  private readonly segByPair = new Map<string, NrSegment>();
  /**
   * shortest station-graph path A→B as one concatenated polyline (cached).
   * Keyed `A>B`, so the two directions are cached apart: each segment is
   * drawn on its own track for the direction travelled.
   */
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
      const pts = segmentPolyFrom(seg, chain[i]!);
      // consecutive segments meet at the station; on per-direction tracks the
      // two ends may differ by a metre or two, so only an exact repeat is dropped
      poly.push(...(samePoint(poly[poly.length - 1], pts[0]) ? pts.slice(1) : pts));
    }
    this.cachePath(key, poly);
    return poly;
  }
}

// ── board → rid-keyed train timelines ──

/** collapse consecutive stops sharing a CRS so no zero-length leg is produced */
function dedupeStops(list: readonly NrTimedStop[]): NrTimedStop[] {
  return list.filter((p, i) => i === 0 || p.crs !== list[i - 1]!.crs);
}

/**
 * When the board was generated (Darwin `generatedAt`), so a board served late
 * from cache cannot override a fresher sighting. Falls back to `now`, i.e.
 * sightings without a parseable generatedAt are applied in arrival order.
 */
function sightingTime(board: { generatedAt?: string }, now: number): number {
  const t = Date.parse(board.generatedAt ?? '');
  return Number.isFinite(t) ? t : now;
}

/** One service's timeline as seen on one board (before merging). */
function sightingStops(
  svc: NrBoard['services'][number],
  board: NrBoard,
  stations: ReadonlyMap<string, NrStation>,
  now: number,
): NrTimedStop[] {
  const seenAt = sightingTime(board, now);
  const boardStation = stations.get(board.crs);
  const boardTime = rankedStopTime(
    { st: svc.std, ...(svc.etd !== undefined ? { et: svc.etd } : {}) },
    now,
  );
  const first: NrTimedStop[] =
    boardStation && boardTime
      ? [{ crs: board.crs, name: boardStation.name, ...boardTime, seenAt }]
      : [];
  const rest = svc.callingPoints
    .map((p): NrTimedStop | null => {
      // in-box station: use directly. out-of-box gateway: snap to the
      // outermost in-box node on its line so origin→snap forms a segment pair
      // along the real corridor. otherwise drop (invisible > wrong).
      const crs = stations.has(p.crs) ? p.crs : (NR_GATEWAY_SNAP.get(p.crs) ?? null);
      if (crs === null || !stations.has(crs)) return null;
      const t = rankedStopTime(p, now);
      return t ? { crs, name: p.name, ...t, seenAt } : null;
    })
    .filter((p): p is NrTimedStop => p !== null);
  return dedupeStops([...first, ...rest].filter((p) => p.time > 0));
}

/** per-stop winner: higher precedence, else the newer sighting (ties → incoming) */
function pickStop(existing: NrTimedStop, incoming: NrTimedStop): NrTimedStop {
  if (incoming.rank !== existing.rank) return incoming.rank > existing.rank ? incoming : existing;
  return incoming.seenAt >= existing.seenAt ? incoming : existing;
}

interface StopPair {
  existing: NrTimedStop | null;
  incoming: NrTimedStop | null;
}

/**
 * Aligns two sightings of one service by CRS into a single ordered list.
 * ORDER: the longer list is the base and keeps its order (ties → the existing
 * timeline, already on screen). Stops only the other list carries are slotted
 * in after the last stop both share (before the first, if none yet). If the
 * two orders conflict, a shared stop stays where the base has it — the longer
 * sighting is the more complete calling pattern, so its order is trusted.
 */
function alignStops(existing: readonly NrTimedStop[], incoming: readonly NrTimedStop[]): StopPair[] {
  const incomingIsBase = incoming.length > existing.length;
  const base = incomingIsBase ? incoming : existing;
  const other = incomingIsBase ? existing : incoming;
  const baseOf = (p: StopPair): NrTimedStop | null => (incomingIsBase ? p.incoming : p.existing);
  const otherOf = (p: StopPair): NrTimedStop | null => (incomingIsBase ? p.existing : p.incoming);
  const pairOf = (b: NrTimedStop | null, o: NrTimedStop | null): StopPair =>
    incomingIsBase ? { existing: o, incoming: b } : { existing: b, incoming: o };

  let pairs: StopPair[] = base.map((s) => pairOf(s, null));
  let anchor = -1; // index of the last pair the walk through `other` landed on
  for (const s of other) {
    const free = (p: StopPair): boolean => baseOf(p)?.crs === s.crs && otherOf(p) === null;
    const ahead = pairs.findIndex((p, i) => i > anchor && free(p));
    const idx = ahead >= 0 ? ahead : pairs.findIndex(free); // behind anchor = order conflict
    if (idx >= 0) {
      pairs = pairs.map((p, i) => (i === idx ? pairOf(baseOf(p), s) : p));
      anchor = Math.max(anchor, idx);
    } else {
      pairs = [...pairs.slice(0, anchor + 1), pairOf(null, s), ...pairs.slice(anchor + 1)];
      anchor += 1;
    }
  }
  return pairs;
}

/**
 * Folds a new sighting into a tracked timeline. Per calling point present in
 * both: actual beats estimate beats scheduled, and between two of the same
 * precedence the newer sighting (board generatedAt) wins. Stops the new
 * sighting lacks are kept; stops it adds are inserted (see alignStops).
 *
 * Guard: an estimate/scheduled update may not pull a stop the train has not
 * yet reached (its old time was still ahead of `now`) into the past while
 * the train has left the previous stop (that stop has an actual, or its time
 * is <= now) — with no actual arrival the train is not confirmed there, and
 * the earlier time would teleport it past the stop. Such a time is clamped
 * to `now` (the train is drawn arriving). Actual times are never clamped.
 */
export function mergeStops(
  existing: readonly NrTimedStop[],
  incoming: readonly NrTimedStop[],
  now: number,
): NrTimedStop[] {
  const merged = alignStops(existing, incoming).reduce<NrTimedStop[]>((out, pair) => {
    const prev = out[out.length - 1];
    let stop = pair.existing && pair.incoming ? pickStop(pair.existing, pair.incoming) : (pair.existing ?? pair.incoming)!;
    const departedPrev = prev !== undefined && (prev.rank === NR_RANK_ACTUAL || prev.time <= now);
    if (
      pair.existing &&
      stop !== pair.existing &&
      stop.rank !== NR_RANK_ACTUAL &&
      departedPrev &&
      pair.existing.time >= now &&
      stop.time < now
    ) {
      stop = { ...stop, time: now };
    }
    return [...out, stop];
  }, []);
  return dedupeStops(merged.filter((p) => p.time > 0));
}

/**
 * Merges one departure board's services into the rid-keyed train table. A
 * service seen for the first time takes this sighting's timeline; one already
 * tracked has it folded in by mergeStops (times updated, never truncated).
 */
export function mergeBoard(
  trains: Map<string, NrTrackedTrain>,
  board: NrBoard,
  stations: ReadonlyMap<string, NrStation>,
  now: number,
): void {
  for (const svc of board.services ?? []) {
    if (!svc.rid || svc.cancelled) continue;
    const stops = sightingStops(svc, board, stations, now);
    if (stops.length < 2) continue;
    const existing = trains.get(svc.rid);
    trains.set(svc.rid, {
      rid: svc.rid,
      operator: svc.operator || existing?.operator || '',
      destination: svc.destination || existing?.destination || '',
      stops: existing ? mergeStops(existing.stops, stops, now) : stops,
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
 *
 * Because mergeBoard now updates a tracked timeline in place, the drawn
 * position CAN step backwards along the path on an ordinary update — this is
 * not smoothed (out of scope): with frac = (now - from.time) / (to.time -
 * from.time), a later estimate for the NEXT stop (the train falling later)
 * shrinks frac, and a later estimate for a stop the clock had already passed
 * puts the train back on the previous leg. The opposite move — the next
 * stop's estimate becoming earlier — steps it forwards, and mergeStops caps
 * that at the stop itself (never earlier than `now` without an actual).
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
