// Bus-coverage flow map. Each feature is a deduplicated ROAD CORRIDOR (built
// server-side by merging all learned route polylines that traverse it), with
// properties j = total journeys/day across every route and direction on that
// road, and b = absolute bucket 0..5 (edges ~10/30/75/150/300 journeys/day).
// Every road is drawn exactly once, so brightness IS the total service level —
// three 1/day routes sharing a street show 3, one 30/day route shows 30. j is
// carried for a future tap-to-inspect; styling reads only b.
//
// Lazy by design: the artifact is ~1 MB compressed, so nothing is fetched
// until the user first toggles the overlay on. The layer itself must still
// exist from start() (empty source, hidden) or the legend would drop the
// toggle for a layer it cannot find.

import type { Map as MaplibreMap, GeoJSONSource } from 'maplibre-gl';

export const BUS_COVERAGE_LAYER_ID = 'bus-coverage';
const SOURCE_ID = 'bus-coverage';
const COVERAGE_URL = '/api/coverage';
/** Beneath the transit line casings, same anchor as the rain radar — anything
 * that drives or floats is added above the static network, so this guarantees
 * the glow sits under bus dots without depending on bus start timing. */
const INSERT_BEFORE_LAYER_ID = 'transit-lines-casing';

const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

/** 'idle' allows a fetch; 'pending' blocks re-entry while one is in flight;
 * 'loaded' means the source holds real data and toggles are pure visibility
 * flips. A failed fetch returns to 'idle' so the next toggle-on retries. */
let fetchState: 'idle' | 'pending' | 'loaded' = 'idle';

/**
 * Adds the (empty, hidden) source + layer. No network traffic here — data
 * arrives on the first toggle-on via setBusCoverageVisible.
 */
export function startBusCoverage(map: MaplibreMap): Promise<void> {
  map.addSource(SOURCE_ID, { type: 'geojson', data: EMPTY });
  map.addLayer(
    {
      id: BUS_COVERAGE_LAYER_ID,
      type: 'line',
      source: SOURCE_ID,
      layout: {
        'line-cap': 'round',
        'line-join': 'round',
        visibility: 'none', // off by default; toggled via the legend
      },
      paint: {
        // Deep teal → ice-white ("ice", user-picked over warm/neon/mono
        // ramps): cool glow against the dark basemap that the crimson bus
        // dots sit on as a complementary color. Quiet roads (low b) stay
        // near-invisible; only busy corridors turn properly bright.
        'line-color': [
          'interpolate',
          ['linear'],
          ['get', 'b'],
          0,
          '#0c2733',
          3,
          '#0891b2',
          5,
          '#a5f3fc',
        ],
        'line-width': ['interpolate', ['linear'], ['get', 'b'], 0, 0.5, 3, 1.6, 5, 3.8],
        'line-opacity': ['interpolate', ['linear'], ['get', 'b'], 0, 0.22, 3, 0.55, 5, 0.9],
        // Blur grows with width so heavy corridors get a soft halo rather
        // than a hard stroke.
        'line-blur': ['interpolate', ['linear'], ['get', 'b'], 0, 0.3, 5, 1.4],
      },
    },
    // Regions without a drawn transit network lack the anchor layer, and
    // passing a missing id makes addLayer throw. Undefined means "top of the
    // stack as of now" — still beneath every vehicle layer added after.
    map.getLayer(INSERT_BEFORE_LAYER_ID) ? INSERT_BEFORE_LAYER_ID : undefined,
  );
  return Promise.resolve();
}

/** Legend toggle handler: visibility flip, plus the one-time lazy fetch. */
export function setBusCoverageVisible(map: MaplibreMap, visible: boolean): void {
  if (!map.getLayer(BUS_COVERAGE_LAYER_ID)) return;
  map.setLayoutProperty(BUS_COVERAGE_LAYER_ID, 'visibility', visible ? 'visible' : 'none');
  if (visible && fetchState === 'idle') void loadCoverage(map);
}

async function loadCoverage(map: MaplibreMap): Promise<void> {
  fetchState = 'pending';
  try {
    const res = await fetch(COVERAGE_URL);
    // 404 is the contract's "no artifact yet" — same recovery as any failure:
    // the toggle shows nothing now and a later re-toggle retries.
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as GeoJSON.FeatureCollection;
    // Minimal shape guard: a 200 from an intermediary (error page, captive
    // portal) must fail into the retryable path, not reach setData.
    if (data?.type !== 'FeatureCollection' || !Array.isArray(data.features)) {
      throw new Error('unexpected coverage payload shape');
    }
    const src = map.getSource(SOURCE_ID);
    if (src && 'setData' in src) {
      (src as GeoJSONSource).setData(data);
      fetchState = 'loaded';
      return;
    }
    throw new Error('coverage source missing');
  } catch (error) {
    console.warn('[coverage]', error);
    fetchState = 'idle';
  }
}
