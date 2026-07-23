// Static transit-line overlay: one merged GeoJSON source, a dark casing layer
// beneath and the official-coloured line on top (colour baked per feature).
import type {
  ExpressionSpecification,
  Map as MapLibreMap,
} from 'maplibre-gl';
import type { FeatureCollection, LineString } from 'geojson';
import {
  fetchJson,
  fetchManifest,
  lineGeometryUrl,
  type LineManifestEntry,
} from '../services/static-data';

interface TransitLineProps {
  lineId: string;
  color: string;
}

type TransitLineCollection = FeatureCollection<LineString, TransitLineProps>;

export const TRANSIT_LINES_SOURCE_ID = 'transit-lines';
export const TRANSIT_LINES_CASING_LAYER_ID = 'transit-lines-casing';
export const TRANSIT_LINES_LAYER_ID = 'transit-lines-line';

// Official TfL colours render at full strength; the Northern line's official
// black needs a light casing (instead of the dark one) to stay visible.
const CASING_COLOR: ExpressionSpecification = [
  'case',
  ['==', ['get', 'lineId'], 'northern'],
  '#9a9a9a',
  '#0a0a0a',
];
const LINE_OPACITY = 1;
// Zoom → width ramps (px). Casing stays ~2px wider than the coloured line.
const LINE_WIDTH_RAMP: ExpressionSpecification = [
  'interpolate',
  ['exponential', 1.4],
  ['zoom'],
  9,
  1,
  12,
  2.2,
  14,
  4,
  16,
  5.5,
];
const CASING_WIDTH_RAMP: ExpressionSpecification = [
  'interpolate',
  ['exponential', 1.4],
  ['zoom'],
  9,
  2.4,
  12,
  4.2,
  14,
  6.5,
  16,
  8.5,
];

// Lines that run their whole route on another line's tracks (Circle on
// Met/District/H&C, H&C on Met/District, Lioness on Bakerloo's DC tracks)
// would be fully painted over. A perpendicular offset renders them alongside
// instead — the TfL-map treatment for shared corridors. Both directions of a
// line are drawn, so the offset splits them symmetrically around the corridor.
const OFFSET_BY_LINE: ExpressionSpecification = [
  'match',
  ['get', 'lineId'],
  'circle',
  3,
  'hammersmith-city',
  -3,
  'lioness',
  3,
  // river services share the Thames channel: RB1 keeps the centreline,
  // the others berth alongside (wider gaps — the river gives us room)
  'rb6',
  4.5,
  'rb4',
  -4.5,
  0,
];
const LINE_OFFSET_RAMP: ExpressionSpecification = [
  'interpolate',
  ['linear'],
  ['zoom'],
  10,
  ['*', OFFSET_BY_LINE, 0.25],
  13,
  ['*', OFFSET_BY_LINE, 0.7],
  15,
  OFFSET_BY_LINE,
  17,
  ['*', OFFSET_BY_LINE, 1.8],
];

async function fetchMergedLineGeometry(
  lines: readonly LineManifestEntry[],
): Promise<TransitLineCollection> {
  const collections = await Promise.all(
    lines.map((line) => fetchJson<TransitLineCollection>(lineGeometryUrl(line.id))),
  );
  return {
    type: 'FeatureCollection',
    features: collections.flatMap((collection) => collection.features),
  };
}

/** First symbol (label) layer of the basemap — transit lines slot in beneath it. */
function findFirstSymbolLayerId(map: MapLibreMap): string | undefined {
  return map.getStyle().layers.find((layer) => layer.type === 'symbol')?.id;
}

/**
 * Fetches the line manifest plus every line's geometry in parallel, then adds
 * the casing + coloured line layers. Returns the manifest entries so callers
 * (e.g. the stations layer) can reuse them without re-fetching the manifest.
 */
export async function addTransitLineLayers(
  map: MapLibreMap,
): Promise<LineManifestEntry[]> {
  const manifest = await fetchManifest();
  const geometry = await fetchMergedLineGeometry(manifest.lines);

  map.addSource(TRANSIT_LINES_SOURCE_ID, { type: 'geojson', data: geometry });

  const beforeId = findFirstSymbolLayerId(map);
  map.addLayer(
    {
      id: TRANSIT_LINES_CASING_LAYER_ID,
      type: 'line',
      source: TRANSIT_LINES_SOURCE_ID,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': CASING_COLOR,
        'line-width': CASING_WIDTH_RAMP,
        'line-offset': LINE_OFFSET_RAMP,
      },
    },
    beforeId,
  );
  map.addLayer(
    {
      id: TRANSIT_LINES_LAYER_ID,
      type: 'line',
      source: TRANSIT_LINES_SOURCE_ID,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        // Colour is baked per feature (already display-corrected, e.g. Northern).
        'line-color': ['get', 'color'],
        'line-width': LINE_WIDTH_RAMP,
        'line-opacity': LINE_OPACITY,
        'line-offset': LINE_OFFSET_RAMP,
      },
    },
    beforeId,
  );

  return manifest.lines;
}
