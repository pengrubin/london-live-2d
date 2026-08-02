import type { FastifyInstance } from 'fastify';
import {
  fetchBikePoints,
  fetchLiftDisruptions,
  fetchLineStatus,
  fetchLiveCrowding,
  fetchStopArrivals,
  fetchStopDetail,
  fetchVehicleArrivals,
} from '../tfl-client';
import { contains, VALIDATION_MARGIN_DEG, widen, type Bbox } from '../region';
import { registerProxyRoute, singleParamKey, type ParsedKey, type ProxyDeps } from './proxy-route';

/** NaPTAN ids look like 940GZZLUOXC / 930GWMR — strictly alphanumeric. */
const NAPTAN_ID_PATTERN = /^[A-Za-z0-9]{4,20}$/;
/** Vehicle ids: tube 3-digit, Overground 15-digit, DLR none — alphanumeric. */
const VEHICLE_ID_PATTERN = /^[A-Za-z0-9-]{1,20}$/;
/** Comma-separated lowercase line ids (same alphabet as the arrivals route). */
const LINE_IDS_PATTERN = /^[a-z0-9-]+(,[a-z0-9-]+){0,29}$/;

/** Cache-key precision for lat/lon (3 dp ≈ 70 m — well within the 350 m radius). */
const COORD_KEY_DECIMALS = 3;

/** On-click departure board proxy: GET /api/stop-arrivals?id=<naptanId>. */
export function registerStopArrivalsRoute(app: FastifyInstance, deps: ProxyDeps): void {
  registerProxyRoute(app, deps, {
    path: '/api/stop-arrivals',
    parseKey: singleParamKey('id', NAPTAN_ID_PATTERN),
    fetchTfl: fetchStopArrivals,
  });
}

/** Vehicle calling-pattern proxy: GET /api/vehicle-arrivals?id=<vehicleId>. */
export function registerVehicleArrivalsRoute(app: FastifyInstance, deps: ProxyDeps): void {
  registerProxyRoute(app, deps, {
    path: '/api/vehicle-arrivals',
    parseKey: singleParamKey('id', VEHICLE_ID_PATTERN),
    fetchTfl: fetchVehicleArrivals,
  });
}

/** Line service-status proxy: GET /api/line-status?lines=a,b,c. */
export function registerLineStatusRoute(app: FastifyInstance, deps: ProxyDeps): void {
  registerProxyRoute(app, deps, {
    path: '/api/line-status',
    parseKey: singleParamKey('lines', LINE_IDS_PATTERN),
    fetchTfl: (value, appKey) => fetchLineStatus(value.split(','), appKey),
  });
}

/** Stop point detail proxy (zones/facilities): GET /api/stop-detail?id=<naptanId>. */
export function registerStopDetailRoute(app: FastifyInstance, deps: ProxyDeps): void {
  registerProxyRoute(app, deps, {
    path: '/api/stop-detail',
    parseKey: singleParamKey('id', NAPTAN_ID_PATTERN),
    fetchTfl: fetchStopDetail,
  });
}

/** Live crowding proxy: GET /api/crowding?id=<naptanId>. */
export function registerCrowdingRoute(app: FastifyInstance, deps: ProxyDeps): void {
  registerProxyRoute(app, deps, {
    path: '/api/crowding',
    parseKey: singleParamKey('id', NAPTAN_ID_PATTERN),
    fetchTfl: fetchLiveCrowding,
  });
}

/** Network-wide lift disruptions proxy: GET /api/lift-disruptions (no params). */
export function registerLiftDisruptionsRoute(app: FastifyInstance, deps: ProxyDeps): void {
  registerProxyRoute(app, deps, {
    path: '/api/lift-disruptions',
    fetchTfl: (_value, appKey) => fetchLiftDisruptions(appKey),
  });
}

/**
 * Validates lat/lon floats against the region (plus a margin, so a click just
 * outside the data box is still served) and rounds them to 3 dp so nearby
 * clicks share a cache entry. The rounded pair doubles as the cache key.
 */
function makeBikePointsKeyParser(bounds: Bbox) {
  return (query: Record<string, string | undefined>): ParsedKey => {
    const lat = Number.parseFloat(query['lat'] ?? '');
    const lon = Number.parseFloat(query['lon'] ?? '');
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !contains(bounds, lon, lat)) {
      return {
        error:
          `Query parameters "lat" and "lon" must be floats within ` +
          `${bounds.minLat}..${bounds.maxLat} / ${bounds.minLon}..${bounds.maxLon}.`,
      };
    }
    return { key: `${lat.toFixed(COORD_KEY_DECIMALS)},${lon.toFixed(COORD_KEY_DECIMALS)}` };
  };
}

/** Nearby cycle-hire docks proxy: GET /api/bike-points?lat=<f>&lon=<f>. */
export function registerBikePointsRoute(app: FastifyInstance, deps: ProxyDeps): void {
  registerProxyRoute(app, deps, {
    path: '/api/bike-points',
    parseKey: makeBikePointsKeyParser(widen(deps.config.region.bbox, VALIDATION_MARGIN_DEG)),
    fetchTfl: (key, appKey) => {
      const [lat = '', lon = ''] = key.split(',');
      return fetchBikePoints(Number.parseFloat(lat), Number.parseFloat(lon), appKey);
    },
  });
}
