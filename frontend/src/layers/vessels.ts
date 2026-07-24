// All AIS ships on the Thames (cargo, tankers, passenger boats, tugs …).
// TfL river buses already render as bullets; AIS vessels close to one are
// suppressed so the same physical boat isn't drawn twice.

import {
  Popup,
  type GeoJSONSource,
  type Map as MaplibreMap,
  type MapLayerMouseEvent,
} from 'maplibre-gl';
import { metersBetween, type LngLat } from '../realtime/geometry';
import { isLayerShown } from '../util/render-gate';
import { appendRankLine } from '../ui/rank-line';
import { dimensionsLine, fetchShipPhoto, flagLine } from '../ui/ship-info';
import { injectPopupStyles } from '../ui/station-popup';

export const VESSELS_LAYER_ID = 'vessels-icons';
const SOURCE_ID = 'vessels';
const POLL_INTERVAL_MS = 10_000;
const KN_TO_MS = 0.514444;
const M_PER_DEG_LAT = 110540;
const M_PER_DEG_LON = 111320 * Math.cos((51.5 * Math.PI) / 180);
/** An AIS ship this close to a TfL boat marker IS that boat. */
const TFL_DEDUPE_M = 200;

interface Vessel {
  mmsi: number;
  name: string;
  lat: number;
  lon: number;
  sog: number | null;
  cog: number | null;
  shipType: number | null;
  destination: string | null;
  lengthM: number | null;
  widthM: number | null;
  draughtM: number | null;
  flag: string | null;
  /** epoch ms of the vessel's own AIS fix — extrapolation anchor */
  lastSeen: number;
}

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);

/** Latest AIS poll result — kept for findVessel() lookups. */
let liveVessels: readonly Vessel[] = [];

/** Last reported [lng, lat] of a live AIS vessel by MMSI, or null. */
export function findVessel(mmsi: number): [number, number] | null {
  const vessel = liveVessels.find((v) => v.mmsi === mmsi);
  return vessel ? [vessel.lon, vessel.lat] : null;
}

interface ShipClass {
  key: string;
  label: string;
  color: string;
}

function classify(shipType: number | null): ShipClass {
  const t = shipType ?? 0;
  if (t >= 60 && t < 70) return { key: 'pass', label: 'Passenger', color: '#4FC3F7' };
  if (t >= 70 && t < 80) return { key: 'cargo', label: 'Cargo', color: '#FFB74D' };
  if (t >= 80 && t < 90) return { key: 'tanker', label: 'Tanker', color: '#EF5350' };
  if (t === 30) return { key: 'fish', label: 'Fishing', color: '#81C784' };
  if (t === 36 || t === 37) return { key: 'pleasure', label: 'Pleasure craft', color: '#BA68C8' };
  if (t >= 50 && t < 56) return { key: 'special', label: 'Tug / pilot / SAR', color: '#90A4AE' };
  return { key: 'other', label: 'Vessel', color: '#B0BEC5' };
}

function makeShipIcon(color: string): ImageData {
  const c = document.createElement('canvas');
  c.width = 30;
  c.height = 46;
  const x = c.getContext('2d');
  if (!x) throw new Error('2d canvas unavailable');
  x.translate(15, 23);
  x.beginPath();
  // hull with pointed bow (up) and flat stern
  x.moveTo(0, -19);
  x.quadraticCurveTo(9, -8, 9, 6);
  x.lineTo(9, 17);
  x.lineTo(-9, 17);
  x.lineTo(-9, 6);
  x.quadraticCurveTo(-9, -8, 0, -19);
  x.closePath();
  x.fillStyle = color;
  x.fill();
  x.strokeStyle = '#10161c';
  x.lineWidth = 2;
  x.stroke();
  return x.getImageData(0, 0, 30, 46);
}

/** Live TfL boat positions from the trains source (river modes only). */
function tflBoatPositions(map: MaplibreMap): LngLat[] {
  const src = map.getSource('trains');
  if (!src || !('serialize' in src)) return [];
  const features = map.querySourceFeatures('trains');
  const out: LngLat[] = [];
  for (const f of features) {
    const lineId = (f.properties as { lineId?: string }).lineId ?? '';
    if (!lineId.startsWith('rb') && lineId !== 'woolwich-ferry') continue;
    if (f.geometry.type === 'Point') out.push(f.geometry.coordinates as LngLat);
  }
  return out;
}

/**
 * Lazily fetches the ship photo and, if one exists and the popup still shows
 * the same vessel, prepends it to the card (same guard pattern as the rank
 * line: tag the content root before the async fetch resolves).
 */
function prependShipPhoto(popup: Popup, mmsi: number): void {
  const root = popup.getElement()?.querySelector<HTMLElement>('.vp');
  if (!root) return;
  root.dataset.photoFor = String(mmsi);
  void fetchShipPhoto(mmsi).then((url) => {
    if (!url) return;
    const current = popup.getElement()?.querySelector<HTMLElement>('.vp');
    if (!current || !current.isConnected || current.dataset.photoFor !== String(mmsi)) return;
    const img = document.createElement('img');
    img.className = 'vp-photo';
    img.alt = '';
    img.src = url;
    current.prepend(img);
  });
}

export async function startVessels(map: MaplibreMap): Promise<void> {
  injectPopupStyles(); // .vp-photo lives in the shared injected style tag
  const classes = ['pass', 'cargo', 'tanker', 'fish', 'pleasure', 'special', 'other'];
  for (const key of classes) {
    const name = `ship-${key}`;
    if (!map.hasImage(name)) {
      map.addImage(name, makeShipIcon(classify(classKeyToType(key)).color), { pixelRatio: 2 });
    }
  }

  map.addSource(SOURCE_ID, {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });
  map.addLayer(
    {
      id: VESSELS_LAYER_ID,
      type: 'symbol',
      source: SOURCE_ID,
      layout: {
        'icon-image': ['concat', 'ship-', ['get', 'cls']],
        'icon-size': ['interpolate', ['linear'], ['zoom'], 10, 0.45, 14, 0.8],
        'icon-rotate': ['get', 'cog'],
        'icon-rotation-alignment': 'map',
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
    },
    'trains-dots', // beneath TfL vehicles so bullets stay readable
  );

  let vessels: Vessel[] = [];

  async function poll(): Promise<void> {
    try {
      const res = await fetch('/api/vessels');
      if (!res.ok) return;
      const list = (await res.json()) as Vessel[];
      if (Array.isArray(list)) {
        vessels = list;
        liveVessels = list;
      }
    } catch {
      // keep the previous picture
    }
  }

  let lastWasEmpty = false;
  function render(): void {
    const schedule = (): void => {
      window.setTimeout(() => requestAnimationFrame(render), 500); // ships are slow
    };
    if (!isLayerShown(map, VESSELS_LAYER_ID) || (vessels.length === 0 && lastWasEmpty)) {
      schedule();
      return;
    }
    // Anchor dead reckoning to each fix's own timestamp: AIS fixes arrive with
    // ~60 s median gaps, so anchoring to our poll time made fast ships lurch
    // forward then snap back every poll (the reported 'looping path'). Cap the
    // extrapolation so stale fixes don't overshoot.
    const nowMs = Date.now();
    const boats = tflBoatPositions(map);
    const features = vessels
      .map((v) => {
        const speedMs = (v.sog ?? 0) * KN_TO_MS;
        const rad = ((v.cog ?? 0) * Math.PI) / 180;
        const dtS = Math.min(Math.max(0, (nowMs - v.lastSeen) / 1000), 120);
        const lngLat: LngLat = [
          v.lon + (speedMs * dtS * Math.sin(rad)) / M_PER_DEG_LON,
          v.lat + (speedMs * dtS * Math.cos(rad)) / M_PER_DEG_LAT,
        ];
        return { v, lngLat };
      })
      .filter(({ lngLat }) => !boats.some((b) => metersBetween(b, lngLat) < TFL_DEDUPE_M))
      .map(({ v, lngLat }) => {
        const cls = classify(v.shipType);
        return {
          type: 'Feature' as const,
          properties: {
            mmsi: v.mmsi,
            name: v.name || `MMSI ${v.mmsi}`,
            cls: cls.key,
            clsLabel: cls.label,
            sog: v.sog ?? 0,
            cog: v.cog ?? 0,
            destination: v.destination ?? '',
            lengthM: v.lengthM ?? 0,
            widthM: v.widthM ?? 0,
            draughtM: v.draughtM ?? 0,
            flag: v.flag ?? '',
          },
          geometry: { type: 'Point' as const, coordinates: lngLat },
        };
      });
    const src = map.getSource(SOURCE_ID);
    if (src && 'setData' in src) {
      (src as GeoJSONSource).setData({ type: 'FeatureCollection', features });
    }
    lastWasEmpty = features.length === 0;
    schedule();
  }

  const tip = new Popup({ closeButton: false, closeOnClick: false, offset: 12, className: 'hover-tip' });
  map.on('mousemove', VESSELS_LAYER_ID, (e: MapLayerMouseEvent) => {
    const p = e.features?.[0]?.properties as Record<string, string | number> | undefined;
    if (!p) return;
    map.getCanvas().style.cursor = 'pointer';
    tip
      .setLngLat(e.lngLat)
      .setHTML(
        `<div class="vp"><b>${esc(String(p.name))}</b><div class="vp-dim">${esc(String(p.clsLabel))} · ${Number(p.sog).toFixed(1)} kn</div></div>`,
      )
      .addTo(map);
  });
  map.on('mouseleave', VESSELS_LAYER_ID, () => {
    map.getCanvas().style.cursor = '';
    tip.remove();
  });

  const detail = new Popup({ closeButton: true, closeOnClick: true, offset: 14, maxWidth: '280px' });
  map.on('click', VESSELS_LAYER_ID, (e: MapLayerMouseEvent) => {
    const p = e.features?.[0]?.properties as Record<string, string | number> | undefined;
    if (!p) return;
    tip.remove();
    const dest = String(p.destination).trim();
    const dims = dimensionsLine(Number(p.lengthM), Number(p.widthM), Number(p.draughtM));
    const flag = flagLine(String(p.flag));
    detail
      .setLngLat(e.lngLat)
      .setHTML(
        `<div class="vp"><div class="sp-title">⚓ ${esc(String(p.name))}</div>
        <div>${esc(String(p.clsLabel))}</div>
        ${dims ? `<div class="vp-dim">${esc(dims)}</div>` : ''}
        ${flag ? `<div class="vp-dim">${esc(flag)}</div>` : ''}
        <div class="vp-dim">${Number(p.sog).toFixed(1)} kn · MMSI ${esc(String(p.mmsi))}</div>
        ${dest ? `<div class="vp-dim">Bound for ${esc(dest)}</div>` : ''}</div>`,
      )
      .addTo(map);
    appendRankLine(detail, 'ship', `ship:${String(p.mmsi)}`);
    prependShipPhoto(detail, Number(p.mmsi));
  });

  await poll();
  window.setInterval(() => void poll(), POLL_INTERVAL_MS);
  requestAnimationFrame(render);
}

/** representative AIS type code per icon class, for tinting the shared hull */
function classKeyToType(key: string): number {
  switch (key) {
    case 'pass':
      return 60;
    case 'cargo':
      return 70;
    case 'tanker':
      return 80;
    case 'fish':
      return 30;
    case 'pleasure':
      return 36;
    case 'special':
      return 50;
    default:
      return 0;
  }
}
