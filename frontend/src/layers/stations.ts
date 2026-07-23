// Station overlay: deduped station dots (interchanges larger) plus name labels
// that appear on zoom-in. Data comes from the per-line baked station files.
import type {
  ExpressionSpecification,
  Map as MapLibreMap,
} from 'maplibre-gl';
import type { Feature, FeatureCollection, Point } from 'geojson';
import { fetchJson, lineStationsUrl } from '../services/static-data';

interface BakedStationProps {
  id: string;
  name: string;
  lineId: string;
}

interface StationProps {
  id: string;
  name: string;
  /** Number of distinct lines serving this station (>= 2 → interchange). */
  lines: number;
  /** Comma-separated line ids serving this station (hover tooltip chips). */
  lineIds: string;
}

type BakedStationCollection = FeatureCollection<Point, BakedStationProps>;
type StationCollection = FeatureCollection<Point, StationProps>;

export const STATIONS_SOURCE_ID = 'stations';
export const STATIONS_CIRCLE_LAYER_ID = 'stations-circle';
export const STATIONS_LABEL_LAYER_ID = 'stations-label';

const STATION_MIN_ZOOM = 10;
const LABEL_MIN_ZOOM = 12.5;
const INTERCHANGE_MIN_LINES = 2;
// Font stack must exist in the basemap glyph set or labels silently fail.
const LABEL_FONT_STACK = ['Noto Sans Regular'];

const IS_INTERCHANGE: ExpressionSpecification = [
  '>=',
  ['get', 'lines'],
  INTERCHANGE_MIN_LINES,
];
const CIRCLE_RADIUS_RAMP: ExpressionSpecification = [
  'interpolate',
  ['linear'],
  ['zoom'],
  10,
  ['case', IS_INTERCHANGE, 2.4, 1.6],
  13,
  ['case', IS_INTERCHANGE, 4, 2.8],
  16,
  ['case', IS_INTERCHANGE, 6.5, 4.5],
];
const CIRCLE_STROKE_WIDTH_RAMP: ExpressionSpecification = [
  'interpolate',
  ['linear'],
  ['zoom'],
  10,
  0.8,
  14,
  1.6,
];
const LABEL_SIZE_RAMP: ExpressionSpecification = [
  'interpolate',
  ['linear'],
  ['zoom'],
  LABEL_MIN_ZOOM,
  10.5,
  16,
  13,
];

interface StationAccumulator {
  name: string;
  coordinates: Point['coordinates'];
  lineIds: Set<string>;
}

function dedupeStations(
  collections: readonly BakedStationCollection[],
): StationCollection {
  const byId = new Map<string, StationAccumulator>();
  for (const collection of collections) {
    for (const feature of collection.features) {
      const { id, name, lineId } = feature.properties;
      const existing = byId.get(id);
      if (existing) {
        existing.lineIds.add(lineId);
      } else {
        byId.set(id, {
          name,
          coordinates: feature.geometry.coordinates,
          lineIds: new Set([lineId]),
        });
      }
    }
  }

  const features: Feature<Point, StationProps>[] = [...byId.entries()].map(
    ([id, station]) => ({
      type: 'Feature',
      properties: {
        id,
        name: station.name,
        lines: station.lineIds.size,
        lineIds: [...station.lineIds].sort().join(','),
      },
      geometry: { type: 'Point', coordinates: station.coordinates },
    }),
  );
  return { type: 'FeatureCollection', features };
}

/**
 * Fetches every line's station file in parallel, dedupes stations shared by
 * multiple lines, and adds the circle + label layers on top of the map.
 */
export async function addStationLayers(
  map: MapLibreMap,
  lineIds: readonly string[],
): Promise<void> {
  const collections = await Promise.all(
    lineIds.map((lineId) =>
      fetchJson<BakedStationCollection>(lineStationsUrl(lineId)),
    ),
  );
  const stations = dedupeStations(collections);

  map.addSource(STATIONS_SOURCE_ID, { type: 'geojson', data: stations });

  map.addLayer({
    id: STATIONS_CIRCLE_LAYER_ID,
    type: 'circle',
    source: STATIONS_SOURCE_ID,
    minzoom: STATION_MIN_ZOOM,
    paint: {
      'circle-radius': CIRCLE_RADIUS_RAMP,
      'circle-color': '#101418',
      'circle-stroke-color': '#e6e6e6',
      'circle-stroke-width': CIRCLE_STROKE_WIDTH_RAMP,
    },
  });

  map.addLayer({
    id: STATIONS_LABEL_LAYER_ID,
    type: 'symbol',
    source: STATIONS_SOURCE_ID,
    minzoom: LABEL_MIN_ZOOM,
    layout: {
      'text-field': ['get', 'name'],
      'text-font': LABEL_FONT_STACK,
      'text-size': LABEL_SIZE_RAMP,
      'text-anchor': 'top',
      'text-offset': [0, 0.7],
    },
    paint: {
      'text-color': '#cdd3d9',
      'text-halo-color': '#0a0a0a',
      'text-halo-width': 1.6,
    },
  });
}
