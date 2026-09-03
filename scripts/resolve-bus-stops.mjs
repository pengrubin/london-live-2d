// Turn every bus-stop closure into a place on the map.
//
//   node scripts/resolve-bus-stops.mjs                     # live closure feed
//   node scripts/resolve-bus-stops.mjs --from <file>       # a saved snapshot
//   node scripts/resolve-bus-stops.mjs --cache <path>      # non-default cache
//
// `/StopPoint/Mode/bus/Disruption` names each closed stop by `atcoCode` alone —
// no coordinate, no routes. This resolves each distinct id once through
// `GET /StopPoint/{ids}` (batched at 20, the measured ceiling) and keeps the
// answer forever in a JSON cache, because a stop's position never changes.
// Re-running only ever asks about ids the cache has not seen.
//
// Reads TFL_APP_KEY from backend/.env; the key is scrubbed out of everything
// written to disk. Raw responses are archived under
// ~/bus-archive/disruption-research/<date>/stoppoint-raw/ for the record.
//
// Prints the true resolution rate: total ids, resolved, every unresolved id
// with its reason, exact pole vs parent pair, and how many carry a route list.
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCache, resolveStops, saveCache } from '../backend/src/disruptions/bus-stop-gazetteer.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CACHE = join(ROOT, 'data', 'bus-stops', 'gazetteer.json');
const TFL_BASE_URL = 'https://api.tfl.gov.uk';
const DISRUPTION_PATH = '/StopPoint/Mode/bus/Disruption';
/** The closure feed measured 124 KB; the default 8 s upstream timeout is tight. */
const FEED_TIMEOUT_MS = 20_000;
const STOPPOINT_TIMEOUT_MS = 20_000;
const PERCENT = 100;
const DECIMALS = 2;
const SEQUENCE_DIGITS = 4;
/** Longest reason line to print before it starts hiding the report. */
const MAX_REASON_CHARS = 160;

const args = process.argv.slice(2);
const fromFile = valueOf('--from');
const cachePath = valueOf('--cache') ?? DEFAULT_CACHE;

const env = Object.fromEntries(
  readFileSync(join(ROOT, 'backend/.env'), 'utf8')
    .split('\n')
    .filter((line) => line.includes('='))
    .map((line) => line.split('=', 2)),
);
const KEY = env.TFL_APP_KEY;
// Required even with --from: a saved snapshot still names ids the cache may
// never have seen, and resolving those is the whole point of the run.
if (!KEY) throw new Error('TFL_APP_KEY missing from backend/.env');

const today = new Date().toISOString().slice(0, 'YYYY-MM-DD'.length);
const ARCHIVE_DIR = join(homedir(), 'bus-archive', 'disruption-research', today, 'stoppoint-raw');

/** Never let the key reach disk or the terminal. */
const scrub = (text) => text.replaceAll(KEY, '[scrubbed]');

function valueOf(flag) {
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : undefined;
}

async function tflJson(path, timeoutMs) {
  const url = `${TFL_BASE_URL}${path}?app_key=${KEY}`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: 'application/json' },
  });
  const text = await res.text();
  return { status: res.status, text };
}

/** The closure rows, live or from a saved snapshot. */
async function readClosures() {
  if (fromFile) {
    try {
      return { rows: JSON.parse(readFileSync(fromFile, 'utf8')), source: fromFile };
    } catch (error) {
      throw new Error(`cannot read closure snapshot ${fromFile}: ${error.message}`);
    }
  }
  const { status, text } = await tflJson(DISRUPTION_PATH, FEED_TIMEOUT_MS);
  if (status !== 200) throw new Error(`closure feed answered HTTP ${status}`);
  return { rows: JSON.parse(text), source: 'live /StopPoint/Mode/bus/Disruption' };
}

/** Distinct `atcoCode` values, in feed order. */
function distinctAtcoCodes(rows) {
  if (!Array.isArray(rows)) throw new Error('closure feed is not an array');
  const seen = new Set();
  for (const row of rows) {
    const code = row?.atcoCode;
    if (typeof code === 'string' && code.length > 0) seen.add(code);
  }
  return [...seen];
}

let sequence = 0;

/** The gazetteer's only network dependency; archives each raw body en route. */
async function fetchStopPoints(ids) {
  const { status, text } = await tflJson(`/StopPoint/${ids.join(',')}`, STOPPOINT_TIMEOUT_MS);
  sequence += 1;
  const name = `batch-${String(sequence).padStart(SEQUENCE_DIGITS, '0')}.json`;
  writeFileSync(
    join(ARCHIVE_DIR, name),
    scrub(JSON.stringify({ requested: ids, status, body: safeParse(text) })),
  );
  if (status !== 200) return { status, body: null };
  return { status, body: JSON.parse(text) };
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { unparseable: scrub(text).slice(0, MAX_REASON_CHARS) };
  }
}

const pct = (part, whole) => (whole === 0 ? 0 : (part / whole) * PERCENT).toFixed(DECIMALS);

mkdirSync(ARCHIVE_DIR, { recursive: true });

const { rows, source } = await readClosures();
const ids = distinctAtcoCodes(rows);
const cached = await loadCache(cachePath);
console.log(
  `closures: ${rows.length} rows / ${ids.length} distinct stops from ${source}` +
    ` — cache holds ${cached.size}`,
);

const result = await resolveStops(ids, {
  fetchStopPoints,
  log: (message) => console.warn(`  ! ${message}`),
  cached,
});

// The cache is permanent and additive: keep everything it already knew.
const merged = new Map([...cached, ...result.resolved]);
await saveCache(cachePath, merged);
const cacheBytes = statSync(cachePath).size;

const { stats } = result;
const routed = [...result.resolved.values()].filter((stop) => stop.routes.length > 0).length;

console.log('');
console.log('resolution');
console.log(`  distinct ATCO ids   ${ids.length}`);
console.log(`  resolved            ${result.resolved.size}  (${pct(result.resolved.size, ids.length)}%)`);
console.log(`  unresolved          ${result.unresolved.length}`);
console.log(`  served from cache   ${stats.fromCache}`);
console.log(`  fetched this run    ${stats.fetched}`);
console.log('coordinate provenance');
console.log(`  exact pole          ${stats.exact}  (${pct(stats.exact, stats.fetched)}% of fetched)`);
console.log(`  parent pair         ${stats.parent}  (${pct(stats.parent, stats.fetched)}% of fetched)`);
console.log('routes (the join key a later wave needs)');
console.log(`  with a route list   ${routed}  (${pct(routed, result.resolved.size)}% of resolved)`);
console.log('upstream');
console.log(`  StopPoint calls     ${stats.upstreamCalls}`);
console.log(`  failed batches      ${stats.failedBatches}`);
console.log(`  raw responses       ${ARCHIVE_DIR}`);
console.log('cache');
console.log(`  file                ${cachePath}`);
console.log(`  entries             ${merged.size}`);
console.log(`  bytes               ${cacheBytes}`);

if (result.unresolved.length > 0) {
  console.log('');
  console.log(`unresolved (${result.unresolved.length}) — every one, with its reason:`);
  for (const id of result.unresolved) {
    const name = rows.find((row) => row?.atcoCode === id)?.commonName ?? '(no name in feed)';
    console.log(`  ${id}  ${name}  — ${result.reasons.get(id)?.slice(0, MAX_REASON_CHARS)}`);
  }
}
