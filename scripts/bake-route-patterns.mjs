// Bake TfL service patterns (Route/Sequence `orderedLineRoutes[].naptanIds`)
// for the 20 rail lines into data/route-patterns/<lineId>.json.
// Run once (or after network changes):  node scripts/bake-route-patterns.mjs [lineId …]
// Reads TFL_APP_KEY from backend/.env. 40 requests (20 lines x 2 directions),
// paced at about one per second, one retry each. Output is sorted so re-bakes
// diff cleanly; each raw response is also archived (key-scrubbed) under
// ~/bus-archive/disruption-research/<date>/route-sequence/ for the record.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');
const OUT_DIR = join(DATA, 'route-patterns');

const env = Object.fromEntries(
  readFileSync(join(ROOT, 'backend/.env'), 'utf8')
    .split('\n')
    .filter((l) => l.includes('='))
    .map((l) => l.split('=', 2)),
);
const KEY = env.TFL_APP_KEY;
if (!KEY) throw new Error('TFL_APP_KEY missing from backend/.env');

// Every line whose disruptions can carry section geometry (manifest rail modes;
// river buses and the cable car have no Route/Sequence patterns worth slicing).
const RAIL_LINE_IDS = [
  'bakerloo',
  'central',
  'circle',
  'district',
  'hammersmith-city',
  'jubilee',
  'metropolitan',
  'northern',
  'piccadilly',
  'victoria',
  'waterloo-city',
  'dlr',
  'elizabeth',
  'liberty',
  'lioness',
  'mildmay',
  'suffragette',
  'weaver',
  'windrush',
  'tram',
];
const DIRECTIONS = ['inbound', 'outbound'];

const REQUEST_GAP_MS = 1000;
const RETRY_DELAY_MS = 2000;
const MAX_ATTEMPTS = 2;

// Optional CLI filter:  node scripts/bake-route-patterns.mjs dlr piccadilly … re-bakes only those.
const only = process.argv.slice(2);
const TARGET_LINES = only.length ? RAIL_LINE_IDS.filter((id) => only.includes(id)) : RAIL_LINE_IDS;

const bakedAt = new Date().toISOString();
const ARCHIVE_DIR = join(
  homedir(),
  'bus-archive',
  'disruption-research',
  bakedAt.slice(0, 'YYYY-MM-DD'.length),
  'route-sequence',
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const scrub = (text) => text.replaceAll(KEY, '[scrubbed]');

async function tfl(path) {
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`https://api.tfl.gov.uk${path}${sep}app_key=${KEY}`);
  if (!res.ok) throw new Error(`TfL ${res.status} for ${path}`);
  return res.text();
}

async function tflWithRetry(path) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await tfl(path);
    } catch (e) {
      if (attempt >= MAX_ATTEMPTS) throw e;
      console.warn(`  ! retrying ${path}: ${scrub(e.message)}`);
      await sleep(RETRY_DELAY_MS);
    }
  }
}

const isStringArray = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');

/** `orderedLineRoutes` → { dir, name, ids }[]; throws on an unexpected shape rather than baking it. */
function toPatterns(body, dir, path) {
  const routes = body.orderedLineRoutes ?? [];
  if (!Array.isArray(routes)) throw new Error(`orderedLineRoutes is not an array for ${path}`);
  return routes.map((r) => {
    if (typeof r.name !== 'string' || !isStringArray(r.naptanIds)) {
      throw new Error(`unexpected orderedLineRoutes entry for ${path}: ${JSON.stringify(r).slice(0, 200)}`);
    }
    return { dir, name: r.name, ids: [...r.naptanIds] };
  });
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sortPatterns = (patterns) =>
  [...patterns].sort(
    (p, q) => cmp(p.dir, q.dir) || cmp(p.name, q.name) || cmp(p.ids.join(','), q.ids.join(',')),
  );

/** One pattern per line: readable diffs without the per-id explosion of JSON.stringify(_, null, 2). */
function serialize(file) {
  const rows = file.patterns.map((p) => '    ' + JSON.stringify(p));
  return [
    '{',
    `  "lineId": ${JSON.stringify(file.lineId)},`,
    `  "bakedAt": ${JSON.stringify(file.bakedAt)},`,
    '  "patterns": [',
    rows.join(',\n'),
    '  ]',
    '}',
    '',
  ].join('\n');
}

/** Fetches one direction, archives the raw body, returns its patterns (or an error). */
async function bakeDirection(lineId, dir) {
  const path = `/Line/${lineId}/Route/Sequence/${dir}?excludeCrowding=true`;
  try {
    const text = await tflWithRetry(path);
    writeFileSync(join(ARCHIVE_DIR, `${lineId}-${dir}.json`), scrub(text));
    return { patterns: toPatterns(JSON.parse(text), dir, path) };
  } catch (e) {
    return { error: `${lineId}/${dir}: ${scrub(e.message)}` };
  }
}

async function bakeLine(lineId) {
  const results = [];
  for (const dir of DIRECTIONS) {
    results.push(await bakeDirection(lineId, dir));
    await sleep(REQUEST_GAP_MS);
  }
  return results;
}

mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(ARCHIVE_DIR, { recursive: true });

const failures = [];
for (const lineId of TARGET_LINES) {
  const results = await bakeLine(lineId);
  const errors = results.flatMap((r) => (r.error ? [r.error] : []));
  if (errors.length) {
    // A half-baked file would silently disable one direction; write nothing.
    failures.push(...errors);
    console.warn(`  ! ${lineId}: incomplete, file not written`);
    continue;
  }
  const patterns = sortPatterns(results.flatMap((r) => r.patterns));
  writeFileSync(join(OUT_DIR, `${lineId}.json`), serialize({ lineId, bakedAt, patterns }));
  const perDir = DIRECTIONS.map((d) => `${d} ${patterns.filter((p) => p.dir === d).length}`).join(', ');
  console.log(`✓ ${lineId}: ${patterns.length} patterns (${perDir})`);
}

if (failures.length) {
  console.error(`failed (${failures.length}):\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log(`done: ${TARGET_LINES.length} lines → ${OUT_DIR}; raw responses in ${ARCHIVE_DIR}`);
