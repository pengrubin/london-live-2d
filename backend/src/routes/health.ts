import type { FastifyInstance } from 'fastify';

const BYTES_PER_MB = 1024 * 1024;
const mb = (bytes: number): number => Math.round(bytes / BYTES_PER_MB);

export function registerHealthRoute(app: FastifyInstance): void {
  app.get('/health', async () => {
    const usage = process.memoryUsage();
    return {
      status: 'ok',
      uptimeS: Math.round(process.uptime()),
      // Railway bills memory as an integral over time, so RSS is the number
      // that costs money: it includes what V8 has grown into and not returned
      // to the OS after a peak. heapUsed alone hides exactly that.
      memory: {
        rssMB: mb(usage.rss),
        heapUsedMB: mb(usage.heapUsed),
        heapTotalMB: mb(usage.heapTotal),
        externalMB: mb(usage.external),
      },
    };
  });
}
