// Bus-coverage flow-map endpoint.
//
//   GET /api/coverage → the prebuilt six-bucket GeoJSON, 404 until first build
//
// The artifact is written by coverage-writer.ts under <busDataDir>/coverage/.
// A 6 h HTTP max-age matches the writer's regeneration cadence (rain-radar
// style): the payload only changes when the rolling window advances, so
// letting the CDN hold it for a full cycle costs no freshness and saves the
// origin→CDN egress this deployment is billed by.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

const COVERAGE_MAX_AGE_S = 21_600;

export function registerCoverageRoute(app: FastifyInstance, coverageDir: string): void {
  app.get('/api/coverage', async (_req, reply) => {
    try {
      // read-then-send (not a stream) so a concurrent tmp+rename rebuild can
      // never interleave with an in-flight response
      const body = await readFile(join(coverageDir, 'latest.json'), 'utf8');
      return await reply
        .header('content-type', 'application/json')
        .header('cache-control', `public, max-age=${COVERAGE_MAX_AGE_S}`)
        .send(body);
    } catch (err) {
      // no-store on both error paths: an edge-cached 404 would keep answering
      // "not yet" for its whole TTL after the artifact actually lands.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return reply
          .code(404)
          .header('cache-control', 'no-store')
          .send({ error: 'coverage artifact not generated yet' });
      }
      // Anything else (permissions, disk I/O) is a real server fault — do not
      // disguise it as the benign pre-first-build state.
      app.log.error({ err }, 'coverage: artifact read failed');
      return reply
        .code(500)
        .header('cache-control', 'no-store')
        .send({ error: 'coverage read failed' });
    }
  });
}
