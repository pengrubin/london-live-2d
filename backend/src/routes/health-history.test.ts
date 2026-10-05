import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { utcDay } from '../health-recorder';
import { registerHealthHistoryRoute } from './health-history';

const PAST = '2026-09-01';
const TODAY_LINE = '{"at":1,"status":"ok"}\n';
const PAST_LINE = '{"at":2,"status":"ok"}\n';

describe('health-history route', () => {
  let base: string;
  let dir: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'health-history-route-'));
    dir = join(base, 'health-history');
    await mkdir(dir);
    await writeFile(join(dir, `${utcDay(Date.now())}.jsonl`), TODAY_LINE);
    await writeFile(join(dir, `${PAST}.jsonl`), PAST_LINE);
    app = Fastify();
    registerHealthHistoryRoute(app, dir);
  });

  afterEach(async () => {
    await app.close();
    await rm(base, { recursive: true, force: true });
  });

  it('serves today by default as uncached NDJSON', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health-history' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/x-ndjson');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toBe(TODAY_LINE);
  });

  it('serves a past day with an hour of public caching', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/health-history?day=${PAST}` });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/x-ndjson');
    expect(res.headers['cache-control']).toBe('public, max-age=3600');
    expect(res.body).toBe(PAST_LINE);
  });

  it('returns a JSON 404 for a day with no file', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health-history?day=2020-01-01' });

    expect(res.statusCode).toBe(404);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toEqual({ error: 'no health history for that day' });
  });

  it.each(['2026-9-1', '../../.env', '2026-09-01.jsonl', '2026-09-01/../x', ''])(
    'rejects malformed day %j with 400',
    async (day) => {
      const res = await app.inject({ method: 'GET', url: `/api/health-history?day=${encodeURIComponent(day)}` });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'day must be YYYY-MM-DD' });
    },
  );

  it('lists available days, sorted, ignoring non-day files', async () => {
    await writeFile(join(dir, 'stray.tmp'), '');

    const res = await app.inject({ method: 'GET', url: '/api/health-history?list=1' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([PAST, utcDay(Date.now())]);
  });

  it('lists nothing when no sample has been written yet', async () => {
    const empty = Fastify();
    registerHealthHistoryRoute(empty, join(base, 'missing'));

    const res = await empty.inject({ method: 'GET', url: '/api/health-history?list=1' });

    expect(res.json()).toEqual([]);
    await empty.close();
  });
});
