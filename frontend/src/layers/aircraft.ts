// Live aircraft over London (ADS-B). Positions are real GPS — no inference —
// with per-frame dead reckoning from speed/track between 5 s polls.

import {
  Popup,
  type GeoJSONSource,
  type Map as MaplibreMap,
  type MapLayerMouseEvent,
} from 'maplibre-gl';
import { isLayerShown, makeRenderGate, SYMBOL_TIER_INTERVAL_MS } from '../util/render-gate';

export const AIRCRAFT_LAYER_ID = 'aircraft-icons';
const SOURCE_ID = 'aircraft';
const POLL_INTERVAL_MS = 5_000;
const KN_TO_MS = 0.514444;
const M_PER_DEG_LAT = 110540;
const M_PER_DEG_LON = 111320 * Math.cos((51.5 * Math.PI) / 180);

interface Aircraft {
  hex: string;
  flight?: string;
  r?: string; // registration
  t?: string; // type code
  desc?: string;
  alt_baro?: number | 'ground';
  gs?: number; // knots
  track?: number;
  lat?: number;
  lon?: number;
  category?: string;
}

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);

const isHelicopter = (a: Aircraft): boolean => a.category === 'A7';

function makePlaneIcon(): ImageData {
  const c = document.createElement('canvas');
  c.width = 48;
  c.height = 48;
  const x = c.getContext('2d');
  if (!x) throw new Error('2d canvas unavailable');
  x.translate(24, 24);
  x.beginPath();
  // fuselage (nose up)
  x.moveTo(0, -18);
  x.quadraticCurveTo(3, -10, 2.5, -4);
  // right wing
  x.lineTo(19, 4);
  x.lineTo(19, 8);
  x.lineTo(2.5, 5);
  // tail
  x.lineTo(2, 13);
  x.lineTo(7, 17);
  x.lineTo(7, 19.5);
  x.lineTo(0, 18);
  x.lineTo(-7, 19.5);
  x.lineTo(-7, 17);
  x.lineTo(-2, 13);
  // left wing
  x.lineTo(-2.5, 5);
  x.lineTo(-19, 8);
  x.lineTo(-19, 4);
  x.lineTo(-2.5, -4);
  x.quadraticCurveTo(-3, -10, 0, -18);
  x.closePath();
  x.fillStyle = '#f5d90a';
  x.fill();
  x.strokeStyle = '#1a1a1a';
  x.lineWidth = 1.5;
  x.stroke();
  return x.getImageData(0, 0, 48, 48);
}

function makeHeliIcon(): ImageData {
  const c = document.createElement('canvas');
  c.width = 40;
  c.height = 40;
  const x = c.getContext('2d');
  if (!x) throw new Error('2d canvas unavailable');
  x.translate(20, 20);
  // body
  x.beginPath();
  x.ellipse(0, 2, 6, 9, 0, 0, Math.PI * 2);
  x.fillStyle = '#ffa726';
  x.fill();
  x.strokeStyle = '#1a1a1a';
  x.lineWidth = 1.5;
  x.stroke();
  // rotor cross
  x.strokeStyle = '#f5f5f5';
  x.lineWidth = 2;
  x.beginPath();
  x.moveTo(-13, -11);
  x.lineTo(13, 15);
  x.moveTo(13, -11);
  x.lineTo(-13, 15);
  x.stroke();
  return x.getImageData(0, 0, 40, 40);
}

function altitudeLabel(alt: number | 'ground' | undefined): string {
  if (alt === 'ground') return 'on ground';
  if (typeof alt !== 'number') return '';
  return `${alt.toLocaleString()} ft`;
}

interface RouteInfo {
  origin: string;
  destination: string;
}

async function fetchRoute(callsign: string): Promise<RouteInfo | null> {
  try {
    const res = await fetch(`/api/callsign?cs=${encodeURIComponent(callsign)}`);
    if (!res.ok) return null;
    const json = (await res.json()) as {
      response?: {
        flightroute?: {
          origin?: { iata_code?: string; municipality?: string };
          destination?: { iata_code?: string; municipality?: string };
        };
      };
    };
    const fr = json.response?.flightroute;
    if (!fr?.origin || !fr.destination) return null;
    const fmt = (a: { iata_code?: string; municipality?: string }): string =>
      a.municipality ? `${a.municipality} (${a.iata_code ?? '?'})` : (a.iata_code ?? '?');
    return { origin: fmt(fr.origin), destination: fmt(fr.destination) };
  } catch {
    return null;
  }
}

export async function startAircraft(map: MaplibreMap): Promise<void> {
  if (!map.hasImage('ac-plane')) map.addImage('ac-plane', makePlaneIcon(), { pixelRatio: 2 });
  if (!map.hasImage('ac-heli')) map.addImage('ac-heli', makeHeliIcon(), { pixelRatio: 2 });

  map.addSource(SOURCE_ID, {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });
  map.addLayer({
    id: AIRCRAFT_LAYER_ID,
    type: 'symbol',
    source: SOURCE_ID,
    layout: {
      'icon-image': ['get', 'icon'],
      'icon-size': ['interpolate', ['linear'], ['zoom'],
        9, ['case', ['==', ['get', 'ground'], 1], 0.33, 0.55],
        13, ['case', ['==', ['get', 'ground'], 1], 0.48, 0.8]],
      'icon-rotate': ['get', 'track'],
      'icon-rotation-alignment': 'map',
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
    paint: {
      'icon-opacity': ['case', ['==', ['get', 'ground'], 1], 0.45, 1],
    },
  });

  let fleet: Aircraft[] = [];
  let fetchedAt = 0;

  async function poll(): Promise<void> {
    try {
      const res = await fetch('/api/aircraft');
      if (!res.ok) return;
      const json = (await res.json()) as { ac?: Aircraft[] };
      fleet = (json.ac ?? []).filter(
        (a) =>
          typeof a.lat === 'number' &&
          typeof a.lon === 'number' &&
          !(a.category ?? '').startsWith('C'), // ground vehicles/obstacles
      );
      fetchedAt = Date.now();
    } catch {
      // keep dead-reckoning the previous fleet
    }
  }

  const renderGate = makeRenderGate(SYMBOL_TIER_INTERVAL_MS);
  let lastWasEmpty = false;
  function render(frameNow: number): void {
    if (!renderGate(frameNow) || !isLayerShown(map, AIRCRAFT_LAYER_ID)) {
      requestAnimationFrame(render);
      return;
    }
    if (fleet.length === 0 && lastWasEmpty) {
      requestAnimationFrame(render);
      return;
    }
    const dtS = (Date.now() - fetchedAt) / 1000;
    const features = fleet.map((a) => {
      const speedMs = a.alt_baro === 'ground' ? 0 : (a.gs ?? 0) * KN_TO_MS;
      const rad = (((a.track ?? 0) - 0) * Math.PI) / 180;
      const lon = (a.lon as number) + (speedMs * dtS * Math.sin(rad)) / M_PER_DEG_LON;
      const lat = (a.lat as number) + (speedMs * dtS * Math.cos(rad)) / M_PER_DEG_LAT;
      return {
        type: 'Feature' as const,
        properties: {
          hex: a.hex,
          icon: isHelicopter(a) ? 'ac-heli' : 'ac-plane',
          callsign: (a.flight ?? '').trim(),
          reg: a.r ?? '',
          typeCode: a.t ?? '',
          desc: a.desc ?? '',
          alt: altitudeLabel(a.alt_baro),
          ground: a.alt_baro === 'ground' ? 1 : 0,
          gs: a.gs ?? 0,
          track: a.track ?? 0,
        },
        geometry: { type: 'Point' as const, coordinates: [lon, lat] },
      };
    });
    const src = map.getSource(SOURCE_ID);
    if (src && 'setData' in src) {
      (src as GeoJSONSource).setData({ type: 'FeatureCollection', features });
    }
    lastWasEmpty = features.length === 0;
    requestAnimationFrame(render);
  }

  // ── hover + click ──
  const tip = new Popup({ closeButton: false, closeOnClick: false, offset: 12, className: 'hover-tip' });
  map.on('mousemove', AIRCRAFT_LAYER_ID, (e: MapLayerMouseEvent) => {
    const p = e.features?.[0]?.properties as Record<string, string | number> | undefined;
    if (!p) return;
    map.getCanvas().style.cursor = 'pointer';
    tip
      .setLngLat(e.lngLat)
      .setHTML(
        `<div class="vp"><b>${esc(String(p.callsign || p.reg || p.hex))}</b> ${esc(String(p.typeCode))}<div class="vp-dim">${esc(String(p.alt))} · ${Math.round(Number(p.gs))} kn</div></div>`,
      )
      .addTo(map);
  });
  map.on('mouseleave', AIRCRAFT_LAYER_ID, () => {
    map.getCanvas().style.cursor = '';
    tip.remove();
  });

  const detail = new Popup({ closeButton: true, closeOnClick: true, offset: 14, maxWidth: '300px' });
  map.on('click', AIRCRAFT_LAYER_ID, (e: MapLayerMouseEvent) => {
    const p = e.features?.[0]?.properties as Record<string, string | number> | undefined;
    if (!p) return;
    tip.remove();
    const title = String(p.callsign || p.reg || p.hex);
    const body = `<div class="vp"><div class="sp-title">✈ ${esc(title)}</div>
      <div>${esc(String(p.desc || p.typeCode))}</div>
      <div class="vp-dim">${esc(String(p.alt))} · ${Math.round(Number(p.gs))} kn · reg ${esc(String(p.reg || '—'))}</div>
      <div class="vp-dim" id="ac-route">Looking up route…</div></div>`;
    detail.setLngLat(e.lngLat).setHTML(body).addTo(map);
    const callsign = String(p.callsign).trim();
    if (callsign) {
      void fetchRoute(callsign).then((route) => {
        const el = document.getElementById('ac-route');
        if (!el) return;
        el.textContent = route ? `${route.origin} → ${route.destination}` : 'Route unknown';
      });
    }
  });

  await poll();
  window.setInterval(() => void poll(), POLL_INTERVAL_MS);
  requestAnimationFrame(render);
}
