// Bake TfL route geometry + per-branch stop/segment data into data/.
// Run once (or after network changes):  node scripts/bake-routes.mjs
// Reads TFL_APP_KEY from backend/.env. ~38 requests total (19 lines x 2 directions).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');

const env = Object.fromEntries(
  readFileSync(join(ROOT, 'backend/.env'), 'utf8')
    .split('\n')
    .filter((l) => l.includes('='))
    .map((l) => l.split('=', 2)),
);
const KEY = env.TFL_APP_KEY;
if (!KEY) throw new Error('TFL_APP_KEY missing from backend/.env');

// Official TfL line colours (post-2024 Overground naming).
const LINES = [
  { id: 'bakerloo', name: 'Bakerloo', mode: 'tube', color: '#B36305' },
  { id: 'central', name: 'Central', mode: 'tube', color: '#E32017' },
  { id: 'circle', name: 'Circle', mode: 'tube', color: '#FFD300' },
  { id: 'district', name: 'District', mode: 'tube', color: '#00782A' },
  { id: 'hammersmith-city', name: 'Hammersmith & City', mode: 'tube', color: '#F3A9BB' },
  { id: 'jubilee', name: 'Jubilee', mode: 'tube', color: '#A0A5A9' },
  { id: 'metropolitan', name: 'Metropolitan', mode: 'tube', color: '#9B0056' },
  // Official black; a light casing in the frontend keeps it readable on the dark basemap.
  { id: 'northern', name: 'Northern', mode: 'tube', color: '#000000' },
  { id: 'piccadilly', name: 'Piccadilly', mode: 'tube', color: '#003688' },
  { id: 'victoria', name: 'Victoria', mode: 'tube', color: '#0098D4' },
  { id: 'waterloo-city', name: 'Waterloo & City', mode: 'tube', color: '#95CDBA' },
  { id: 'dlr', name: 'DLR', mode: 'dlr', color: '#00A4A7' },
  { id: 'elizabeth', name: 'Elizabeth line', mode: 'elizabeth-line', color: '#6950A1' },
  { id: 'liberty', name: 'Liberty', mode: 'overground', color: '#5D6061' },
  { id: 'lioness', name: 'Lioness', mode: 'overground', color: '#FAA61A' },
  { id: 'mildmay', name: 'Mildmay', mode: 'overground', color: '#0077AD' },
  { id: 'suffragette', name: 'Suffragette', mode: 'overground', color: '#5BBD72' },
  { id: 'weaver', name: 'Weaver', mode: 'overground', color: '#823A62' },
  { id: 'windrush', name: 'Windrush', mode: 'overground', color: '#ED7158' },
  // Thames river services (Uber Boat by Thames Clippers + Woolwich Ferry).
  { id: 'rb1', name: 'RB1', mode: 'river-bus', color: '#2EB4E9' },
  { id: 'rb4', name: 'RB4', mode: 'river-bus', color: '#61C29D' },
  { id: 'rb6', name: 'RB6', mode: 'river-bus', color: '#EC7DA8' },
  { id: 'woolwich-ferry', name: 'Woolwich Ferry', mode: 'river-bus', color: '#F7B58C' },
];

// Optional CLI filter:  node scripts/bake-routes.mjs rb1 rb4 …  re-bakes only those.
const only = process.argv.slice(2);
const TARGET_LINES = only.length ? LINES.filter((l) => only.includes(l.id)) : LINES;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tfl(path) {
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`https://api.tfl.gov.uk${path}${sep}app_key=${KEY}`);
  if (!res.ok) throw new Error(`TfL ${res.status} for ${path}`);
  return res.json();
}

// ── planar geometry helpers (equirectangular approx is fine at London scale) ──
const M_PER_DEG_LAT = 110540;
const M_PER_DEG_LON = 111320 * Math.cos((51.5 * Math.PI) / 180);
const toXY = ([lon, lat]) => [lon * M_PER_DEG_LON, lat * M_PER_DEG_LAT];
const dist = (a, b) => {
  const [ax, ay] = toXY(a);
  const [bx, by] = toXY(b);
  return Math.hypot(ax - bx, ay - by);
};

// Nearest point on polyline: returns { d: distance m, arc: arc-length m, seg, t }
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

// Extract sub-polyline between two arc-length positions (handles reversal).
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

const MAX_SNAP_M = 250; // stop must sit this close to a polyline to snap onto it

// Best sub-polyline connecting two stops across all polylines; null if none fits.
function trackSegment(polylines, a, b, maxSnapM = MAX_SNAP_M) {
  let best = null;
  for (const poly of polylines) {
    const pa = projectOnto(poly, a);
    const pb = projectOnto(poly, b);
    if (!pa || !pb) continue;
    const worst = Math.max(pa.d, pb.d);
    if (worst > maxSnapM) continue;
    const pathLen = Math.abs(pb.arc - pa.arc);
    if (pathLen < 1) continue; // both snapped to the same spot — wrong polyline
    // Prefer close snaps; reject absurd detours (path >4x straight-line distance)
    // — except on the meandering Thames, where a real leg can loop far around.
    const detourCap = maxSnapM > MAX_SNAP_M ? 8 : 4;
    if (pathLen > detourCap * Math.max(200, dist(a, b))) continue;
    if (!best || worst < best.worst) best = { worst, poly, pa, pb };
  }
  if (!best) return null;
  return subPolyline(best.poly, best.pa, best.pb);
}

const round5 = (n) => Math.round(n * 1e5) / 1e5;
const roundCoords = (pts) => pts.map(([lon, lat]) => [round5(lon), round5(lat)]);

mkdirSync(join(DATA, 'lines'), { recursive: true });
mkdirSync(join(DATA, 'stations'), { recursive: true });
mkdirSync(join(DATA, 'branches'), { recursive: true });
mkdirSync(join(DATA, 'osm-cache'), { recursive: true });

// ── Thames centreline from OSM (TfL river-bus geometry is pier-to-pier chords) ──
const RIVER_SNAP_M = 600; // piers sit on the bank, well off the centreline
const THAMES_CACHE = join(DATA, 'osm-cache', 'thames.json');

function stitchWays(ways) {
  // Greedy chain-joining on shared endpoints (coords rounded for keying).
  const key = ([lon, lat]) => `${lon.toFixed(6)},${lat.toFixed(6)}`;
  const chains = ways.map((w) => [...w]);
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < chains.length; i++) {
      for (let j = i + 1; j < chains.length; j++) {
        const a = chains[i];
        const b = chains[j];
        let joined = null;
        if (key(a[a.length - 1]) === key(b[0])) joined = a.concat(b.slice(1));
        else if (key(b[b.length - 1]) === key(a[0])) joined = b.concat(a.slice(1));
        else if (key(a[a.length - 1]) === key(b[b.length - 1]))
          joined = a.concat([...b].reverse().slice(1));
        else if (key(a[0]) === key(b[0])) joined = [...a].reverse().concat(b.slice(1));
        if (joined) {
          chains[i] = joined;
          chains.splice(j, 1);
          merged = true;
          break outer;
        }
      }
    }
  }
  return chains;
}

async function thamesPolylines() {
  let elements;
  try {
    elements = JSON.parse(readFileSync(THAMES_CACHE, 'utf8')).elements;
  } catch {
    const query = `[out:json][timeout:60];
      way["waterway"="river"]["name"="River Thames"](51.2,-0.7,51.6,0.5);
      out geom;`;
    const res = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(query),
    });
    if (!res.ok) throw new Error(`Overpass ${res.status}`);
    const json = await res.json();
    writeFileSync(THAMES_CACHE, JSON.stringify(json));
    elements = json.elements;
  }
  const ways = elements
    .filter((e) => e.type === 'way' && Array.isArray(e.geometry))
    .map((e) => e.geometry.map((g) => [g.lon, g.lat]));
  const chains = stitchWays(ways).filter((c) => c.length >= 2);
  chains.sort((a, b) => polyLen(b) - polyLen(a));
  return chains;
}

function polyLen(poly) {
  let len = 0;
  for (let i = 0; i < poly.length - 1; i++) len += dist(poly[i], poly[i + 1]);
  return len;
}

// ── smooth pier approaches ──────────────────────────────────────────────
// A boat leaves the centreline early and sweeps into the pier on an arc. We
// trim DOCK_TRIM_M off each end of the centreline sub-path and replace it with
// a quadratic Bézier whose control point is the trimmed-off centreline foot —
// giving a tangent-ish blend from sailing line to berth.
const DOCK_TRIM_M = 140;
const BEZIER_STEPS = 10;

function quadBezier(p0, c, p1) {
  const pts = [];
  for (let i = 0; i <= BEZIER_STEPS; i++) {
    const t = i / BEZIER_STEPS;
    const u = 1 - t;
    pts.push([
      u * u * p0[0] + 2 * u * t * c[0] + t * t * p1[0],
      u * u * p0[1] + 2 * u * t * c[1] + t * t * p1[1],
    ]);
  }
  return pts;
}

/** Point at arc-length `target` metres along poly, plus the following index. */
function pointAtArc(poly, target) {
  let acc = 0;
  for (let i = 0; i < poly.length - 1; i++) {
    const seg = dist(poly[i], poly[i + 1]);
    if (acc + seg >= target) {
      const t = seg === 0 ? 0 : (target - acc) / seg;
      return {
        point: [
          poly[i][0] + (poly[i + 1][0] - poly[i][0]) * t,
          poly[i][1] + (poly[i + 1][1] - poly[i][1]) * t,
        ],
        nextIndex: i + 1,
      };
    }
    acc += seg;
  }
  return { point: poly[poly.length - 1], nextIndex: poly.length - 1 };
}

function withDockingCurves(pierA, pierB, centreline) {
  const total = polyLen(centreline);
  const trim = Math.min(DOCK_TRIM_M, total / 3);
  const entry = pointAtArc(centreline, trim);
  const exit = pointAtArc(centreline, total - trim);
  if (exit.nextIndex <= entry.nextIndex) {
    // path too short for curves — fall back to simple legs
    return [pierA, ...centreline, pierB];
  }
  const middle = centreline.slice(entry.nextIndex, exit.nextIndex);
  const approach = quadBezier(pierA, centreline[0], entry.point);
  const departure = quadBezier(exit.point, centreline[centreline.length - 1], pierB);
  return [...approach, ...middle, ...departure];
}

const stats = { lines: 0, branches: 0, segments: 0, fallbacks: 0 };

for (const line of TARGET_LINES) {
  const polylines = [];
  const seen = new Set();
  const branches = [];
  const stationById = new Map();

  for (const direction of ['outbound', 'inbound']) {
    let seq;
    try {
      seq = await tfl(`/Line/${line.id}/Route/Sequence/${direction}?excludeCrowding=true`);
    } catch (e) {
      console.warn(`  ! ${line.id}/${direction}: ${e.message}`);
      continue;
    }
    for (const ls of seq.lineStrings ?? []) {
      const parsed = JSON.parse(ls); // [[ [lon,lat], ... ]]
      for (const coords of parsed) {
        const key = JSON.stringify([coords[0], coords[coords.length - 1], coords.length]);
        if (seen.has(key) || coords.length < 2) continue;
        seen.add(key);
        polylines.push(coords);
      }
    }
    for (const sps of seq.stopPointSequences ?? []) {
      const stops = sps.stopPoint.map((s) => ({
        id: s.id,
        name: s.name.replace(/ (Underground|Rail|DLR) Station$/, ''),
        lon: round5(s.lon),
        lat: round5(s.lat),
      }));
      if (stops.length < 2) continue;
      branches.push({ branchId: sps.branchId, direction, stops });
      for (const s of stops) stationById.set(s.id, s);
    }
    await sleep(150);
  }

  // Per-branch inter-stop track segments (fallback: straight line between stops).
  // River-bus legs are cut along the OSM Thames centreline — TfL's own river
  // geometry is pier-to-pier chords that slice straight across the city.
  const isRiver = line.mode === 'river-bus' && line.id !== 'woolwich-ferry';
  const segPolylines = isRiver ? await thamesPolylines() : polylines;
  const snap = isRiver ? RIVER_SNAP_M : MAX_SNAP_M;
  for (const br of branches) {
    br.segments = [];
    for (let i = 0; i < br.stops.length - 1; i++) {
      const a = [br.stops[i].lon, br.stops[i].lat];
      const b = [br.stops[i + 1].lon, br.stops[i + 1].lat];
      const seg = trackSegment(segPolylines, a, b, snap);
      if (seg) {
        // Piers sit on the bank while the sailing line follows the mid-river
        // centreline: blend in smooth curved approach/departure legs so the
        // route sweeps into the pier instead of turning at right angles.
        const withDocking = isRiver ? withDockingCurves(a, b, seg) : seg;
        br.segments.push(roundCoords(withDocking));
      } else {
        br.segments.push([a, b]);
        stats.fallbacks++;
      }
      stats.segments++;
    }
    stats.branches++;
  }

  // Draw river routes from their river-following segments, not the TfL chords.
  if (isRiver) {
    const uniq = new Map();
    for (const br of branches) {
      for (const seg of br.segments) {
        uniq.set(JSON.stringify([seg[0], seg[seg.length - 1], seg.length]), seg);
      }
    }
    polylines.length = 0;
    polylines.push(...uniq.values());
  }

  writeFileSync(
    join(DATA, 'lines', `${line.id}.json`),
    JSON.stringify({
      type: 'FeatureCollection',
      features: polylines.map((coords) => ({
        type: 'Feature',
        properties: { lineId: line.id, color: line.displayColor ?? line.color },
        geometry: { type: 'LineString', coordinates: roundCoords(coords) },
      })),
    }),
  );
  writeFileSync(
    join(DATA, 'stations', `${line.id}.json`),
    JSON.stringify({
      type: 'FeatureCollection',
      features: [...stationById.values()].map((s) => ({
        type: 'Feature',
        properties: { id: s.id, name: s.name, lineId: line.id },
        geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
      })),
    }),
  );
  writeFileSync(
    join(DATA, 'branches', `${line.id}.json`),
    JSON.stringify({ lineId: line.id, branches }),
  );
  stats.lines++;
  console.log(`✓ ${line.id}: ${polylines.length} polylines, ${branches.length} branches`);
}

writeFileSync(
  join(DATA, 'manifest.json'),
  JSON.stringify({ generatedAt: new Date().toISOString(), lines: LINES }, null, 2),
);
console.log('done:', JSON.stringify(stats));
