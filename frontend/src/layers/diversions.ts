// Live bus-diversion events from the detector (/api/diversions). Each event's
// bypassed learned-polyline slices draw as a translucent highlighter band
// (no separate centroid marker — the wide band itself is the click target).
//
// TWO ways in, one picture. The Diversions overlay toggle (default OFF) shows
// every event the API returned; searching a bus line in the Filter tab shows,
// with the toggle still off, only the events serving that line — see the
// display coordinator below for the truth table. Search changes WHICH events
// are drawn and nothing else: same colours, same widths, same popup, so a
// diversion looks the same however it got on screen.
//
// The API still decides what is display-worthy at all, and search does NOT
// lower that bar: a diversion corroborated by a single vehicle stays hidden
// here too (DISPLAY_MIN_VEHICLES in backend/src/diversion-events.ts). Search is
// where the rider is paying most attention, which is the worst place to spend a
// false positive.
//
// Polling is gated on that same pair: the detector output only changes every
// rollup pass, so a layer nobody is looking at polling anyway would be pure
// egress waste. Becoming active refreshes immediately since the last picture
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
import { matchesSearch, onSearchedLines } from './searched-lines';

export const DIVERSIONS_SEGMENTS_LAYER_ID = 'diversions-segments';
export const DIVERSIONS_LAYER_IDS = [DIVERSIONS_SEGMENTS_LAYER_ID];

const SOURCE_ID = 'diversions';
const DIVERSIONS_URL = '/api/diversions';
/** The API caches for 60 s; 90 s keeps at most one wasted hit per fresh copy. */
const POLL_INTERVAL_MS = 90_000;

/** Highlighter-band styling: the basemap is already saturated with coloured
 * transit lines, so competing on colour loses — instead the event is a WIDE,
 * strongly translucent band over the road, a visual channel nothing else on
 * the map uses. Status drives the lifecycle look (recovering = healing
 * green, stale = nearly gone); among ACTIVE events, severity splits red
 * ('road': >=2 route-directions divert) from amber ('partial': one direction
 * of one route; the road otherwise flows). */
const STATUS_COLOR: ExpressionSpecification = [
  'match', ['get', 'status'],
  'recovering', '#4c5',
  'stale', '#8a94a0',
  ['match', ['get', 'severity'], 'partial', '#f7b04a', '#ff6b6b'],
];
// Tuned by bisection on the DARK basemap: 0.3 and even 0.45 render nearly
// invisible against near-black streets (verified with constant-paint tests);
// 0.6 with a soft blur is the floor where a wash stays clearly findable
// without turning back into a solid line.
const STATUS_OPACITY: ExpressionSpecification =
  ['match', ['get', 'status'], 'recovering', 0.5, 'stale', 0.22, 0.6];

type LngLat = [number, number];

export interface DiversionEvent {
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
export interface DiversionProps {
  routes: string;
  vehicles: number;
  status: string;
  severity: string;
  longRunning: boolean;
  startedAt: number;
  lastEvidenceAt: number;
  hasTfl: boolean;
  tflLoc: string;
  tflDist: number;
  /** True when a line search, not the overlay toggle, put this on screen. Read
   * by the popup only — nothing in the paint expressions touches it. */
  scoped: boolean;
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

/**
 * The events a search of `lines` surfaces.
 *
 * MATCHED IN JS, ON THE ARRAY, and it has to stay that way: `toProps` joins
 * `routes` into one comma-separated STRING for MapLibre, so the equivalent map
 * filter (`['in', '46', ['get', 'routes']]`) would substring-match and put 146,
 * 460 and N46 on screen for a search of 46 — three different roads.
 */
export function eventsOnSearchedLines(
  events: readonly DiversionEvent[],
  lines: ReadonlySet<string> | null,
): DiversionEvent[] {
  if (!lines) return [];
  return events.filter((ev) => (ev.routes ?? []).some((route) => matchesSearch(route, lines)));
}

function toProps(ev: DiversionEvent, scoped: boolean): DiversionProps {
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
    lastEvidenceAt: ev.lastEvidenceAt ?? 0,
    hasTfl: ev.tfl != null,
    tflLoc: ev.tfl?.loc ?? '',
    tflDist: ev.tfl?.dist ?? 0,
    scoped,
  };
}

/** `scoped` only reaches the popup: the drawn shape is identical either way. */
export function buildDiversionFeatures(
  events: readonly DiversionEvent[],
  scoped: boolean,
): GeoJSON.Feature[] {
  return events.flatMap((ev) => {
    const props = toProps(ev, scoped);
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

/** How long ago the last bus actually diverted here. The red stretch outlives
 * the closure by design (it clears only once traffic has driven it again), so
 * without this a finished diversion reads as happening right now. */
export function freshnessLabel(lastEvidenceAt: number, nowSec: number): string {
  if (!Number.isFinite(lastEvidenceAt) || lastEvidenceAt <= 0) return '';
  const mins = Math.floor((nowSec - lastEvidenceAt) / 60);
  if (mins < 0) return '';
  if (mins < 1) return 'last diverting bus just now';
  if (mins < 60) return `last diverting bus ${mins} min ago`;
  const hours = Math.floor(mins / 60);
  return `last diverting bus ${hours} h ${mins % 60} min ago`;
}

/**
 * A search surfaces this event because ONE of its routes matched, but the
 * geometry is the union of the bracket slices of every high-confidence route on
 * it — there is no per-route shape to draw. Left unsaid, the band would read as
 * "your route now goes this way". So say what it actually is, and keep listing
 * every affected route rather than just the one that was typed.
 */
function scopeNote(p: DiversionProps): string {
  if (!p.scoped) return '';
  return `<div class="vp-dim">Affects routes ${esc(p.routes)} — the band is the whole diversion, not one route’s path</div>`;
}

export function diversionPopupHtml(p: DiversionProps): string {
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
  const fresh =
    p.status === 'stale' ? '' : freshnessLabel(p.lastEvidenceAt, Math.floor(Date.now() / 1000));
  return `<div class="vp"><div class="sp-title">${title} — ${esc(p.routes)}</div>
    <div>${esc(status)}${ongoing}</div>
    <div>since ${timeLabel(p.startedAt, p.longRunning)} · ${p.vehicles} vehicle${p.vehicles === 1 ? '' : 's'}</div>
    ${scopeNote(p)}
    ${fresh === '' ? '' : `<div class="vp-dim">${fresh}</div>`}
    <div class="vp-dim">${tfl}</div></div>`;
}

function wireInteractions(map: MaplibreMap, layerId: string): void {
  const detail = new Popup({ closeButton: true, closeOnClick: true, offset: 12, maxWidth: '320px' });
  map.on('click', layerId, (e: MapLayerMouseEvent) => {
    const p = e.features?.[0]?.properties as DiversionProps | undefined;
    if (!p) return;
    detail.setLngLat(e.lngLat).setHTML(diversionPopupHtml(p)).addTo(map);
  });
  map.on('mouseenter', layerId, () => {
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', layerId, () => {
    map.getCanvas().style.cursor = '';
  });
}

// ── diversion display coordinator ──
// Two independent inputs decide what this layer shows, so they are resolved
// together in one place rather than fighting over the same source:
//   • the Diversions overlay toggle (Lines tab) — overlayOn
//   • the bus line search (Filter tab)          — searchedSelection
// Truth table:
//   overlay ON,  no search → every event the API returned
//   overlay ON,  search    → every event, unchanged: the toggle already asked
//                            for all of them, and searching must not take any
//                            away from a rider who is looking at the lot
//   overlay OFF, search    → ONLY events serving a searched line, drawn exactly
//                            as the toggle draws them
//   overlay OFF, no search → nothing drawn, and ZERO fetches

/** OFF by default, mirroring the legend row's startOff. */
let overlayOn = false;
/** The Filter tab's selection, or null when the rider is not searching. */
let searchedSelection: ReadonlySet<string> | null = null;
/** The resolved output of the truth table, kept as state because poll() reads
 * it: while nothing is on screen, nothing is fetched. */
let onScreen = false;
/** The last events the API returned, so a filter change re-scopes the picture
 * without spending a request on data we already hold. */
let lastEvents: readonly DiversionEvent[] = [];
/** Set by startDiversions so a newly-active input can force an immediate refresh. */
let refresh: (() => void) | null = null;

/** Push the currently-drawable events to the source. With neither input active
 * the scoped list is empty, so `scoped` never reaches a feature in that case. */
function draw(map: MaplibreMap): void {
  const src = map.getSource(SOURCE_ID);
  if (!src || !('setData' in src)) return;
  const events = overlayOn ? lastEvents : eventsOnSearchedLines(lastEvents, searchedSelection);
  (src as GeoJSONSource).setData({
    type: 'FeatureCollection',
    features: buildDiversionFeatures(events, !overlayOn),
  });
}

/** Recompute visibility, the poll gate and the drawn events from both inputs. */
function applyDiversionDisplay(map: MaplibreMap): void {
  const active = overlayOn || searchedSelection !== null;
  // Coming back on, `lastEvents` holds whatever was true when we stopped
  // fetching — possibly a whole off-interval stale — so refresh out of band
  // rather than leaving that picture up until the next tick.
  const resumed = active && !onScreen;
  onScreen = active;
  for (const id of DIVERSIONS_LAYER_IDS) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', active ? 'visible' : 'none');
  }
  draw(map);
  if (resumed) refresh?.();
}

/** Legend toggle handler: one of the two inputs above. */
export function setDiversionsVisible(map: MaplibreMap, visible: boolean): void {
  overlayOn = visible;
  applyDiversionDisplay(map);
}

export async function startDiversions(map: MaplibreMap): Promise<void> {
  map.addSource(SOURCE_ID, {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });
  // Same anchor as roadworks: stations-circle sits above the transit lines
  // (and the coverage glow beneath them) but below every vehicle layer, so
  // inserting under it lands exactly between the static network and the dots.
  //
  // One wide translucent band — no casing, no dashes: solid saturated lines
  // lose against a basemap full of them (a previous dashed-red pass read as
  // yet another line), while a broad ~30%-opacity wash over the road is a
  // channel nothing else on the map uses. Since the layer only appears when
  // asked for (toggle on, or the line searched), subtle is a feature: you went
  // looking for it, so you know where to look.
  //
  // The only `filter` here is on geometry type. Scoping to a searched line is
  // deliberately NOT expressible here — see eventsOnSearchedLines.
  map.addLayer(
    {
      id: DIVERSIONS_SEGMENTS_LAYER_ID,
      type: 'line',
      source: SOURCE_ID,
      filter: ['==', ['geometry-type'], 'LineString'],
      // hidden until an input asks for it; applyDiversionDisplay flips this
      layout: { 'line-cap': 'round', 'line-join': 'round', visibility: 'none' },
      paint: {
        'line-color': STATUS_COLOR,
        'line-opacity': STATUS_OPACITY,
        'line-width': ['interpolate', ['linear'], ['zoom'], 9, 5, 13, 11, 16, 20],
        // Soft edges: reads as a highlight wash, not another transit line.
        'line-blur': 2.5,
      },
    },
    below(map, 'stations-circle'),
  );

  async function poll(): Promise<void> {
    if (!onScreen) return;
    try {
      const res = await fetch(DIVERSIONS_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as DiversionsResponse;
      // A 200 from an intermediary (error page, captive portal) must not reach
      // setData; empty `events` is fine and clears the layer.
      if (!Array.isArray(body?.events)) throw new Error('unexpected diversions payload shape');
      lastEvents = body.events;
      draw(map);
    } catch (error) {
      // Keep the last picture; the next poll retries.
      console.warn('[diversions]', error);
    }
  }

  wireInteractions(map, DIVERSIONS_SEGMENTS_LAYER_ID);

  // Subscribing delivers the CURRENT selection synchronously, so a rider who
  // typed a line before this layer finished starting gets it resolved here
  // rather than at their next keystroke. `refresh` is still null during that
  // first delivery, so it cannot kick a request of its own — the awaited poll
  // below stays the single start-up fetch.
  onSearchedLines((lines) => {
    searchedSelection = lines;
    applyDiversionDisplay(map);
  });

  refresh = () => void poll();
  await poll();
  registerPoll(() => void poll(), POLL_INTERVAL_MS);
}
