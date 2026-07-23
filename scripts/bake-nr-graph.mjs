// Bake a National Rail station-to-station segment network for Greater London.
//
// Usage:  node scripts/bake-nr-graph.mjs
//
// Inputs (both cached under data/osm-cache/ so re-runs resume):
//   - UK station list (davwheat/uk-railway-stations) -> uk-stations.json
//   - Overpass way["railway"="rail"] with no service=* tag, fetched as four
//     bbox quadrants -> nr-rail-q1.json .. nr-rail-q4.json
//
// Outputs:
//   - data/nr/stations.json  [{ crs, name, lat, lon }]           (5 dp)
//   - data/nr/segments.json  [{ a, b, lenM, poly: [[lon,lat]] }] (5 dp)
//
// Algorithm: build a node graph from all rail ways (nodes keyed by 1e-6
// rounded coords), snap each station to its nearest graph node (<= 500 m),
// then run one multi-target Dijkstra per station. Adjacency follows the
// definition "B is adjacent to A if the shortest path A->B does not pass
// within 300 m of any other snapped station's node": every graph node within
// 300 m of a snap node belongs to that station's zone (nearest station wins),
// and Dijkstra branches entering a foreign zone may travel within it but
// never leave it, so corridors of parallel tracks terminate at each station
// they pass. The cheapest settled node per foreign zone becomes the neighbour
// hit and its Dijkstra path the segment polyline. Undirected deduped output.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');
const CACHE = join(DATA, 'osm-cache');
const OUT_DIR = join(DATA, 'nr');

const STATIONS_URL =
  'https://raw.githubusercontent.com/davwheat/uk-railway-stations/main/stations.json';
const STATIONS_CACHE = join(CACHE, 'uk-stations.json');

const BBOX = { south: 51.25, west: -0.55, north: 51.72, east: 0.35 };

const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const BACKOFF_MS = [15000, 40000, 90000];

const SNAP_MAX_M = 500; // station centroid -> nearest track node
const ZONE_M = 300; // nodes this close to a snap node belong to that station
const PATH_CAP_M = 25000; // give up Dijkstra branches beyond this
const MAX_PATH_RATIO = 3; // path/straight beyond this = wrong routing, drop
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const DP_EPSILON_M = 10; // Douglas-Peucker tolerance if output too large

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── planar geometry (equirectangular at lat 51.5, as bake-osm-geometry) ─────
const M_PER_DEG_LAT = 110540;
const M_PER_DEG_LON = 111320 * Math.cos((51.5 * Math.PI) / 180);
const toXY = ([lon, lat]) => [lon * M_PER_DEG_LON, lat * M_PER_DEG_LAT];
const dist = (a, b) => {
  const [ax, ay] = toXY(a);
  const [bx, by] = toXY(b);
  return Math.hypot(ax - bx, ay - by);
};
const round5 = (n) => Math.round(n * 1e5) / 1e5;

// ── HTTP helpers ─────────────────────────────────────────────────────────────
const COMMON_HEADERS = {
  Accept: 'application/json',
  'User-Agent': 'london-live-2d-bake-script/1.0 (one-off NR geometry bake; contact: local dev)',
};

function curlOverpass(url, query) {
  // node fetch sometimes gets 406 from Overpass mirrors; curl does not.
  try {
    const stdout = execFileSync(
      'curl',
      ['-sS', '--fail', '--max-time', '300', '-H', 'Accept: application/json',
        '--data-urlencode', `data=${query}`, url],
      { maxBuffer: 512 * 1024 * 1024, encoding: 'utf8' },
    );
    const data = JSON.parse(stdout);
    if (data.elements) return data;
  } catch {
    /* fall through to next attempt */
  }
  return null;
}

async function fetchOverpass(query, label) {
  let lastErr = null;
  const delays = [0, ...BACKOFF_MS];
  for (const delay of delays) {
    if (delay) {
      console.log(`    retrying ${label} in ${delay / 1000}s (${lastErr})`);
      await sleep(delay);
    }
    for (const url of OVERPASS_URLS) {
      const host = new URL(url).host;
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...COMMON_HEADERS },
          body: `data=${encodeURIComponent(query)}`,
        });
        if (res.ok) {
          const data = await res.json();
          if (data.elements) return data;
          lastErr = `malformed response from ${host}`;
        } else {
          lastErr = `HTTP ${res.status} from ${host}`;
          if (res.status === 406) {
            const viaCurl = curlOverpass(url, query);
            if (viaCurl) return viaCurl;
            lastErr += ' (curl fallback also failed)';
          }
        }
      } catch (e) {
        lastErr = `${e.message} (${host})`;
        const viaCurl = curlOverpass(url, query);
        if (viaCurl) return viaCurl;
      }
      await sleep(3000); // space requests out between mirrors
    }
  }
  throw new Error(`Overpass failed for ${label}: ${lastErr}`);
}

// ── input 1: stations ────────────────────────────────────────────────────────
async function loadStations() {
  let raw;
  if (existsSync(STATIONS_CACHE)) {
    raw = JSON.parse(readFileSync(STATIONS_CACHE, 'utf8'));
    console.log(`stations: ${raw.length} from cache`);
  } else {
    console.log('stations: fetching', STATIONS_URL);
    const res = await fetch(STATIONS_URL, { headers: COMMON_HEADERS });
    if (!res.ok) throw new Error(`station list fetch failed: HTTP ${res.status}`);
    raw = await res.json();
    if (!Array.isArray(raw) || raw.length < 2000) {
      throw new Error(`station list looks wrong (${Array.isArray(raw) ? raw.length : typeof raw})`);
    }
    writeFileSync(STATIONS_CACHE, JSON.stringify(raw));
    console.log(`stations: fetched ${raw.length}, cached`);
  }

  const seen = new Set();
  const kept = [];
  let skippedBad = 0;
  for (const s of raw) {
    const lat = Number(s.lat);
    const lon = Number(s.long);
    const crs = typeof s.crsCode === 'string' ? s.crsCode.trim().toUpperCase() : '';
    if (!crs || !Number.isFinite(lat) || !Number.isFinite(lon)) {
      skippedBad++;
      continue;
    }
    if (lat < BBOX.south || lat > BBOX.north || lon < BBOX.west || lon > BBOX.east) continue;
    if (seen.has(crs)) continue;
    seen.add(crs);
    kept.push({ crs, name: s.stationName, lat, lon });
  }
  console.log(`stations: ${kept.length} inside bbox (${skippedBad} rows without crs/coords skipped)`);
  return kept;
}

// ── input 2: rail ways (4 bbox quadrants, cached separately) ────────────────
function quadrantBoxes() {
  const midLat = (BBOX.south + BBOX.north) / 2;
  const midLon = (BBOX.west + BBOX.east) / 2;
  return [
    { name: 'q1', s: BBOX.south, w: BBOX.west, n: midLat, e: midLon },
    { name: 'q2', s: BBOX.south, w: midLon, n: midLat, e: BBOX.east },
    { name: 'q3', s: midLat, w: BBOX.west, n: BBOX.north, e: midLon },
    { name: 'q4', s: midLat, w: midLon, n: BBOX.north, e: BBOX.east },
  ];
}

async function loadRailWays() {
  const wayById = new Map(); // id -> [[lon,lat], ...]
  for (const q of quadrantBoxes()) {
    const cachePath = join(CACHE, `nr-rail-${q.name}.json`);
    let data = null;
    if (existsSync(cachePath)) {
      const cached = JSON.parse(readFileSync(cachePath, 'utf8'));
      if (cached.elements?.length) {
        data = cached;
        console.log(`rail ${q.name}: ${cached.elements.length} elements from cache`);
      }
    }
    if (!data) {
      const query = [
        '[out:json][timeout:300];',
        `way["railway"="rail"]["service"!~"."](${q.s},${q.w},${q.n},${q.e});`,
        'out geom;',
      ].join('\n');
      console.log(`rail ${q.name}: querying Overpass (${q.s},${q.w},${q.n},${q.e})…`);
      data = await fetchOverpass(query, `rail ${q.name}`);
      writeFileSync(cachePath, JSON.stringify(data));
      console.log(`rail ${q.name}: fetched ${data.elements.length} elements, cached`);
      await sleep(5000); // be nice to Overpass between quadrants
    }
    for (const el of data.elements) {
      if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;
      if (!wayById.has(el.id)) {
        wayById.set(el.id, el.geometry.map((g) => [g.lon, g.lat]));
      }
    }
  }
  console.log(`rail: ${wayById.size} unique ways after merging quadrants`);
  return [...wayById.values()];
}

// ── node graph (integer-indexed for Dijkstra speed) ─────────────────────────
const nodeKey = (p) => `${Math.round(p[0] * 1e6)}|${Math.round(p[1] * 1e6)}`;

function buildGraph(ways) {
  const keyToIdx = new Map();
  const coords = []; // idx -> [lon, lat]
  const adjLists = []; // idx -> flat [to0, w0, to1, w1, ...]
  const idxOf = (p) => {
    const k = nodeKey(p);
    let i = keyToIdx.get(k);
    if (i === undefined) {
      i = coords.length;
      keyToIdx.set(k, i);
      coords.push(p);
      adjLists.push([]);
    }
    return i;
  };
  let edges = 0;
  for (const way of ways) {
    let prevIdx = idxOf(way[0]);
    for (let i = 1; i < way.length; i++) {
      const curIdx = idxOf(way[i]);
      if (curIdx !== prevIdx) {
        const w = dist(coords[prevIdx], coords[curIdx]);
        adjLists[prevIdx].push(curIdx, w);
        adjLists[curIdx].push(prevIdx, w);
        edges++;
      }
      prevIdx = curIdx;
    }
  }
  return { coords, adjLists, edges };
}

// ── station snapping via spatial grid ───────────────────────────────────────
const CELL_LAT = 0.005; // ~550 m
const CELL_LON = 0.0075; // ~520 m
const cellKey = (lat, lon) => `${Math.floor(lat / CELL_LAT)}|${Math.floor(lon / CELL_LON)}`;

function buildNodeGrid(coords) {
  const grid = new Map(); // cell -> [nodeIdx]
  for (let i = 0; i < coords.length; i++) {
    const k = cellKey(coords[i][1], coords[i][0]);
    let cell = grid.get(k);
    if (!cell) {
      cell = [];
      grid.set(k, cell);
    }
    cell.push(i);
  }
  return grid;
}

function nearestNodes(grid, coords, station) {
  const p = [station.lon, station.lat];
  const cy = Math.floor(station.lat / CELL_LAT);
  const cx = Math.floor(station.lon / CELL_LON);
  const found = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cell = grid.get(`${cy + dy}|${cx + dx}`);
      if (!cell) continue;
      for (const i of cell) {
        const d = dist(p, coords[i]);
        if (d <= SNAP_MAX_M) found.push({ i, d });
      }
    }
  }
  found.sort((a, b) => a.d - b.d);
  return found;
}

// ── binary min-heap over (cost, nodeIdx) ────────────────────────────────────
class MinHeap {
  constructor() {
    this.cost = [];
    this.node = [];
  }
  get size() {
    return this.cost.length;
  }
  push(c, n) {
    const { cost, node } = this;
    cost.push(c);
    node.push(n);
    let i = cost.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (cost[p] <= cost[i]) break;
      [cost[p], cost[i]] = [cost[i], cost[p]];
      [node[p], node[i]] = [node[i], node[p]];
      i = p;
    }
  }
  pop() {
    const { cost, node } = this;
    const top = [cost[0], node[0]];
    const lastC = cost.pop();
    const lastN = node.pop();
    if (cost.length) {
      cost[0] = lastC;
      node[0] = lastN;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < cost.length && cost[l] < cost[m]) m = l;
        if (r < cost.length && cost[r] < cost[m]) m = r;
        if (m === i) break;
        [cost[m], cost[i]] = [cost[i], cost[m]];
        [node[m], node[i]] = [node[i], node[m]];
        i = m;
      }
    }
    return top;
  }
}

// ── polyline helpers ────────────────────────────────────────────────────────
function roundPoly(pts) {
  const out = [];
  for (const [lon, lat] of pts) {
    const p = [round5(lon), round5(lat)];
    const last = out[out.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
  }
  return out;
}

function simplifyDP(pts, epsM) {
  if (pts.length <= 2) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [i0, i1] = stack.pop();
    if (i1 - i0 < 2) continue;
    const [ax, ay] = toXY(pts[i0]);
    const [bx, by] = toXY(pts[i1]);
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let maxD = -1;
    let maxI = -1;
    for (let i = i0 + 1; i < i1; i++) {
      const [px, py] = toXY(pts[i]);
      let d;
      if (len2 === 0) {
        d = Math.hypot(px - ax, py - ay);
      } else {
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
        d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      }
      if (d > maxD) {
        maxD = d;
        maxI = i;
      }
    }
    if (maxD > epsM) {
      keep[maxI] = 1;
      stack.push([i0, maxI], [maxI, i1]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

// ── main ────────────────────────────────────────────────────────────────────
mkdirSync(CACHE, { recursive: true });
mkdirSync(OUT_DIR, { recursive: true });

const stationsInBox = await loadStations();
const ways = await loadRailWays();

const { coords, adjLists, edges } = buildGraph(ways);
console.log(`graph: ${coords.length} nodes, ${edges} edges`);

// Snap stations (no two stations share a snap node; take next-nearest if taken).
const grid = buildNodeGrid(coords);
const snapped = []; // { crs, name, lat, lon, node, snapD }
const dropped = []; // { crs, name, reason }
const nodeTaken = new Set();
for (const st of stationsInBox) {
  const candidates = nearestNodes(grid, coords, st);
  const pick = candidates.find((c) => !nodeTaken.has(c.i));
  if (!pick) {
    dropped.push({ crs: st.crs, name: st.name, reason: `no rail node within ${SNAP_MAX_M} m` });
    continue;
  }
  nodeTaken.add(pick.i);
  snapped.push({ ...st, node: pick.i, snapD: pick.d });
}
console.log(`snap: ${snapped.length} stations snapped, ${dropped.length} dropped`);
for (const d of dropped) console.log(`  dropped ${d.crs} ${d.name}: ${d.reason}`);

// Assign every graph node within ZONE_M of a snap node to that station's
// zone (nearest station wins). Zones make adjacency robust to parallel
// tracks: any track passing a station falls inside its zone.
const n = coords.length;
const zoneOf = new Int32Array(n).fill(-1);
{
  const zoneDist = new Float64Array(n).fill(Infinity);
  const snapGrid = new Map(); // cell -> [stationIdx]
  snapped.forEach((st, si) => {
    const [lon, lat] = coords[st.node];
    const k = cellKey(lat, lon);
    let cell = snapGrid.get(k);
    if (!cell) {
      cell = [];
      snapGrid.set(k, cell);
    }
    cell.push(si);
  });
  for (let i = 0; i < n; i++) {
    const [lon, lat] = coords[i];
    const cy = Math.floor(lat / CELL_LAT);
    const cx = Math.floor(lon / CELL_LON);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cell = snapGrid.get(`${cy + dy}|${cx + dx}`);
        if (!cell) continue;
        for (const si of cell) {
          const d = dist(coords[i], coords[snapped[si].node]);
          if (d <= ZONE_M && d < zoneDist[i]) {
            zoneDist[i] = d;
            zoneOf[i] = si;
          }
        }
      }
    }
  }
}
const zoneNodes = snapped.map(() => []);
for (let i = 0; i < n; i++) if (zoneOf[i] >= 0) zoneNodes[zoneOf[i]].push(i);

// Per-station Dijkstra. Seeds: all nodes in the station's own zone, seeded
// with the straight-line stub from the snap node. Branch rule: a path may
// enter a foreign station's zone and move within it, but never leave it —
// so every route terminates at the first station it passes. The cheapest
// settled node per foreign zone (path cost + exit stub) is the neighbour hit.
const distArr = new Float64Array(n);
const prevArr = new Int32Array(n);
const stampArr = new Int32Array(n);
let run = 0;

function dijkstraNeighbours(si) {
  run++;
  const snapCoord = coords[snapped[si].node];
  const heap = new MinHeap();
  for (const i of zoneNodes[si]) {
    const c = dist(coords[i], snapCoord);
    stampArr[i] = run;
    distArr[i] = c;
    prevArr[i] = -1;
    heap.push(c, i);
  }
  const bestHit = new Map(); // otherStationIdx -> { node, score, cost }
  while (heap.size) {
    const [c, i] = heap.pop();
    if (stampArr[i] !== run || c > distArr[i]) continue;
    if (c > PATH_CAP_M) break;
    const zi = zoneOf[i];
    const isForeign = zi >= 0 && zi !== si;
    if (isForeign) {
      const score = c + dist(coords[i], coords[snapped[zi].node]);
      const prevBest = bestHit.get(zi);
      if (!prevBest || score < prevBest.score) bestHit.set(zi, { node: i, score, cost: c });
    }
    const a = adjLists[i];
    for (let j = 0; j < a.length; j += 2) {
      const to = a[j];
      if (isForeign && zoneOf[to] !== zi) continue; // may not leave a foreign zone
      const nc = c + a[j + 1];
      if (stampArr[to] !== run || nc < distArr[to]) {
        stampArr[to] = run;
        distArr[to] = nc;
        prevArr[to] = i;
        heap.push(nc, to);
      }
    }
  }
  return bestHit;
}

function pathTo(node) {
  const path = [];
  for (let i = node; i !== -1; i = prevArr[i]) path.push(coords[i]);
  path.reverse();
  return path;
}

const polyLength = (pts) => {
  let sum = 0;
  for (let i = 0; i < pts.length - 1; i++) sum += dist(pts[i], pts[i + 1]);
  return sum;
};

console.log('adjacency: running one Dijkstra per station…');
const segByKey = new Map(); // "A|B" (crs sorted) -> { a, b, lenM, path }
const t0 = Date.now();
for (let si = 0; si < snapped.length; si++) {
  const hits = dijkstraNeighbours(si);
  for (const [otherIdx, h] of hits) {
    const other = snapped[otherIdx];
    const me = snapped[si];
    // Full polyline: my snap point -> zone path -> other snap point.
    const inner = pathTo(h.node);
    const path = [coords[me.node], ...inner, coords[other.node]];
    const lenM = polyLength(path);
    if (lenM > PATH_CAP_M) continue;
    const [a, b] = me.crs < other.crs ? [me, other] : [other, me];
    const key = `${a.crs}|${b.crs}`;
    const existing = segByKey.get(key);
    if (existing && existing.lenM <= lenM) continue;
    const oriented = me.crs === a.crs ? path : [...path].reverse();
    segByKey.set(key, { a: a.crs, b: b.crs, lenM, path: oriented });
  }
  if ((si + 1) % 100 === 0 || si === snapped.length - 1) {
    console.log(`  ${si + 1}/${snapped.length} stations (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  }
}

// Filter wrong routings (path much longer than straight line between snaps).
const snapByCrs = new Map(snapped.map((s) => [s.crs, s]));
const straightM = (seg) => {
  const a = snapByCrs.get(seg.a);
  const b = snapByCrs.get(seg.b);
  return Math.max(50, dist(coords[a.node], coords[b.node]));
};
const segments = [];
const rejected = [];
for (const seg of segByKey.values()) {
  const ratio = seg.lenM / straightM(seg);
  if (ratio > MAX_PATH_RATIO) {
    rejected.push({ ...seg, ratio });
  } else {
    segments.push(seg);
  }
}
if (rejected.length) {
  console.log(`ratio filter: dropped ${rejected.length} segments with path/straight > ${MAX_PATH_RATIO}:`);
  for (const r of rejected.slice(0, 20)) {
    console.log(`  ${r.a}-${r.b}: ${Math.round(r.lenM)} m, ratio ${r.ratio.toFixed(2)}`);
  }
  if (rejected.length > 20) console.log(`  … and ${rejected.length - 20} more`);
}

// ── outputs ─────────────────────────────────────────────────────────────────
const stationsOut = snapped.map((s) => ({
  crs: s.crs,
  name: s.name,
  lat: round5(s.lat),
  lon: round5(s.lon),
}));
writeFileSync(join(OUT_DIR, 'stations.json'), JSON.stringify(stationsOut));

let segmentsOut = segments.map((s) => ({
  a: s.a,
  b: s.b,
  lenM: Math.round(s.lenM),
  poly: roundPoly(s.path),
}));
let segJson = JSON.stringify(segmentsOut);
if (segJson.length > MAX_OUTPUT_BYTES) {
  console.log(
    `segments.json would be ${(segJson.length / 1e6).toFixed(1)} MB; ` +
      `applying ${DP_EPSILON_M} m Douglas-Peucker`,
  );
  segmentsOut = segments.map((s) => ({
    a: s.a,
    b: s.b,
    lenM: Math.round(s.lenM),
    poly: roundPoly(simplifyDP(s.path, DP_EPSILON_M)),
  }));
  segJson = JSON.stringify(segmentsOut);
}
writeFileSync(join(OUT_DIR, 'segments.json'), segJson);

// ── verification ────────────────────────────────────────────────────────────
console.log('\n── verification ──');
console.log(`stations kept: ${snapped.length}, dropped: ${dropped.length}`);
console.log(`graph: ${coords.length} nodes, ${edges} edges`);
console.log(`segments emitted: ${segmentsOut.length} (${rejected.length} rejected by ratio filter)`);
const avgNeighbours = snapped.length ? (2 * segmentsOut.length) / snapped.length : 0;
console.log(`average neighbours per station: ${avgNeighbours.toFixed(2)} (expect ~2-4)`);

// Largest connected component over the station/segment graph (union-find).
{
  const parent = new Map(snapped.map((s) => [s.crs, s.crs]));
  const find = (x) => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r);
    let c = x;
    while (parent.get(c) !== r) {
      const next = parent.get(c);
      parent.set(c, r);
      c = next;
    }
    return r;
  };
  for (const s of segmentsOut) parent.set(find(s.a), find(s.b));
  const sizes = new Map();
  for (const s of snapped) {
    const r = find(s.crs);
    sizes.set(r, (sizes.get(r) ?? 0) + 1);
  }
  const sorted = [...sizes.values()].sort((a, b) => b - a);
  console.log(
    `connected components: ${sorted.length}; largest ${sorted[0]}/${snapped.length} stations` +
      (sorted.length > 1 ? ` (others: ${sorted.slice(1, 11).join(', ')}${sorted.length > 11 ? ', …' : ''})` : ''),
  );
}

// Segment invariants.
{
  const tooLong = segmentsOut.filter((s) => s.lenM > PATH_CAP_M);
  console.log(
    tooLong.length
      ? `FAIL: ${tooLong.length} segments exceed ${PATH_CAP_M / 1000} km: ${tooLong.map((s) => `${s.a}-${s.b}`).join(', ')}`
      : `ok: no segment longer than ${PATH_CAP_M / 1000} km`,
  );
}

// Spot checks. When a direct segment is absent (a station lies between the
// pair, so by the adjacency definition the link is a chain), report the
// shortest chain over the emitted segment network as evidence of coverage.
const segIndex = new Map(segmentsOut.map((s) => [`${s.a}|${s.b}`, s]));
const getSeg = (x, y) => segIndex.get(x < y ? `${x}|${y}` : `${y}|${x}`);

function chainBetween(x, y) {
  const adjS = new Map();
  for (const s of segmentsOut) {
    if (!adjS.has(s.a)) adjS.set(s.a, []);
    if (!adjS.has(s.b)) adjS.set(s.b, []);
    adjS.get(s.a).push({ to: s.b, w: s.lenM, seg: s });
    adjS.get(s.b).push({ to: s.a, w: s.lenM, seg: s });
  }
  const cost = new Map([[x, 0]]);
  const from = new Map();
  const queue = [{ crs: x, c: 0 }];
  while (queue.length) {
    queue.sort((p, q) => p.c - q.c);
    const { crs, c } = queue.shift();
    if (c > (cost.get(crs) ?? Infinity)) continue;
    if (crs === y) break;
    for (const e of adjS.get(crs) ?? []) {
      const nc = c + e.w;
      if (nc < (cost.get(e.to) ?? Infinity)) {
        cost.set(e.to, nc);
        from.set(e.to, { crs, seg: e.seg });
        queue.push({ crs: e.to, c: nc });
      }
    }
  }
  if (!cost.has(y)) return null;
  const crsPath = [y];
  let pts = 0;
  for (let cur = y; cur !== x; ) {
    const f = from.get(cur);
    pts += f.seg.poly.length;
    cur = f.crs;
    crsPath.push(cur);
  }
  crsPath.reverse();
  return { stations: crsPath, lenM: cost.get(y), pts };
}
const spotChecks = [
  { label: 'WAT-CLJ', pairs: [['WAT', 'CLJ']], minPts: 40, kmRange: [5, 8] },
  { label: 'VIC-CLJ', pairs: [['VIC', 'CLJ']] },
  { label: 'KGX/STP-FPK', pairs: [['KGX', 'FPK'], ['STP', 'FPK']] },
  { label: 'LST-SRA', pairs: [['LST', 'SRA']] },
  { label: 'PAD-west (EAL/AML/STL/HAY)', pairs: [['PAD', 'EAL'], ['PAD', 'AML'], ['PAD', 'STL'], ['PAD', 'HAY']] },
];
let spotFailures = 0;
console.log('\nspot checks:');
for (const check of spotChecks) {
  const found = check.pairs.map(([x, y]) => ({ x, y, seg: getSeg(x, y) })).filter((f) => f.seg);
  if (!found.length) {
    // No direct segment: intermediate calling stations sit on the route, so
    // by the 300 m adjacency rule the pair is covered by a chain of
    // segments. Validate the chain against the same expectations.
    let chainOk = false;
    for (const [x, y] of check.pairs) {
      const chain = chainBetween(x, y);
      if (!chain) continue;
      const sx = snapByCrs.get(x);
      const sy = snapByCrs.get(y);
      const straight = dist(coords[sx.node], coords[sy.node]);
      const ratio = chain.lenM / Math.max(50, straight);
      const km = chain.lenM / 1000;
      const issues = [];
      if (ratio < 1.0 || ratio > 1.8) issues.push(`ratio ${ratio.toFixed(2)} outside 1.0-1.8`);
      if (check.minPts && chain.pts <= check.minPts) issues.push(`only ${chain.pts} pts`);
      if (check.kmRange && (km < check.kmRange[0] || km > check.kmRange[1])) {
        issues.push(`length ${km.toFixed(1)} km outside ~${check.kmRange[0]}-${check.kmRange[1]} km`);
      }
      console.log(
        `  ${issues.length ? 'FAIL' : 'ok  '} ${x}-${y} via chain ${chain.stations.join('-')}: ` +
          `${km.toFixed(2)} km, ${chain.pts} pts, path/straight ${ratio.toFixed(2)}` +
          (issues.length ? `  [${issues.join('; ')}]` : '  (no direct segment: intermediate stations on route)'),
      );
      if (!issues.length) chainOk = true;
      break;
    }
    if (!chainOk) spotFailures++;
    continue;
  }
  for (const { x, y, seg } of found) {
    const sa = snapByCrs.get(x);
    const sb = snapByCrs.get(y);
    const straight = dist(coords[sa.node], coords[sb.node]);
    const ratio = seg.lenM / Math.max(50, straight);
    const issues = [];
    if (ratio < 1.0 || ratio > 1.8) issues.push(`ratio ${ratio.toFixed(2)} outside 1.0-1.8`);
    if (check.minPts && seg.poly.length <= check.minPts) {
      issues.push(`only ${seg.poly.length} poly points (need > ${check.minPts})`);
    }
    if (check.kmRange) {
      const km = seg.lenM / 1000;
      if (km < check.kmRange[0] || km > check.kmRange[1]) {
        issues.push(`length ${km.toFixed(1)} km outside ~${check.kmRange[0]}-${check.kmRange[1]} km`);
      }
    }
    if (issues.length) spotFailures++;
    console.log(
      `  ${issues.length ? 'FAIL' : 'ok  '} ${x}-${y}: ${(seg.lenM / 1000).toFixed(2)} km, ` +
        `${seg.poly.length} pts, path/straight ${ratio.toFixed(2)}` +
        (issues.length ? `  [${issues.join('; ')}]` : ''),
    );
  }
}

const stationsBytes = JSON.stringify(stationsOut).length;
console.log(
  `\noutputs: data/nr/stations.json ${(stationsBytes / 1024).toFixed(0)} KB, ` +
    `data/nr/segments.json ${(segJson.length / 1e6).toFixed(2)} MB`,
);
if (spotFailures) {
  console.log(`\nWARNING: ${spotFailures} spot-check failure(s) — see above.`);
  process.exitCode = 1;
} else {
  console.log('\nall spot checks passed');
}
