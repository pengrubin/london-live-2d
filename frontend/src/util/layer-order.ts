// Two answers to the same question — "which layer owns this pixel?": where a
// layer is inserted in the stack, and which layer wins a tap on it.
//
// MapLibre's addLayer THROWS when the `beforeId` names a layer that does not
// exist. Every "sit under the station dots / under the trains" insertion was
// written when those layers were guaranteed, which stopped being true once a
// deployment could lack the feeds that create them: a region with ships but no
// tube has no `trains-dots`, so the ship layer took itself down on startup.
//
// Passing `undefined` is the documented "add on top" behaviour, which is the
// right degradation — the layer this one wanted to hide under isn't there.

import type { Map as MaplibreMap, MapLayerMouseEvent } from 'maplibre-gl';

/** The screen point MapLibre hands a mouse handler. */
type ScreenPoint = MapLayerMouseEvent['point'];

/** `layerId` if the map has it, else undefined (meaning "add on top"). */
export function below(map: MaplibreMap, layerId: string): string | undefined {
  return map.getLayer(layerId) ? layerId : undefined;
}

// ── click ownership ────────────────────────────────────────────────────────
//
// MapLibre fires EVERY layer-scoped click handler that has a feature under the
// point, so an overlay mark landing on a station dot or a vehicle opens two
// popups at once. The fix is always the same query, and it had been written out
// three times (the station popup, the rail disruption bands, the hover
// tooltip); it lives here once instead.

/**
 * The ids from `ids` that the style actually contains.
 *
 * queryRenderedFeatures aborts the whole query on the first layer id the style
 * does not have: it fires a map error and returns an empty array. A region
 * without a live train pipeline has no vehicles layer, so asking for it would
 * both spam the console and make "is something on top of this?" answer no —
 * letting the layer underneath overwrite the popup the user aimed at.
 */
export function presentLayers(map: MaplibreMap, ids: readonly string[]): string[] {
  return ids.filter((id) => map.getLayer(id));
}

/** True when any of `ids` the style has renders a feature under `point`. */
export function anyFeatureAt(
  map: MaplibreMap,
  point: ScreenPoint,
  ids: readonly string[],
): boolean {
  const layers = presentLayers(map, ids);
  if (layers.length === 0) return false;
  return map.queryRenderedFeatures(point, { layers }).length > 0;
}

/**
 * The point layers that own a tap outright: rail station dots and every live
 * vehicle dot. An overlay drawn beneath them yields to this list rather than
 * opening a second popup over the one the user actually aimed at.
 *
 * Spelled out rather than imported so this stays a plain string table (the
 * legend's FILTERED_LAYERS convention) and so a util never depends on a layer
 * module. A missing id is skipped by presentLayers, so naming a layer a region
 * does not have is free.
 */
export const DOT_LAYER_IDS: readonly string[] = [
  'stations-circle',
  'trains-dots',
  'nr-trains-dots',
  'buses-dots',
];
