// GET /api/disruptions — the structured tier of the disruption map
// (docs/DISRUPTION_GEOLOCATION_SPEC.md §3.1, §4). One fixed cache key, one
// 60 s TTL, one single-flighted upstream call for every viewer: the 500+ KB
// window body is fetched, resolved into ~30 KB of ids and sentences, and only
// the resolved payload is ever cached or sent. The raw body is dropped inside
// the closure — it is the largest transient in the process and none of it,
// least of all the app key TfL echoes in its error bodies, may reach a browser.
import type { FastifyInstance } from 'fastify';
import { registerProxyRoute, type ProxyDeps } from './proxy-route';
import { resolveSnapshot, type DisruptionItem, type ResolveContext } from '../disruptions/resolver';
import { compactStatus } from '../disruptions/tfl-status-shape';
import { londonDay, MS_PER_DAY } from '../shared/london-date';
import { fetchLineStatusWindow, type TflResponse } from '../tfl-client';

/** Status changes slowly and every viewer shares this one key. */
export const DISRUPTIONS_TTL_MS = 60_000;
/**
 * Oldest payload the route may serve when TfL is failing. A suspension that
 * has been lifted must stop being drawn, so staleness is bounded here as well
 * as in the browser — TfL's own `toDate` cannot say it (§13.1: a RealTime
 * toDate is a rolling now+2–3 h stamp).
 */
export const DISRUPTIONS_MAX_STALE_MS = 10 * 60_000;

const WINDOW_LOOKBACK_DAYS = 1;
const WINDOW_LOOKAHEAD_DAYS = 7;
const MS_PER_SECOND = 1_000;
const HTTP_OK = 200;
/** No parsed tier exists in this phase, so parsed sections are never enabled. */
const PARSED_SECTIONS_DISABLED = 0;

/** The §4 body. `notices` and `nr` belong to later tiers and are not sent yet. */
export interface DisruptionsPayload {
  /** Unix seconds when the upstream body was fetched (server clock). */
  readonly t: number;
  /** The requested window [from, to] as Europe/London dates. */
  readonly w: readonly [string, string];
  readonly pf: 0;
  readonly items: readonly DisruptionItem[];
}

/** `/health` counters, named as app.ts reports them. */
export interface DisruptionsCounters {
  readonly disruptionsItems: number;
  readonly disruptionsSections: number;
  readonly disruptionsStops: number;
  /** Route slices refused by the hop gate — bake/feed drift on a corridor. */
  readonly disruptionsSectionsDropped: number;
  /** affectedStops ids refused by the id gate — bake/feed drift on a station. */
  readonly disruptionsStopsDropped: number;
  /** Lines or status entries the shaping step could not read at all. */
  readonly disruptionsLinesDropped: number;
  readonly disruptionsLastParseMs: number;
}

export interface DisruptionsContext {
  /** The rail lines to ask about — the manifest's, never a hard-coded list. */
  readonly lineIds: readonly string[];
  readonly resolve: ResolveContext;
  /** Injection point for tests; production uses the real window call. */
  readonly fetchWindow?: (
    lineIds: readonly string[],
    fromDate: string,
    toDate: string,
    appKey: string,
  ) => Promise<TflResponse>;
}

const ZERO_COUNTERS: DisruptionsCounters = {
  disruptionsItems: 0,
  disruptionsSections: 0,
  disruptionsStops: 0,
  disruptionsSectionsDropped: 0,
  disruptionsStopsDropped: 0,
  disruptionsLinesDropped: 0,
  disruptionsLastParseMs: 0,
};

/** [yesterday, today+7] in Europe/London days — TfL's window is date-based. */
function disruptionWindow(nowMs: number): readonly [string, string] {
  return [
    londonDay(new Date(nowMs - WINDOW_LOOKBACK_DAYS * MS_PER_DAY)),
    londonDay(new Date(nowMs + WINDOW_LOOKAHEAD_DAYS * MS_PER_DAY)),
  ];
}

/**
 * Registers the route and returns its `/health` counters getter. The counters
 * come from the last resolve, so they answer "what is this cache entry made
 * of" — items, sections and, most importantly, sections REFUSED, which is the
 * number that turns a silent bake/feed drift into something visible.
 */
export function registerDisruptionsRoute(
  app: FastifyInstance,
  deps: ProxyDeps,
  ctx: DisruptionsContext,
): () => DisruptionsCounters {
  const now = deps.now ?? Date.now;
  const fetchWindow = ctx.fetchWindow ?? fetchLineStatusWindow;
  let counters = ZERO_COUNTERS;
  let fetched = { w: disruptionWindow(now()), t: Math.floor(now() / MS_PER_SECOND) };

  if (ctx.lineIds.length === 0) {
    app.log.info('disruptions: no baked rail lines, route not registered');
    return () => counters;
  }

  /**
   * A non-200 is a THROW, never a returned response: only a throw reaches the
   * stale path, and forwarding the body would echo the app key TfL puts in
   * `ApiError.relativeUri` (measured, §13.1 R16). The status alone is logged.
   */
  const fetchTfl = async (_key: string, appKey: string): Promise<TflResponse> => {
    const at = now();
    const w = disruptionWindow(at);
    const response = await fetchWindow(ctx.lineIds, w[0], w[1], appKey);
    if (response.status !== HTTP_OK) {
      throw new Error(`TfL line status window returned ${response.status}`);
    }
    fetched = { w, t: Math.floor(at / MS_PER_SECOND) };
    return response;
  };

  const shape = (body: unknown): DisruptionsPayload => {
    const startedAt = now();
    // A whole-body failure throws below, but ONE line losing its statuses in a
    // 200 body would otherwise be invisible: the map would say "no disruption"
    // on that line during an incident. Every such drop is logged and counted.
    let linesDropped = 0;
    const snapshot = compactStatus(body, (reason) => {
      linesDropped += 1;
      ctx.resolve.log(`disruptions: unreadable upstream entry, ${reason}`);
    });
    // An unparseable body must not become an empty "all clear" map: throwing
    // keeps the last good payload on screen until it ages out.
    if (snapshot === null) throw new Error('TfL line status body was not a line array');
    // The payload's own instant, not the wall clock a listener reads it at:
    // whether a window is in force must be decided against the moment this
    // body describes, so a cached payload cannot drift into claiming
    // otherwise.
    const { items, stats } = resolveSnapshot(snapshot, ctx.resolve, fetched.t * MS_PER_SECOND);
    counters = {
      disruptionsItems: stats.items,
      disruptionsSections: stats.sections,
      disruptionsStops: stats.stops,
      disruptionsSectionsDropped: stats.sectionsDropped,
      disruptionsStopsDropped: stats.stopsDropped,
      disruptionsLinesDropped: linesDropped,
      disruptionsLastParseMs: now() - startedAt,
    };
    return { t: fetched.t, w: fetched.w, pf: PARSED_SECTIONS_DISABLED, items };
  };

  registerProxyRoute(app, deps, {
    path: '/api/disruptions',
    shape,
    maxStaleMs: DISRUPTIONS_MAX_STALE_MS,
    fetchTfl,
  });

  return () => counters;
}
