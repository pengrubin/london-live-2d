// Daily bus-trace rollup — the longitudinal series the pruner would otherwise
// destroy.
//
// TraceWriter keeps raw GPS fixes for only 7 days (RETENTION_DAYS) before
// deleting them, so any long-run statistic — fleet size over time, journey
// counts, speed distributions, future headway-regularity work — is lost unless
// it is aggregated first. This writer scans <base>/bus-traces/ once an hour,
// and for every COMPLETE UTC day that has a trace file but no rollup yet,
// streams the JSONL once and writes one small summary to
// <base>/bus-rollups/YYYY-MM-DD.json. Rollups are never deleted: at roughly
// 250 KB/day it would take decades for size to matter. Catch-up is idempotent
// (a day is skipped once its rollup file exists), so restarts and missed runs
// self-heal as long as the trace file is still inside the retention window.
//
// Privacy: rollups are route-level aggregates only. Vehicle identifiers are
// counted (distinct-vehicle cardinality) but never written to the output.

import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

const CHECK_INTERVAL_MS = 60 * 60_000;
const STARTUP_DELAY_MS = 30_000;
/** Same gap the learner uses to split a vehicle's stream into journeys. */
const JOURNEY_SPLIT_GAP_S = 600;
/** Ignore fix pairs closer than this — dt too small for a stable speed. */
const MIN_SPEED_DT_S = 5;
/** Implied speeds above this are GPS glitches (144 km/h), not buses. */
const MAX_SPEED_MS = 40;
/** Speed histogram: SPEED_BUCKETS buckets of SPEED_BUCKET_MS m/s each. */
const SPEED_BUCKET_MS = 0.5;
const SPEED_BUCKETS = Math.ceil(MAX_SPEED_MS / SPEED_BUCKET_MS);

const TRACE_FILE_RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
const EARTH_RADIUS_M = 6_371_000;

/** Matches the learner's key→filename mapping (learn-bus-routes.mjs). */
const sanitizeKey = (key: string): string => key.replace(/[^A-Za-z0-9_.-]/g, '_');

function utcDateStamp(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

export interface RouteDayStats {
  /** Raw fixes recorded for this route that day. */
  fixes: number;
  /** Distinct vehicles seen on this route that day. */
  vehicles: number;
  /** Journeys, split on the same 600 s gap the learner uses. */
  journeys: number;
  /** Implied point-to-point speed quartiles (m/s), or null if no samples. */
  speedMs: { p25: number; p50: number; p75: number; samples: number } | null;
  /** Learner's mean fit residual (m) for this route at rollup time, if learned. */
  meanResidualM: number | null;
}

export interface DayRollup {
  day: string;
  generatedAt: string;
  totals: { fixes: number; vehicles: number; routes: number; journeys: number; malformedLines: number };
  routes: Record<string, RouteDayStats>;
}

interface TraceLine {
  k: string;
  i: string;
  x: number;
  y: number;
  t: number;
}

function parseTraceLine(line: string): TraceLine | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { k, i, x, y, t } = parsed as Record<string, unknown>;
  if (typeof k !== 'string' || typeof i !== 'string') return null;
  if (typeof x !== 'number' || typeof y !== 'number' || typeof t !== 'number') return null;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(t)) return null;
  return { k, i, x, y, t };
}

interface KeyAccumulator {
  fixes: number;
  vehicles: Set<string>;
  journeys: number;
  speedHist: Uint32Array;
  speedSamples: number;
}

function quartilesFromHist(
  hist: Uint32Array,
  samples: number,
): { p25: number; p50: number; p75: number; samples: number } | null {
  if (samples === 0) return null;
  const at = (q: number): number => {
    const target = q * (samples - 1);
    let seen = 0;
    for (let b = 0; b < hist.length; b += 1) {
      seen += hist[b] ?? 0;
      if (seen > target) return Number(((b + 0.5) * SPEED_BUCKET_MS).toFixed(2));
    }
    return Number(((hist.length - 0.5) * SPEED_BUCKET_MS).toFixed(2));
  };
  return { p25: at(0.25), p50: at(0.5), p75: at(0.75), samples };
}

/**
 * One streaming pass over a day's trace lines → per-route aggregates.
 * Accepts any (a)sync iterable of JSONL lines so tests can feed arrays.
 */
export async function aggregateTraceLines(
  lines: AsyncIterable<string> | Iterable<string>,
  day: string,
): Promise<DayRollup> {
  const perKey = new Map<string, KeyAccumulator>();
  // `${k}\u0000${i}` → last accepted fix, for journey splits + speed pairs.
  const lastFix = new Map<string, { t: number; x: number; y: number }>();
  const allVehicles = new Set<string>();
  let malformedLines = 0;
  let totalFixes = 0;

  for await (const raw of lines) {
    if (raw === '') continue;
    const fix = parseTraceLine(raw);
    if (fix === null) {
      malformedLines += 1;
      continue;
    }
    let acc = perKey.get(fix.k);
    if (acc === undefined) {
      acc = {
        fixes: 0,
        vehicles: new Set(),
        journeys: 0,
        speedHist: new Uint32Array(SPEED_BUCKETS),
        speedSamples: 0,
      };
      perKey.set(fix.k, acc);
    }
    acc.fixes += 1;
    totalFixes += 1;
    acc.vehicles.add(fix.i);
    allVehicles.add(fix.i);

    const pairKey = `${fix.k}\u0000${fix.i}`;
    const prev = lastFix.get(pairKey);
    if (prev === undefined || fix.t - prev.t > JOURNEY_SPLIT_GAP_S) {
      acc.journeys += 1;
    } else if (fix.t > prev.t) {
      const dt = fix.t - prev.t;
      if (dt >= MIN_SPEED_DT_S) {
        const speed = haversineMeters(prev.y, prev.x, fix.y, fix.x) / dt;
        if (speed < MAX_SPEED_MS) {
          const bucket = Math.floor(speed / SPEED_BUCKET_MS);
          acc.speedHist[bucket] = (acc.speedHist[bucket] ?? 0) + 1;
          acc.speedSamples += 1;
        }
      }
    } else {
      // BODS occasionally rewinds RecordedAtTime; keep the newer fix as anchor.
      continue;
    }
    lastFix.set(pairKey, { t: fix.t, x: fix.x, y: fix.y });
  }

  const routes: Record<string, RouteDayStats> = {};
  let totalJourneys = 0;
  for (const [key, acc] of [...perKey.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    totalJourneys += acc.journeys;
    routes[key] = {
      fixes: acc.fixes,
      vehicles: acc.vehicles.size,
      journeys: acc.journeys,
      speedMs: quartilesFromHist(acc.speedHist, acc.speedSamples),
      meanResidualM: null,
    };
  }

  return {
    day,
    generatedAt: new Date().toISOString(),
    totals: {
      fixes: totalFixes,
      vehicles: allVehicles.size,
      routes: perKey.size,
      journeys: totalJourneys,
      malformedLines,
    },
    routes,
  };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export class RollupWriter {
  private readonly tracesDir: string;
  private readonly rollupsDir: string;
  private readonly learnedDir: string;
  private readonly log: (msg: string) => void;
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private checkTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  /** `baseDir` is the same resolved bus data dir the writer/learner use. */
  constructor(baseDir: string, log: (msg: string) => void) {
    this.tracesDir = join(baseDir, 'bus-traces');
    this.rollupsDir = join(baseDir, 'bus-rollups');
    this.learnedDir = join(baseDir, 'bus-routes', 'learned');
    this.log = log;
  }

  start(): void {
    this.startTimer = setTimeout(() => void this.catchUp(), STARTUP_DELAY_MS);
    this.startTimer.unref();
    this.checkTimer = setInterval(() => void this.catchUp(), CHECK_INTERVAL_MS);
    this.checkTimer.unref();
  }

  stop(): void {
    if (this.startTimer) clearTimeout(this.startTimer);
    if (this.checkTimer) clearInterval(this.checkTimer);
    this.startTimer = null;
    this.checkTimer = null;
  }

  /** Roll up every complete UTC day that has traces but no rollup yet. */
  async catchUp(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await mkdir(this.rollupsDir, { recursive: true });
      let names: string[];
      try {
        names = (await readdir(this.tracesDir)).filter((n) => TRACE_FILE_RE.test(n)).sort();
      } catch {
        return; // no traces dir yet — nothing to do
      }
      const today = utcDateStamp(Date.now());
      let residuals: Map<string, number> | null = null;
      for (const name of names) {
        const day = name.slice(0, 10);
        if (day >= today) continue; // still being written
        const outPath = join(this.rollupsDir, `${day}.json`);
        if (await fileExists(outPath)) continue;
        try {
          const stream = createReadStream(join(this.tracesDir, name), 'utf8');
          const rollup = await aggregateTraceLines(
            createInterface({ input: stream, crlfDelay: Infinity }),
            day,
          );
          residuals ??= await this.loadResiduals();
          for (const [key, stats] of Object.entries(rollup.routes)) {
            stats.meanResidualM = residuals.get(sanitizeKey(key)) ?? null;
          }
          // tmp + rename so a crash mid-write never leaves a truncated file
          // that the exists-check would treat as done.
          const tmpPath = `${outPath}.tmp`;
          await writeFile(tmpPath, JSON.stringify(rollup), 'utf8');
          await rename(tmpPath, outPath);
          this.log(
            `rollup: wrote ${day} — ${rollup.totals.routes} routes, ` +
              `${rollup.totals.vehicles} vehicles, ${rollup.totals.fixes} fixes`,
          );
        } catch (err) {
          // Leave the day unwritten; the hourly cycle retries while the trace
          // file survives retention.
          this.log(`rollup: ${day} failed (will retry): ${String(err)}`);
        }
      }
    } finally {
      this.running = false;
    }
  }

  /** learned/<sanitized key>.json → quality.meanResidualM, best-effort. */
  private async loadResiduals(): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    let names: string[];
    try {
      names = (await readdir(this.learnedDir)).filter(
        (n) => !n.startsWith('.') && n.endsWith('.json'),
      );
    } catch {
      return out;
    }
    for (const name of names) {
      try {
        const raw = await readFile(join(this.learnedDir, name), 'utf8');
        const parsed = JSON.parse(raw) as { quality?: { meanResidualM?: unknown } };
        const residual = parsed.quality?.meanResidualM;
        if (typeof residual === 'number' && Number.isFinite(residual)) {
          out.set(name.slice(0, -'.json'.length), residual);
        }
      } catch {
        // one unreadable learned file must not sink the rollup
      }
    }
    return out;
  }
}
