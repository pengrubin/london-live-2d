import { TFL_BASE_URL, UPSTREAM_TIMEOUT_MS } from './constants';

export interface TflResponse {
  readonly status: number;
  readonly body: unknown;
}

/**
 * Thin fetch wrapper for the TfL Unified API. The app key is appended here and
 * never appears in logs or responses. Throws on network failure or timeout.
 */
export async function fetchArrivals(
  lineIds: readonly string[],
  appKey: string,
  timeoutMs: number = UPSTREAM_TIMEOUT_MS,
): Promise<TflResponse> {
  return fetchTfl(`/Line/${lineIds.join(',')}/Arrivals`, appKey, timeoutMs);
}

/** Live departures board for one stop point (station or pier). */
export async function fetchStopArrivals(
  naptanId: string,
  appKey: string,
  timeoutMs: number = UPSTREAM_TIMEOUT_MS,
): Promise<TflResponse> {
  return fetchTfl(`/StopPoint/${naptanId}/Arrivals`, appKey, timeoutMs);
}

/** Every upcoming stop prediction for one vehicle (its calling pattern). */
export async function fetchVehicleArrivals(
  vehicleId: string,
  appKey: string,
  timeoutMs: number = UPSTREAM_TIMEOUT_MS,
): Promise<TflResponse> {
  return fetchTfl(`/Vehicle/${vehicleId}/Arrivals`, appKey, timeoutMs);
}

/** Service status (delays/disruptions) for a set of lines. */
export async function fetchLineStatus(
  lineIds: readonly string[],
  appKey: string,
  timeoutMs: number = UPSTREAM_TIMEOUT_MS,
): Promise<TflResponse> {
  return fetchTfl(`/Line/${lineIds.join(',')}/Status`, appKey, timeoutMs);
}

/** Every current road disruption (roadworks, closures) network-wide. */
export async function fetchRoadDisruptions(
  appKey: string,
  timeoutMs: number = UPSTREAM_TIMEOUT_MS,
): Promise<TflResponse> {
  return fetchTfl('/Road/all/Disruption', appKey, timeoutMs, { stripContent: 'false' });
}

/**
 * Service status for every line of the given modes (e.g. all tube lines).
 * `withDetail` asks TfL for the structured `disruption` object (affectedRoutes /
 * affectedStops with NaPTAN ids) alongside the free-text reason. Measured on
 * 2026-09-02: 399 KB raw vs 19 KB without, 91% of it affectedRoutes — so only
 * callers that archive or geolocate should ask, never a browser-facing proxy.
 */
export async function fetchLineStatusByModes(
  modes: readonly string[],
  appKey: string,
  timeoutMs: number = UPSTREAM_TIMEOUT_MS,
  withDetail = false,
): Promise<TflResponse> {
  const params = withDetail ? { detail: 'true' } : undefined;
  return fetchTfl(`/Line/Mode/${modes.join(',')}/Status`, appKey, timeoutMs, params);
}

/**
 * Service status for explicit lines over a date window (YYYY-MM-DD, Europe/London
 * days), always with detail. Unlike the Mode form this returns planned works days
 * ahead with their affectedRoutes — the only TfL form that does. Measured
 * 2026-09-02: all 20 rail lines incl. tram in one URL, 607 KB raw / 23 KB gzipped,
 * ≈ 0.7 s (Node's fetch asks for gzip), so the default timeout holds; the Mode
 * form of this path returns 404.
 */
export async function fetchLineStatusWindow(
  lineIds: readonly string[],
  fromDate: string,
  toDate: string,
  appKey: string,
  timeoutMs: number = UPSTREAM_TIMEOUT_MS,
): Promise<TflResponse> {
  return fetchTfl(`/Line/${lineIds.join(',')}/Status/${fromDate}/to/${toDate}`, appKey, timeoutMs, {
    detail: 'true',
  });
}

/**
 * Station-scoped disruptions (closures, lifts, "trains not stopping") for the
 * given modes — an array keyed by atcoCode. Measured 2026-09-02: 46 KB raw.
 */
export async function fetchStopPointDisruptions(
  modes: readonly string[],
  appKey: string,
  timeoutMs: number = UPSTREAM_TIMEOUT_MS,
): Promise<TflResponse> {
  return fetchTfl(`/StopPoint/Mode/${modes.join(',')}/Disruption`, appKey, timeoutMs);
}

/**
 * Stop point detail for several NaPTAN/ATCO ids at once — the only way to turn
 * the `atcoCode` of a bus-stop closure into a coordinate and a route list.
 * Measured 2026-09-03: 20 ids per URL answer 200, 25 answer HTTP 400, so
 * callers batch at `STOPPOINT_BATCH_MAX` (disruptions/bus-stop-gazetteer.ts).
 * A single id answers with a bare object, several with an array; asking for a
 * pole answers with its stop PAIR and the pole inside `children[]`.
 */
export async function fetchStopPoints(
  ids: readonly string[],
  appKey: string,
  timeoutMs: number = UPSTREAM_TIMEOUT_MS,
): Promise<TflResponse> {
  return fetchTfl(`/StopPoint/${ids.join(',')}`, appKey, timeoutMs);
}

/**
 * /Line/Mode/bus/Status bodies measured 760 KB in 4.6 s on 2026-09-02 — over
 * half the default upstream timeout, so this call gets its own.
 */
export const BUS_STATUS_TIMEOUT_MS = 20_000;

/**
 * Status of every bus route, without detail: the detail form is 10 MB and its
 * affected routes are all whole routes (zero localisation value).
 */
export async function fetchBusLineStatus(
  appKey: string,
  timeoutMs: number = BUS_STATUS_TIMEOUT_MS,
): Promise<TflResponse> {
  return fetchTfl('/Line/Mode/bus/Status', appKey, timeoutMs);
}

/** Full stop point detail (zones, facilities, lines) — a large object. */
export async function fetchStopDetail(
  naptanId: string,
  appKey: string,
  timeoutMs: number = UPSTREAM_TIMEOUT_MS,
): Promise<TflResponse> {
  return fetchTfl(`/StopPoint/${naptanId}`, appKey, timeoutMs);
}

/** Live crowding for one station: { dataAvailable, percentageOfBaseline, ... }. */
export async function fetchLiveCrowding(
  naptanId: string,
  appKey: string,
  timeoutMs: number = UPSTREAM_TIMEOUT_MS,
): Promise<TflResponse> {
  return fetchTfl(`/crowding/${naptanId}/Live`, appKey, timeoutMs);
}

/** Network-wide lift disruptions: array of { stationUniqueId, message, ... }. */
export async function fetchLiftDisruptions(
  appKey: string,
  timeoutMs: number = UPSTREAM_TIMEOUT_MS,
): Promise<TflResponse> {
  return fetchTfl('/Disruptions/Lifts/v2/', appKey, timeoutMs);
}

/** Radius search of Santander Cycles docks around a point (metres). */
const BIKE_POINT_RADIUS_M = 350;

/** Bike docks near a point — an object { centrePoint, places: [...] }. */
export async function fetchBikePoints(
  lat: number,
  lon: number,
  appKey: string,
  timeoutMs: number = UPSTREAM_TIMEOUT_MS,
): Promise<TflResponse> {
  return fetchTfl('/BikePoint', appKey, timeoutMs, {
    lat: String(lat),
    lon: String(lon),
    radius: String(BIKE_POINT_RADIUS_M),
  });
}

async function fetchTfl(
  path: string,
  appKey: string,
  timeoutMs: number,
  params?: Readonly<Record<string, string>>,
): Promise<TflResponse> {
  const url = new URL(path, TFL_BASE_URL);
  for (const [name, value] of Object.entries(params ?? {})) url.searchParams.set(name, value);
  url.searchParams.set('app_key', appKey);

  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: 'application/json' },
  });
  const body: unknown = await response.json();
  return { status: response.status, body };
}
