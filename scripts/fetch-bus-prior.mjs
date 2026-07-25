#!/usr/bin/env node
// Fetch BODS timetable data for Greater London and bake per-line route priors.
//
// Why per-operator, not bulk: the BODS bulk timetable archive is ~1.7 GB and
// TfL (OperatorRef TFLO, ~94 % of London vehicles) does not publish timetables
// to BODS at all — so we page the dataset API for Greater London (adminArea
// 490), download each published per-operator zip (byte-capped), parse the
// TransXChange inside, and emit priors for whatever lines that covers.
// Lines with no prior (the whole TfL fleet) are handled by the learner's
// trace-only fallback — the pipeline works with zero priors.
//
// Output: <base>/bus-routes/prior/<sanitized OPERATOR:line:direction>.json
//   { poly: [[lon,lat],…], stops: [[lon,lat],…] }
// plus a .fetched.json freshness stamp the backend scheduler checks.
//
// Fully unattended: any dataset/parse failure is skipped and counted; the
// script always exits 0 with a one-line JSON summary on stdout.

import { readFileSync, existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
// Base dir pinned by the backend scheduler (BUS_DATA_DIR) to the same base the
// trace writer + learner use — the PERSIST_DIR volume in production, else data/
// — so priors land where the learner reads them. Falls back to repo data/.
const BASE_DIR = process.env.BUS_DATA_DIR ?? join(ROOT, 'data');
const PRIOR_DIR = process.env.BUS_PRIOR_DIR ?? join(BASE_DIR, 'bus-routes', 'prior');
const ENV_PATH = join(ROOT, 'backend', '.env');

const API_BASE = 'https://data.bus-data.dft.gov.uk/api/v1/dataset/';
const LONDON_ADMIN_AREA = '490'; // ATCO area: Greater London
const PAGE_LIMIT = 25;
const MAX_TOTAL_DOWNLOAD_BYTES = 300 * 1024 * 1024;
const MAX_DATASET_BYTES = 40 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 120_000;
/** Ignore datasets whose timetable validity ended more than this long ago. */
const EXPIRED_GRACE_MS = 90 * 24 * 60 * 60_000;

function readApiKey() {
  if (process.env.BODS_API_KEY) return process.env.BODS_API_KEY;
  if (!existsSync(ENV_PATH)) return undefined;
  for (const line of readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const m = /^\s*BODS_API_KEY\s*=\s*(.+?)\s*$/.exec(line);
    if (m) return m[1].replace(/^(["'])(.*)\1$/, '$2');
  }
  return undefined;
}

/** Must match backend/frontend: key → safe filename. */
function sanitizeKey(key) {
  return key.replace(/[^A-Za-z0-9_.-]/g, '_');
}

/** TfL publishes "1"/"2"; TXC uses words. Keep in sync with bods-client. */
function normalizeDirection(raw) {
  const dir = String(raw ?? '').trim().toLowerCase();
  if (dir === '') return 'unknown';
  if (dir === '1') return 'outbound';
  if (dir === '2') return 'inbound';
  return dir;
}

// ── minimal zip reader (central directory + inflateRaw; no zip64) ──────────

function listZipEntries(buf) {
  let i = buf.length - 22;
  const lowest = Math.max(0, buf.length - 22 - 65_536);
  while (i >= lowest && buf.readUInt32LE(i) !== 0x06054b50) i -= 1;
  if (i < lowest) throw new Error('zip: end-of-central-directory not found');
  const count = buf.readUInt16LE(i + 10);
  let off = buf.readUInt32LE(i + 16);
  const entries = [];
  for (let n = 0; n < count; n += 1) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    entries.push({ name, method, compSize, localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readZipEntry(buf, entry) {
  const lh = entry.localOff;
  if (buf.readUInt32LE(lh) !== 0x04034b50) throw new Error('zip: bad local header');
  const nameLen = buf.readUInt16LE(lh + 26);
  const extraLen = buf.readUInt16LE(lh + 28);
  const start = lh + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + entry.compSize);
  if (entry.method === 0) return raw;
  if (entry.method === 8) return zlib.inflateRawSync(raw);
  throw new Error(`zip: unsupported method ${entry.method}`);
}

// ── OSGB36 easting/northing → WGS84 lon/lat (for Track points without
//    a Translation block). Standard OS transverse-Mercator inverse + Helmert.

function osgbToWgs84(E, N) {
  const a = 6377563.396;
  const b = 6356256.909; // Airy 1830
  const F0 = 0.9996012717;
  const lat0 = (49 * Math.PI) / 180;
  const lon0 = (-2 * Math.PI) / 180;
  const N0 = -100000;
  const E0 = 400000;
  const e2 = 1 - (b * b) / (a * a);
  const n = (a - b) / (a + b);
  let lat = lat0;
  let M = 0;
  for (let k = 0; k < 20; k += 1) {
    lat = (N - N0 - M) / (a * F0) + lat;
    const dLat = lat - lat0;
    const sLat = lat + lat0;
    M =
      b *
      F0 *
      ((1 + n + (5 / 4) * n * n + (5 / 4) * n * n * n) * dLat -
        (3 * n + 3 * n * n + (21 / 8) * n * n * n) * Math.sin(dLat) * Math.cos(sLat) +
        ((15 / 8) * n * n + (15 / 8) * n * n * n) * Math.sin(2 * dLat) * Math.cos(2 * sLat) -
        (35 / 24) * n * n * n * Math.sin(3 * dLat) * Math.cos(3 * sLat));
    if (Math.abs(N - N0 - M) < 0.00001) break;
  }
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const tanLat = Math.tan(lat);
  const nu = (a * F0) / Math.sqrt(1 - e2 * sinLat * sinLat);
  const rho = (a * F0 * (1 - e2)) / Math.pow(1 - e2 * sinLat * sinLat, 1.5);
  const eta2 = nu / rho - 1;
  const VII = tanLat / (2 * rho * nu);
  const VIII =
    (tanLat / (24 * rho * nu ** 3)) * (5 + 3 * tanLat ** 2 + eta2 - 9 * tanLat ** 2 * eta2);
  const IX = (tanLat / (720 * rho * nu ** 5)) * (61 + 90 * tanLat ** 2 + 45 * tanLat ** 4);
  const X = 1 / (cosLat * nu);
  const XI = (1 / (cosLat * 6 * nu ** 3)) * (nu / rho + 2 * tanLat ** 2);
  const XII = (1 / (cosLat * 120 * nu ** 5)) * (5 + 28 * tanLat ** 2 + 24 * tanLat ** 4);
  const XIIA =
    (1 / (cosLat * 5040 * nu ** 7)) * (61 + 662 * tanLat ** 2 + 1320 * tanLat ** 4 + 720 * tanLat ** 6);
  const dE = E - E0;
  const latOsgb = lat - VII * dE ** 2 + VIII * dE ** 4 - IX * dE ** 6;
  const lonOsgb = lon0 + X * dE - XI * dE ** 3 + XII * dE ** 5 - XIIA * dE ** 7;
  // Helmert OSGB36 → WGS84 (≈5 m accuracy — plenty for a learning seed).
  const aW = 6378137;
  const e2W = 6.6943799901377997e-3;
  const H = 0;
  const sinP = Math.sin(latOsgb);
  const cosP = Math.cos(latOsgb);
  const sinL = Math.sin(lonOsgb);
  const cosL = Math.cos(lonOsgb);
  const e2A = 1 - (b * b) / (a * a);
  const nuA = a / Math.sqrt(1 - e2A * sinP * sinP);
  let x = (nuA + H) * cosP * cosL;
  let y = (nuA + H) * cosP * sinL;
  let z = ((1 - e2A) * nuA + H) * sinP;
  const tx = 446.448;
  const ty = -125.157;
  const tz = 542.06;
  const s = -20.4894e-6;
  const rx = (0.1502 / 3600) * (Math.PI / 180);
  const ry = (0.247 / 3600) * (Math.PI / 180);
  const rz = (0.8421 / 3600) * (Math.PI / 180);
  const x2 = tx + (1 + s) * x - rz * y + ry * z;
  const y2 = ty + rz * x + (1 + s) * y - rx * z;
  const z2 = tz - ry * x + rx * y + (1 + s) * z;
  const p = Math.sqrt(x2 * x2 + y2 * y2);
  let latW = Math.atan2(z2, p * (1 - e2W));
  for (let k = 0; k < 10; k += 1) {
    const nuW = aW / Math.sqrt(1 - e2W * Math.sin(latW) ** 2);
    latW = Math.atan2(z2 + e2W * nuW * Math.sin(latW), p);
  }
  return [(Math.atan2(y2, x2) * 180) / Math.PI, (latW * 180) / Math.PI];
}

// ── TransXChange parsing (string scans — files are a few MB of flat XML) ──

function blockContents(xml, tag) {
  const out = [];
  const open = `<${tag}`;
  const close = `</${tag}>`;
  let from = 0;
  for (;;) {
    const start = xml.indexOf(open, from);
    if (start === -1) break;
    const bodyStart = xml.indexOf('>', start);
    const end = xml.indexOf(close, bodyStart);
    if (bodyStart === -1 || end === -1) break;
    out.push({ head: xml.slice(start, bodyStart + 1), body: xml.slice(bodyStart + 1, end) });
    from = end + close.length;
  }
  return out;
}

function firstTag(xml, tag) {
  const open = `<${tag}>`;
  const start = xml.indexOf(open);
  if (start === -1) return '';
  const end = xml.indexOf(`</${tag}>`, start + open.length);
  if (end === -1) return '';
  return xml.slice(start + open.length, end).trim();
}

function attrOf(head, name) {
  const m = new RegExp(`${name}="([^"]*)"`).exec(head);
  return m ? m[1] : '';
}

/** [[lon,lat],…] from a chunk containing Longitude/Latitude or Easting/Northing pairs. */
function parseLocations(chunk) {
  const pts = [];
  const lonLat = /<Longitude>(-?[\d.]+)<\/Longitude>\s*<Latitude>(-?[\d.]+)<\/Latitude>/g;
  const latLon = /<Latitude>(-?[\d.]+)<\/Latitude>\s*<Longitude>(-?[\d.]+)<\/Longitude>/g;
  let m;
  while ((m = lonLat.exec(chunk)) !== null) pts.push([Number(m[1]), Number(m[2])]);
  if (pts.length === 0) {
    while ((m = latLon.exec(chunk)) !== null) pts.push([Number(m[2]), Number(m[1])]);
  }
  if (pts.length === 0) {
    const en = /<Easting>(-?[\d.]+)<\/Easting>\s*<Northing>(-?[\d.]+)<\/Northing>/g;
    while ((m = en.exec(chunk)) !== null) pts.push(osgbToWgs84(Number(m[1]), Number(m[2])));
  }
  return pts.filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
}

function pathLengthM(poly) {
  const mLat = 110_540;
  const mLon = 111_320 * Math.cos((51.5 * Math.PI) / 180);
  let total = 0;
  for (let i = 1; i < poly.length; i += 1) {
    total += Math.hypot((poly[i][0] - poly[i - 1][0]) * mLon, (poly[i][1] - poly[i - 1][1]) * mLat);
  }
  return total;
}

/** One TXC document → [{noc, line, direction, poly, stops}] */
function parseTransXChange(xml) {
  const nocs = [];
  for (const op of blockContents(xml, 'Operator')) {
    const noc = firstTag(op.body, 'NationalOperatorCode') || firstTag(op.body, 'OperatorCode');
    if (noc) nocs.push(noc);
  }
  if (nocs.length === 0) return [];

  // Stop locations by ref (AnnotatedStopPointRef may or may not carry one).
  const stopLoc = new Map();
  for (const sp of blockContents(xml, 'AnnotatedStopPointRef')) {
    const ref = firstTag(sp.body, 'StopPointRef');
    const pts = parseLocations(sp.body);
    if (ref && pts.length > 0) stopLoc.set(ref, pts[0]);
  }
  for (const sp of blockContents(xml, 'StopPoint')) {
    const ref = firstTag(sp.body, 'AtcoCode');
    const pts = parseLocations(sp.body);
    if (ref && pts.length > 0 && !stopLoc.has(ref)) stopLoc.set(ref, pts[0]);
  }

  // RouteSection id → {track, stopRefs} (from RouteLink From/To + Track).
  const sections = new Map();
  for (const rs of blockContents(xml, 'RouteSection')) {
    const id = attrOf(rs.head, 'id');
    const track = [];
    const stopRefs = [];
    for (const link of blockContents(rs.body, 'RouteLink')) {
      const from = /<From>[\s\S]*?<StopPointRef>([^<]+)<\/StopPointRef>[\s\S]*?<\/From>/.exec(link.body)?.[1];
      const to = /<To>[\s\S]*?<StopPointRef>([^<]+)<\/StopPointRef>[\s\S]*?<\/To>/.exec(link.body)?.[1];
      if (from && (stopRefs.length === 0 || stopRefs[stopRefs.length - 1] !== from)) {
        stopRefs.push(from);
      }
      if (to) stopRefs.push(to);
      for (const tb of blockContents(link.body, 'Track')) track.push(...parseLocations(tb.body));
    }
    if (id) sections.set(id, { track, stopRefs });
  }

  // Route id → ordered RouteSectionRefs.
  const routes = new Map();
  for (const r of blockContents(xml, 'Route')) {
    const id = attrOf(r.head, 'id');
    const refs = [...r.body.matchAll(/<RouteSectionRef>([^<]+)<\/RouteSectionRef>/g)].map((m) => m[1]);
    if (id) routes.set(id, refs);
  }

  // Line id → published name.
  const lineNames = new Map();
  for (const ln of blockContents(xml, 'Line')) {
    const id = attrOf(ln.head, 'id');
    const name = firstTag(ln.body, 'LineName');
    if (id && name) lineNames.set(id, name);
  }

  // Journey patterns: line (via the service's lines) + direction + route.
  const results = new Map(); // key → {poly, stops, lengthM}
  for (const svc of blockContents(xml, 'Service')) {
    const svcLineNames = [...blockContents(svc.body, 'Line')]
      .map((ln) => firstTag(ln.body, 'LineName'))
      .filter((n) => n !== '');
    const names = svcLineNames.length > 0 ? svcLineNames : [...lineNames.values()];
    for (const jp of blockContents(svc.body, 'JourneyPattern')) {
      const direction = normalizeDirection(firstTag(jp.body, 'Direction'));
      const routeRef = firstTag(jp.body, 'RouteRef');
      const sectionRefs = routes.get(routeRef) ?? [];
      const poly = [];
      const stopRefs = [];
      for (const ref of sectionRefs) {
        const section = sections.get(ref);
        if (!section) continue;
        poly.push(...section.track);
        stopRefs.push(...section.stopRefs);
      }
      const stops = [];
      for (const ref of stopRefs) {
        const loc = stopLoc.get(ref);
        if (loc && (stops.length === 0 || stops[stops.length - 1] !== loc)) stops.push(loc);
      }
      const usablePoly = poly.length >= 2 ? poly : stops;
      if (usablePoly.length < 2) continue;
      const lengthM = pathLengthM(usablePoly);
      for (const noc of nocs) {
        for (const name of names) {
          const key = `${noc}:${name}:${direction}`;
          const prev = results.get(key);
          // Longest variant wins — it is the fullest expression of the route.
          if (!prev || lengthM > prev.lengthM) results.set(key, { poly: usablePoly, stops, lengthM });
        }
      }
    }
  }
  return [...results.entries()].map(([key, v]) => ({ key, poly: v.poly, stops: v.stops }));
}

// ── dataset download loop ──────────────────────────────────────────────────

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function main() {
  const apiKey = readApiKey();
  const summary = {
    task: 'fetch-bus-prior',
    datasetsSeen: 0,
    datasetsDownloaded: 0,
    datasetsFailed: 0,
    bytesDownloaded: 0,
    priorsWritten: 0,
    note: '',
  };
  if (!apiKey) {
    summary.note = 'no BODS_API_KEY — skipped (learner will use trace-only seeds)';
    console.log(JSON.stringify(summary));
    return;
  }
  await mkdir(PRIOR_DIR, { recursive: true });

  // Page through Greater London timetable datasets.
  const datasets = [];
  let url = `${API_BASE}?adminArea=${LONDON_ADMIN_AREA}&status=published&limit=${PAGE_LIMIT}&api_key=${apiKey}`;
  for (let page = 0; page < 40 && url; page += 1) {
    let body;
    try {
      body = await fetchJson(url);
    } catch (err) {
      summary.note = `dataset listing failed: ${String(err)}`;
      break;
    }
    datasets.push(...(body.results ?? []));
    url = body.next ? `${body.next}&api_key=${apiKey}` : null;
  }
  summary.datasetsSeen = datasets.length;

  const now = Date.now();
  const fresh = datasets
    .filter((d) => {
      const end = Date.parse(d.lastEndDate ?? '');
      return !Number.isFinite(end) || end > now - EXPIRED_GRACE_MS;
    })
    .sort((a, b) => Date.parse(b.modified ?? 0) - Date.parse(a.modified ?? 0));

  const written = new Set();
  for (const ds of fresh) {
    if (summary.bytesDownloaded >= MAX_TOTAL_DOWNLOAD_BYTES) {
      summary.note += ' download budget reached;';
      break;
    }
    try {
      const res = await fetch(ds.url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_DATASET_BYTES) throw new Error(`too large (${buf.length} B)`);
      summary.bytesDownloaded += buf.length;
      summary.datasetsDownloaded += 1;

      const xmlDocs = [];
      if (buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50) {
        for (const entry of listZipEntries(buf)) {
          if (entry.name.toLowerCase().endsWith('.xml')) {
            xmlDocs.push(readZipEntry(buf, entry).toString('utf8'));
          } else if (entry.name.toLowerCase().endsWith('.zip')) {
            const inner = readZipEntry(buf, entry); // one level of nesting
            for (const e2 of listZipEntries(inner)) {
              if (e2.name.toLowerCase().endsWith('.xml')) {
                xmlDocs.push(readZipEntry(inner, e2).toString('utf8'));
              }
            }
          }
        }
      } else {
        xmlDocs.push(buf.toString('utf8')); // plain single TXC file
      }

      for (const xml of xmlDocs) {
        for (const prior of parseTransXChange(xml)) {
          const file = `${sanitizeKey(prior.key)}.json`;
          if (written.has(file)) continue; // newest dataset wins (sorted desc)
          written.add(file);
          await writeFile(
            join(PRIOR_DIR, file),
            JSON.stringify({
              key: prior.key,
              poly: prior.poly.map(([x, y]) => [Number(x.toFixed(6)), Number(y.toFixed(6))]),
              stops: prior.stops.map(([x, y]) => [Number(x.toFixed(6)), Number(y.toFixed(6))]),
            }),
          );
          summary.priorsWritten += 1;
        }
      }
    } catch (err) {
      summary.datasetsFailed += 1;
      console.error(`dataset ${ds.id} (${ds.operatorName}): ${String(err)}`);
    }
  }

  await writeFile(
    join(PRIOR_DIR, '.fetched.json'),
    JSON.stringify({ fetchedAt: Date.now(), ...summary }),
  );
  console.log(JSON.stringify(summary));
}

main().catch((err) => {
  // Never fail the pipeline — the learner falls back to trace-only seeds.
  console.log(JSON.stringify({ task: 'fetch-bus-prior', error: String(err) }));
});
