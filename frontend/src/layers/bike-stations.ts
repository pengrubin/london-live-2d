// Docked bike-share stations from any GBFS feed, served by /api/bikes.
//
// Colour encodes what a rider actually wants to know at a glance: whether the
// station is worth walking to. Empty and full are both failures, so the ramp
// runs red (no bikes) → amber → green (plenty), and a full station with no
// space to return one is drawn hollow.

import {
  Popup,
  type GeoJSONSource,
  type Map as MaplibreMap,
  type MapLayerMouseEvent,
} from 'maplibre-gl';
import { registerPoll } from '../util/lifecycle';
import { below } from '../util/layer-order';

export const BIKE_STATIONS_LAYER_ID = 'bike-stations-dots';
const SOURCE_ID = 'bike-stations';
const MIN_ZOOM = 11;
/** The feed itself refreshes about once a minute; matching it is enough. */
const POLL_INTERVAL_MS = 60_000;

const EMPTY_COLOR = '#E05A47';
const LOW_COLOR = '#E8A33D';
const OK_COLOR = '#3FB47F';
const CLOSED_COLOR = '#6b7280';

/** Wire row from /api/bikes — short keys, hundreds of stations. */
interface BikeStationWire {
  i: string;
  n: string;
  x: number;
  y: number;
  b: number;
  d: number;
  c: number | null;
  r: 0 | 1;
}

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);

function toFeatures(rows: readonly BikeStationWire[]): GeoJSON.Feature[] {
  return rows.map((s) => ({
    type: 'Feature',
    properties: { name: s.n, bikes: s.b, docks: s.d, capacity: s.c, renting: s.r },
    geometry: { type: 'Point', coordinates: [s.x, s.y] },
  }));
}

function availabilityLine(bikes: number, docks: number, renting: number): string {
  if (!renting) return 'not renting';
  if (bikes === 0) return `no bikes · ${docks} space${docks === 1 ? '' : 's'} to return one`;
  if (docks === 0) return `${bikes} bike${bikes === 1 ? '' : 's'} · no space to return`;
  return `${bikes} bike${bikes === 1 ? '' : 's'} · ${docks} space${docks === 1 ? '' : 's'}`;
}

export async function startBikeStations(map: MaplibreMap): Promise<void> {
  map.addSource(SOURCE_ID, {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });

  map.addLayer(
    {
      id: BIKE_STATIONS_LAYER_ID,
      type: 'circle',
      source: SOURCE_ID,
      minzoom: MIN_ZOOM,
      paint: {
        // Size tracks how many bikes are there, so a busy station reads first.
        'circle-radius': [
          'interpolate',
          ['linear'],
          ['zoom'],
          MIN_ZOOM,
          2.5,
          16,
          ['interpolate', ['linear'], ['get', 'bikes'], 0, 4, 20, 9],
        ],
        'circle-color': [
          'case',
          ['==', ['get', 'renting'], 0],
          CLOSED_COLOR,
          ['==', ['get', 'bikes'], 0],
          EMPTY_COLOR,
          ['<=', ['get', 'bikes'], 3],
          LOW_COLOR,
          OK_COLOR,
        ],
        // Hollow when there is nowhere to return a bike — the other failure
        // mode, and invisible if colour only encoded availability.
        'circle-opacity': ['case', ['==', ['get', 'docks'], 0], 0.25, 0.9],
        'circle-stroke-color': '#0a0a0a',
        'circle-stroke-width': 1,
      },
    },
    below(map, 'stations-circle'), // beneath rail stations and vehicles
  );

  async function poll(): Promise<void> {
    try {
      const res = await fetch('/api/bikes');
      if (!res.ok) return;
      const rows = (await res.json()) as BikeStationWire[];
      if (!Array.isArray(rows)) return;
      const src = map.getSource(SOURCE_ID);
      if (src && 'setData' in src) {
        (src as GeoJSONSource).setData({
          type: 'FeatureCollection',
          features: toFeatures(rows),
        });
      }
    } catch {
      // keep the previous picture rather than blanking the layer
    }
  }

  const tip = new Popup({
    closeButton: false,
    closeOnClick: false,
    offset: 10,
    className: 'hover-tip',
  });
  map.on('mousemove', BIKE_STATIONS_LAYER_ID, (e: MapLayerMouseEvent) => {
    const p = e.features?.[0]?.properties as
      | { name?: string; bikes?: number; docks?: number; capacity?: number | null; renting?: number }
      | undefined;
    if (!p || typeof p.bikes !== 'number') return;
    map.getCanvas().style.cursor = 'pointer';
    const capacity = typeof p.capacity === 'number' ? ` of ${p.capacity}` : '';
    tip
      .setLngLat(e.lngLat)
      .setHTML(
        `<div class="vp"><b>🚲 ${esc(p.name ?? 'Bike station')}</b>` +
          `<div class="vp-dim">${esc(availabilityLine(p.bikes, p.docks ?? 0, p.renting ?? 1))}${esc(capacity)}</div></div>`,
      )
      .addTo(map);
  });
  map.on('mouseleave', BIKE_STATIONS_LAYER_ID, () => {
    map.getCanvas().style.cursor = '';
    tip.remove();
  });

  await poll();
  registerPoll(() => void poll(), POLL_INTERVAL_MS);
}
