// Learned route shape for the filtered bus line(s). Selecting "24" in the Bus
// Filter draws the polylines the backend learner built for that route — the
// path the buses actually take, not a schematic — so the spotlighted dots have
// a road to sit on. Clearing the filter removes it.
//
// Which shapes: live vehicles first. A selected line with buses running
// contributes exactly THOSE buses' route keys, so what is drawn is what is
// moving. A line with nothing live falls back to the learner's index, which is
// keyed only by line NUMBER — and numbers are reused by intercity coaches, so
// index-derived shapes must additionally sit inside the region (see
// INSIDE_FRACTION_MIN). Resolution lives here (resolveRouteKeys) over the fleet
// and index accessors buses.ts exposes; geometry comes from the SAME cache the
// snapping path fills, so a line already on screen costs zero network.
//
// Both directions are drawn identically, with no offset: where they share a
// road the opaque strokes coincide into one line, and where they genuinely
// diverge (gyratories, terminus loops) two strands appear — the picture splits
// exactly where the route does.
//
// Not a legend layer: it has no toggle and is driven purely by the filter via
// the hook registered below.
//
// v1 limitation: shapes resolve on filter change only. A line that gains its
// first live bus after being selected keeps its index-derived shape until the
// filter is re-applied.

import type { ExpressionSpecification, GeoJSONSource, Map as MaplibreMap } from 'maplibre-gl';
import { below } from '../util/layer-order';
import { isInsideRegion } from '../region';
import {
  BUSES_DOTS_LAYER_ID,
  activeBusRoutes,
  busRouteIndex,
  forgetRouteGeometry,
  loadRouteGeometry,
  setBusRouteShapeHook,
  type BusRouteIndex,
  type LiveBusRoute,
} from './buses';

export const BUS_ROUTE_SHAPE_CASING_LAYER_ID = 'bus-route-shape-casing';
export const BUS_ROUTE_SHAPE_LINE_LAYER_ID = 'bus-route-shape-line';
const SOURCE_ID = 'bus-route-shape';

/** Pure white — the only line channel this map has not spent. Central-line red
 * (#E32017), Bus Flow ice (#0891b2/#a5f3fc) and the Diversions orange/red are
 * all taken, and white is also the one achromatic choice that survives every
 * CVD type on a basemap already carrying eleven tube brand hues. */
const HIGHLIGHT_CORE_COLOR = '#FFFFFF';
/** Near-black with a faint blue bias so it reads as shadow, not mud, against
 * the basemap's #1f1f1f earth. */
const HIGHLIGHT_CASING_COLOR = '#05070A';
/** Opaque core: translucent white greys out against a dark basemap. */
const HIGHLIGHT_CORE_OPACITY = 1;
/** Semi-transparent casing so a crossing tube line is dimmed, never erased. */
const HIGHLIGHT_CASING_OPACITY = 0.55;

/** Same curve as the transit-line width ramps, so the highlight tracks the
 * network it sits on rather than drifting relative to it with zoom. */
const HIGHLIGHT_CORE_WIDTH: ExpressionSpecification = [
  'interpolate',
  ['exponential', 1.4],
  ['zoom'],
  9,
  2.0,
  12,
  3.2,
  14,
  4.4,
  16,
  6.0,
];
const HIGHLIGHT_CASING_WIDTH: ExpressionSpecification = [
  'interpolate',
  ['exponential', 1.4],
  ['zoom'],
  9,
  5.0,
  12,
  7.0,
  14,
  9.0,
  16,
  11.5,
];
/** Halo softness grows with the casing so it never hardens into a black bar. */
const HIGHLIGHT_CASING_BLUR: ExpressionSpecification = [
  'interpolate',
  ['linear'],
  ['zoom'],
  9,
  0.8,
  16,
  2.0,
];

/** Above the transit geometry and Bus Flow, below station dots/labels and both
 * bus vehicle tiers — the white must win over the tube colours but must not
 * slice through station names or hide the bullets it is drawn for. */
const INSERT_BEFORE_LAYER_ID = 'stations-circle';

/**
 * An index-derived shape is dropped when fewer than this fraction of its
 * vertices fall inside the region: line numbers are reused by intercity
 * coaches, and at 0.5 exactly the out-of-town ones (Oxford Tube, Metrobus 400,
 * Reading RA1) fail while every genuine outer-London route passes. A bbox
 * intersection test would drop nothing — those coaches all touch London.
 */
const INSIDE_FRACTION_MIN = 0.5;
/** Fallback stems per line — the measured corpus maximum: no line number
 * carries more than six learned stems (460, 200, 20 and 21 each do, as three
 * operators × two directions), so this truncates nothing today while still
 * bounding a line the learner later splits further. */
const MAX_FALLBACK_STEMS_PER_LINE = 6;
/** …and a hard ceiling across the whole selection: the fallback path is the
 * only branch that can request many uncached files at once. */
const MAX_FALLBACK_FETCHES = 12;
/**
 * The local operator, ranked ahead of every other operator's stems within a
 * line before the caps apply. TFLO is BODS's code for TfL-contracted London
 * buses, and line numbers are shared with intercity coaches (460 is METR_,
 * NATX_ and TFLO_): index order is alphabetical, so without this ranking a
 * binding cap keeps the coaches and drops the route the user meant. A region
 * with no TFLO stems keeps index order.
 */
const PRIMARY_OPERATOR = 'TFLO';

const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

/** Where a route key came from: an index-derived one has never been confirmed
 * by a live vehicle, so it still has to pass the region test. */
export type BusRouteKeySource = 'live' | 'index';

export interface BusRouteKey {
  /** Sanitized learned-file stem, e.g. "TFLO_24_outbound". */
  readonly key: string;
  /** Uppercased line the key was matched on. */
  readonly line: string;
  readonly source: BusRouteKeySource;
}

/**
 * Split a learned-file stem into operator / line / direction: first segment is
 * the operator, LAST is the direction, everything between is the line (BODS
 * line names are sanitized, so a space or slash would add segments).
 *
 * Fewer than three segments is a reject, not a best effort — /api/bus-routes-index
 * lists every file matching the served-name pattern, which includes the
 * learner's own ".last-run.json" marker.
 */
export function parseRouteStem(
  stem: string,
): { operator: string; line: string; direction: string } | null {
  const parts = stem.split('_');
  if (parts.length < 3) return null;
  const operator = parts[0];
  const direction = parts[parts.length - 1];
  const line = parts.slice(1, -1).join('_');
  if (operator === '' || line === '' || direction === '') return null;
  return { operator, line, direction };
}

/**
 * The index's own casing for `key` when the two differ only by case. Learned
 * files are served by exact name off a case-sensitive filesystem, and the
 * learner has written at least one whose name is cased differently from the
 * key inside it (GOCH_Go2_outbound.json ← "GOCH:go2:outbound"), so a live
 * tracker's own key can 404 while the indexed spelling resolves.
 */
export function indexedKey(key: string, index: BusRouteIndex | null): string {
  if (index === null || index.stems.has(key)) return key;
  return index.folded.get(key.toLowerCase()) ?? key;
}

/**
 * Learned-route file keys to draw for `lines`, live-vehicle first: a line with
 * buses running contributes the distinct routeFileKeys of THOSE buses; a line
 * with none falls back to every indexed stem carrying that line number. Line
 * comparison is exact once uppercased — never numeric, never zero-stripped, as
 * "032" (a coach) and "32" (the London bus) are different routes.
 */
export function resolveRouteKeys(
  lines: ReadonlySet<string>,
  live: Iterable<LiveBusRoute>,
  index: BusRouteIndex | null,
): readonly BusRouteKey[] {
  if (lines.size === 0) return [];
  const wanted = new Set<string>();
  for (const line of lines) wanted.add(line.toUpperCase());

  const out: BusRouteKey[] = [];
  const seen = new Set<string>();
  const hasLive = new Set<string>();

  for (const tr of live) {
    const line = tr.line.toUpperCase();
    if (!wanted.has(line) || tr.routeFileKey === '') continue;
    const key = indexedKey(tr.routeFileKey, index);
    // A live tracker routinely names a file the learner never wrote: 52
    // operator+line pairs are indexed for one direction only (ARHE has 724
    // inbound and no outbound). Fetching that key is a guaranteed 404 — and
    // counting the line as "has live" would additionally suppress the fallback
    // that DOES hold its shape, leaving the selection drawing nothing at all.
    if (index !== null && !index.stems.has(key)) continue;
    hasLive.add(line);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, line, source: 'live' });
  }

  if (index !== null) {
    for (const stem of index.stems) {
      const parsed = parseRouteStem(stem);
      if (parsed === null) continue;
      const line = parsed.line.toUpperCase();
      if (!wanted.has(line) || hasLive.has(line) || seen.has(stem)) continue;
      seen.add(stem);
      out.push({ key: stem, line, source: 'index' });
    }
  }
  return out;
}

/**
 * Monotonic selection counter. Every call to setBusRouteShapeLines bumps it and
 * captures the value; a resolution whose capture no longer matches has been
 * superseded and must not paint, or a slow fetch from an abandoned selection
 * would land on top of the current one.
 */
let generation = 0;

/** Fraction of `poly`'s vertices inside the active region; 0 when empty. */
export function insideFraction(poly: readonly (readonly [number, number])[]): number {
  if (poly.length === 0) return 0;
  let inside = 0;
  for (const [lon, lat] of poly) {
    if (isInsideRegion(lon, lat)) inside += 1;
  }
  return inside / poly.length;
}

/**
 * FeatureCollection for `keys` and their loaded geometry (index-aligned; null
 * where the learned file was missing or malformed). Index-derived keys must
 * also clear INSIDE_FRACTION_MIN — a live vehicle is proof enough of region on
 * its own, and clipping a route the user is watching would be worse than
 * drawing a coach.
 */
export function buildRouteShapeData(
  keys: readonly BusRouteKey[],
  geometries: readonly ([number, number][] | null)[],
): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (let i = 0; i < keys.length; i += 1) {
    const poly = geometries[i];
    if (!poly || poly.length < 2) continue;
    if (keys[i].source === 'index' && insideFraction(poly) < INSIDE_FRACTION_MIN) continue;
    features.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: poly },
      // `line` is carried for a future hover/tap; styling reads neither it nor
      // the direction (owner call: one white treatment for every selected line).
      properties: { line: keys[i].line, key: keys[i].key },
    });
  }
  return { type: 'FeatureCollection', features };
}

/** One line's fallback stems, PRIMARY_OPERATOR's first, otherwise index order.
 * A stable partition rather than a sort: index order carries no meaning beyond
 * operator grouping, so nothing else is worth reordering. */
function rankFallbackStems(stems: readonly BusRouteKey[]): BusRouteKey[] {
  const primary: BusRouteKey[] = [];
  const rest: BusRouteKey[] = [];
  for (const stem of stems) {
    if (parseRouteStem(stem.key)?.operator === PRIMARY_OPERATOR) primary.push(stem);
    else rest.push(stem);
  }
  return [...primary, ...rest];
}

/** Live keys uncapped (already cached by the snapping path); fallback keys
 * capped per line and in total, since only they can trigger a fetch burst. */
export function capRouteKeys(keys: readonly BusRouteKey[]): readonly BusRouteKey[] {
  const byLine = new Map<string, BusRouteKey[]>();
  for (const key of keys) {
    if (key.source !== 'index') continue;
    const stems = byLine.get(key.line);
    if (stems === undefined) byLine.set(key.line, [key]);
    else stems.push(key);
  }
  for (const [line, stems] of byLine) byLine.set(line, rankFallbackStems(stems));

  // Round-robin, not first-come: every selected line gets its best stem before
  // any line gets a second. Allocating in order would let a binding ceiling
  // drop whole lines, and which lines survived would be decided by nothing more
  // meaningful than alphabetical operator order.
  const fallback: BusRouteKey[] = [];
  for (
    let rank = 0;
    rank < MAX_FALLBACK_STEMS_PER_LINE && fallback.length < MAX_FALLBACK_FETCHES;
    rank += 1
  ) {
    for (const stems of byLine.values()) {
      if (fallback.length >= MAX_FALLBACK_FETCHES) break;
      if (rank < stems.length) fallback.push(stems[rank]);
    }
  }
  return [...keys.filter((key) => key.source === 'live'), ...fallback];
}

/**
 * Adds the (empty, hidden) source + both layers, and registers the filter hook.
 * No network traffic here — geometry arrives on the first non-empty selection.
 */
export function startBusRouteShapes(map: MaplibreMap): Promise<void> {
  map.addSource(SOURCE_ID, { type: 'geojson', data: EMPTY });
  // Regions without a drawn transit network lack the station anchor; the bus
  // dots are the next-best "stay under the vehicles" target, and undefined
  // (add on top) is the last resort.
  const beforeId = below(map, INSERT_BEFORE_LAYER_ID) ?? below(map, BUSES_DOTS_LAYER_ID);
  // Casing first: layers sharing a beforeId splice in at the same index, so the
  // core added next ends up directly above it.
  map.addLayer(
    {
      id: BUS_ROUTE_SHAPE_CASING_LAYER_ID,
      type: 'line',
      source: SOURCE_ID,
      layout: { 'line-cap': 'round', 'line-join': 'round', visibility: 'none' },
      paint: {
        'line-color': HIGHLIGHT_CASING_COLOR,
        'line-width': HIGHLIGHT_CASING_WIDTH,
        'line-opacity': HIGHLIGHT_CASING_OPACITY,
        'line-blur': HIGHLIGHT_CASING_BLUR,
      },
    },
    beforeId,
  );
  map.addLayer(
    {
      id: BUS_ROUTE_SHAPE_LINE_LAYER_ID,
      type: 'line',
      source: SOURCE_ID,
      layout: { 'line-cap': 'round', 'line-join': 'round', visibility: 'none' },
      paint: {
        'line-color': HIGHLIGHT_CORE_COLOR,
        'line-width': HIGHLIGHT_CORE_WIDTH,
        'line-opacity': HIGHLIGHT_CORE_OPACITY,
        // Crisp: this layer's whole claim is "the route goes down THAT road".
        'line-blur': 0,
      },
    },
    beforeId,
  );
  setBusRouteShapeHook(setBusRouteShapeLines);
  return Promise.resolve();
}

/**
 * Draw the learned shapes for `lines`; null or an empty set clears them. Called
 * only on a real filter change (see setBusLineFilter) — never per keystroke.
 */
export function setBusRouteShapeLines(map: MaplibreMap, lines: ReadonlySet<string> | null): void {
  if (!map.getLayer(BUS_ROUTE_SHAPE_LINE_LAYER_ID)) return; // region without buses
  generation += 1;
  const gen = generation;
  // Clear before any await: a superseded selection's shape must never linger on
  // screen while the new one loads.
  setData(map, EMPTY);
  if (lines === null || lines.size === 0) {
    setVisible(map, false);
    return;
  }
  setVisible(map, true);
  void resolveShapes(map, lines, gen);
}

async function resolveShapes(
  map: MaplibreMap,
  lines: ReadonlySet<string>,
  gen: number,
): Promise<void> {
  try {
    const keys = capRouteKeys(resolveRouteKeys(lines, activeBusRoutes(), busRouteIndex()));
    if (keys.length === 0) return; // no learned route for this line — draw nothing
    // Index-aligned with `keys`, filled in as fetches land.
    const geometries: ([number, number][] | null)[] = keys.map(() => null);
    await Promise.all(
      keys.map(async (key, i) => {
        geometries[i] = await loadRouteGeometry(key.key);
        // The feature below owns its own coordinate array, so the cached route
        // can go now: an index key exists precisely because the line has no
        // live vehicles, so the snapping engine can never read it, and leaving
        // it in would evict routes that on-screen buses are snapped to.
        if (key.source === 'index') forgetRouteGeometry(key.key);
        if (geometries[i] === null) return;
        if (gen !== generation) return; // a newer selection has already won
        // Repaint per arrival rather than once after the batch: one stalled key
        // must not hide the shapes that were already in memory.
        setData(map, buildRouteShapeData(keys, geometries));
      }),
    );
  } catch (error) {
    // Degrade to no shape: the filter itself (dot colouring) is unaffected, and
    // the next filter change retries from scratch.
    console.warn('[bus-route-shape]', error);
  }
}

function setData(map: MaplibreMap, data: GeoJSON.FeatureCollection): void {
  const src = map.getSource(SOURCE_ID);
  if (src && 'setData' in src) (src as GeoJSONSource).setData(data);
}

function setVisible(map: MaplibreMap, visible: boolean): void {
  for (const id of [BUS_ROUTE_SHAPE_CASING_LAYER_ID, BUS_ROUTE_SHAPE_LINE_LAYER_ID]) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
  }
}
