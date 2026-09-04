// GET /api/bus-stop-closures — the bus stops closed right now.
//
// `/StopPoint/Mode/bus/Disruption` is the only feed that names them, and until
// this route it had no production caller at all. It is 121 KB of rows carrying
// no coordinate and no route list, so the round trip is: fetch the feed →
// resolve every in-force pole through the permanent gazetteer (network only
// for ids nobody has ever resolved) → shape into pins → cache the pins.
//
// Two properties matter more than anything else here:
//   * the raw body never leaves this closure. TfL echoes the request URI —
//     app key and all — inside its error bodies, so a non-200 is a THROW, not
//     a forwarded response, and the shaped payload carries only listed fields.
//   * only closures IN FORCE at the fetch instant are shaped, judged against
//     the server clock rather than the browser's. See bus-stop-closures.ts for
//     the map that hatched a running line closed when this was got wrong.
import type { FastifyInstance } from 'fastify';
import { registerProxyRoute, type ProxyDeps } from './proxy-route';
import {
  liveClosureIds,
  shapeClosures,
  type ClosureStop,
} from '../disruptions/bus-stop-closures';
import { resolveStops, type BusStop } from '../disruptions/bus-stop-gazetteer';
import { fetchStopPointDisruptions, fetchStopPoints, type TflResponse } from '../tfl-client';

/** The closure feed changes over days, not minutes; every viewer shares one key. */
export const BUS_STOP_CLOSURES_TTL_MS = 600_000;

/** How long past its TTL a payload may still be served while TfL is failing. */
const STALE_GRACE_MS = 10 * 60_000;

/**
 * Oldest payload the route may serve, measured from the fetch — `getStale`
 * bounds TOTAL age, so this has to be TTL + grace. Setting it to the grace
 * alone would make the whole stale path unreachable: an entry first goes stale
 * at exactly the TTL, which is already the bound, and a single TfL blip would
 * empty the closure map for every viewer instead of holding the last picture.
 *
 * Bounded rather than open-ended because a lifted closure must stop being
 * drawn and nothing in a cached body can say that it was lifted. The payload's
 * `t` is the fetch instant, so a viewer can always see how old the picture is.
 */
export const BUS_STOP_CLOSURES_MAX_STALE_MS = BUS_STOP_CLOSURES_TTL_MS + STALE_GRACE_MS;

/** Measured 2026-09-04: 121 KB in the feed, so the 8 s default is tight. */
const UPSTREAM_TIMEOUT_MS = 20_000;

const BUS_MODE = 'bus';
const MS_PER_SECOND = 1_000;
const HTTP_OK = 200;
const MAX_REASON_CHARS = 160;

/** The whole body. Nothing upstream is passed through — see the route test. */
export interface BusStopClosuresPayload {
  /** Unix seconds when the upstream body was fetched (server clock). */
  readonly t: number;
  readonly stops: readonly ClosureStop[];
}

/** `/health` counters, named as app.ts reports them. */
export interface BusStopClosuresCounters {
  readonly busStopClosuresStops: number;
  /** Rows too malformed to read — no id, or a window that will not parse. */
  readonly busStopClosuresDropped: number;
  /** In-force poles with no position, so nothing honest could be drawn. */
  readonly busStopClosuresUnresolved: number;
  /**
   * Rows correctly filtered because their window does not cover now. Reported
   * because it is the number the "in force only" decision rests on: if it ever
   * reads zero, or nearly everything, the window test has stopped working.
   */
  readonly busStopClosuresNotInForce: number;
  readonly busStopClosuresLastShapeMs: number;
}

export interface BusStopClosuresContext {
  /** Ids already positioned; grows as new poles are resolved. */
  readonly gazetteer: ReadonlyMap<string, BusStop>;
  readonly log: (message: string) => void;
  /** Persists newly resolved poles. Omitted leaves the top-up in memory only. */
  readonly saveGazetteer?: (stops: ReadonlyMap<string, BusStop>) => Promise<void>;
  /** Injection points for tests; production uses the real TfL calls. */
  readonly fetchFeed?: (appKey: string) => Promise<TflResponse>;
  readonly fetchStopPoints?: (ids: readonly string[], appKey: string) => Promise<TflResponse>;
  readonly sleep?: (ms: number) => Promise<void>;
}

const ZERO_COUNTERS: BusStopClosuresCounters = {
  busStopClosuresStops: 0,
  busStopClosuresDropped: 0,
  busStopClosuresUnresolved: 0,
  busStopClosuresNotInForce: 0,
  busStopClosuresLastShapeMs: 0,
};

/**
 * Registers the route and returns its `/health` counters getter. The counters
 * describe the last shaped payload: what is drawn, what was filtered as not in
 * force, and what was dropped — the two numbers that turn a silently thinning
 * closure map into something visible.
 */
export function registerBusStopClosuresRoute(
  app: FastifyInstance,
  deps: ProxyDeps,
  ctx: BusStopClosuresContext,
): () => BusStopClosuresCounters {
  const now = deps.now ?? Date.now;
  const fetchFeed =
    ctx.fetchFeed ?? ((appKey) => fetchStopPointDisruptions([BUS_MODE], appKey, UPSTREAM_TIMEOUT_MS));
  const fetchPoints =
    ctx.fetchStopPoints ?? ((ids, appKey) => fetchStopPoints(ids, appKey, UPSTREAM_TIMEOUT_MS));

  let gazetteer = ctx.gazetteer;
  let counters = ZERO_COUNTERS;
  let fetchedAtMs = now();

  /**
   * Resolve the poles this feed names that nobody has resolved before, and
   * keep them: a stop's position never changes. Only IN-FORCE ids are looked
   * up — resolving a closure that starts next week spends calls on a pin the
   * overlay is forbidden to draw.
   */
  const topUpGazetteer = async (body: unknown, appKey: string, atMs: number): Promise<void> => {
    const missing = liveClosureIds(body, atMs).filter((id) => !gazetteer.has(id));
    if (missing.length === 0) return;

    const result = await resolveStops(missing, {
      fetchStopPoints: (ids) => fetchPoints(ids, appKey),
      log: ctx.log,
      cached: gazetteer,
      ...(ctx.sleep === undefined ? {} : { sleep: ctx.sleep }),
    });
    ctx.log(
      `bus-stop-closures: ${missing.length} new pole(s), ${result.resolved.size} resolved, ${result.unresolved.length} not`,
    );
    if (result.resolved.size === 0) return;

    gazetteer = new Map([...gazetteer, ...result.resolved]);
    await persistGazetteer();
  };

  /** A read-only data directory must cost the log a line, never the viewer the layer. */
  const persistGazetteer = async (): Promise<void> => {
    if (ctx.saveGazetteer === undefined) return;
    try {
      await ctx.saveGazetteer(gazetteer);
    } catch (error) {
      ctx.log(`bus-stop-closures: gazetteer cache not written — ${describe(error)}`);
    }
  };

  /**
   * A non-200 is a THROW, never a returned response: only a throw reaches the
   * stale path, and forwarding the body would echo the app key TfL puts in its
   * error text. The status alone is named.
   */
  const fetchTfl = async (_key: string, appKey: string): Promise<TflResponse> => {
    const at = now();
    const response = await fetchFeed(appKey);
    if (response.status !== HTTP_OK) {
      throw new Error(`TfL bus stop disruption feed returned ${response.status}`);
    }
    fetchedAtMs = at;
    await topUpGazetteer(response.body, appKey, at);
    return response;
  };

  // Shaped against the FETCH instant, the same one the payload's `t` reports
  // and the same one the gazetteer top-up used, so the ids resolved and the
  // rows drawn can never disagree about what "now" meant.
  const shape = (body: unknown): BusStopClosuresPayload => {
    const startedAt = now();
    const { stops, stats } = shapeClosures(body, gazetteer, fetchedAtMs, (reason) =>
      ctx.log(`bus-stop-closures: ${reason}`),
    );
    counters = {
      busStopClosuresStops: stats.stops,
      busStopClosuresDropped: stats.dropped,
      busStopClosuresUnresolved: stats.unresolved,
      busStopClosuresNotInForce: stats.notInForce,
      busStopClosuresLastShapeMs: now() - startedAt,
    };
    ctx.log(
      `bus-stop-closures: ${stats.rows} rows → ${stats.stops} stops in force (${stats.notInForce} outside their window, ${stats.dropped} unreadable, ${stats.unresolved} unpositioned)`,
    );
    return { t: Math.floor(fetchedAtMs / MS_PER_SECOND), stops };
  };

  registerProxyRoute(app, deps, {
    path: '/api/bus-stop-closures',
    shape,
    maxStaleMs: BUS_STOP_CLOSURES_MAX_STALE_MS,
    fetchTfl,
  });

  return () => counters;
}

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, MAX_REASON_CHARS);
}
