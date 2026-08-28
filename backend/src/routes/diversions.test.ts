import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { registerDiversionsRoute } from './diversions';
import type { DiversionDetector } from '../diversion-detector';
import type { DiversionsPayload } from '../diversion-events';

describe('diversions route', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  it('answers an empty payload with the cache header when no detector runs', async () => {
    app = Fastify();
    registerDiversionsRoute(app, () => null);

    const res = await app.inject({ method: 'GET', url: '/api/diversions' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=60');
    const body = res.json() as DiversionsPayload;
    expect(body.events).toEqual([]);
    expect(typeof body.generatedAt).toBe('number');
  });

  it('serves the detector snapshot verbatim', async () => {
    const payload: DiversionsPayload = {
      generatedAt: 1_756_300_000,
      events: [
        {
          id: 'div-2026-08-28-1',
          status: 'active',
        severity: 'road',
          startedAt: 1_756_290_000,
          lastEvidenceAt: 1_756_299_000,
          routes: ['133', '45'],
          vehicles: 3,
          longRunning: false,
          centroid: [-0.1, 51.5],
          segments: [
            [
              [-0.1, 51.5],
              [-0.1, 51.51],
            ],
          ],
          tfl: { loc: 'HIGH ROAD closed', dist: 80 },
        },
      ],
    };
    const detector: DiversionDetector = {
      record: () => {},
      snapshot: () => Promise.resolve(payload),
      stop: () => {},
    };
    app = Fastify();
    registerDiversionsRoute(app, () => detector);

    const res = await app.inject({ method: 'GET', url: '/api/diversions' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=60');
    expect(res.json()).toEqual(payload);
  });

  it('serves a detector that starts AFTER route registration (fresh-volume start)', async () => {
    // On a fresh volume app.ts starts the detector from a retry timer long
    // after the route registers — the getter must observe that late start.
    const payload: DiversionsPayload = { generatedAt: 1_756_300_000, events: [] };
    let detector: DiversionDetector | null = null;
    app = Fastify();
    registerDiversionsRoute(app, () => detector);

    const before = await app.inject({ method: 'GET', url: '/api/diversions' });
    expect((before.json() as DiversionsPayload).events).toEqual([]);

    detector = {
      record: () => {},
      snapshot: () => Promise.resolve(payload),
      stop: () => {},
    };
    const after = await app.inject({ method: 'GET', url: '/api/diversions' });
    expect(after.json()).toEqual(payload);
  });
});
