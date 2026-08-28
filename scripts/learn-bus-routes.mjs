#!/usr/bin/env node
// Learn bus-route polylines from collected GPS traces.
//
// Paths are all relative to a base dir (BASE_DIR): the PERSIST_DIR volume in
// production (pinned by the backend scheduler via BUS_DATA_DIR), else data/.
// Input:  <base>/bus-traces/YYYY-MM-DD.jsonl  (last 3 days; written by backend)
//         <base>/bus-routes/prior/<key>.json  (optional BODS timetable shapes)
// Output: <base>/bus-routes/learned/<key>.json
//           {poly, quality:{journeys, meanResidualM, coverage}}
//         scheduler freshness stamp at BUS_LAST_RUN_PATH (the scheduler passes
//         the exact path it reads; standalone runs default to the flat volume /
//         data/-local convention) — matching learner-scheduler.ts.
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
// Every result is then MEASURED: coverage = fraction of ALL the key's journey
// fixes inside the result's adaptive corridor (written as quality.coverage).
// For London operators, a result covering < COVERAGE_THRESHOLD of its own fix
// cloud means the seed was bad (a short working or a glued median journey) —
// the REPAIR PATH re-seeds from the observed journey that best explains the
// whole cloud and keeps the repaired result only when it measures better.
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
// Base dir for all runtime bus data. The backend scheduler pins this (via
// BUS_DATA_DIR) to the SAME base its trace writer uses — the PERSIST_DIR volume
// in production, else data/ — so the learner reads traces where the writer wrote
// them and writes learned routes where the read route serves. Falls back to the
// repo's data/ for standalone/manual runs. Finer per-dir overrides remain for
// testing against synthetic traces.
const BASE_DIR = process.env.BUS_DATA_DIR ?? join(ROOT, 'data');
const TRACES_DIR = process.env.BUS_TRACES_DIR ?? join(BASE_DIR, 'bus-traces');
const PRIOR_DIR = process.env.BUS_PRIOR_DIR ?? join(BASE_DIR, 'bus-routes', 'prior');
const LEARNED_DIR = process.env.BUS_LEARNED_DIR ?? join(BASE_DIR, 'bus-routes', 'learned');
// Freshness stamp must match the scheduler's read. The scheduler passes the
// exact path via BUS_LAST_RUN_PATH (kept in lockstep even under the volume→data/
// fallback). Standalone runs fall back to the PERSIST_DIR-flat / data/-local
// convention the scheduler's persistPath uses.
const LAST_RUN_PATH =
  process.env.BUS_LAST_RUN_PATH ??
  (process.env.PERSIST_DIR
    ? join(process.env.PERSIST_DIR, 'bus-learner.last-run.json')
    : join(LEARNED_DIR, '.last-run.json'));

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

// ── coverage measurement + low-coverage repair ─────────────────────────────
/**
 * A learned shape must cover at least this fraction of its own fix cloud or —
 * for London operators — the repair path re-seeds it. London-only because low
 * coverage there reliably means a bad seed (dense urban routes, dense traces);
 * coaches and country operators legitimately stray (diversions, motorway
 * variants), so re-seeding them from one journey would do harm.
 */
const COVERAGE_THRESHOLD = 0.9;
// Case-insensitive (operator codes have burned us before: go2 vs Go2), and an
// empty/blank env value falls back to the default rather than silently
// disabling every repair.
const LONDON_OPERATORS = (() => {
  const parsed = (process.env.LONDON_OPERATORS ?? '')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  return new Set(parsed.length > 0 ? parsed : ['TFLO']);
})();
/** Candidate journeys actually scored per repaired key (most-fixes first). */
const SCORING_MAX_CANDIDATES = 400;
/** Fixes are stride-sampled to at most this many for candidate-journey scoring. */
const SCORING_SAMPLE_CAP = 15_000;
/** "Explains the cloud" radius for best-journey scoring (~ corridor cap). */
const SCORING_RADIUS_M = 60;
/**
 * A candidate vertex is "supported" when at least this many sampled fixes
 * project to it. Genuine-corridor vertices collect tens of fixes; vertices on
 * a glued deadhead/mislabeled leg collect almost none. Candidate selection
 * maximizes recall × precision, where precision = supported vertex fraction —
 * this defeats revenue-trip+deadhead glue journeys that dwell-splitting
 * cannot catch (fast < 5 min turnarounds).
 */
const VERTEX_SUPPORT_MIN_FIXES = 3;
/**
 * Anti-doubling guard for candidate journeys. Direction mislabels can glue an
 * outbound return onto an inbound leg (600 s turnarounds don't split them);
 * such an out-and-back explains ~100 % of the cloud and would always win. A
 * candidate whose path retraces itself — more than OVERLAP_MAX_FRACTION of its
 * vertices lying within OVERLAP_RADIUS_M of an EARLIER, non-adjacent (>
 * OVERLAP_MIN_SEPARATION segments back) part of its own path — is rejected.
 * Genuine one-way trips only self-overlap at terminus loops (fraction ≪ 0.3).
 */
const OVERLAP_RADIUS_M = 30;
const OVERLAP_MIN_SEPARATION = 20; // segments (~500 m along path at 25 m spacing)
const OVERLAP_MAX_FRACTION = 0.3;
/**
 * Layover split for candidate journeys. A terminal stand shorter than
 * JOURNEY_SPLIT_GAP_S glues a trip to its return leg (often carrying a
 * mislabeled direction), producing a "journey" that spans the route
 * down-and-back and wins the best-journey contest on recall alone (a 591 s
 * stand did exactly this on route 254). Split whenever the vehicle dwells
 * within LAYOVER_RADIUS_M for at least LAYOVER_MIN_S — terminal stands are
 * minutes long; ordinary stops and traffic lights are not.
 */
const LAYOVER_MIN_S = 300;
const LAYOVER_RADIUS_M = 80;

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

/** Completeness filter shared by both journey splitters. */
function isCompleteJourney(j) {
  if (j.length < JOURNEY_MIN_FIXES) return false;
  if (j[j.length - 1].t - j[0].t < JOURNEY_MIN_DURATION_S) return false;
  const pts = j.map((f) => toM([f.x, f.y]));
  return pathLengthM(pts) >= JOURNEY_MIN_LENGTH_M;
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
  return journeys.filter(isCompleteJourney);
}

/**
 * Split one vehicle's fixes into complete journeys, ALSO splitting at
 * layovers (dwell within LAYOVER_RADIUS_M for ≥ LAYOVER_MIN_S). Used only to
 * build repair-path candidate journeys: the normal learn keeps the plain
 * gap-split so its behavior stays identical, but a candidate seed glued to
 * its return leg across a short terminal stand must never win (guard (a)).
 */
function splitJourneysAtLayovers(fixes) {
  fixes.sort((a, b) => a.t - b.t);
  const distM = (a, b) => {
    const [ax, ay] = toM([a.x, a.y]);
    const [bx, by] = toM([b.x, b.y]);
    return Math.hypot(ax - bx, ay - by);
  };
  const journeys = [];
  let current = [];
  let standStart = 0; // index into `current` of the possible stand anchor
  for (const fix of fixes) {
    if (current.length > 0 && fix.t <= current[current.length - 1].t) continue;
    if (current.length > 0) {
      const prev = current[current.length - 1];
      const dt = fix.t - prev.t;
      const isGapSplit = dt > JOURNEY_SPLIT_GAP_S;
      // Quiet layover: a long fix gap while parked (writers often go silent on stand).
      const isQuietLayover = !isGapSplit && dt >= LAYOVER_MIN_S && distM(fix, prev) <= LAYOVER_RADIUS_M;
      // Dwelling layover: fixes keep coming but the bus stays put for LAYOVER_MIN_S.
      let isDwellLayover = false;
      if (!isGapSplit && !isQuietLayover) {
        if (distM(fix, current[standStart]) > LAYOVER_RADIUS_M) {
          standStart = current.length; // window re-anchors on the incoming fix
        } else if (fix.t - current[standStart].t >= LAYOVER_MIN_S) {
          isDwellLayover = true;
        }
      }
      if (isGapSplit || isQuietLayover || isDwellLayover) {
        // Dwell split: keep the journey up to where the stand began; the
        // stationary tail belongs to the layover, not either leg.
        const endIdx = isDwellLayover ? standStart + 1 : current.length;
        journeys.push(current.slice(0, endIdx));
        current = [];
        standStart = 0;
      }
    }
    if (current.length === 0) standStart = 0;
    current.push(fix);
  }
  if (current.length > 0) journeys.push(current);
  return journeys.filter(isCompleteJourney);
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

/**
 * COVERAGE METRIC. Project every fix (meter-space) onto a shape (degree-space
 * poly). Corridor = adaptive p90 of on-shape residuals clamped to
 * [CORRIDOR_START_M, CORRIDOR_CAP_M] — the same rule the fit uses. Coverage =
 * fraction of ALL fixes inside the corridor; fixes beyond
 * MAX_CONSIDERED_RESIDUAL_M count as uncovered. Coverage is unrounded here so
 * normal-vs-repaired comparison is exact; it is rounded once at write time.
 */
function computeShapeStats(polyDeg, fixesM) {
  const polyM = polyDeg.map(toM);
  const index = buildSegmentIndex(polyM, 100);
  // Stride-sampled: this runs for EVERY key, and busy keys carry ~100k fixes
  // per window — an unsampled pass would dominate the run and blow the
  // per-chunk memory budget. 15k samples put the coverage error well under
  // a percentage point, far inside the 0.06 threshold hysteresis.
  const step = Math.max(1, Math.floor(fixesM.length / SCORING_SAMPLE_CAP));
  let sampled = 0;
  const hits = [];
  for (let i = 0; i < fixesM.length; i += step) {
    const [px, py] = fixesM[i];
    sampled += 1;
    const proj = projectOnto(polyM, index, px, py, MAX_CONSIDERED_RESIDUAL_M);
    if (proj !== null) hits.push(proj.dist);
  }
  hits.sort((a, b) => a - b);
  const corridorM = Math.min(
    CORRIDOR_CAP_M,
    Math.max(CORRIDOR_START_M, quantile(hits, 0.9)),
  );
  let covered = 0;
  for (const d of hits) {
    if (d > corridorM) break; // hits are sorted — everything past here is out
    covered += 1;
  }
  return {
    lengthKm: Number((pathLengthM(polyM) / 1000).toFixed(2)),
    coverage: sampled === 0 ? 0 : covered / sampled,
  };
}

/** Fraction of a resampled path's vertices that retrace an earlier part of it. */
function selfOverlapFraction(poly) {
  if (poly.length < OVERLAP_MIN_SEPARATION + 2) return 0;
  const index = buildSegmentIndex(poly, 100);
  const { cells, cellM } = index;
  const reach = Math.max(1, Math.ceil(OVERLAP_RADIUS_M / cellM));
  let overlapped = 0;
  for (let i = 0; i < poly.length; i += 1) {
    const [px, py] = poly[i];
    const cx = Math.floor(px / cellM);
    const cy = Math.floor(py / cellM);
    let hit = false;
    for (let dx = -reach; dx <= reach && !hit; dx += 1) {
      for (let dy = -reach; dy <= reach && !hit; dy += 1) {
        const list = cells.get(`${cx + dx},${cy + dy}`);
        if (!list) continue;
        for (const j of list) {
          if (j > i - OVERLAP_MIN_SEPARATION) continue; // only earlier, non-adjacent path
          const [ax, ay] = poly[j];
          const [bx, by] = poly[j + 1];
          const vx = bx - ax;
          const vy = by - ay;
          const len2 = vx * vx + vy * vy;
          const u = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((px - ax) * vx + (py - ay) * vy) / len2));
          const d = Math.hypot(px - (ax + vx * u), py - (ay + vy * u));
          if (d <= OVERLAP_RADIUS_M) {
            hit = true;
            break;
          }
        }
      }
    }
    if (hit) overlapped += 1;
  }
  return overlapped / poly.length;
}

/**
 * BEST-JOURNEY SELECTION for the repair path. Score every candidate journey
 * by recall × precision against the route's (stride-sampled) fix cloud:
 * recall = fraction of the sample within SCORING_RADIUS_M of the candidate's
 * path (NOT length, so a rare short/school working cannot win merely by being
 * long or common); precision = supported fraction of the candidate's
 * 25 m-resampled vertices (guard (b) — kills revenue-trip+deadhead glue).
 * Doubled out-and-back candidates are rejected via selfOverlapFraction.
 * Ties break toward the longer path. Returns the winner or null.
 */
function selectBestJourney(journeyMetas, fixesM) {
  const step = Math.max(1, Math.floor(fixesM.length / SCORING_SAMPLE_CAP));
  const sample = [];
  for (let i = 0; i < fixesM.length; i += step) sample.push(fixesM[i]);
  // Busy keys can offer >1000 candidate journeys; scoring cost is linear in
  // candidates. The most-fixes-first cap keeps the winner (a full-length,
  // well-sampled journey by construction) while bounding the worst case.
  const candidates = [...journeyMetas]
    .sort((a, b) => b.fixes.length - a.fixes.length)
    .slice(0, SCORING_MAX_CANDIDATES);
  let best = null;
  for (const meta of candidates) {
    const pts = meta.fixes.map((f) => toM([f.x, f.y]));
    const poly = resample(pts, SEED_SPACING_M);
    if (poly.length < 2) continue;
    if (selfOverlapFraction(poly) > OVERLAP_MAX_FRACTION) {
      continue; // out-and-back from a direction mislabel — never a valid seed
    }
    const index = buildSegmentIndex(poly, 100);
    let inside = 0;
    const support = new Array(poly.length).fill(0);
    for (const [px, py] of sample) {
      const proj = projectOnto(poly, index, px, py, SCORING_RADIUS_M);
      if (proj === null) continue;
      inside += 1;
      support[proj.u < 0.5 ? proj.seg : proj.seg + 1] += 1;
    }
    const recall = sample.length === 0 ? 0 : inside / sample.length;
    let supported = 0;
    for (const c of support) if (c >= VERTEX_SUPPORT_MIN_FIXES) supported += 1;
    const precision = supported / poly.length;
    const score = recall * precision;
    const lenM = pathLengthM(pts);
    if (
      best === null ||
      score > best.score + 1e-9 ||
      (Math.abs(score - best.score) <= 1e-9 && lenM > best.lenM)
    ) {
      best = { meta, score, lenM };
    }
  }
  return best;
}

/**
 * REPAIR PATH for a London key whose normal result under-covers its own fix
 * cloud. Re-seed from the best-scoring observed journey (candidates come from
 * the layover-aware split), re-run the standard refine on that seed, and keep
 * the repaired result only when its coverage beats the normal one. Returns
 * {result, stats} or null when no repair improves on the normal result.
 */
function repairLowCoverageKey(key, vehicles, journeys, fixesM, normalStats) {
  const candidates = [];
  for (const [veh, fixes] of vehicles) {
    for (const j of splitJourneysAtLayovers(fixes)) candidates.push({ veh, fixes: j });
  }
  const best = selectBestJourney(candidates, fixesM);
  if (best === null) return null;
  // The winning journey acts as the seed "prior" (degree-space, no stops);
  // the refine itself — corridor, trimmed mean, smoothing, gate — is the
  // standard learnKey over the SAME journeys as the normal pass.
  const seedPrior = { poly: best.meta.fixes.map((f) => [f.x, f.y]), stops: [] };
  const result = learnKey(journeys, seedPrior);
  if (result.skip) return null;
  const stats = computeShapeStats(result.poly, fixesM);
  if (stats.coverage <= normalStats.coverage) return null;
  // One summary line per repaired key, on the same stdout stream the
  // scheduler already captures for learner runs.
  console.log(
    JSON.stringify({
      task: 'learn-bus-routes',
      event: 'repaired-low-coverage-key',
      key,
      seedVehicle: best.meta.veh,
      oldCoverage: Number(normalStats.coverage.toFixed(3)),
      newCoverage: Number(stats.coverage.toFixed(3)),
      oldLengthKm: normalStats.lengthKm,
      newLengthKm: stats.lengthKm,
    }),
  );
  return { result, stats };
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
    repaired: 0,
    /** per-repair audit (key + old/new coverage/length), capped at 200. */
    repairs: [],
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

      // Measure the result against the key's whole fix cloud (all journey
      // fixes, meter space) — quality.coverage for every learned file.
      const fixesM = [];
      for (const j of journeys) for (const f of j) fixesM.push(toM([f.x, f.y]));
      let final = result;
      let stats = computeShapeStats(result.poly, fixesM);

      // Low coverage on a London route = bad seed; try the repair path.
      const operator = (key.split(':')[0] ?? '').toUpperCase();
      if (stats.coverage < COVERAGE_THRESHOLD && LONDON_OPERATORS.has(operator)) {
        const before = stats;
        const repaired = repairLowCoverageKey(key, vehicles, journeys, fixesM, stats);
        if (repaired) {
          final = repaired.result;
          stats = repaired.stats;
          summary.repaired += 1;
          // Persisted in the last-run stamp: the stdout line vanishes with
          // the child process in production, and "which shapes changed and
          // why" is exactly what a future incident will ask. Capped so the
          // stamp stays small.
          if (summary.repairs.length < 200) {
            summary.repairs.push({
              key,
              oldCoverage: Number(before.coverage.toFixed(3)),
              newCoverage: Number(stats.coverage.toFixed(3)),
              oldLengthKm: before.lengthKm,
              newLengthKm: stats.lengthKm,
            });
          }
        }
      }

      await writeFile(
        join(LEARNED_DIR, `${sanitizeKey(key)}.json`),
        JSON.stringify({
          key,
          poly: final.poly,
          quality: {
            journeys: journeys.length,
            meanResidualM: final.meanResidualM,
            coverage: Number(stats.coverage.toFixed(3)),
          },
        }),
      );
      summary.learned += 1;
      residualTotal += final.meanResidualM;
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
