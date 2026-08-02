// Non-TfL upstream proxies: ADS-B aircraft, adsbdb callsign lookups, plus the
// TfL JamCam list. All go through the shared proxy factory; aircraft/adsbdb
// carry their own budgets so they can never eat into the TfL allowance.

import type { FastifyInstance } from 'fastify';
import type { TflResponse } from '../tfl-client';
import { UPSTREAM_TIMEOUT_MS, TFL_BASE_URL } from '../constants';
import type { Bbox, CirclePoint } from '../region';
import { registerProxyRoute, singleParamKey, type ProxyDeps } from './proxy-route';

const CALLSIGN_PATTERN = /^[A-Za-z0-9-]{2,10}$/;

/** Both ADS-B networks take the same /point/{lat}/{lon}/{radiusNm} path shape. */
function adsbUrls(point: CirclePoint): { primary: string; fallback: string } {
  const path = `v2/point/${point.lat}/${point.lon}/${point.radiusNm}`;
  return {
    // Primary carries aircraft descriptions inline; fallback is the same network.
    primary: `https://api.airplanes.live/${path}`,
    fallback: `https://api.adsb.lol/${path}`,
  };
}

async function fetchJson(url: string): Promise<TflResponse> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    headers: { accept: 'application/json' },
  });
  const body: unknown = await response.json();
  return { status: response.status, body };
}

async function fetchAircraft(point: CirclePoint): Promise<TflResponse> {
  const { primary: primaryUrl, fallback } = adsbUrls(point);
  try {
    const primary = await fetchJson(primaryUrl);
    if (primary.status === 200) return primary;
  } catch {
    // fall through to the mirror
  }
  return fetchJson(fallback);
}

/** Live aircraft over the region's centre point: GET /api/aircraft (no params). */
export function registerAircraftRoute(app: FastifyInstance, deps: ProxyDeps): void {
  const { adsb } = deps.config.region;
  registerProxyRoute(app, deps, {
    path: '/api/aircraft',
    fetchUpstream: () => fetchAircraft(adsb),
  });
}

/** Route/airline info for a callsign: GET /api/callsign?cs=BAW123. */
export function registerCallsignRoute(app: FastifyInstance, deps: ProxyDeps): void {
  registerProxyRoute(app, deps, {
    path: '/api/callsign',
    parseKey: singleParamKey('cs', CALLSIGN_PATTERN),
    fetchUpstream: (cs) => fetchJson(`https://api.adsbdb.com/v0/callsign/${cs}`),
  });
}

const CRS_PATTERN = /^[A-Za-z]{3}$/;

/** National Rail departure board: GET /api/nr-board?crs=CLJ. 503 until a
 * DARWIN_TOKEN is configured. */
export function registerNrBoardRoute(app: FastifyInstance, deps: ProxyDeps): void {
  const token = deps.config.darwinToken;
  if (!token) {
    app.get('/api/nr-board', async (_req, reply) =>
      reply.code(503).send({ error: 'DARWIN_TOKEN not configured' }),
    );
    return;
  }
  registerProxyRoute(app, deps, {
    path: '/api/nr-board',
    parseKey: singleParamKey('crs', CRS_PATTERN),
    fetchUpstream: async (crs) => {
      const { fetchNrBoard } = await import('../darwin-client');
      return fetchNrBoard(crs.toUpperCase(), token);
    },
  });
}

/** TfL traffic-camera list: GET /api/jamcams (no params; images come from S3). */
export function registerJamCamsRoute(app: FastifyInstance, deps: ProxyDeps): void {
  registerProxyRoute(app, deps, {
    path: '/api/jamcams',
    fetchTfl: (_value, appKey) => {
      const url = new URL('/Place/Type/JamCam', TFL_BASE_URL);
      url.searchParams.set('app_key', appKey);
      return fetchJson(url.toString());
    },
  });
}

/** Tide gauges (Environment Agency): GET /api/tide-gauges (no params).
 * Returns [{ref,label,lat,lon,levelM,readingAt,trend}] — see ea-tides.ts.
 * The EA publishes English stations only, so a region outside England serves an
 * empty list rather than calling an upstream that can have nothing for it. */
export function registerTideGaugesRoute(app: FastifyInstance, deps: ProxyDeps): void {
  const { region } = deps.config;
  if (!region.tideGauges) {
    app.get('/api/tide-gauges', () => []);
    return;
  }
  const bbox: Bbox = region.bbox;
  registerProxyRoute(app, deps, {
    path: '/api/tide-gauges',
    fetchUpstream: async () => {
      const { fetchTideGauges } = await import('../ea-tides');
      return { status: 200, body: await fetchTideGauges(bbox) };
    },
  });
}


/** TfL road disruptions (roadworks, closures …): GET /api/road-disruptions. */
export function registerRoadDisruptionsRoute(app: FastifyInstance, deps: ProxyDeps): void {
  registerProxyRoute(app, deps, {
    path: '/api/road-disruptions',
    fetchTfl: (_value, appKey) => {
      const url = new URL('/Road/all/Disruption', TFL_BASE_URL);
      url.searchParams.set('stripContent', 'false');
      url.searchParams.set('app_key', appKey);
      return fetchJson(url.toString());
    },
  });
}
