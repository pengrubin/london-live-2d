// Bus-coverage flow map. Each feature is a deduplicated ROAD CORRIDOR (built
// server-side by merging all learned route polylines that traverse it), with
// properties j = total journeys/day across every route and direction on that
// road, and b = absolute bucket 0..5 (edges ~10/30/75/150/300 journeys/day).
// Every road is drawn exactly once, so brightness IS the total service level —
// three 1/day routes sharing a street show 3, one 30/day route shows 30.
// Styling reads only b; tapping a corridor opens a card with ~j and the
// contributing routes (property r — see coverage-popup.ts).
//
// Lazy by design: the artifact is ~1 MB compressed, so nothing is fetched
// until the user first toggles the overlay on. The layer itself must still
// exist from start() (empty source, hidden) or the legend would drop the
// toggle for a layer it cannot find.

import {
  Popup,
  type GeoJSONSource,
  type Map as MaplibreMap,
  type MapLayerMouseEvent,
} from 'maplibre-gl';
import { anyFeatureAt, DOT_LAYER_IDS } from '../util/layer-order';
import { BUS_STOP_CLOSURES_LAYER_IDS } from './bus-stop-closures';
import { DISRUPTIONS_LAYER_IDS } from './disruptions';
import { DIVERSIONS_LAYER_IDS } from './diversions';
import { ROAD_DISRUPTIONS_LAYER_IDS } from './road-disruptions';
import { coveragePopupHtml, type CoverageProps } from './coverage-popup';

export const BUS_COVERAGE_LAYER_ID = 'bus-coverage';
const SOURCE_ID = 'bus-coverage';
const COVERAGE_URL = '/api/coverage';
/** Beneath the transit line casings, same anchor as the rain radar — anything
 * that drives or floats is added above the static network, so this guarantees
 * the glow sits under bus dots without depending on bus start timing. */
const INSERT_BEFORE_LAYER_ID = 'transit-lines-casing';

/** Everything with its own popup that draws ABOVE the coverage glow. The
 * glow is the bottom-most overlay and covers most streets, so without
 * yielding, a tap on a bus dot, a diversion band or a roadworks mark would
 * open the corridor card on top of the one the user aimed at. */
const YIELD_TO_LAYER_IDS: readonly string[] = [
  ...DOT_LAYER_IDS,
  ...DIVERSIONS_LAYER_IDS,
  ...DISRUPTIONS_LAYER_IDS,
  ...ROAD_DISRUPTIONS_LAYER_IDS,
  ...BUS_STOP_CLOSURES_LAYER_IDS,
];

const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

/** 'idle' allows a fetch; 'pending' blocks re-entry while one is in flight;
 * 'loaded' means the source holds real data and toggles are pure visibility
 * flips. A failed fetch returns to 'idle' so the next toggle-on retries. */
let fetchState: 'idle' | 'pending' | 'loaded' = 'idle';

/** Closes the corridor card; set once the popup exists (wireInteractions). */
let closeDetail: (() => void) | null = null;

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
  wireInteractions(map);
  return Promise.resolve();
}

/** Tap a corridor → its total and contributing routes. MapLibre only fires
 * layer-scoped events for a rendered layer, so while the overlay is toggled
 * off (visibility none) none of these handlers can run. The popup is
 * user-triggered, so allocating here is fine — unlike the per-frame paths
 * elsewhere. closeOnClick closes it on a tap anywhere else, the house
 * pattern shared with the diversion and disruption cards. */
function wireInteractions(map: MaplibreMap): void {
  const detail = new Popup({ closeButton: true, closeOnClick: true, offset: 8, maxWidth: '280px' });
  closeDetail = () => void detail.remove();
  map.on('click', BUS_COVERAGE_LAYER_ID, (e: MapLayerMouseEvent) => {
    if (anyFeatureAt(map, e.point, YIELD_TO_LAYER_IDS)) return;
    const p = e.features?.[0]?.properties as CoverageProps | undefined;
    if (!p) return;
    detail.setLngLat(e.lngLat).setHTML(coveragePopupHtml(p)).addTo(map);
  });
  map.on('mouseenter', BUS_COVERAGE_LAYER_ID, () => {
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', BUS_COVERAGE_LAYER_ID, () => {
    map.getCanvas().style.cursor = '';
  });
}

/** Legend toggle handler: visibility flip, plus the one-time lazy fetch. */
export function setBusCoverageVisible(map: MaplibreMap, visible: boolean): void {
  if (!map.getLayer(BUS_COVERAGE_LAYER_ID)) return;
  // A card left open would describe a layer that is no longer drawn.
  if (!visible) closeDetail?.();
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
