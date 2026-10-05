// The server's own /health series (written by health-recorder.ts).
//
//   GET /api/health-history                 → today's (UTC) samples, NDJSON
//   GET /api/health-history?day=YYYY-MM-DD  → that day's samples, NDJSON
//   GET /api/health-history?list=1          → JSON array of available days
//
// Today's file is still being appended to, so it is never cached; a past day
// is immutable, so an hour at the edge costs nothing in freshness.

import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { utcDay } from '../health-recorder';

const PAST_DAY_MAX_AGE_S = 3600;
// Strict: digits and dashes only, anchored at both ends. This is the whole
// path-traversal defence — no '/', '.', or '%' can reach join() below, so the
// request can never name a file outside the health-history directory.
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

interface HealthHistoryQuery {
  day?: string;
  list?: string;
}

export function registerHealthHistoryRoute(app: FastifyInstance, historyDir: string): void {
  app.get<{ Querystring: HealthHistoryQuery }>('/api/health-history', async (req, reply) => {
    if (req.query.list === '1') {
      try {
        const names = await readdir(historyDir);
        const days = names.flatMap((n) => DAY_FILE_RE.exec(n)?.[1] ?? []).sort();
        return await reply.header('cache-control', 'no-store').send(days);
      } catch {
        // Directory not created yet: nothing recorded.
        return reply.header('cache-control', 'no-store').send([]);
      }
    }

    const today = utcDay(Date.now());
    const day = req.query.day ?? today;
    if (!DAY_RE.test(day)) {
      return reply.code(400).header('cache-control', 'no-store').send({ error: 'day must be YYYY-MM-DD' });
    }
    const filePath = join(historyDir, `${day}.jsonl`);
    try {
      const info = await stat(filePath);
      if (!info.isFile()) throw new Error('not a file');
    } catch {
      // no-store: an edge-cached 404 for today would hide the first sample.
      return reply.code(404).header('cache-control', 'no-store').send({ error: 'no health history for that day' });
    }
    return reply
      .header('content-type', 'application/x-ndjson')
      .header('cache-control', day === today ? 'no-store' : `public, max-age=${PAST_DAY_MAX_AGE_S}`)
      .send(createReadStream(filePath));
  });
}
