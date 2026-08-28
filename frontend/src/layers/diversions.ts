// Live bus-diversion events from the detector (/api/diversions). Each event's
// bypassed learned-polyline slices draw as a prominent red line with a small
// dot at the centroid. The API returns only display-worthy events — the
// frontend renders exactly what it is given, no client-side filtering.
//
// Polling is gated on the overlay toggle (default ON): the detector output
// only changes every rollup pass, so a hidden overlay polling anyway would be
// pure egress waste. Re-enabling refreshes immediately since the last picture
// may be a whole off-interval stale.

import {
  Popup,
  type ExpressionSpecification,
  type GeoJSONSource,
  type Map as MaplibreMap,
  type MapLayerMouseEvent,
} from 'maplibre-gl';
import { registerPoll } from '../util/lifecycle';
import { below } from '../util/layer-order';

export const DIVERSIONS_SEGMENTS_LAYER_ID = 'diversions-segments';
export const DIVERSIONS_DOTS_LAYER_ID = 'diversions-dots';
export const DIVERSIONS_LAYER_IDS = [DIVERSIONS_SEGMENTS_LAYER_ID, DIVERSIONS_DOTS_LAYER_ID];

const SOURCE_ID = 'diversions';
const DIVERSIONS_URL = '/api/diversions';
/** The API caches for 60 s; 90 s keeps at most one wasted hit per fresh copy. */
const POLL_INTERVAL_MS = 90_000;

/** Status drives the lifecycle look (recovering = healing green, stale =
 * faded furniture); among ACTIVE events, severity splits red from amber:
 * 'road' (>=2 route-directions divert — the road has a problem) stays loud
 * red, 'partial' (one direction of one route; the road otherwise flows)
 * drops to amber so it never reads as a closure. */
const STATUS_COLOR: ExpressionSpecification = [
  'match', ['get', 'status'],
  'recovering', '#4c5',
  'stale', '#8a94a0',
  ['match', ['get', 'severity'], 'partial', '#f0a030', '#e33'],
];
const STATUS_OPACITY: ExpressionSpecification =
  ['match', ['get', 'status'], 'recovering', 0.7, 'stale', 0.35, 0.9];

type LngLat = [number, number];

interface DiversionEvent {
  id?: string;
  status?: 'active' | 'recovering' | 'stale';
  severity?: 'road' | 'partial';
  startedAt?: number;
  lastEvidenceAt?: number;
  routes?: string[];
  vehicles?: number;
  longRunning?: boolean;
  centroid?: unknown;
  segments?: unknown;
  tfl?: { loc?: string; dist?: number } | null;
}

interface DiversionsResponse {
  generatedAt?: number;
  events?: DiversionEvent[];
}

/** Flat because maplibre JSON-round-trips feature properties; a nested `tfl`
 * object would come back out of queryRenderedFeatures as a string. */
interface DiversionProps {
  routes: string;
  vehicles: number;
  status: string;
  severity: string;
  longRunning: boolean;
  startedAt: number;
  hasTfl: boolean;
  tflLoc: string;
  tflDist: number;
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

function toProps(ev: DiversionEvent): DiversionProps {
  return {
    // Numeric-aware so "9" sorts before "10" and "N136" after "45" — the same
    // idiom as listActiveBusLines in layers/buses.ts.
    routes: [...(ev.routes ?? [])]
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .join(', '),
    vehicles: ev.vehicles ?? 0,
    status: ev.status ?? 'active',
    severity: ev.severity ?? 'road',
    longRunning: ev.longRunning === true,
    startedAt: ev.startedAt ?? 0,
    hasTfl: ev.tfl != null,
    tflLoc: ev.tfl?.loc ?? '',
    tflDist: ev.tfl?.dist ?? 0,
  };
}

function toFeatures(events: DiversionEvent[]): GeoJSON.Feature[] {
  return events.flatMap((ev) => {
    const props = toProps(ev);
    const features: GeoJSON.Feature[] = [];
    // One MultiLineString per event, not a feature per slice: the popup should
    // hit the whole event wherever it is clicked.
    // Every point must validate — one bad coordinate in an otherwise-valid
    // segment would otherwise reach setData and break the whole source.
    const segments = Array.isArray(ev.segments)
      ? ev.segments.filter(
          (seg): seg is LngLat[] => Array.isArray(seg) && seg.length >= 2 && seg.every(isLngLat),
        )
      : [];
    if (segments.length > 0) {
      features.push({
        type: 'Feature',
        properties: props,
        geometry: { type: 'MultiLineString', coordinates: segments },
      });
    }
    if (isLngLat(ev.centroid)) {
      features.push({
        type: 'Feature',
        properties: props,
        geometry: { type: 'Point', coordinates: [ev.centroid[0], ev.centroid[1]] },
      });
    }
    return features;
  });
}

const STATUS_WORDS: Record<string, string> = {
  active: 'Buses diverting now',
  recovering: 'Buses returning to route',
  stale: 'No recent evidence',
};

/** Bare HH:MM misleads once the event started on an earlier day (or has run
 * >24 h): "since 09:15" would read as this morning. Add the date then. */
const timeLabel = (epochSec: number, longRunning: boolean): string => {
  const started = new Date(epochSec * 1000);
  const isToday = started.toDateString() === new Date().toDateString();
  return isToday && !longRunning
    ? started.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : started.toLocaleString([], {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
};

function popupHtml(p: DiversionProps): string {
  // 'partial' softens everything: one direction of one route is diverting
  // while the road itself flows — "Diversion" + red would read as a closure.
  const partial = p.severity === 'partial';
  const title = partial ? '⚠️ Some buses diverting' : '🚧 Diversion';
  const status = partial && p.status === 'active'
    ? 'Other routes and directions running normally'
    : (STATUS_WORDS[p.status] ?? p.status);
  const ongoing = p.longRunning ? ' · ongoing >24h' : '';
  const tfl = p.hasTfl
    ? `TfL: ${esc(p.tflLoc)} (~${Math.round(p.tflDist)}m)`
    : 'no matching roadworks record';
  return `<div class="vp"><div class="sp-title">${title} — ${esc(p.routes)}</div>
    <div>${esc(status)}${ongoing}</div>
    <div>since ${timeLabel(p.startedAt, p.longRunning)} · ${p.vehicles} vehicle${p.vehicles === 1 ? '' : 's'}</div>
    <div class="vp-dim">${tfl}</div></div>`;
}

function wireInteractions(map: MaplibreMap, layerId: string): void {
  const detail = new Popup({ closeButton: true, closeOnClick: true, offset: 12, maxWidth: '320px' });
  map.on('click', layerId, (e: MapLayerMouseEvent) => {
    const p = e.features?.[0]?.properties as DiversionProps | undefined;
    if (!p) return;
    detail.setLngLat(e.lngLat).setHTML(popupHtml(p)).addTo(map);
  });
  map.on('mouseenter', layerId, () => {
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', layerId, () => {
    map.getCanvas().style.cursor = '';
  });
}

/** ON by default, mirroring the legend row (no startOff). */
let overlayOn = true;
/** Set by startDiversions so the toggle can force an immediate refresh. */
let refresh: (() => void) | null = null;

/** Legend toggle handler: visibility flip + poll gate. */
export function setDiversionsVisible(map: MaplibreMap, visible: boolean): void {
  overlayOn = visible;
  for (const id of DIVERSIONS_LAYER_IDS) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
  }
  if (visible) refresh?.();
}

export async function startDiversions(map: MaplibreMap): Promise<void> {
  map.addSource(SOURCE_ID, {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });
  // Same anchor as roadworks: stations-circle sits above the transit lines
  // (and the coverage glow beneath them) but below every vehicle layer, so
  // inserting under it lands exactly between the static network and the dots.
  map.addLayer(
    {
      id: DIVERSIONS_SEGMENTS_LAYER_ID,
      type: 'line',
      source: SOURCE_ID,
      filter: ['==', ['geometry-type'], 'LineString'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': STATUS_COLOR,
        'line-opacity': STATUS_OPACITY,
        'line-width': ['interpolate', ['linear'], ['zoom'], 9, 2, 13, 4, 16, 6],
      },
    },
    below(map, 'stations-circle'),
  );
  map.addLayer(
    {
      id: DIVERSIONS_DOTS_LAYER_ID,
      type: 'circle',
      source: SOURCE_ID,
      filter: ['==', ['geometry-type'], 'Point'],
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 3, 15, 6],
        'circle-color': STATUS_COLOR,
        'circle-opacity': STATUS_OPACITY,
        'circle-stroke-color': '#0a0a0a',
        'circle-stroke-width': 1,
      },
    },
    below(map, 'stations-circle'),
  );

  async function poll(): Promise<void> {
    if (!overlayOn) return;
    try {
      const res = await fetch(DIVERSIONS_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as DiversionsResponse;
      // A 200 from an intermediary (error page, captive portal) must not reach
      // setData; empty `events` is fine and clears the layer.
      if (!Array.isArray(body?.events)) throw new Error('unexpected diversions payload shape');
      const src = map.getSource(SOURCE_ID);
      if (src && 'setData' in src) {
        (src as GeoJSONSource).setData({
          type: 'FeatureCollection',
          features: toFeatures(body.events),
        });
      }
    } catch (error) {
      // Keep the last picture; the next poll retries.
      console.warn('[diversions]', error);
    }
  }
  refresh = () => void poll();

  wireInteractions(map, DIVERSIONS_SEGMENTS_LAYER_ID);
  wireInteractions(map, DIVERSIONS_DOTS_LAYER_ID);

  await poll();
  registerPoll(() => void poll(), POLL_INTERVAL_MS);
}
