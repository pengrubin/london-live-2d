import type { FastifyInstance, FastifyReply } from 'fastify';
import type { TtlCache } from '../cache';
import type { AppConfig } from '../config';
import type { RateBudget } from '../rate-budget';
import type { TflResponse } from '../tfl-client';

export interface ProxyDeps {
  readonly config: AppConfig;
  readonly cache: TtlCache<unknown>;
  readonly budget: RateBudget;
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

/** Cache key for routes without query parameters. */
const FIXED_KEY = '';
const HTTP_OK = 200;

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
 * Registers a GET route proxying one TfL lookup, with fresh/stale caching and
 * the shared upstream budget. Any 200 upstream body (array or object) is cached
 * and passed through; non-200 bodies are passed through with the key redacted.
 */
export function registerProxyRoute(
  app: FastifyInstance,
  deps: ProxyDeps,
  spec: ProxyRouteSpec,
): void {
  const { config, cache, budget } = deps;

  // Resolve the fetcher once, at registration: a TfL upstream with no key
  // configured never becomes a live route at all. Mirrors how /api/nr-board
  // behaves without DARWIN_TOKEN, and is what lets a deployment outside London
  // start with the TfL layers simply absent rather than failing.
  const appKey = config.tflAppKey;
  let fetchUpstream: (value: string) => Promise<TflResponse>;
  if (spec.fetchTfl !== undefined) {
    if (appKey === undefined) {
      app.get(spec.path, async (_request, reply) =>
        reply.code(503).send({ error: 'TFL_APP_KEY not configured' }),
      );
      return;
    }
    const { fetchTfl } = spec;
    const tflKey = appKey;
    fetchUpstream = (value) => fetchTfl(value, tflKey);
  } else {
    fetchUpstream = spec.fetchUpstream;
  }

  app.get<{ Querystring: QueryString }>(spec.path, async (request, reply) => {
    const parsed = spec.parseKey ? spec.parseKey(request.query) : { key: FIXED_KEY };
    if ('error' in parsed) {
      return reply.code(400).send({ error: parsed.error });
    }
    const key = parsed.key;

    const fresh = cache.getFresh(key);
    if (fresh !== undefined) return sendCached(reply, 'hit', fresh);

    if (!budget.tryConsume()) {
      const stale = cache.getStale(key);
      if (stale !== undefined) return sendCached(reply, 'stale', stale);
      return reply
        .code(429)
        .send({ error: 'Upstream TfL request budget exhausted; try again shortly.' });
    }

    try {
      const upstream = await fetchUpstream(key);
      if (upstream.status === HTTP_OK) {
        cache.set(key, upstream.body);
        return reply.header('x-cache', 'miss').send(upstream.body);
      }
      // TfL error bodies echo the request URI incl. app_key — redact the secret.
      // Non-TfL upstreams have no key to leak, so there is nothing to redact.
      const raw = JSON.stringify(upstream.body);
      const sanitized = appKey === undefined ? raw : raw.replaceAll(appKey, '<redacted>');
      return reply
        .code(upstream.status)
        .header('x-cache', 'miss')
        .header('content-type', 'application/json; charset=utf-8')
        .send(sanitized);
    } catch (err) {
      request.log.warn({ err, path: spec.path, key }, 'upstream TfL fetch failed');
      const stale = cache.getStale(key);
      if (stale !== undefined) return sendCached(reply, 'stale', stale);
      return reply.code(502).send({ error: 'Upstream TfL request failed.' });
    }
  });
}
