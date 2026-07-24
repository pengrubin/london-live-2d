// National Rail trains inferred from Darwin departure boards: a train's
// calling points (with estimated/actual times) are interpolated along the
// baked station-to-station rail graph. Positions are pure functions of the
// clock, so per-frame evaluation is inherently smooth.

import {
  Popup,
  type GeoJSONSource,
  type Map as MaplibreMap,
  type MapLayerMouseEvent,
} from 'maplibre-gl';
import { pointAtFraction, polylineLength, type LngLat } from './geometry';
import { isLayerShown, makeRenderGate, SYMBOL_TIER_INTERVAL_MS } from '../util/render-gate';
import { appendRankLine } from '../ui/rank-line';

export const NR_TRAINS_LAYER_ID = 'nr-trains-dots';
const SOURCE_ID = 'nr-trains';
/** Major boards to poll — their calling points cover trains across the bbox. */
const HUBS = ['WAT', 'VIC', 'LBG', 'LST', 'KGX', 'STP', 'EUS', 'PAD', 'MYB', 'CHX', 'CST', 'FST', 'MOG', 'BFR', 'CLJ', 'SRA', 'ECR'];
/** One board fetched every BOARD_STAGGER_MS, round-robin (~70s full cycle). */
const BOARD_STAGGER_MS = 4_000;
const NR_COLOR = '#e8e8e8';

interface Station {
  crs: string;
  name: string;
  lat: number;
  lon: number;
}

interface Segment {
  a: string;
  b: string;
  lenM: number;
  poly: LngLat[];
}

interface NrCallingPoint {
  crs: string;
  name: string;
  st: string;
  et?: string;
  at?: string;
}

interface NrService {
  rid: string;
  std: string;
  etd?: string;
  platform?: string;
  operator?: string;
  origin: string;
  destination: string;
  cancelled: boolean;
  callingPoints: NrCallingPoint[];
}

interface NrBoard {
  crs: string;
  services: NrService[];
}

interface TimedStop {
  crs: string;
  name: string;
  /** epoch ms */
  time: number;
}

interface NrTrain {
  rid: string;
  operator: string;
  destination: string;
  platform: string;
  delayed: boolean;
  stops: TimedStop[];
}

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);

// Live train table + path resolver at module scope so findNrTrain (the
// leaderboard's dblclick locator) can evaluate positions outside the
// startNrTrains closure. Populated once startNrTrains has loaded the graph.
const trains = new Map<string, NrTrain>();
let activeRailPath: ((a: string, b: string) => LngLat[] | null) | null = null;

interface TrainFix {
  lngLat: LngLat;
  bearing: number;
  /** index of the stop the train most recently departed */
  legIndex: number;
}

/** Clock-driven position of a tracked train, or null when off-coverage. */
function currentFix(t: NrTrain, now: number): TrainFix | null {
  if (!activeRailPath) return null;
  const { stops } = t;
  if (stops[0].time > now) return null; // not yet departed our coverage
  let i = 0;
  while (i < stops.length - 1 && stops[i + 1].time <= now) i++;
  if (i >= stops.length - 1) return null; // journey finished
  const path = activeRailPath(stops[i].crs, stops[i + 1].crs);
  if (!path || polylineLength(path) === 0) return null;
  const span = stops[i + 1].time - stops[i].time;
  const frac = span <= 0 ? 0 : Math.min(1, (now - stops[i].time) / span);
  const pt = pointAtFraction(path, frac);
  return { lngLat: pt.lngLat, bearing: pt.bearing, legIndex: i };
}

/** rid → current displayed position, for the leaderboard dblclick locator. */
export function findNrTrain(rid: string): [number, number] | null {
  const t = trains.get(rid);
  if (!t) return null;
  return currentFix(t, Date.now())?.lngLat ?? null;
}

/** "HH:mm" → epoch ms nearest to now (handles the midnight wrap). */
function parseTime(hhmm: string, now: number): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const d = new Date(now);
  d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  let t = d.getTime();
  const HALF_DAY = 12 * 3600_000;
  if (t - now > HALF_DAY) t -= 24 * 3600_000;
  if (now - t > HALF_DAY) t += 24 * 3600_000;
  return t;
}

/** best known time for a stop: actual > parseable estimate > scheduled */
function stopTime(p: { st: string; et?: string; at?: string }, now: number): number | null {
  return (
    (p.at ? parseTime(p.at, now) : null) ??
    (p.et ? parseTime(p.et, now) : null) ??
    parseTime(p.st, now)
  );
}

export async function startNrTrains(map: MaplibreMap): Promise<void> {
  const [stationsRes, segmentsRes] = await Promise.all([
    fetch('/nr/stations.json'),
    fetch('/nr/segments.json'),
  ]);
  if (!stationsRes.ok || !segmentsRes.ok) return;
  const stations = new Map(
    ((await stationsRes.json()) as Station[]).map((s) => [s.crs, s]),
  );
  const segments = (await segmentsRes.json()) as Segment[];

  // adjacency + segment lookup for pathing between calling points
  const neighbours = new Map<string, { crs: string; lenM: number }[]>();
  const segByPair = new Map<string, Segment>();
  for (const seg of segments) {
    segByPair.set(`${seg.a}>${seg.b}`, seg);
    segByPair.set(`${seg.b}>${seg.a}`, seg);
    (neighbours.get(seg.a) ?? neighbours.set(seg.a, []).get(seg.a))!.push({ crs: seg.b, lenM: seg.lenM });
    (neighbours.get(seg.b) ?? neighbours.set(seg.b, []).get(seg.b))!.push({ crs: seg.a, lenM: seg.lenM });
  }

  /** shortest station-graph path A→B as one concatenated polyline (cached) */
  const PATH_CACHE_MAX = 300; // caps polyline memory; oldest entries evicted (FIFO)
  const pathCache = new Map<string, LngLat[] | null>();
  function cachePath(key: string, value: LngLat[] | null): void {
    if (pathCache.size >= PATH_CACHE_MAX) {
      const oldest = pathCache.keys().next().value;
      if (oldest !== undefined) pathCache.delete(oldest);
    }
    pathCache.set(key, value);
  }
  function railPath(a: string, b: string): LngLat[] | null {
    const key = `${a}>${b}`;
    const cached = pathCache.get(key);
    if (cached !== undefined) return cached;
    // Dijkstra over the 431-node station graph
    const dist = new Map<string, number>([[a, 0]]);
    const prev = new Map<string, string>();
    const visited = new Set<string>();
    while (true) {
      let cur: string | null = null;
      let curD = Infinity;
      for (const [crs, d] of dist) {
        if (!visited.has(crs) && d < curD) {
          cur = crs;
          curD = d;
        }
      }
      if (cur === null || curD > 60_000) {
        cachePath(key, null);
        return null;
      }
      if (cur === b) break;
      visited.add(cur);
      for (const n of neighbours.get(cur) ?? []) {
        const nd = curD + n.lenM;
        if (nd < (dist.get(n.crs) ?? Infinity)) {
          dist.set(n.crs, nd);
          prev.set(n.crs, cur);
        }
      }
    }
    const chain: string[] = [b];
    while (chain[0] !== a) chain.unshift(prev.get(chain[0])!);
    const poly: LngLat[] = [];
    for (let i = 0; i < chain.length - 1; i++) {
      const seg = segByPair.get(`${chain[i]}>${chain[i + 1]}`);
      if (!seg) {
        cachePath(key, null);
        return null;
      }
      const pts = seg.a === chain[i] ? seg.poly : [...seg.poly].reverse();
      poly.push(...(i === 0 ? pts : pts.slice(1)));
    }
    cachePath(key, poly);
    return poly;
  }
  activeRailPath = railPath;

  // ── vehicle icon + layer ──
  if (!map.hasImage('train-national-rail')) {
    // reuse the bullet generator via a tiny local copy: draw with canvas
    const c = document.createElement('canvas');
    c.width = 36;
    c.height = 64;
    const x = c.getContext('2d')!;
    x.beginPath();
    x.moveTo(4, 24);
    x.quadraticCurveTo(4, 9, 18, 4);
    x.quadraticCurveTo(32, 9, 32, 24);
    x.lineTo(32, 53);
    x.quadraticCurveTo(32, 60, 25, 60);
    x.lineTo(11, 60);
    x.quadraticCurveTo(4, 60, 4, 53);
    x.closePath();
    x.fillStyle = NR_COLOR;
    x.fill();
    x.strokeStyle = '#555';
    x.lineWidth = 3;
    x.stroke();
    map.addImage('train-national-rail', x.getImageData(0, 0, 36, 64), { pixelRatio: 2 });
  }
  map.addSource(SOURCE_ID, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer(
    {
      id: NR_TRAINS_LAYER_ID,
      type: 'symbol',
      source: SOURCE_ID,
      layout: {
        'icon-image': 'train-national-rail',
        'icon-size': ['interpolate', ['linear'], ['zoom'], 9, 0.3, 12, 0.5, 15, 0.85],
        'icon-rotate': ['get', 'bearing'],
        'icon-rotation-alignment': 'map',
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
    },
    'trains-dots',
  );

  // ── board polling (round-robin, deduped by rid) ──
  let hubIndex = 0;
  let boardsUnavailable = false;

  async function pollNextBoard(): Promise<void> {
    const crs = HUBS[hubIndex];
    hubIndex = (hubIndex + 1) % HUBS.length;
    try {
      const res = await fetch(`/api/nr-board?crs=${crs}`);
      if (res.status === 503) {
        boardsUnavailable = true; // no token yet — idle quietly
        return;
      }
      boardsUnavailable = false;
      if (!res.ok) return;
      const board = (await res.json()) as NrBoard;
      const now = Date.now();
      for (const svc of board.services ?? []) {
        if (!svc.rid || svc.cancelled) continue;
        const boardStation = stations.get(board.crs);
        const first: TimedStop[] = boardStation
          ? [
              {
                crs: board.crs,
                name: boardStation.name,
                time: stopTime({ st: svc.std, et: svc.etd }, now) ?? 0,
              },
            ]
          : [];
        const rest: TimedStop[] = svc.callingPoints
          .filter((p) => stations.has(p.crs))
          .map((p) => ({ crs: p.crs, name: p.name, time: stopTime(p, now) ?? 0 }))
          .filter((p) => p.time > 0);
        const stops = [...first, ...rest].filter((p) => p.time > 0);
        if (stops.length < 2) continue;
        const existing = trains.get(svc.rid);
        // keep the sighting with the longest calling pattern (earliest board)
        if (existing && existing.stops.length >= stops.length) continue;
        trains.set(svc.rid, {
          rid: svc.rid,
          operator: svc.operator ?? '',
          destination: svc.destination,
          platform: svc.platform ?? '',
          delayed: svc.etd !== undefined && svc.etd !== 'On time' && !/^\d/.test(svc.etd),
          stops,
        });
      }
      // prune finished journeys
      for (const [rid, t] of trains) {
        if (t.stops[t.stops.length - 1].time < now - 120_000) trains.delete(rid);
      }
    } catch {
      // transient — next board in a few seconds anyway
    }
  }

  const renderGate = makeRenderGate(SYMBOL_TIER_INTERVAL_MS);
  let lastWasEmpty = false;
  function render(frameNow: number): void {
    if (!renderGate(frameNow) || !isLayerShown(map, NR_TRAINS_LAYER_ID)) {
      requestAnimationFrame(render);
      return;
    }
    const now = Date.now();
    const features = [];
    for (const t of trains.values()) {
      const fix = currentFix(t, now);
      if (!fix) continue;
      const next = t.stops[fix.legIndex + 1];
      features.push({
        type: 'Feature' as const,
        properties: {
          rid: t.rid,
          operator: t.operator,
          destination: t.destination,
          nextStop: next.name,
          etaMin: Math.max(0, Math.round((next.time - now) / 60_000)),
          delayed: t.delayed ? 1 : 0,
          bearing: fix.bearing,
        },
        geometry: { type: 'Point' as const, coordinates: fix.lngLat },
      });
    }
    const src = map.getSource(SOURCE_ID);
    if (src && 'setData' in src && !(features.length === 0 && lastWasEmpty)) {
      (src as GeoJSONSource).setData({ type: 'FeatureCollection', features });
    }
    lastWasEmpty = features.length === 0;
    requestAnimationFrame(render);
  }

  // ── hover / click ──
  const tip = new Popup({ closeButton: false, closeOnClick: false, offset: 12, className: 'hover-tip' });
  map.on('mousemove', NR_TRAINS_LAYER_ID, (e: MapLayerMouseEvent) => {
    const p = e.features?.[0]?.properties as Record<string, string | number> | undefined;
    if (!p) return;
    map.getCanvas().style.cursor = 'pointer';
    tip
      .setLngLat(e.lngLat)
      .setHTML(
        `<div class="vp"><b>${esc(String(p.operator))}</b> → ${esc(String(p.destination))}<div class="vp-dim">${esc(String(p.nextStop))} · ${String(p.etaMin)} min${Number(p.delayed) ? ' · ⚠ delayed' : ''}</div></div>`,
      )
      .addTo(map);
  });
  map.on('mouseleave', NR_TRAINS_LAYER_ID, () => {
    map.getCanvas().style.cursor = '';
    tip.remove();
  });
  const detail = new Popup({ closeButton: true, closeOnClick: true, offset: 14, maxWidth: '300px' });
  map.on('click', NR_TRAINS_LAYER_ID, (e: MapLayerMouseEvent) => {
    const p = e.features?.[0]?.properties as Record<string, string | number> | undefined;
    if (!p) return;
    tip.remove();
    const t = trains.get(String(p.rid));
    const calling = t
      ? t.stops
          .filter((s) => s.time > Date.now())
          .slice(0, 5)
          .map(
            (s) =>
              `<div class="sp-row"><span class="sp-dest">${esc(s.name)}</span><span class="sp-eta">${new Date(s.time).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</span></div>`,
          )
          .join('')
      : '';
    detail
      .setLngLat(e.lngLat)
      .setHTML(
        `<div class="vp"><div class="vp-line" style="background:#5a5f66">National Rail</div>
        <div class="vp-dest">→ ${esc(String(p.destination))}</div>
        <div class="vp-dim">${esc(String(p.operator))}${Number(p.delayed) ? ' · ⚠ delayed' : ''}</div>
        ${calling ? `<div class="vp-section">Calling at</div>${calling}` : ''}</div>`,
      )
      .addTo(map);
    appendRankLine(detail, 'train', `train:nr:${String(p.rid)}`);
  });

  await pollNextBoard();
  window.setInterval(() => {
    if (!boardsUnavailable || hubIndex === 0) void pollNextBoard();
  }, BOARD_STAGGER_MS);
  requestAnimationFrame(render);
}
