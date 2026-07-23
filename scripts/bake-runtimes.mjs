// Bake scheduled inter-stop run times from the TfL Timetable API into
// data/branches/<id>.json (branch.runTimes[i] = seconds stops[i] → stops[i+1]).
// The frontend positions trains by elapsed/scheduled ratio when these exist.
// Run after bake-routes.mjs:  node scripts/bake-runtimes.mjs [lineId ...]
import { readFileSync, writeFileSync } from 'node:fs';
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tfl(path) {
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`https://api.tfl.gov.uk${path}${sep}app_key=${KEY}`, {
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`TfL ${res.status}`);
  return res.json();
}

const manifest = JSON.parse(readFileSync(join(DATA, 'manifest.json'), 'utf8'));
const only = process.argv.slice(2);
const lines = manifest.lines.filter((l) => (only.length ? only.includes(l.id) : true));

const totals = { lines: 0, calls: 0, segments: 0, filled: 0 };

for (const line of lines) {
  const branchesPath = join(DATA, 'branches', `${line.id}.json`);
  let lineData;
  try {
    lineData = JSON.parse(readFileSync(branchesPath, 'utf8'));
  } catch {
    continue;
  }

  // ordered stop pair "A>B" → observed scheduled runtimes (seconds)
  const pairSamples = new Map();
  const addSample = (a, b, seconds) => {
    if (!(seconds > 0) || seconds > 1800) return;
    const k = `${a}>${b}`;
    (pairSamples.get(k) ?? pairSamples.set(k, []).get(k)).push(seconds);
  };

  // one timetable call per unique (direction, branch first stop)
  const queried = new Set();
  for (const br of lineData.branches) {
    const fromId = br.stops[0]?.id;
    if (!fromId) continue;
    const qk = `${br.direction}|${fromId}`;
    if (queried.has(qk)) continue;
    queried.add(qk);
    try {
      const tt = await tfl(`/Line/${line.id}/Timetable/${fromId}?direction=${br.direction}`);
      totals.calls++;
      for (const route of tt?.timetable?.routes ?? []) {
        for (const si of route.stationIntervals ?? []) {
          let prevStop = tt.timetable.departureStopId ?? fromId;
          let prevT = 0;
          for (const iv of si.intervals ?? []) {
            if (typeof iv.timeToArrival === 'number' && iv.stopId) {
              addSample(prevStop, iv.stopId, (iv.timeToArrival - prevT) * 60);
              prevStop = iv.stopId;
              prevT = iv.timeToArrival;
            }
          }
        }
      }
    } catch (e) {
      console.warn(`  ! ${line.id} ${br.direction} from ${fromId}: ${e.message}`);
    }
    await sleep(250);
  }

  const median = (arr) => {
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };

  let filled = 0;
  let segs = 0;
  for (const br of lineData.branches) {
    br.runTimes = [];
    for (let i = 0; i < br.stops.length - 1; i++) {
      segs++;
      const samples = pairSamples.get(`${br.stops[i].id}>${br.stops[i + 1].id}`);
      if (samples?.length) {
        br.runTimes.push(Math.round(median(samples)));
        filled++;
      } else {
        br.runTimes.push(null);
      }
    }
  }
  writeFileSync(branchesPath, JSON.stringify(lineData));
  totals.lines++;
  totals.segments += segs;
  totals.filled += filled;
  console.log(`✓ ${line.id}: ${filled}/${segs} segments got scheduled run times`);
}

console.log('done:', JSON.stringify(totals));
