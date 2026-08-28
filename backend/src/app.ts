import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { constants as zlibConstants } from 'node:zlib';
import compress from '@fastify/compress';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { AisClient } from './ais-client';
import { BodsClient } from './bods-client';
import { GbfsClient } from './gbfs-client';
import { TtlCache } from './cache';
import { type AppConfig, resolveBusDataDir } from './config';
import { startCoverageWriter } from './coverage-writer';
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
import { RollupWriter } from './rollup-writer';
import { TubeStatusRecorder } from './tube-status-recorder';
import { TraceWriter } from './trace-writer';
import { registerArrivalsRoute } from './routes/arrivals';
import { registerCapabilitiesRoute } from './routes/capabilities';
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
import { registerCoverageRoute } from './routes/coverage';
import { registerDataExportRoute } from './routes/data-export';
import { registerShipPhotoRoute } from './routes/ship-photo';

/** Repo layout anchors — data/ and scripts/ sit beside backend/. */
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCRIPTS_DIR = join(REPO_ROOT, 'scripts');

/**
 * Baked, git-committed, read-only data for THIS region: manifest, line
 * geometry, station points, and (where a live train pipeline exists) branches.
 * Served at the same root-relative URLs in every deployment, so a second region
 * points this elsewhere and the frontend needs no change at all.
 *
 * Deliberately NOT the same thing as config.ts's DATA_DIR, which is the
 * fallback root for runtime-WRITTEN state (leaderboard standings, bus traces,
 * learned routes). That is already isolated per deployment by PERSIST_DIR and
 * must not follow this switch.
 */
function resolveBakedDataDir(): string {
  const configured = process.env['REGION_DATA_DIR']?.trim();
  if (!configured) return join(REPO_ROOT, 'data');
  return isAbsolute(configured) ? configured : join(REPO_ROOT, configured);
}
const DATA_DIR = resolveBakedDataDir();

/** Builds the Fastify app with all plugins and routes; exported for tests (inject()). */
export async function buildApp(config: AppConfig): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  // Registered first so it covers every route AND the static roots. Railway
  // bills egress by the byte and these payloads are pure JSON: /api/arrivals is
  // ~7.4 MB raw vs ~300 KB gzipped (24x), /api/buses ~840 KB raw. Cloudflare
  // already compresses CDN→browser, so this buys nothing for the user — it is
  // purely the origin→CDN leg, which was 86% of the bill while uncompressed.
  //
  // Brotli quality 4 rather than zlib's default 11: q11 burns seconds of CPU on
  // a multi-MB body, and this re-runs on every cache miss. Measured on a 4.97 MB
  // /api/arrivals body — br q4: 154 KB in 15 ms, gzip: 210 KB in 22 ms — so q4
  // is both smaller and faster than gzip here; the CPU worry only applies to q11.
  // Only mime-db "compressible" types are touched, so the pmtiles basemap
  // (application/octet-stream, already compressed internally and served by range
  // request) is left alone.
  const BROTLI_QUALITY = 4;
  await app.register(compress, {
    encodings: ['br', 'gzip', 'deflate'],
    brotliOptions: { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY } },
    // x-ndjson is not in mime-db's compressible set, but the JSONL trace
    // exports compress ~8x — without this each daily archive pull ships
    // ~700 MB of raw egress instead of ~80 MB.
    customTypes: /^application\/x-ndjson$/,
  });

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
    const ais = new AisClient(config.aisApiKey, config.region.aisBbox, (msg) => app.log.info(msg));
    ais.start();
    app.addHook('onClose', () => ais.stop());
    app.get('/api/vessels', () => ais.list());
    aisClient = ais;
  } else {
    app.get('/api/vessels', () => []);
  }

  // One coherent base dir for ALL runtime-written bus data (traces, learned
  // routes, priors): the PERSIST_DIR volume when set (survives redeploys), else
  // data/. Resolved once, with a robust volume→data/ fallback so an unwritable
  // volume degrades instead of crashing. The writer, the learner scripts, and
  // the read route all key off this same base, so the writer always writes where
  // the learner reads and the route serves.
  const busDataDir = resolveBusDataDir((msg) => app.log.warn(msg));

  // All-London live buses (optional feature — needs a BODS key in .env)
  let bodsClient: BodsClient | null = null;
  if (config.bodsApiKey) {
    // Trace log + self-scheduled route learner ride along with the poller.
    const traces = new TraceWriter(join(busDataDir, 'bus-traces'), (msg) => app.log.info(msg));
    traces.start();
    const bods = new BodsClient(
      config.bodsApiKey,
      config.region.bbox,
      (msg) => app.log.info(msg),
      (buses, now) => traces.record(buses, now),
    );
    bods.start();
    const learner = new LearnerScheduler(SCRIPTS_DIR, busDataDir, (msg) => app.log.info(msg));
    learner.start();
    // Daily aggregates outlive the 7-day raw-trace retention window.
    const rollups = new RollupWriter(busDataDir, (msg) => app.log.info(msg));
    rollups.start();
    app.addHook('onClose', () => {
      bods.stop();
      traces.stop();
      learner.stop();
      rollups.stop();
    });
    app.get('/api/buses', () => bods.list());
    bodsClient = bods;
  } else {
    app.get('/api/buses', () => []);
  }
  registerBusRoutesRoute(app, join(busDataDir, 'bus-routes', 'learned'));

  // Coverage flow-map artifact — derived offline from learned routes +
  // rollups already on disk, so unlike the writers above it needs no BODS key:
  // a deployment that lost its credential keeps serving (and re-windowing)
  // the coverage it already earned. Skips itself until inputs exist.
  const coverage = startCoverageWriter(busDataDir, (msg) => app.log.info(msg));
  app.addHook('onClose', () => coverage.stop());
  registerCoverageRoute(app, join(busDataDir, 'coverage'));

  // Permanent line-status archive — TfL publishes no history, so we keep our
  // own from the day this ships. A few MB per year; never pruned.
  if (config.tflAppKey) {
    const tubeStatus = new TubeStatusRecorder(busDataDir, config.tflAppKey, (msg) =>
      app.log.info(msg),
    );
    tubeStatus.start();
    app.addHook('onClose', () => tubeStatus.stop());
  }

  // Token-guarded bulk export of the day-partitioned archives (traces, rollups,
  // tube status) for local analysis. Off unless ADMIN_EXPORT_TOKEN is set.
  if (config.adminExportToken) {
    registerDataExportRoute(app, busDataDir, config.adminExportToken);
  }

  // Docked bike share (optional feature — needs a GBFS discovery URL). GBFS is
  // an open standard, so this is not specific to any city or operator.
  if (config.gbfsUrl) {
    const gbfs = new GbfsClient(config.gbfsUrl, config.region.bbox, (msg) => app.log.info(msg));
    gbfs.start();
    app.addHook('onClose', () => gbfs.stop());
    app.get('/api/bikes', () => gbfs.list());
  } else {
    app.get('/api/bikes', () => []);
  }

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
  registerCapabilitiesRoute(app, config, DATA_DIR, busDataDir);
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
