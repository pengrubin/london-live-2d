import Fastify, { type FastifyInstance, type LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { FAILURE_BACKOFF_MS, registerProxyRoute, singleParamKey } from './proxy-route';
import { TtlCache } from '../cache';
import { RateBudget } from '../rate-budget';
import type { AppConfig } from '../config';
import type { TflResponse } from '../tfl-client';

// Only the field registerProxyRoute reads from the config.
const APP_KEY = 'test-app-key-0123';
const CONFIG = { tflAppKey: APP_KEY } as unknown as AppConfig;
const CONFIG_WITHOUT_KEY = { tflAppKey: undefined } as unknown as AppConfig;

const PATH = '/api/proxy-under-test';
const TTL_MS = 8_000;
/** Shorter than the back-off so one test can cross the stale bound inside it. */
const MAX_STALE_MS = 20_000;
const BUDGET_LIMIT = 60;
const BUDGET_WINDOW_MS = 60_000;
const T0 = 1_756_800_000_000;
const CONCURRENT_REQUESTS = 10;
const OK_BODY = { items: [1, 2] };
const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;
const HTTP_TOO_MANY = 429;
const HTTP_BAD_GATEWAY = 502;
const UPSTREAM_FAILED = { error: 'Upstream TfL request failed.' };

type Spec = Parameters<typeof registerProxyRoute>[2];

interface Harness {
  readonly app: FastifyInstance;
  readonly cache: TtlCache<unknown>;
  readonly tryConsume: MockInstance<RateBudget['tryConsume']>;
  readonly advance: (ms: number) => void;
  readonly get: (url?: string) => Promise<LightMyRequestResponse>;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: Error) => void;
}

const ok = (body: unknown = OK_BODY): TflResponse => ({ status: HTTP_OK, body });

/** A fetcher that succeeds until `fail()` is called, then throws on every call. */
function flakyFetcher(): { readonly fetchTfl: ReturnType<typeof vi.fn>; readonly fail: () => void } {
  let failing = false;
  const fetchTfl = vi.fn(async (): Promise<TflResponse> => {
    if (failing) throw new Error('upstream down');
    return ok();
  });
  return {
    fetchTfl,
    fail: () => {
      failing = true;
    },
  };
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

const apps: FastifyInstance[] = [];

function harness(spec: Spec, budgetLimit = BUDGET_LIMIT, config = CONFIG): Harness {
  let clock = T0;
  const cache = new TtlCache<unknown>(TTL_MS);
  const budget = new RateBudget(budgetLimit, BUDGET_WINDOW_MS);
  const tryConsume = vi.spyOn(budget, 'tryConsume');
  const app = Fastify();
  apps.push(app);
  registerProxyRoute(app, { config, cache, budget, now: () => clock }, spec);
  return {
    app,
    cache,
    tryConsume,
    advance: (ms) => {
      clock += ms;
    },
    get: (url = PATH) => app.inject({ method: 'GET', url }),
  };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('registerProxyRoute with shape and maxStaleMs absent (existing behaviour)', () => {
  it('answers a cold key from upstream as miss and a warm one from the cache as hit', async () => {
    // Arrange
    const fetchTfl = vi.fn(async () => ok());
    const h = harness({ path: PATH, fetchTfl });

    // Act
    const first = await h.get();
    const second = await h.get();

    // Assert
    expect(first.statusCode).toBe(HTTP_OK);
    expect(first.headers['x-cache']).toBe('miss');
    expect(first.json()).toEqual(OK_BODY);
    expect(second.headers['x-cache']).toBe('hit');
    expect(second.json()).toEqual(OK_BODY);
    expect(fetchTfl).toHaveBeenCalledTimes(1);
    expect(fetchTfl).toHaveBeenCalledWith('', APP_KEY);
    expect(h.tryConsume).toHaveBeenCalledTimes(1);
  });

  it('passes the parsed key to the fetcher and rejects a bad query with 400', async () => {
    // Arrange
    const fetchTfl = vi.fn(async (id: string) => ok({ id }));
    const h = harness({ path: PATH, parseKey: singleParamKey('id', /^[0-9]{3}$/), fetchTfl });

    // Act
    const good = await h.get(`${PATH}?id=490`);
    const bad = await h.get(`${PATH}?id=nope`);

    // Assert
    expect(good.json()).toEqual({ id: '490' });
    expect(fetchTfl).toHaveBeenCalledWith('490', APP_KEY);
    expect(bad.statusCode).toBe(400);
    expect(fetchTfl).toHaveBeenCalledTimes(1);
  });

  it('forwards a non-200 upstream body with the app key redacted and caches nothing', async () => {
    // Arrange
    const leaking = { message: `https://api.tfl.gov.uk/x?app_key=${APP_KEY}` };
    const fetchTfl = vi.fn(async (): Promise<TflResponse> => ({ status: HTTP_NOT_FOUND, body: leaking }));
    const h = harness({ path: PATH, fetchTfl });

    // Act
    const res = await h.get();

    // Assert
    expect(res.statusCode).toBe(HTTP_NOT_FOUND);
    expect(res.headers['x-cache']).toBe('miss');
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(res.body).not.toContain(APP_KEY);
    expect(res.json()).toEqual({ message: 'https://api.tfl.gov.uk/x?app_key=<redacted>' });
    expect(h.cache.getStale('')).toBeUndefined();
  });

  it('serves the expired entry as stale when the budget is exhausted', async () => {
    // Arrange
    const fetchTfl = vi.fn(async () => ok());
    const h = harness({ path: PATH, fetchTfl }, 1);
    await h.get();
    h.advance(TTL_MS);

    // Act
    const res = await h.get();

    // Assert
    expect(res.statusCode).toBe(HTTP_OK);
    expect(res.headers['x-cache']).toBe('stale');
    expect(res.json()).toEqual(OK_BODY);
    expect(fetchTfl).toHaveBeenCalledTimes(1);
  });

  it('answers 429 when the budget is exhausted and nothing is cached', async () => {
    // Arrange
    const fetchTfl = vi.fn(async () => ok());
    const h = harness({ path: PATH, fetchTfl }, 0);

    // Act
    const res = await h.get();

    // Assert
    expect(res.statusCode).toBe(HTTP_TOO_MANY);
    expect(fetchTfl).not.toHaveBeenCalled();
  });

  it('serves the expired entry as stale when the upstream throws', async () => {
    // Arrange
    const upstream = flakyFetcher();
    const h = harness({ path: PATH, fetchTfl: upstream.fetchTfl });
    await h.get();
    upstream.fail();
    h.advance(TTL_MS);

    // Act
    const res = await h.get();

    // Assert
    expect(res.statusCode).toBe(HTTP_OK);
    expect(res.headers['x-cache']).toBe('stale');
    expect(res.json()).toEqual(OK_BODY);
    expect(upstream.fetchTfl).toHaveBeenCalledTimes(2);
  });

  it('answers 502 when the upstream throws and nothing is cached', async () => {
    // Arrange
    const fetchTfl = vi.fn(async (): Promise<TflResponse> => {
      throw new Error('upstream down');
    });
    const h = harness({ path: PATH, fetchTfl });

    // Act
    const res = await h.get();

    // Assert
    expect(res.statusCode).toBe(HTTP_BAD_GATEWAY);
    expect(res.json()).toEqual(UPSTREAM_FAILED);
  });

  it('registers a 503 route for a TfL upstream when no key is configured', async () => {
    // Arrange
    const fetchTfl = vi.fn(async () => ok());
    const h = harness({ path: PATH, fetchTfl }, BUDGET_LIMIT, CONFIG_WITHOUT_KEY);

    // Act
    const res = await h.get();

    // Assert
    expect(res.statusCode).toBe(503);
    expect(fetchTfl).not.toHaveBeenCalled();
    expect(h.tryConsume).not.toHaveBeenCalled();
  });
});

describe('single-flight', () => {
  it('coalesces concurrent cold requests: one upstream call, one tryConsume, every response a miss', async () => {
    // Arrange
    const upstream = deferred<TflResponse>();
    const fetchTfl = vi.fn(() => upstream.promise);
    const h = harness({ path: PATH, fetchTfl });
    await h.app.ready();

    // Act
    const pending = Promise.all(Array.from({ length: CONCURRENT_REQUESTS }, () => h.get()));
    await nextMacrotask();
    const callsBeforeRelease = fetchTfl.mock.calls.length;
    upstream.resolve(ok());
    const responses = await pending;

    // Assert
    expect(callsBeforeRelease).toBe(1);
    expect(fetchTfl).toHaveBeenCalledTimes(1);
    expect(h.tryConsume).toHaveBeenCalledTimes(1);
    expect(responses.map((r) => r.statusCode)).toEqual(Array(CONCURRENT_REQUESTS).fill(HTTP_OK));
    expect(responses.map((r) => r.headers['x-cache'])).toEqual(Array(CONCURRENT_REQUESTS).fill('miss'));
    expect(responses.map((r) => r.json())).toEqual(Array(CONCURRENT_REQUESTS).fill(OK_BODY));
  });

  it('shares one upstream failure with every waiter and arms the back-off once', async () => {
    // Arrange
    const upstream = deferred<TflResponse>();
    const fetchTfl = vi.fn(() => upstream.promise);
    const h = harness({ path: PATH, fetchTfl });
    await h.app.ready();

    // Act
    const pending = Promise.all(Array.from({ length: CONCURRENT_REQUESTS }, () => h.get()));
    await nextMacrotask();
    upstream.reject(new Error('upstream down'));
    const responses = await pending;
    h.advance(1);
    const later = await h.get();

    // Assert
    expect(responses.map((r) => r.statusCode)).toEqual(Array(CONCURRENT_REQUESTS).fill(HTTP_BAD_GATEWAY));
    expect(later.statusCode).toBe(HTTP_BAD_GATEWAY);
    expect(fetchTfl).toHaveBeenCalledTimes(1);
    expect(h.tryConsume).toHaveBeenCalledTimes(1);
  });

  it('fetches again once the in-flight request has settled and the entry has expired', async () => {
    // Arrange
    const fetchTfl = vi.fn(async () => ok());
    const h = harness({ path: PATH, fetchTfl });
    await h.get();
    h.advance(TTL_MS);

    // Act
    const res = await h.get();

    // Assert
    expect(res.headers['x-cache']).toBe('miss');
    expect(fetchTfl).toHaveBeenCalledTimes(2);
    expect(h.tryConsume).toHaveBeenCalledTimes(2);
  });
});

describe('failure back-off', () => {
  it('a miss within FAILURE_BACKOFF_MS of a failed fetch serves stale without tryConsume', async () => {
    // Arrange
    const upstream = flakyFetcher();
    const h = harness({ path: PATH, fetchTfl: upstream.fetchTfl });
    await h.get();
    upstream.fail();
    h.advance(TTL_MS);
    const failing = await h.get();
    h.advance(FAILURE_BACKOFF_MS - 1);

    // Act
    const backedOff = await h.get();

    // Assert
    expect(failing.headers['x-cache']).toBe('stale');
    expect(backedOff.statusCode).toBe(HTTP_OK);
    expect(backedOff.headers['x-cache']).toBe('stale');
    expect(backedOff.json()).toEqual(OK_BODY);
    expect(upstream.fetchTfl).toHaveBeenCalledTimes(2);
    expect(h.tryConsume).toHaveBeenCalledTimes(2);
  });

  it('retries upstream once FAILURE_BACKOFF_MS has elapsed', async () => {
    // Arrange
    const upstream = flakyFetcher();
    const h = harness({ path: PATH, fetchTfl: upstream.fetchTfl });
    await h.get();
    upstream.fail();
    h.advance(TTL_MS);
    await h.get();
    h.advance(FAILURE_BACKOFF_MS);

    // Act
    const res = await h.get();

    // Assert
    expect(res.headers['x-cache']).toBe('stale');
    expect(upstream.fetchTfl).toHaveBeenCalledTimes(3);
    expect(h.tryConsume).toHaveBeenCalledTimes(3);
  });

  it('in back-off with nothing cached answers 502 exactly like the failure path, without tryConsume', async () => {
    // Arrange
    const fetchTfl = vi.fn(async (): Promise<TflResponse> => {
      throw new Error('upstream down');
    });
    const h = harness({ path: PATH, fetchTfl });
    const failing = await h.get();
    h.advance(1);

    // Act
    const backedOff = await h.get();

    // Assert
    expect(failing.statusCode).toBe(HTTP_BAD_GATEWAY);
    expect(backedOff.statusCode).toBe(HTTP_BAD_GATEWAY);
    expect(backedOff.json()).toEqual(UPSTREAM_FAILED);
    expect(backedOff.headers['x-cache']).toBeUndefined();
    expect(fetchTfl).toHaveBeenCalledTimes(1);
    expect(h.tryConsume).toHaveBeenCalledTimes(1);
  });

  it('a returned non-200 is forwarded and does not arm the back-off', async () => {
    // The future disruptions route throws after its fallback fails; a plain
    // non-200 stays a pass-through, so it must not silence the next miss.
    // Arrange
    const fetchTfl = vi.fn(async (): Promise<TflResponse> => ({ status: HTTP_NOT_FOUND, body: {} }));
    const h = harness({ path: PATH, fetchTfl });
    await h.get();
    h.advance(1);

    // Act
    const res = await h.get();

    // Assert
    expect(res.statusCode).toBe(HTTP_NOT_FOUND);
    expect(fetchTfl).toHaveBeenCalledTimes(2);
    expect(h.tryConsume).toHaveBeenCalledTimes(2);
  });
});

describe('maxStaleMs', () => {
  it('bounds the stale served on the failure path: stale inside the bound, 502 at it', async () => {
    // Arrange
    const upstream = flakyFetcher();
    const h = harness({ path: PATH, fetchTfl: upstream.fetchTfl, maxStaleMs: MAX_STALE_MS });
    await h.get();
    upstream.fail();
    h.advance(TTL_MS);

    // Act
    const inside = await h.get();
    h.advance(MAX_STALE_MS - TTL_MS);
    const insideBackoff = await h.get();
    h.advance(FAILURE_BACKOFF_MS);
    const afterBackoff = await h.get();

    // Assert
    expect(inside.headers['x-cache']).toBe('stale');
    expect(insideBackoff.statusCode).toBe(HTTP_BAD_GATEWAY);
    expect(insideBackoff.json()).toEqual(UPSTREAM_FAILED);
    expect(afterBackoff.statusCode).toBe(HTTP_BAD_GATEWAY);
    expect(upstream.fetchTfl).toHaveBeenCalledTimes(3);
    expect(h.tryConsume).toHaveBeenCalledTimes(3);
  });

  it('bounds the stale served on the budget-exhausted path: stale inside the bound, 429 at it', async () => {
    // Arrange
    const fetchTfl = vi.fn(async () => ok());
    const h = harness({ path: PATH, fetchTfl, maxStaleMs: MAX_STALE_MS }, 1);
    await h.get();
    h.advance(TTL_MS);

    // Act
    const inside = await h.get();
    h.advance(MAX_STALE_MS - TTL_MS);
    const beyond = await h.get();

    // Assert
    expect(inside.headers['x-cache']).toBe('stale');
    expect(beyond.statusCode).toBe(HTTP_TOO_MANY);
    expect(fetchTfl).toHaveBeenCalledTimes(1);
  });
});

describe('shape', () => {
  it('caches and sends the shaped body, so a later hit sees the shaped body too', async () => {
    // Arrange
    const shape = vi.fn((body: unknown) => ({ n: (body as { items: number[] }).items.length }));
    const fetchTfl = vi.fn(async () => ok());
    const h = harness({ path: PATH, fetchTfl, shape });

    // Act
    const first = await h.get();
    const second = await h.get();

    // Assert
    expect(first.headers['x-cache']).toBe('miss');
    expect(first.json()).toEqual({ n: 2 });
    expect(second.headers['x-cache']).toBe('hit');
    expect(second.json()).toEqual({ n: 2 });
    expect(shape).toHaveBeenCalledTimes(1);
    expect(shape).toHaveBeenCalledWith(OK_BODY);
    expect(h.cache.getStale('')).toEqual({ n: 2 });
  });

  it('is not applied to a non-200 body', async () => {
    // Arrange
    const shape = vi.fn((body: unknown) => body);
    const fetchTfl = vi.fn(async (): Promise<TflResponse> => ({ status: HTTP_NOT_FOUND, body: {} }));
    const h = harness({ path: PATH, fetchTfl, shape });

    // Act
    const res = await h.get();

    // Assert
    expect(res.statusCode).toBe(HTTP_NOT_FOUND);
    expect(shape).not.toHaveBeenCalled();
  });

  it('a throwing shape is a failed fetch: 502 when cold, stale when warm, back-off armed', async () => {
    // Arrange
    let broken = false;
    const shape = (body: unknown): unknown => {
      if (broken) throw new Error('unexpected body');
      return body;
    };
    const fetchTfl = vi.fn(async () => ok());
    const cold = harness({ path: PATH, fetchTfl, shape });
    const warm = harness({ path: PATH, fetchTfl, shape });
    await warm.get();

    // Act
    broken = true;
    const coldRes = await cold.get();
    warm.advance(TTL_MS);
    const warmRes = await warm.get();
    warm.advance(1);
    const backedOff = await warm.get();

    // Assert
    expect(coldRes.statusCode).toBe(HTTP_BAD_GATEWAY);
    expect(coldRes.json()).toEqual(UPSTREAM_FAILED);
    expect(warmRes.headers['x-cache']).toBe('stale');
    expect(warmRes.json()).toEqual(OK_BODY);
    expect(backedOff.headers['x-cache']).toBe('stale');
    expect(warm.cache.getStale('')).toEqual(OK_BODY);
    expect(fetchTfl).toHaveBeenCalledTimes(3);
    expect(warm.tryConsume).toHaveBeenCalledTimes(2);
  });
});
