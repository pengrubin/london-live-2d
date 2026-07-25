// Learned bus-route geometry endpoints.
//
//   GET /api/bus-routes-index         → ["TFLO_88_outbound", …] sanitized keys
//   GET /bus-routes/learned/:file     → one learned route JSON
//
// The learned files live under <base>/bus-routes/learned/ (base = the persist
// volume when PERSIST_DIR is set, else data/ — the SAME base the learner writes
// to, injected as `learnedDir`). In dev the data/ variant is also Vite's
// publicDir, so the frontend fetches the JSON straight from Vite there. The
// backend serves the same files so production needs no extra static host, and
// serves the index in both cases (Vite can't list a directory).

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

const INDEX_TTL_MS = 5 * 60_000;
const LEARNED_FILE_RE = /^[A-Za-z0-9_.-]+\.json$/;

export function registerBusRoutesRoute(app: FastifyInstance, learnedDir: string): void {
  let cachedIndex: string[] | null = null;
  let cachedAt = 0;

  app.get('/api/bus-routes-index', async () => {
    const now = Date.now();
    if (cachedIndex !== null && now - cachedAt < INDEX_TTL_MS) return cachedIndex;
    try {
      const names = await readdir(learnedDir);
      cachedIndex = names
        .filter((n) => LEARNED_FILE_RE.test(n))
        .map((n) => n.slice(0, -'.json'.length))
        .sort();
    } catch {
      cachedIndex = []; // learner hasn't produced anything yet — empty index
    }
    cachedAt = now;
    return cachedIndex;
  });

  app.get<{ Params: { file: string } }>('/bus-routes/learned/:file', async (req, reply) => {
    const { file } = req.params;
    if (!LEARNED_FILE_RE.test(file)) {
      return reply.code(400).send({ error: 'bad route file name' });
    }
    try {
      const body = await readFile(join(learnedDir, file), 'utf8');
      return await reply
        .header('content-type', 'application/json')
        .header('cache-control', 'public, max-age=3600')
        .send(body);
    } catch {
      return reply.code(404).send({ error: 'no such learned route' });
    }
  });
}
