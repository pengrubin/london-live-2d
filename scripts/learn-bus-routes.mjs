#!/usr/bin/env node
// Learn bus-route polylines from collected GPS traces.
//
// Input:  data/bus-traces/YYYY-MM-DD.jsonl  (last 3 days; written by backend)
//         data/bus-routes/prior/<key>.json  (optional BODS timetable shapes)
// Output: data/bus-routes/learned/<key>.json {poly, quality:{journeys, meanResidualM}}
//         scheduler freshness stamp: PERSIST_DIR/bus-learner.last-run.json when
//         PERSIST_DIR is set (production volume, survives redeploys), else
//         data/bus-routes/learned/.last-run.json — matching learner-scheduler.ts.
//
// Method, per line+direction with ≥ MIN_JOURNEYS complete journeys:
//   seed  = prior shape if present, else the median-length journey,
//           resampled to uniform 25 m vertex spacing;
//   fit   = project every trace point onto the seed, adapt the corridor
//           (start 30 m → p90 of residuals, capped 60 m), then per-vertex
//           trimmed mean (worst 20 % by residual dropped) of assigned points;
//   snap  = pull vertices within 40 m of a prior stop toward the stop, then
//           one light smoothing pass;
//   gate  = re-project points on the result; keep only if meanResidual ≤ 35 m
//           (worse means bad geometry — unsnapped buses look better).
//
// Idempotent full recompute from the trace window; existing learned files for
// keys that currently lack data are left in place. Memory is bounded by
// processing keys in chunks (two-pass: count, then collect per chunk).

import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
// Env overrides exist for testing the learner against synthetic traces.
const TRACES_DIR = process.env.BUS_TRACES_DIR ?? join(ROOT, 'data', 'bus-traces');
const PRIOR_DIR = process.env.BUS_PRIOR_DIR ?? join(ROOT, 'data', 'bus-routes', 'prior');
const LEARNED_DIR = process.env.BUS_LEARNED_DIR ?? join(ROOT, 'data', 'bus-routes', 'learned');
// Freshness stamp relocates to the persist volume in production so the
// scheduler's read (learner-scheduler.ts persistPath('bus-learner.last-run.json'))
// finds it after a redeploy; locally it stays exactly where it lives today.
const LAST_RUN_PATH = process.env.PERSIST_DIR
  ? join(process.env.PERSIST_DIR, 'bus-learner.last-run.json')
  : join(LEARNED_DIR, '.last-run.json');

const TRACE_WINDOW_DAYS = 3;
const MIN_JOURNEYS = 5;
/** A journey counts as complete only past these thresholds. */
const JOURNEY_MIN_FIXES = 15;
const JOURNEY_MIN_LENGTH_M = 2_000;
const JOURNEY_MIN_DURATION_S = 480;
/** Fix gap that splits a vehicle's stream into separate journeys. */
const JOURNEY_SPLIT_GAP_S = 600;
const SEED_SPACING_M = 25;
const MAX_SEED_VERTICES = 2_500;
const CORRIDOR_START_M = 30;
const CORRIDOR_CAP_M = 60;
/** Points farther than this from the seed are off-route noise — ignored. */
const MAX_CONSIDERED_RESIDUAL_M = 100;
const TRIM_FRACTION = 0.2;
const VERTEX_MIN_SUPPORT = 4;
const STOP_ANCHOR_RADIUS_M = 40;
const STOP_ANCHOR_PULL = 0.5;
const MAX_MEAN_RESIDUAL_M = 35;
/** Per-chunk fix budget bounds memory (~24 B/fix → ≲ 100 MB a chunk). */
const CHUNK_FIX_BUDGET = 4_000_000;

const M_PER_DEG_LAT = 110_540;
const M_PER_DEG_LON = 111_320 * Math.cos((51.5 * Math.PI) / 180);

/** Must match backend/frontend: key → safe filename. */
const sanitizeKey = (key) => key.replace(/[^A-Za-z0-9_.-]/g, '_');

const toM = ([lon, lat]) => [lon * M_PER_DEG_LON, lat * M_PER_DEG_LAT];
const toDeg = ([x, y]) => [x / M_PER_DEG_LON, y / M_PER_DEG_LAT];

function pathLengthM(pts) {
  let total = 0;
  for (let i = 1; i < pts.length; i += 1) {
    total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  }
  return total;
}

/** Uniformly resample a meter-space polyline to `spacing`, keeping endpoints. */
function resample(pts, spacing) {
  if (pts.length < 2) return pts;
  const out = [pts[0]];
  let carry = 0;
  for (let i = 1; i < pts.length; i += 1) {
    let [ax, ay] = pts[i - 1];
    const [bx, by] = pts[i];
    let seg = Math.hypot(bx - ax, by - ay);
    while (carry + seg >= spacing) {
      const need = spacing - carry;
      const f = need / seg;
      const nx = ax + (bx - ax) * f;
      const ny = ay + (by - ay) * f;
      out.push([nx, ny]);
      ax = nx;
      ay = ny;
      seg -= need;
      carry = 0;
      if (out.length >= MAX_SEED_VERTICES) return out;
    }
    carry += seg;
  }
  const last = pts[pts.length - 1];
  const tail = out[out.length - 1];
  if (Math.hypot(last[0] - tail[0], last[1] - tail[1]) > spacing / 4) out.push(last);
  return out;
}

/** Spatial hash of polyline segments for fast nearest-segment queries. */
function buildSegmentIndex(poly, cellM) {
  const cells = new Map();
  const put = (cx, cy, i) => {
    const key = `${cx},${cy}`;
    const list = cells.get(key);
    if (list) list.push(i);
    else cells.set(key, [i]);
  };
  for (let i = 0; i < poly.length - 1; i += 1) {
    const x0 = Math.floor(Math.min(poly[i][0], poly[i + 1][0]) / cellM);
    const x1 = Math.floor(Math.max(poly[i][0], poly[i + 1][0]) / cellM);
    const y0 = Math.floor(Math.min(poly[i][1], poly[i + 1][1]) / cellM);
    const y1 = Math.floor(Math.max(poly[i][1], poly[i + 1][1]) / cellM);
    for (let cx = x0; cx <= x1; cx += 1) for (let cy = y0; cy <= y1; cy += 1) put(cx, cy, i);
  }
  return { cells, cellM, segCount: poly.length - 1 };
}

/**
 * Nearest point on `poly` to (px,py) using the index; returns
 * {seg, u, dist, x, y} or null when nothing is within `maxDist`.
 */
function projectOnto(poly, index, px, py, maxDist) {
  const { cells, cellM } = index;
  const reach = Math.max(1, Math.ceil(maxDist / cellM));
  const cx = Math.floor(px / cellM);
  const cy = Math.floor(py / cellM);
  let best = null;
  const seen = new Set();
  for (let dx = -reach; dx <= reach; dx += 1) {
    for (let dy = -reach; dy <= reach; dy += 1) {
      const list = cells.get(`${cx + dx},${cy + dy}`);
      if (!list) continue;
      for (const i of list) {
        if (seen.has(i)) continue;
        seen.add(i);
        const [ax, ay] = poly[i];
        const [bx, by] = poly[i + 1];
        const vx = bx - ax;
        const vy = by - ay;
        const len2 = vx * vx + vy * vy;
        const u = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((px - ax) * vx + (py - ay) * vy) / len2));
        const qx = ax + vx * u;
        const qy = ay + vy * u;
        const dist = Math.hypot(px - qx, py - qy);
        if (best === null || dist < best.dist) best = { seg: i, u, dist, x: qx, y: qy };
      }
    }
  }
  if (best === null || best.dist > maxDist) return null;
  return best;
}

function quantile(sorted, q) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[idx];
}

/** Split one vehicle's time-sorted fixes into complete journeys. */
function splitJourneys(fixes) {
  fixes.sort((a, b) => a.t - b.t);
  const journeys = [];
  let current = [];
  for (const fix of fixes) {
    if (current.length > 0 && fix.t - current[current.length - 1].t > JOURNEY_SPLIT_GAP_S) {
      journeys.push(current);
      current = [];
    }
    if (current.length === 0 || fix.t > current[current.length - 1].t) current.push(fix);
  }
  if (current.length > 0) journeys.push(current);
  return journeys.filter((j) => {
    if (j.length < JOURNEY_MIN_FIXES) return false;
    if (j[j.length - 1].t - j[0].t < JOURNEY_MIN_DURATION_S) return false;
    const pts = j.map((f) => toM([f.x, f.y]));
    return pathLengthM(pts) >= JOURNEY_MIN_LENGTH_M;
  });
}

async function loadPrior(key) {
  const path = join(PRIOR_DIR, `${sanitizeKey(key)}.json`);
  if (!existsSync(path)) return null;
  try {
    const prior = JSON.parse(await readFile(path, 'utf8'));
    if (!Array.isArray(prior.poly) || prior.poly.length < 2) return null;
    return { poly: prior.poly, stops: Array.isArray(prior.stops) ? prior.stops : [] };
  } catch {
    return null;
  }
}

/** Learn one key from its journeys; returns a result object or a skip reason. */
function learnKey(journeys, prior) {
  // Seed: prior shape, else the journey with median path length.
  let seedPts;
  if (prior) {
    seedPts = prior.poly.map(toM);
  } else {
    const measured = journeys
      .map((j) => ({ j, len: pathLengthM(j.map((f) => toM([f.x, f.y]))) }))
      .sort((a, b) => a.len - b.len);
    seedPts = measured[Math.floor(measured.length / 2)].j.map((f) => toM([f.x, f.y]));
  }
  const seed = resample(seedPts, SEED_SPACING_M);
  if (seed.length < 2) return { skip: 'degenerate-seed' };
  const index = buildSegmentIndex(seed, 100);

  // Project every fix; collect residuals for the adaptive corridor.
  const projections = [];
  const residuals = [];
  for (const journey of journeys) {
    for (const fix of journey) {
      const [px, py] = toM([fix.x, fix.y]);
      const proj = projectOnto(seed, index, px, py, MAX_CONSIDERED_RESIDUAL_M);
      if (proj === null) continue;
      projections.push({ px, py, proj });
      residuals.push(proj.dist);
    }
  }
  if (projections.length === 0) return { skip: 'no-on-route-points' };
  residuals.sort((a, b) => a - b);
  const corridor = Math.min(
    CORRIDOR_CAP_M,
    Math.max(CORRIDOR_START_M, quantile(residuals, 0.9)),
  );

  // Per-vertex accumulation of in-corridor points (sorted by residual later).
  const perVertex = seed.map(() => []);
  for (const { px, py, proj } of projections) {
    if (proj.dist > corridor) continue;
    const vertex = proj.u < 0.5 ? proj.seg : proj.seg + 1;
    perVertex[vertex].push({ px, py, dist: proj.dist });
  }

  const learned = seed.map((v, i) => {
    const pts = perVertex[i];
    if (pts.length < VERTEX_MIN_SUPPORT) return [v[0], v[1]];
    pts.sort((a, b) => a.dist - b.dist);
    const keep = Math.max(VERTEX_MIN_SUPPORT, Math.ceil(pts.length * (1 - TRIM_FRACTION)));
    let sx = 0;
    let sy = 0;
    for (let k = 0; k < keep; k += 1) {
      sx += pts[k].px;
      sy += pts[k].py;
    }
    return [sx / keep, sy / keep];
  });

  // Anchor vertices near prior stops toward the stop.
  if (prior && prior.stops.length > 0) {
    for (const stop of prior.stops) {
      const [sx, sy] = toM(stop);
      let bestI = -1;
      let bestD = Infinity;
      for (let i = 0; i < learned.length; i += 1) {
        const d = Math.hypot(learned[i][0] - sx, learned[i][1] - sy);
        if (d < bestD) {
          bestD = d;
          bestI = i;
        }
      }
      if (bestI >= 0 && bestD <= STOP_ANCHOR_RADIUS_M) {
        learned[bestI] = [
          learned[bestI][0] + (sx - learned[bestI][0]) * STOP_ANCHOR_PULL,
          learned[bestI][1] + (sy - learned[bestI][1]) * STOP_ANCHOR_PULL,
        ];
      }
    }
  }

  // Light 1-2-1 smoothing to iron out per-vertex estimation jitter.
  const smoothed = learned.map((v, i) => {
    if (i === 0 || i === learned.length - 1) return v;
    return [
      0.25 * learned[i - 1][0] + 0.5 * v[0] + 0.25 * learned[i + 1][0],
      0.25 * learned[i - 1][1] + 0.5 * v[1] + 0.25 * learned[i + 1][1],
    ];
  });

  // Quality gate: mean residual of (a sample of) points against the result.
  const finalIndex = buildSegmentIndex(smoothed, 100);
  const step = Math.max(1, Math.floor(projections.length / 20_000));
  let residualSum = 0;
  let residualCount = 0;
  for (let i = 0; i < projections.length; i += step) {
    const { px, py } = projections[i];
    const proj = projectOnto(smoothed, finalIndex, px, py, MAX_CONSIDERED_RESIDUAL_M);
    if (proj === null) continue;
    residualSum += proj.dist;
    residualCount += 1;
  }
  const meanResidualM = residualCount === 0 ? Infinity : residualSum / residualCount;
  if (meanResidualM > MAX_MEAN_RESIDUAL_M) return { skip: 'bad-geometry', meanResidualM };

  return {
    poly: smoothed.map((p) => toDeg(p).map((c) => Number(c.toFixed(6)))),
    meanResidualM: Number(meanResidualM.toFixed(1)),
  };
}

// ── streaming trace IO ─────────────────────────────────────────────────────

async function traceFiles() {
  let names;
  try {
    names = await readdir(TRACES_DIR);
  } catch {
    return [];
  }
  const cutoff = new Date(Date.now() - TRACE_WINDOW_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);
  return names
    .filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n) && n.slice(0, 10) >= cutoff)
    .sort()
    .map((n) => join(TRACES_DIR, n));
}

async function scanTraces(files, onFix) {
  for (const file of files) {
    const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    for await (const line of rl) {
      if (line === '') continue;
      let fix;
      try {
        fix = JSON.parse(line);
      } catch {
        continue; // torn final line from a crashed writer — ignore
      }
      if (
        typeof fix.k !== 'string' ||
        typeof fix.i !== 'string' ||
        !Number.isFinite(fix.x) ||
        !Number.isFinite(fix.y) ||
        !Number.isFinite(fix.t)
      ) {
        continue;
      }
      onFix(fix);
    }
  }
}

async function main() {
  const startedAt = Date.now();
  await mkdir(LEARNED_DIR, { recursive: true });
  const files = await traceFiles();

  const summary = {
    task: 'learn-bus-routes',
    traceFiles: files.length,
    keysSeen: 0,
    learned: 0,
    insufficientData: 0,
    badGeometry: 0,
    otherSkips: 0,
    meanResidualM: 0,
    tookS: 0,
  };

  // Pass 1: fix counts per key, to pack keys into memory-bounded chunks.
  const counts = new Map();
  await scanTraces(files, (fix) => {
    if (fix.k.endsWith(':unknown')) return; // mixed directions never learn well
    counts.set(fix.k, (counts.get(fix.k) ?? 0) + 1);
  });
  summary.keysSeen = counts.size;

  const chunks = [];
  {
    let current = new Set();
    let budget = 0;
    for (const [key, count] of counts) {
      if (budget + count > CHUNK_FIX_BUDGET && current.size > 0) {
        chunks.push(current);
        current = new Set();
        budget = 0;
      }
      current.add(key);
      budget += count;
    }
    if (current.size > 0) chunks.push(current);
  }

  let residualTotal = 0;
  for (const chunk of chunks) {
    // Pass 2 (per chunk): collect fixes grouped by key → vehicle.
    const byKey = new Map();
    await scanTraces(files, (fix) => {
      if (!chunk.has(fix.k)) return;
      let vehicles = byKey.get(fix.k);
      if (!vehicles) {
        vehicles = new Map();
        byKey.set(fix.k, vehicles);
      }
      let fixes = vehicles.get(fix.i);
      if (!fixes) {
        fixes = [];
        vehicles.set(fix.i, fixes);
      }
      fixes.push({ x: fix.x, y: fix.y, t: fix.t });
    });

    for (const [key, vehicles] of byKey) {
      const journeys = [];
      for (const fixes of vehicles.values()) journeys.push(...splitJourneys(fixes));
      if (journeys.length < MIN_JOURNEYS) {
        summary.insufficientData += 1;
        continue;
      }
      const prior = await loadPrior(key);
      const result = learnKey(journeys, prior);
      if (result.skip === 'bad-geometry') {
        summary.badGeometry += 1;
        continue;
      }
      if (result.skip) {
        summary.otherSkips += 1;
        continue;
      }
      await writeFile(
        join(LEARNED_DIR, `${sanitizeKey(key)}.json`),
        JSON.stringify({
          key,
          poly: result.poly,
          quality: { journeys: journeys.length, meanResidualM: result.meanResidualM },
        }),
      );
      summary.learned += 1;
      residualTotal += result.meanResidualM;
    }
  }

  summary.meanResidualM = summary.learned === 0 ? 0 : Number((residualTotal / summary.learned).toFixed(1));
  summary.tookS = Number(((Date.now() - startedAt) / 1000).toFixed(1));
  await mkdir(dirname(LAST_RUN_PATH), { recursive: true });
  await writeFile(LAST_RUN_PATH, JSON.stringify({ ranAt: Date.now(), ...summary }));
  console.log(JSON.stringify(summary));
}

main().catch((err) => {
  console.error(String(err?.stack ?? err));
  console.log(JSON.stringify({ task: 'learn-bus-routes', error: String(err) }));
  process.exitCode = 1;
});
