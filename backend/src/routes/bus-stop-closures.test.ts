import Fastify, { type FastifyInstance, type LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BUS_STOP_CLOSURES_MAX_STALE_MS,
  BUS_STOP_CLOSURES_TTL_MS,
  registerBusStopClosuresRoute,
  type BusStopClosuresContext,
  type BusStopClosuresCounters,
} from './bus-stop-closures';
import type { BusStop } from '../disruptions/bus-stop-gazetteer';
import { TtlCache } from '../cache';
import { RateBudget } from '../rate-budget';
import type { AppConfig } from '../config';
import type { TflResponse } from '../tfl-client';

const APP_KEY = 'test-app-key-0123';
const CONFIG = { tflAppKey: APP_KEY } as unknown as AppConfig;
const PATH = '/api/bus-stop-closures';
const BUDGET_LIMIT = 60;
const BUDGET_WINDOW_MS = 60_000;
/** 2026-09-04T08:06:36Z — the server-anchored "now" every window is judged by. */
const T0 = Date.parse('2026-09-04T08:06:36Z');
const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;
const HTTP_BAD_GATEWAY = 502;

const KNOWN = '490006655CG';
const NEW_POLE = '490009477N';

const known: BusStop = {
  id: KNOWN,
  name: 'Eton Road',
  lat: 51.54389,
  lon: -0.15824,
  routes: ['31', 'N31'],
  match: 'exact',
  towards: 'Camden Town',
};

/** A row shaped exactly like the live feed's, in force at T0 by default. */
function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    $type: 'Tfl.Api.Presentation.Entities.DisruptedPoint, Tfl.Api.Presentation.Entities',
    atcoCode: KNOWN,
    fromDate: '2026-08-24T05:00:00Z',
    toDate: '2026-10-02T18:00:00Z',
    description: 'Bus Stop Closed\n\n\n',
    commonName: 'Eton Road',
    type: 'Closure',
    mode: 'bus',
    stationAtcoCode: '490G00006655',
    appearance: 'Information',
    ...overrides,
  };
}

/** The StopPoint answer for a pole: a pair node with the pole in children. */
function stopPointBody(id: string): unknown {
  return [
    {
      naptanId: '490G00009477',
      id: '490G00009477',
      commonName: 'Pair 490G00009477',
      stopType: 'NaptanOnstreetBusCoachStopPair',
      lines: [{ id: '88', name: '88', type: 'Line' }],
      lineGroup: [{ naptanIdReference: id, stationAtcoCode: '490G00009477' }],
      lat: 51.5,
      lon: -0.14,
      children: [
        {
          naptanId: id,
          id,
          commonName: 'Chalk Farm Station',
          stopType: 'NaptanPublicBusCoachTram',
          lines: [{ id: '88', name: '88', type: 'Line' }],
          additionalProperties: [{ category: 'Direction', key: 'Towards', value: 'Camden Town' }],
          children: [],
          lat: 51.54,
          lon: -0.15,
        },
      ],
    },
  ];
}

interface Harness {
  readonly app: FastifyInstance;
  readonly fetchFeed: ReturnType<typeof vi.fn>;
  readonly fetchStopPoints: ReturnType<typeof vi.fn>;
  readonly saveGazetteer: ReturnType<typeof vi.fn>;
  readonly logs: string[];
  readonly counters: () => BusStopClosuresCounters;
  readonly advance: (ms: number) => void;
  readonly get: () => Promise<LightMyRequestResponse>;
}

const apps: FastifyInstance[] = [];

interface HarnessOptions {
  readonly gazetteer?: ReadonlyMap<string, BusStop>;
  readonly stopPoints?: () => Promise<TflResponse>;
}

function harness(responses: (() => Promise<TflResponse>)[], options: HarnessOptions = {}): Harness {
  let clock = T0;
  const app = Fastify();
  apps.push(app);
  const logs: string[] = [];
  const fetchFeed = vi.fn(async (): Promise<TflResponse> => {
    const next = responses.shift();
    if (next === undefined) throw new Error('upstream called more often than the test allows');
    return next();
  });
  const fetchStopPoints = vi.fn(
    options.stopPoints ??
      (async (ids: readonly string[]): Promise<TflResponse> => ({
        status: HTTP_OK,
        body: stopPointBody(ids[0] ?? ''),
      })),
  );
  const saveGazetteer = vi.fn(async (): Promise<void> => {});
  const ctx: BusStopClosuresContext = {
    gazetteer: options.gazetteer ?? new Map([[KNOWN, known]]),
    log: (message) => logs.push(message),
    fetchFeed,
    fetchStopPoints,
    saveGazetteer,
    sleep: async () => {},
  };
  const counters = registerBusStopClosuresRoute(
    app,
    {
      config: CONFIG,
      cache: new TtlCache<unknown>(BUS_STOP_CLOSURES_TTL_MS),
      budget: new RateBudget(BUDGET_LIMIT, BUDGET_WINDOW_MS),
      now: () => clock,
    },
    ctx,
  );
  return {
    app,
    fetchFeed,
    fetchStopPoints,
    saveGazetteer,
    logs,
    counters,
    advance: (ms) => {
      clock += ms;
    },
    get: () => app.inject({ method: 'GET', url: PATH }),
  };
}

const ok =
  (body: unknown) =>
  async (): Promise<TflResponse> => ({ status: HTTP_OK, body });

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('GET /api/bus-stop-closures payload contract', () => {
  it('carries exactly { t, stops } — no upstream field can ride along', async () => {
    // Arrange
    const h = harness([ok([row()])]);

    // Act
    const res = await h.get();
    const payload = res.json() as Record<string, unknown>;

    // Assert
    expect(res.statusCode).toBe(HTTP_OK);
    expect(Object.keys(payload).sort()).toEqual(['stops', 't']);
    expect(payload['t']).toBe(Math.floor(T0 / 1_000));
  });

  it('carries exactly the stop keys, so a future upstream field cannot leak', async () => {
    const h = harness([ok([row()])]);

    const { stops } = (await h.get()).json() as { stops: Record<string, unknown>[] };

    expect(stops).toHaveLength(1);
    expect(Object.keys(stops[0] ?? {}).sort()).toEqual([
      'd',
      'f',
      'id',
      'lat',
      'lon',
      'name',
      'routes',
      't',
      'towards',
      'ty',
    ]);
  });

  it('never serialises an upstream-only field name or the app key', async () => {
    const h = harness([ok([row()])]);

    const { body } = await h.get();

    for (const leak of ['$type', 'atcoCode', 'stationAtcoCode', 'appearance', 'mode', 'commonName', APP_KEY]) {
      expect(body).not.toContain(leak);
    }
  });

  it('draws only the closures in force at the server clock', async () => {
    // Arrange — one live, one starting next week, one that ended yesterday.
    const h = harness([
      ok([
        row(),
        row({ atcoCode: NEW_POLE, fromDate: '2026-09-11T05:00:00Z' }),
        row({ atcoCode: NEW_POLE, toDate: '2026-09-03T17:00:00Z' }),
      ]),
    ]);

    // Act
    const { stops } = (await h.get()).json() as { stops: { id: string }[] };

    // Assert
    expect(stops.map((s) => s.id)).toEqual([KNOWN]);
    expect(h.counters().busStopClosuresNotInForce).toBe(2);
  });

  it('asks TfL only for the bus closure feed, once, for concurrent viewers', async () => {
    const h = harness([ok([row()])]);

    await Promise.all([h.get(), h.get(), h.get()]);

    expect(h.fetchFeed).toHaveBeenCalledTimes(1);
    expect(h.fetchFeed).toHaveBeenCalledWith(APP_KEY);
  });
});

describe('GET /api/bus-stop-closures gazetteer top-up', () => {
  it('resolves a pole the gazetteer has never seen and writes the cache back', async () => {
    // Arrange — the feed names a pole resolved by nobody yet.
    const h = harness([ok([row({ atcoCode: NEW_POLE })])]);

    // Act
    const { stops } = (await h.get()).json() as { stops: { id: string; lat: number }[] };

    // Assert
    expect(h.fetchStopPoints).toHaveBeenCalledWith([NEW_POLE], APP_KEY);
    expect(stops.map((s) => s.id)).toEqual([NEW_POLE]);
    expect(stops[0]?.lat).toBe(51.54);
    expect(h.saveGazetteer).toHaveBeenCalledTimes(1);
    const saved = h.saveGazetteer.mock.calls[0]?.[0] as ReadonlyMap<string, BusStop>;
    expect(saved.get(NEW_POLE)?.name).toBe('Chalk Farm Station');
    expect(saved.get(KNOWN)).toEqual(known);
  });

  it('never re-asks for a pole already in the gazetteer', async () => {
    const h = harness([ok([row()])]);

    await h.get();

    expect(h.fetchStopPoints).not.toHaveBeenCalled();
    expect(h.saveGazetteer).not.toHaveBeenCalled();
  });

  it('drops an unresolvable pole with a counter and a log instead of a guessed pin', async () => {
    // Arrange — TfL answers 200 but never mentions the pole.
    const h = harness([ok([row(), row({ atcoCode: NEW_POLE })])], {
      stopPoints: async () => ({ status: HTTP_OK, body: [] }),
    });

    // Act
    const { stops } = (await h.get()).json() as { stops: { id: string }[] };

    // Assert
    expect(stops.map((s) => s.id)).toEqual([KNOWN]);
    expect(h.counters().busStopClosuresUnresolved).toBe(1);
    expect(h.logs.some((entry) => entry.includes(NEW_POLE))).toBe(true);
  });

  it('still serves the placeable closures when the StopPoint lookup fails outright', async () => {
    const h = harness([ok([row(), row({ atcoCode: NEW_POLE })])], {
      stopPoints: async () => {
        throw new Error('socket hang up');
      },
    });

    const res = await h.get();

    expect(res.statusCode).toBe(HTTP_OK);
    expect((res.json() as { stops: { id: string }[] }).stops.map((s) => s.id)).toEqual([KNOWN]);
    expect(h.counters().busStopClosuresUnresolved).toBe(1);
  });

  it('serves the payload even when the gazetteer cache cannot be written', async () => {
    // Arrange — a read-only data dir must not cost the viewer the layer.
    const h = harness([ok([row({ atcoCode: NEW_POLE })])]);
    h.saveGazetteer.mockRejectedValueOnce(new Error('EROFS: read-only file system'));

    // Act
    const res = await h.get();

    // Assert
    expect(res.statusCode).toBe(HTTP_OK);
    expect((res.json() as { stops: unknown[] }).stops).toHaveLength(1);
    expect(h.logs.some((entry) => entry.includes('EROFS'))).toBe(true);
  });
});

describe('GET /api/bus-stop-closures health counters', () => {
  it('reports the counters app.ts publishes on /health', async () => {
    // Arrange — one drawn, one filtered, one unreadable, one unplaceable.
    const h = harness(
      [
        ok([
          row(),
          row({ fromDate: '2026-09-11T05:00:00Z' }),
          row({ fromDate: 'shortly' }),
          row({ atcoCode: NEW_POLE }),
        ]),
      ],
      { stopPoints: async () => ({ status: HTTP_OK, body: [] }) },
    );

    // Act
    await h.get();

    // Assert
    expect(h.counters()).toEqual({
      busStopClosuresStops: 1,
      busStopClosuresDropped: 1,
      busStopClosuresUnresolved: 1,
      busStopClosuresNotInForce: 1,
      busStopClosuresLastShapeMs: 0,
    });
  });

  it('starts at zero before the first fetch', async () => {
    const h = harness([ok([row()])]);

    expect(h.counters()).toEqual({
      busStopClosuresStops: 0,
      busStopClosuresDropped: 0,
      busStopClosuresUnresolved: 0,
      busStopClosuresNotInForce: 0,
      busStopClosuresLastShapeMs: 0,
    });
  });
});

describe('GET /api/bus-stop-closures upstream failures', () => {
  const notFound = async (): Promise<TflResponse> => ({
    // A real TfL error body echoes the request URI, app key included.
    status: HTTP_NOT_FOUND,
    body: { message: `Resource not found: /StopPoint/Mode/bus/Disruption?app_key=${APP_KEY}` },
  });

  it('THROWS on a non-200 instead of forwarding the key-echoing error body', async () => {
    // Arrange
    const h = harness([notFound]);

    // Act
    const res = await h.get();

    // Assert
    expect(res.statusCode).toBe(HTTP_BAD_GATEWAY);
    expect(res.body).not.toContain(APP_KEY);
    expect(res.json()).toEqual({ error: 'Upstream TfL request failed.' });
  });

  it('serves the last good payload as stale when the upstream then fails', async () => {
    const h = harness([ok([row()]), notFound]);
    await h.get();

    // Act — past the TTL, so a second fetch runs and fails.
    h.advance(BUS_STOP_CLOSURES_TTL_MS + 1);
    const res = await h.get();

    // Assert
    expect(res.headers['x-cache']).toBe('stale');
    expect((res.json() as { stops: unknown[] }).stops).toHaveLength(1);
  });

  it('stops serving a payload older than the max-stale bound', async () => {
    // A lifted closure must leave the map even while TfL is down.
    const h = harness([ok([row()]), notFound]);
    await h.get();

    h.advance(BUS_STOP_CLOSURES_MAX_STALE_MS + 1);
    const res = await h.get();

    expect(res.statusCode).toBe(HTTP_BAD_GATEWAY);
  });

  it('bounds staleness PAST the TTL, so the stale path is reachable at all', async () => {
    // A bound equal to the TTL would be dead code: an entry first goes stale
    // at exactly the TTL, which would already be the bound, and one TfL blip
    // would empty the map for every viewer.
    expect(BUS_STOP_CLOSURES_MAX_STALE_MS).toBeGreaterThan(BUS_STOP_CLOSURES_TTL_MS);
    expect(BUS_STOP_CLOSURES_MAX_STALE_MS - BUS_STOP_CLOSURES_TTL_MS).toBe(600_000);
  });

  it('caches for ten minutes, because the closure feed changes slowly', async () => {
    const h = harness([ok([row()])]);
    await h.get();

    h.advance(BUS_STOP_CLOSURES_TTL_MS - 1);
    const res = await h.get();

    expect(res.headers['x-cache']).toBe('hit');
    expect(h.fetchFeed).toHaveBeenCalledTimes(1);
    expect(BUS_STOP_CLOSURES_TTL_MS).toBe(600_000);
  });

  it('throws on a body that is not a row array rather than caching an empty map', async () => {
    const h = harness([ok({ message: 'unexpected' })]);

    const res = await h.get();

    expect(res.statusCode).toBe(HTTP_BAD_GATEWAY);
  });

  it('answers 503 with no TfL key configured, and never calls the upstream', async () => {
    // Arrange
    const app = Fastify();
    apps.push(app);
    const fetchFeed = vi.fn();
    registerBusStopClosuresRoute(
      app,
      {
        config: { tflAppKey: undefined } as unknown as AppConfig,
        cache: new TtlCache<unknown>(BUS_STOP_CLOSURES_TTL_MS),
        budget: new RateBudget(BUDGET_LIMIT, BUDGET_WINDOW_MS),
      },
      { gazetteer: new Map(), log: () => {}, fetchFeed },
    );

    // Act
    const res = await app.inject({ method: 'GET', url: PATH });

    // Assert
    expect(res.statusCode).toBe(503);
    expect(fetchFeed).not.toHaveBeenCalled();
  });
});
