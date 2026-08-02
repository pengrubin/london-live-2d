// Environment Agency tide gauges along the tidal Thames (Teddington→Tilbury).
// Deep-blue dots with a small ▲/▼ arrow while the tide is rising/falling.
// Levels are metres AOD, published every 15 min; we poll our proxy every 5 min.

import {
  Popup,
  type GeoJSONSource,
  type Map as MaplibreMap,
  type MapLayerMouseEvent,
} from 'maplibre-gl';
import { registerPoll } from '../util/lifecycle';
import { below } from '../util/layer-order';

const DOTS_LAYER_ID = 'tide-gauges-dots';
const ARROWS_LAYER_ID = 'tide-gauges-arrows';
export const TIDE_GAUGES_LAYER_IDS = [DOTS_LAYER_ID, ARROWS_LAYER_ID];
const SOURCE_ID = 'tide-gauges';
const MIN_ZOOM = 10;
const POLL_INTERVAL_MS = 300_000; // EA updates every 15 min; 5 min keeps us fresh
const GAUGE_COLOR = '#3B7DD8';

type TideTrend = 'rising' | 'falling' | 'steady';

interface TideGauge {
  ref: string;
  label: string;
  lat: number;
  lon: number;
  levelM: number;
  readingAt: string;
  trend: TideTrend;
}

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);

const TREND_GLYPH: Record<TideTrend, string> = { rising: '▲', falling: '▼', steady: '·' };

/** Small triangle icon (canvas, not glyphs — ▲▼ may be missing from the font). */
function makeTrendIcon(pointsUp: boolean): ImageData {
  const size = 18;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const x = c.getContext('2d');
  if (!x) throw new Error('2d canvas unavailable');
  x.translate(size / 2, size / 2);
  if (!pointsUp) x.rotate(Math.PI);
  x.beginPath();
  x.moveTo(0, -6);
  x.lineTo(6, 5);
  x.lineTo(-6, 5);
  x.closePath();
  x.fillStyle = '#9EC4F5';
  x.fill();
  x.strokeStyle = '#0a0a0a';
  x.lineWidth = 1.5;
  x.stroke();
  return x.getImageData(0, 0, size, size);
}

function toFeatures(gauges: TideGauge[]): GeoJSON.Feature[] {
  return gauges
    .filter((g) => typeof g.lat === 'number' && typeof g.lon === 'number')
    .map((g) => ({
      type: 'Feature' as const,
      properties: {
        ref: g.ref,
        label: g.label,
        levelM: g.levelM,
        readingAt: g.readingAt,
        trend: g.trend,
      },
      geometry: { type: 'Point' as const, coordinates: [g.lon, g.lat] },
    }));
}

function levelLine(levelM: number, trend: TideTrend): string {
  return `${levelM.toFixed(2)} m ${TREND_GLYPH[trend]} ${trend}`;
}

function readingTime(readingAt: string): string {
  const at = new Date(readingAt);
  if (Number.isNaN(at.getTime())) return readingAt;
  return at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export async function startTideGauges(map: MaplibreMap): Promise<void> {
  if (!map.hasImage('tide-rising')) {
    map.addImage('tide-rising', makeTrendIcon(true), { pixelRatio: 2 });
  }
  if (!map.hasImage('tide-falling')) {
    map.addImage('tide-falling', makeTrendIcon(false), { pixelRatio: 2 });
  }

  map.addSource(SOURCE_ID, {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });
  map.addLayer(
    {
      id: DOTS_LAYER_ID,
      type: 'circle',
      source: SOURCE_ID,
      minzoom: MIN_ZOOM,
      paint: {
        // slightly larger than the JamCam dots so gauges read on the river
        'circle-radius': ['interpolate', ['linear'], ['zoom'], MIN_ZOOM, 3, 15, 6.5],
        'circle-color': GAUGE_COLOR,
        'circle-stroke-color': '#0a0a0a',
        'circle-stroke-width': 1,
        'circle-opacity': 0.9,
      },
    },
    below(map, 'stations-circle'), // gauges sit beneath station dots and vehicles
  );
  map.addLayer(
    {
      id: ARROWS_LAYER_ID,
      type: 'symbol',
      source: SOURCE_ID,
      minzoom: MIN_ZOOM,
      filter: ['!=', ['get', 'trend'], 'steady'],
      layout: {
        'icon-image': ['concat', 'tide-', ['get', 'trend']],
        'icon-size': ['interpolate', ['linear'], ['zoom'], MIN_ZOOM, 0.6, 15, 1],
        'icon-offset': [0, -14],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
    },
    below(map, 'stations-circle'),
  );

  async function poll(): Promise<void> {
    try {
      const res = await fetch('/api/tide-gauges');
      if (!res.ok) return;
      const gauges = (await res.json()) as TideGauge[];
      if (!Array.isArray(gauges)) return;
      const src = map.getSource(SOURCE_ID);
      if (src && 'setData' in src) {
        (src as GeoJSONSource).setData({
          type: 'FeatureCollection',
          features: toFeatures(gauges),
        });
      }
    } catch {
      // keep the previous picture
    }
  }

  const tip = new Popup({ closeButton: false, closeOnClick: false, offset: 10, className: 'hover-tip' });
  map.on('mousemove', DOTS_LAYER_ID, (e: MapLayerMouseEvent) => {
    const p = e.features?.[0]?.properties as
      | { label?: string; levelM?: number; trend?: TideTrend }
      | undefined;
    if (!p || typeof p.levelM !== 'number') return;
    map.getCanvas().style.cursor = 'pointer';
    tip
      .setLngLat(e.lngLat)
      .setHTML(
        `<div class="vp"><b>${esc(p.label ?? 'Tide gauge')}</b><div class="vp-dim">${esc(levelLine(p.levelM, p.trend ?? 'steady'))}</div></div>`,
      )
      .addTo(map);
  });
  map.on('mouseleave', DOTS_LAYER_ID, () => {
    map.getCanvas().style.cursor = '';
    tip.remove();
  });

  const detail = new Popup({ closeButton: true, closeOnClick: true, offset: 12, maxWidth: '300px' });
  map.on('click', DOTS_LAYER_ID, (e: MapLayerMouseEvent) => {
    const p = e.features?.[0]?.properties as
      | { label?: string; levelM?: number; readingAt?: string; trend?: TideTrend }
      | undefined;
    if (!p || typeof p.levelM !== 'number') return;
    tip.remove();
    const trend = p.trend ?? 'steady';
    detail
      .setLngLat(e.lngLat)
      .setHTML(
        `<div class="vp"><div class="sp-title">🌊 ${esc(p.label ?? 'Tide gauge')}</div>
        <div>${esc(levelLine(p.levelM, trend))}</div>
        <div class="vp-dim">reading at ${esc(readingTime(p.readingAt ?? ''))}</div>
        <div class="vp-dim">Thames is tidal up to Teddington</div></div>`,
      )
      .addTo(map);
  });

  await poll();
  registerPoll(() => void poll(), POLL_INTERVAL_MS);
}
