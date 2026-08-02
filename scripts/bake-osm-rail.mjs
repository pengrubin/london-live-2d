// Bake rail lines and stations for a region straight from OpenStreetMap.
//
// Usage:  node scripts/bake-osm-rail.mjs <region> [--out data/<region>] [--refresh]
//         node scripts/bake-osm-rail.mjs dubai
//
// Emits the same three files the London pipeline produces, so the frontend
// renders both identically:
//   <out>/manifest.json          {generatedAt, lines:[{id,name,mode,color}]}
//   <out>/lines/<id>.json        FeatureCollection<LineString>  {lineId,color}
//   <out>/stations/<id>.json     FeatureCollection<Point>       {id,name,lineId}
//
// NOT to be confused with scripts/bake-osm-geometry.mjs, which REFINES existing
// TfL geometry and needs a TfL-authored stop list to snap to. This one builds
// from OSM alone, which is the only option where no operator publishes a feed.
//
// The line catalogue lives in scripts/regions/<region>.mjs — see that file for
// why relation ids are pinned rather than discovered.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
/**
 * Overpass is a free shared service that answers 429 and 504 under load, often
 * on both mirrors at once. This baker runs rarely and its results are cached,
 * so patience costs nothing and impatience costs a failed run: the ladder below
 * spans about twelve minutes per query.
 */
const RETRY_DELAYS_MS = [0, 5_000, 15_000, 30_000, 60_000, 120_000, 240_000, 240_000];
const REQUEST_SPACING_MS = 2_000;
const USER_AGENT = 'london-live-2d rail baker (github.com/pengrubin/london-live-2d)';
/** Coordinates are rounded to this many decimals (~1 m) to keep payloads small. */
const COORD_DECIMALS = 5;
/** Relation member roles that carry the running line, unless a line overrides it. */
const DEFAULT_WAY_ROLES = [''];
/** Relation member roles that mark a calling point. */
const STOP_ROLES = new Set(['stop', 'stop_entry_only', 'stop_exit_only']);

// ── plumbing ────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  const positional = argv.filter((a) => !a.startsWith('--'));
  const region = positional[0];
  if (!region) {
    throw new Error('Usage: node scripts/bake-osm-rail.mjs <region> [--out <dir>] [--refresh]');
  }
  const outFlag = argv.indexOf('--out');
  return {
    region,
    outDir: join(ROOT, outFlag === -1 ? join('data', region) : argv[outFlag + 1]),
    refresh: argv.includes('--refresh'),
  };
}

/** Posts one Overpass query, retrying across both endpoints. Never partial. */
async function overpass(query, label, cachePath, refresh) {
  if (!refresh && cachePath && existsSync(cachePath)) {
    return JSON.parse(readFileSync(cachePath, 'utf8'));
  }
  let lastError;
  for (const [attempt, delay] of RETRY_DELAYS_MS.entries()) {
    if (delay) {
      console.log(`  retrying ${label} in ${delay / 1000}s (attempt ${attempt + 1})`);
      await sleep(delay);
    }
    const url = OVERPASS_URLS[attempt % OVERPASS_URLS.length];
    try {
      // The User-Agent is load-bearing: overpass-api.de answers 406 to Node's
      // default fetch agent regardless of body or content type. Identifying the
      // client is also what Overpass asks of anyone using the free instances.
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'user-agent': USER_AGENT },
        body: query,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      // Overpass reports runtime errors inside a 200 body.
      if (text.includes('runtime error') || text.includes('Dispatcher_Client')) {
        throw new Error(text.slice(0, 200));
      }
      const data = JSON.parse(text);
      if (cachePath) {
        mkdirSync(dirname(cachePath), { recursive: true });
        writeFileSync(cachePath, JSON.stringify(data));
      }
      await sleep(REQUEST_SPACING_MS); // be a polite client
      return data;
    } catch (error) {
      lastError = error;
      console.warn(`  ${label} failed on ${new URL(url).host}: ${String(error).slice(0, 120)}`);
    }
  }
  throw new Error(`Overpass exhausted all retries for ${label}: ${String(lastError)}`);
}

const round = (n) => Number(n.toFixed(COORD_DECIMALS));

// ── geometry ────────────────────────────────────────────────────────────────

/**
 * Joins a relation's member ways into one polyline.
 *
 * Member ways are stored in route order but NOT in a consistent direction —
 * measured across Dubai's nine rail relations, seven store the FIRST way
 * reversed. Taking way[0] as-is and appending from its last node fabricates a
 * gap in four of them (two of which break at every single joint), so the first
 * way's orientation is resolved against the second before anything is appended.
 */
function stitch(wayNodeLists) {
  const lists = wayNodeLists.filter((nodes) => nodes.length >= 2);
  if (lists.length === 0) return { chain: [], gaps: [] };
  if (lists.length === 1) return { chain: [...lists[0]], gaps: [] };

  const [first, second] = lists;
  const secondEnds = new Set([second[0], second[second.length - 1]]);
  // The first way's tail must touch the second way; if its head does instead,
  // the way is stored backwards relative to the route.
  const chain = secondEnds.has(first[first.length - 1]) ? [...first] : [...first].reverse();

  const gaps = [];
  for (let i = 1; i < lists.length; i += 1) {
    const way = lists[i];
    const tail = chain[chain.length - 1];
    let next;
    if (way[0] === tail) next = way;
    else if (way[way.length - 1] === tail) next = [...way].reverse();
    else {
      gaps.push(i);
      continue; // a genuine break in mapping — skip rather than draw a chord
    }
    chain.push(...next.slice(1)); // shared node appears once
  }
  return { chain, gaps };
}

/** True when every coordinate lies inside the region's declared bounds. */
function withinBbox(coords, bbox) {
  return coords.every(
    ([lon, lat]) =>
      lon >= bbox.minLon && lon <= bbox.maxLon && lat >= bbox.minLat && lat <= bbox.maxLat,
  );
}

// ── OSM extraction ──────────────────────────────────────────────────────────

function indexElements(data) {
  const relations = new Map();
  const ways = new Map();
  const nodes = new Map();
  for (const element of data.elements ?? []) {
    if (element.type === 'relation') relations.set(element.id, element);
    else if (element.type === 'way') ways.set(element.id, element);
    else if (element.type === 'node') nodes.set(element.id, element);
  }
  return { relations, ways, nodes };
}

const relationQuery = (id) => `[out:json][timeout:120];rel(${id});out body;>;out body;`;

/**
 * Builds one line's geometry. Later relations contribute only the ways earlier
 * ones did not use, which is how a branched line (Dubai's Red) draws its shared
 * trunk exactly once.
 */
async function bakeLineGeometry(line, cacheDir, refresh) {
  const roles = new Set(line.wayRoles ?? DEFAULT_WAY_ROLES);
  const usedWayIds = new Set();
  const parts = [];
  const stopNodeIds = [];

  for (const relationRef of line.relations) {
    const cachePath = join(cacheDir, `rel-${relationRef.id}.json`);
    const data = await overpass(
      relationQuery(relationRef.id),
      `relation ${relationRef.id} (${relationRef.note})`,
      cachePath,
      refresh,
    );
    const { relations, ways, nodes } = indexElements(data);
    const relation = relations.get(relationRef.id);
    if (!relation) throw new Error(`relation ${relationRef.id} not returned by Overpass`);

    for (const member of relation.members ?? []) {
      if (member.type === 'node' && STOP_ROLES.has(member.role)) stopNodeIds.push(member.ref);
    }

    const fresh = (relation.members ?? [])
      .filter((m) => m.type === 'way' && roles.has(m.role ?? ''))
      .filter((m) => !usedWayIds.has(m.ref))
      .map((m) => {
        usedWayIds.add(m.ref);
        return ways.get(m.ref)?.nodes ?? [];
      });

    const missing = fresh.filter((n) => n.length === 0).length;
    if (missing) console.warn(`  ! ${line.id}: ${missing} member ways had no geometry`);

    const { chain, gaps } = stitch(fresh);
    if (gaps.length) {
      console.warn(`  ! ${line.id}: ${gaps.length} gap(s) in relation ${relationRef.id}; skipped`);
    }
    const coords = chain
      .map((nodeId) => nodes.get(nodeId))
      .filter(Boolean)
      .map((n) => [round(n.lon), round(n.lat)]);
    if (coords.length >= 2) parts.push(coords);

    // Node tags come back on this same query; keep them for the stop fallback.
    for (const id of stopNodeIds) {
      const node = nodes.get(id);
      if (node) STOP_NODE_CACHE.set(id, node);
    }
  }

  return { parts, stopNodeIds: [...new Set(stopNodeIds)] };
}

/** Stop nodes accumulated while walking relations, reused for the fallback. */
const STOP_NODE_CACHE = new Map();

const stopAreaQuery = (ids) =>
  `[out:json][timeout:120];` +
  `node(id:${ids.join(',')})->.stops;` +
  `rel(bn.stops)["public_transport"="stop_area"]->.areas;` +
  `.areas out body;` +
  `node(r.areas)["railway"="station"];out body;`;

/**
 * Resolves per-direction stop positions to one marker per physical station.
 *
 * Every calling point is mapped twice — once per direction — and the two node
 * ids never coincide, so the obvious key gives two dots per station. The
 * `public_transport=stop_area` relation is what ties them together, and its
 * `railway=station` member is the stable per-station id.
 *
 * Not every station has one: Dubai's tram has none at all and four Palm stops
 * lack them, so anything unresolved falls back to deduplicating by name.
 */
async function resolveStations(line, stopNodeIds, cacheDir, refresh) {
  if (stopNodeIds.length === 0) return [];
  const cachePath = join(cacheDir, `stops-${line.id}.json`);
  const data = await overpass(
    stopAreaQuery(stopNodeIds),
    `stop areas for ${line.id}`,
    cachePath,
    refresh,
  );
  const { relations: areas, nodes } = indexElements(data);

  const stationByStop = new Map();
  for (const area of areas.values()) {
    const members = area.members ?? [];
    const stationMember = members.find((m) => m.type === 'node' && nodes.has(m.ref));
    if (!stationMember) continue;
    for (const member of members) {
      if (member.type === 'node') stationByStop.set(member.ref, nodes.get(stationMember.ref));
    }
  }

  const displayName = (tags = {}) => tags['name:en'] ?? tags.name ?? tags['name:ar'] ?? 'Station';
  const out = new Map();
  const seenNames = new Set();

  for (const stopId of stopNodeIds) {
    const station = stationByStop.get(stopId);
    if (station) {
      // Stable identity: one railway=station node per physical station.
      if (!out.has(station.id)) {
        out.set(station.id, {
          id: `osm:${station.id}`,
          name: displayName(station.tags),
          lon: round(station.lon),
          lat: round(station.lat),
        });
        seenNames.add(displayName(station.tags).toLowerCase());
      }
      continue;
    }
    // Fallback: no station node (all tram stops, four Palm stops). Two
    // direction-specific stop positions share a name; keep the first.
    const node = STOP_NODE_CACHE.get(stopId);
    if (!node) continue;
    const name = displayName(node.tags);
    const key = name.toLowerCase();
    if (seenNames.has(key)) continue;
    seenNames.add(key);
    out.set(`stop:${node.id}`, {
      id: `osm:${node.id}`,
      name,
      lon: round(node.lon),
      lat: round(node.lat),
    });
  }
  return [...out.values()];
}

// ── output ──────────────────────────────────────────────────────────────────

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

async function main() {
  const { region, outDir, refresh } = parseArgs(process.argv.slice(2));
  const configPath = join(ROOT, 'scripts', 'regions', `${region}.mjs`);
  if (!existsSync(configPath)) throw new Error(`No catalogue at scripts/regions/${region}.mjs`);
  const config = (await import(configPath)).default;
  const cacheDir = join(ROOT, 'data', 'osm-cache', region);

  console.log(`Baking ${config.name} from OpenStreetMap → ${outDir}`);
  const manifestLines = [];

  for (const line of config.lines) {
    console.log(`\n${line.id} (${line.name})`);
    const { parts, stopNodeIds } = await bakeLineGeometry(line, cacheDir, refresh);
    const coordCount = parts.reduce((sum, p) => sum + p.length, 0);
    if (parts.length === 0) throw new Error(`${line.id}: produced no geometry`);
    for (const part of parts) {
      if (!withinBbox(part, config.bbox)) {
        throw new Error(`${line.id}: geometry escapes the region bbox — wrong relation?`);
      }
    }
    console.log(`  geometry: ${parts.length} part(s), ${coordCount} coordinates`);

    writeJson(join(outDir, 'lines', `${line.id}.json`), {
      type: 'FeatureCollection',
      features: parts.map((coordinates) => ({
        type: 'Feature',
        properties: { lineId: line.id, color: line.color },
        geometry: { type: 'LineString', coordinates },
      })),
    });

    const stations = await resolveStations(line, stopNodeIds, cacheDir, refresh);
    console.log(`  stations: ${stations.length} (from ${stopNodeIds.length} stop positions)`);
    writeJson(join(outDir, 'stations', `${line.id}.json`), {
      type: 'FeatureCollection',
      features: stations.map((s) => ({
        type: 'Feature',
        properties: { id: s.id, name: s.name, lineId: line.id },
        geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
      })),
    });

    manifestLines.push({ id: line.id, name: line.name, mode: line.mode, color: line.color });
  }

  writeJson(join(outDir, 'manifest.json'), {
    generatedAt: new Date().toISOString(),
    lines: manifestLines,
  });
  console.log(`\nWrote manifest with ${manifestLines.length} lines to ${outDir}`);
}

main().catch((error) => {
  console.error(`Fatal: ${error.message}`);
  process.exit(1);
});
