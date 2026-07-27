// Shared pacing for the live-layer render loops. Rebuilding a GeoJSON source
// every rAF (60-120 Hz) churns hundreds of MB/min of feature garbage across
// five layers; visually anything past ~15 Hz is indistinguishable for symbol
// tiers. Each loop keeps its rAF cadence but only *builds features + setData*
// when its gate opens — and not at all while the layer is legend-hidden.

import type { Map as MaplibreMap } from 'maplibre-gl';

/** Symbol (icon) tiers refresh at most ~15 Hz. */
export const SYMBOL_TIER_INTERVAL_MS = 66;
/** Circle / low-zoom tiers refresh at most 1 Hz. */
export const LOW_ZOOM_TIER_INTERVAL_MS = 1_000;

/**
 * Returns a gate that opens at most once per `minIntervalMs`.
 * Call it with the current time (rAF timestamp or Date.now(), consistently).
 *
 * `minIntervalMs` may be a getter so callers can vary the cadence at runtime
 * (e.g. the mobile power-saver drops the symbol tiers to ~3 Hz) — it is read
 * on every check.
 */
export function makeRenderGate(
  minIntervalMs: number | (() => number),
): (now: number) => boolean {
  const getMin = typeof minIntervalMs === 'function' ? minIntervalMs : (): number => minIntervalMs;
  let lastOpenedAt = -Infinity;
  return (now: number): boolean => {
    if (now - lastOpenedAt < getMin()) return false;
    lastOpenedAt = now;
    return true;
  };
}

/** True unless the layer exists and is toggled off (visibility 'none'). */
export function isLayerShown(map: MaplibreMap, layerId: string): boolean {
  if (!map.getLayer(layerId)) return true;
  return map.getLayoutProperty(layerId, 'visibility') !== 'none';
}
