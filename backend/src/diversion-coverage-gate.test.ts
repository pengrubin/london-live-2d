// The detector's learned-route coverage gate: partial learned shapes (a
// polyline covering only part of the route) must not be indexed, must not
// open events, and events open on a key that drops out at the next rebuild
// must be retired rather than orphaned.

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { Bus } from './bods-client';
import { startDiversionDetector, type DiversionDetector } from './diversion-detector';
import {
  addExcursion,
  createEventStore,
  retireEventsOffIndex,
  type CompletedExcursion,
} from './diversion-events';
import { DETECTOR_MIN_COVERAGE, loadLearnedRoutes } from './learned-routes';
import type { LonLat } from './route-projection';

const LAT0 = 51.5;
const LON0 = -0.1;
const M_PER_DEG_LAT = 110_540;
const M_PER_DEG_LON = 111_320 * Math.cos((51.545 * Math.PI) / 180);
const latAt = (metres: number): number => LAT0 + metres / M_PER_DEG_LAT;
const lonAt = (offsetM: number): number => LON0 + offsetM / M_PER_DEG_LON;

const ROUTE_KEY = 'OP:45:outbound';
const ROUTE_POLY: LonLat[] = [
  [LON0, latAt(0)],
  [LON0, latAt(10_000)],
];
const T0 = 1_000_000;
const STEP_S = 15;

interface Fix {
  t: number;
  lon: number;
  lat: number;
}

const fixAt = (t: number, sM: number, offsetM = 0): Fix => ({ t, lon: lonAt(offsetM), lat: latAt(sM) });

const toBus = (veh: string, fix: Fix): Bus => ({
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

/** On-route warm-up, a parallel excursion of `offsetM` for 6 fixes, rejoin. */
function detour(tOffsetS: number, offsetM: number): Fix[] {
  const fixes: Fix[] = [];
  for (let i = 0; i <= 9; i++) fixes.push(fixAt(T0 + tOffsetS + i * STEP_S, i * 120));
  let t = T0 + tOffsetS + 9 * STEP_S;
  for (let i = 0; i < 6; i++) {
    t += STEP_S;
    fixes.push(fixAt(t, 1200 + i * 120, offsetM));
  }
  fixes.push(fixAt(t + STEP_S, 1920));
  fixes.push(fixAt(t + 2 * STEP_S, 2040));
  return fixes;
}

/** Two vehicles 60 s apart through the same detour — the display bar. */
function driveTwoDetours(detector: DiversionDetector, offsetM: number): void {
  const v1 = detour(0, offsetM);
  const v2 = detour(60, offsetM);
  for (let i = 0; i < v1.length; i++) {
    const f1 = v1[i];
    const f2 = v2[i];
    if (f1 === undefined || f2 === undefined) continue;
    detector.record([toBus('OP:V1', f1), toBus('OP:V2', f2)], f2.t * 1000);
  }
}

function learnedDoc(key: string, coverage: number | undefined): string {
  const quality: Record<string, number> = { journeys: 40, meanResidualM: 12 };
  if (coverage !== undefined) quality.coverage = coverage;
  return JSON.stringify({ key, poly: ROUTE_POLY, quality });
}

let tmp = '';
afterEach(async () => {
  if (tmp !== '') await rm(tmp, { recursive: true, force: true });
  tmp = '';
});

async function makeDataDir(files: Record<string, string>): Promise<string> {
  tmp = await mkdtemp(join(tmpdir(), 'diversions-coverage-'));
  const learned = join(tmp, 'bus-routes', 'learned');
  await mkdir(learned, { recursive: true });
  for (const [name, body] of Object.entries(files)) await writeFile(join(learned, name), body);
  await mkdir(join(tmp, 'bus-rollups'), { recursive: true });
  await writeFile(
    join(tmp, 'bus-rollups', '2026-08-27.json'),
    JSON.stringify({ routes: { [ROUTE_KEY]: { meanResidualM: 12 } } }),
  );
  return tmp;
}

const indexedLog = (logs: readonly string[]): string | undefined =>
  logs.find((m) => m.startsWith('detector: indexed '));

describe('loadLearnedRoutes coverage gate', () => {
  test('the threshold is 0.8', () => {
    expect(DETECTOR_MIN_COVERAGE).toBe(0.8);
  });

  test('skips keys below coverage 0.8, keeps those at/above it and those without a coverage field', async () => {
    const dir = await makeDataDir({
      'a.json': learnedDoc('OP:A:outbound', 0.5),
      'b.json': learnedDoc('OP:B:outbound', 0.79),
      'c.json': learnedDoc('OP:C:outbound', 0.8),
      'd.json': learnedDoc('OP:D:outbound', 0.95),
      'e.json': learnedDoc('OP:E:outbound', undefined),
    });
    const loaded = await loadLearnedRoutes(join(dir, 'bus-routes', 'learned'));
    expect([...loaded.routes.keys()].sort()).toEqual(['OP:C:outbound', 'OP:D:outbound', 'OP:E:outbound']);
    expect(loaded.skippedLowCoverage).toEqual([
      { key: 'OP:A:outbound', coverage: 0.5 },
      { key: 'OP:B:outbound', coverage: 0.79 },
    ]);
  });

  test('a key without a coverage field (pre-repair learner output) is indexed', async () => {
    const dir = await makeDataDir({ 'old.json': learnedDoc(ROUTE_KEY, undefined) });
    const loaded = await loadLearnedRoutes(join(dir, 'bus-routes', 'learned'));
    expect(loaded.routes.has(ROUTE_KEY)).toBe(true);
    expect(loaded.skippedLowCoverage).toEqual([]);
  });
});

describe('detector coverage gate wiring', () => {
  test('coverage 0.5: not indexed, and a far-off bus opens no event', async () => {
    const dir = await makeDataDir({ 'r.json': learnedDoc(ROUTE_KEY, 0.5) });
    const logs: string[] = [];
    const detector = startDiversionDetector(dir, (msg) => logs.push(msg));
    try {
      await vi.waitFor(() => expect(indexedLog(logs)).toBeDefined());
      // 3 km off the shape — what the uncovered half of a partial shape looks like
      driveTwoDetours(detector, 3000);
      driveTwoDetours(detector, 500);
      expect((await detector.snapshot()).events).toEqual([]);
      expect(detector.sizes()).toMatchObject({
        routeIndexes: 0,
        routeIndexesSkippedLowCoverage: 1,
        shapeGates: 0,
        vehicleStates: 0,
        events: 0,
      });
    } finally {
      detector.stop();
    }
  });

  test('coverage 0.95: indexed and detects a diversion as before', async () => {
    const dir = await makeDataDir({ 'r.json': learnedDoc(ROUTE_KEY, 0.95) });
    const logs: string[] = [];
    const detector = startDiversionDetector(dir, (msg) => logs.push(msg));
    try {
      await vi.waitFor(() => expect(indexedLog(logs)).toBeDefined());
      driveTwoDetours(detector, 500);
      const payload = await detector.snapshot();
      expect(payload.events).toHaveLength(1);
      expect(payload.events[0]?.vehicles).toBe(2);
      expect(detector.sizes()).toMatchObject({ routeIndexes: 1, routeIndexesSkippedLowCoverage: 0 });
    } finally {
      detector.stop();
    }
  });

  test('the counter and the summary log line report the skipped count', async () => {
    const dir = await makeDataDir({
      'a.json': learnedDoc('OP:A:outbound', 0.3),
      'b.json': learnedDoc('OP:B:outbound', 0.6),
      'c.json': learnedDoc('OP:C:outbound', 0.9),
      'd.json': learnedDoc('OP:D:outbound', undefined),
    });
    const logs: string[] = [];
    const detector = startDiversionDetector(dir, (msg) => logs.push(msg));
    try {
      await vi.waitFor(() => expect(indexedLog(logs)).toBeDefined());
      expect(indexedLog(logs)).toBe('detector: indexed 2 keys, skipped 2 below coverage 0.8');
      expect(detector.sizes()).toMatchObject({ routeIndexes: 2, routeIndexesSkippedLowCoverage: 2 });
    } finally {
      detector.stop();
    }
  });

  test('an event open on a key that is skipped at the next rebuild is retired, not orphaned', async () => {
    const dir = await makeDataDir({ 'r.json': learnedDoc(ROUTE_KEY, 0.95) });
    const logs: string[] = [];
    const detector = startDiversionDetector(dir, (msg) => logs.push(msg), {
      indexRebuildIntervalMs: 50,
    });
    try {
      await vi.waitFor(() => expect(indexedLog(logs)).toBeDefined());
      driveTwoDetours(detector, 500);
      expect((await detector.snapshot()).events).toHaveLength(1);

      // The nightly re-learn rewrites the shape as a partial one.
      await writeFile(join(dir, 'bus-routes', 'learned', 'r.json'), learnedDoc(ROUTE_KEY, 0.5));
      await vi.waitFor(() =>
        expect(logs).toContain('detector: indexed 0 keys, skipped 1 below coverage 0.8'),
      );

      expect((await detector.snapshot()).events).toEqual([]);
      expect(detector.sizes()).toMatchObject({ events: 0, shapeGates: 0, vehicleStates: 0 });
      const day = new Date(T0 * 1000).toISOString().slice(0, 10);
      const nowDay = new Date().toISOString().slice(0, 10);
      await vi.waitFor(async () => {
        const bodies = await Promise.all(
          [...new Set([day, nowDay])].map((d) =>
            readFile(join(dir, 'diversions', `${d}.jsonl`), 'utf8').catch(() => ''),
          ),
        );
        expect(bodies.join('')).toContain('"transition":"dropped"');
      });
    } finally {
      detector.stop();
    }
  });
});

function mkExc(overrides: Partial<CompletedExcursion>): CompletedExcursion {
  return {
    key: ROUTE_KEY,
    veh: 'OP:V1',
    dest: '',
    t0: T0,
    t1: T0 + 120,
    sExit: 1000,
    sRejoin: 1800,
    sA: 1000,
    sB: 1800,
    maxD: 150,
    nFix: 6,
    groundM: 900,
    midLon: lonAt(150),
    midLat: latAt(1400),
    confidence: 'high',
    ...overrides,
  };
}

describe('retireEventsOffIndex', () => {
  test('drops an event whose every key left the index and logs the drop', () => {
    const store = createEventStore();
    addExcursion(store, mkExc({ veh: 'OP:V1' }), T0 + 200);
    addExcursion(store, mkExc({ veh: 'OP:V2', t0: T0 + 60, t1: T0 + 180 }), T0 + 240);
    expect(store.events[0]?.displayWorthy).toBe(true);

    const transitions = retireEventsOffIndex(store, () => false, T0 + 300);
    expect(store.events).toEqual([]);
    expect(transitions.map((t) => t.transition)).toEqual(['dropped']);
    expect(transitions[0]?.event.routes).toEqual(['45']);
  });

  test('keeps an event that still has indexed keys, minus the departed key', () => {
    const store = createEventStore();
    const other = 'OP:56:inbound';
    addExcursion(store, mkExc({ veh: 'OP:V1' }), T0 + 200);
    addExcursion(store, mkExc({ veh: 'OP:V2', t0: T0 + 60, t1: T0 + 180 }), T0 + 240);
    addExcursion(store, mkExc({ key: other, veh: 'OP:V3' }), T0 + 250);
    addExcursion(store, mkExc({ key: other, veh: 'OP:V4', t0: T0 + 60, t1: T0 + 180 }), T0 + 260);
    expect(store.events).toHaveLength(1);

    const transitions = retireEventsOffIndex(store, (k) => k === other, T0 + 300);
    expect(transitions).toEqual([]);
    const ev = store.events[0];
    expect(ev?.members.every((m) => m.key === other)).toBe(true);
    expect([...(ev?.brackets.keys() ?? [])]).toEqual([other]);
    expect([...(ev?.recovery.keys() ?? [])]).toEqual([other]);
    expect([...(ev?.vehicles ?? [])].sort()).toEqual(['OP:V3', 'OP:V4']);
    expect(ev?.displayWorthy).toBe(true);
  });

  test('leaves events on indexed keys untouched', () => {
    const store = createEventStore();
    addExcursion(store, mkExc({}), T0 + 200);
    const before = store.events[0];
    expect(retireEventsOffIndex(store, () => true, T0 + 300)).toEqual([]);
    expect(store.events[0]).toBe(before);
    expect(before?.members).toHaveLength(1);
  });
});
