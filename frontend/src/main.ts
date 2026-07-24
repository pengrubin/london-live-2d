import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Protocol } from 'pmtiles';
import { layers, namedFlavor } from '@protomaps/basemaps';
import { addTransitLineLayers } from './layers/transit-lines';
import { addStationLayers } from './layers/stations';
import { startTrains, type TrainsHandle } from './realtime/trains-controller';
import { setupStationPopups } from './ui/station-popup';
import { setupHoverTooltips } from './ui/hover-tooltip';
import { addLegend } from './ui/legend';
import { startAircraft, AIRCRAFT_LAYER_ID } from './layers/aircraft';
import { startVessels, VESSELS_LAYER_ID } from './layers/vessels';
import { addJamCams, JAMCAMS_LAYER_ID } from './layers/jamcams';
import { startNrTrains, NR_TRAINS_LAYER_ID } from './realtime/nr-trains';
import { startBuses, BUSES_DOTS_LAYER_ID, BUSES_ICONS_LAYER_ID } from './layers/buses';
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
        url: 'pmtiles:///london.pmtiles',
        attribution:
          '<a href="https://protomaps.com">Protomaps</a> © <a href="https://openstreetmap.org">OpenStreetMap</a>',
      },
    },
    layers: layers('protomaps', namedFlavor('dark'), { lang: 'en' }),
  },
  center: initialView.center,
  zoom: initialView.zoom,
  maxBounds: LONDON_BOUNDS,
  attributionControl: { compact: true },
});

map.addControl(new maplibregl.NavigationControl(), 'top-right');
map.addControl(new maplibregl.ScaleControl(), 'bottom-left');

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
