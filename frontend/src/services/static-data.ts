// Typed access to the baked static JSON served from the Vite publicDir (../data).

export interface LineManifestEntry {
  id: string;
  name: string;
  mode: 'tube' | 'dlr' | 'elizabeth-line' | 'overground';
  /** Official TfL line colour (e.g. Northern is #000000). */
  color: string;
  /** Render-friendly override where the official colour is unreadable on a dark map. */
  displayColor?: string;
}

export interface LineManifest {
  generatedAt: string;
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
