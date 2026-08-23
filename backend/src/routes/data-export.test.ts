import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerDataExportRoute } from './data-export';

const TOKEN = 'test-export-token';
const AUTH = { authorization: `Bearer ${TOKEN}` };

describe('data export routes', () => {
  let app: FastifyInstance;
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), 'export-test-'));
    await mkdir(join(baseDir, 'bus-traces'), { recursive: true });
    await writeFile(
      join(baseDir, 'bus-traces', '2026-08-20.jsonl'),
      '{"k":"TFLO:88:outbound","i":"V1","x":-0.1,"y":51.5,"t":1755640000}\n',
    );
    await writeFile(join(baseDir, 'bus-traces', 'not-a-day.jsonl'), '{}\n');
    app = Fastify();
    registerDataExportRoute(app, baseDir, TOKEN);
  });

  afterEach(async () => {
    await app.close();
    await rm(baseDir, { recursive: true, force: true });
  });

  it('rejects a missing token with 401', async () => {
    const res = await app.inject({ url: '/api/export/bus-traces' });

    expect(res.statusCode).toBe(401);
  });

  it('rejects a wrong token with 401', async () => {
    const res = await app.inject({
      url: '/api/export/bus-traces/2026-08-20',
      headers: { authorization: 'Bearer wrong' },
    });

    expect(res.statusCode).toBe(401);
  });

  it('lists only well-formed day files for a dataset', async () => {
    const res = await app.inject({ url: '/api/export/bus-traces', headers: AUTH });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(['2026-08-20']);
  });

  it('returns an empty list for a dataset with no directory yet', async () => {
    const res = await app.inject({ url: '/api/export/tube-status', headers: AUTH });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it('rejects an unknown dataset with 400', async () => {
    const res = await app.inject({ url: '/api/export/learned-routes', headers: AUTH });

    expect(res.statusCode).toBe(400);
  });

  it('rejects a malformed day (path traversal shape) with 400', async () => {
    const res = await app.inject({
      url: '/api/export/bus-traces/..%2F..%2Fsecrets',
      headers: AUTH,
    });

    expect(res.statusCode).toBe(400);
  });

  it('returns 404 for a day with no file', async () => {
    const res = await app.inject({ url: '/api/export/bus-traces/2026-08-19', headers: AUTH });

    expect(res.statusCode).toBe(404);
  });

  it('streams the day file back verbatim', async () => {
    const res = await app.inject({ url: '/api/export/bus-traces/2026-08-20', headers: AUTH });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/x-ndjson');
    expect(res.body).toContain('"k":"TFLO:88:outbound"');
  });
});
