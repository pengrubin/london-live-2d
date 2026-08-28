// One-off bulk export of runtime-collected datasets for local analysis.
//
//   GET /api/export/:dataset        → ["2026-08-16", …] available UTC days
//   GET /api/export/:dataset/:day   → that day's file, streamed
//
// Datasets are a fixed whitelist of the day-partitioned archives under the
// persist base dir. Everything is guarded by ADMIN_EXPORT_TOKEN (Bearer): the
// raw traces contain vehicle IDs, which are fine to analyse privately but are
// never published — so this must never be an open endpoint. When the token is
// unset the routes are not registered at all. Streaming keeps memory flat even
// for multi-hundred-MB trace days; egress is a deliberate one-off cost.

import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { createHash, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

interface DatasetSpec {
  readonly dir: string;
  readonly ext: '.jsonl' | '.json';
  readonly contentType: string;
}

const DATASETS: Readonly<Record<string, DatasetSpec>> = {
  'bus-traces': { dir: 'bus-traces', ext: '.jsonl', contentType: 'application/x-ndjson' },
  'bus-rollups': { dir: 'bus-rollups', ext: '.json', contentType: 'application/json' },
  'tube-status': { dir: 'tube-status', ext: '.jsonl', contentType: 'application/x-ndjson' },
  'road-disruptions': {
    dir: 'road-disruptions',
    ext: '.jsonl',
    contentType: 'application/x-ndjson',
  },
};

/** Constant-time bearer-token check; hashing first equalises lengths. */
function isAuthorized(header: string | undefined, token: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const presented = createHash('sha256').update(header.slice('Bearer '.length)).digest();
  const expected = createHash('sha256').update(token).digest();
  return timingSafeEqual(presented, expected);
}

export function registerDataExportRoute(
  app: FastifyInstance,
  baseDir: string,
  token: string,
): void {
  const guard = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (isAuthorized(req.headers.authorization, token)) return true;
    void reply.code(401).send({ error: 'missing or invalid token' });
    return false;
  };

  app.get<{ Params: { dataset: string } }>('/api/export/:dataset', async (req, reply) => {
    if (!guard(req, reply)) return reply;
    const spec = DATASETS[req.params.dataset];
    if (!spec) return reply.code(400).send({ error: 'unknown dataset' });
    try {
      const names = await readdir(join(baseDir, spec.dir));
      const days = names
        .filter((n) => n.endsWith(spec.ext) && DAY_RE.test(n.slice(0, -spec.ext.length)))
        .map((n) => n.slice(0, -spec.ext.length))
        .sort();
      return await reply.send(days);
    } catch {
      return reply.send([]); // dataset directory not created yet — nothing recorded
    }
  });

  app.get<{ Params: { dataset: string; day: string } }>(
    '/api/export/:dataset/:day',
    async (req, reply) => {
      if (!guard(req, reply)) return reply;
      const spec = DATASETS[req.params.dataset];
      if (!spec) return reply.code(400).send({ error: 'unknown dataset' });
      if (!DAY_RE.test(req.params.day)) {
        return reply.code(400).send({ error: 'day must be YYYY-MM-DD' });
      }
      const filePath = join(baseDir, spec.dir, `${req.params.day}${spec.ext}`);
      try {
        const info = await stat(filePath);
        if (!info.isFile()) return await reply.code(404).send({ error: 'no such day' });
      } catch {
        return reply.code(404).send({ error: 'no such day' });
      }
      return reply.header('content-type', spec.contentType).send(createReadStream(filePath));
    },
  );
}
