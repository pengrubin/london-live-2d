import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { AisClient } from './ais-client';
import { BodsClient } from './bods-client';
import { TtlCache } from './cache';
import type { AppConfig } from './config';
import { ARRIVALS_CACHE_TTL_MS, TFL_BUDGET_LIMIT, TFL_BUDGET_WINDOW_MS } from './constants';
import {
  LeaderboardTracker,
  loadBranchData,
  makeCachedArrivalsFetcher,
  registerLeaderboardRoute,
} from './leaderboard';
import { LearnerScheduler } from './learner-scheduler';
import { loadNrGraph, makeCachedNrBoardFetcher, NrSampler } from './nr-sampler';
import { RateBudget } from './rate-budget';
import { TraceWriter } from './trace-writer';
import { registerArrivalsRoute } from './routes/arrivals';
import { registerHealthRoute } from './routes/health';
import {
  registerBikePointsRoute,
  registerCrowdingRoute,
  registerLiftDisruptionsRoute,
  registerLineStatusRoute,
  registerStopArrivalsRoute,
  registerStopDetailRoute,
  registerVehicleArrivalsRoute,
} from './routes/stop-arrivals';
import {
  registerAircraftRoute,
  registerCallsignRoute,
  registerJamCamsRoute,
  registerNrBoardRoute,
  registerRoadDisruptionsRoute,
  registerTideGaugesRoute,
} from './routes/external';
import { registerAircraftPhotoRoute } from './routes/aircraft-photo';
import { registerBusRoutesRoute } from './routes/bus-routes';
import { registerShipPhotoRoute } from './routes/ship-photo';

/** Repo layout anchors — data/ and scripts/ sit beside backend/. */
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DATA_DIR = join(REPO_ROOT, 'data');
const SCRIPTS_DIR = join(REPO_ROOT, 'scripts');

/** Builds the Fastify app with all plugins and routes; exported for tests (inject()). */
export async function buildApp(config: AppConfig): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  // CORS_ORIGIN may be a single origin or a comma-separated list.
  const corsOrigins = config.corsOrigin
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  await app.register(cors, {
    origin: corsOrigins.length > 1 ? corsOrigins : config.corsOrigin,
  });

  // Live vessel names (optional feature — needs an aisstream.io key in .env)
  let aisClient: AisClient | null = null;
  if (config.aisApiKey) {
    const ais = new AisClient(config.aisApiKey, (msg) => app.log.info(msg));
    ais.start();
    app.addHook('onClose', () => ais.stop());
    app.get('/api/vessels', () => ais.list());
    aisClient = ais;
  } else {
    app.get('/api/vessels', () => []);
  }

  // All-London live buses (optional feature — needs a BODS key in .env)
  let bodsClient: BodsClient | null = null;
  if (config.bodsApiKey) {
    // Trace log + self-scheduled route learner ride along with the poller.
    // NB: bus-traces/ and bus-routes/learned/ are runtime-written but large, so
    // they still live under data/ for now — a later step could move them to
    // PERSIST_DIR (like leaderboard.json + the learner marker already do).
    const traces = new TraceWriter(join(DATA_DIR, 'bus-traces'), (msg) => app.log.info(msg));
    traces.start();
    const bods = new BodsClient(
      config.bodsApiKey,
      (msg) => app.log.info(msg),
      (buses, now) => traces.record(buses, now),
    );
    bods.start();
    const learner = new LearnerScheduler(SCRIPTS_DIR, DATA_DIR, (msg) => app.log.info(msg));
    learner.start();
    app.addHook('onClose', () => {
      bods.stop();
      traces.stop();
      learner.stop();
    });
    app.get('/api/buses', () => bods.list());
    bodsClient = bods;
  } else {
    app.get('/api/buses', () => []);
  }
  registerBusRoutesRoute(app, join(DATA_DIR, 'bus-routes', 'learned'));

  const LINE_STATUS_TTL_MS = 60_000; // status changes slowly; poll gently
  const STOP_DETAIL_TTL_MS = 600_000; // facilities/zones are near-static
  const CROWDING_TTL_MS = 60_000; // live crowding updates every minute
  const LIFT_DISRUPTIONS_TTL_MS = 300_000; // network-wide list; changes rarely
  const BIKE_POINTS_TTL_MS = 60_000; // dock occupancy drifts by the minute

  const arrivalsCache = new TtlCache<unknown>(ARRIVALS_CACHE_TTL_MS);
  const stopArrivalsCache = new TtlCache<unknown>(ARRIVALS_CACHE_TTL_MS);
  const vehicleArrivalsCache = new TtlCache<unknown>(ARRIVALS_CACHE_TTL_MS);
  const lineStatusCache = new TtlCache<unknown>(LINE_STATUS_TTL_MS);
  const stopDetailCache = new TtlCache<unknown>(STOP_DETAIL_TTL_MS);
  const crowdingCache = new TtlCache<unknown>(CROWDING_TTL_MS);
  const liftDisruptionsCache = new TtlCache<unknown>(LIFT_DISRUPTIONS_TTL_MS);
  const bikePointsCache = new TtlCache<unknown>(BIKE_POINTS_TTL_MS);
  const tflBudget = new RateBudget(TFL_BUDGET_LIMIT, TFL_BUDGET_WINDOW_MS);

  registerHealthRoute(app);
  registerArrivalsRoute(app, { config, cache: arrivalsCache, budget: tflBudget });
  registerStopArrivalsRoute(app, { config, cache: stopArrivalsCache, budget: tflBudget });
  registerVehicleArrivalsRoute(app, { config, cache: vehicleArrivalsCache, budget: tflBudget });
  registerLineStatusRoute(app, { config, cache: lineStatusCache, budget: tflBudget });
  registerStopDetailRoute(app, { config, cache: stopDetailCache, budget: tflBudget });
  registerCrowdingRoute(app, { config, cache: crowdingCache, budget: tflBudget });
  registerLiftDisruptionsRoute(app, { config, cache: liftDisruptionsCache, budget: tflBudget });
  registerBikePointsRoute(app, { config, cache: bikePointsCache, budget: tflBudget });

  // ── vehicle distance leaderboard ──
  // Tube positions come from the SAME arrivals cache + TfL budget as
  // /api/arrivals (identical cache key), so the sampler piggybacks on frontend
  // polling and never double-spends the budget.
  const log = (msg: string): void => app.log.info(msg);
  const branchData = loadBranchData(DATA_DIR, log);

  // National Rail boards — Darwin fair use is generous, but boards are heavy:
  // long-ish cache and a dedicated budget keep us a polite consumer. The cache
  // and budget are shared between /api/nr-board and the leaderboard's NR
  // sampler (identical cache key: the CRS), so NR ranking never double-spends.
  const NR_BOARD_TTL_MS = 45_000;
  const nrBoardCache = new TtlCache<unknown>(NR_BOARD_TTL_MS);
  const darwinBudget = new RateBudget(40, 60_000);

  // NR trains rank alongside tube in the "train" mode; off without a token.
  let nrSampler: NrSampler | null = null;
  if (config.darwinToken) {
    const nrGraph = loadNrGraph(DATA_DIR, log);
    if (nrGraph) {
      nrSampler = new NrSampler(
        nrGraph,
        makeCachedNrBoardFetcher({ config, cache: nrBoardCache, budget: darwinBudget, log }),
      );
    }
  }

  const leaderboard = new LeaderboardTracker({
    log,
    getBuses: () => bodsClient?.list() ?? [],
    getVessels: () => aisClient?.list() ?? [],
    fetchTubePredictions: makeCachedArrivalsFetcher({
      config,
      cache: arrivalsCache,
      budget: tflBudget,
      lineIds: branchData.lineIds,
      log,
    }),
    branchesByLine: branchData.branchesByLine,
    lineNameById: branchData.lineNameById,
    nrSampler,
  });
  leaderboard.start();
  app.addHook('onClose', () => leaderboard.stop());
  registerLeaderboardRoute(app, leaderboard);
  // Persistence diagnostic (no secrets — path + booleans only).
  app.get('/api/leaderboard-status', () => leaderboard.persistenceStatus());

  // Non-TfL upstreams get their own budgets — they must never starve TfL calls.
  const AIRCRAFT_TTL_MS = 4_000; // planes are fast; keep the picture fresh
  const CALLSIGN_TTL_MS = 3_600_000; // routes/airlines are static per callsign
  const JAMCAMS_TTL_MS = 600_000; // camera list changes rarely
  const adsbBudget = new RateBudget(60, 60_000);
  const adsbdbBudget = new RateBudget(30, 60_000);
  registerAircraftRoute(app, { config, cache: new TtlCache(AIRCRAFT_TTL_MS), budget: adsbBudget });
  registerCallsignRoute(app, { config, cache: new TtlCache(CALLSIGN_TTL_MS), budget: adsbdbBudget });
  registerJamCamsRoute(app, { config, cache: new TtlCache(JAMCAMS_TTL_MS), budget: tflBudget });

  // Ship photos (VesselFinder scrape) — own budget + 24 h cache inside.
  registerShipPhotoRoute(app);

  // Aircraft photos (Planespotters public API) — own budget + 24 h cache inside.
  registerAircraftPhotoRoute(app);

  // Thames tide gauges — Environment Agency upstream, NOT TfL, so it gets its
  // own budget. EA publishes every 15 min; a 5-min cache keeps us polite.
  const TIDE_GAUGES_TTL_MS = 300_000;
  const eaBudget = new RateBudget(10, 60_000);
  registerTideGaugesRoute(app, {
    config,
    cache: new TtlCache(TIDE_GAUGES_TTL_MS),
    budget: eaBudget,
  });

  // Shared e-bikes/e-scooters — GBFS operator feeds, NOT TfL, so they get
  // their own budget. Feeds refresh roughly every minute; 60 s cache matches.
  const MICROMOBILITY_TTL_MS = 60_000;
  // Road disruptions are a TfL feed — they share the TfL budget.
  const ROAD_DISRUPTIONS_TTL_MS = 120_000; // roadworks list drifts slowly
  registerRoadDisruptionsRoute(app, {
    config,
    cache: new TtlCache(ROAD_DISRUPTIONS_TTL_MS),
    budget: tflBudget,
  });

  // National Rail boards share nrBoardCache + darwinBudget with the
  // leaderboard's NR sampler (declared above, before the tracker wiring).
  registerNrBoardRoute(app, { config, cache: nrBoardCache, budget: darwinBudget });

  // ── production static serving ──
  // Single-service deploy (Railway): the backend serves the built frontend
  // plus the baked JSON in data/ — mirroring Vite's publicDir so the
  // frontend's relative fetches (/manifest.json, /lines/…, /stations/…,
  // /branches/…, /nr/…, /bus-routes/learned/…) work identically in prod.
  // Registered AFTER all API routes: explicit /api/* routes always win over
  // the static wildcard. Guarded so local dev (frontend/dist absent or
  // NODE_ENV unset) is unchanged. The 136 MB london.pmtiles is NOT served
  // from here in prod — the frontend points at R2 via VITE_PMTILES_URL.
  const FRONTEND_DIST = join(REPO_ROOT, 'frontend', 'dist');
  if (process.env.NODE_ENV === 'production' && existsSync(FRONTEND_DIST)) {
    await app.register(fastifyStatic, {
      // First matching root wins: built assets first, then baked data.
      root: [FRONTEND_DIST, DATA_DIR],
    });
    app.log.info({ roots: [FRONTEND_DIST, DATA_DIR] }, 'static serving enabled');
  }

  return app;
}
