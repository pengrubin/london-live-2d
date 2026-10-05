import Fastify, { type FastifyInstance, type LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { registerArrivalsRoute } from './arrivals';
import { ArrivalsSource, MONOTONIC_HOLD_MS } from '../arrivals-source';
import { TtlCache } from '../cache';
import { makeCachedArrivalsFetcher } from '../leaderboard';
import { RateBudget } from '../rate-budget';
import type { TflResponse } from '../tfl-client';

const APP_KEY = 'test-app-key-0123';
const TTL_MS = 8_000;
const BUDGET_LIMIT = 60;
const BUDGET_WINDOW_MS = 60_000;
const T0 = 1_759_658_400_000;
const LINES = 'victoria,central';
/** The route sorts and dedupes, so this is the cache key for LINES. */
const KEY = 'central,victoria';
const URL = `/api/arrivals?lines=${LINES}`;
const CONCURRENT_REQUESTS = 5;
const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;
const HTTP_TOO_MANY = 429;
const HTTP_BAD_GATEWAY = 502;
const HTTP_UNAVAILABLE = 503;

const TS_OLD = '2026-10-05T10:00:00.1234567Z';
const TS_NEW = '2026-10-05T10:00:20.1234567Z';
const TS_NEWER = '2026-10-05T10:00:40Z';

/** A TfL Line/Arrivals body: an array of predictions, each carrying the feed timestamp. */
const body = (timestamp: string, id = 'p1'): unknown[] => [
  { id, timestamp, lineId: 'victoria' },
  { id: `${id}-b`, timestamp, lineId: 'central' },
];
const ok = (b: unknown): TflResponse => ({ status: HTTP_OK, body: b });

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: Error) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  let reject: (reason: Error) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets every queued request reach its handler before the test continues. */
const nextMacrotask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

type FetchFn = (ids: readonly string[], appKey: string) => Promise<TflResponse>;

interface Harness {
  readonly app: FastifyInstance;
  readonly cache: TtlCache<unknown>;
  readonly source: ArrivalsSource;
  readonly tryConsume: MockInstance<RateBudget['tryConsume']>;
  readonly debug: ReturnType<typeof vi.fn>;
  readonly advance: (ms: number) => void;
  readonly get: (url?: string) => Promise<LightMyRequestResponse>;
}

const apps: FastifyInstance[] = [];

function harness(fetchUpstream: FetchFn, budgetLimit = BUDGET_LIMIT): Harness {
  let clock = T0;
  const cache = new TtlCache<unknown>(TTL_MS);
  const budget = new RateBudget(budgetLimit, BUDGET_WINDOW_MS);
  const tryConsume = vi.spyOn(budget, 'tryConsume');
  const debug = vi.fn();
  const source = new ArrivalsSource({
    appKey: APP_KEY,
    cache,
    budget,
    fetchUpstream,
    now: () => clock,
    log: { debug },
  });
  const app = Fastify();
  apps.push(app);
  registerArrivalsRoute(app, { source });
  return {
    app,
    cache,
    source,
    tryConsume,
    debug,
    advance: (ms) => {
      clock += ms;
    },
    get: (url = URL) => app.inject({ method: 'GET', url }),
  };
}

/** Upstream whose n-th call returns the n-th deferred, so a test controls resolution order. */
function queuedFetcher(): { readonly fetch: ReturnType<typeof vi.fn<FetchFn>>; readonly calls: Deferred<TflResponse>[] } {
  const calls: Deferred<TflResponse>[] = [];
  const fetch = vi.fn<FetchFn>(() => {
    const d = deferred<TflResponse>();
    calls.push(d);
    return d.promise;
  });
  return { fetch, calls };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('/api/arrivals existing behaviour', () => {
  it('answers a cold key as miss, a warm one as hit, with one upstream call on the sorted ids', async () => {
    // Arrange
    const fetch = vi.fn<FetchFn>(async () => ok(body(TS_OLD)));
    const h = harness(fetch);

    // Act
    const first = await h.get();
    const second = await h.get();

    // Assert
    expect(first.statusCode).toBe(HTTP_OK);
    expect(first.headers['x-cache']).toBe('miss');
    expect(second.headers['x-cache']).toBe('hit');
    expect(second.json()).toEqual(body(TS_OLD));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(['central', 'victoria'], APP_KEY);
    expect(h.tryConsume).toHaveBeenCalledTimes(1);
  });

  it('rejects a missing or malformed lines parameter with 400 and no upstream call', async () => {
    // Arrange
    const fetch = vi.fn<FetchFn>(async () => ok(body(TS_OLD)));
    const h = harness(fetch);

    // Act
    const missing = await h.get('/api/arrivals');
    const bad = await h.get('/api/arrivals?lines=Victoria!');

    // Assert
    expect(missing.statusCode).toBe(400);
    expect(bad.statusCode).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('forwards a TfL error body with the app key redacted and caches nothing', async () => {
    // Arrange
    const leaking = { message: `https://api.tfl.gov.uk/Line/x/Arrivals?app_key=${APP_KEY}` };
    const fetch = vi.fn<FetchFn>(async () => ({ status: HTTP_NOT_FOUND, body: leaking }));
    const h = harness(fetch);

    // Act
    const res = await h.get();

    // Assert
    expect(res.statusCode).toBe(HTTP_NOT_FOUND);
    expect(res.body).not.toContain(APP_KEY);
    expect(res.body).toContain('<redacted>');
    expect(h.cache.size).toBe(0);
  });

  it('answers 429 when the budget is exhausted and nothing is cached', async () => {
    // Arrange
    const fetch = vi.fn<FetchFn>(async () => ok(body(TS_OLD)));
    const h = harness(fetch, 0);

    // Act
    const res = await h.get();

    // Assert
    expect(res.statusCode).toBe(HTTP_TOO_MANY);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('answers 502 when the upstream throws and nothing is cached', async () => {
    // Arrange
    const fetch = vi.fn<FetchFn>(async () => {
      throw new Error('upstream down');
    });
    const h = harness(fetch);

    // Act
    const res = await h.get();

    // Assert
    expect(res.statusCode).toBe(HTTP_BAD_GATEWAY);
  });

  it('registers a 503 route when no TfL key is configured', async () => {
    // Arrange
    const app = Fastify();
    apps.push(app);
    registerArrivalsRoute(app, { source: undefined });

    // Act
    const res = await app.inject({ method: 'GET', url: URL });

    // Assert
    expect(res.statusCode).toBe(HTTP_UNAVAILABLE);
  });
});

describe('/api/arrivals single-flight', () => {
  it('two concurrent misses on the same key make one upstream call and both get the same body', async () => {
    // Arrange
    const { fetch, calls } = queuedFetcher();
    const h = harness(fetch);
    await h.app.ready();

    // Act
    const pending = Promise.all([h.get(), h.get(`/api/arrivals?lines=central,victoria,central`)]);
    await nextMacrotask();
    const callsBeforeRelease = fetch.mock.calls.length;
    calls[0]?.resolve(ok(body(TS_NEW)));
    const [a, b] = await pending;

    // Assert
    expect(callsBeforeRelease).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(h.tryConsume).toHaveBeenCalledTimes(1);
    expect(a?.json()).toEqual(body(TS_NEW));
    expect(b?.json()).toEqual(body(TS_NEW));
    expect([a?.headers['x-cache'], b?.headers['x-cache']]).toEqual(['miss', 'join']);
  });

  it('many concurrent misses spend one budget unit and every joiner is marked join', async () => {
    // Arrange
    const { fetch, calls } = queuedFetcher();
    const h = harness(fetch);
    await h.app.ready();

    // Act
    const pending = Promise.all(Array.from({ length: CONCURRENT_REQUESTS }, () => h.get()));
    await nextMacrotask();
    calls[0]?.resolve(ok(body(TS_NEW)));
    const responses = await pending;

    // Assert
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(h.tryConsume).toHaveBeenCalledTimes(1);
    expect(responses.filter((r) => r.headers['x-cache'] === 'join')).toHaveLength(CONCURRENT_REQUESTS - 1);
  });

  it('a slower earlier fetch resolving after a faster later one never leaves an older body in the cache', async () => {
    // Arrange: the first-started upstream call carries the OLDER feed, a second
    // one (if the route starts it) the NEWER — the race measured in document 3.
    const { fetch, calls } = queuedFetcher();
    const h = harness(fetch);
    await h.app.ready();

    // Act: resolve in reverse start order, the later call first.
    const pending = Promise.all([h.get(), h.get()]);
    await nextMacrotask();
    const replies = [ok(body(TS_OLD, 'early')), ok(body(TS_NEW, 'late'))];
    [...calls].reverse().forEach((d) => d.resolve(replies[calls.indexOf(d)] ?? ok(body(TS_NEW))));
    const served = await pending;
    h.advance(1_000);
    const after = await h.get();

    // Assert: whatever was served, the cache never goes backwards afterwards.
    const servedTs = served.map((r) => r.headers['x-feed-timestamp'] as string);
    const newestServed = servedTs.reduce((m, t) => (Date.parse(t) > Date.parse(m) ? t : m));
    expect(after.headers['x-cache']).toBe('hit');
    expect(Date.parse(after.headers['x-feed-timestamp'] as string)).toBeGreaterThanOrEqual(Date.parse(newestServed));
  });

  it('a later fetch returning an older feed does not overwrite the newer cached body', async () => {
    // Arrange
    const { fetch, calls } = queuedFetcher();
    const h = harness(fetch);
    await h.app.ready();
    const first = h.get();
    await nextMacrotask();
    calls[0]?.resolve(ok(body(TS_NEW)));
    await first;
    h.advance(TTL_MS);

    // Act: the cache has expired; the refetch answers with an older feed.
    const second = h.get();
    await nextMacrotask();
    calls[1]?.resolve(ok(body(TS_OLD)));
    const res = await second;
    const cached = h.cache.getStale(KEY);

    // Assert
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(res.json()).toEqual(body(TS_NEW));
    expect(res.headers['x-feed-timestamp']).toBe(TS_NEW);
    expect(res.headers['x-cache-age']).toBe(String(TTL_MS / 1_000));
    expect(cached).toEqual(body(TS_NEW));
    expect(h.debug).toHaveBeenCalledTimes(1);
  });

  it('a newer feed replaces the cached body as usual', async () => {
    // Arrange
    const { fetch, calls } = queuedFetcher();
    const h = harness(fetch);
    await h.app.ready();
    const first = h.get();
    await nextMacrotask();
    calls[0]?.resolve(ok(body(TS_NEW)));
    await first;
    h.advance(TTL_MS);

    // Act
    const second = h.get();
    await nextMacrotask();
    calls[1]?.resolve(ok(body(TS_NEWER)));
    const res = await second;

    // Assert
    expect(res.headers['x-feed-timestamp']).toBe(TS_NEWER);
    expect(h.cache.getStale(KEY)).toEqual(body(TS_NEWER));
  });

  it('accepts an older feed once the cached body is past MONOTONIC_HOLD_MS, so one bad timestamp cannot pin the cache', async () => {
    // Arrange
    const { fetch, calls } = queuedFetcher();
    const h = harness(fetch);
    await h.app.ready();
    const first = h.get();
    await nextMacrotask();
    calls[0]?.resolve(ok(body(TS_NEW)));
    await first;
    h.advance(MONOTONIC_HOLD_MS);

    // Act
    const second = h.get();
    await nextMacrotask();
    calls[1]?.resolve(ok(body(TS_OLD)));
    const res = await second;

    // Assert
    expect(res.headers['x-feed-timestamp']).toBe(TS_OLD);
    expect(res.headers['x-cache-age']).toBe('0');
    expect(h.cache.getStale(KEY)).toEqual(body(TS_OLD));
  });
});

describe('/api/arrivals provenance headers', () => {
  it('miss: x-feed-timestamp is the first row timestamp and x-cache-age is 0', async () => {
    // Arrange
    const h = harness(vi.fn<FetchFn>(async () => ok(body(TS_OLD))));

    // Act
    const res = await h.get();

    // Assert
    expect(res.headers['x-cache']).toBe('miss');
    expect(res.headers['x-feed-timestamp']).toBe(TS_OLD);
    expect(res.headers['x-cache-age']).toBe('0');
  });

  it('hit: x-cache-age is whole seconds since the body was cached', async () => {
    // Arrange
    const h = harness(vi.fn<FetchFn>(async () => ok(body(TS_OLD))));
    await h.get();
    h.advance(5_900);

    // Act
    const res = await h.get();

    // Assert
    expect(res.headers['x-cache']).toBe('hit');
    expect(res.headers['x-feed-timestamp']).toBe(TS_OLD);
    expect(res.headers['x-cache-age']).toBe('5');
  });

  it('stale on an exhausted budget: the old body, its feed timestamp, and its true age', async () => {
    // Arrange
    const fetch = vi.fn<FetchFn>(async () => ok(body(TS_OLD)));
    const h = harness(fetch, 1);
    await h.get();
    h.advance(20_000);

    // Act
    const res = await h.get();

    // Assert
    expect(res.statusCode).toBe(HTTP_OK);
    expect(res.headers['x-cache']).toBe('stale');
    expect(res.headers['x-feed-timestamp']).toBe(TS_OLD);
    expect(res.headers['x-cache-age']).toBe('20');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('stale on an upstream failure carries the same headers', async () => {
    // Arrange
    let failing = false;
    const fetch = vi.fn<FetchFn>(async () => {
      if (failing) throw new Error('upstream down');
      return ok(body(TS_OLD));
    });
    const h = harness(fetch);
    await h.get();
    h.advance(TTL_MS + 3_000);
    failing = true;

    // Act
    const res = await h.get();

    // Assert
    expect(res.headers['x-cache']).toBe('stale');
    expect(res.headers['x-feed-timestamp']).toBe(TS_OLD);
    expect(res.headers['x-cache-age']).toBe('11');
  });

  it('omits x-feed-timestamp for an empty array body', async () => {
    // Arrange
    const h = harness(vi.fn<FetchFn>(async () => ok([])));

    // Act
    const res = await h.get();

    // Assert
    expect(res.statusCode).toBe(HTTP_OK);
    expect(res.headers['x-feed-timestamp']).toBeUndefined();
    expect(res.headers['x-cache-age']).toBe('0');
  });
});

describe('leaderboard sampler shares the route in-flight map', () => {
  it('a sampler tick during a route miss joins the same upstream call', async () => {
    // Arrange
    const { fetch, calls } = queuedFetcher();
    const h = harness(fetch);
    await h.app.ready();
    const sample = makeCachedArrivalsFetcher({ source: h.source, lineIds: ['central', 'victoria'], log: () => {} });

    // Act
    const routePending = h.get();
    await nextMacrotask();
    const samplerPending = sample();
    calls[0]?.resolve(ok(body(TS_NEW)));
    const [res, predictions] = await Promise.all([routePending, samplerPending]);

    // Assert
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(h.tryConsume).toHaveBeenCalledTimes(1);
    expect(res.json()).toEqual(body(TS_NEW));
    expect(predictions).toEqual(body(TS_NEW));
  });

  it('the route then answers from what the sampler fetched as a hit', async () => {
    // Arrange
    const fetch = vi.fn<FetchFn>(async () => ok(body(TS_NEW)));
    const h = harness(fetch);
    const sample = makeCachedArrivalsFetcher({ source: h.source, lineIds: ['victoria', 'central'], log: () => {} });

    // Act
    await sample();
    const res = await h.get();

    // Assert
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(res.headers['x-cache']).toBe('hit');
  });

  it('returns null without a source (no TfL key) and without a fetch', async () => {
    // Arrange
    const sample = makeCachedArrivalsFetcher({ source: undefined, lineIds: ['victoria'], log: () => {} });

    // Act
    const predictions = await sample();

    // Assert
    expect(predictions).toBeNull();
  });
});
