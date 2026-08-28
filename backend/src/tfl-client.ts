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

/** Service status for every line of the given modes (e.g. all tube lines). */
/** Every current road disruption (roadworks, closures) network-wide. */
export async function fetchRoadDisruptions(
  appKey: string,
  timeoutMs: number = UPSTREAM_TIMEOUT_MS,
): Promise<TflResponse> {
  return fetchTfl('/Road/all/Disruption', appKey, timeoutMs, { stripContent: 'false' });
}

export async function fetchLineStatusByModes(
  modes: readonly string[],
  appKey: string,
  timeoutMs: number = UPSTREAM_TIMEOUT_MS,
): Promise<TflResponse> {
  return fetchTfl(`/Line/Mode/${modes.join(',')}/Status`, appKey, timeoutMs);
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
