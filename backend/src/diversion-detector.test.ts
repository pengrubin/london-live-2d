import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { Bus } from './bods-client';
import {
  createGuardCounters,
  createVehicleState,
  isDiversionDetectorRunning,
  oppositeKey,
  pruneVehicleStates,
  startDiversionDetector,
  stepVehicle,
  type FixInput,
  type StepContext,
} from './diversion-detector';
import {
  addExcursion,
  buildApiEvents,
  createEventStore,
  matchTfl,
  noteOffRouteFix,
  noteOnRouteFix,
  parseDisruptionSnapshotLine,
  tickLifecycle,
  type CompletedExcursion,
} from './diversion-events';
import { buildRouteIndex, type LonLat } from './route-projection';

// ---------------------------------------------------------------------------
// synthetic geometry: a straight 10 km north-south route
// ---------------------------------------------------------------------------

const LAT0 = 51.5;
const LON0 = -0.1;
const M_PER_DEG_LAT = 110_540;
const M_PER_DEG_LON = 111_320 * Math.cos((51.545 * Math.PI) / 180); // route mean lat

const latAt = (metres: number): number => LAT0 + metres / M_PER_DEG_LAT;
const lonAt = (offsetM: number): number => LON0 + offsetM / M_PER_DEG_LON;

const ROUTE_KEY = 'OP:45:outbound';
const ROUTE_POLY: LonLat[] = [
  [LON0, latAt(0)],
  [LON0, latAt(10_000)],
];
const ROUTE_INDEX = buildRouteIndex(ROUTE_POLY);
const THR_M = 75; // the no-rollup default: max(50, 5 × 15)

const T0 = 1_000_000;
const STEP_S = 15;

function makeCtx(overrides: Partial<StepContext> = {}): StepContext {
  return {
    key: ROUTE_KEY,
    veh: 'OP:V1',
    dest: '',
    thrM: THR_M,
    index: ROUTE_INDEX,
    oppIndex: null,
    counters: createGuardCounters(),
    ...overrides,
  };
}

/** Fix at along-route position sM with a lateral offset (east = positive). */
const fixAt = (t: number, sM: number, offsetM = 0): FixInput => ({
  t,
  lon: lonAt(offsetM),
  lat: latAt(sM),
});

/** Drive one vehicle through a fix sequence, collecting everything emitted. */
function drive(
  fixes: readonly FixInput[],
  ctx: StepContext,
): { completed: CompletedExcursion[]; onRouteCount: number } {
  const state = createVehicleState();
  const completed: CompletedExcursion[] = [];
  let onRouteCount = 0;
  for (const fix of fixes) {
    const result = stepVehicle(state, fix, ctx);
    completed.push(...result.completed);
    if (result.onRouteS !== null) onRouteCount += 1;
  }
  return { completed, onRouteCount };
}

/** On-route warm-up from s=0: clears the 500 m clip and banks the ≥2 on-route
 * fixes the before-bracket needs. Ends at s=1080, t = T0 + 9×15. */
function warmupFixes(): FixInput[] {
  const fixes: FixInput[] = [];
  for (let i = 0; i <= 9; i++) fixes.push(fixAt(T0 + i * STEP_S, i * 120));
  return fixes;
}
const AFTER_WARMUP_T = T0 + 9 * STEP_S;

/** The canonical detour: 150 m parallel offset for 6 fixes, then rejoin. */
function detourFixes(): FixInput[] {
  const fixes = warmupFixes();
  let t = AFTER_WARMUP_T;
  for (let i = 0; i < 6; i++) {
    t += STEP_S;
    fixes.push(fixAt(t, 1200 + i * 120, 150));
  }
  fixes.push(fixAt(t + STEP_S, 1920));
  fixes.push(fixAt(t + 2 * STEP_S, 2040));
  return fixes;
}

// ---------------------------------------------------------------------------
// per-vehicle state machine
// ---------------------------------------------------------------------------

describe('stepVehicle', () => {
  test('on-route → parallel offset → rejoin yields one HIGH-confidence excursion', () => {
    const ctx = makeCtx();

    const { completed } = drive(detourFixes(), ctx);

    expect(completed).toHaveLength(1);
    const exc = completed[0];
    expect(exc?.confidence).toBe('high');
    expect(exc?.key).toBe(ROUTE_KEY);
    expect(exc?.maxD).toBeGreaterThan(140);
    expect(exc?.maxD).toBeLessThan(160);
    // exit at the last on-route fix, rejoin at the first one after
    expect(Math.abs((exc?.sExit ?? 0) - 1080)).toBeLessThan(2);
    expect(Math.abs((exc?.sRejoin ?? 0) - 1920)).toBeLessThan(2);
    expect(exc?.nFix).toBe(6);
    expect(ctx.counters.completedHigh).toBe(1);
  });

  test('the first 500 m of a journey never count as evidence', () => {
    const ctx = makeCtx();
    // Straight off-route from the depot: offset fixes from the journey start.
    const fixes: FixInput[] = [];
    for (let i = 0; i < 8; i++) fixes.push(fixAt(T0 + i * STEP_S, i * 120, 150));

    const { completed, onRouteCount } = drive(fixes.slice(0, 4), ctx);

    expect(completed).toHaveLength(0);
    expect(onRouteCount).toBe(0); // clipped fixes are not on-route evidence either
  });

  test('garage pull-in (off-route at journey end, no rejoin) yields nothing', () => {
    const ctx = makeCtx();
    const fixes = warmupFixes();
    let t = AFTER_WARMUP_T;
    for (let i = 0; i < 8; i++) {
      t += STEP_S;
      fixes.push(fixAt(t, 1200 + i * 120, 200)); // veers off toward the garage
    }
    fixes.push(fixAt(t + 700, 5_000)); // next journey, 700 s later

    const { completed } = drive(fixes, ctx);

    expect(completed).toHaveLength(0);
    expect(ctx.counters.completedHigh + ctx.counters.completedLow).toBe(0);
  });

  test('dwell-only excursion (moving fraction < 30%) is LOW confidence', () => {
    const ctx = makeCtx();
    const fixes = warmupFixes();
    let t = AFTER_WARMUP_T;
    // two fast off-route hops (real movement ≥ 300 m)…
    for (const s of [1200, 1400, 1600]) {
      t += STEP_S;
      fixes.push(fixAt(t, s, 150));
    }
    // …then 20 fixes parked at the same spot
    for (let i = 0; i < 20; i++) {
      t += STEP_S;
      fixes.push(fixAt(t, 1600, 150));
    }
    fixes.push(fixAt(t + STEP_S, 1720));
    fixes.push(fixAt(t + 2 * STEP_S, 1840));

    const { completed } = drive(fixes, ctx);

    expect(completed).toHaveLength(1);
    expect(completed[0]?.confidence).toBe('low');
    expect(ctx.counters.completedLow).toBe(1);
  });

  test('a >180 s gap inside an excursion resets its accumulation', () => {
    const ctx = makeCtx();
    const fixes = warmupFixes();
    let t = AFTER_WARMUP_T;
    for (const s of [1200, 1320, 1440]) {
      t += STEP_S;
      fixes.push(fixAt(t, s, 150));
    }
    t += 200; // hole > EXCURSION_GAP_RESET_S, < the 600 s journey split
    for (const s of [1560, 1680, 1800]) {
      fixes.push(fixAt(t, s, 150));
      t += STEP_S;
    }
    fixes.push(fixAt(t, 1920));
    fixes.push(fixAt(t + STEP_S, 2040));

    const { completed } = drive(fixes, ctx);

    // post-reset run is only 3 fixes — below the 5-fix bar, so no excursion
    expect(completed).toHaveLength(0);
    expect(ctx.counters.gapResets).toBe(1);
    expect(ctx.counters.minorRun).toBe(1);
  });

  test('beyond-terminus wandering is rejected by the endpoint-clamp guard', () => {
    const ctx = makeCtx();
    const fixes: FixInput[] = [];
    let t = T0;
    for (let i = 0; i <= 10; i++) {
      fixes.push(fixAt(t, 8000 + i * 120)); // on-route toward the terminus
      t += STEP_S;
    }
    for (let i = 1; i <= 5; i++) {
      fixes.push(fixAt(t, 10_000 + i * 120)); // straight past the end: s clamps
      t += STEP_S;
    }
    fixes.push(fixAt(t, 9920)); // comes back onto the route
    fixes.push(fixAt(t + STEP_S, 9800));

    const { completed } = drive(fixes, ctx);

    expect(completed).toHaveLength(0);
    expect(ctx.counters.clampInvalid).toBe(1);
  });

  test('direction mislabel: the excursion lies ON the opposite polyline → discarded', () => {
    const oppositePoly: LonLat[] = [
      [lonAt(150), latAt(10_000)],
      [lonAt(150), latAt(0)],
    ];
    const ctx = makeCtx({ oppIndex: buildRouteIndex(oppositePoly) });

    const { completed } = drive(detourFixes(), ctx);

    expect(completed).toHaveLength(0);
    expect(ctx.counters.mislabelDropped).toBe(1);
  });

  test('wanderer guard: huge ground for a tiny skipped interval → rejected', () => {
    const ctx = makeCtx();
    const fixes = warmupFixes();
    let t = AFTER_WARMUP_T;
    // 30 fast fixes sweeping 3.5 km east and back while skipping ~600 m of route
    for (let i = 0; i < 15; i++) {
      t += STEP_S;
      fixes.push(fixAt(t, 1200 + i * 20, 150 + i * 230));
    }
    for (let i = 14; i >= 0; i--) {
      t += STEP_S;
      fixes.push(fixAt(t, 1500 + (14 - i) * 20, 150 + i * 230));
    }
    fixes.push(fixAt(t + STEP_S, 1920));
    fixes.push(fixAt(t + 2 * STEP_S, 2040));

    const { completed } = drive(fixes, ctx);

    expect(completed).toHaveLength(0);
    expect(ctx.counters.wandererDropped).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// site-keyed clustering + lifecycle
// ---------------------------------------------------------------------------

function mkExc(overrides: Partial<CompletedExcursion>): CompletedExcursion {
  return {
    key: ROUTE_KEY,
    veh: 'OP:V1',
    dest: '',
    t0: T0,
    t1: T0 + 300,
    sExit: 1080,
    sRejoin: 1920,
    sA: 1080,
    sB: 1920,
    maxD: 150,
    nFix: 6,
    groundM: 600,
    midLon: lonAt(150),
    midLat: latAt(1500),
    confidence: 'high',
    ...overrides,
  };
}

describe('event clustering', () => {
  test('two HIGH vehicles at one site within 45 min → one display-worthy event', () => {
    const store = createEventStore();

    const first = addExcursion(store, mkExc({ veh: 'OP:V1' }), T0 + 300);
    const second = addExcursion(
      store,
      mkExc({ veh: 'OP:V2', t0: T0 + 600, t1: T0 + 900, midLat: latAt(1700) }),
      T0 + 900,
    );

    expect(first.map((r) => r.transition)).toEqual(['created']);
    expect(second.map((r) => r.transition)).toEqual(['displayed']);
    expect(store.events).toHaveLength(1);
    expect(store.events[0]?.id).toMatch(/^div-\d{4}-\d{2}-\d{2}-1$/);
    expect(store.events[0]?.vehicles.size).toBe(2);
  });

  test('cross-route excursions merge by SITE, not route family', () => {
    const store = createEventStore();

    addExcursion(store, mkExc({ veh: 'OP:V1' }), T0 + 300);
    addExcursion(
      store,
      mkExc({ key: 'OP:133:inbound', veh: 'OP:V9', midLat: latAt(1600) }),
      T0 + 300,
    );

    expect(store.events).toHaveLength(1);
    expect(store.events[0]?.brackets.size).toBe(2);
  });

  test('a site 2 km away opens a separate event', () => {
    const store = createEventStore();

    addExcursion(store, mkExc({}), T0 + 300);
    addExcursion(store, mkExc({ veh: 'OP:V2', midLat: latAt(3500) }), T0 + 300);

    expect(store.events).toHaveLength(2);
  });

  test('one vehicle alone is never display-worthy — even excursing twice', () => {
    const store = createEventStore();

    addExcursion(store, mkExc({}), T0 + 300);
    addExcursion(store, mkExc({ t0: T0 + 400, t1: T0 + 700 }), T0 + 700);

    expect(store.events[0]?.displayWorthy).toBe(false);
  });

  test('two LOW-confidence vehicles reach the day log but never the display bar', () => {
    const store = createEventStore();

    const first = addExcursion(store, mkExc({ confidence: 'low' }), T0 + 300);
    addExcursion(store, mkExc({ veh: 'OP:V2', confidence: 'low' }), T0 + 400);

    expect(first.map((r) => r.transition)).toEqual(['created']); // logged
    expect(store.events[0]?.displayWorthy).toBe(false);
  });
});

describe('lifecycle', () => {
  function displayWorthyStore(): ReturnType<typeof createEventStore> {
    const store = createEventStore();
    addExcursion(store, mkExc({ veh: 'OP:V1' }), T0 + 300);
    addExcursion(store, mkExc({ veh: 'OP:V2', t0: T0 + 600, t1: T0 + 900 }), T0 + 900);
    return store;
  }

  test('recovery passages by two vehicles flip the event to recovering, then drop it', () => {
    const store = displayWorthyStore();
    const transitions: string[] = [];
    for (const veh of ['OP:R1', 'OP:R2']) {
      for (let s = 1000; s <= 2000; s += 100) {
        transitions.push(
          ...noteOnRouteFix(store, ROUTE_KEY, veh, s, T0 + 2000).map((r) => r.transition),
        );
      }
    }

    expect(transitions).toEqual(['recovering']);
    expect(store.events[0]?.status).toBe('recovering');

    // 10 min later the recovered event leaves the API entirely
    const dropped = tickLifecycle(store, T0 + 2000 + 601);
    expect(dropped.map((r) => r.transition)).toEqual(['dropped']);
    expect(store.events).toHaveLength(0);
  });

  test('one recovery vehicle is not enough', () => {
    const store = displayWorthyStore();
    for (let s = 1000; s <= 2000; s += 100) {
      noteOnRouteFix(store, ROUTE_KEY, 'OP:R1', s, T0 + 2000);
    }

    expect(store.events[0]?.status).toBe('active');
  });

  test('fresh evidence reactivates a recovering event and resets its passages', () => {
    const store = displayWorthyStore();
    for (const veh of ['OP:R1', 'OP:R2']) {
      for (let s = 1000; s <= 2000; s += 100) noteOnRouteFix(store, ROUTE_KEY, veh, s, T0 + 2000);
    }
    expect(store.events[0]?.status).toBe('recovering');

    const transitions = addExcursion(
      store,
      mkExc({ veh: 'OP:V3', t0: T0 + 2100, t1: T0 + 2400 }),
      T0 + 2400,
    );

    expect(transitions.map((r) => r.transition)).toContain('reactivated');
    expect(store.events[0]?.status).toBe('active');
    expect(store.events[0]?.passages.size).toBe(0);
    const recovery = [...(store.events[0]?.recovery.values() ?? [])];
    expect(recovery.every((r) => r.cleanPassAt === null && !r.recovered)).toBe(true);
  });

  // One site, two route directions — what severity 'road' means. Retiring the
  // whole event when only one direction reopens would erase a live closure.
  const OTHER_KEY = 'OP:45:inbound';
  function twoKeyStore(): ReturnType<typeof createEventStore> {
    const store = displayWorthyStore();
    addExcursion(
      store,
      mkExc({ key: OTHER_KEY, veh: 'OP:V3', t0: T0 + 600, t1: T0 + 900, sA: 3000, sB: 3800 }),
      T0 + 900,
    );
    return store;
  }

  test('one direction fully re-driven does not retire the other direction', () => {
    const store = twoKeyStore();

    for (const veh of ['OP:R1', 'OP:R2']) {
      for (let s = 1080; s <= 1920; s += 60) noteOnRouteFix(store, ROUTE_KEY, veh, s, T0 + 2000);
    }

    expect(store.events[0]?.status).toBe('active'); // OP:45:inbound never cleared
  });

  test('a bus caught off-route again un-recovers its direction', () => {
    // Without this the recovered flag latches: the event could retire (and be
    // dropped ten minutes later) while a bus was provably still diverting.
    const store = twoKeyStore();
    for (const veh of ['OP:R1', 'OP:R2']) {
      for (let s = 1080; s <= 1920; s += 60) noteOnRouteFix(store, ROUTE_KEY, veh, s, T0 + 2000);
    }
    expect(store.events[0]?.recovery.get(ROUTE_KEY)?.recovered).toBe(true);

    noteOffRouteFix(store, ROUTE_KEY, 'OP:R1', 1200);
    expect(store.events[0]?.recovery.get(ROUTE_KEY)?.recovered).toBe(false);

    // Clearing the OTHER direction must no longer retire the whole event.
    for (const veh of ['OP:R3', 'OP:R4']) {
      for (let s = 3000; s <= 3800; s += 60) noteOnRouteFix(store, OTHER_KEY, veh, s, T0 + 2200);
    }
    expect(store.events[0]?.status).toBe('active');
  });

  test('an excursion dropped by the member cap creates no bracket to wait on', () => {
    // members is capped by count and never evicted, so a late excursion is not
    // drawn — it must not gate retirement either.
    const store = createEventStore();
    for (let i = 0; i < 500; i += 1) {
      addExcursion(store, mkExc({ veh: `OP:F${i}`, t0: T0 + i, t1: T0 + i + 30 }), T0 + i + 30);
    }
    expect(store.events[0]?.members.length).toBe(500);

    addExcursion(store, mkExc({ key: OTHER_KEY, veh: 'OP:LATE', sA: 3000, sB: 3800 }), T0 + 600);

    expect(store.events[0]?.recovery.get(OTHER_KEY)?.displayed).toBe(false);
  });

  test('quiet retirement waits for every drawn direction, then fires', () => {
    const store = twoKeyStore(); // last evidence T0 + 900

    for (let s = 3000; s <= 3200; s += 55) noteOnRouteFix(store, OTHER_KEY, 'OP:R9', s, T0 + 1000);
    expect(tickLifecycle(store, T0 + 900 + 20 * 60 + 1)).toEqual([]);
    expect(store.events[0]?.status).toBe('active');

    for (let s = 1080; s <= 1300; s += 55) noteOnRouteFix(store, ROUTE_KEY, 'OP:R1', s, T0 + 1100);

    const quiet = tickLifecycle(store, T0 + 900 + 20 * 60 + 2);
    expect(quiet.map((r) => r.transition)).toEqual(['recovering']);
  });

  test('two vehicles covering DIFFERENT halves stitch into one recovery', () => {
    // Bracket is [1080, 1920]. Neither vehicle spans it alone — the case a bus
    // that entered service mid-bracket creates, which used to hold the event
    // open until it timed out.
    const store = displayWorthyStore();
    const transitions: string[] = [];
    for (let s = 1080; s <= 1500; s += 60) {
      transitions.push(
        ...noteOnRouteFix(store, ROUTE_KEY, 'OP:R1', s, T0 + 2000).map((r) => r.transition),
      );
    }
    expect(store.events[0]?.status).toBe('active'); // half the bracket, one vehicle

    for (let s = 1500; s <= 1920; s += 60) {
      transitions.push(
        ...noteOnRouteFix(store, ROUTE_KEY, 'OP:R2', s, T0 + 2100).map((r) => r.transition),
      );
    }

    expect(transitions).toEqual(['recovering']);
    expect(store.events[0]?.status).toBe('recovering');
  });

  test('stitched passes that leave a gap in the middle do not recover the event', () => {
    const store = displayWorthyStore();
    for (let s = 1080; s <= 1300; s += 55) noteOnRouteFix(store, ROUTE_KEY, 'OP:R1', s, T0 + 2000);
    for (let s = 1750; s <= 1920; s += 55) noteOnRouteFix(store, ROUTE_KEY, 'OP:R2', s, T0 + 2100);

    // ~0.6 of the bracket covered, so the middle is still unproven.
    expect(store.events[0]?.status).toBe('active');
  });

  test('an off-route fix inside the bracket disqualifies that vehicle from stitching', () => {
    const store = displayWorthyStore();
    for (let s = 1080; s <= 1500; s += 60) noteOnRouteFix(store, ROUTE_KEY, 'OP:R1', s, T0 + 2000);
    noteOffRouteFix(store, ROUTE_KEY, 'OP:R1', 1200); // R1 demonstrably left the route
    for (let s = 1500; s <= 1920; s += 60) noteOnRouteFix(store, ROUTE_KEY, 'OP:R2', s, T0 + 2100);

    expect(store.events[0]?.status).toBe('active');
  });

  test('20 min quiet plus one clean pass retires the event without full coverage', () => {
    const store = displayWorthyStore(); // last evidence T0 + 900
    // A single bus drives part of the bracket — not enough to stitch coverage.
    for (let s = 1080; s <= 1300; s += 55) noteOnRouteFix(store, ROUTE_KEY, 'OP:R1', s, T0 + 1000);
    expect(store.events[0]?.status).toBe('active');

    const quiet = tickLifecycle(store, T0 + 900 + 20 * 60 + 1);
    expect(quiet.map((r) => r.transition)).toEqual(['recovering']);

    const dropped = tickLifecycle(store, T0 + 900 + 20 * 60 + 1 + 601);
    expect(dropped.map((r) => r.transition)).toEqual(['dropped']);
    expect(store.events).toHaveLength(0);
  });

  test('quiet alone does not retire an event when no bus has got through', () => {
    const store = displayWorthyStore();

    expect(tickLifecycle(store, T0 + 900 + 20 * 60 + 1)).toEqual([]);
    expect(store.events[0]?.status).toBe('active');

    // The 90 min staleness path still applies when nothing ever passes.
    expect(tickLifecycle(store, T0 + 900 + 90 * 60).map((r) => r.transition)).toEqual(['stale']);
  });

  test('active → stale at 90 min without evidence, dropped 6 h after that', () => {
    const store = displayWorthyStore();
    const lastEvidence = T0 + 900;

    const toStale = tickLifecycle(store, lastEvidence + 90 * 60);
    expect(toStale.map((r) => r.transition)).toEqual(['stale']);
    expect(store.events[0]?.status).toBe('stale'); // still served while stale

    const toDropped = tickLifecycle(store, lastEvidence + 90 * 60 + 6 * 3600);
    expect(toDropped.map((r) => r.transition)).toEqual(['dropped']);
    expect(store.events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// API payload + enrichment
// ---------------------------------------------------------------------------

describe('buildApiEvents', () => {
  test('serves exactly the contract for a display-worthy event', () => {
    const store = createEventStore();
    addExcursion(store, mkExc({ veh: 'OP:V1' }), T0 + 300);
    addExcursion(store, mkExc({ veh: 'OP:V2', key: 'OP:133:inbound' }), T0 + 900);

    const payload = buildApiEvents(
      store,
      T0 + 1000,
      (key) => (key === ROUTE_KEY ? ROUTE_POLY : null),
      () => null,
    );

    expect(payload.generatedAt).toBe(T0 + 1000);
    expect(payload.events).toHaveLength(1);
    const ev = payload.events[0];
    expect(ev?.id).toMatch(/^div-\d{4}-\d{2}-\d{2}-\d+$/);
    expect(ev?.status).toBe('active');
    expect(ev?.routes).toEqual(['45', '133']); // human line names, sorted
    expect(ev?.vehicles).toBe(2);
    expect(ev?.longRunning).toBe(false);
    // one segment: the 133 has no learned polyline in this fixture
    expect(ev?.segments).toHaveLength(1);
    const segment = ev?.segments[0] ?? [];
    expect(segment.length).toBeGreaterThanOrEqual(2);
    // the slice spans the bypassed bracket [1080, 1920]
    const sOf = (p: readonly [number, number]): number => (p[1] - LAT0) * M_PER_DEG_LAT;
    expect(Math.abs(sOf(segment[0] ?? [0, 0]) - 1080)).toBeLessThan(15);
    expect(Math.abs(sOf(segment[segment.length - 1] ?? [0, 0]) - 1920)).toBeLessThan(15);
    expect(ev?.tfl).toBeNull();
  });

  test('non-display-worthy events are never returned', () => {
    const store = createEventStore();
    addExcursion(store, mkExc({}), T0 + 300);

    const payload = buildApiEvents(store, T0 + 400, () => ROUTE_POLY, () => null);

    expect(payload.events).toHaveLength(0);
  });

  test('a route contributing only LOW-confidence excursions gets no name and no line (hitchhiker)', () => {
    const store = createEventStore();
    // route 45: two HIGH vehicles → the event is display-worthy
    addExcursion(store, mkExc({ veh: 'OP:V1' }), T0 + 300);
    addExcursion(store, mkExc({ veh: 'OP:V2', t0: T0 + 600, t1: T0 + 900 }), T0 + 900);
    // route 133: a LOW-confidence hitchhiker at the same site
    addExcursion(
      store,
      mkExc({ key: 'OP:133:inbound', veh: 'OP:V3', confidence: 'low', midLat: latAt(1600) }),
      T0 + 900,
    );

    // getPoly answers for EVERY key: were the 133's bracket wrongly kept, a
    // second segment would appear.
    const payload = buildApiEvents(store, T0 + 1000, () => ROUTE_POLY, () => null);

    expect(payload.events).toHaveLength(1);
    expect(payload.events[0]?.routes).toEqual(['45']); // no 133 in the popup
    expect(payload.events[0]?.segments).toHaveLength(1); // no red line for 133
  });

  test('longRunning flips once the evidence span exceeds 24 h', () => {
    const store = createEventStore();
    addExcursion(store, mkExc({ veh: 'OP:V1' }), T0 + 300);
    addExcursion(store, mkExc({ veh: 'OP:V2' }), T0 + 600);
    const ev = store.events[0];
    if (ev !== undefined) ev.lastEvidenceAt = T0 + 25 * 3600;

    const payload = buildApiEvents(store, T0 + 25 * 3600, () => ROUTE_POLY, () => null);

    expect(payload.events[0]?.longRunning).toBe(true);
  });
});

describe('TfL enrichment', () => {
  test('parses the recorder snapshot line and matches within 250 m', () => {
    const line = JSON.stringify({
      t: T0,
      disruptions: [
        { id: 'A', loc: 'HIGH ROAD closed', pt: `[${lonAt(100)},${latAt(1500)}]` },
        { id: 'B', loc: 'far away', pt: `[${lonAt(100)},${latAt(9000)}]` },
        { id: 'C', loc: 'no point' },
      ],
    });

    const points = parseDisruptionSnapshotLine(line);
    expect(points).toHaveLength(2);

    const hit = matchTfl(points, lonAt(150), latAt(1500));
    expect(hit?.loc).toBe('HIGH ROAD closed');
    expect(hit?.dist).toBeLessThan(100);

    expect(matchTfl(points, lonAt(150), latAt(5000))).toBeNull();
  });

  test('malformed snapshot lines yield no candidates instead of throwing', () => {
    expect(parseDisruptionSnapshotLine('not json')).toEqual([]);
    expect(parseDisruptionSnapshotLine('{"t":1}')).toEqual([]);
    expect(
      parseDisruptionSnapshotLine('{"disruptions":[{"pt":"broken["}]}'),
    ).toEqual([]);
  });
});

describe('oppositeKey', () => {
  test('pairs inbound and outbound, leaves other directions alone', () => {
    expect(oppositeKey('OP:45:outbound')).toBe('OP:45:inbound');
    expect(oppositeKey('OP:45:inbound')).toBe('OP:45:outbound');
    expect(oppositeKey('OP:45:unknown')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// full detector wiring (learned dir → record() → API events + day log)
// ---------------------------------------------------------------------------

describe('startDiversionDetector wiring', () => {
  let tmp = '';

  afterEach(async () => {
    if (tmp !== '') await rm(tmp, { recursive: true, force: true });
  });

  const toBus = (veh: string, fix: FixInput): Bus => ({
    id: veh,
    line: '45',
    operator: 'OP',
    direction: 'outbound',
    dest: 'Test Terminus',
    lat: fix.lat,
    lon: fix.lon,
    bearing: null,
    recordedAt: fix.t * 1000,
  });

  /** detourFixes() with the parallel offset widened to 500 m, time-shifted. */
  function detour500(tOffsetS: number): FixInput[] {
    const fixes: FixInput[] = [];
    for (let i = 0; i <= 9; i++) fixes.push(fixAt(T0 + tOffsetS + i * STEP_S, i * 120));
    let t = T0 + tOffsetS + 9 * STEP_S;
    for (let i = 0; i < 6; i++) {
      t += STEP_S;
      fixes.push(fixAt(t, 1200 + i * 120, 500));
    }
    fixes.push(fixAt(t + STEP_S, 1920));
    fixes.push(fixAt(t + 2 * STEP_S, 2040));
    return fixes;
  }

  test('two detouring vehicles produce one display-worthy event and a logged transition', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'diversions-wiring-'));
    await mkdir(join(tmp, 'bus-routes', 'learned'), { recursive: true });
    await writeFile(
      join(tmp, 'bus-routes', 'learned', 'OP_45_outbound.json'),
      JSON.stringify({ key: ROUTE_KEY, poly: ROUTE_POLY }),
    );
    await mkdir(join(tmp, 'bus-rollups'), { recursive: true });
    await writeFile(
      join(tmp, 'bus-rollups', '2026-08-27.json'),
      JSON.stringify({ routes: { [ROUTE_KEY]: { meanResidualM: 12 } } }),
    );

    const logs: string[] = [];
    const detector = startDiversionDetector(tmp, (msg) => logs.push(msg));
    try {
      expect(isDiversionDetectorRunning()).toBe(true);
      // The index build is async; record() drops fixes until it completes.
      await vi.waitFor(() => {
        expect(logs.some((m) => m.includes('route indexes built'))).toBe(true);
      });

      // Two vehicles, same on-route → 500 m parallel → rejoin sequence, 60 s
      // apart — timestamps carried by recordedAt, so no fake timers needed.
      const v1 = detour500(0);
      const v2 = detour500(60);
      for (let i = 0; i < v1.length; i++) {
        const f1 = v1[i];
        const f2 = v2[i];
        if (f1 === undefined || f2 === undefined) continue;
        detector.record([toBus('OP:V1', f1), toBus('OP:V2', f2)], f2.t * 1000);
      }

      const payload = await detector.snapshot();
      expect(payload.events).toHaveLength(1);
      expect(payload.events[0]?.status).toBe('active');
      expect(payload.events[0]?.routes).toEqual(['45 → Test Terminus']);
      expect(payload.events[0]?.vehicles).toBe(2);
      expect(payload.events[0]?.segments.length).toBeGreaterThanOrEqual(1);

      // Transition appends are a serialized async chain — wait for the file.
      const day = new Date(T0 * 1000).toISOString().slice(0, 10);
      const dayFile = join(tmp, 'diversions', `${day}.jsonl`);
      await vi.waitFor(async () => {
        const body = await readFile(dayFile, 'utf8');
        expect(body).toContain('"transition":"created"');
        expect(body).toContain('"transition":"displayed"');
      });
    } finally {
      detector.stop();
    }
    expect(isDiversionDetectorRunning()).toBe(false);
  });
});

describe('updateShapeGate', () => {
  test('stays open for healthy routes and suspends broken shapes, then recovers', async () => {
    const { createShapeGate, updateShapeGate } = await import('./diversion-detector');
    const gate = createShapeGate();
    // healthy: median |d| ~8 m, threshold 50 — never suspends
    for (let i = 0; i < 200; i += 1) updateShapeGate(gate, 8, 50);
    expect(gate.suspended).toBe(false);

    // broken shape: median jumps far beyond the threshold — suspends
    let flipped = false;
    for (let i = 0; i < 300; i += 1) flipped = updateShapeGate(gate, 400, 50) || flipped;
    expect(gate.suspended).toBe(true);
    expect(flipped).toBe(true);

    // re-learned shape: |d| back to noise — the gate re-opens
    for (let i = 0; i < 300; i += 1) updateShapeGate(gate, 6, 50);
    expect(gate.suspended).toBe(false);
  });
});

describe('severity and route labels', () => {
  test('one direction of one route is partial; a second direction makes it road', () => {
    const store = createEventStore();
    const t = [
      ...addExcursion(store, mkExc({ veh: 'OP:V1', dest: 'Uxbridge' }), T0 + 400),
      ...addExcursion(store, mkExc({ veh: 'OP:V2', dest: 'Uxbridge', t0: T0 + 60 }), T0 + 460),
    ];
    expect(t.length).toBeGreaterThan(0);
    const one = buildApiEvents(store, T0 + 500, () => ROUTE_POLY, () => null);
    expect(one.events[0]?.severity).toBe('partial');
    expect(one.events[0]?.routes).toEqual(['45 → Uxbridge']);

    // the opposite direction joins at the same site → the road itself is hit
    addExcursion(store, mkExc({ key: 'OP:45:inbound', veh: 'OP:V3', dest: 'Ealing' }), T0 + 520);
    addExcursion(store, mkExc({ key: 'OP:45:inbound', veh: 'OP:V4', dest: 'Ealing', t0: T0 + 60 }), T0 + 540);
    const two = buildApiEvents(store, T0 + 600, () => ROUTE_POLY, () => null);
    expect(two.events[0]?.severity).toBe('road');
    expect(two.events[0]?.routes).toEqual(['45 → Ealing', '45 → Uxbridge']);
  });
});

describe('credible-offset guard', () => {
  test('a kilometres-scale offset is LOW confidence even when moving', () => {
    const ctx = makeCtx();
    const fixes = warmupFixes();
    let t = AFTER_WARMUP_T;
    // moving the whole time, but 2 km off the route — shape/service mismatch
    for (let i = 0; i < 6; i++) {
      t += STEP_S;
      fixes.push(fixAt(t, 1200 + i * 120, 2000));
    }
    fixes.push(fixAt(t + STEP_S, 1920));
    fixes.push(fixAt(t + 2 * STEP_S, 2040));

    const { completed } = drive(fixes, ctx);

    expect(completed).toHaveLength(1);
    expect(completed[0]?.confidence).toBe('low');
  });
});

describe('credible-bracket guard', () => {
  test('a kilometres-long bypassed stretch is LOW confidence even when clean', () => {
    const ctx = makeCtx();
    const fixes = warmupFixes();
    let t = AFTER_WARMUP_T;
    // clean 150 m lateral offset, but skips 5 km of route before rejoining
    for (let i = 0; i < 40; i++) {
      t += STEP_S;
      fixes.push(fixAt(t, 1200 + i * 120, 150));
    }
    fixes.push(fixAt(t + STEP_S, 6200));
    fixes.push(fixAt(t + 2 * STEP_S, 6320));

    const { completed } = drive(fixes, ctx);

    expect(completed).toHaveLength(1);
    expect(completed[0]?.confidence).toBe('low');
  });
});

describe('pruneVehicleStates', () => {
  const TTL_S = 30 * 60;

  function stateAt(lastT: number) {
    const s = createVehicleState();
    s.lastT = lastT;
    return s;
  }

  test('drops only vehicles silent for longer than the TTL', () => {
    const now = T0 + 100_000;
    const states = new Map([
      ['fresh', stateAt(now - 60)],
      ['borderline', stateAt(now - TTL_S + 30)],
      ['finished-its-shift', stateAt(now - TTL_S - 1)],
    ]);

    const removed = pruneVehicleStates(states, now);

    expect(removed).toBe(1);
    expect([...states.keys()]).toEqual(['fresh', 'borderline']);
  });

  test('prunes a small map — the old size>=20000 throttle never fired at fleet scale', () => {
    // London's live fleet peaks near 9,000, so a threshold of 20,000 meant the
    // TTL never applied and stale states were retained indefinitely.
    const now = T0 + 100_000;
    const states = new Map(
      Array.from({ length: 9_000 }, (_, i) => [`v${i}`, stateAt(now - TTL_S - 1)] as const),
    );

    expect(pruneVehicleStates(states, now)).toBe(9_000);
    expect(states.size).toBe(0);
  });
});
