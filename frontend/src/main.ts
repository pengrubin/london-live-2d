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
import { startBikeStations, BIKE_STATIONS_LAYER_ID } from './layers/bike-stations';
import { startSimulatedTrains, SIMULATED_TRAINS_LAYER_ID } from './layers/simulated-trains';
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
 * Google-Maps-style heading wedge on the geolocate dot. maplibre-gl 6.0 has no
 * `showUserHeading`, so it is hand-rolled: a CSS wedge (styled in index.html as
 * .user-heading-beam) appended inside maplibre's dot element and rotated from
 * device-orientation events. Stays invisible until a trustworthy compass
 * reading arrives, so desktop browsers never show a broken beam.
 */
function setupHeadingBeam(map: maplibregl.Map, geolocate: maplibregl.GeolocateControl): void {
  let compassHeading: number | null = null; // degrees clockwise from true north
  let beam: HTMLDivElement | null = null;
  let rafPending = false;

  // Orientation events and map `rotate` both fire in bursts; coalesce to one
  // style write per frame by storing the latest heading and scheduling one rAF.
  const scheduleRender = (): void => {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      if (beam === null || compassHeading === null) return;
      // The wedge is drawn pointing screen-up; subtract the map bearing so it
      // stays true when the map has been rotated by touch gestures.
      beam.style.transform = `rotate(${compassHeading - map.getBearing()}deg)`;
      beam.style.opacity = '1';
    });
  };

  const onOrientation = (event: DeviceOrientationEvent): void => {
    // iOS ships a ready-made compass heading (already clockwise-from-north);
    // elsewhere alpha is only trustworthy when the browser marks it absolute.
    // Anything else is ignored — no beam beats a wrong beam.
    const webkitHeading = (event as any).webkitCompassHeading;
    if (typeof webkitHeading === 'number' && Number.isFinite(webkitHeading)) {
      compassHeading = webkitHeading;
    } else if (event.absolute && event.alpha != null) {
      // alpha is measured in the DEVICE frame, but the wedge is drawn in
      // screen space — in landscape they differ by the screen rotation, so
      // add it back. (webkitCompassHeading is already screen-corrected.)
      const screenAngle = window.screen.orientation?.angle ?? 0;
      compassHeading = (360 - event.alpha + screenAngle) % 360;
    } else {
      return;
    }
    scheduleRender();
  };

  let listening = false;
  const startListening = (): void => {
    if (listening) return;
    listening = true;
    // Prefer the absolute-referenced event (Android Chrome); fall back to the
    // plain one where it does not exist (iOS, which compensates via
    // webkitCompassHeading instead).
    const type = 'ondeviceorientationabsolute' in window ? 'deviceorientationabsolute' : 'deviceorientation';
    window.addEventListener(type, onOrientation as EventListener);
  };

  // iOS only grants orientation events when requestPermission() runs inside a
  // user gesture, so piggyback on the geolocate button click (the element
  // exists: the control's onAdd ran in addControl above). Denial silently
  // means no beam.
  const button = map.getContainer().querySelector<HTMLButtonElement>('.maplibregl-ctrl-geolocate');
  button?.addEventListener('click', () => {
    const request = typeof DeviceOrientationEvent !== 'undefined' ? (DeviceOrientationEvent as any).requestPermission : undefined;
    if (typeof request === 'function') {
      void Promise.resolve(request.call(DeviceOrientationEvent))
        .then((state: unknown) => {
          if (state === 'granted') startListening();
        })
        .catch((err: unknown) => {
          // Denial resolves as 'denied' above; only genuine API errors land
          // here — keep them visible in devtools without surfacing UI.
          console.debug('[heading] orientation permission request failed', err);
        });
    } else {
      startListening();
    }
  });

  geolocate.on('geolocate', () => {
    // The dot only exists after a successful fix. A child div is safe from the
    // dot's pulse animation, which lives on its ::before/::after.
    const dot = map.getContainer().querySelector('.maplibregl-user-location-dot');
    if (dot === null) return;
    if (beam === null) {
      beam = document.createElement('div');
      beam.className = 'user-heading-beam';
    }
    // Re-append if maplibre ever rebuilt the marker between fixes.
    if (beam.parentElement !== dot) dot.append(beam);
    scheduleRender();
  });
  map.on('rotate', scheduleRender);
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

  // Corner credit line, derived from the layer set rather than the city name —
  // a deployment only names the licensors whose data it actually draws (TfL's
  // terms require a visible "Powered by TfL Open Data"; Dubai must not show
  // one). Kept short: the full licence wording lives in the panel's About tab
  // and the README. Joined into ONE string — MapLibre length-sorts separate
  // attribution entries, which scrambled the order — so the owner credit stays
  // first and the separator stays uniform. The basemap credit lives here too
  // (not on the source) for the same reason.
  const dataCredits = [
    '<a href="https://github.com/pengrubin/london-live-2d" target="_blank" rel="noopener"><b>© PENG</b></a>',
    hasLayer('trainPositions') || hasLayer('stopArrivals')
      ? '<a href="https://tfl.gov.uk/info-for/open-data-users/" target="_blank" rel="noopener">Powered by TfL Open Data</a>'
      : null,
    hasLayer('buses')
      ? '<a href="https://www.bus-data.dft.gov.uk/" target="_blank" rel="noopener">DfT BODS</a>'
      : null,
    // Corner keeps only the legally required OSM notice; the Protomaps tile
    // credit lives in the Info tab and README (self-hosted pmtiles).
    '<a href="https://openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap</a>',
  ]
    .filter((credit): credit is string => credit !== null)
    .join(' | ');

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
          // No `attribution` here: the Protomaps/OSM credit is part of
          // dataCredits above so the credit line renders in a fixed order.
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
    // No `compact` override: MapLibre expands the line on desktop widths and
    // collapses to the ⓘ button on phones, which is the accepted attribution
    // pattern for small screens.
    attributionControl: {
      customAttribution: dataCredits,
    },
  });
  toastHost = map.getContainer();

  // On phone widths MapLibre's compact attribution starts EXPANDED — a fat
  // white bar over the map until the user happens to tap elsewhere. Collapse
  // it up front: credits stay one tap away behind the ⓘ (the OSMF-accepted
  // minimum for small screens; ODbL requires OSM attribution on or one
  // interaction from the map, so the control itself cannot be dropped).
  // Desktop keeps the always-visible line — space is not contested there.
  map.once('load', () => {
    map
      .getContainer()
      .querySelector('.maplibregl-ctrl-attrib.maplibregl-compact')
      ?.classList.remove('maplibregl-compact-show');
  });

  // No NavigationControl: the zoom +/- buttons and compass go unused (pinch /
  // scroll zoom covers it, and the map is never deliberately rotated), so the
  // top-right stack holds only the geolocate button.

  // User-initiated "locate me" control. Privacy-safe: the browser permission
  // prompt only fires on click, never on load, and the coordinates stay on the
  // client (maplibre never transmits them).
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
  setupHeadingBeam(map, geolocate);

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

  // Static network geometry: baked data only, no operator credential involved.
  if (hasLayer('transitLines')) {
    try {
      manifestLines = await addTransitLineLayers(target);
      await addStationLayers(target, manifestLines.map((line) => line.id));
    } catch (error) {
      console.error('[transit-lines]', error);
    }
  }
  // Live vehicle dots are a separate capability: a region can have a drawn
  // network with no arrivals feed to move anything along it. Separate try too,
  // because the train pipeline re-fetches the manifest itself and can fail
  // independently of the geometry above.
  if (hasLayer('trainPositions')) {
    try {
      trains = await startTrains(target);
    } catch (error) {
      console.error('[trains]', error);
    }
  }

  // TWO ORDERS, deliberately different — collapsing them into one silently
  // restacks the map.
  //
  // `start` order IS the z-order: layers sharing a beforeId are spliced in at
  // the same index, so whichever is added last ends up highest. Ships must go
  // in before buses and National Rail to stay beneath them, as vessels.ts asks
  // ("beneath TfL vehicles so bullets stay readable").
  //
  // `row` is only where the toggle sits in the Lines tab, which reads best
  // with the everyday modes first. Both sequences reproduce what shipped
  // before capability gating.
  const LAYERS: ReadonlyArray<{
    readonly name: string;
    readonly row: number;
    readonly start: () => Promise<unknown>;
    readonly overlay: OverlayToggle;
  }> = [
    {
      name: 'transitLines',
      row: 0,
      start: () => startSimulatedTrains(target),
      overlay: {
        label: 'Metro (simulated)',
        layerIds: [SIMULATED_TRAINS_LAYER_ID],
      },
    },
    {
      name: 'bikeStations',
      row: 5,
      start: () => startBikeStations(target),
      overlay: { label: 'Bike stations', layerIds: [BIKE_STATIONS_LAYER_ID] },
    },
    {
      name: 'jamCams',
      row: 6,
      start: () => addJamCams(target),
      overlay: { label: 'JamCams', layerIds: [JAMCAMS_LAYER_ID] },
    },
    {
      name: 'vessels',
      row: 4,
      start: () => startVessels(target),
      overlay: { label: 'Ships', layerIds: [VESSELS_LAYER_ID] },
    },
    {
      name: 'aircraft',
      row: 3,
      start: () => startAircraft(target),
      overlay: { label: 'Aircraft', layerIds: [AIRCRAFT_LAYER_ID] },
    },
    {
      name: 'nationalRail',
      row: 2,
      start: () => startNrTrains(target),
      overlay: { label: 'National Rail', layerIds: [NR_TRAINS_LAYER_ID] },
    },
    {
      name: 'buses',
      row: 1,
      start: () => startBuses(target),
      overlay: {
        label: 'Buses',
        layerIds: [BUSES_DOTS_LAYER_ID, BUSES_ICONS_LAYER_ID],
        // Buses visibility is resolved against the line filter (see buses.ts),
        // not a plain show/hide — route the toggle through the coordinator.
        onToggle: (visible: boolean) => setBusesOverlayVisible(target, visible),
      },
    },
    {
      name: 'roadDisruptions',
      row: 7,
      start: () => startRoadDisruptions(target),
      overlay: { label: 'Roadworks', layerIds: ROAD_DISRUPTIONS_LAYER_IDS },
    },
    {
      name: 'tideGauges',
      row: 8,
      start: () => startTideGauges(target),
      overlay: { label: 'Tide gauges', layerIds: TIDE_GAUGES_LAYER_IDS },
    },
    {
      name: 'rainRadar',
      row: 9,
      start: () => startRainRadar(target),
      overlay: { label: 'Rain radar', layerIds: [RAIN_RADAR_LAYER_ID], startOff: true },
    },
  ];

  const available = LAYERS.filter((layer) => hasLayer(layer.name));
  await Promise.allSettled(available.map((layer) => layer.start()));

  // Offer a toggle only for layers that actually exist. A capability being on
  // is not the same as a layer having been created: a start can decline (the
  // simulated services need timetable parameters the region may not publish)
  // or fail outright, and a switch that controls nothing is worse than no
  // switch — it advertises data the map does not have.
  const overlays: OverlayToggle[] = [...available]
    .filter((layer) => layer.overlay.layerIds.some((id) => target.getLayer(id)))
    .sort((a, b) => a.row - b.row)
    .map((layer) => layer.overlay);

  // One merged panel (top-left): Board / Filter / Lines tabs. Leaving the
  // top-right corner free for MapLibre's geolocate control.
  const handle = trains ?? NO_TRAINS;
  addControlPanel(target, manifestLines, overlays, handle.colorByLine, {
    findTrain: handle.findVehicle,
    findNrTrain,
    findBus,
    findVessel,
  });
  // Station departure boards need an arrivals feed; without one a click would
  // open a card that can only ever say "unavailable", plus five doomed
  // requests. Hover tooltips need none of that — their colours and names come
  // from the manifest — so they run wherever there is a network drawn.
  if (trains) {
    window.__trains = trains;
    setupStationPopups(target, trains.colorByLine, trains.closeVehiclePopup);
  }
  // Either source justifies tooltips: vehicles need only the train handle,
  // stations and lines need only the manifest. Gating on the manifest alone
  // would drop vehicle hover in the state where line geometry failed to load
  // but the train pipeline started — which is what the old `if (trains)` gate
  // covered.
  if (trains !== null || manifestLines.length > 0) {
    const colorByLine = new Map(manifestLines.map((line) => [line.id, line.color]));
    const nameByLine = new Map(manifestLines.map((line) => [line.id, line.name]));
    setupHoverTooltips(
      target,
      trains?.colorByLine ?? colorByLine,
      nameByLine,
      (key) => trains?.selectedVehicleKey() === key,
      trains !== null,
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
