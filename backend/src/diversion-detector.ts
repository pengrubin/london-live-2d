// Real-time bus diversion detection — the online port of the validated batch
// prototype (scan-diversions.cjs; audit gate 8/10 confirmed, 0 garage
// artifacts) plus the four production guards from the final audit.
//
// Pipeline, riding the existing BODS poll exactly like TraceWriter:
//   1. per (route key, vehicle): project each fix → (s, d) against the learned
//      polyline; journeys split at 600 s gaps; the first 500 m of ground track
//      is excluded from evidence (depot pull-outs). The batch trailing-500 m
//      clip is subsumed online by the rejoin requirement — an excursion at a
//      journey's end never sees 2 on-route fixes after it, so it never counts.
//   2. excursion: ≥5 fixes |d| > max(50, 5×meanResidualM), ≥60 s, ≥300 m of
//      REAL movement (ground distance across consecutive fixes ≤60 s apart —
//      imputed jumps across gaps never count), bracketed by ≥2 on-route fixes
//      on BOTH sides with forward s-progression, wanderer-bounded ground.
//   3. production guards: endpoint clamp, ≥180 s in-excursion gap reset, dwell
//      (moving fraction <30% ⇒ LOW confidence), opposite-direction reprojection.
//   4. SITE-keyed clustering + lifecycle + API assembly + TfL enrichment live
//      in diversion-events.ts (the pure event-store half of this pipeline).
//
// Every event state transition is appended to <busDataDir>/diversions/
// YYYY-MM-DD.jsonl. On boot the detector starts empty — events rebuild from
// live traffic within minutes, so no active-state file is needed.

import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Bus } from './bods-client';
import {
  addExcursion,
  buildApiEvents,
  createEventStore,
  matchTfl,
  median,
  metresBetween,
  noteOffRouteFix,
  noteOnRouteFix,
  parseDisruptionSnapshotLine,
  tickLifecycle,
  utcDay,
  type CompletedExcursion,
  type Confidence,
  type DiversionsPayload,
  type TflDisruptionPoint,
  type TransitionRecord,
} from './diversion-events';
import { buildRouteIndex, type LonLat, type RouteIndex } from './route-projection';

// --- tuning constants (task spec + prototype calibration; do not retune
// without re-running the audit gate) ---
const GAP_SPLIT_S = 600;
const CLIP_M = 500;
const MIN_RUN_FIXES = 5;
const MIN_RUN_DURATION_S = 60;
const MIN_RUN_REAL_GROUND_M = 300;
/** Ground between consecutive fixes further apart than this is imputed, not real. */
const REAL_MOVE_MAX_DT_S = 60;
const THRESHOLD_FLOOR_M = 50;
const THRESHOLD_RESIDUAL_MULT = 5;
const DEFAULT_RESIDUAL_M = 15;
const MIN_ON_ROUTE_BRACKET_FIXES = 2;
/** Forward-progression medians use this many recent on-route fixes. */
const BEFORE_S_WINDOW = 32;
// wanderer guard (prototype): a genuine detour's ground distance is
// commensurate with the skipped s-interval; terminus overruns and wrong-route
// journeys travel far while skipping little route.
const WANDERER_GROUND_FLOOR_M = 2500;
const WANDERER_GROUND_MULT = 4;
const WANDERER_MIN_SKIP_M = 500;
// production guards (final audit)
const EXCURSION_GAP_RESET_S = 180;
const CLAMP_FIX_FRAC_MAX = 0.2;
/** Projections within this of s=0 / s=max are endpoint clamps. */
const CLAMP_END_EPS_M = 1;
const ENDPOINT_LOCUS_M = 200;
const DWELL_SPEED_MS = 2;
const DWELL_MOVING_FRAC_MIN = 0.3;
/** Beyond this |d|, "diversion" is no longer the credible explanation. */
const MAX_CREDIBLE_D_M = 1500;
/** Beyond this bypassed-stretch length, likewise: a street closure diverts
 * you around hundreds of metres, occasionally 2-3 km — never 10+. Live case:
 * coach/mismatched-shape vehicles leaving near a route's start and rejoining
 * near its end painted 11-15 km washes across half of north-west London. */
const MAX_CREDIBLE_BRACKET_M = 4000;
const MISLABEL_SAMPLE_N = 15;
// memory bounds
const EXC_FIX_CAP = 2000;
const PENDING_CAP = 4;
const VEHICLE_STATE_TTL_S = 30 * 60;

const LIFECYCLE_TICK_MS = 60_000;
const TFL_SNAPSHOT_TTL_MS = 10 * 60_000;
const INDEX_BUILD_YIELD_EVERY = 100;
/** The learner re-learns polylines daily — re-index on the same cadence so
 * the detector never projects against boot-frozen geometry forever. */
const INDEX_REBUILD_INTERVAL_MS = 24 * 3600_000;
/** Guard-counter summary cadence: one line per hour, only when nonzero. */
const GUARD_LOG_INTERVAL_MS = 3600_000;

export function oppositeKey(key: string): string | null {
  if (key.endsWith(':inbound')) return `${key.slice(0, -':inbound'.length)}:outbound`;
  if (key.endsWith(':outbound')) return `${key.slice(0, -':outbound'.length)}:inbound`;
  return null;
}

// ---------------------------------------------------------------------------
// per-vehicle online state machine
// ---------------------------------------------------------------------------

export interface FixInput {
  /** epoch seconds */
  t: number;
  lon: number;
  lat: number;
}

interface ExcFix {
  t: number;
  lon: number;
  lat: number;
  s: number;
}

interface ExcursionAcc {
  t0: number;
  tLast: number;
  nFix: number;
  /** ground across consecutive exc fixes ≤ REAL_MOVE_MAX_DT_S apart */
  realGroundM: number;
  /** ground across ALL consecutive exc fixes (wanderer guard, as in batch) */
  totalGroundM: number;
  movingPairs: number;
  totalPairs: number;
  clampCount: number;
  maxD: number;
  /** last on-route s before departure (batch: ss[i-1]) */
  sExit: number;
  /** journey on-route context frozen at excursion start */
  beforeCount: number;
  beforeMedianS: number;
  fixes: ExcFix[];
}

interface PendingExcursion {
  exc: ExcursionAcc;
  /** first on-route s after the run (batch: ss[j]) */
  sRejoin: number;
  afterOnS: number[];
}

export interface VehicleState {
  lastT: number;
  lastLon: number;
  lastLat: number;
  lastS: number;
  /** |d| of the latest projection — feeds the per-route shape gate. */
  lastAbsD: number;
  hasLast: boolean;
  journeyGroundM: number;
  /** recent on-route s values this journey, post-clip (forward progression) */
  beforeOnS: number[];
  beforeCount: number;
  exc: ExcursionAcc | null;
  pendings: PendingExcursion[];
}

/**
 * Forget vehicles that have gone quiet for longer than the TTL, and report how
 * many were dropped.
 *
 * This used to be throttled by `states.size < 20_000`, a guard against
 * scanning on every poll — but London's fleet peaks near 9,000, so the
 * threshold was never reached and the TTL never applied. A bus that ended its
 * shift mid-excursion kept its state forever, including up to EXC_FIX_CAP
 * fixes accumulated for a rejoin that would never come. It now runs on the
 * once-a-minute lifecycle tick, where a full scan of the live fleet is
 * microseconds and the TTL is what bounds the map.
 */
export function pruneVehicleStates(states: Map<string, VehicleState>, nowSec: number): number {
  const cutoff = nowSec - VEHICLE_STATE_TTL_S;
  let removed = 0;
  for (const [id, state] of states) {
    if (state.lastT < cutoff) {
      states.delete(id);
      removed += 1;
    }
  }
  return removed;
}

export function createVehicleState(): VehicleState {
  return {
    lastT: 0,
    lastLon: 0,
    lastLat: 0,
    lastS: 0,
    lastAbsD: 0,
    hasLast: false,
    journeyGroundM: 0,
    beforeOnS: [],
    beforeCount: 0,
    exc: null,
    pendings: [],
  };
}

/** Rejection counters — observable for tests and periodic operator logging. */
export interface GuardCounters {
  minorRun: number;
  noBracket: number;
  notForward: number;
  wandererDropped: number;
  clampInvalid: number;
  mislabelDropped: number;
  gapResets: number;
  pendingDropped: number;
  /** routes whose shape gate flipped to suspended (unreliable geometry). */
  shapeSuspended: number;
  completedHigh: number;
  completedLow: number;
}

export function createGuardCounters(): GuardCounters {
  return {
    minorRun: 0,
    noBracket: 0,
    notForward: 0,
    wandererDropped: 0,
    clampInvalid: 0,
    mislabelDropped: 0,
    gapResets: 0,
    pendingDropped: 0,
    shapeSuspended: 0,
    completedHigh: 0,
    completedLow: 0,
  };
}

export interface StepContext {
  key: string;
  veh: string;
  /** destination sign from the live feed — carried onto excursions. */
  dest: string;
  thrM: number;
  index: RouteIndex;
  oppIndex: RouteIndex | null;
  counters: GuardCounters;
}

export interface StepResult {
  /** set when this fix counted as on-route evidence (post-clip) */
  onRouteS: number | null;
  /** guard-passed excursions finalized by this fix */
  completed: CompletedExcursion[];
}

function resetJourney(state: VehicleState): void {
  // A 600 s gap ends the journey: an unfinished excursion has no rejoin and a
  // pending one loses its after-bracket — both are evidence of nothing.
  state.hasLast = false;
  state.journeyGroundM = 0;
  state.beforeOnS = [];
  state.beforeCount = 0;
  state.exc = null;
  state.pendings = [];
}

function startExcursion(state: VehicleState, fix: FixInput, s: number): ExcursionAcc {
  return {
    t0: fix.t,
    tLast: fix.t,
    nFix: 0,
    realGroundM: 0,
    totalGroundM: 0,
    movingPairs: 0,
    totalPairs: 0,
    clampCount: 0,
    maxD: 0,
    // batch sExitRaw = ss[i-1]: the previous journey fix's s when one exists
    sExit: state.hasLast ? state.lastS : s,
    beforeCount: state.beforeCount,
    beforeMedianS: median(state.beforeOnS),
    fixes: [],
  };
}

/** Guard (b): a >180 s hole inside an excursion resets its accumulation
 * (exit geometry and journey context are kept — the vehicle never returned
 * on-route, so the exit point still stands). */
function resetExcursionAccum(exc: ExcursionAcc, fix: FixInput): void {
  exc.t0 = fix.t;
  exc.tLast = fix.t;
  exc.nFix = 0;
  exc.realGroundM = 0;
  exc.totalGroundM = 0;
  exc.movingPairs = 0;
  exc.totalPairs = 0;
  exc.clampCount = 0;
  exc.maxD = 0;
  exc.fixes = [];
}

function accumulateExcursionFix(
  exc: ExcursionAcc,
  fix: FixInput,
  s: number,
  absD: number,
  totalLengthM: number,
): void {
  const prev = exc.fixes[exc.fixes.length - 1];
  if (prev !== undefined) {
    const dt = fix.t - prev.t;
    const ground = metresBetween(prev.lon, prev.lat, fix.lon, fix.lat);
    exc.totalGroundM += ground;
    if (dt <= REAL_MOVE_MAX_DT_S) exc.realGroundM += ground;
    exc.totalPairs += 1;
    if (dt > 0 && ground / dt > DWELL_SPEED_MS) exc.movingPairs += 1;
  }
  exc.nFix += 1;
  exc.tLast = fix.t;
  if (absD > exc.maxD) exc.maxD = absD;
  if (s <= CLAMP_END_EPS_M || s >= totalLengthM - CLAMP_END_EPS_M) exc.clampCount += 1;
  if (exc.fixes.length < EXC_FIX_CAP) exc.fixes.push({ t: fix.t, lon: fix.lon, lat: fix.lat, s });
}

/** All guards run at finalize time, mirroring the batch order:
 * mislabel → wanderer → bracket → forward → clamp → dwell(confidence). */
function finalizePending(pending: PendingExcursion, ctx: StepContext): CompletedExcursion | null {
  const { exc, sRejoin, afterOnS } = pending;
  const c = ctx.counters;

  // guard (d): direction mislabel — the excursion locus lies ON the paired
  // opposite-direction polyline, so it is a labeling error, not a diversion.
  if (ctx.oppIndex !== null && exc.fixes.length > 0) {
    const sampleN = Math.min(MISLABEL_SAMPLE_N, exc.fixes.length);
    const dOpp: number[] = [];
    for (let i = 0; i < sampleN; i++) {
      const fi = exc.fixes[Math.floor((i * (exc.fixes.length - 1)) / Math.max(1, sampleN - 1))];
      if (fi !== undefined) dOpp.push(Math.abs(ctx.oppIndex.projectFix(fi.lon, fi.lat).d));
    }
    if (median(dOpp) < ctx.thrM) {
      c.mislabelDropped += 1;
      return null;
    }
  }

  const skipped = Math.abs(sRejoin - exc.sExit);
  const allowedGround = Math.max(
    WANDERER_GROUND_FLOOR_M,
    WANDERER_GROUND_MULT * Math.max(skipped, WANDERER_MIN_SKIP_M),
  );
  if (exc.totalGroundM > allowedGround) {
    c.wandererDropped += 1;
    return null;
  }

  // garage-run guards: on-route on BOTH sides, progressing forward.
  if (
    exc.beforeCount < MIN_ON_ROUTE_BRACKET_FIXES ||
    afterOnS.length < MIN_ON_ROUTE_BRACKET_FIXES
  ) {
    c.noBracket += 1;
    return null;
  }
  if (!(sRejoin > exc.sExit) || !(median(afterOnS) > exc.beforeMedianS)) {
    c.notForward += 1;
    return null;
  }

  // guard (a): endpoint clamp — beyond-terminus wanderings project onto the
  // polyline ends and fabricate excursions there.
  const mid = exc.fixes[exc.fixes.length >> 1];
  const total = ctx.index.totalLengthM;
  const locusNearEnd =
    mid !== undefined && (mid.s < ENDPOINT_LOCUS_M || mid.s > total - ENDPOINT_LOCUS_M);
  if (exc.nFix > 0 && (exc.clampCount / exc.nFix > CLAMP_FIX_FRAC_MAX || locusNearEnd)) {
    c.clampInvalid += 1;
    return null;
  }

  // guard (c): dwell — a stationary off-route vehicle (stand, stuck GPS) is
  // weak evidence; kept, but only as LOW confidence.
  const movingFrac = exc.totalPairs > 0 ? exc.movingPairs / exc.totalPairs : 0;
  // guard (e): a street-level diversion stays within ~hundreds of metres of
  // the route; a kilometres-scale |d| means the learned shape and this
  // vehicle's actual service disagree (live case: 254s projecting 2-4 km off
  // hitchhiked their name onto a genuine 56/106 event). LOW keeps it logged
  // without letting it name routes or draw segments.
  const credibleD = exc.maxD <= MAX_CREDIBLE_D_M;
  // guard (f): the bypassed stretch itself must be street-closure sized —
  // laterally credible but kilometres-long brackets are shape/service
  // mismatch, not a diversion.
  const credibleBracket =
    Math.abs(Math.max(exc.sExit, sRejoin) - Math.min(exc.sExit, sRejoin)) <=
    MAX_CREDIBLE_BRACKET_M;
  const confidence: Confidence =
    movingFrac >= DWELL_MOVING_FRAC_MIN && credibleD && credibleBracket ? 'high' : 'low';
  if (confidence === 'high') c.completedHigh += 1;
  else c.completedLow += 1;

  return {
    key: ctx.key,
    veh: ctx.veh,
    dest: ctx.dest,
    t0: exc.t0,
    t1: exc.tLast,
    sExit: exc.sExit,
    sRejoin,
    sA: Math.min(exc.sExit, sRejoin),
    sB: Math.max(exc.sExit, sRejoin),
    maxD: Math.round(exc.maxD),
    nFix: exc.nFix,
    groundM: Math.round(exc.totalGroundM),
    midLon: mid?.lon ?? 0,
    midLat: mid?.lat ?? 0,
    confidence,
  };
}

/**
 * Advance one vehicle's state by one fix. Mutates `state` (bounded per-vehicle
 * hot-path state; immutably rebuilding it 9k times per poll would be pure GC
 * churn). Returns on-route evidence and any excursions finalized by this fix.
 */
export function stepVehicle(state: VehicleState, fix: FixInput, ctx: StepContext): StepResult {
  const out: StepResult = { onRouteS: null, completed: [] };
  if (state.hasLast && fix.t <= state.lastT) return out; // duplicate / rewind

  if (state.hasLast && fix.t - state.lastT > GAP_SPLIT_S) resetJourney(state);

  const proj = ctx.index.projectFix(fix.lon, fix.lat);
  const s = proj.s; // copy out — projectFix returns a shared scratch
  const absD = Math.abs(proj.d);

  if (state.hasLast) {
    state.journeyGroundM += metresBetween(state.lastLon, state.lastLat, fix.lon, fix.lat);
  }
  const clipped = state.journeyGroundM < CLIP_M;

  if (!clipped && absD <= ctx.thrM) {
    out.onRouteS = s;
    // feed pendings first: this fix is part of every waiting after-bracket
    const still: PendingExcursion[] = [];
    for (const pending of state.pendings) {
      pending.afterOnS.push(s);
      if (pending.afterOnS.length >= MIN_ON_ROUTE_BRACKET_FIXES) {
        const done = finalizePending(pending, ctx);
        if (done !== null) out.completed.push(done);
      } else {
        still.push(pending);
      }
    }
    state.pendings = still;
    // close the current excursion into a pending when it met the run bars
    if (state.exc !== null) {
      const exc = state.exc;
      state.exc = null;
      const dur = exc.tLast - exc.t0;
      if (exc.nFix >= MIN_RUN_FIXES && dur >= MIN_RUN_DURATION_S && exc.realGroundM >= MIN_RUN_REAL_GROUND_M) {
        if (state.pendings.length < PENDING_CAP) {
          state.pendings.push({ exc, sRejoin: s, afterOnS: [s] });
        } else {
          ctx.counters.pendingDropped += 1;
        }
      } else {
        ctx.counters.minorRun += 1;
      }
    }
    state.beforeCount += 1;
    state.beforeOnS.push(s);
    if (state.beforeOnS.length > BEFORE_S_WINDOW) state.beforeOnS.shift();
  } else if (!clipped) {
    if (state.exc === null) {
      state.exc = startExcursion(state, fix, s);
    } else if (fix.t - state.exc.tLast > EXCURSION_GAP_RESET_S) {
      resetExcursionAccum(state.exc, fix);
      ctx.counters.gapResets += 1;
    }
    accumulateExcursionFix(state.exc, fix, s, absD, ctx.index.totalLengthM);
  }
  // clipped fixes are position bookkeeping only — no evidence either way

  state.lastT = fix.t;
  state.lastLon = fix.lon;
  state.lastLat = fix.lat;
  state.lastS = s;
  state.lastAbsD = absD;
  state.hasLast = true;
  return out;
}

// ---------------------------------------------------------------------------
// per-route shape-reliability gate
// ---------------------------------------------------------------------------
//
// The offline calibration found learned shapes that sit hundreds of metres
// from where vehicles actually drive (long coach routes with branching
// variants, a few stale quiet routes: p50 |d| of 112-814 m vs 3-14 m on
// healthy routes). Excursion logic on such routes emits pure noise — the
// replay's worst false events were all of this class. This is the online port
// of the prototype's route-day p50 sanity gate: track a rolling median of
// |d| per route and SUSPEND detection while the median exceeds the excursion
// threshold itself — when the MEDIAN fix reads as "diverted", the shape, not
// the traffic, is wrong. Suspended routes keep projecting (cheap) so the gate
// re-opens after the nightly re-learn repairs the shape.

const GATE_RING = 256;
const GATE_EVAL_EVERY = 64;

export interface ShapeGate {
  ds: Float64Array;
  n: number;
  i: number;
  sinceEval: number;
  suspended: boolean;
}

export function createShapeGate(): ShapeGate {
  return { ds: new Float64Array(GATE_RING), n: 0, i: 0, sinceEval: 0, suspended: false };
}

/** Push one |d| sample; re-evaluates the median every GATE_EVAL_EVERY
 * samples. Returns true when the gate just flipped to suspended. */
export function updateShapeGate(gate: ShapeGate, absD: number, thrM: number): boolean {
  gate.ds[gate.i] = absD;
  gate.i = (gate.i + 1) % GATE_RING;
  if (gate.n < GATE_RING) gate.n += 1;
  gate.sinceEval += 1;
  if (gate.sinceEval < GATE_EVAL_EVERY || gate.n < GATE_EVAL_EVERY) return false;
  gate.sinceEval = 0;
  const sorted = [...gate.ds.subarray(0, gate.n)].sort((a, b) => a - b);
  const med = sorted[Math.floor(gate.n / 2)] ?? 0;
  const wasSuspended = gate.suspended;
  gate.suspended = med > thrM;
  return gate.suspended && !wasSuspended;
}

// ---------------------------------------------------------------------------
// detector wiring (closure, like startCoverageWriter)
// ---------------------------------------------------------------------------

interface RouteEntry {
  poly: LonLat[];
  index: RouteIndex;
}

export interface DiversionDetector {
  /** Ride-along on the BODS poll callback — synchronous CPU only, no IO. */
  record(buses: readonly Bus[], nowMs: number): void;
  snapshot(): Promise<DiversionsPayload>;
  /** Live map sizes for /health — the retention question, not the cost one. */
  sizes(): Record<string, number>;
  stop(): void;
}

// Whether a detector instance is live in this process — consulted by the
// capabilities route so the busDiversions flag mirrors reality instead of
// re-deriving it from config + directories. Module-level because at most one
// detector runs per process (app.ts starts it once, possibly after a
// fresh-volume retry).
let detectorRunning = false;
export const isDiversionDetectorRunning = (): boolean => detectorRunning;

export function startDiversionDetector(
  busDataDir: string,
  log: (msg: string) => void,
): DiversionDetector {
  const learnedDir = join(busDataDir, 'bus-routes', 'learned');
  const rollupsDir = join(busDataDir, 'bus-rollups');
  const disruptionsDir = join(busDataDir, 'road-disruptions');
  const diversionsDir = join(busDataDir, 'diversions');

  detectorRunning = true;
  let routes = new Map<string, RouteEntry>();
  let ready = false;
  let building = false;
  const states = new Map<string, VehicleState>(); // `${key}|${veh}`
  const gates = new Map<string, ShapeGate>(); // per route key
  const store = createEventStore();
  const counters = createGuardCounters();

  // meanResidualM thresholds — lazy, cached, refreshed when the UTC day rolls
  // (a new rollup lands at most once a day).
  let thresholds = new Map<string, number>();
  let thresholdsDay = '';
  let thresholdsLoading = false;

  // TfL snapshot cache for enrichment.
  let tflPoints: TflDisruptionPoint[] = [];
  let tflLoadedAt = 0;

  // Serialized transition-log appends: concurrent appendFile calls could
  // interleave lines from two polls.
  let logChain: Promise<void> = Promise.resolve();

  // Boot build AND daily rebuild share this path: the learner re-learns
  // polylines every day, so a boot-frozen index would drift from the geometry
  // the rest of the system serves. Built into a fresh map and swapped
  // wholesale so record() never sees a half-built set; in-flight vehicle
  // states keyed to a rebuilt route keep working — their s/d simply
  // re-project against the new index on the next fix.
  async function buildIndexes(): Promise<void> {
    if (building) return; // re-entrancy: a slow build must not overlap the next
    building = true;
    try {
      let names: string[] = [];
      try {
        names = (await readdir(learnedDir)).filter((n) => !n.startsWith('.') && n.endsWith('.json'));
      } catch {
        // dir vanished after the boot check — detector idles with zero routes
      }
      const next = new Map<string, RouteEntry>();
      let built = 0;
      for (const name of names) {
        try {
          const doc = JSON.parse(await readFile(join(learnedDir, name), 'utf8')) as {
            key?: unknown;
            poly?: unknown;
          };
          const { key, poly } = doc;
          const isValid =
            typeof key === 'string' &&
            Array.isArray(poly) &&
            poly.length >= 2 &&
            poly.every(
              (p) => Array.isArray(p) && typeof p[0] === 'number' && typeof p[1] === 'number',
            );
          if (isValid) {
            next.set(key, { poly: poly as LonLat[], index: buildRouteIndex(poly as LonLat[]) });
            built += 1;
          }
        } catch {
          // one unreadable learned file must not sink the detector
        }
        if (built % INDEX_BUILD_YIELD_EVERY === 0) {
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      }
      routes = next;
      ready = true;
      log(`diversions: ${routes.size} route indexes built`);
    } finally {
      building = false;
    }
  }
  void buildIndexes();
  const rebuildTimer = setInterval(() => void buildIndexes(), INDEX_REBUILD_INTERVAL_MS);
  rebuildTimer.unref();

  function refreshThresholds(nowMs: number): void {
    const today = new Date(nowMs).toISOString().slice(0, 10);
    if (thresholdsDay === today || thresholdsLoading) return;
    thresholdsLoading = true;
    void (async () => {
      try {
        const names = (await readdir(rollupsDir)).filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort();
        const newest = names[names.length - 1];
        const next = new Map<string, number>();
        if (newest !== undefined) {
          const doc = JSON.parse(await readFile(join(rollupsDir, newest), 'utf8')) as {
            routes?: Record<string, { meanResidualM?: unknown }>;
          };
          for (const [key, stats] of Object.entries(doc.routes ?? {})) {
            const resid = stats?.meanResidualM;
            if (typeof resid === 'number' && Number.isFinite(resid)) {
              next.set(key, Math.max(THRESHOLD_FLOOR_M, THRESHOLD_RESIDUAL_MULT * resid));
            }
          }
        }
        thresholds = next;
        thresholdsDay = today;
      } catch {
        thresholdsDay = today; // no rollups yet — defaults hold until tomorrow
      } finally {
        thresholdsLoading = false;
      }
    })();
  }

  const defaultThr = Math.max(THRESHOLD_FLOOR_M, THRESHOLD_RESIDUAL_MULT * DEFAULT_RESIDUAL_M);
  const thrFor = (key: string): number => thresholds.get(key) ?? defaultThr;

  function appendTransitions(transitions: readonly TransitionRecord[]): void {
    if (transitions.length === 0) return;
    const byDay = new Map<string, string[]>();
    for (const rec of transitions) {
      const day = utcDay(rec.t);
      const lines = byDay.get(day);
      if (lines === undefined) byDay.set(day, [JSON.stringify(rec)]);
      else lines.push(JSON.stringify(rec));
    }
    logChain = logChain.then(async () => {
      try {
        await mkdir(diversionsDir, { recursive: true });
        for (const [day, lines] of byDay) {
          await appendFile(join(diversionsDir, `${day}.jsonl`), `${lines.join('\n')}\n`, 'utf8');
        }
      } catch (err) {
        log(`diversions: transition log append failed: ${String(err)}`);
      }
    });
  }

  function record(buses: readonly Bus[], nowMs: number): void {
    if (!ready) return;
    refreshThresholds(nowMs);
    const nowSec = Math.floor(nowMs / 1000);
    const transitions: TransitionRecord[] = [];
    for (const bus of buses) {
      if (bus.line === '') continue;
      const key = `${bus.operator}:${bus.line}:${bus.direction}`;
      const route = routes.get(key);
      if (route === undefined) continue;
      let gate = gates.get(key);
      if (gate === undefined) {
        gate = createShapeGate();
        gates.set(key, gate);
      }
      if (gate.suspended) {
        // Untrusted shape: keep sampling (so the gate re-opens after the
        // nightly re-learn) but run no excursion logic.
        const proj = route.index.projectFix(bus.lon, bus.lat);
        updateShapeGate(gate, Math.abs(proj.d), thrFor(key));
        continue;
      }
      const stateKey = `${key}|${bus.id}`;
      let state = states.get(stateKey);
      if (state === undefined) {
        state = createVehicleState();
        states.set(stateKey, state);
      }
      const oppKey = oppositeKey(key);
      const ctx: StepContext = {
        key,
        veh: bus.id,
        dest: bus.dest,
        thrM: thrFor(key),
        index: route.index,
        oppIndex: oppKey === null ? null : (routes.get(oppKey)?.index ?? null),
        counters,
      };
      const fix: FixInput = { t: Math.round(bus.recordedAt / 1000), lon: bus.lon, lat: bus.lat };
      const result = stepVehicle(state, fix, ctx);
      if (updateShapeGate(gate, state.lastAbsD, ctx.thrM)) counters.shapeSuspended += 1;
      if (result.onRouteS !== null) {
        transitions.push(...noteOnRouteFix(store, key, bus.id, result.onRouteS, nowSec));
      } else if (state.exc !== null) {
        noteOffRouteFix(store, key, bus.id, state.lastS);
      }
      for (const exc of result.completed) {
        transitions.push(...addExcursion(store, exc, nowSec));
      }
    }
    appendTransitions(transitions);
  }

  const lifecycleTimer = setInterval(() => {
    const nowSec = Math.floor(Date.now() / 1000);
    pruneVehicleStates(states, nowSec);
    appendTransitions(tickLifecycle(store, nowSec));
  }, LIFECYCLE_TICK_MS);
  lifecycleTimer.unref();

  // Hourly guard observability: without this the counters are write-only.
  // Deltas against the last logged snapshot, one line, skipped when silent.
  let loggedCounters = createGuardCounters();
  function logGuardSummary(): void {
    const parts: string[] = [];
    for (const key of Object.keys(counters) as Array<keyof GuardCounters>) {
      const delta = counters[key] - loggedCounters[key];
      if (delta > 0) parts.push(`${key}=${delta}`);
    }
    if (parts.length === 0) return;
    loggedCounters = { ...counters };
    log(`diversions: 1h guards — ${parts.join(', ')}`);
  }
  const guardLogTimer = setInterval(logGuardSummary, GUARD_LOG_INTERVAL_MS);
  guardLogTimer.unref();

  async function loadTflPoints(): Promise<TflDisruptionPoint[]> {
    const nowMs = Date.now();
    if (nowMs - tflLoadedAt < TFL_SNAPSHOT_TTL_MS) return tflPoints;
    tflLoadedAt = nowMs;
    try {
      const names = (await readdir(disruptionsDir)).filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort();
      const newest = names[names.length - 1];
      if (newest === undefined) return (tflPoints = []);
      const body = await readFile(join(disruptionsDir, newest), 'utf8');
      const lines = body.split('\n').filter((l) => l.trim() !== '');
      const last = lines[lines.length - 1];
      tflPoints = last === undefined ? [] : parseDisruptionSnapshotLine(last);
    } catch {
      tflPoints = []; // enrichment only — never let it gate the payload
    }
    return tflPoints;
  }

  async function snapshot(): Promise<DiversionsPayload> {
    const points = await loadTflPoints();
    return buildApiEvents(
      store,
      Math.floor(Date.now() / 1000),
      (key) => routes.get(key)?.poly ?? null,
      (lon, lat) => matchTfl(points, lon, lat),
    );
  }

  return {
    record,
    snapshot,
    sizes: () => {
      let eventMembers = 0;
      let eventPassages = 0;
      for (const ev of store.events) {
        eventMembers += ev.members.length;
        eventPassages += ev.passages.size;
      }
      return {
        vehicleStates: states.size,
        routeIndexes: routes.size,
        shapeGates: gates.size,
        events: store.events.length,
        eventMembers,
        eventPassages,
      };
    },
    stop: () => {
      clearInterval(lifecycleTimer);
      clearInterval(rebuildTimer);
      clearInterval(guardLogTimer);
      detectorRunning = false;
    },
  };
}
