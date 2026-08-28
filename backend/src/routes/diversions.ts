// Live bus-diversion events.
//
//   GET /api/diversions → { generatedAt, events: [...] } (contract in
//   diversion-detector.ts: only display-worthy events; the frontend renders
//   exactly what this returns, with no client-side filtering rules)
//
// max-age=60: events change on the 15 s BODS cadence but the display bar
// (two vehicles, high confidence) moves in minutes, so a minute of edge cache
// costs no correctness and absorbs the polling fan-out. When the detector is
// not running (no BODS key or no learned routes) the route still answers with
// an empty event list — the capabilities flag keeps the frontend from asking,
// but a stray fetch must not 404 into an edge cache.
//
// Takes a GETTER, not a detector instance: on a fresh volume app.ts starts
// the detector long after this route registers (once learned routes appear),
// and the route must serve it from that moment.

import type { FastifyInstance } from 'fastify';
import type { DiversionDetector } from '../diversion-detector';

const DIVERSIONS_MAX_AGE_S = 60;

export function registerDiversionsRoute(
  app: FastifyInstance,
  getDetector: () => DiversionDetector | null,
): void {
  app.get('/api/diversions', async (_req, reply) => {
    const detector = getDetector();
    const payload =
      detector === null
        ? { generatedAt: Math.floor(Date.now() / 1000), events: [] }
        : await detector.snapshot();
    return reply
      .header('cache-control', `public, max-age=${DIVERSIONS_MAX_AGE_S}`)
      .send(payload);
  });
}
