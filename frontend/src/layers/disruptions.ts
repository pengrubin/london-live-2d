// Rail disruption bands (/api/disruptions, spec §6) — map wiring and paint.
//
// The map draws ONLY what TfL states as structured NaPTAN ids: the ordered
// `sec[].st` paths and `pts[]` the backend resolved from `affectedRoutes` /
// `affectedStops`. There is no sentence parsing here and no geometry guess:
// an item the backend could not localise (`sc: 'line'`) draws NOTHING — a mark
// at a place would imply a place — and reaches the rider as text in the Lines
// tab instead (control-panel.ts) plus a pip on its line row (legend.ts).
//
// The contract, the hop index, feature building and the popup are in
// disruptions-model.ts (no maplibre import, so they stay unit-testable); this
// module re-exports that public surface so callers have one entry point.

import {
  Popup,
  type ExpressionSpecification,
  type GeoJSONSource,
  type Map as MaplibreMap,
  type MapLayerMouseEvent,
} from 'maplibre-gl';
import type { LineBranches } from '../realtime/types';
import { fetchJson } from '../services/static-data';
import { below } from '../util/layer-order';
import { registerPoll } from '../util/lifecycle';
import { isLayerShown } from '../util/render-gate';
import { LINE_OFFSET_RAMP, LINE_WIDTH_RAMP } from './transit-lines';
import {
  currencyOf,
  disruptionPopupHtml,
  disruptionsStats,
  EMPTY_SNAPSHOT,
  payloadAgeMs,
  publishSnapshot,
  serverAgeMs,
  toFeatures,
  CLOSED_COLOR,
  HATCH_COLOR,
  INFO_COLOR,
  MINOR_COLOR,
  PLANNED_COLOR,
  SEVERE_COLOR,
  STALE_COLOR,
  type BandProps,
  type DisruptionsPayload,
  type PayloadArrival,
} from './disruptions-model';

export type {
  BandProps,
  BuiltFeatures,
  Currency,
  DisruptionClass,
  DisruptionItem,
  DisruptionPoint,
  DisruptionSection,
  DisruptionSource,
  DisruptionValidity,
  DisruptionsPayload,
  FeatureContext,
  PayloadArrival,
  ServiceRow,
  Snapshot,
  StationNoticeLine,
} from './disruptions-model';
export {
  currencyOf,
  disruptionPopupHtml,
  disruptionsConnectionLost,
  disruptionsExpired,
  disruptionsStale,
  disruptionsForStation,
  disruptionsStats,
  linePip,
  onDisruptionsUpdate,
  payloadAgeMs,
  sectionGeometry,
  serverAgeMs,
  serviceStripRows,
  STALE_SUFFIX,
  stationDisruptionLines,
  toFeatures,
} from './disruptions-model';

// ── ids ──

export const DISRUPTIONS_SOURCE_ID = 'disruptions';
export const DISRUPTIONS_PLANNED_SOURCE_ID = 'disruptions-planned';
export const DISRUPTIONS_STATIONS_SOURCE_ID = 'disruptions-stations';
export const DISRUPTIONS_STATIONS_PLANNED_SOURCE_ID = 'disruptions-stations-planned';

export const DISRUPTIONS_WASH_LAYER_ID = 'disruptions-wash';
export const DISRUPTIONS_CORE_LAYER_ID = 'disruptions-core';
export const DISRUPTIONS_HATCH_LAYER_ID = 'disruptions-hatch';
export const DISRUPTIONS_PLANNED_LAYER_ID = 'disruptions-planned';
export const DISRUPTIONS_STATIONS_LAYER_ID = 'disruptions-stations-ring';
export const DISRUPTIONS_STATIONS_PLANNED_LAYER_ID = 'disruptions-stations-planned';

/** "Disruptions" toggle — live items only. */
export const DISRUPTIONS_LAYER_IDS = [
  DISRUPTIONS_WASH_LAYER_ID,
  DISRUPTIONS_CORE_LAYER_ID,
  DISRUPTIONS_HATCH_LAYER_ID,
  DISRUPTIONS_STATIONS_LAYER_ID,
];
/** "Planned works" toggle — its own sources, because the Lines-tab filter
 * REPLACES a layer's filter and so could not keep live and planned apart. */
export const DISRUPTIONS_PLANNED_IDS = [
  DISRUPTIONS_PLANNED_LAYER_ID,
  DISRUPTIONS_STATIONS_PLANNED_LAYER_ID,
];

const ALL_SOURCE_IDS = [
  DISRUPTIONS_SOURCE_ID,
  DISRUPTIONS_PLANNED_SOURCE_ID,
  DISRUPTIONS_STATIONS_SOURCE_ID,
  DISRUPTIONS_STATIONS_PLANNED_SOURCE_ID,
];

// ── constants ──

/** The route caches for 60 s; 90 s keeps at most one wasted hit per copy. */
const POLL_INTERVAL_MS = 90_000;
/** Re-derives currency without a fetch, so a dead backend still clears. */
const TICK_INTERVAL_MS = 60_000;
const DISRUPTIONS_URL = '/api/disruptions';
const RING_MIN_ZOOM = 10;
/**
 * Failed polls before the UI calls the feed lost. Two 90 s polls is ~3 min —
 * well inside the 10 min un-draw, so the strip says "unavailable" long before
 * the map silently empties.
 */
const CONNECTION_LOST_AFTER_FAILURES = 2;
/** Layer the bands and rings sit under, in every insertion and in raise. */
const DOTS_ANCHOR_LAYER_ID = 'stations-circle';
const PLANNED_MIN_ZOOM = 11;

// ── paint ──

const CLASS_COLOR: ExpressionSpecification = [
  'match',
  ['get', 'k'],
  'closed',
  CLOSED_COLOR,
  'severe',
  SEVERE_COLOR,
  'minor',
  MINOR_COLOR,
  INFO_COLOR,
];

/** One greyed picture past 5 minutes — the data is no longer worth its colour. */
const whenStale = (normal: ExpressionSpecification | string): ExpressionSpecification => [
  'case',
  ['get', 'stale'],
  STALE_COLOR,
  normal,
];

const WASH_WIDTH_RAMP: ExpressionSpecification = [
  'interpolate',
  ['linear'],
  ['zoom'],
  9,
  6,
  13,
  12,
  16,
  22,
];
/** Shape, not colour, says which class: closed and severe read as a solid
 * wash, minor as a dotted one. A zero-length gap is how the style spec writes
 * "solid" once the dash array has to be data-driven. */
const WASH_DASH: ExpressionSpecification = [
  'match',
  ['get', 'k'],
  'minor',
  ['literal', [0.6, 1.4]],
  ['literal', [1, 0]],
];
const WASH_OPACITY: ExpressionSpecification = ['match', ['get', 'k'], 'minor', 0.45, 0.55];
/** The hatch layer sees every band; only closed ones are painted. A filter
 * would be REPLACED by the Lines-tab line filter, so this is opacity-driven. */
const HATCH_OPACITY: ExpressionSpecification = ['match', ['get', 'k'], 'closed', 0.9, 0];
// The network's own width ramp plus a constant, written out rather than
// composed with an arithmetic expression: a "zoom" expression may only be the
// input of a TOP-LEVEL step/interpolate, so wrapping the ramp in arithmetic
// makes addLayer reject the whole layer.
const HATCH_WIDTH_RAMP: ExpressionSpecification = [
  'interpolate',
  ['exponential', 1.4],
  ['zoom'],
  9,
  2.5,
  12,
  3.7,
  14,
  5.5,
  16,
  7,
];
const PLANNED_WIDTH_RAMP: ExpressionSpecification = [
  'interpolate',
  ['exponential', 1.4],
  ['zoom'],
  9,
  3,
  12,
  4.2,
  14,
  6,
  16,
  7.5,
];
const RING_RADIUS_RAMP: ExpressionSpecification = [
  'interpolate',
  ['linear'],
  ['zoom'],
  10,
  ['case', ['==', ['get', 'role'], 'mid'], 3.1, 4.6],
  13,
  ['case', ['==', ['get', 'role'], 'mid'], 4.3, 5.8],
  16,
  ['case', ['==', ['get', 'role'], 'mid'], 6, 7.5],
];
const IS_CAUSE: ExpressionSpecification = ['==', ['get', 'role'], 'cause'];

function addLiveBandLayers(map: MaplibreMap): void {
  map.addLayer(
    {
      id: DISRUPTIONS_WASH_LAYER_ID,
      type: 'line',
      source: DISRUPTIONS_SOURCE_ID,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': whenStale(CLASS_COLOR),
        'line-opacity': WASH_OPACITY,
        'line-width': WASH_WIDTH_RAMP,
        'line-blur': 1.5,
        'line-dasharray': WASH_DASH,
        'line-offset': LINE_OFFSET_RAMP,
      },
    },
    below(map, DOTS_ANCHOR_LAYER_ID),
  );
  // Line-coloured core: on the shared Circle / District / H&C / Met corridor
  // the wash alone cannot say WHICH line is shut.
  map.addLayer(
    {
      id: DISRUPTIONS_CORE_LAYER_ID,
      type: 'line',
      source: DISRUPTIONS_SOURCE_ID,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': whenStale(['get', 'color']),
        'line-width': LINE_WIDTH_RAMP,
        'line-offset': LINE_OFFSET_RAMP,
      },
    },
    below(map, DOTS_ANCHOR_LAYER_ID),
  );
  map.addLayer(
    {
      id: DISRUPTIONS_HATCH_LAYER_ID,
      type: 'line',
      source: DISRUPTIONS_SOURCE_ID,
      layout: { 'line-cap': 'butt', 'line-join': 'round' },
      paint: {
        'line-color': HATCH_COLOR,
        'line-opacity': HATCH_OPACITY,
        'line-width': HATCH_WIDTH_RAMP,
        'line-dasharray': [1.4, 1.4],
        'line-offset': LINE_OFFSET_RAMP,
      },
    },
    below(map, DOTS_ANCHOR_LAYER_ID),
  );
}

function addPlannedBandLayer(map: MaplibreMap): void {
  map.addLayer(
    {
      id: DISRUPTIONS_PLANNED_LAYER_ID,
      type: 'line',
      source: DISRUPTIONS_PLANNED_SOURCE_ID,
      minzoom: PLANNED_MIN_ZOOM,
      layout: { 'line-cap': 'butt', 'line-join': 'round', visibility: 'none' },
      paint: {
        'line-color': whenStale(PLANNED_COLOR),
        'line-opacity': 0.85,
        'line-width': PLANNED_WIDTH_RAMP,
        'line-dasharray': [3, 2],
        'line-offset': LINE_OFFSET_RAMP,
      },
    },
    below(map, DOTS_ANCHOR_LAYER_ID),
  );
}

function addRingLayer(map: MaplibreMap, layerId: string, sourceId: string, planned: boolean): void {
  map.addLayer(
    {
      id: layerId,
      type: 'circle',
      source: sourceId,
      minzoom: planned ? PLANNED_MIN_ZOOM : RING_MIN_ZOOM,
      layout: planned ? { visibility: 'none' } : {},
      paint: {
        'circle-radius': RING_RADIUS_RAMP,
        'circle-color': whenStale(planned ? PLANNED_COLOR : CLASS_COLOR),
        'circle-opacity': ['case', IS_CAUSE, 0, 0.9],
        'circle-stroke-color': ['case', IS_CAUSE, SEVERE_COLOR, HATCH_COLOR],
        'circle-stroke-width': ['case', IS_CAUSE, 2, 1],
      },
    },
    // Under the station dots: a tap on a dot must still open the station popup.
    below(map, DOTS_ANCHOR_LAYER_ID),
  );
}

// ── interaction ──

/** MapLibre fires every layer-scoped handler whose layer has a feature under
 * the point, and a 6-22 px band runs through every station of a section — so
 * the band yields whenever a dot owns the tap. */
const DOT_LAYER_IDS = ['stations-circle', 'trains-dots', 'nr-trains-dots', 'buses-dots'];

function dotUnderTap(map: MaplibreMap, point: MapLayerMouseEvent['point']): boolean {
  const layers = DOT_LAYER_IDS.filter((id) => map.getLayer(id));
  if (layers.length === 0) return false;
  return map.queryRenderedFeatures(point, { layers }).length > 0;
}

function wireInteractions(map: MaplibreMap, layerIds: readonly string[]): void {
  const detail = new Popup({ closeButton: true, closeOnClick: true, offset: 12, maxWidth: '340px' });
  for (const layerId of layerIds) {
    map.on('click', layerId, (e: MapLayerMouseEvent) => {
      if (dotUnderTap(map, e.point)) return;
      const props = e.features?.[0]?.properties as BandProps | undefined;
      if (!props) return;
      detail.setLngLat(e.lngLat).setHTML(disruptionPopupHtml(props)).addTo(map);
    });
    map.on('mouseenter', layerId, () => {
      map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', layerId, () => {
      map.getCanvas().style.cursor = '';
    });
  }
}

// ── lifecycle ──

export interface DisruptionsDeps {
  /** Branch geometry already loaded by the trains controller, or null. */
  readonly getBranches: () => ReadonlyMap<string, LineBranches> | null;
  readonly colorByLine: ReadonlyMap<string, string>;
  readonly nameByLine: ReadonlyMap<string, string>;
}

/** Default ON (spec §6.4); planned works default OFF. */
let liveOn = true;
let plannedOn = false;
let refresh: (() => void) | null = null;

function setVisibility(map: MaplibreMap, layerIds: readonly string[], visible: boolean): void {
  for (const id of layerIds) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
  }
}

export function setDisruptionsVisible(map: MaplibreMap, visible: boolean): void {
  liveOn = visible;
  setVisibility(map, DISRUPTIONS_LAYER_IDS, visible);
  if (visible) refresh?.();
}

export function setPlannedWorksVisible(map: MaplibreMap, visible: boolean): void {
  plannedOn = visible;
  setVisibility(map, DISRUPTIONS_PLANNED_IDS, visible);
  if (visible) refresh?.();
}

/**
 * Re-anchors every disruption layer just under the station dots (spec §6.1).
 * Insertion order alone cannot settle this: the three overlay washes (rail
 * disruptions, roadworks, bus diversions) all insert `below('stations-circle')`
 * and MapLibre gives the LAST inserted the highest z, so whichever layer
 * happens to start last wins. Bus diversions start after this one, which would
 * put a translucent bus wash on top of a rail closure. main.ts calls this once
 * after every layer has settled, which makes the stacking explicit.
 */
export function raiseDisruptions(map: MaplibreMap): void {
  const anchor = below(map, DOTS_ANCHOR_LAYER_ID);
  for (const id of [...DISRUPTIONS_LAYER_IDS, ...DISRUPTIONS_PLANNED_IDS]) {
    if (map.getLayer(id)) map.moveLayer(id, anchor);
  }
}

function setData(map: MaplibreMap, sourceId: string, features: GeoJSON.Feature[]): void {
  const src = map.getSource(sourceId);
  if (src && 'setData' in src) {
    (src as GeoJSONSource).setData({ type: 'FeatureCollection', features });
  }
}

export async function startDisruptions(map: MaplibreMap, deps: DisruptionsDeps): Promise<void> {
  for (const id of ALL_SOURCE_IDS) {
    map.addSource(id, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  }
  // Between the static network and the station dots, like roadworks and bus
  // diversions: above transit-lines-line, beneath every dot layer.
  addLiveBandLayers(map);
  addPlannedBandLayer(map);
  addRingLayer(map, DISRUPTIONS_STATIONS_LAYER_ID, DISRUPTIONS_STATIONS_SOURCE_ID, false);
  addRingLayer(
    map,
    DISRUPTIONS_STATIONS_PLANNED_LAYER_ID,
    DISRUPTIONS_STATIONS_PLANNED_SOURCE_ID,
    true,
  );
  wireInteractions(map, [
    DISRUPTIONS_WASH_LAYER_ID,
    DISRUPTIONS_STATIONS_LAYER_ID,
    DISRUPTIONS_PLANNED_LAYER_ID,
    DISRUPTIONS_STATIONS_PLANNED_LAYER_ID,
  ]);

  // Branch geometry: the trains controller already downloaded all 1.0 MB of
  // it. Only when there is no train pipeline does this fetch a line's file
  // lazily, tolerating a 404 (the section then drops, as a missing hop would).
  const lazyBranches = new Map<string, LineBranches | null>();
  async function ensureBranches(
    lineIds: readonly string[],
  ): Promise<ReadonlyMap<string, LineBranches>> {
    const shared = deps.getBranches();
    if (shared) return shared;
    await Promise.all(
      lineIds
        .filter((id) => !lazyBranches.has(id))
        .map(async (id) => {
          try {
            lazyBranches.set(id, await fetchJson<LineBranches>(`/branches/${id}.json`));
          } catch {
            lazyBranches.set(id, null); // 404 or malformed: draw nothing for it
          }
        }),
    );
    const loaded = new Map<string, LineBranches>();
    for (const [id, branches] of lazyBranches) if (branches) loaded.set(id, branches);
    return loaded;
  }

  const stats = disruptionsStats();
  let payload: DisruptionsPayload | null = null;
  let arrival: PayloadArrival = { serverAgeMs: 0, receivedAt: 0 };

  /** True once enough polls in a row have failed to call the feed lost. */
  function connectionLost(): boolean {
    return stats.consecutiveFailures >= CONNECTION_LOST_AFTER_FAILURES;
  }

  function clearEverything(): void {
    payload = null;
    stats.staleCleared += 1;
    for (const id of ALL_SOURCE_IDS) setData(map, id, []);
    publishSnapshot({
      ...EMPTY_SNAPSHOT,
      names: deps.nameByLine,
      colors: deps.colorByLine,
      connectionLost: connectionLost(),
    });
  }

  async function rebuild(): Promise<void> {
    // No payload yet: still publish, so a failing first poll shows as an
    // outage in the Service strip rather than as a silent empty map.
    if (!payload) {
      publishSnapshot({
        ...EMPTY_SNAPSHOT,
        names: deps.nameByLine,
        colors: deps.colorByLine,
        connectionLost: connectionLost(),
      });
      return;
    }
    const age = payloadAgeMs(arrival, Date.now());
    const currency = currencyOf(age);
    // A hatch that never clears is worse than an empty map: a non-OK response
    // keeps the last picture only until the payload turns 10 minutes old.
    if (currency === 'expired') {
      clearEverything();
      return;
    }
    const items = payload.items ?? [];
    publishSnapshot({
      items,
      names: deps.nameByLine,
      colors: deps.colorByLine,
      expired: false,
      // The same currency the bands are greyed by, so the strip, the pips and
      // the station popup cannot disagree with the map about one hiccup.
      stale: currency === 'stale',
      connectionLost: connectionLost(),
    });
    const shown =
      isLayerShown(map, DISRUPTIONS_WASH_LAYER_ID) ||
      isLayerShown(map, DISRUPTIONS_PLANNED_LAYER_ID);
    if (!shown) return;
    const lineIds = [...new Set(items.map((item) => item.l ?? '').filter(Boolean))];
    const built = toFeatures(payload, {
      branchesByLine: await ensureBranches(lineIds),
      colorByLine: deps.colorByLine,
      nameByLine: deps.nameByLine,
      nowMs: (payload.t ?? 0) * 1000 + age,
      stale: currency === 'stale',
    });
    stats.items = items.length;
    stats.sectionsDrawn = built.sectionsDrawn;
    stats.sectionsDroppedMissingHop = built.sectionsDroppedMissingHop;
    setData(map, DISRUPTIONS_SOURCE_ID, built.live);
    setData(map, DISRUPTIONS_PLANNED_SOURCE_ID, built.planned);
    setData(map, DISRUPTIONS_STATIONS_SOURCE_ID, built.liveStations);
    setData(map, DISRUPTIONS_STATIONS_PLANNED_SOURCE_ID, built.plannedStations);
  }

  async function poll(): Promise<void> {
    if (!liveOn && !plannedOn) return;
    try {
      const res = await fetch(DISRUPTIONS_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as DisruptionsPayload;
      // A 200 from an intermediary (error page, captive portal) must never
      // reach setData; an empty items[] is fine and clears the map.
      if (!Array.isArray(body?.items)) throw new Error('unexpected disruptions payload shape');
      payload = body;
      arrival = {
        serverAgeMs: serverAgeMs(body.t, res.headers.get('date')),
        receivedAt: Date.now(),
      };
      stats.polls += 1;
      stats.consecutiveFailures = 0;
      stats.lastPollError = '';
      stats.lastPayloadAt = body.t ?? 0;
    } catch (error) {
      // Keep the previous picture; rebuild() clears it once it is 10 min old.
      // But NEVER swallow the reason: a permanently 404ing route and a genuine
      // all-clear look identical on the map, and only this line tells them
      // apart. Modelled on diversions.ts's own catch.
      stats.pollFailures += 1;
      stats.consecutiveFailures += 1;
      stats.lastPollError = error instanceof Error ? error.message : String(error);
      console.error('[disruptions]', error);
    }
    await rebuild();
  }
  // Turning the overlay back on must not wait up to 90 s for the next poll
  // when the last payload was already cleared as too old.
  refresh = () => void (payload ? rebuild() : poll());

  await poll();
  registerPoll(() => void poll(), POLL_INTERVAL_MS);
  // Currency is time-dependent, so it is re-derived without a fetch. A raw
  // setInterval would keep ticking on a hidden page; registerPoll pauses.
  registerPoll(() => void rebuild(), TICK_INTERVAL_MS);
}
