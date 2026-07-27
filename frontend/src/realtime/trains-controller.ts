// Wires the pure inference pipeline to the map: polls the backend arrivals
// proxy, infers train positions, and renders smoothed dots every frame.

import type { GeoJSONSource, Map as MaplibreMap, MapLayerMouseEvent } from 'maplibre-gl';
import type { LineBranches, Prediction, Train } from './types';
import { inferTrains } from './position-inference';
import { TrainInterpolator } from './interpolator';
import { VehiclePopup } from '../ui/vehicle-popup';
import { isLayerShown, makeRenderGate } from '../util/render-gate';
import { registerPoll, symbolTierIntervalMs } from '../util/lifecycle';

const POLL_INTERVAL_MS = 10_000;
const SOURCE_ID = 'trains';
const LAYER_ID = 'trains-dots';

// ── bullet-nose vehicle icon, drawn pointing north; MapLibre rotates it ──
const ICON_PX = 36; // canvas width  (drawn at 2x, rendered at pixelRatio 2)
const ICON_PY = 64; // canvas height
const ICON_OUTLINE = '#ffffff';

function makeBulletIcon(color: string): ImageData {
  const canvas = document.createElement('canvas');
  canvas.width = ICON_PX;
  canvas.height = ICON_PY;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d canvas unavailable');
  const w = ICON_PX;
  const h = ICON_PY;
  const inset = 4; // room for the outline stroke
  const left = inset;
  const right = w - inset;
  const bottom = h - inset;
  const noseTip = inset;
  const shoulder = h * 0.38; // where the straight body curves into the nose
  const rearR = (right - left) / 2.6; // rounded tail corners

  ctx.beginPath();
  ctx.moveTo(left, shoulder);
  // nose: two symmetric curves meeting at the tip
  ctx.quadraticCurveTo(left, noseTip + (shoulder - noseTip) * 0.25, w / 2, noseTip);
  ctx.quadraticCurveTo(right, noseTip + (shoulder - noseTip) * 0.25, right, shoulder);
  // body sides + rounded tail
  ctx.lineTo(right, bottom - rearR);
  ctx.quadraticCurveTo(right, bottom, right - rearR, bottom);
  ctx.lineTo(left + rearR, bottom);
  ctx.quadraticCurveTo(left, bottom, left, bottom - rearR);
  ctx.closePath();

  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = ICON_OUTLINE;
  ctx.lineWidth = 3;
  ctx.stroke();
  return ctx.getImageData(0, 0, w, h);
}

function addVehicleIcons(map: MaplibreMap, colorByLine: Map<string, string>): void {
  for (const [lineId, color] of colorByLine) {
    const name = `train-${lineId}`;
    if (!map.hasImage(name)) map.addImage(name, makeBulletIcon(color), { pixelRatio: 2 });
  }
}

interface ManifestLine {
  id: string;
  name: string;
  mode: string;
  color: string;
  displayColor?: string;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

async function loadBranches(lines: ManifestLine[]): Promise<Map<string, LineBranches>> {
  const loaded = await Promise.all(
    lines.map((l) => fetchJson<LineBranches>(`/branches/${l.id}.json`)),
  );
  return new Map(loaded.map((lb) => [lb.lineId, lb]));
}

function toFeatureCollection(
  displayed: ReturnType<TrainInterpolator['frame']>,
  colorByLine: Map<string, string>,
): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: displayed.map(({ train, lngLat, bearing, opacity }) => ({
      type: 'Feature',
      properties: {
        key: train.key,
        lineId: train.lineId,
        lineName: train.lineName,
        color: colorByLine.get(train.lineId) ?? '#ffffff',
        nextStop: train.nextStopName,
        destination: train.destination,
        timeToStation: train.timeToStation,
        receivedAt: train.receivedAt ?? 0,
        bearing,
        opacity,
      },
      geometry: { type: 'Point', coordinates: lngLat },
    })),
  };
}

export interface TrainsHandle {
  stop: () => void;
  /** live counters for acceptance tooling */
  stats: { trains: number; polls: number; lastPollAt: number };
  /** lineId → display colour, shared with other UI (station popups, legend) */
  colorByLine: ReadonlyMap<string, string>;
  /** dismiss the follow-the-vehicle popup (e.g. when a station board opens) */
  closeVehiclePopup: () => void;
  /** key of the vehicle whose detail card is open, if any */
  selectedVehicleKey: () => string | null;
  /** displayed [lng, lat] of a live train by key ("lineId:vehicleId"), or null */
  findVehicle: (key: string) => [number, number] | null;
}

export async function startTrains(map: MaplibreMap): Promise<TrainsHandle> {
  const manifest = await fetchJson<{ lines: ManifestLine[] }>('/manifest.json');
  const branches = await loadBranches(manifest.lines);
  const colorByLine = new Map(
    manifest.lines.map((l) => [l.id, l.displayColor ?? l.color]),
  );
  const lineIds = manifest.lines.map((l) => l.id).join(',');

  addVehicleIcons(map, colorByLine);
  map.addSource(SOURCE_ID, {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });
  map.addLayer({
    id: LAYER_ID,
    type: 'symbol',
    source: SOURCE_ID,
    layout: {
      'icon-image': ['concat', 'train-', ['get', 'lineId']],
      'icon-size': ['interpolate', ['linear'], ['zoom'], 9, 0.32, 12, 0.55, 15, 0.9],
      'icon-rotate': ['get', 'bearing'],
      'icon-rotation-alignment': 'map',
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
    paint: {
      'icon-opacity': ['get', 'opacity'],
    },
  });

  const interpolator = new TrainInterpolator();
  const vehiclePopup = new VehiclePopup(map, colorByLine);
  map.on('click', LAYER_ID, (e: MapLayerMouseEvent) => {
    const key = e.features?.[0]?.properties?.key as string | undefined;
    if (key) vehiclePopup.select(key);
  });
  // clicking empty map (not a vehicle, not inside the popup DOM) dismisses the card
  map.on('click', (e) => {
    if (map.queryRenderedFeatures(e.point, { layers: [LAYER_ID] }).length === 0) {
      vehiclePopup.close();
    }
  });
  const stats = { trains: 0, polls: 0, lastPollAt: 0 };
  let stopped = false;
  let pollTimer: number | undefined;
  let rafId: number | undefined;

  async function poll(): Promise<void> {
    try {
      const preds = await fetchJson<Prediction[]>(`/api/arrivals?lines=${lineIds}`);
      if (Array.isArray(preds)) {
        const trains: Train[] = inferTrains(preds, branches, interpolator.segmentAssignments());
        const receivedAt = Date.now();
        for (const t of trains) t.receivedAt = receivedAt;
        interpolator.update(trains, receivedAt);
        stats.trains = trains.length;
        stats.polls += 1;
        stats.lastPollAt = Date.now();
      }
    } catch (err) {
      console.error('[trains] poll failed:', err);
    }
  }

  const renderGate = makeRenderGate(symbolTierIntervalMs);
  let lastFrame = performance.now();
  function frame(now: number): void {
    if (stopped) return;
    if (!renderGate(now) || !isLayerShown(map, LAYER_ID)) {
      rafId = requestAnimationFrame(frame);
      return;
    }
    const dt = now - lastFrame;
    lastFrame = now;
    const displayed = interpolator.frame(dt);
    const src = map.getSource(SOURCE_ID);
    if (src && 'setData' in src) {
      (src as GeoJSONSource).setData(toFeatureCollection(displayed, colorByLine));
    }
    vehiclePopup.sync(displayed);
    rafId = requestAnimationFrame(frame);
  }

  await poll();
  // Poller is managed by the battery-saver lifecycle (pauses while hidden).
  registerPoll(() => void poll(), POLL_INTERVAL_MS);
  rafId = requestAnimationFrame(frame);

  return {
    stop: () => {
      stopped = true;
      if (pollTimer !== undefined) clearInterval(pollTimer);
      if (rafId !== undefined) cancelAnimationFrame(rafId);
    },
    stats,
    colorByLine,
    closeVehiclePopup: () => vehiclePopup.close(),
    selectedVehicleKey: () => vehiclePopup.selected,
    findVehicle: (key) => interpolator.findVehicle(key),
  };
}
