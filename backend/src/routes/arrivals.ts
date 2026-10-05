import type { FastifyInstance, FastifyReply } from 'fastify';
import { feedTimestamp, type ArrivalsCacheState, type ArrivalsSource } from '../arrivals-source';
import { LINE_ID_PATTERN, MAX_LINE_IDS, MIN_LINE_IDS } from '../constants';

interface ArrivalsQuery {
  readonly lines?: string;
}

interface ArrivalsDeps {
  /** Undefined when TFL_APP_KEY is unset: the route then answers 503. */
  readonly source: ArrivalsSource | undefined;
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

const MS_PER_SECOND = 1_000;

/**
 * Provenance headers on every body this route serves. `x-cache` says how the
 * origin answered (hit | miss | join | stale — see ArrivalsCacheState);
 * `x-feed-timestamp` is TfL's own timestamp for the body (absent for an empty
 * one) and `x-cache-age` the whole seconds since the origin cached it. A
 * browser that sees a body older than one it already had can then tell the
 * origin (an x-feed-timestamp that went backwards here) from the Cloudflare
 * edge (the same origin headers replayed with an age that no longer adds up).
 */
function sendBody(
  reply: FastifyReply,
  served: { readonly cacheState: ArrivalsCacheState; readonly body: unknown; readonly storedAt: number },
  now: number,
): FastifyReply {
  const ts = feedTimestamp(served.body);
  const ageSeconds = Math.max(0, Math.floor((now - served.storedAt) / MS_PER_SECOND));
  reply.header('x-cache', served.cacheState).header('x-cache-age', String(ageSeconds));
  if (ts !== undefined) reply.header('x-feed-timestamp', ts);
  return reply.send(served.body);
}

export function registerArrivalsRoute(app: FastifyInstance, deps: ArrivalsDeps): void {
  const { source } = deps;

  // No TfL key → no source and no tube network to report on. Answering 503
  // with the reason beats a silent empty array: a frontend that reads
  // /api/capabilities never calls this, so anyone who does reach it is
  // debugging and wants the cause.
  if (source === undefined) {
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

    const result = await source.lookup(parsed.ids);
    switch (result.kind) {
      case 'body':
        return sendBody(reply, result, source.clock());
      case 'upstream-error': {
        // TfL error object (e.g. unknown line id): pass through, not cached.
        // TfL echoes the request URI (including app_key) in error bodies, so
        // redact the secret before it can reach the browser.
        const sanitized = JSON.stringify(result.body).replaceAll(source.appKey, '<redacted>');
        return reply
          .code(result.status)
          .header('x-cache', result.cacheState)
          .header('content-type', 'application/json; charset=utf-8')
          .send(sanitized);
      }
      case 'exhausted':
        return reply
          .code(429)
          .send({ error: 'Upstream TfL request budget exhausted; try again shortly.' });
      case 'failed':
        request.log.warn({ err: result.error, lines: parsed.ids.join(',') }, 'upstream TfL fetch failed');
        return reply.code(502).send({ error: 'Upstream TfL request failed.' });
    }
  });
}
