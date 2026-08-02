import type { FastifyInstance, FastifyReply } from 'fastify';
import type { TtlCache } from '../cache';
import type { AppConfig } from '../config';
import { LINE_ID_PATTERN, MAX_LINE_IDS, MIN_LINE_IDS } from '../constants';
import type { RateBudget } from '../rate-budget';
import { fetchArrivals } from '../tfl-client';

interface ArrivalsQuery {
  readonly lines?: string;
}

interface ArrivalsDeps {
  readonly config: AppConfig;
  readonly cache: TtlCache<unknown>;
  readonly budget: RateBudget;
}

type LinesParseResult =
  | { readonly ok: true; readonly ids: readonly string[] }
  | { readonly ok: false; readonly message: string };

function parseLinesParam(raw: string | undefined): LinesParseResult {
  if (raw === undefined || raw.trim() === '') {
    return { ok: false, message: 'Query parameter "lines" is required (comma-separated line ids).' };
  }
  const ids = raw.split(',').map((id) => id.trim());
  if (ids.length < MIN_LINE_IDS || ids.length > MAX_LINE_IDS) {
    return {
      ok: false,
      message: `"lines" must contain between ${MIN_LINE_IDS} and ${MAX_LINE_IDS} ids.`,
    };
  }
  const invalid = ids.find((id) => !LINE_ID_PATTERN.test(id));
  if (invalid !== undefined) {
    return {
      ok: false,
      message: `Invalid line id "${invalid}": ids must match ${LINE_ID_PATTERN.toString()}.`,
    };
  }
  const deduped = [...new Set(ids)].sort();
  return { ok: true, ids: deduped };
}

function sendCached(reply: FastifyReply, cacheState: 'hit' | 'stale', body: unknown): FastifyReply {
  return reply.header('x-cache', cacheState).send(body);
}

export function registerArrivalsRoute(app: FastifyInstance, deps: ArrivalsDeps): void {
  const { config, cache, budget } = deps;

  // No TfL key → no tube network to report on. Answering 503 with the reason
  // beats a silent empty array: a frontend that reads /api/capabilities never
  // calls this, so anyone who does reach it is debugging and wants the cause.
  const appKey = config.tflAppKey;
  if (appKey === undefined) {
    app.get('/api/arrivals', async (_request, reply) =>
      reply.code(503).send({ error: 'TFL_APP_KEY not configured' }),
    );
    return;
  }

  app.get<{ Querystring: ArrivalsQuery }>('/api/arrivals', async (request, reply) => {
    const parsed = parseLinesParam(request.query.lines);
    if (!parsed.ok) {
      return reply.code(400).send({ error: parsed.message });
    }

    const cacheKey = parsed.ids.join(',');

    const fresh = cache.getFresh(cacheKey);
    if (fresh !== undefined) {
      return sendCached(reply, 'hit', fresh);
    }

    if (!budget.tryConsume()) {
      const stale = cache.getStale(cacheKey);
      if (stale !== undefined) {
        return sendCached(reply, 'stale', stale);
      }
      return reply
        .code(429)
        .send({ error: 'Upstream TfL request budget exhausted; try again shortly.' });
    }

    try {
      const upstream = await fetchArrivals(parsed.ids, appKey);
      if (Array.isArray(upstream.body)) {
        cache.set(cacheKey, upstream.body);
        return reply.header('x-cache', 'miss').send(upstream.body);
      }
      // TfL error object (e.g. unknown line id): pass through, do not cache.
      // TfL echoes the request URI (including app_key) in error bodies, so
      // redact the secret before it can reach the browser.
      const sanitized = JSON.stringify(upstream.body).replaceAll(appKey, '<redacted>');
      return reply
        .code(upstream.status)
        .header('x-cache', 'miss')
        .header('content-type', 'application/json; charset=utf-8')
        .send(sanitized);
    } catch (err) {
      request.log.warn({ err, lines: cacheKey }, 'upstream TfL fetch failed');
      const stale = cache.getStale(cacheKey);
      if (stale !== undefined) {
        return sendCached(reply, 'stale', stale);
      }
      return reply.code(502).send({ error: 'Upstream TfL request failed.' });
    }
  });
}
