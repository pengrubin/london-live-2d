// TfL road disruptions (roadworks, closures, collisions). Impact polygons
// render as a translucent fill + outline; every disruption also gets a point
// marker at its location (or polygon centroid). Refreshed every 2 minutes.

import {
  Popup,
  type GeoJSONSource,
  type Map as MaplibreMap,
  type MapLayerMouseEvent,
} from 'maplibre-gl';

export const ROAD_DISRUPTIONS_FILL_LAYER_ID = 'road-disruptions-fill';
export const ROAD_DISRUPTIONS_OUTLINE_LAYER_ID = 'road-disruptions-outline';
export const ROAD_DISRUPTIONS_DOTS_LAYER_ID = 'road-disruptions-dots';
export const ROAD_DISRUPTIONS_LAYER_IDS = [
  ROAD_DISRUPTIONS_FILL_LAYER_ID,
  ROAD_DISRUPTIONS_OUTLINE_LAYER_ID,
  ROAD_DISRUPTIONS_DOTS_LAYER_ID,
];

const SOURCE_ID = 'road-disruptions';
const MIN_ZOOM = 10;
const POLL_INTERVAL_MS = 120_000;
const FILL_OPACITY = 0.25;
const COMMENTS_TRUNCATE_AT = 300;

/** Severe/Serious read as red, Moderate as amber; anything milder stays dim. */
const SEVERITY_COLORS: Record<string, string> = {
  Severe: '#d43',
  Serious: '#d43',
  Moderate: '#da3',
};
const DEFAULT_COLOR = '#8a94a0';

type LngLat = [number, number];

interface DisruptionGeography {
  type?: string;
  coordinates?: unknown;
}

interface RoadDisruption {
  id?: string;
  category?: string;
  severity?: string;
  location?: string;
  comments?: string;
  /** JSON-encoded "[lon,lat]" string, e.g. "[-0.058822,51.659637]" */
  point?: string;
  geography?: DisruptionGeography;
}

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);

function isLngLat(value: unknown): value is LngLat {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1])
  );
}

/** Outer-ring vertex average — plenty for placing a marker on a works area. */
function ringCentroid(ring: unknown): LngLat | null {
  if (!Array.isArray(ring) || ring.length === 0) return null;
  const points = ring.filter(isLngLat);
  if (points.length === 0) return null;
  const sum = points.reduce<LngLat>((acc, p) => [acc[0] + p[0], acc[1] + p[1]], [0, 0]);
  return [sum[0] / points.length, sum[1] / points.length];
}

function markerPosition(d: RoadDisruption): LngLat | null {
  if (typeof d.point === 'string') {
    try {
      const parsed: unknown = JSON.parse(d.point);
      if (isLngLat(parsed)) return [parsed[0], parsed[1]];
    } catch {
      // fall through to geography
    }
  }
  const g = d.geography;
  if (g?.type === 'Point' && isLngLat(g.coordinates)) return [g.coordinates[0], g.coordinates[1]];
  if (g?.type === 'Polygon' && Array.isArray(g.coordinates)) return ringCentroid(g.coordinates[0]);
  if (g?.type === 'MultiPolygon' && Array.isArray(g.coordinates)) {
    const first: unknown = g.coordinates[0];
    return Array.isArray(first) ? ringCentroid(first[0]) : null;
  }
  return null;
}

interface DisruptionProps {
  category: string;
  severity: string;
  location: string;
  comments: string;
  color: string;
}

function toProps(d: RoadDisruption): DisruptionProps {
  return {
    category: d.category ?? 'Disruption',
    severity: d.severity ?? 'Unknown',
    location: d.location ?? '',
    comments: d.comments ?? '',
    color: SEVERITY_COLORS[d.severity ?? ''] ?? DEFAULT_COLOR,
  };
}

function toFeatures(disruptions: RoadDisruption[]): GeoJSON.Feature[] {
  return disruptions.flatMap((d) => {
    const props = toProps(d);
    const features: GeoJSON.Feature[] = [];
    const g = d.geography;
    if ((g?.type === 'Polygon' || g?.type === 'MultiPolygon') && Array.isArray(g.coordinates)) {
      features.push({
        type: 'Feature',
        properties: props,
        geometry: { type: g.type, coordinates: g.coordinates } as GeoJSON.Geometry,
      });
    }
    const at = markerPosition(d);
    if (at) {
      features.push({
        type: 'Feature',
        properties: props,
        geometry: { type: 'Point', coordinates: at },
      });
    }
    return features;
  });
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}

function popupHtml(p: DisruptionProps): string {
  const badge = `<span style="background:${esc(p.color)};color:#0a0a0a;border-radius:3px;
    padding:1px 6px;font-weight:600">${esc(p.severity)}</span>`;
  const comments = p.comments ? `<div>${esc(truncate(p.comments, COMMENTS_TRUNCATE_AT))}</div>` : '';
  return `<div class="vp"><div class="sp-title">⚠️ ${esc(p.category)} ${badge}</div>
    ${p.location ? `<div class="vp-dim">${esc(p.location)}</div>` : ''}
    ${comments}</div>`;
}

function wireInteractions(map: MaplibreMap, layerId: string): void {
  const tip = new Popup({ closeButton: false, closeOnClick: false, offset: 10, className: 'hover-tip' });
  map.on('mousemove', layerId, (e: MapLayerMouseEvent) => {
    const p = e.features?.[0]?.properties as DisruptionProps | undefined;
    if (!p) return;
    map.getCanvas().style.cursor = 'pointer';
    tip
      .setLngLat(e.lngLat)
      .setHTML(
        `<div class="vp">⚠️ ${esc(p.category)}${p.location ? `<div class="vp-dim">${esc(p.location)}</div>` : ''}</div>`,
      )
      .addTo(map);
  });
  map.on('mouseleave', layerId, () => {
    map.getCanvas().style.cursor = '';
    tip.remove();
  });

  const detail = new Popup({ closeButton: true, closeOnClick: true, offset: 12, maxWidth: '340px' });
  map.on('click', layerId, (e: MapLayerMouseEvent) => {
    const p = e.features?.[0]?.properties as DisruptionProps | undefined;
    if (!p) return;
    tip.remove();
    detail.setLngLat(e.lngLat).setHTML(popupHtml(p)).addTo(map);
  });
}

export async function startRoadDisruptions(map: MaplibreMap): Promise<void> {
  map.addSource(SOURCE_ID, {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });
  map.addLayer(
    {
      id: ROAD_DISRUPTIONS_FILL_LAYER_ID,
      type: 'fill',
      source: SOURCE_ID,
      minzoom: MIN_ZOOM,
      filter: ['==', ['geometry-type'], 'Polygon'],
      paint: {
        'fill-color': ['get', 'color'],
        'fill-opacity': FILL_OPACITY,
      },
    },
    'stations-circle', // beneath station dots and vehicles, like JamCams
  );
  map.addLayer(
    {
      id: ROAD_DISRUPTIONS_OUTLINE_LAYER_ID,
      type: 'line',
      source: SOURCE_ID,
      minzoom: MIN_ZOOM,
      filter: ['==', ['geometry-type'], 'Polygon'],
      paint: {
        'line-color': ['get', 'color'],
        'line-width': 1.5,
        'line-opacity': 0.8,
      },
    },
    'stations-circle',
  );
  map.addLayer(
    {
      id: ROAD_DISRUPTIONS_DOTS_LAYER_ID,
      type: 'circle',
      source: SOURCE_ID,
      minzoom: MIN_ZOOM,
      filter: ['==', ['geometry-type'], 'Point'],
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], MIN_ZOOM, 3, 15, 6.5],
        'circle-color': ['get', 'color'],
        'circle-stroke-color': '#0a0a0a',
        'circle-stroke-width': 1,
        'circle-opacity': 0.9,
      },
    },
    'stations-circle',
  );

  async function poll(): Promise<void> {
    try {
      const res = await fetch('/api/road-disruptions');
      if (!res.ok) return;
      const list = (await res.json()) as RoadDisruption[];
      if (!Array.isArray(list)) return;
      const src = map.getSource(SOURCE_ID);
      if (src && 'setData' in src) {
        (src as GeoJSONSource).setData({
          type: 'FeatureCollection',
          features: toFeatures(list),
        });
      }
    } catch {
      // keep the previous picture
    }
  }

  wireInteractions(map, ROAD_DISRUPTIONS_DOTS_LAYER_ID);
  wireInteractions(map, ROAD_DISRUPTIONS_FILL_LAYER_ID);

  await poll();
  window.setInterval(() => void poll(), POLL_INTERVAL_MS);
}
