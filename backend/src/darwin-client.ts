// National Rail live boards via the Rail Data Marketplace REST gateway
// (LDBWS GetDepBoardWithDetails as JSON; auth = x-apikey header).

import { UPSTREAM_TIMEOUT_MS } from './constants';

const RDM_BASE =
  'https://api1.raildata.org.uk/1010-live-departure-board-dep1_2/LDBWS/api/20220120';

export interface NrCallingPoint {
  crs: string;
  name: string;
  st: string;
  et?: string;
  at?: string;
}

export interface NrService {
  rid: string;
  std: string;
  etd?: string;
  platform?: string;
  operator?: string;
  origin: string;
  destination: string;
  cancelled: boolean;
  callingPoints: NrCallingPoint[];
}

export interface NrBoard {
  crs: string;
  locationName: string;
  generatedAt: string;
  services: NrService[];
}

interface RdmLocation {
  locationName?: string;
  crs?: string;
}

interface RdmCallingPoint {
  locationName?: string;
  crs?: string;
  st?: string;
  et?: string;
  at?: string;
  isCancelled?: boolean;
}

interface RdmService {
  serviceID?: string;
  std?: string;
  etd?: string;
  platform?: string;
  operator?: string;
  isCancelled?: boolean;
  origin?: RdmLocation[];
  destination?: RdmLocation[];
  subsequentCallingPoints?: { callingPoint?: RdmCallingPoint[] }[];
}

interface RdmBoard {
  crs?: string;
  locationName?: string;
  generatedAt?: string;
  trainServices?: RdmService[];
}

/** Fetches and normalizes a departure board. */
export async function fetchNrBoard(
  crs: string,
  apiKey: string,
  numRows = 20,
): Promise<{ status: number; body: unknown }> {
  const url = `${RDM_BASE}/GetDepBoardWithDetails/${crs}?numRows=${numRows}&timeWindow=120`;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    headers: { 'x-apikey': apiKey, accept: 'application/json' },
  });
  if (!response.ok) {
    return { status: response.status, body: { error: `Darwin gateway ${response.status}` } };
  }
  const raw = (await response.json()) as RdmBoard;

  const services: NrService[] = (raw.trainServices ?? []).map((s) => {
    // first calling-point list = the through train's own onward pattern
    const points = s.subsequentCallingPoints?.[0]?.callingPoint ?? [];
    return {
      rid: s.serviceID ?? '',
      std: s.std ?? '',
      etd: s.etd || undefined,
      platform: s.platform || undefined,
      operator: s.operator || undefined,
      origin: s.origin?.[0]?.locationName ?? '',
      destination: s.destination?.[0]?.locationName ?? '',
      cancelled: s.isCancelled === true || s.etd === 'Cancelled',
      callingPoints: points
        .filter((p) => !p.isCancelled)
        .map((p) => ({
          crs: p.crs ?? '',
          name: p.locationName ?? '',
          st: p.st ?? '',
          et: p.et || undefined,
          at: p.at || undefined,
        })),
    };
  });

  const board: NrBoard = {
    crs: raw.crs ?? crs,
    locationName: raw.locationName ?? '',
    generatedAt: raw.generatedAt ?? '',
    services,
  };
  return { status: 200, body: board };
}
