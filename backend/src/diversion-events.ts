// Pure event-store half of bus-diversion detection: SITE-keyed clustering of
// completed excursions, event lifecycle transitions, API payload assembly,
// and TfL road-disruption enrichment. No IO and no timers — the detector
// closure in diversion-detector.ts owns the wiring and feeds this store.
//
// Split out of diversion-detector.ts purely mechanically (the per-vehicle
// state machine stays there); the shared geometry/statistics helpers live
// here because this module must not import the detector (the dependency runs
// detector → events only).

import { slicePolyline, type LonLat } from './route-projection';

// --- tuning constants (task spec + prototype calibration; do not retune
// without re-running the audit gate) ---
const SITE_MERGE_DIST_M = 500;
const EVENT_WINDOW_S = 45 * 60;
const DISPLAY_MIN_VEHICLES = 2;
const RECOVERY_MIN_VEHICLES = 2;
/** A recovery passage must reach within this of both bracket ends. */
const RECOVERY_PASS_MARGIN_M = 50;
const STALE_AFTER_S = 90 * 60;
const STALE_DROP_AFTER_S = 6 * 3600;
const RECOVERING_DROP_AFTER_S = 10 * 60;
const LONG_RUNNING_S = 24 * 3600;
const TFL_MATCH_DIST_M = 250;
// memory bounds — members and the per-event collections (vehicles, brackets,
// passages) all share this cap.
const EVENT_MEMBER_CAP = 500;
const MAX_EVENT_SEGMENTS = 12;

const METRES_PER_DEG_LAT = 110_540;
const METRES_PER_DEG_LON_EQUATOR = 111_320;

// ---------------------------------------------------------------------------
// small shared helpers (also used by the detector's state machine)
// ---------------------------------------------------------------------------

/** Planar metres between two lon/lat points (equirect at their mean lat). */
export function metresBetween(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const kx = METRES_PER_DEG_LON_EQUATOR * Math.cos((((lat1 + lat2) / 2) * Math.PI) / 180);
  return Math.hypot((lon2 - lon1) * kx, (lat2 - lat1) * METRES_PER_DEG_LAT);
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1] ?? NaN;
}

/** Prototype's time proximity: windows within EVENT_WINDOW_S of each other. */
function timesNear(t0a: number, t1a: number, t0b: number, t1b: number): boolean {
  return t0b <= t1a + EVENT_WINDOW_S && t0a <= t1b + EVENT_WINDOW_S;
}

export function utcDay(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString().slice(0, 10);
}

/** Bounded insert for the per-event collections: Maps/Sets iterate in
 * insertion order, so dropping the first entry evicts the oldest and keeps
 * the newest. Call before inserting a NEW key only — replacing an existing
 * key never grows the collection. */
function evictOldestIfFull(coll: {
  size: number;
  keys(): IterableIterator<string>;
  delete(key: string): boolean;
}): void {
  if (coll.size < EVENT_MEMBER_CAP) return;
  const oldest = coll.keys().next();
  if (!oldest.done) coll.delete(oldest.value);
}

// ---------------------------------------------------------------------------
// completed excursions (produced by the detector's per-vehicle state machine)
// ---------------------------------------------------------------------------

export type Confidence = 'high' | 'low';

export interface CompletedExcursion {
  key: string;
  veh: string;
  /** the vehicle's destination sign at the time — labels the direction for
   * humans ("SL8 → Uxbridge") far better than inbound/outbound would */
  dest: string;
  t0: number;
  t1: number;
  sExit: number;
  sRejoin: number;
  sA: number;
  sB: number;
  maxD: number;
  nFix: number;
  groundM: number;
  midLon: number;
  midLat: number;
  confidence: Confidence;
}

// ---------------------------------------------------------------------------
// site-keyed event clustering + lifecycle
// ---------------------------------------------------------------------------

export type EventStatus = 'active' | 'recovering' | 'stale';

interface KeyBracket {
  sA: number;
  sB: number;
}

interface RecoveryPassage {
  minS: number;
  maxS: number;
  broken: boolean;
}

export interface DiversionEvent {
  id: string;
  status: EventStatus;
  displayWorthy: boolean;
  startedAt: number;
  lastEvidenceAt: number;
  recoveringAt: number | null;
  members: CompletedExcursion[];
  vehicles: Set<string>;
  /** per route key: merged bypassed [s_exit, s_rejoin] bracket */
  brackets: Map<string, KeyBracket>;
  centroid: [number, number];
  /** `${key}|${veh}` → on-route traversal progress through the bracket */
  passages: Map<string, RecoveryPassage>;
  passedVehicles: Set<string>;
}

export interface EventStore {
  events: DiversionEvent[];
  seqDay: string;
  daySeq: number;
}

export function createEventStore(): EventStore {
  return { events: [], seqDay: '', daySeq: 0 };
}

export interface TransitionRecord {
  t: number;
  id: string;
  transition: 'created' | 'displayed' | 'reactivated' | 'recovering' | 'stale' | 'dropped';
  event: {
    status: EventStatus;
    displayWorthy: boolean;
    startedAt: number;
    lastEvidenceAt: number;
    routes: string[];
    vehicles: number;
    members: number;
    centroid: [number, number];
  };
}

/** Human line names from route keys (OPERATOR:line:direction), sorted. */
function routeNames(keys: Iterable<string>): string[] {
  const lines = new Set<string>();
  for (const key of keys) lines.add(key.split(':')[1] ?? key);
  return [...lines].sort();
}

/** Human route labels with the majority destination sign of each diverting
 * route-direction's HIGH members: "SL8 → Uxbridge" beats a bare "SL8", which
 * read as "the whole route" to a live user watching the OTHER direction run
 * normally. Falls back to the bare line name when no dest is known. */
function routeLabels(
  keys: Iterable<string>,
  members: ReadonlyArray<CompletedExcursion>,
): string[] {
  const labels = new Set<string>();
  for (const key of keys) {
    const line = key.split(':')[1] ?? key;
    const counts = new Map<string, number>();
    for (const m of members) {
      if (m.key !== key || m.confidence !== 'high' || m.dest === '') continue;
      counts.set(m.dest, (counts.get(m.dest) ?? 0) + 1);
    }
    let dest = '';
    let bestN = 0;
    for (const [d, n] of counts) {
      if (n > bestN) {
        dest = d;
        bestN = n;
      }
    }
    labels.add(dest === '' ? line : `${line} → ${dest}`);
  }
  return [...labels].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

/** Per-route brackets rebuilt from HIGH-confidence members only. `ev.brackets`
 * (all confidences) still drives recovery tracking, but attribution — route
 * names in the popup and the red sliced segments — extends the display bar's
 * principle: a LOW-confidence excursion may corroborate a site, yet a route
 * whose ONLY contribution is LOW must never get a red line or a name. */
function highConfidenceBrackets(ev: DiversionEvent): Map<string, KeyBracket> {
  const out = new Map<string, KeyBracket>();
  for (const m of ev.members) {
    if (m.confidence !== 'high') continue;
    const bracket = out.get(m.key);
    if (bracket === undefined) {
      out.set(m.key, { sA: m.sA, sB: m.sB });
    } else {
      bracket.sA = Math.min(bracket.sA, m.sA);
      bracket.sB = Math.max(bracket.sB, m.sB);
    }
  }
  return out;
}

function transitionOf(ev: DiversionEvent, t: number, transition: TransitionRecord['transition']): TransitionRecord {
  return {
    t,
    id: ev.id,
    transition,
    event: {
      status: ev.status,
      displayWorthy: ev.displayWorthy,
      startedAt: ev.startedAt,
      lastEvidenceAt: ev.lastEvidenceAt,
      // The day log is evidence, not display: LOW-only routes stay listed here.
      routes: routeNames(ev.brackets.keys()),
      vehicles: ev.vehicles.size,
      members: ev.members.length,
      centroid: ev.centroid,
    },
  };
}

/** DISPLAY_MIN_VEHICLES distinct vehicles with HIGH-confidence excursions
 * overlapping within 45 min — the display-worthiness bar. The pairwise scan
 * IS the two-vehicle requirement; members are capped, so it stays tiny. */
function isDisplayWorthy(ev: DiversionEvent): boolean {
  const high = ev.members.filter((m) => m.confidence === 'high');
  for (let i = 0; i < high.length; i++) {
    for (let j = i + 1; j < high.length; j++) {
      const a = high[i];
      const b = high[j];
      if (a === undefined || b === undefined || a.veh === b.veh) continue;
      if (timesNear(a.t0, a.t1, b.t0, b.t1)) return true;
    }
  }
  return false;
}

function recomputeCentroid(ev: DiversionEvent): void {
  ev.centroid = [median(ev.members.map((m) => m.midLon)), median(ev.members.map((m) => m.midLat))];
}

/**
 * Merge one completed excursion into the store (SITE-keyed: nearest live
 * event whose centroid is within 500 m and whose time window overlaps,
 * regardless of route family). Returns the transitions this caused.
 */
export function addExcursion(
  store: EventStore,
  exc: CompletedExcursion,
  nowSec: number,
): TransitionRecord[] {
  const transitions: TransitionRecord[] = [];
  let target: DiversionEvent | null = null;
  let bestDist = Infinity;
  for (const ev of store.events) {
    if (!timesNear(exc.t0, exc.t1, ev.startedAt, ev.lastEvidenceAt)) continue;
    const dist = metresBetween(ev.centroid[0], ev.centroid[1], exc.midLon, exc.midLat);
    if (dist <= SITE_MERGE_DIST_M && dist < bestDist) {
      bestDist = dist;
      target = ev;
    }
  }

  if (target === null) {
    const day = utcDay(nowSec);
    if (day !== store.seqDay) {
      store.seqDay = day;
      store.daySeq = 0;
    }
    store.daySeq += 1;
    target = {
      id: `div-${day}-${store.daySeq}`,
      status: 'active',
      displayWorthy: false,
      startedAt: exc.t0,
      lastEvidenceAt: exc.t1,
      recoveringAt: null,
      members: [],
      vehicles: new Set(),
      brackets: new Map(),
      centroid: [exc.midLon, exc.midLat],
      passages: new Map(),
      passedVehicles: new Set(),
    };
    store.events.push(target);
    transitions.push(transitionOf(target, nowSec, 'created'));
  }

  if (target.members.length < EVENT_MEMBER_CAP) target.members.push(exc);
  if (!target.vehicles.has(exc.veh)) {
    evictOldestIfFull(target.vehicles);
    target.vehicles.add(exc.veh);
  }
  const bracket = target.brackets.get(exc.key);
  if (bracket === undefined) {
    evictOldestIfFull(target.brackets);
    target.brackets.set(exc.key, { sA: exc.sA, sB: exc.sB });
  } else {
    bracket.sA = Math.min(bracket.sA, exc.sA);
    bracket.sB = Math.max(bracket.sB, exc.sB);
  }
  target.startedAt = Math.min(target.startedAt, exc.t0);
  target.lastEvidenceAt = Math.max(target.lastEvidenceAt, exc.t1);
  recomputeCentroid(target);

  // Fresh diversion evidence contradicts recovery/staleness: back to active,
  // and recovery passages must be re-earned from scratch.
  target.passages.clear();
  target.passedVehicles.clear();
  if (target.status !== 'active') {
    target.status = 'active';
    target.recoveringAt = null;
    transitions.push(transitionOf(target, nowSec, 'reactivated'));
  }

  if (!target.displayWorthy && isDisplayWorthy(target)) {
    target.displayWorthy = true;
    transitions.push(transitionOf(target, nowSec, 'displayed'));
  }
  return transitions;
}

/**
 * Feed one on-route fix into recovery tracking: a vehicle of an affected
 * route traversing the bypassed bracket on-route (|d| < thr through
 * [s_exit, s_rejoin]) is evidence the road reopened.
 */
export function noteOnRouteFix(
  store: EventStore,
  key: string,
  veh: string,
  s: number,
  nowSec: number,
): TransitionRecord[] {
  const transitions: TransitionRecord[] = [];
  for (const ev of store.events) {
    if (ev.status !== 'active') continue;
    const bracket = ev.brackets.get(key);
    if (bracket === undefined) continue;
    if (s < bracket.sA - RECOVERY_PASS_MARGIN_M || s > bracket.sB + RECOVERY_PASS_MARGIN_M) continue;
    const passKey = `${key}|${veh}`;
    let passage = ev.passages.get(passKey);
    if (passage === undefined) {
      evictOldestIfFull(ev.passages);
      passage = { minS: s, maxS: s, broken: false };
      ev.passages.set(passKey, passage);
    }
    passage.minS = Math.min(passage.minS, s);
    passage.maxS = Math.max(passage.maxS, s);
    if (
      !passage.broken &&
      passage.minS <= bracket.sA + RECOVERY_PASS_MARGIN_M &&
      passage.maxS >= bracket.sB - RECOVERY_PASS_MARGIN_M
    ) {
      ev.passedVehicles.add(veh);
      if (ev.passedVehicles.size >= RECOVERY_MIN_VEHICLES) {
        ev.status = 'recovering';
        ev.recoveringAt = nowSec;
        transitions.push(transitionOf(ev, nowSec, 'recovering'));
      }
    }
  }
  return transitions;
}

/** An off-route fix inside a bracket breaks that vehicle's recovery passage —
 * it demonstrably did NOT get through on-route. */
export function noteOffRouteFix(store: EventStore, key: string, veh: string, s: number): void {
  for (const ev of store.events) {
    if (ev.status !== 'active') continue;
    const bracket = ev.brackets.get(key);
    if (bracket === undefined || s < bracket.sA || s > bracket.sB) continue;
    const passage = ev.passages.get(`${key}|${veh}`);
    if (passage !== undefined) passage.broken = true;
  }
}

/** Time-driven transitions: active → stale, stale → dropped, recovering →
 * dropped. Dropped events are removed from the store. */
export function tickLifecycle(store: EventStore, nowSec: number): TransitionRecord[] {
  const transitions: TransitionRecord[] = [];
  const kept: DiversionEvent[] = [];
  for (const ev of store.events) {
    const sinceEvidence = nowSec - ev.lastEvidenceAt;
    if (ev.status === 'recovering' && ev.recoveringAt !== null) {
      if (nowSec - ev.recoveringAt >= RECOVERING_DROP_AFTER_S) {
        transitions.push(transitionOf(ev, nowSec, 'dropped'));
        continue;
      }
    } else if (ev.status === 'active' && sinceEvidence >= STALE_AFTER_S) {
      ev.status = 'stale';
      transitions.push(transitionOf(ev, nowSec, 'stale'));
    } else if (ev.status === 'stale' && sinceEvidence >= STALE_AFTER_S + STALE_DROP_AFTER_S) {
      transitions.push(transitionOf(ev, nowSec, 'dropped'));
      continue;
    }
    kept.push(ev);
  }
  store.events = kept;
  return transitions;
}

// ---------------------------------------------------------------------------
// API payload assembly
// ---------------------------------------------------------------------------

export interface TflEnrichment {
  loc: string;
  dist: number;
}

export interface ApiDiversionEvent {
  id: string;
  status: EventStatus;
  /** 'road': >=2 route-directions divert here — the road itself has a
   * problem. 'partial': one direction of one route — those buses are
   * diverting, but the road is otherwise flowing (drawn amber, softer
   * wording; the SL8 case that confused a live user: inbound ran normally
   * while outbound looped around). */
  severity: 'road' | 'partial';
  startedAt: number;
  lastEvidenceAt: number;
  /** human labels, destination-signed when known: "SL8 → Uxbridge" */
  routes: string[];
  vehicles: number;
  longRunning: boolean;
  centroid: [number, number];
  segments: Array<Array<[number, number]>>;
  tfl: TflEnrichment | null;
}

export interface DiversionsPayload {
  generatedAt: number;
  events: ApiDiversionEvent[];
}

const round5 = (v: number): number => Math.round(v * 1e5) / 1e5;

export function buildApiEvents(
  store: EventStore,
  nowSec: number,
  getPoly: (key: string) => readonly LonLat[] | null,
  tflMatch: (lon: number, lat: number) => TflEnrichment | null,
): DiversionsPayload {
  const events: ApiDiversionEvent[] = [];
  for (const ev of store.events) {
    if (!ev.displayWorthy) continue;
    // Attribution comes from HIGH-confidence members only (see
    // highConfidenceBrackets) — never from ev.brackets, which includes
    // LOW-only hitchhiker routes.
    const brackets = highConfidenceBrackets(ev);
    const segments: Array<Array<[number, number]>> = [];
    // TfL is matched against BRACKET midpoints — the middle of the bypassed
    // stretch ON the learned polyline, which sits at the works itself. The
    // excursion-path midpoint (the detour apex) lies a parallel street away
    // and the multi-route centroid drifts further still: in the replay the
    // A23 closure matched @~100 m by bracket midpoint and missed by both
    // alternatives.
    let tfl: TflEnrichment | null = null;
    for (const [key, bracket] of brackets) {
      const poly = getPoly(key);
      if (poly === null) continue;
      const midS = (bracket.sA + bracket.sB) / 2;
      const midSlice = slicePolyline(poly, midS - 1, midS + 1);
      const mid = midSlice[0];
      if (mid !== undefined) {
        const hit = tflMatch(mid[0], mid[1]);
        if (hit !== null && (tfl === null || hit.dist < tfl.dist)) tfl = hit;
      }
      if (segments.length >= MAX_EVENT_SEGMENTS) continue;
      const slice = slicePolyline(poly, bracket.sA, bracket.sB);
      if (slice.length >= 2) {
        segments.push(slice.map(([lon, lat]) => [round5(lon), round5(lat)]));
      }
    }
    events.push({
      id: ev.id,
      status: ev.status,
      severity: brackets.size >= 2 ? 'road' : 'partial',
      startedAt: ev.startedAt,
      lastEvidenceAt: ev.lastEvidenceAt,
      routes: routeLabels(brackets.keys(), ev.members),
      vehicles: ev.vehicles.size,
      longRunning: ev.lastEvidenceAt - ev.startedAt > LONG_RUNNING_S,
      centroid: [round5(ev.centroid[0]), round5(ev.centroid[1])],
      segments,
      tfl,
    });
  }
  return { generatedAt: nowSec, events };
}

// ---------------------------------------------------------------------------
// TfL road-disruption enrichment (never gating)
// ---------------------------------------------------------------------------

export interface TflDisruptionPoint {
  loc: string;
  lon: number;
  lat: number;
}

/** Parse the LAST line of the newest road-disruptions day file into match
 * candidates. The snapshot recorder appends one full snapshot per line, so
 * the last line of the newest file is the current disruption set. */
export function parseDisruptionSnapshotLine(line: string): TflDisruptionPoint[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [];
  }
  const disruptions = (parsed as { disruptions?: unknown }).disruptions;
  if (!Array.isArray(disruptions)) return [];
  const out: TflDisruptionPoint[] = [];
  for (const raw of disruptions) {
    const { loc, pt } = (raw ?? {}) as { loc?: unknown; pt?: unknown };
    if (typeof pt !== 'string') continue;
    let coords: unknown;
    try {
      coords = JSON.parse(pt);
    } catch {
      continue;
    }
    if (!Array.isArray(coords) || typeof coords[0] !== 'number' || typeof coords[1] !== 'number') {
      continue;
    }
    out.push({ loc: typeof loc === 'string' ? loc : '', lon: coords[0], lat: coords[1] });
  }
  return out;
}

export function matchTfl(
  disruptions: readonly TflDisruptionPoint[],
  lon: number,
  lat: number,
): TflEnrichment | null {
  let best: TflEnrichment | null = null;
  for (const d of disruptions) {
    const dist = metresBetween(lon, lat, d.lon, d.lat);
    if (dist <= TFL_MATCH_DIST_M && (best === null || dist < best.dist)) {
      best = { loc: d.loc, dist: Math.round(dist) };
    }
  }
  return best;
}
