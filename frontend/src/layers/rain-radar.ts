// RainViewer rain radar: raster overlay of the latest observed radar frame.
// Tiles come straight from RainViewer's public CDN (no key, no proxy); we
// re-fetch the frame catalogue every 5 min and swap tiles when a newer frame
// lands. Defaults to hidden so the map isn't washed out on dry days.

import type { Map as MaplibreMap, RasterTileSource } from 'maplibre-gl';
import { registerPoll } from '../util/lifecycle';

export const RAIN_RADAR_LAYER_ID = 'rain-radar';
const SOURCE_ID = 'rain-radar';
const CATALOG_URL = 'https://api.rainviewer.com/public/weather-maps.json';
const REFRESH_INTERVAL_MS = 300_000; // RainViewer publishes a frame every 10 min
const RADAR_OPACITY = 0.55;
/** colour scheme 2 (universal blue), smoothed, snow shown; 512px for detail */
const TILE_SUFFIX = '/512/{z}/{x}/{y}/2/1_1.png';
/** RainViewer's public tiles stop at z7 (higher zooms return a "Zoom Level
 * Not Supported" placeholder), so cap the source and let maplibre oversample */
const TILE_MAX_ZOOM = 7;
/** keep transport crisp: radar sits beneath the transit line casings */
const INSERT_BEFORE_LAYER_ID = 'transit-lines-casing';

interface RadarFrame {
  time: number;
  path: string;
}

interface WeatherMaps {
  host?: string;
  radar?: { past?: RadarFrame[]; nowcast?: RadarFrame[] };
}

/** Latest observed ("past") frame = current radar picture. */
async function fetchLatestFrame(): Promise<{ tileUrl: string; time: number } | undefined> {
  const res = await fetch(CATALOG_URL);
  if (!res.ok) return undefined;
  const data = (await res.json()) as WeatherMaps;
  const past = data.radar?.past;
  const latest = past?.[past.length - 1];
  if (!data.host || !latest?.path || typeof latest.time !== 'number') return undefined;
  return { tileUrl: `${data.host}${latest.path}${TILE_SUFFIX}`, time: latest.time };
}

export async function startRainRadar(map: MaplibreMap): Promise<void> {
  const frame = await fetchLatestFrame();
  if (!frame) return;
  let currentTileUrl = frame.tileUrl;

  map.addSource(SOURCE_ID, {
    type: 'raster',
    tiles: [currentTileUrl],
    tileSize: 512,
    maxzoom: TILE_MAX_ZOOM,
    attribution: '<a href="https://www.rainviewer.com/">RainViewer</a>',
  });
  map.addLayer(
    {
      id: RAIN_RADAR_LAYER_ID,
      type: 'raster',
      source: SOURCE_ID,
      layout: { visibility: 'none' }, // off by default; toggled on via the legend
      paint: { 'raster-opacity': RADAR_OPACITY, 'raster-fade-duration': 300 },
    },
    // Sit under the transit lines where they exist. A deployment without them
    // has no such layer, and passing a missing id makes addLayer throw — which
    // would take the radar down with it. Undefined simply means "on top".
    map.getLayer(INSERT_BEFORE_LAYER_ID) ? INSERT_BEFORE_LAYER_ID : undefined,
  );

  async function refresh(): Promise<void> {
    try {
      const next = await fetchLatestFrame();
      if (!next || next.tileUrl === currentTileUrl) return;
      const src = map.getSource(SOURCE_ID);
      if (src && 'setTiles' in src) {
        (src as RasterTileSource).setTiles([next.tileUrl]);
        currentTileUrl = next.tileUrl;
      }
    } catch {
      // keep showing the previous frame
    }
  }

  registerPoll(() => void refresh(), REFRESH_INTERVAL_MS);
}
