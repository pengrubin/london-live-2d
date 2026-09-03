import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  STOPPOINT_BATCH_MAX,
  loadCache,
  resolveStops,
  saveCache,
  type BusStop,
  type StopPointResponse,
} from './bus-stop-gazetteer';

/** Never wait in tests; the pacing gap itself is not under test. */
const noWait = async (): Promise<void> => {};
const silent = (): void => {};

/** One line identifier exactly as TfL spells it (`name` is the published route). */
const line = (name: string) => ({ id: name.toLowerCase(), name, type: 'Line' });

/** A pole: the node that carries the real per-pole position and direction. */
function pole(
  id: string,
  lat: number,
  lon: number,
  routes: readonly string[],
  towards?: string,
): Record<string, unknown> {
  return {
    naptanId: id,
    id,
    commonName: `Stop ${id}`,
    stopType: 'NaptanPublicBusCoachTram',
    lines: routes.map(line),
    additionalProperties: towards
      ? [{ category: 'Direction', key: 'Towards', sourceSystemKey: 'CountDown', value: towards }]
      : [],
    children: [],
    lat,
    lon,
  };
}

/** A stop pair: what TfL actually answers with when asked for a pole id. */
function pair(
  id: string,
  lat: number,
  lon: number,
  routes: readonly string[],
  children: readonly Record<string, unknown>[],
  claimedPoleIds: readonly string[] = [],
): Record<string, unknown> {
  const referenced = claimedPoleIds.length > 0 ? claimedPoleIds : children.map((c) => c['id']);
  return {
    naptanId: id,
    id,
    commonName: `Pair ${id}`,
    stopType: 'NaptanOnstreetBusCoachStopPair',
    lines: routes.map(line),
    lineGroup: referenced.map((ref) => ({ naptanIdReference: ref, stationAtcoCode: id })),
    additionalProperties: [],
    children,
    lat,
    lon,
  };
}

interface Stub {
  readonly calls: string[][];
  readonly fetchStopPoints: (ids: readonly string[]) => Promise<StopPointResponse>;
}

/**
 * Answers with the distinct root nodes covering the requested ids, recording
 * every batch. `poison` makes any batch containing that id fail, the way one
 * bad id makes TfL reject a whole comma-joined URL.
 */
function stubFetcher(roots: ReadonlyMap<string, Record<string, unknown>>, poison?: string): Stub {
  const calls: string[][] = [];
  return {
    calls,
    fetchStopPoints: async (ids) => {
      calls.push([...ids]);
      if (poison !== undefined && ids.includes(poison)) return { status: 400, body: null };
      const seen = new Set<unknown>();
      const body: Record<string, unknown>[] = [];
      for (const id of ids) {
        const node = roots.get(id);
        if (!node || seen.has(node['id'])) continue;
        seen.add(node['id']);
        body.push(node);
      }
      return { status: 200, body };
    },
  };
}

/** n standalone poles, each answered as its own root node. */
function standalonePoles(n: number): { ids: string[]; roots: Map<string, Record<string, unknown>> } {
  const ids: string[] = [];
  const roots = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < n; i += 1) {
    const id = `4900${String(i).padStart(5, '0')}A`;
    ids.push(id);
    roots.set(id, pole(id, 51.5 + i / 1000, -0.1 - i / 1000, ['88']));
  }
  return { ids, roots };
}

describe('resolveStops batching', () => {
  it('never asks for more than STOPPOINT_BATCH_MAX ids in one call', async () => {
    // Arrange — 45 ids is two full batches plus a remainder.
    const { ids, roots } = standalonePoles(45);
    const stub = stubFetcher(roots);

    // Act
    const result = await resolveStops(ids, {
      fetchStopPoints: stub.fetchStopPoints,
      log: silent,
      sleep: noWait,
    });

    // Assert
    expect(STOPPOINT_BATCH_MAX).toBe(20);
    expect(stub.calls.map((c) => c.length)).toEqual([20, 20, 5]);
    expect(stub.calls.every((c) => c.length <= STOPPOINT_BATCH_MAX)).toBe(true);
    expect(result.resolved.size).toBe(45);
    expect(result.unresolved).toEqual([]);
  });

  it('asks once for a repeated id', async () => {
    // Arrange
    const { ids, roots } = standalonePoles(3);
    const stub = stubFetcher(roots);

    // Act
    const result = await resolveStops([...ids, ...ids], {
      fetchStopPoints: stub.fetchStopPoints,
      log: silent,
      sleep: noWait,
    });

    // Assert
    expect(stub.calls).toEqual([ids]);
    expect(result.resolved.size).toBe(3);
  });
});

describe('resolveStops node choice', () => {
  const POLE = '490006655CG';
  const PAIR = '490G00006655';

  it('prefers the pole inside children over the pair that was returned for it', async () => {
    // Arrange — the pair centroid and the pole differ; only the pole is right.
    const child = pole(POLE, 51.54389, -0.15824, ['31', 'N31'], 'Camden Town');
    const roots = new Map([[POLE, pair(PAIR, 51.5, -0.15, ['31'], [child])]]);
    const stub = stubFetcher(roots);

    // Act
    const result = await resolveStops([POLE], {
      fetchStopPoints: stub.fetchStopPoints,
      log: silent,
      sleep: noWait,
    });

    // Assert
    const stop = result.resolved.get(POLE);
    expect(stop?.id).toBe(POLE);
    expect(stop?.lat).toBe(51.54389);
    expect(stop?.lon).toBe(-0.15824);
    expect(stop?.match).toBe('exact');
    expect(stop?.towards).toBe('Camden Town');
    expect(result.stats.exact).toBe(1);
    expect(result.stats.parent).toBe(0);
  });

  it('falls back to the claiming pair and records the coordinate as a pair centroid', async () => {
    // Arrange — the pole is absent from children; only lineGroup names it.
    const roots = new Map([[POLE, pair(PAIR, 51.5, -0.15, ['31'], [], [POLE])]]);
    const stub = stubFetcher(roots);

    // Act
    const result = await resolveStops([POLE], {
      fetchStopPoints: stub.fetchStopPoints,
      log: silent,
      sleep: noWait,
    });

    // Assert
    const stop = result.resolved.get(POLE);
    expect(stop?.id).toBe(POLE);
    expect(stop?.lat).toBe(51.5);
    expect(stop?.match).toBe('parent');
    expect(stop?.towards).toBeUndefined();
    expect(result.stats.parent).toBe(1);
    expect(result.stats.exact).toBe(0);
  });

  it('records an id the response never mentions as unresolved with a reason', async () => {
    // Arrange — a 200 that simply omits the id is still a dropped id.
    const stub = stubFetcher(new Map());

    // Act
    const result = await resolveStops([POLE], {
      fetchStopPoints: stub.fetchStopPoints,
      log: silent,
      sleep: noWait,
    });

    // Assert
    expect(result.resolved.size).toBe(0);
    expect(result.unresolved).toEqual([POLE]);
    expect(result.reasons.get(POLE)).toMatch(/absent/i);
  });

  it('rejects a node whose coordinate is the 0,0 placeholder', async () => {
    // Arrange
    const roots = new Map([[POLE, pole(POLE, 0, 0, ['31'])]]);
    const stub = stubFetcher(roots);

    // Act
    const result = await resolveStops([POLE], {
      fetchStopPoints: stub.fetchStopPoints,
      log: silent,
      sleep: noWait,
    });

    // Assert
    expect(result.unresolved).toEqual([POLE]);
    expect(result.reasons.get(POLE)).toMatch(/coordinate/i);
  });
});

describe('resolveStops routes', () => {
  it('stores TfL route names verbatim, keeping case and leading zeros', async () => {
    // Arrange — "032" (a coach) is a different route from "32", and BODS spells
    // the same routes upper-case, so nothing here may be normalised.
    const id = '490000000A';
    const roots = new Map([[id, pole(id, 51.5, -0.1, ['N1', 'EL1', '148X', '032', '32'])]]);
    const stub = stubFetcher(roots);

    // Act
    const result = await resolveStops([id], {
      fetchStopPoints: stub.fetchStopPoints,
      log: silent,
      sleep: noWait,
    });

    // Assert
    expect(result.resolved.get(id)?.routes).toEqual(['N1', 'EL1', '148X', '032', '32']);
    expect(result.stats.withRoutes).toBe(1);
  });

  it('falls back to the line id when a line carries no name', async () => {
    // Arrange
    const id = '490000001A';
    const node = pole(id, 51.5, -0.1, []);
    const roots = new Map([[id, { ...node, lines: [{ id: 'n55', type: 'Line' }] }]]);
    const stub = stubFetcher(roots);

    // Act
    const result = await resolveStops([id], {
      fetchStopPoints: stub.fetchStopPoints,
      log: silent,
      sleep: noWait,
    });

    // Assert
    expect(result.resolved.get(id)?.routes).toEqual(['n55']);
  });

  it('inherits the pair route list when the pole itself lists none', async () => {
    // Arrange — a later wave joins closures to the route the rider searched, so
    // an empty pole list must not throw the join key away.
    const POLE = '490000002A';
    const child = pole(POLE, 51.51, -0.11, []);
    const roots = new Map([[POLE, pair('490G0000002', 51.5, -0.1, ['187', '46'], [child])]]);
    const stub = stubFetcher(roots);

    // Act
    const result = await resolveStops([POLE], {
      fetchStopPoints: stub.fetchStopPoints,
      log: silent,
      sleep: noWait,
    });

    // Assert
    const stop = result.resolved.get(POLE);
    expect(stop?.routes).toEqual(['187', '46']);
    expect(stop?.match).toBe('exact');
    expect(stop?.lat).toBe(51.51);
  });
});

describe('resolveStops cache reuse', () => {
  it('never re-requests an id that is already cached', async () => {
    // Arrange — a stop's position never changes, so a cached id is final.
    const { ids, roots } = standalonePoles(3);
    const [first, second, third] = ids as [string, string, string];
    const cached = new Map<string, BusStop>([
      [first, { id: first, name: 'Cached one', lat: 51.1, lon: -0.1, routes: ['1'], match: 'exact' }],
      [second, { id: second, name: 'Cached two', lat: 51.2, lon: -0.2, routes: [], match: 'parent' }],
    ]);
    const stub = stubFetcher(roots);

    // Act
    const result = await resolveStops(ids, {
      fetchStopPoints: stub.fetchStopPoints,
      log: silent,
      sleep: noWait,
      cached,
    });

    // Assert
    expect(stub.calls).toEqual([[third]]);
    expect(result.resolved.size).toBe(3);
    expect(result.resolved.get(first)?.name).toBe('Cached one');
    expect(result.stats.fromCache).toBe(2);
    expect(result.stats.fetched).toBe(1);
  });

  it('makes no upstream call at all when every id is cached', async () => {
    // Arrange
    const { ids, roots } = standalonePoles(2);
    const cached = new Map<string, BusStop>(
      ids.map((id) => [id, { id, name: id, lat: 51.5, lon: -0.1, routes: [], match: 'exact' }]),
    );
    const stub = stubFetcher(roots);

    // Act
    const result = await resolveStops(ids, {
      fetchStopPoints: stub.fetchStopPoints,
      log: silent,
      sleep: noWait,
      cached,
    });

    // Assert
    expect(stub.calls).toEqual([]);
    expect(result.stats.upstreamCalls).toBe(0);
    expect(result.resolved.size).toBe(2);
  });
});

describe('resolveStops failure degradation', () => {
  it('keeps the other ids in a batch one bad id makes TfL reject', async () => {
    // Arrange — 20 ids, one of which poisons every batch it appears in.
    const { ids, roots } = standalonePoles(20);
    const poison = ids[7] as string;
    const stub = stubFetcher(roots, poison);
    const logs: string[] = [];

    // Act
    const result = await resolveStops(ids, {
      fetchStopPoints: stub.fetchStopPoints,
      log: (message) => logs.push(message),
      sleep: noWait,
    });

    // Assert — 19 survive, the bad one is named, and the failure is logged.
    expect(result.resolved.size).toBe(19);
    expect(result.unresolved).toEqual([poison]);
    expect(result.reasons.get(poison)).toMatch(/400/);
    expect(result.stats.upstreamCalls).toBeGreaterThan(1);
    expect(result.stats.failedBatches).toBeGreaterThan(0);
    expect(logs.some((entry) => entry.includes(poison))).toBe(true);
  });

  it('degrades the same way when the fetcher throws instead of answering', async () => {
    // Arrange
    const { ids, roots } = standalonePoles(4);
    const poison = ids[1] as string;
    const fetchStopPoints = async (batch: readonly string[]): Promise<StopPointResponse> => {
      if (batch.includes(poison)) throw new Error('socket hang up');
      const body = batch.map((id) => roots.get(id)).filter((node) => node !== undefined);
      return { status: 200, body };
    };

    // Act
    const result = await resolveStops(ids, { fetchStopPoints, log: silent, sleep: noWait });

    // Assert
    expect(result.resolved.size).toBe(3);
    expect(result.unresolved).toEqual([poison]);
    expect(result.reasons.get(poison)).toMatch(/socket hang up/);
  });
});

describe('gazetteer cache file', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bus-gazetteer-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips a map through save and load', async () => {
    // Arrange
    const path = join(dir, 'nested', 'bus-stops.json');
    const stops = new Map<string, BusStop>([
      [
        '490006655CG',
        {
          id: '490006655CG',
          name: 'Eton Road',
          lat: 51.54389,
          lon: -0.15824,
          routes: ['31', 'N31'],
          match: 'exact',
          towards: 'Camden Town',
        },
      ],
      [
        '490000123B',
        {
          id: '490000123B',
          name: 'Cavendish Avenue',
          lat: 51.5,
          lon: -0.2,
          routes: ['187', '46'],
          match: 'parent',
        },
      ],
    ]);

    // Act
    await saveCache(path, stops);
    const loaded = await loadCache(path);

    // Assert
    expect(loaded.size).toBe(2);
    expect(loaded.get('490006655CG')).toEqual(stops.get('490006655CG'));
    expect(loaded.get('490000123B')).toEqual(stops.get('490000123B'));
  });

  it('treats a missing cache file as an empty cache', async () => {
    // Arrange / Act
    const loaded = await loadCache(join(dir, 'never-written.json'));

    // Assert
    expect(loaded.size).toBe(0);
  });

  it('refuses a corrupt cache loudly rather than silently starting empty', async () => {
    // Arrange
    const path = join(dir, 'broken.json');
    await writeFile(path, '{not json', 'utf8');

    // Act / Assert
    await expect(loadCache(path)).rejects.toThrow(/broken\.json/);
  });

  it('refuses a cache entry that lost its coordinate rather than serving it', async () => {
    // Arrange
    const path = join(dir, 'lossy.json');
    await writeFile(path, '{"490000123B":{"id":"490000123B","name":"X","routes":[]}}', 'utf8');

    // Act / Assert
    await expect(loadCache(path)).rejects.toThrow(/490000123B/);
  });
});
