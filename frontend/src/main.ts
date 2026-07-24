import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// maplibre resolves its render worker's filename at runtime (relative to
// import.meta.url), which the bundler cannot see — in a production build the
// worker would 404. `?worker&url` makes Vite bundle the worker (with its
// shared-chunk import) and hand back its URL; dev keeps maplibre's own
// resolution, which works from node_modules.
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { Protocol } from 'pmtiles';
import { layers, namedFlavor } from '@protomaps/basemaps';
import { addTransitLineLayers } from './layers/transit-lines';
import { addStationLayers } from './layers/stations';
import { startTrains, type TrainsHandle } from './realtime/trains-controller';
import { setupStationPopups } from './ui/station-popup';
import { setupHoverTooltips } from './ui/hover-tooltip';
import { addLegend } from './ui/legend';
import { addLeaderboard } from './ui/leaderboard';
import { startAircraft, AIRCRAFT_LAYER_ID } from './layers/aircraft';
import { findVessel, startVessels, VESSELS_LAYER_ID } from './layers/vessels';
import { addJamCams, JAMCAMS_LAYER_ID } from './layers/jamcams';
import { findNrTrain, startNrTrains, NR_TRAINS_LAYER_ID } from './realtime/nr-trains';
import { findBus, startBuses, BUSES_DOTS_LAYER_ID, BUSES_ICONS_LAYER_ID } from './layers/buses';
import { startRoadDisruptions, ROAD_DISRUPTIONS_LAYER_IDS } from './layers/road-disruptions';
import { startTideGauges, TIDE_GAUGES_LAYER_IDS } from './layers/tide-gauges';
import { startRainRadar, RAIN_RADAR_LAYER_ID } from './layers/rain-radar';

const LONDON_CENTER: [number, number] = [-0.1276, 51.5072];
// Slightly wider than the pmtiles extract bbox so panning never hits a hard wall
const LONDON_BOUNDS: [[number, number], [number, number]] = [
  [-0.65, 51.2],
  [0.45, 51.77],
];
const INITIAL_ZOOM = 11;

// Optional ?z=13&lat=51.51&lon=-0.12 overrides for acceptance/debug runs.
function readInitialViewFromUrl(): { center: [number, number]; zoom: number } {
  const params = new URLSearchParams(window.location.search);
  const zoom = Number.parseFloat(params.get('z') ?? '');
  const lat = Number.parseFloat(params.get('lat') ?? '');
  const lon = Number.parseFloat(params.get('lon') ?? '');
  const hasCenter = Number.isFinite(lat) && Number.isFinite(lon);
  return {
    center: hasCenter ? [lon, lat] : LONDON_CENTER,
    zoom: Number.isFinite(zoom) ? zoom : INITIAL_ZOOM,
  };
}

const initialView = readInitialViewFromUrl();

if (import.meta.env.PROD) {
  maplibregl.setWorkerUrl(maplibreWorkerUrl);
}

const protocol = new Protocol();
maplibregl.addProtocol('pmtiles', protocol.tile);

const map = new maplibregl.Map({
  container: 'app',
  style: {
    version: 8,
    glyphs: 'https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf',
    sprite: 'https://protomaps.github.io/basemaps-assets/sprites/v4/dark',
    sources: {
      protomaps: {
        type: 'vector',
        url: `pmtiles://${import.meta.env.VITE_PMTILES_URL ?? '/london.pmtiles'}`,
        attribution:
          '<a href="https://protomaps.com">Protomaps</a> © <a href="https://openstreetmap.org">OpenStreetMap</a>',
      },
    },
    layers: layers('protomaps', namedFlavor('dark'), { lang: 'en' }),
  },
  center: initialView.center,
  zoom: initialView.zoom,
  maxBounds: LONDON_BOUNDS,
  attributionControl: {
    compact: true,
    customAttribution:
      '<a href="https://github.com/pengrubin" target="_blank"><b>© PENG</b></a>',
  },
});

map.addControl(new maplibregl.NavigationControl(), 'top-right');

// User-initiated "locate me" control. Privacy-safe: the browser permission
// prompt only fires on click, never on load, and the coordinates stay on the
// client (maplibre never transmits them). Sits directly under the zoom +/-
// buttons in the top-right stack.
const geolocate = new maplibregl.GeolocateControl({
  positionOptions: { enableHighAccuracy: true },
  trackUserLocation: false,
  showAccuracyCircle: true,
  showUserLocation: true,
  // Cap the fly-to zoom at ~14 (default is 15). maxBounds still clamps the
  // camera so it can never pan outside Greater London.
  fitBoundsOptions: { maxZoom: 14 },
});
map.addControl(geolocate, 'top-right');

// True when [lon, lat] falls outside the Greater London bbox (maxBounds).
function isOutsideLondon(lon: number, lat: number): boolean {
  const [[west, south], [east, north]] = LONDON_BOUNDS;
  return lon < west || lon > east || lat < south || lat > north;
}

function showOutsideLondonToast(): void {
  showToast(
    'You appear to be outside Greater London — showing the nearest edge.',
  );
}

// maplibre already clamps to maxBounds (== LONDON_BOUNDS): when the located
// position lies outside, it emits `outofmaxbounds` (and does NOT fly), so the
// nearest edge is shown. That event is the precise outside-bbox signal.
geolocate.on('outofmaxbounds', (event) => {
  if (isOutsideLondon(event.coords.longitude, event.coords.latitude)) {
    showOutsideLondonToast();
  }
});

// Belt-and-suspenders: if a successful geolocate ever reports coords beyond the
// London bbox (e.g. maxBounds tweaked wider than LONDON_BOUNDS), still notify.
geolocate.on('geolocate', (event) => {
  if (isOutsideLondon(event.coords.longitude, event.coords.latitude)) {
    showOutsideLondonToast();
  }
});

geolocate.on('error', () => {
  showToast('Location unavailable or permission denied.');
});

map.addControl(new maplibregl.ScaleControl(), 'bottom-left');

const TOAST_DISMISS_MS = 4000;
let activeToast: HTMLDivElement | null = null;

// Lightweight one-off notice, absolutely positioned over the map and
// auto-dismissed. Styling lives in index.html's <style> block (.map-toast).
function showToast(message: string): void {
  if (activeToast) activeToast.remove();
  const toast = document.createElement('div');
  toast.className = 'map-toast';
  toast.textContent = message;
  map.getContainer().append(toast);
  activeToast = toast;
  window.setTimeout(() => {
    if (toast === activeToast) activeToast = null;
    toast.remove();
  }, TOAST_DISMISS_MS);
}

map.on('error', (e: maplibregl.ErrorEvent) => {
  console.error('[map]', e.error);
});

map.on('load', () => {
  void addTransitOverlays(map);
});

async function addTransitOverlays(target: maplibregl.Map): Promise<void> {
  try {
    const manifestLines = await addTransitLineLayers(target);
    await addStationLayers(target, manifestLines.map((line) => line.id));
    const trains = await startTrains(target);
    await Promise.allSettled([
      addJamCams(target),
      startVessels(target),
      startAircraft(target),
      startNrTrains(target),
      startBuses(target),
      startRoadDisruptions(target),
      startTideGauges(target),
      startRainRadar(target),
    ]);
    addLegend(target, manifestLines, [
      { label: 'Buses', layerIds: [BUSES_DOTS_LAYER_ID, BUSES_ICONS_LAYER_ID] },
      { label: 'National Rail', layerIds: [NR_TRAINS_LAYER_ID] },
      { label: 'Aircraft', layerIds: [AIRCRAFT_LAYER_ID] },
      { label: 'Ships', layerIds: [VESSELS_LAYER_ID] },
      { label: 'JamCams', layerIds: [JAMCAMS_LAYER_ID] },
      { label: 'Roadworks', layerIds: ROAD_DISRUPTIONS_LAYER_IDS },
      { label: 'Tide gauges', layerIds: TIDE_GAUGES_LAYER_IDS },
      { label: 'Rain radar', layerIds: [RAIN_RADAR_LAYER_ID], startOff: true },    ]);
    addLeaderboard(target, trains.colorByLine, {
      findTrain: trains.findVehicle,
      findNrTrain,
      findBus,
      findVessel,
    });
    window.__trains = trains;
    setupStationPopups(target, trains.colorByLine, trains.closeVehiclePopup);
    const nameByLine = new Map(manifestLines.map((line) => [line.id, line.name]));
    setupHoverTooltips(
      target,
      trains.colorByLine,
      nameByLine,
      (key) => trains.selectedVehicleKey() === key,
    );
  } catch (error) {
    console.error('[transit-layers]', error);
  }
}

// dev-only handles for acceptance tooling (scripts/screenshot.mjs, debug-map.mjs)
declare global {
  interface Window {
    __map: maplibregl.Map;
    __trains?: TrainsHandle;
  }
}
window.__map = map;
