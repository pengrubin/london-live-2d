import { buildApp } from './app';
import { loadConfig } from './config';
import {
  ARRIVALS_CACHE_TTL_MS,
  TFL_BUDGET_LIMIT,
  TFL_BUDGET_WINDOW_MS,
} from './constants';

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await buildApp(config);

  await app.listen({ port: config.port, host: '0.0.0.0' });

  // Structured startup summary — never log TFL_APP_KEY.
  app.log.info(
    {
      port: config.port,
      corsOrigin: config.corsOrigin,
      cacheTtlMs: ARRIVALS_CACHE_TTL_MS,
      tflBudget: { limit: TFL_BUDGET_LIMIT, windowMs: TFL_BUDGET_WINDOW_MS },
    },
    'london-live-2d backend ready',
  );
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Fatal: ${message}`);
  process.exit(1);
});
