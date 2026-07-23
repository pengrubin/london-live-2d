// Rebuild data/lines/<id>.json and data/branches/<id>.json segments from real
// OpenStreetMap railway geometry (Overpass API) instead of TfL's straight
// station-to-station chords on underground sections.
//
// Usage:  node scripts/bake-osm-geometry.mjs [lineId ...]
//
// - Stop lists in data/branches/<id>.json are authoritative and never changed;
//   only branches[].segments and data/lines/<id>.json geometry are rebuilt.
// - Raw Overpass responses are cached in data/osm-cache/<id>.json and reused.
// - When no OSM polyline fits a stop pair, the EXISTING TfL segment is kept
//   (never a synthetic straight line).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');
const CACHE = join(DATA, 'osm-cache');

const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter', // mirror, tried when primary fails
];
// Greater London + Elizabeth-line-to-Reading + Metropolitan-to-Chesham.
const BBOX = '51.0,-1.2,51.9,0.6';

// Overpass relation selectors per line (rail lines only; river-bus is skipped
// because TfL geometry already follows the Thames).
const OSM_TUBE = (name) => ({ route: 'subway', nameRe: `^${name}` });
const LINES = [
  { id: 'bakerloo', osm: OSM_TUBE('Bakerloo line') },
  { id: 'central', osm: OSM_TUBE('Central line') },
  { id: 'circle', osm: OSM_TUBE('Circle line') },
  { id: 'district', osm: OSM_TUBE('District line') },
  { id: 'hammersmith-city', osm: OSM_TUBE('Hammersmith & City line') },
  { id: 'jubilee', osm: OSM_TUBE('Jubilee line') },
  { id: 'metropolitan', osm: OSM_TUBE('Metropolitan line') },
  { id: 'northern', osm: OSM_TUBE('Northern line') },
  { id: 'piccadilly', osm: OSM_TUBE('Piccadilly line') },
  { id: 'victoria', osm: OSM_TUBE('Victoria line') },
  { id: 'waterloo-city', osm: OSM_TUBE('Waterloo & City line') },
  { id: 'dlr', osm: { route: 'light_rail', nameRe: '^(DLR:|Docklands Light Railway)' } },
  { id: 'elizabeth', osm: { route: 'train', nameRe: '^Elizabeth line' } },
  { id: 'liberty', osm: { route: 'train', nameRe: '^Liberty line' } },
  { id: 'lioness', osm: { route: 'train', nameRe: '^Lioness line' } },
  { id: 'mildmay', osm: { route: 'train', nameRe: '^Mildmay line' } },
  { id: 'suffragette', osm: { route: 'train', nameRe: '^Suffragette line' } },
  { id: 'weaver', osm: { route: 'train', nameRe: '^Weaver line' } },
  { id: 'windrush', osm: { route: 'train', nameRe: '^Windrush line' } },
];

const only = process.argv.slice(2);
const TARGET_LINES = only.length ? LINES.filter((l) => only.includes(l.id)) : LINES;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Overpass fetch with cache + backoff ──────────────────────────────────────
function buildQuery({ route, nameRe }) {
  return [
    '[out:json][timeout:180];',
    `rel["route"="${route}"]["name"~"${nameRe}",i](${BBOX});`,
    'way(r)["railway"~"^(rail|subway|light_rail|narrow_gauge)$"];',
    'out geom;',
  ].join('\n');
}

async function fetchOverpass(line) {
  const cachePath = join(CACHE, `${line.id}.json`);
  if (existsSync(cachePath)) {
    const cached = JSON.parse(readFileSync(cachePath, 'utf8'));
    if (cached.elements?.length) return { data: cached, fromCache: true };
  }
  const query = buildQuery(line.osm);
  const delays = [0, 10000, 30000, 60000, 90000];
  let lastErr = null;
  for (const delay of delays) {
    if (delay) {
      console.log(`    retrying ${line.id} in ${delay / 1000}s (${lastErr})`);
      await sleep(delay);
    }
    // Try primary endpoint first, then the mirror, on each attempt.
    for (const url of OVERPASS_URLS) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
            'User-Agent': 'london-live-2d-bake-script/1.0 (one-off geometry bake; contact: local dev)',
          },
          body: `data=${encodeURIComponent(query)}`,
        });
        if (!res.ok) {
          lastErr = `HTTP ${res.status} from ${new URL(url).host}`;
          continue;
        }
        const data = await res.json();
        if (!data.elements) {
          lastErr = `malformed response from ${new URL(url).host}`;
          continue;
        }
        writeFileSync(cachePath, JSON.stringify(data));
        return { data, fromCache: false };
      } catch (e) {
        lastErr = e.message;
      }
      await sleep(3000); // space requests out (another session may also be querying)
    }
  }
  throw new Error(`Overpass failed for ${line.id}: ${lastErr}`);
}

// ── planar geometry helpers (same approach as bake-routes.mjs) ───────────────
const M_PER_DEG_LAT = 110540;
const M_PER_DEG_LON = 111320 * Math.cos((51.5 * Math.PI) / 180);
const toXY = ([lon, lat]) => [lon * M_PER_DEG_LON, lat * M_PER_DEG_LAT];
const dist = (a, b) => {
  const [ax, ay] = toXY(a);
  const [bx, by] = toXY(b);
  return Math.hypot(ax - bx, ay - by);
};
const polyLength = (pts) => {
  let sum = 0;
  for (let i = 0; i < pts.length - 1; i++) sum += dist(pts[i], pts[i + 1]);
  return sum;
};

// Nearest point on polyline: { d: distance m, arc: arc-length m, seg, t }
function projectOnto(poly, pt) {
  const [px, py] = toXY(pt);
  let best = null;
  let arcBefore = 0;
  for (let i = 0; i < poly.length - 1; i++) {
    const [ax, ay] = toXY(poly[i]);
    const [bx, by] = toXY(poly[i + 1]);
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
    const qx = ax + t * dx;
    const qy = ay + t * dy;
    const d = Math.hypot(px - qx, py - qy);
    const segLen = Math.sqrt(len2);
    if (!best || d < best.d) best = { d, arc: arcBefore + t * segLen, seg: i, t };
    arcBefore += segLen;
  }
  return best;
}

// Sub-polyline between two arc-length positions (handles reversal).
function subPolyline(poly, projA, projB) {
  const reversed = projA.arc > projB.arc;
  const [from, to] = reversed ? [projB, projA] : [projA, projB];
  const pts = [];
  const lerp = (p, q, t) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
  pts.push(lerp(poly[from.seg], poly[from.seg + 1], from.t));
  for (let i = from.seg + 1; i <= to.seg; i++) pts.push(poly[i]);
  pts.push(lerp(poly[to.seg], poly[to.seg + 1], to.t));
  if (reversed) pts.reverse();
  return pts;
}

// Best sub-polyline connecting stops a→b across all polylines; null if none.
function trackSegment(polylines, a, b, maxSnap) {
  let best = null;
  for (const poly of polylines) {
    const pa = projectOnto(poly, a);
    const pb = projectOnto(poly, b);
    if (!pa || !pb) continue;
    const worst = Math.max(pa.d, pb.d);
    if (worst > maxSnap) continue;
    const pathLen = Math.abs(pb.arc - pa.arc);
    if (pathLen < 1) continue; // both snapped to same spot — wrong polyline
    if (pathLen > 4 * Math.max(200, dist(a, b))) continue; // absurd detour
    if (!best || worst < best.worst) best = { worst, poly, pa, pb };
  }
  if (!best) return null;
  return subPolyline(best.poly, best.pa, best.pb);
}

// ── way stitching ────────────────────────────────────────────────────────────
const nodeKey = (p) => `${Math.round(p[0] * 1e6)}|${Math.round(p[1] * 1e6)}`;

// Join ways sharing endpoints into maximal continuous polylines. A chain ends
// at junctions (3+ way endpoints meeting) and at dead ends.
function stitchWays(ways) {
  const endpoints = new Map(); // key -> [{ i, atStart }]
  const add = (k, entry) => {
    if (!endpoints.has(k)) endpoints.set(k, []);
    endpoints.get(k).push(entry);
  };
  ways.forEach((w, i) => {
    add(nodeKey(w[0]), { i, atStart: true });
    add(nodeKey(w[w.length - 1]), { i, atStart: false });
  });

  const used = new Array(ways.length).fill(false);
  const chains = [];

  // Extend chain from its tail (last point) while the endpoint is degree-2.
  const extend = (chain) => {
    for (;;) {
      const k = nodeKey(chain[chain.length - 1]);
      const here = endpoints.get(k) ?? [];
      if (here.length !== 2) return; // junction (3+) or dead end (1)
      const next = here.find((e) => !used[e.i]);
      if (!next) return;
      used[next.i] = true;
      const w = ways[next.i];
      const pts = next.atStart ? w : [...w].reverse();
      for (let j = 1; j < pts.length; j++) chain.push(pts[j]);
    }
  };

  for (let i = 0; i < ways.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    let chain = [...ways[i]];
    extend(chain); // forward from tail
    chain = chain.reverse();
    extend(chain); // forward from what was the head
    chains.push(chain);
  }
  return chains;
}

// ── graph shortest-path fallback (spans junctions parallel to trackSegment) ──
function buildGraph(ways) {
  const coords = new Map(); // key -> [lon, lat]
  const adj = new Map(); // key -> [{ to, w }]
  const edge = (ka, kb, w) => {
    if (!adj.has(ka)) adj.set(ka, []);
    adj.get(ka).push({ to: kb, w });
  };
  for (const way of ways) {
    for (let i = 0; i < way.length; i++) {
      const k = nodeKey(way[i]);
      if (!coords.has(k)) coords.set(k, way[i]);
      if (i > 0) {
        const kp = nodeKey(way[i - 1]);
        const w = dist(way[i - 1], way[i]);
        edge(kp, k, w);
        edge(k, kp, w);
      }
    }
  }
  return { coords, adj };
}

// Multi-source Dijkstra from vertices near `a` to vertices near `b`.
// Snap distance is penalised so nearer entry/exit points win.
function graphSegment(graph, a, b, maxSnap) {
  const { coords, adj } = graph;
  const SNAP_PENALTY = 3;
  const sources = [];
  const targets = new Map(); // key -> exit cost
  for (const [k, p] of coords) {
    const da = dist(p, a);
    const db = dist(p, b);
    if (da <= maxSnap) sources.push({ k, cost: da * SNAP_PENALTY });
    if (db <= maxSnap) targets.set(k, db * SNAP_PENALTY);
  }
  if (!sources.length || !targets.size) return null;

  const cost = new Map();
  const prev = new Map();
  // Simple binary heap.
  const heap = [];
  const push = (item) => {
    heap.push(item);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p].c <= heap[i].c) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && heap[l].c < heap[m].c) m = l;
        if (r < heap.length && heap[r].c < heap[m].c) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };

  for (const s of sources) {
    cost.set(s.k, s.cost);
    push({ k: s.k, c: s.cost });
  }
  const limit = 4 * Math.max(200, dist(a, b)) + maxSnap * 2 * SNAP_PENALTY;
  while (heap.length) {
    const { k, c } = pop();
    if (c > (cost.get(k) ?? Infinity)) continue;
    if (c > limit) break;
    for (const { to, w } of adj.get(k) ?? []) {
      const nc = c + w;
      if (nc < (cost.get(to) ?? Infinity)) {
        cost.set(to, nc);
        prev.set(to, k);
        push({ k: to, c: nc });
      }
    }
  }

  let bestKey = null;
  let bestTotal = Infinity;
  for (const [k, exitCost] of targets) {
    const c = cost.get(k);
    if (c !== undefined && c + exitCost < bestTotal) {
      bestTotal = c + exitCost;
      bestKey = k;
    }
  }
  if (bestKey === null) return null;
  const path = [];
  for (let k = bestKey; k !== undefined; k = prev.get(k)) path.push(coords.get(k));
  path.reverse();
  if (path.length < 2) return null;
  if (polyLength(path) > 4 * Math.max(200, dist(a, b))) return null;
  return path;
}

// ── output helpers ───────────────────────────────────────────────────────────
const round5 = (n) => Math.round(n * 1e5) / 1e5;
const roundCoords = (pts) => {
  const out = [];
  for (const [lon, lat] of pts) {
    const p = [round5(lon), round5(lat)];
    const last = out[out.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
  }
  return out;
};

// ── main ─────────────────────────────────────────────────────────────────────
mkdirSync(CACHE, { recursive: true });
const MAX_SNAP_M = 250;
const MAX_SNAP_RELAXED_M = 400; // some tube stop coords are street-level entrances
const report = [];

for (const line of TARGET_LINES) {
  const row = { id: line.id, ways: 0, stitched: 0, osm: 0, graph: 0, tfl: 0, note: '' };
  report.push(row);

  let fetched;
  try {
    fetched = await fetchOverpass(line);
  } catch (e) {
    row.note = `fetch failed: ${e.message}; TfL data kept`;
    console.warn(`  ! ${line.id}: ${row.note}`);
    continue;
  }
  if (!fetched.fromCache) await sleep(4000); // be nice to Overpass

  // Dedup ways by OSM id (same way appears in several directional relations).
  const wayById = new Map();
  for (const el of fetched.data.elements ?? []) {
    if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;
    wayById.set(el.id, el.geometry.map((g) => [g.lon, g.lat]));
  }
  const ways = [...wayById.values()];
  row.ways = ways.length;
  if (!ways.length) {
    row.note = 'no OSM ways matched; TfL data kept';
    console.warn(`  ! ${line.id}: ${row.note}`);
    continue;
  }

  const chains = stitchWays(ways);
  row.stitched = chains.length;
  const graph = buildGraph(ways);

  const branchesFile = JSON.parse(readFileSync(join(DATA, 'branches', `${line.id}.json`), 'utf8'));
  const newBranches = branchesFile.branches.map((br) => {
    const segments = [];
    for (let i = 0; i < br.stops.length - 1; i++) {
      const a = [br.stops[i].lon, br.stops[i].lat];
      const b = [br.stops[i + 1].lon, br.stops[i + 1].lat];
      let seg = trackSegment(chains, a, b, MAX_SNAP_M) ?? trackSegment(chains, a, b, MAX_SNAP_RELAXED_M);
      if (seg) {
        row.osm++;
      } else {
        seg = graphSegment(graph, a, b, MAX_SNAP_RELAXED_M);
        if (seg) row.graph++;
      }
      if (seg) {
        segments.push(roundCoords(seg));
      } else {
        segments.push(br.segments[i]); // keep existing TfL segment, never a chord
        row.tfl++;
      }
    }
    return { ...br, segments };
  });

  const linesFile = JSON.parse(readFileSync(join(DATA, 'lines', `${line.id}.json`), 'utf8'));
  const color = linesFile.features[0]?.properties?.color ?? '#888888';

  writeFileSync(
    join(DATA, 'branches', `${line.id}.json`),
    JSON.stringify({ ...branchesFile, branches: newBranches }),
  );
  writeFileSync(
    join(DATA, 'lines', `${line.id}.json`),
    JSON.stringify({
      type: 'FeatureCollection',
      features: chains.map((coords) => ({
        type: 'Feature',
        properties: { lineId: line.id, color },
        geometry: { type: 'LineString', coordinates: roundCoords(coords) },
      })),
    }),
  );
  const total = row.osm + row.graph + row.tfl;
  console.log(
    `✓ ${line.id}: ${row.ways} ways → ${row.stitched} polylines; ` +
      `segments osm=${row.osm} graph=${row.graph} keptTfL=${row.tfl} (${total} total)` +
      (fetched.fromCache ? ' [cache]' : ''),
  );
}

// ── report ───────────────────────────────────────────────────────────────────
console.log('\nline              ways  stitched  osm  graph  keptTfL  recut%');
for (const r of report) {
  const total = r.osm + r.graph + r.tfl;
  const pct = total ? (((r.osm + r.graph) / total) * 100).toFixed(1) : '-';
  console.log(
    `${r.id.padEnd(17)} ${String(r.ways).padStart(4)}  ${String(r.stitched).padStart(8)}  ` +
      `${String(r.osm).padStart(3)}  ${String(r.graph).padStart(5)}  ${String(r.tfl).padStart(7)}  ${String(pct).padStart(6)}` +
      (r.note ? `  ${r.note}` : ''),
  );
}
