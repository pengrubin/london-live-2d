// Typed access to the baked static JSON served from the Vite publicDir (../data).

export interface LineManifestEntry {
  id: string;
  name: string;
  /** London's TfL modes, plus whatever an OSM-baked region declares. */
  mode: 'tube' | 'dlr' | 'elizabeth-line' | 'overground' | string;
  /** Official line colour (e.g. Northern is #000000). */
  color: string;
  /** Render-friendly override where the official colour is unreadable on a dark map. */
  displayColor?: string;
  /**
   * Published timetable parameters, present only where the operator publishes
   * no live positions and the region has opted into SIMULATED services.
   */
  sim?: { speedKmh: number; headwayPeakS: number; headwayOffPeakS: number };
}

/** Present only where a region declares simulated services. */
export interface ServiceManifest {
  utcOffsetHours: number;
  hours: Array<{ open: number; close: number }>;
  peakHours: Array<[number, number]>;
}

export interface LineManifest {
  generatedAt: string;
  service?: ServiceManifest;
  lines: LineManifestEntry[];
}

const MANIFEST_URL = '/manifest.json';

export async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

export function fetchManifest(): Promise<LineManifest> {
  return fetchJson<LineManifest>(MANIFEST_URL);
}

export function lineGeometryUrl(lineId: string): string {
  return `/lines/${lineId}.json`;
}

export function lineStationsUrl(lineId: string): string {
  return `/stations/${lineId}.json`;
}
