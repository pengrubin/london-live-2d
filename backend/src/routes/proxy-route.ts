import type { FastifyInstance, FastifyReply } from 'fastify';
import type { TtlCache } from '../cache';
import type { AppConfig } from '../config';
import type { RateBudget } from '../rate-budget';
import type { TflResponse } from '../tfl-client';

export interface ProxyDeps {
  readonly config: AppConfig;
  readonly cache: TtlCache<unknown>;
  readonly budget: RateBudget;
  /** Clock behind cache ages and the failure back-off; `Date.now` unless a test injects one. */
  readonly now?: () => number;
}

/** Result of validating a request's query string: a cache key, or a 400 message. */
export type ParsedKey = { readonly key: string } | { readonly error: string };

type QueryString = Record<string, string | undefined>;

interface ProxyRouteBase {
  readonly path: string;
  /**
   * Derives the cache key (also passed to the fetcher) from the query string.
   * Omit for routes with no query parameters — those use a fixed cache key.
   */
  readonly parseKey?: (query: QueryString) => ParsedKey;
  /**
   * Reshapes a 200 upstream body before it is cached and sent, so neither the
   * cache nor the browser ever holds the raw body. A throw is a failed fetch
   * (stale-or-502, back-off armed). Omit to pass the body through unchanged.
   */
  readonly shape?: (body: unknown) => unknown;
  /**
   * Oldest entry the route may serve as stale when the budget is exhausted or
   * the upstream fails. Omit to serve any age, as the existing routes do.
   */
  readonly maxStaleMs?: number;
}

/**
 * A spec supplies exactly one fetcher, and which one it is *is* the declaration
 * of whether the route needs the TfL key. Expressed as a union rather than a
 * boolean flag so a TfL upstream cannot be registered without the key being
 * threaded to it — the compiler enforces what a flag would leave to memory.
 */
type ProxyRouteSpec = ProxyRouteBase &
  (
    | {
        /** Upstream needing no TfL key (ADS-B, adsbdb, Environment Agency …). */
        readonly fetchUpstream: (value: string) => Promise<TflResponse>;
        readonly fetchTfl?: never;
      }
    | {
        /** TfL upstream; the route degrades to 503 when TFL_APP_KEY is unset. */
        readonly fetchTfl: (value: string, appKey: string) => Promise<TflResponse>;
        readonly fetchUpstream?: never;
      }
  );

type Fetcher = (value: string) => Promise<TflResponse>;

/** Per-route state shared by every request on the route. */
interface RouteState {
  readonly cache: TtlCache<unknown>;
  readonly now: () => number;
  readonly fetchUpstream: Fetcher;
  readonly shape: ((body: unknown) => unknown) | undefined;
  /** Single-flight: the one upstream promise per key, cleared once it settles. */
  readonly inflight: Map<string, Promise<TflResponse>>;
  /** When the last upstream fetch for a key threw; drives the back-off. */
  readonly lastFailureAt: Map<string, number>;
}

/** Cache key for routes without query parameters. */
const FIXED_KEY = '';
const HTTP_OK = 200;
const HTTP_BAD_GATEWAY = 502;
const UPSTREAM_FAILED_ERROR = 'Upstream TfL request failed.';

/**
 * After an upstream fetch throws, misses on that key serve stale (bounded by
 * `maxStaleMs`) or 502 for this long without consuming budget or fetching, so
 * a failing endpoint costs one unit per key per window rather than one per
 * viewer poll.
 */
export const FAILURE_BACKOFF_MS = 30_000;

/** Builds a parseKey for the common case: one query param validated by a pattern. */
export function singleParamKey(name: string, pattern: RegExp): (query: QueryString) => ParsedKey {
  return (query) => {
    const value = query[name]?.trim() ?? '';
    if (!pattern.test(value)) {
      return { error: `Query parameter "${name}" must match ${pattern.toString()}.` };
    }
    return { key: value };
  };
}

function sendCached(reply: FastifyReply, state: 'hit' | 'stale', body: unknown): FastifyReply {
  return reply.header('x-cache', state).send(body);
}

/**
 * Forwards a non-200 upstream body. TfL error bodies echo the request URI
 * incl. app_key — redact the secret. Non-TfL upstreams have no key to leak,
 * so there is nothing to redact.
 */
function sendRedacted(
  reply: FastifyReply,
  upstream: TflResponse,
  appKey: string | undefined,
): FastifyReply {
  const raw = JSON.stringify(upstream.body);
  const sanitized = appKey === undefined ? raw : raw.replaceAll(appKey, '<redacted>');
  return reply
    .code(upstream.status)
    .header('x-cache', 'miss')
    .header('content-type', 'application/json; charset=utf-8')
    .send(sanitized);
}

function sendStaleOrFailure(reply: FastifyReply, stale: unknown): FastifyReply {
  if (stale !== undefined) return sendCached(reply, 'stale', stale);
  return reply.code(HTTP_BAD_GATEWAY).send({ error: UPSTREAM_FAILED_ERROR });
}

/**
 * Resolves the fetcher once, at registration: a TfL upstream with no key
 * configured never becomes a live route at all — a 503 stub is registered and
 * `undefined` returned. Mirrors how /api/nr-board behaves without DARWIN_TOKEN,
 * and is what lets a deployment outside London start with the TfL layers
 * simply absent rather than failing.
 */
function resolveFetcher(
  app: FastifyInstance,
  spec: ProxyRouteSpec,
  appKey: string | undefined,
): Fetcher | undefined {
  if (spec.fetchTfl === undefined) return spec.fetchUpstream;
  if (appKey === undefined) {
    app.get(spec.path, async (_request, reply) =>
      reply.code(503).send({ error: 'TFL_APP_KEY not configured' }),
    );
    return undefined;
  }
  const { fetchTfl } = spec;
  const tflKey = appKey;
  return (value) => fetchTfl(value, tflKey);
}

function isBackingOff(state: RouteState, key: string): boolean {
  const failedAt = state.lastFailureAt.get(key);
  return failedAt !== undefined && state.now() - failedAt < FAILURE_BACKOFF_MS;
}

/**
 * One upstream round trip. A 200 body is shaped and cached before any caller
 * sees it; a throw (from the fetch or from `shape`) arms the back-off for the
 * key and propagates to every request awaiting this flight.
 */
async function fetchAndStore(state: RouteState, key: string): Promise<TflResponse> {
  try {
    const upstream = await state.fetchUpstream(key);
    if (upstream.status !== HTTP_OK) return upstream;
    const body = state.shape === undefined ? upstream.body : state.shape(upstream.body);
    state.cache.set(key, body, state.now());
    state.lastFailureAt.delete(key);
    return { status: HTTP_OK, body };
  } catch (err) {
    state.lastFailureAt.set(key, state.now());
    throw err;
  }
}

/** Concurrent misses on a key share the one in-flight promise. */
function fetchOnce(state: RouteState, key: string): Promise<TflResponse> {
  const pending = state.inflight.get(key);
  if (pending !== undefined) return pending;
  const flight = fetchAndStore(state, key).finally(() => state.inflight.delete(key));
  state.inflight.set(key, flight);
  return flight;
}

/**
 * Registers a GET route proxying one TfL lookup, with fresh/stale caching and
 * the shared upstream budget. Any 200 upstream body (array or object) is cached
 * and passed through; non-200 bodies are passed through with the key redacted.
 *
 * Miss path, in order: a request joining an in-flight fetch awaits it (no
 * budget unit); a key inside its failure back-off serves stale or 502 (no
 * budget unit, no fetch); otherwise one budget unit is consumed and the fetch
 * started — or, budget exhausted, stale or 429.
 */
export function registerProxyRoute(
  app: FastifyInstance,
  deps: ProxyDeps,
  spec: ProxyRouteSpec,
): void {
  const { config, cache, budget } = deps;
  const appKey = config.tflAppKey;
  const fetchUpstream = resolveFetcher(app, spec, appKey);
  if (fetchUpstream === undefined) return;

  const state: RouteState = {
    cache,
    now: deps.now ?? Date.now,
    fetchUpstream,
    shape: spec.shape,
    inflight: new Map(),
    lastFailureAt: new Map(),
  };

  app.get<{ Querystring: QueryString }>(spec.path, async (request, reply) => {
    const parsed = spec.parseKey ? spec.parseKey(request.query) : { key: FIXED_KEY };
    if ('error' in parsed) {
      return reply.code(400).send({ error: parsed.error });
    }
    const key = parsed.key;

    const fresh = cache.getFresh(key, state.now());
    if (fresh !== undefined) return sendCached(reply, 'hit', fresh);

    const stale = (): unknown => cache.getStale(key, spec.maxStaleMs, state.now());
    const joining = state.inflight.has(key);
    if (!joining && isBackingOff(state, key)) {
      request.log.info({ path: spec.path, key }, 'upstream TfL in failure back-off, not retried');
      return sendStaleOrFailure(reply, stale());
    }
    if (!joining && !budget.tryConsume(state.now())) {
      const value = stale();
      if (value !== undefined) return sendCached(reply, 'stale', value);
      return reply
        .code(429)
        .send({ error: 'Upstream TfL request budget exhausted; try again shortly.' });
    }

    try {
      const upstream = await fetchOnce(state, key);
      if (upstream.status === HTTP_OK) {
        return reply.header('x-cache', 'miss').send(upstream.body);
      }
      return sendRedacted(reply, upstream, appKey);
    } catch (err) {
      request.log.warn({ err, path: spec.path, key }, 'upstream TfL fetch failed');
      return sendStaleOrFailure(reply, stale());
    }
  });
}
