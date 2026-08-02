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
import { isLayerShown, makeRenderGate } from '../util/render-gate';
import { registerPoll, symbolTierIntervalMs } from '../util/lifecycle';
import { appendRankLine } from '../ui/rank-line';
import { enablePopupDragToPan, isPopupTextInteracting } from '../ui/popup-drag';
import { below } from '../util/layer-order';

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

// ── gateway stations (fast / express fix) ─────────────────────────────────
// Fast trains leave a London terminus and their FIRST calling point lies
// OUTSIDE the in-box station graph (e.g. Euston→Milton Keynes, Paddington→
// Reading). After filtering calling points to in-box stations only the origin
// survives → no segment pair → the train never renders even while physically
// crossing visible London track. Each gateway maps a first-out-of-box
// calling-point CRS to `snap`: the outermost in-box station on the SAME line of
// route (a real rail-graph node). origin→snap then gives a segment pair along
// the true corridor (WCML/GWML/ECML/MML/GEML/…) out to the bbox edge, where the
// train correctly leaves view. lat/lon are the gateway's real coordinates
// (verified against data/osm-cache/uk-stations.json); positioning uses the snap
// node's baked coordinates. KEEP IN SYNC with backend/src/shared/nr-inference.ts.
interface NrGateway {
  crs: string;
  name: string;
  lat: number;
  lon: number;
  /** outermost in-box station on the same line of route (a rail-graph node) */
  snap: string;
}
const NR_GATEWAYS: NrGateway[] = [
  // West Coast Main Line (Euston) → Kings Langley
  { crs: 'MKC', name: 'Milton Keynes Central', lat: 52.03436, lon: -0.77341, snap: 'KGL' },
  { crs: 'TRI', name: 'Tring', lat: 51.80033, lon: -0.62225, snap: 'KGL' },
  // Great Western Main Line (Paddington) → Langley
  { crs: 'RDG', name: 'Reading', lat: 51.45877, lon: -0.97217, snap: 'LNY' },
  { crs: 'SLO', name: 'Slough', lat: 51.51192, lon: -0.5918, snap: 'LNY' },
  { crs: 'MAI', name: 'Maidenhead', lat: 51.5186, lon: -0.72246, snap: 'LNY' },
  { crs: 'TWY', name: 'Twyford', lat: 51.47561, lon: -0.86389, snap: 'LNY' },
  // East Coast Main Line / Great Northern (King's Cross) → Potters Bar
  { crs: 'SVG', name: 'Stevenage', lat: 51.89903, lon: -0.20644, snap: 'PBR' },
  { crs: 'HIT', name: 'Hitchin', lat: 51.95291, lon: -0.2625, snap: 'PBR' },
  { crs: 'WGC', name: 'Welwyn Garden City', lat: 51.80096, lon: -0.20308, snap: 'PBR' },
  { crs: 'PBO', name: 'Peterborough', lat: 52.57495, lon: -0.24981, snap: 'PBR' },
  // Midland Main Line / Thameslink (St Pancras) → Radlett
  { crs: 'LUT', name: 'Luton', lat: 51.88223, lon: -0.41488, snap: 'RDT' },
  { crs: 'LTN', name: 'Luton Airport Parkway', lat: 51.87116, lon: -0.39348, snap: 'RDT' },
  { crs: 'SAC', name: 'St Albans City', lat: 51.74883, lon: -0.32684, snap: 'RDT' },
  { crs: 'BDM', name: 'Bedford', lat: 52.13618, lon: -0.47945, snap: 'RDT' },
  // Great Eastern Main Line (Liverpool St) → Shenfield
  { crs: 'CHM', name: 'Chelmsford', lat: 51.7366, lon: 0.46932, snap: 'SNF' },
  { crs: 'COL', name: 'Colchester', lat: 51.90048, lon: 0.89409, snap: 'SNF' },
  // West Anglia Main Line (Liverpool St) → Cheshunt
  { crs: 'HWN', name: 'Harlow Town', lat: 51.78164, lon: 0.0948, snap: 'CHN' },
  { crs: 'BIS', name: 'Bishops Stortford', lat: 51.86669, lon: 0.16557, snap: 'CHN' },
  { crs: 'SSD', name: 'Stansted Airport', lat: 51.88898, lon: 0.26162, snap: 'CHN' },
  // c2c (Fenchurch St) → West Horndon
  { crs: 'BSO', name: 'Basildon', lat: 51.56867, lon: 0.45731, snap: 'WHR' },
  // Chiltern Main Line (Marylebone) → Denham Golf Club
  { crs: 'HWY', name: 'High Wycombe', lat: 51.62979, lon: -0.74514, snap: 'DGC' },
  { crs: 'GER', name: 'Gerrards Cross', lat: 51.58888, lon: -0.55537, snap: 'DGC' },
  // South West Main Line (Waterloo) → West Byfleet / Clandon
  { crs: 'WOK', name: 'Woking', lat: 51.31847, lon: -0.55781, snap: 'WBY' },
  { crs: 'BSK', name: 'Basingstoke', lat: 51.26804, lon: -1.0869, snap: 'WBY' },
  { crs: 'GLD', name: 'Guildford', lat: 51.23691, lon: -0.58041, snap: 'CLA' },
  // South Eastern Main Line (Charing Cross) → Sevenoaks
  { crs: 'TON', name: 'Tonbridge', lat: 51.19113, lon: 0.26971, snap: 'SEV' },
  // Brighton Main Line (Victoria / London Bridge) → Merstham
  { crs: 'RDH', name: 'Redhill', lat: 51.24012, lon: -0.16485, snap: 'MHM' },
  { crs: 'GTW', name: 'Gatwick Airport', lat: 51.15642, lon: -0.16102, snap: 'MHM' },
];
/** gateway CRS → snap-node CRS (outermost in-box station on its line) */
const NR_GATEWAY_SNAP = new Map<string, string>(NR_GATEWAYS.map((g) => [g.crs, g.snap]));

/** collapse consecutive stops sharing a CRS so no zero-length leg is produced */
function dedupeStops(list: TimedStop[]): TimedStop[] {
  return list.filter((p, i) => i === 0 || p.crs !== list[i - 1].crs);
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
    below(map, 'trains-dots'),
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
          .map((p) => {
            // in-box station: use directly. out-of-box gateway: snap to the
            // outermost in-box node on its line so origin→snap forms a segment
            // pair along the real corridor. otherwise drop (invisible > wrong).
            const crs = stations.has(p.crs) ? p.crs : (NR_GATEWAY_SNAP.get(p.crs) ?? null);
            if (crs === null || !stations.has(crs)) return null;
            return { crs, name: p.name, time: stopTime(p, now) ?? 0 };
          })
          .filter((p): p is TimedStop => p !== null && p.time > 0);
        const stops = dedupeStops([...first, ...rest].filter((p) => p.time > 0));
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

  const renderGate = makeRenderGate(symbolTierIntervalMs);
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
    // Keep an open detail popup glued to its train. findNrTrain returns null
    // once the train leaves coverage — leave the popup at its last position.
    if (selectedRid && detail.isOpen()) {
      const el = detail.getElement();
      // Freeze following while the user is selecting/copying text in the card.
      if (!el || !isPopupTextInteracting(el)) {
        const pos = findNrTrain(selectedRid);
        if (pos) detail.setLngLat(pos);
      }
    }
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
  enablePopupDragToPan(map, detail);
  // The currently-selected train (by rid), followed by the detail popup.
  let selectedRid: string | null = null;
  detail.on('close', () => {
    selectedRid = null;
  });
  map.on('click', NR_TRAINS_LAYER_ID, (e: MapLayerMouseEvent) => {
    const p = e.features?.[0]?.properties as Record<string, string | number> | undefined;
    if (!p) return;
    tip.remove();
    selectedRid = String(p.rid);
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
  registerPoll(() => {
    if (!boardsUnavailable || hubIndex === 0) void pollNextBoard();
  }, BOARD_STAGGER_MS);
  requestAnimationFrame(render);
}
