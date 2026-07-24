// Non-TfL upstream proxies: ADS-B aircraft, adsbdb callsign lookups, plus the
// TfL JamCam list. All go through the shared proxy factory; aircraft/adsbdb
// carry their own budgets so they can never eat into the TfL allowance.

import type { FastifyInstance } from 'fastify';
import type { TflResponse } from '../tfl-client';
import { UPSTREAM_TIMEOUT_MS, TFL_BASE_URL } from '../constants';
import { registerProxyRoute, singleParamKey, type ProxyDeps } from './proxy-route';

/** London centre-point radius query, in nautical miles. */
const ADSB_LAT = 51.5;
const ADSB_LON = -0.12;
const ADSB_RADIUS_NM = 30;
/** Primary carries aircraft descriptions inline; fallback is the same network. */
const ADSB_PRIMARY = `https://api.airplanes.live/v2/point/${ADSB_LAT}/${ADSB_LON}/${ADSB_RADIUS_NM}`;
const ADSB_FALLBACK = `https://api.adsb.lol/v2/point/${ADSB_LAT}/${ADSB_LON}/${ADSB_RADIUS_NM}`;

const CALLSIGN_PATTERN = /^[A-Za-z0-9-]{2,10}$/;

async function fetchJson(url: string): Promise<TflResponse> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    headers: { accept: 'application/json' },
  });
  const body: unknown = await response.json();
  return { status: response.status, body };
}

async function fetchAircraft(): Promise<TflResponse> {
  try {
    const primary = await fetchJson(ADSB_PRIMARY);
    if (primary.status === 200) return primary;
  } catch {
    // fall through to the mirror
  }
  return fetchJson(ADSB_FALLBACK);
}

/** Live aircraft over London: GET /api/aircraft (no params). */
export function registerAircraftRoute(app: FastifyInstance, deps: ProxyDeps): void {
  registerProxyRoute(app, deps, {
    path: '/api/aircraft',
    fetchUpstream: () => fetchAircraft(),
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
    fetchUpstream: (_value, appKey) => {
      const url = new URL('/Place/Type/JamCam', TFL_BASE_URL);
      url.searchParams.set('app_key', appKey);
      return fetchJson(url.toString());
    },
  });
}

/** Thames tide gauges (Environment Agency): GET /api/tide-gauges (no params).
 * Returns [{ref,label,lat,lon,levelM,readingAt,trend}] — see ea-tides.ts. */
export function registerTideGaugesRoute(app: FastifyInstance, deps: ProxyDeps): void {
  registerProxyRoute(app, deps, {
    path: '/api/tide-gauges',
    fetchUpstream: async () => {
      const { fetchTideGauges } = await import('../ea-tides');
      return { status: 200, body: await fetchTideGauges() };
    },
  });
}


/** TfL road disruptions (roadworks, closures …): GET /api/road-disruptions. */
export function registerRoadDisruptionsRoute(app: FastifyInstance, deps: ProxyDeps): void {
  registerProxyRoute(app, deps, {
    path: '/api/road-disruptions',
    fetchUpstream: (_value, appKey) => {
      const url = new URL('/Road/all/Disruption', TFL_BASE_URL);
      url.searchParams.set('stripContent', 'false');
      url.searchParams.set('app_key', appKey);
      return fetchJson(url.toString());
    },
  });
}
