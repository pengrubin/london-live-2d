import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerCoverageRoute } from './coverage';

describe('coverage route', () => {
  let app: FastifyInstance;
  let coverageDir: string;

  beforeEach(async () => {
    coverageDir = await mkdtemp(join(tmpdir(), 'coverage-test-'));
    app = Fastify();
    registerCoverageRoute(app, coverageDir);
  });

  afterEach(async () => {
    await app.close();
    await rm(coverageDir, { recursive: true, force: true });
  });

  it('serves the artifact with the 6h cache header', async () => {
    const artifact = '{"type":"FeatureCollection","day":"2026-08-27","features":[]}';
    await writeFile(join(coverageDir, 'latest.json'), artifact);

    const res = await app.inject({ method: 'GET', url: '/api/coverage' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json\b/);
    expect(res.headers['cache-control']).toBe('public, max-age=21600');
    expect(res.body).toBe(artifact);
  });

  it('returns an uncacheable 404 before the first build', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/coverage' });

    expect(res.statusCode).toBe(404);
    // no-store: an edge-cached 404 would outlive the artifact landing
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toEqual({ error: 'coverage artifact not generated yet' });
  });

  it('reports a non-ENOENT read failure as a 500, not a benign 404', async () => {
    // a directory at the artifact path makes readFile fail with EISDIR
    await mkdir(join(coverageDir, 'latest.json'));

    const res = await app.inject({ method: 'GET', url: '/api/coverage' });

    expect(res.statusCode).toBe(500);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toEqual({ error: 'coverage read failed' });
  });
});
