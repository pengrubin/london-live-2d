// SIMULATED trains, for regions whose operator publishes no live positions.
//
// THIS IS NOT A MEASUREMENT. Every marker here is generated from published
// timetable parameters — line speed, headway, operating hours — applied to the
// baked geometry. A train cancelled ten minutes ago still runs on this map, and
// a delayed one is still on time. That is a categorically weaker claim than the
// rest of the map makes, so it is drawn HOLLOW where real data is solid, the
// overlay is labelled "simulated", and every popup says so in its first line.
//
// The parameters come from the region's baked manifest rather than from code,
// so a region that publishes none simply has no simulated trains — the same
// data-derives-capability rule the rest of the app follows.
//
// Positions are a pure function of UTC wall-clock time, so there is no server,
// no polling, and every viewer sees the same trains in the same places.

import { type GeoJSONSource, type Map as MaplibreMap, type MapLayerMouseEvent, Popup } from 'maplibre-gl';
import { M_PER_DEG_LAT, metersPerDegLon } from '../region';
import { below } from '../util/layer-order';
import { makeBulletIcon } from '../util/bullet-icon';
import { stockPhotoUrl } from '../ui/stock-photos';
import { fetchManifest, lineGeometryUrl } from '../services/static-data';

export const SIMULATED_TRAINS_LAYER_ID = 'simulated-trains';
const SOURCE_ID = 'simulated-trains';
const MIN_ZOOM = 9;
const MS_PER_HOUR = 3_600_000;
const KMH_TO_MS = 1 / 3.6;
/**
 * The two directions share a departure grid; offsetting one by half a headway
 * stops them meeting at the midpoint on every single run, which reads as an
 * animation artefact rather than a service.
 */
const REVERSE_PHASE = 0.5;


export interface ServiceHours {
  readonly open: number;
  readonly close: number;
}
export interface ServiceSpec {
  readonly utcOffsetHours: number;
  /** Indexed by day of week, 0 = Sunday. */
  readonly hours: readonly ServiceHours[];
  readonly peakHours: ReadonlyArray<readonly [number, number]>;
}
export interface SimSpec {
  readonly speedKmh: number;
  readonly headwayPeakS: number;
  readonly headwayOffPeakS: number;
}
export interface SimLine {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly sim?: SimSpec;
}

/** One continuous run of track: a line may have several (branches). */
interface Route {
  readonly lineId: string;
  readonly lineName: string;
  readonly color: string;
  readonly sim: SimSpec;
  readonly coords: ReadonlyArray<readonly [number, number]>;
  /** Cumulative metres to each coordinate; last entry is the total. */
  readonly cum: Float64Array;
}

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);

function cumulativeMetres(coords: ReadonlyArray<readonly [number, number]>): Float64Array {
  const mPerDegLon = metersPerDegLon();
  const cum = new Float64Array(coords.length);
  for (let i = 1; i < coords.length; i += 1) {
    const a = coords[i - 1];
    const b = coords[i];
    if (a === undefined || b === undefined) continue;
    const dx = (b[0] - a[0]) * mPerDegLon;
    const dy = (b[1] - a[1]) * M_PER_DEG_LAT;
    cum[i] = (cum[i - 1] ?? 0) + Math.hypot(dx, dy);
  }
  return cum;
}

/**
 * Point at `metres` along the route, with the bearing of the track there.
 *
 * A bullet marker has a nose, so it needs a direction: without one it points
 * north wherever it is, which reads as broken rather than stylised.
 */
function pointAt(route: Route, metres: number): { position: [number, number]; bearing: number } {
  const { coords, cum } = route;
  const total = cum[cum.length - 1] ?? 0;
  const target = Math.max(0, Math.min(total, metres));
  let lo = 0;
  let hi = cum.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if ((cum[mid] ?? 0) <= target) lo = mid;
    else hi = mid;
  }
  const a = coords[lo];
  const b = coords[hi];
  if (a === undefined) return { position: [0, 0], bearing: 0 };
  if (b === undefined) return { position: [a[0], a[1]], bearing: 0 };
  const segment = (cum[hi] ?? 0) - (cum[lo] ?? 0);
  const t = segment > 0 ? (target - (cum[lo] ?? 0)) / segment : 0;
  const mPerDegLon = metersPerDegLon();
  // Compass bearing: 0 is north, increasing clockwise, which is what
  // MapLibre's icon-rotate expects.
  const bearing =
    (Math.atan2((b[0] - a[0]) * mPerDegLon, (b[1] - a[1]) * M_PER_DEG_LAT) * 180) / Math.PI;
  return { position: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], bearing };
}

/** Local wall-clock parts for a region with a fixed UTC offset (no DST). */
function localParts(nowMs: number, offsetHours: number): { day: number; hour: number } {
  const shifted = new Date(nowMs + offsetHours * MS_PER_HOUR);
  return { day: shifted.getUTCDay(), hour: shifted.getUTCHours() + shifted.getUTCMinutes() / 60 };
}

/**
 * Whether the network is running. Closing times past midnight are expressed as
 * hours >= 24 (Friday closes at 25 = 01:00 Saturday), so the previous day's
 * late service is checked as well as today's.
 */
export function isServiceRunning(service: ServiceSpec, nowMs: number): boolean {
  const { day, hour } = localParts(nowMs, service.utcOffsetHours);
  const today = service.hours[day];
  if (today && hour >= today.open && hour < today.close) return true;
  const yesterday = service.hours[(day + 6) % 7];
  return yesterday !== undefined && hour + 24 < yesterday.close;
}

export function isPeak(service: ServiceSpec, nowMs: number): boolean {
  const { hour } = localParts(nowMs, service.utcOffsetHours);
  return service.peakHours.some(([from, to]) => hour >= from && hour < to);
}

/**
 * Every train in flight on one route, both directions.
 *
 * Departures sit on a fixed grid anchored to the epoch, so the answer depends
 * only on the clock — no state to drift, and two browsers agree.
 */
function trainsOnRoute(
  route: Route,
  nowMs: number,
  headwayS: number,
): Array<{ position: [number, number]; bearing: number }> {
  const total = route.cum[route.cum.length - 1] ?? 0;
  const journeyS = total / (route.sim.speedKmh * KMH_TO_MS);
  if (journeyS <= 0 || headwayS <= 0) return [];

  const out: Array<{ position: [number, number]; bearing: number }> = [];
  const nowS = nowMs / 1000;
  const inFlight = Math.ceil(journeyS / headwayS);

  for (const heading of [1, -1] as const) {
    const phase = heading === 1 ? 0 : REVERSE_PHASE * headwayS;
    const latest = Math.floor((nowS - phase) / headwayS) * headwayS + phase;
    for (let k = 0; k <= inFlight; k += 1) {
      const departedAt = latest - k * headwayS;
      const elapsed = nowS - departedAt;
      if (elapsed < 0 || elapsed > journeyS) continue;
      const progress = elapsed / journeyS;
      const metres = heading === 1 ? progress * total : (1 - progress) * total;
      const { position, bearing } = pointAt(route, metres);
      // The stored bearing follows the polyline's own direction; a train
      // running the other way faces the opposite heading.
      out.push({ position, bearing: heading === 1 ? bearing : bearing + 180 });
    }
  }
  return out;
}

/**
 * Starts simulated services if — and only if — the region's manifest declares
 * both the service parameters and at least one line with a timetable. Reads
 * the manifest itself rather than taking it as an argument so the layer stays
 * a plain start function like every other, and so a region without simulated
 * services costs nothing but one cached fetch.
 */
export async function startSimulatedTrains(map: MaplibreMap): Promise<void> {
  let manifest;
  try {
    manifest = await fetchManifest();
  } catch {
    return; // no manifest, no simulated service
  }
  const maybeService = manifest.service as ServiceSpec | undefined;
  if (!maybeService) return;
  const service: ServiceSpec = maybeService;
  const lines = manifest.lines as readonly SimLine[];
  const simLines = lines.filter((l): l is SimLine & { sim: SimSpec } => l.sim !== undefined);
  if (simLines.length === 0) return;

  const routes: Route[] = [];
  await Promise.all(
    simLines.map(async (line) => {
      try {
        const response = await fetch(lineGeometryUrl(line.id));
        if (!response.ok) return;
        const collection = (await response.json()) as GeoJSON.FeatureCollection;
        for (const feature of collection.features ?? []) {
          if (feature.geometry?.type !== 'LineString') continue;
          const coords = feature.geometry.coordinates as Array<[number, number]>;
          if (coords.length < 2) continue;
          routes.push({
            lineId: line.id,
            lineName: line.name,
            color: line.color,
            sim: line.sim,
            coords,
            cum: cumulativeMetres(coords),
          });
        }
      } catch {
        // A line without geometry simply contributes no simulated service.
      }
    }),
  );
  if (routes.length === 0) return;

  // One hollow bullet per line colour — the same silhouette the live London
  // trains use, so a train reads as a train, outlined rather than filled so it
  // never passes for a measured position.
  for (const line of simLines) {
    const name = `sim-train-${line.id}`;
    if (!map.hasImage(name)) {
      map.addImage(name, makeBulletIcon(line.color, { hollow: true }), { pixelRatio: 2 });
    }
  }

  map.addSource(SOURCE_ID, {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });
  map.addLayer(
    {
      id: SIMULATED_TRAINS_LAYER_ID,
      type: 'symbol',
      source: SOURCE_ID,
      minzoom: MIN_ZOOM,
      layout: {
        'icon-image': ['concat', 'sim-train-', ['get', 'lineId']],
        'icon-size': ['interpolate', ['linear'], ['zoom'], 9, 0.32, 12, 0.55, 15, 0.9],
        'icon-rotate': ['get', 'bearing'],
        'icon-rotation-alignment': 'map',
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
    },
    below(map, 'stations-circle'),
  );

  const source = (): GeoJSONSource | undefined => {
    const src = map.getSource(SOURCE_ID);
    return src && 'setData' in src ? (src as GeoJSONSource) : undefined;
  };

  let running = true;
  function frame(): void {
    if (!running) return;
    const now = Date.now();
    const features: GeoJSON.Feature[] = [];
    if (isServiceRunning(service, now)) {
      const peak = isPeak(service, now);
      for (const route of routes) {
        const headwayS = peak ? route.sim.headwayPeakS : route.sim.headwayOffPeakS;
        for (const train of trainsOnRoute(route, now, headwayS)) {
          features.push({
            type: 'Feature',
            properties: {
              lineId: route.lineId,
              lineName: route.lineName,
              bearing: train.bearing,
              headwayMin: Math.round(headwayS / 60),
            },
            geometry: { type: 'Point', coordinates: train.position },
          });
        }
      }
    }
    source()?.setData({ type: 'FeatureCollection', features });
    requestAnimationFrame(frame);
  }
  map.once('remove', () => {
    running = false;
  });
  requestAnimationFrame(frame);

  const tip = new Popup({
    closeButton: false,
    closeOnClick: false,
    offset: 10,
    className: 'hover-tip',
  });
  map.on('mousemove', SIMULATED_TRAINS_LAYER_ID, (e: MapLayerMouseEvent) => {
    const p = e.features?.[0]?.properties as
      | { lineName?: string; headwayMin?: number }
      | undefined;
    if (!p) return;
    map.getCanvas().style.cursor = 'help';
    tip
      .setLngLat(e.lngLat)
      .setHTML(
        `<div class="vp"><b>${esc(p.lineName ?? 'Train')}</b>` +
          `<div class="vp-dim">simulated — no live feed is published for this network</div>` +
          `<div class="vp-dim">drawn from the timetable: about every ${p.headwayMin ?? '?'} min</div></div>`,
      )
      .addTo(map);
  });
  map.on('mouseleave', SIMULATED_TRAINS_LAYER_ID, () => {
    map.getCanvas().style.cursor = '';
    tip.remove();
  });

  const detail = new Popup({ closeButton: true, closeOnClick: true, offset: 12, maxWidth: '320px' });
  map.on('click', SIMULATED_TRAINS_LAYER_ID, (e: MapLayerMouseEvent) => {
    const p = e.features?.[0]?.properties as
      | { lineId?: string; lineName?: string; headwayMin?: number }
      | undefined;
    if (!p) return;
    tip.remove();
    const photo = stockPhotoUrl(p.lineId ?? '');
    const image = photo
      ? `<img class="vp-photo" src="${esc(photo)}" alt="${esc(p.lineName ?? '')} rolling stock" loading="lazy">`
      : '';
    detail
      .setLngLat(e.lngLat)
      .setHTML(
        `<div class="vp">${image}` +
          `<div class="sp-title">${esc(p.lineName ?? 'Train')}</div>` +
          // The disclaimer leads, because everything below it is generated.
          `<div class="vp-dim"><b>Simulated position.</b> No live feed is published ` +
          `for this network, so this train is drawn from the timetable — about ` +
          `every ${p.headwayMin ?? '?'} min — not from a measurement.</div>` +
          `<div class="vp-dim">Photo: see docs/PHOTO_CREDITS.md</div></div>`,
      )
      .addTo(map);
  });
}
