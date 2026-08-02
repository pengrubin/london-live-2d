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
import { addControlPanel } from './ui/control-panel';
import type { OverlayToggle } from './ui/legend';
import { startAircraft, AIRCRAFT_LAYER_ID } from './layers/aircraft';
import { findVessel, startVessels, VESSELS_LAYER_ID } from './layers/vessels';
import { addJamCams, JAMCAMS_LAYER_ID } from './layers/jamcams';
import { findNrTrain, startNrTrains, NR_TRAINS_LAYER_ID } from './realtime/nr-trains';
import {
  findBus,
  setBusesOverlayVisible,
  startBuses,
  BUSES_DOTS_LAYER_ID,
  BUSES_ICONS_LAYER_ID,
} from './layers/buses';
import { startRoadDisruptions, ROAD_DISRUPTIONS_LAYER_IDS } from './layers/road-disruptions';
import { startTideGauges, TIDE_GAUGES_LAYER_IDS } from './layers/tide-gauges';
import { startRainRadar, RAIN_RADAR_LAYER_ID } from './layers/rain-radar';
import { hasLayer, loadCapabilities } from './region';

const TOAST_DISMISS_MS = 4000;
let activeToast: HTMLDivElement | null = null;
/** Set once the map exists; toasts mount into its container. */
let toastHost: HTMLElement | null = null;

// Lightweight one-off notice, absolutely positioned over the map and
// auto-dismissed. Styling lives in index.html's <style> block (.map-toast).
function showToast(message: string): void {
  if (activeToast) activeToast.remove();
  if (!toastHost) return;
  const toast = document.createElement('div');
  toast.className = 'map-toast';
  toast.textContent = message;
  toastHost.append(toast);
  activeToast = toast;
  window.setTimeout(() => {
    if (toast === activeToast) activeToast = null;
    toast.remove();
  }, TOAST_DISMISS_MS);
}

// Optional ?z=13&lat=51.51&lon=-0.12 overrides for acceptance/debug runs.
function readInitialViewFromUrl(
  fallbackCenter: readonly [number, number],
  fallbackZoom: number,
): { center: [number, number]; zoom: number } {
  const params = new URLSearchParams(window.location.search);
  const zoom = Number.parseFloat(params.get('z') ?? '');
  const lat = Number.parseFloat(params.get('lat') ?? '');
  const lon = Number.parseFloat(params.get('lon') ?? '');
  const hasCenter = Number.isFinite(lat) && Number.isFinite(lon);
  return {
    center: hasCenter ? [lon, lat] : [fallbackCenter[0], fallbackCenter[1]],
    zoom: Number.isFinite(zoom) ? zoom : fallbackZoom,
  };
}

/**
 * Builds the map from whatever the backend says this deployment is and has.
 *
 * The camera cannot be created before /api/capabilities answers — centre, zoom,
 * bounds and basemap all come from it — so everything that used to run at
 * module scope now runs here. `loadCapabilities` never rejects (it falls back
 * to London), which preserves the property that the map always renders even
 * when the API is unreachable.
 */
async function bootstrap(): Promise<void> {
  const caps = await loadCapabilities();
  const { region } = caps;
  document.title = `${region.name} Live — 2D Real-Time Transport Map`;

  const initialView = readInitialViewFromUrl(region.center, region.zoom);
  const bounds = region.maxBounds;

  if (import.meta.env.PROD) {
    maplibregl.setWorkerUrl(maplibreWorkerUrl);
  }

  const protocol = new Protocol();
  maplibregl.addProtocol('pmtiles', protocol.tile);

  const basemapUrl =
    region.pmtilesUrl ?? (import.meta.env.VITE_PMTILES_URL as string | undefined) ?? '/london.pmtiles';

  const map = new maplibregl.Map({
    container: 'app',
    style: {
      version: 8,
      glyphs: 'https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf',
      sprite: 'https://protomaps.github.io/basemaps-assets/sprites/v4/dark',
      sources: {
        protomaps: {
          type: 'vector',
          url: `pmtiles://${basemapUrl}`,
          attribution:
            '<a href="https://protomaps.com">Protomaps</a> © <a href="https://openstreetmap.org">OpenStreetMap</a>',
        },
      },
      layers: layers('protomaps', namedFlavor('dark'), { lang: 'en' }),
    },
    center: initialView.center,
    zoom: initialView.zoom,
    maxBounds: [
      [bounds[0][0], bounds[0][1]],
      [bounds[1][0], bounds[1][1]],
    ],
    attributionControl: {
      compact: true,
      customAttribution:
        '<a href="https://github.com/pengrubin" target="_blank"><b>© PENG</b></a>',
    },
  });
  toastHost = map.getContainer();

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
    // camera so it can never pan outside the region.
    fitBoundsOptions: { maxZoom: 14 },
  });
  map.addControl(geolocate, 'top-right');

  const isOutsideRegion = (lon: number, lat: number): boolean => {
    const [[west, south], [east, north]] = bounds;
    return lon < west || lon > east || lat < south || lat > north;
  };
  const showOutsideRegionToast = (): void => {
    showToast(`You appear to be outside ${region.name} — showing the nearest edge.`);
  };

  // maplibre already clamps to maxBounds: when the located position lies
  // outside, it emits `outofmaxbounds` (and does NOT fly), so the nearest edge
  // is shown. That event is the precise outside-bbox signal.
  geolocate.on('outofmaxbounds', (event) => {
    if (isOutsideRegion(event.coords.longitude, event.coords.latitude)) {
      showOutsideRegionToast();
    }
  });

  // Belt-and-suspenders: if a successful geolocate ever reports coords beyond
  // the region bbox (e.g. maxBounds tweaked wider), still notify.
  geolocate.on('geolocate', (event) => {
    if (isOutsideRegion(event.coords.longitude, event.coords.latitude)) {
      showOutsideRegionToast();
    }
  });

  geolocate.on('error', () => {
    showToast('Location unavailable or permission denied.');
  });

  map.addControl(new maplibregl.ScaleControl(), 'bottom-left');

  map.on('error', (e: maplibregl.ErrorEvent) => {
    console.error('[map]', e.error);
  });

  map.on('load', () => {
    void addTransitOverlays(map);
  });

  window.__map = map;
}

/** Colour map and lookups used by the panels when there is no train pipeline. */
const NO_TRAINS = {
  colorByLine: new Map<string, string>() as ReadonlyMap<string, string>,
  findVehicle: (): [number, number] | null => null,
  closeVehiclePopup: (): void => {},
  selectedVehicleKey: (): string | null => null,
};

/**
 * Starts every layer this deployment has.
 *
 * Each layer is isolated: previously the three tube-related calls were bare
 * `await`s inside one try/catch, so a single 404 on /manifest.json took the
 * ships, aircraft and rain radar down with it. That was latent in London and
 * certain anywhere without baked tube data.
 */
async function addTransitOverlays(target: maplibregl.Map): Promise<void> {
  let manifestLines: Awaited<ReturnType<typeof addTransitLineLayers>> = [];
  let trains: TrainsHandle | null = null;

  if (hasLayer('tube')) {
    try {
      manifestLines = await addTransitLineLayers(target);
      await addStationLayers(target, manifestLines.map((line) => line.id));
    } catch (error) {
      console.error('[transit-lines]', error);
    }
    // Separate try: the train pipeline re-fetches the manifest itself, so it
    // can fail (or succeed) independently of the line geometry above.
    try {
      trains = await startTrains(target);
    } catch (error) {
      console.error('[trains]', error);
    }
  }

  const starts: Array<Promise<unknown>> = [];
  const overlays: OverlayToggle[] = [];
  const enable = (
    name: string,
    start: () => Promise<unknown>,
    overlay: OverlayToggle,
  ): void => {
    if (!hasLayer(name)) return;
    starts.push(start());
    overlays.push(overlay);
  };

  // Order here is the order of the overlay rows in the Lines tab.
  enable('buses', () => startBuses(target), {
    label: 'Buses',
    layerIds: [BUSES_DOTS_LAYER_ID, BUSES_ICONS_LAYER_ID],
    // Buses visibility is resolved against the line filter (see buses.ts),
    // not a plain show/hide — route the toggle through the coordinator.
    onToggle: (visible: boolean) => setBusesOverlayVisible(target, visible),
  });
  enable('nationalRail', () => startNrTrains(target), {
    label: 'National Rail',
    layerIds: [NR_TRAINS_LAYER_ID],
  });
  enable('aircraft', () => startAircraft(target), {
    label: 'Aircraft',
    layerIds: [AIRCRAFT_LAYER_ID],
  });
  enable('vessels', () => startVessels(target), {
    label: 'Ships',
    layerIds: [VESSELS_LAYER_ID],
  });
  enable('jamCams', () => addJamCams(target), {
    label: 'JamCams',
    layerIds: [JAMCAMS_LAYER_ID],
  });
  enable('roadDisruptions', () => startRoadDisruptions(target), {
    label: 'Roadworks',
    layerIds: ROAD_DISRUPTIONS_LAYER_IDS,
  });
  enable('tideGauges', () => startTideGauges(target), {
    label: 'Tide gauges',
    layerIds: TIDE_GAUGES_LAYER_IDS,
  });
  enable('rainRadar', () => startRainRadar(target), {
    label: 'Rain radar',
    layerIds: [RAIN_RADAR_LAYER_ID],
    startOff: true,
  });

  await Promise.allSettled(starts);

  // One merged panel (top-left): Board / Filter / Lines tabs. Leaving the
  // top-right corner free for MapLibre's zoom + geolocate controls.
  const handle = trains ?? NO_TRAINS;
  addControlPanel(target, manifestLines, overlays, handle.colorByLine, {
    findTrain: handle.findVehicle,
    findNrTrain,
    findBus,
    findVessel,
  });
  if (trains) {
    window.__trains = trains;
    setupStationPopups(target, trains.colorByLine, trains.closeVehiclePopup);
    const nameByLine = new Map(manifestLines.map((line) => [line.id, line.name]));
    setupHoverTooltips(
      target,
      trains.colorByLine,
      nameByLine,
      (key) => trains.selectedVehicleKey() === key,
    );
  }
}

// dev-only handles for acceptance tooling (scripts/screenshot.mjs, debug-map.mjs).
// __map now appears one capabilities round trip later than it used to; those
// scripts already guard for its absence and poll on a timeout.
declare global {
  interface Window {
    __map?: maplibregl.Map;
    __trains?: TrainsHandle;
  }
}

void bootstrap();
