import type { FastifyInstance } from 'fastify';

const BYTES_PER_MB = 1024 * 1024;
const mb = (bytes: number): number => Math.round(bytes / BYTES_PER_MB);

/**
 * `components` reports live map/cache sizes. Memory alone says the process is
 * growing; it cannot say which structure is doing the growing, which is the
 * question that actually leads to a fix.
 */
export function registerHealthRoute(
  app: FastifyInstance,
  components: () => Record<string, number> = () => ({}),
): void {
  app.get('/health', async () => {
    const usage = process.memoryUsage();
    return {
      status: 'ok',
      uptimeS: Math.round(process.uptime()),
      components: components(),
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
