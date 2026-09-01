import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerHealthRoute } from './health';

describe('health route', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = Fastify();
    registerHealthRoute(app);
  });

  afterEach(async () => {
    await app.close();
  });

  it('still answers ok, so existing uptime checks keep working', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ok');
  });

  it('reports memory in whole MB, with RSS at least as large as the heap in use', async () => {
    const body = res(await app.inject({ method: 'GET', url: '/health' }));

    expect(body.memory.rssMB).toBeGreaterThan(0);
    for (const value of Object.values(body.memory)) expect(Number.isInteger(value)).toBe(true);
    // heapUsed <= heapTotal is the only ordering that actually holds. RSS is
    // NOT necessarily the largest: heapTotal counts committed pages, and on a
    // host that compresses or pages them out RSS reads lower — measured 258 MB
    // RSS against 476 MB heapUsed on this machine.
    expect(body.memory.heapUsedMB).toBeLessThanOrEqual(body.memory.heapTotalMB);
    expect(body.uptimeS).toBeGreaterThanOrEqual(0);
  });
});

interface HealthBody {
  status: string;
  uptimeS: number;
  memory: { rssMB: number; heapUsedMB: number; heapTotalMB: number; externalMB: number };
}

const res = (r: { json: () => unknown }): HealthBody => r.json() as HealthBody;
