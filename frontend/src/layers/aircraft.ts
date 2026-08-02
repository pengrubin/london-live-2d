// Live aircraft over London (ADS-B). Positions are real GPS — no inference —
// with per-frame dead reckoning from speed/track between 5 s polls.

import {
  Popup,
  type GeoJSONSource,
  type Map as MaplibreMap,
  type MapLayerMouseEvent,
} from 'maplibre-gl';
import { isLayerShown, makeRenderGate } from '../util/render-gate';
import { registerPoll, symbolTierIntervalMs } from '../util/lifecycle';
import { injectPopupStyles } from '../ui/station-popup';
import { enablePopupDragToPan, isPopupTextInteracting } from '../ui/popup-drag';
import { M_PER_DEG_LAT, metersPerDegLon } from '../region';

export const AIRCRAFT_LAYER_ID = 'aircraft-icons';
const SOURCE_ID = 'aircraft';
const POLL_INTERVAL_MS = 5_000;
const KN_TO_MS = 0.514444;

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

// ── Emergency-helicopter classification ──────────────────────────────────────
// London POLICE (NPAS / Met Police Air Support) and AIR-AMBULANCE (HEMS)
// helicopters, so they can be rendered distinctly among the live ADS-B fleet.
//
// Registrations and callsign conventions verified July 2026 against operator
// sites and aircraft databases (londonsairambulance.org.uk, aakss.org.uk,
// helis.com/database/sqd/NPAS). Fleets change, so the exact-reg allow-list is
// backed by reg-prefix rules (whole G-POL/G-MPS/G-NPA/G-LAA/G-KSS blocks are
// single-operator) and by callsign-prefix fallbacks. Everything is conservative:
// only unambiguous matches classify; anything else stays a normal helicopter.
export type EmergencyKind = 'police' | 'air-ambulance';

// Exact marks of police helicopters that work the Greater-London area.
const POLICE_REGS = new Set<string>([
  'G-MPSA', 'G-MPSB', 'G-MPSC', // Metropolitan Police Service H145s (North Weald) — cover London directly
  'G-NPAS', 'G-NPAA', 'G-NPAB', 'G-NPAC', // NPAS new-build H135s (2025 fleet-renewal programme)
  'G-POLA', 'G-POLD', 'G-POLF', 'G-POLH', 'G-POLU', // police-marked EC135s
  'G-CPAO', 'G-CPAS', 'G-LASU', // ex-London Air Support Unit / NPAS EC135s
]);
// Whole reg blocks that are exclusively police — future-proofs new deliveries
// (a future G-POLx / G-MPSx / G-NPAx airframe is caught without a code change).
const POLICE_REG_PREFIXES = ['G-POL', 'G-MPS', 'G-NPA'];

// Exact marks of air-ambulance helicopters that routinely fly within the 30 nm
// London ADS-B radius (some are based just outside Greater London but respond in).
const AMBULANCE_REGS = new Set<string>([
  'G-LAAA', 'G-LAAB', // London's Air Ambulance H135s "Amy"/"Beth" (in service 1 Oct 2024)
  'G-KSST', 'G-KSSC', 'G-LNAC', // Air Ambulance Kent Surrey Sussex AW169s (Redhill) — G-LNAC observed live 25 Jul 26
  'G-EHAT', 'G-EHEM', // Essex & Herts Air Ambulance AW169s (North Weald / Earls Colne)
]);
// G-LAA = London's Air Ambulance, G-KSS = Kent-Surrey-Sussex — both exclusively HEMS.
const AMBULANCE_REG_PREFIXES = ['G-LAA', 'G-KSS'];

// Callsign fallbacks (matched only after regs, so a known airframe always wins).
// NPAS is the National Police Air Service prefix; POL is used by police units.
const POLICE_CS_PREFIXES = ['NPAS', 'POL'];
// HLE is the shared ICAO code Flightradar24 files all UK air ambulances under;
// HEMS / HMED / HELIMED / MEDIC are common dispatch/operator variants.
const AMBULANCE_CS_PREFIXES = ['HLE', 'HEMS', 'HMED', 'HELIMED', 'MEDIC'];

/**
 * Classify an aircraft as a London emergency helicopter. Pure — no side effects.
 * Priority: curated registration table/prefixes first, then callsign prefixes.
 * Returns null for everything that is not an unambiguous match (the common case;
 * frequently none are airborne). Registration is authoritative and reliable even
 * when the ADS-B `category` field is missing, so category is intentionally not
 * required here.
 */
export function classifyEmergency(a: Aircraft): EmergencyKind | null {
  const reg = (a.r ?? '').toUpperCase().trim();
  if (reg) {
    if (POLICE_REGS.has(reg) || POLICE_REG_PREFIXES.some((p) => reg.startsWith(p))) return 'police';
    if (AMBULANCE_REGS.has(reg) || AMBULANCE_REG_PREFIXES.some((p) => reg.startsWith(p)))
      return 'air-ambulance';
  }
  // Callsigns arrive space-padded (e.g. "HLE21   "); strip to alphanumerics.
  const cs = (a.flight ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (cs) {
    if (POLICE_CS_PREFIXES.some((p) => cs.startsWith(p))) return 'police';
    if (AMBULANCE_CS_PREFIXES.some((p) => cs.startsWith(p))) return 'air-ambulance';
  }
  return null;
}

/** Human label + emoji for a classified emergency helicopter (''=not emergency). */
function emergencyLabel(kind: string): string {
  if (kind === 'police') return '🚁 Police helicopter';
  if (kind === 'air-ambulance') return '🚑 Air Ambulance';
  return '';
}

const POLICE_BLUE = '#1B4DE4';
const MEDICAL_RED = '#E8112D';

/**
 * Larger, eye-catching heli icon for emergency airframes: coloured body + rotor
 * (police blue / medical red), a soft semi-transparent halo glow so it pops on a
 * busy map, and — for air ambulances — a white medical cross badge. Drawn in the
 * same canvas style / pixelRatio as makeHeliIcon, on a bigger 64px canvas.
 */
function makeEmergencyHeliIcon(kind: EmergencyKind): ImageData {
  const SIZE = 64;
  const c = document.createElement('canvas');
  c.width = SIZE;
  c.height = SIZE;
  const x = c.getContext('2d');
  if (!x) throw new Error('2d canvas unavailable');
  x.translate(SIZE / 2, SIZE / 2);

  const [r, g, b] = kind === 'police' ? [27, 77, 228] : [232, 17, 45];
  const bodyColor = kind === 'police' ? POLICE_BLUE : MEDICAL_RED;

  // Soft glowing halo (outer glow ring at ~0.35 alpha) — the visual "pop".
  const glow = x.createRadialGradient(0, 0, 8, 0, 0, 30);
  glow.addColorStop(0, `rgba(${r},${g},${b},0)`);
  glow.addColorStop(0.55, `rgba(${r},${g},${b},0.35)`);
  glow.addColorStop(1, `rgba(${r},${g},${b},0)`);
  x.fillStyle = glow;
  x.beginPath();
  x.arc(0, 0, 30, 0, Math.PI * 2);
  x.fill();
  // Crisp ring at the glow's edge.
  x.strokeStyle = `rgba(${r},${g},${b},0.55)`;
  x.lineWidth = 2.5;
  x.beginPath();
  x.arc(0, 0, 21, 0, Math.PI * 2);
  x.stroke();

  // Body (≈1.4× the normal heli body).
  x.beginPath();
  x.ellipse(0, 3, 8.5, 12.5, 0, 0, Math.PI * 2);
  x.fillStyle = bodyColor;
  x.fill();
  x.strokeStyle = '#1a1a1a';
  x.lineWidth = 1.5;
  x.stroke();
  // Rotor cross.
  x.strokeStyle = '#f5f5f5';
  x.lineWidth = 2.5;
  x.beginPath();
  x.moveTo(-17, -14);
  x.lineTo(17, 20);
  x.moveTo(17, -14);
  x.lineTo(-17, 20);
  x.stroke();

  if (kind === 'air-ambulance') {
    // White medical cross badge over the body.
    x.fillStyle = '#ffffff';
    const half = 2.4; // arm half-thickness
    const arm = 6; // arm half-length
    x.fillRect(-half, 3 - arm, half * 2, arm * 2); // vertical bar
    x.fillRect(-arm, 3 - half, arm * 2, half * 2); // horizontal bar
  }

  return x.getImageData(0, 0, SIZE, SIZE);
}

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

interface AircraftPhoto {
  src: string;
  photographer: string;
  link: string;
}

/** Photo lookups by "reg|hex"; null = checked, no photo. Session-lifetime cache. */
const photoByAircraft = new Map<string, Promise<AircraftPhoto | null>>();

/** One backend request per airframe per session (the backend caches 24 h). */
function fetchAircraftPhoto(reg: string, hex: string): Promise<AircraftPhoto | null> {
  const key = `${reg}|${hex}`;
  const cached = photoByAircraft.get(key);
  if (cached) return cached;
  const pending = (async (): Promise<AircraftPhoto | null> => {
    try {
      const params = new URLSearchParams();
      if (reg) params.set('reg', reg);
      if (hex) params.set('hex', hex);
      const res = await fetch(`/api/aircraft-photo?${params.toString()}`);
      if (!res.ok) return null;
      const json = (await res.json()) as Partial<AircraftPhoto>;
      if (!json.src) return null;
      return { src: json.src, photographer: json.photographer ?? '', link: json.link ?? '' };
    } catch {
      return null;
    }
  })();
  photoByAircraft.set(key, pending);
  return pending;
}

/**
 * Lazily fetches the airframe photo and, if one exists and the popup still
 * shows the same aircraft, prepends it plus the photographer-attribution line
 * (required by Planespotters) to the card. Same guard pattern as the vessel
 * photo: tag the content root before the async fetch resolves.
 */
function prependAircraftPhoto(popup: Popup, reg: string, hex: string): void {
  const root = popup.getElement()?.querySelector<HTMLElement>('.vp');
  if (!root) return;
  const tag = `${reg}|${hex}`;
  root.dataset.photoFor = tag;
  void fetchAircraftPhoto(reg, hex).then((photo) => {
    if (!photo) return;
    const current = popup.getElement()?.querySelector<HTMLElement>('.vp');
    if (!current || !current.isConnected || current.dataset.photoFor !== tag) return;
    const credit = document.createElement('a');
    credit.className = 'vp-credit';
    credit.href = photo.link;
    credit.target = '_blank';
    credit.rel = 'noopener noreferrer';
    credit.textContent = `📷 ${photo.photographer || 'Planespotters.net'}`;
    current.prepend(credit);
    const img = document.createElement('img');
    img.className = 'vp-photo';
    img.alt = '';
    img.src = photo.src;
    current.prepend(img);
  });
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
  injectPopupStyles(); // .vp-photo / .vp-credit live in the shared injected style tag
  if (!map.hasImage('ac-plane')) map.addImage('ac-plane', makePlaneIcon(), { pixelRatio: 2 });
  if (!map.hasImage('ac-heli')) map.addImage('ac-heli', makeHeliIcon(), { pixelRatio: 2 });
  if (!map.hasImage('ac-heli-police'))
    map.addImage('ac-heli-police', makeEmergencyHeliIcon('police'), { pixelRatio: 2 });
  if (!map.hasImage('ac-heli-ambulance'))
    map.addImage('ac-heli-ambulance', makeEmergencyHeliIcon('air-ambulance'), { pixelRatio: 2 });

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
      // Emergency helis get a noticeably larger base size so they stand out; the
      // larger 64px canvas already helps, this pushes them further.
      'icon-size': ['interpolate', ['linear'], ['zoom'],
        9, ['case', ['==', ['get', 'emergency'], 1], 0.85,
          ['case', ['==', ['get', 'ground'], 1], 0.33, 0.55]],
        13, ['case', ['==', ['get', 'emergency'], 1], 1.2,
          ['case', ['==', ['get', 'ground'], 1], 0.48, 0.8]]],
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

  const renderGate = makeRenderGate(symbolTierIntervalMs);
  let lastWasEmpty = false;
  // Current displayed [lon,lat] per aircraft hex — rebuilt each render so the
  // selected aircraft's detail popup can follow it between the 5 s polls.
  const posByHex = new Map<string, [number, number]>();
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
    const mPerDegLon = metersPerDegLon();
    posByHex.clear();
    const features = fleet.map((a) => {
      const speedMs = a.alt_baro === 'ground' ? 0 : (a.gs ?? 0) * KN_TO_MS;
      const rad = (((a.track ?? 0) - 0) * Math.PI) / 180;
      const lon = (a.lon as number) + (speedMs * dtS * Math.sin(rad)) / mPerDegLon;
      const lat = (a.lat as number) + (speedMs * dtS * Math.cos(rad)) / M_PER_DEG_LAT;
      posByHex.set(a.hex, [lon, lat]);
      const emKind = classifyEmergency(a);
      const icon =
        emKind === 'police'
          ? 'ac-heli-police'
          : emKind === 'air-ambulance'
            ? 'ac-heli-ambulance'
            : isHelicopter(a)
              ? 'ac-heli'
              : 'ac-plane';
      return {
        type: 'Feature' as const,
        properties: {
          hex: a.hex,
          icon,
          emergency: emKind ? 1 : 0,
          emKind: emKind ?? '',
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
    // Keep an open detail popup glued to its aircraft. When the hex drops out of
    // the fleet the lookup misses — leave the popup at its last position.
    if (selectedHex && detail.isOpen()) {
      const el = detail.getElement();
      // Freeze following while the user is selecting/copying text in the card.
      if (!el || !isPopupTextInteracting(el)) {
        const pos = posByHex.get(selectedHex);
        if (pos) detail.setLngLat(pos);
      }
    }
    requestAnimationFrame(render);
  }

  // ── hover + click ──
  const tip = new Popup({ closeButton: false, closeOnClick: false, offset: 12, className: 'hover-tip' });
  map.on('mousemove', AIRCRAFT_LAYER_ID, (e: MapLayerMouseEvent) => {
    const p = e.features?.[0]?.properties as Record<string, string | number> | undefined;
    if (!p) return;
    map.getCanvas().style.cursor = 'pointer';
    const emLabel = emergencyLabel(String(p.emKind ?? ''));
    const nameLine = emLabel
      ? `${emLabel} · ${esc(String(p.callsign || p.reg || p.hex))}`
      : esc(String(p.callsign || p.reg || p.hex));
    tip
      .setLngLat(e.lngLat)
      .setHTML(
        `<div class="vp"><b>${nameLine}</b> ${esc(String(p.typeCode))}<div class="vp-dim">${esc(String(p.alt))} · ${Math.round(Number(p.gs))} kn</div></div>`,
      )
      .addTo(map);
  });
  map.on('mouseleave', AIRCRAFT_LAYER_ID, () => {
    map.getCanvas().style.cursor = '';
    tip.remove();
  });

  const detail = new Popup({ closeButton: true, closeOnClick: true, offset: 14, maxWidth: '300px' });
  enablePopupDragToPan(map, detail);
  // The currently-selected aircraft (by hex), followed by the detail popup.
  let selectedHex: string | null = null;
  detail.on('close', () => {
    selectedHex = null;
  });
  map.on('click', AIRCRAFT_LAYER_ID, (e: MapLayerMouseEvent) => {
    const p = e.features?.[0]?.properties as Record<string, string | number> | undefined;
    if (!p) return;
    tip.remove();
    selectedHex = String(p.hex);
    const title = String(p.callsign || p.reg || p.hex);
    const emLabel = emergencyLabel(String(p.emKind ?? ''));
    const titleLine = emLabel ? `${emLabel} — ${esc(title)}` : `✈ ${esc(title)}`;
    const body = `<div class="vp"><div class="sp-title">${titleLine}</div>
      <div>${esc(String(p.desc || p.typeCode))}</div>
      <div class="vp-dim">${esc(String(p.alt))} · ${Math.round(Number(p.gs))} kn · reg ${esc(String(p.reg || '—'))}</div>
      <div class="vp-dim" id="ac-route">Looking up route…</div></div>`;
    detail.setLngLat(e.lngLat).setHTML(body).addTo(map);
    prependAircraftPhoto(detail, String(p.reg ?? '').trim(), String(p.hex ?? '').trim());
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
  registerPoll(() => void poll(), POLL_INTERVAL_MS);
  requestAnimationFrame(render);
}
