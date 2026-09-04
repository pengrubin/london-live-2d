// Bus stops TfL currently has closed (/api/bus-stop-closures). One pin per
// pole, drawn ONLY while the row's own from/to window covers the moment the
// payload was built.
//
// That rule is the whole overlay. The rail layer originally split live from
// planned by TfL's category and hatched the Waterloo & City line shut on a
// Friday morning while it was running; the mirror of that bug is worse — a
// closure that HAS begun filed as "planned" and hidden, so the map says a stop
// is open on the morning it is boarded up. Neither can happen here: the window
// is compared against a SERVER-anchored now (payload `t` plus locally elapsed
// time, a difference, so a skewed viewer clock cancels), and a row whose window
// does not cover it is not drawn at all. A row that states no window is drawn —
// it is in the current-disruption feed and nothing in it bounds the closure —
// but a row whose stamp cannot be parsed is dropped rather than guessed.
//
// The feed carries no coordinates and no route list: both come from the
// backend's stop gazetteer, so a pole the gazetteer could not resolve has no
// position and is dropped (and counted) rather than placed somewhere plausible.
//
// Polling is gated on the overlay toggle (default OFF): while hidden the layer
// makes zero requests.

import {
  Popup,
  type ExpressionSpecification,
  type GeoJSONSource,
  type Map as MaplibreMap,
  type MapLayerMouseEvent,
} from 'maplibre-gl';
import { registerPoll } from '../util/lifecycle';
import { anyFeatureAt, below, DOT_LAYER_IDS } from '../util/layer-order';

export const BUS_STOP_CLOSURES_HALO_LAYER_ID = 'bus-stop-closures-halo';
export const BUS_STOP_CLOSURES_CORE_LAYER_ID = 'bus-stop-closures-core';
export const BUS_STOP_CLOSURES_LAYER_IDS = [
  BUS_STOP_CLOSURES_HALO_LAYER_ID,
  BUS_STOP_CLOSURES_CORE_LAYER_ID,
];

const SOURCE_ID = 'bus-stop-closures';
const CLOSURES_URL = '/api/bus-stop-closures';
/** The feed is cached 10 minutes server-side and a closure lasts days. */
const POLL_INTERVAL_MS = 300_000;
/** Re-filters the payload already in hand so a window can expire between
 * polls; costs no request. */
const TICK_INTERVAL_MS = 60_000;
/** ~260 poles across Greater London: below this they are a smear, not a map. */
const MIN_ZOOM = 11;
const LONDON_TIME_ZONE = 'Europe/London';
const DESCRIPTION_MAX_CHARS = 320;
const DOTS_ANCHOR_LAYER_ID = 'stations-circle';

/**
 * Magenta, and a glow rather than a disc.
 *
 * Every other point layer on this map is a 2-6 px filled disc with a 1 px
 * near-black stroke (bike stations, JamCams, roadworks, tide gauges) or the
 * station dots' dark core inside a pale ring — so hue alone would not have
 * separated a new one. A small hard core inside a WIDE soft halo is a
 * silhouette nothing else here uses, and magenta is the one saturated hue the
 * palette had left: reds are roadworks and rail closures, amber is JamCams and
 * severe delays, green/cyan are bike docks and bus flow, TfL red is the buses.
 */
const CLOSURE_COLOR = '#ff4fd8';

const HALO_RADIUS: ExpressionSpecification = [
  'interpolate', ['linear'], ['zoom'], MIN_ZOOM, 6, 15, 18,
];
const CORE_RADIUS: ExpressionSpecification = [
  'interpolate', ['linear'], ['zoom'], MIN_ZOOM, 2.5, 15, 6,
];

// ── payload contract (unknown keys are ignored on purpose) ──

export interface BusStopClosure {
  /** ATCO code of the pole. */
  id?: string;
  name?: string;
  lat?: number;
  lon?: number;
  routes?: string[];
  /** TfL's own disruption type, e.g. "Closure". */
  ty?: string;
  /** ISO start of the closure window. */
  f?: string;
  /** ISO end of the closure window; frequently absent (open-ended). */
  t?: string;
  /** Free text from TfL. */
  d?: string;
  towards?: string;
}

export interface BusStopClosuresPayload {
  /** Unix seconds the server built the body at — the clock every window is
   * compared against. */
  t?: number;
  stops?: BusStopClosure[];
}

/** Flat: maplibre JSON-round-trips feature properties, so a nested object
 * would come back out of queryRenderedFeatures as a string. */
export interface ClosureProps {
  id: string;
  name: string;
  routes: string;
  towards: string;
  ty: string;
  when: string;
  description: string;
}

// ── counters (no drop is silent) ──

const stats = {
  polls: 0,
  received: 0,
  drawn: 0,
  droppedNoCoords: 0,
  droppedNotInForce: 0,
  droppedUnreadableWindow: 0,
  pollFailures: 0,
  lastPollError: '',
};

/** Live counters for acceptance tooling and the console. */
export function busStopClosuresStats(): typeof stats {
  return stats;
}

// ── pure helpers ──

/** Does not escape `'` — so no upstream string is ever interpolated into an
 * attribute; every attribute below is a static class name, and anything that
 * needed a value would be set as a DOM property instead. */
const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);

/**
 * "Now" on the server's clock. Comparing a closure window to the browser clock
 * would let a viewer running ten minutes fast hide a closure that has just
 * begun, so the payload's own timestamp is the anchor and only ELAPSED local
 * time is added — a difference, so the skew cancels.
 */
export function serverNowMs(payloadT: number, receivedAt: number, now: number): number {
  return payloadT * 1000 + Math.max(0, now - receivedAt);
}

export type ClosureState = 'in-force' | 'not-yet' | 'ended' | 'unreadable';

/** Milliseconds for an ISO stamp: `null` when absent, `NaN` when unreadable. */
function stampMs(iso: string | undefined): number | null {
  if (iso === undefined || iso === null) return null;
  if (iso === '') return Number.NaN;
  return Date.parse(iso);
}

/**
 * Whether this row's window covers `nowMs` — the only thing that decides
 * whether the stop is drawn.
 *
 * An absent bound is open-ended, which is honest: the row is in TfL's
 * current-disruption feed and states nothing that bounds it. An UNREADABLE
 * bound is not: it would put a mark on the map the data does not state, in
 * either direction, so it is dropped and counted.
 */
export function closureState(stop: BusStopClosure, nowMs: number): ClosureState {
  const from = stampMs(stop.f);
  const to = stampMs(stop.t);
  if (Number.isNaN(from) || Number.isNaN(to)) return 'unreadable';
  if (from !== null && from > nowMs) return 'not-yet';
  if (to !== null && to < nowMs) return 'ended';
  return 'in-force';
}

function hasPosition(stop: BusStopClosure): boolean {
  return Number.isFinite(stop.lat) && Number.isFinite(stop.lon);
}

function londonLabel(iso: string | undefined): string {
  const at = stampMs(iso);
  if (at === null || Number.isNaN(at)) return '';
  // Closures routinely span days, so a bare HH:MM would read as today.
  return new Date(at).toLocaleString([], {
    timeZone: LONDON_TIME_ZONE,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** The closure window in London time, worded from what the row actually says. */
export function closureWindowLabel(stop: BusStopClosure): string {
  const from = londonLabel(stop.f);
  const to = londonLabel(stop.t);
  if (from && to) return `${from} – ${to}`;
  if (from) return `Since ${from}`;
  if (to) return `Until ${to}`;
  return '';
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}

function toProps(stop: BusStopClosure): ClosureProps {
  return {
    id: stop.id ?? '',
    name: stop.name ?? 'Bus stop',
    // Numeric-aware so "9" sorts before "24" and "N29" after "176" — the same
    // idiom as listActiveBusLines in layers/buses.ts.
    routes: [...(stop.routes ?? [])]
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .join(', '),
    towards: stop.towards ?? '',
    // NOT defaulted to "Closure". An absent `ty` states nothing, and inventing
    // the most specific claim the layer can make for a row that made none is
    // exactly the mark the upstream data does not state.
    ty: stop.ty ?? '',
    when: closureWindowLabel(stop),
    description: stop.d ?? '',
  };
}

export interface BuiltClosures {
  readonly features: GeoJSON.Feature[];
  readonly droppedNoCoords: number;
  readonly droppedNotInForce: number;
  readonly droppedUnreadableWindow: number;
}

/** One point feature per stop that is both positioned and in force right now. */
export function buildClosureFeatures(
  stops: readonly BusStopClosure[],
  nowMs: number,
): BuiltClosures {
  const features: GeoJSON.Feature[] = [];
  let droppedNoCoords = 0;
  let droppedNotInForce = 0;
  let droppedUnreadableWindow = 0;

  for (const stop of stops) {
    const state = closureState(stop, nowMs);
    if (state === 'unreadable') {
      droppedUnreadableWindow += 1;
      continue;
    }
    if (state !== 'in-force') {
      droppedNotInForce += 1;
      continue;
    }
    if (!hasPosition(stop)) {
      droppedNoCoords += 1;
      continue;
    }
    features.push({
      type: 'Feature',
      properties: toProps(stop),
      geometry: { type: 'Point', coordinates: [stop.lon as number, stop.lat as number] },
    });
  }
  return { features, droppedNoCoords, droppedNotInForce, droppedUnreadableWindow };
}

// ── popup ──

/** Only "Closure" may be worded as closed; anything else keeps TfL's own word,
 * because the map must not claim more than the row states. */
const TYPE_WORDS: Record<string, string> = { Closure: '⛔ Bus stop closed' };

/** A row TfL gave no type at all. The pin is honest — the pole IS in the
 * current-disruption feed with a window covering now — but the wording may go
 * no further than that, so it names the fact and not a kind of disruption. */
const UNTYPED_TITLE = '⚠ Disruption';

const titleFor = (props: ClosureProps): string => {
  if (!props.ty) return UNTYPED_TITLE;
  return TYPE_WORDS[props.ty] ?? `⚠ ${props.ty}`;
};

const textLine = (text: string, className?: string): string =>
  text ? `<div${className ? ` class="${className}"` : ''}>${esc(text)}</div>` : '';

export function closurePopupHtml(props: ClosureProps): string {
  return `<div class="vp"><div class="sp-title">${esc(titleFor(props))}</div>
    ${textLine(props.name, 'vp-dest')}
    ${textLine(props.towards ? `towards ${props.towards}` : '', 'vp-dim')}
    ${textLine(props.routes ? `Routes: ${props.routes}` : '')}
    ${textLine(props.when, 'vp-status')}
    ${textLine(truncate(props.description, DESCRIPTION_MAX_CHARS), 'vp-dim')}</div>`;
}

function hoverHtml(props: ClosureProps): string {
  return `<div class="vp">${esc(titleFor(props))}
    ${textLine(props.name, 'vp-dest')}
    ${textLine(props.routes, 'vp-dim')}</div>`;
}

// ── map wiring ──

function wireInteractions(map: MaplibreMap, layerId: string): void {
  const tip = new Popup({
    closeButton: false,
    closeOnClick: false,
    offset: 10,
    className: 'hover-tip',
  });
  map.on('mousemove', layerId, (e: MapLayerMouseEvent) => {
    const props = e.features?.[0]?.properties as ClosureProps | undefined;
    if (!props) return;
    map.getCanvas().style.cursor = 'pointer';
    tip.setLngLat(e.lngLat).setHTML(hoverHtml(props)).addTo(map);
  });
  map.on('mouseleave', layerId, () => {
    map.getCanvas().style.cursor = '';
    tip.remove();
  });

  const detail = new Popup({ closeButton: true, closeOnClick: true, offset: 12, maxWidth: '320px' });
  map.on('click', layerId, (e: MapLayerMouseEvent) => {
    // A closure pin sits on the pavement beside a station entrance often
    // enough that both would answer the same tap with a popup; the dot wins.
    if (anyFeatureAt(map, e.point, DOT_LAYER_IDS)) return;
    const props = e.features?.[0]?.properties as ClosureProps | undefined;
    if (!props) return;
    tip.remove();
    detail.setLngLat(e.lngLat).setHTML(closurePopupHtml(props)).addTo(map);
  });
}

function addLayers(map: MaplibreMap): void {
  // Beneath the station dots, like every other overlay point layer: a tap on a
  // dot must still open the station card.
  const anchor = below(map, DOTS_ANCHOR_LAYER_ID);
  map.addLayer(
    {
      id: BUS_STOP_CLOSURES_HALO_LAYER_ID,
      type: 'circle',
      source: SOURCE_ID,
      minzoom: MIN_ZOOM,
      // Off by default; the legend toggle flips visibility on opt-in.
      layout: { visibility: 'none' },
      paint: {
        'circle-radius': HALO_RADIUS,
        'circle-color': CLOSURE_COLOR,
        'circle-opacity': 0.18,
        'circle-blur': 0.8,
      },
    },
    anchor,
  );
  map.addLayer(
    {
      id: BUS_STOP_CLOSURES_CORE_LAYER_ID,
      type: 'circle',
      source: SOURCE_ID,
      minzoom: MIN_ZOOM,
      layout: { visibility: 'none' },
      paint: {
        'circle-radius': CORE_RADIUS,
        'circle-color': CLOSURE_COLOR,
        'circle-opacity': 0.95,
        'circle-stroke-color': '#0a0a0a',
        'circle-stroke-width': 1,
      },
    },
    anchor,
  );
}

function setData(map: MaplibreMap, features: GeoJSON.Feature[]): void {
  const src = map.getSource(SOURCE_ID);
  if (src && 'setData' in src) {
    (src as GeoJSONSource).setData({ type: 'FeatureCollection', features });
  }
}

/** OFF by default, mirroring the legend row's startOff. */
let overlayOn = false;
/** Set by startBusStopClosures so the toggle can force an immediate refresh. */
let refresh: (() => void) | null = null;

/** Legend toggle handler: visibility flip + poll gate. */
export function setBusStopClosuresVisible(map: MaplibreMap, visible: boolean): void {
  overlayOn = visible;
  for (const id of BUS_STOP_CLOSURES_LAYER_IDS) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
  }
  if (visible) refresh?.();
}

export async function startBusStopClosures(map: MaplibreMap): Promise<void> {
  map.addSource(SOURCE_ID, {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });
  addLayers(map);

  let payload: BusStopClosuresPayload | null = null;
  let receivedAt = 0;
  /** Last breakdown that was logged, so the minute tick does not repeat it. */
  let loggedDrops = '';

  /** Nothing vanishes silently: the counters always carry the full breakdown,
   * and an ANOMALOUS drop (a pole with no position, a window that cannot be
   * read) also says so on the console the first time it appears. Rows filtered
   * out for not being in force are the overlay working, not a failure, so they
   * ride along in the message rather than raising one of their own. */
  function logDrops(built: BuiltClosures, total: number): void {
    if (built.droppedNoCoords === 0 && built.droppedUnreadableWindow === 0) {
      loggedDrops = '';
      return;
    }
    const line =
      `[bus-stop-closures] of ${total} row(s): ${built.droppedNoCoords} without a position, ` +
      `${built.droppedUnreadableWindow} with an unreadable window, ` +
      `${built.droppedNotInForce} not in force now`;
    if (line === loggedDrops) return;
    loggedDrops = line;
    console.warn(line);
  }

  /** Re-filters the payload in hand against a freshly anchored "now". */
  function rebuild(): void {
    if (!overlayOn || !payload || typeof payload.t !== 'number') return;
    const stops = payload.stops ?? [];
    const built = buildClosureFeatures(stops, serverNowMs(payload.t, receivedAt, Date.now()));
    stats.received = stops.length;
    stats.drawn = built.features.length;
    stats.droppedNoCoords = built.droppedNoCoords;
    stats.droppedNotInForce = built.droppedNotInForce;
    stats.droppedUnreadableWindow = built.droppedUnreadableWindow;
    logDrops(built, stops.length);
    setData(map, built.features);
  }

  /** The one place a failure is recorded, so both call paths below leave the
   * same trail: a counter, the reason, and a [bus-stop-closures] line. */
  function noteFailure(error: unknown): void {
    stats.pollFailures += 1;
    stats.lastPollError = error instanceof Error ? error.message : String(error);
    console.error('[bus-stop-closures]', error);
  }

  /**
   * The minute tick's entry point. rebuild() throwing inside poll() is caught
   * below, but the tick fetches nothing, so an unguarded throw there would land
   * in the interval callback: no counter, no reason, no log line to grep, and
   * busStopClosuresStats() still reporting a clean layer that has quietly
   * stopped re-deriving its state.
   */
  function tickRebuild(): void {
    try {
      rebuild();
    } catch (error) {
      noteFailure(error);
    }
  }

  async function poll(): Promise<void> {
    if (!overlayOn) return;
    try {
      const res = await fetch(CLOSURES_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as BusStopClosuresPayload;
      // A 200 from an intermediary (error page, captive portal) must never
      // reach setData; an empty stops[] is fine and clears the map.
      if (!Array.isArray(body?.stops)) throw new Error('unexpected bus-stop-closures payload shape');
      // Without the server clock there is nothing safe to compare a window to,
      // and the browser clock is explicitly not an acceptable substitute.
      if (typeof body.t !== 'number' || !Number.isFinite(body.t)) {
        throw new Error('bus-stop-closures payload carries no server timestamp');
      }
      payload = body;
      receivedAt = Date.now();
      stats.polls += 1;
      stats.lastPollError = '';
      rebuild();
    } catch (error) {
      // Keep the previous picture; the next poll retries. But NEVER swallow the
      // reason: a permanently failing route and a genuine "nothing is closed"
      // look identical on the map, and only this line tells them apart.
      noteFailure(error);
    }
  }
  refresh = () => void poll();

  wireInteractions(map, BUS_STOP_CLOSURES_CORE_LAYER_ID);

  // No-op while the overlay is off, which is how it ships: zero requests until
  // someone asks for the layer.
  await poll();
  registerPoll(() => void poll(), POLL_INTERVAL_MS);
  // The window is time-dependent, so it is re-derived without a fetch.
  registerPoll(tickRebuild, TICK_INTERVAL_MS);
}
