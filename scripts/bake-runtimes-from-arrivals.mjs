#!/usr/bin/env node
// Fill missing per-segment run times from recorded TfL Arrivals predictions.
//
// Why this exists: the Timetable API (`/Line/{id}/Timetable/{stop}`) answers
// 404 for the Elizabeth line and the six named Overground lines (probed
// 2026-09-28, both by line id and by stop pair), so bake-runtimes.mjs leaves
// every runTimes slot on those 7 lines null (306 segments) and the frontend
// positions their trains by the geometric fallback (length / 12 m/s).
//
// The Arrivals feed carries the same schedule implicitly: within ONE poll a
// train (vehicleId) has a prediction for every upcoming stop, so the
// difference in timeToStation between two consecutive stops of a baked
// branch is the run time between them. Taking the median over many polls
// and trains gives the scheduled figure to the minute.
//
// Input:  one or more sampled-arrivals files, each a gzip of JSON lines
//         {"t", "n", "p": [[id, lineId, vehicleId, naptanId, timeToStation,
//          currentLocation, ...], ...]}  (the format written by the
//          london-live arrivals sampler; any recorder producing that shape
//          will do). Concatenated gzip members are fine.
// Output: data/branches/<id>.json with null runTimes filled in. Existing
//         non-null values are NEVER overwritten (pass --overwrite to
//         recompute everything, e.g. to compare against the timetable).
//
//   node scripts/bake-runtimes-from-arrivals.mjs [--overwrite] [--min-samples N]
//        [--lines a,b,c] file.jsonl.gz [more.jsonl.gz ...]
import { createReadStream, readFileSync, writeFileSync } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DATA = join(ROOT, 'data');
/** Same validity window bake-runtimes.mjs applies to timetable samples. */
const MAX_RUN_S = 1800;
const NO_VEHICLE_ID = '000';

const argv = process.argv.slice(2);
const overwrite = argv.includes('--overwrite');
const minSamples = argv.includes('--min-samples') ? Number(argv[argv.indexOf('--min-samples') + 1]) : 5;
const onlyIdx = argv.indexOf('--lines');
const only = onlyIdx >= 0 ? new Set(argv[onlyIdx + 1].split(',')) : null;
const files = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--min-samples' && argv[i - 1] !== '--lines');
if (files.length === 0) {
  console.error('usage: bake-runtimes-from-arrivals.mjs [--overwrite] [--min-samples N] [--lines a,b] <arrivals.jsonl.gz>...');
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(join(DATA, 'manifest.json'), 'utf8'));
const lines = manifest.lines.filter((l) => (only ? only.has(l.id) : true));
const branchesByLine = new Map(lines.map((l) => [l.id, JSON.parse(readFileSync(join(DATA, 'branches', `${l.id}.json`), 'utf8'))]));

// (lineId, fromStopId, toStopId) -> samples; only consecutive stops of a baked branch count.
const pairKey = (l, a, b) => `${l}|${a}|${b}`;
const wanted = new Set();
for (const [lineId, file] of branchesByLine) {
  for (const br of file.branches) {
    for (let i = 0; i < br.stops.length - 1; i += 1) wanted.add(pairKey(lineId, br.stops[i].id, br.stops[i + 1].id));
  }
}
const samples = new Map();
const lineSet = new Set(branchesByLine.keys());

let polls = 0;
for (const file of files) {
  const rl = createInterface({ input: createReadStream(file).pipe(createGunzip()), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let poll;
    try { poll = JSON.parse(line); } catch { continue; }
    if (!poll.p) continue;
    polls += 1;
    const byTrain = new Map();
    for (const p of poll.p) {
      const [, lineId, vehicleId, naptanId, tts] = p;
      if (!lineSet.has(lineId) || !vehicleId || vehicleId === NO_VEHICLE_ID || typeof tts !== 'number') continue;
      const k = `${lineId}|${vehicleId}`;
      if (!byTrain.has(k)) byTrain.set(k, []);
      byTrain.get(k).push([tts, naptanId, lineId]);
    }
    for (const rows of byTrain.values()) {
      rows.sort((a, b) => a[0] - b[0]);
      for (let i = 0; i < rows.length - 1; i += 1) {
        const [t1, s1, lineId] = rows[i];
        const [t2, s2] = rows[i + 1];
        const k = pairKey(lineId, s1, s2);
        if (!wanted.has(k)) continue;
        const dt = t2 - t1;
        if (dt <= 0 || dt > MAX_RUN_S) continue;
        if (!samples.has(k)) samples.set(k, []);
        samples.get(k).push(dt);
      }
    }
  }
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
// Planar length of a segment, metres (same constants as the bake scripts).
const segLengthM = (pts) => {
  let m = 0;
  for (let i = 1; i < pts.length; i += 1) {
    m += Math.hypot((pts[i][0] - pts[i - 1][0]) * 111320 * Math.cos((51.5 * Math.PI) / 180), (pts[i][1] - pts[i - 1][1]) * 110540);
  }
  return m;
};
// A train waiting at its origin terminus is listed with a ~0 s countdown to the
// origin and dwell + run to the next stop, so the first segment of a branch
// measures the terminus dwell (observed ~1,000 s) rather than the run. Use the
// opposite direction's measurement of the same stop pair instead (there the pair
// is mid-route), and reject any value that implies a speed below this: nothing
// on these lines runs slower, so such a figure is dwell, not travel.
const MIN_PLAUSIBLE_SPEED_MS = 4;
const summary = { polls, lines: 0, segments: 0, filled: 0, kept: 0, unsampled: 0 };
for (const [lineId, file] of branchesByLine) {
  let filled = 0, kept = 0, unsampled = 0, total = 0;
  for (const br of file.branches) {
    const n = br.stops.length - 1;
    const rt = Array.isArray(br.runTimes) && br.runTimes.length === n ? br.runTimes : new Array(n).fill(null);
    for (let i = 0; i < n; i += 1) {
      total += 1;
      if (rt[i] != null && !overwrite) { kept += 1; continue; }
      let s = samples.get(pairKey(lineId, br.stops[i].id, br.stops[i + 1].id));
      if (i === 0) {
        const reverse = samples.get(pairKey(lineId, br.stops[1].id, br.stops[0].id));
        s = reverse && reverse.length >= minSamples ? reverse : null; // never the dwell-contaminated origin pair itself
      }
      let value = s && s.length >= minSamples ? Math.round(median(s)) : null;
      if (value != null && br.segments?.[i] && segLengthM(br.segments[i]) / value < MIN_PLAUSIBLE_SPEED_MS) value = null;
      if (value != null) { rt[i] = value; filled += 1; }
      else { rt[i] = rt[i] ?? null; unsampled += 1; }
    }
    br.runTimes = rt;
  }
  if (filled > 0) writeFileSync(join(DATA, 'branches', `${lineId}.json`), JSON.stringify(file));
  console.log(`${filled > 0 ? '✓' : '·'} ${lineId}: ${filled} filled, ${kept} kept, ${unsampled} without enough samples (of ${total})`);
  summary.lines += 1; summary.segments += total; summary.filled += filled; summary.kept += kept; summary.unsampled += unsampled;
}
console.log('done:', JSON.stringify(summary));
