// Vehicle distance leaderboard: every 15 s, sample positions of live buses
// (BODS table), ships (AIS table + TfL river vehicles) and rail vehicles
// (tube/DLR/overground/Elizabeth via the same pure arrivals→position inference
// the frontend map uses), accumulate haversine distance into period-keyed
// buckets (day / Wednesday-anchored week / month, Europe/London), and serve
// GET /api/leaderboard. Buckets persist to data/leaderboard.json so restarts
// don't wipe standings. No cron: a rollover simply starts writing a new key.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Vessel } from './ais-client';
import type { BusWire } from './bods-client';
import type { NrSampleRow } from './nr-sampler';
import type { TtlCache } from './cache';
import type { AppConfig } from './config';
import { persistPath } from './config';
import type { RateBudget } from './rate-budget';
import { fetchArrivals } from './tfl-client';
import { londonDay, MS_PER_DAY } from './shared/london-date';
import { inferTrains } from './shared/position-inference';
import type { LineBranches, Prediction } from './shared/types';

const SAMPLE_INTERVAL_MS = 15_000;
const PERSIST_INTERVAL_MS = 60_000;
/** Ignore GPS jitter below this per-sample displacement. */
const MIN_MOVE_M = 5;
/** Implied-speed sanity caps (m/s): faster deltas are feed glitches, not travel. */
const MAX_SPEED_RAIL_BUS_MS = 40;
const MAX_SPEED_SHIP_MS = 25;
/** National Rail runs InterCity stock (~200 km/h) — higher teleport guard. */
const MAX_SPEED_NR_TRAIN_MS = 65;
/** NR entries live in the train ranking but carry their own id namespace. */
const NR_TRAIN_ID_PREFIX = 'train:nr:';
/** A vehicle unseen for longer than this restarts its track (no distance credit). */
const MAX_GAP_MS = 5 * 60_000;
/** Drop last-position entries unseen for this long (bounds memory). */
const LAST_SEEN_TTL_MS = 15 * 60_000;
/** Buckets older than roughly two months are pruned from memory + disk. */
const BUCKET_RETENTION_MS = 62 * 24 * 3_600_000;
const TOP_N = 20;
/** Full-bucket rank sorts are cached this long per mode (popup opens are cheap). */
const RANK_CACHE_TTL_MS = 15_000;
const EARTH_RADIUS_M = 6_371_000;
/** Weekly period anchors on Wednesday (ISO weekday index with Sunday = 0). */
const WEEK_ANCHOR_WEEKDAY = 3;

/** TfL river services live in the trains pipeline but rank as ships. */
const RIVER_LINE_IDS = new Set(['rb1', 'rb4', 'rb6', 'woolwich-ferry']);

export type LeaderboardMode = 'tube' | 'bus' | 'ship';
export type LeaderboardPeriod = 'day' | 'week' | 'month';
const PERIODS: readonly LeaderboardPeriod[] = ['day', 'week', 'month'];

/** Public API mode values → internal entry modes ("train" ranks tube/rail). */
const API_MODES = { train: 'tube', bus: 'bus', ship: 'ship' } as const;
export type LeaderboardApiMode = keyof typeof API_MODES;

interface VehicleTotal {
  mode: LeaderboardMode;
  id: string;
  label: string;
  /** manifest line id when the vehicle belongs to a TfL line (colours the UI chip) */
  lineId?: string;
  /** cumulative metres in this bucket */
  m: number;
}

interface LastFix {
  lat: number;
  lon: number;
  at: number;
}

export interface LeaderboardRow {
  rank: number;
  mode: LeaderboardMode;
  id: string;
  label: string;
  lineId?: string;
  km: number;
}

export interface LeaderboardSnapshot {
  period: LeaderboardPeriod;
  mode: LeaderboardApiMode;
  key: string;
  /** number of tracked vehicles of the requested mode in this bucket */
  totalVehicles: number;
  top: LeaderboardRow[];
}

export interface RankInfo {
  /** 1-based rank within the mode's DAY bucket */
  rank: number;
  /** vehicles of that mode tracked today */
  total: number;
  km: number;
}

/** Cached per-mode day-bucket ranking (rebuilt at most every RANK_CACHE_TTL_MS). */
interface RankCacheEntry {
  at: number;
  dayKey: string;
  total: number;
  byId: Map<string, { rank: number; km: number }>;
}

/** Persisted file shape (data/leaderboard.json). */
interface PersistedState {
  savedAt: number;
  buckets: Record<string, VehicleTotal[]>;
}

// ── Europe/London period keys (no cron: a new key IS the rollover) ──

const LONDON_WEEKDAY = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London',
  weekday: 'short',
});
const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export interface PeriodKeys {
  day: string;
  week: string;
  month: string;
}

/**
 * Current bucket keys in Europe/London: dayKey "2026-07-24", weekKey = the
 * date of the week's Wednesday anchor, monthKey "2026-07".
 */
export function londonPeriodKeys(now: number): PeriodKeys {
  const day = londonDay(new Date(now));
  const weekdayName = LONDON_WEEKDAY.format(now).slice(0, 3);
  const weekday = WEEKDAY_INDEX[weekdayName] ?? 0;
  const daysSinceWednesday = (weekday - WEEK_ANCHOR_WEEKDAY + 7) % 7;
  const [y, m, d] = day.split('-').map(Number);
  const anchor = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1) - daysSinceWednesday * MS_PER_DAY);
  return { day, week: anchor.toISOString().slice(0, 10), month: day.slice(0, 7) };
}

/** Bucket keys for the periods still accumulating right now — the only ones
 * any API can serve, because snapshot() derives its key from the clock. */
export function openBucketKeys(now: number): Set<string> {
  const keys = londonPeriodKeys(now);
  return new Set(PERIODS.map((period) => `${period}:${keys[period]}`));
}

/** Start of a bucket ("day:2026-07-24" / "week:…" / "month:2026-07") as epoch ms. */
function bucketStartMs(bucketKey: string): number {
  const datePart = bucketKey.slice(bucketKey.indexOf(':') + 1);
  const [y, m, d] = datePart.split('-').map(Number);
  return Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1);
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

// ── data + upstream helpers used by app.ts wiring ──

interface ManifestLine {
  id: string;
  name: string;
  /** TfL mode, e.g. "tube" / "overground" / "river-bus"; absent on older manifests. */
  mode?: string;
}

/** Reads data/manifest.json + data/branches/<id>.json for the tube pipeline. */
export function loadBranchData(dataDir: string, log: (msg: string) => void): {
  branchesByLine: Map<string, LineBranches>;
  lineNameById: Map<string, string>;
  /** Only lines whose manifest row names a mode. */
  lineModeById: Map<string, string>;
  lineIds: string[];
} {
  const branchesByLine = new Map<string, LineBranches>();
  const lineNameById = new Map<string, string>();
  const lineModeById = new Map<string, string>();
  let lines: ManifestLine[] = [];
  try {
    const manifest = JSON.parse(readFileSync(join(dataDir, 'manifest.json'), 'utf8')) as {
      lines?: ManifestLine[];
    };
    lines = manifest.lines ?? [];
  } catch (err) {
    log(`leaderboard: manifest.json unreadable, tube ranking disabled: ${String(err)}`);
    return { branchesByLine, lineNameById, lineModeById, lineIds: [] };
  }
  for (const line of lines) {
    lineNameById.set(line.id, line.name);
    if (typeof line.mode === 'string') lineModeById.set(line.id, line.mode);
    try {
      const parsed = JSON.parse(
        readFileSync(join(dataDir, 'branches', `${line.id}.json`), 'utf8'),
      ) as LineBranches;
      branchesByLine.set(parsed.lineId, parsed);
    } catch (err) {
      log(`leaderboard: branches for ${line.id} unreadable, skipping: ${String(err)}`);
    }
  }
  const lineIds = [...new Set(lines.map((l) => l.id))].sort();
  return { branchesByLine, lineNameById, lineModeById, lineIds };
}

export interface ArrivalsFetcherDeps {
  config: AppConfig;
  cache: TtlCache<unknown>;
  budget: RateBudget;
  lineIds: readonly string[];
  log: (msg: string) => void;
}

/**
 * Arrivals for all manifest lines through the SAME cache + budget the
 * /api/arrivals route uses (identical cache key: sorted, deduped, comma-joined)
 * — the sampler therefore piggybacks on frontend polling instead of
 * double-spending the TfL budget, and only fetches upstream itself when the
 * cache has gone stale and budget remains.
 */
export function makeCachedArrivalsFetcher(deps: ArrivalsFetcherDeps): () => Promise<Prediction[] | null> {
  const { config, cache, budget, lineIds, log } = deps;
  const cacheKey = lineIds.join(',');
  const appKey = config.tflAppKey;
  return async (): Promise<Prediction[] | null> => {
    // No TfL key → no tube predictions; the leaderboard still ranks the modes
    // whose feeds this deployment does have (buses, vessels, National Rail).
    if (appKey === undefined || lineIds.length === 0) return null;
    const fresh = cache.getFresh(cacheKey);
    if (Array.isArray(fresh)) return fresh as Prediction[];
    if (!budget.tryConsume()) {
      const stale = cache.getStale(cacheKey);
      return Array.isArray(stale) ? (stale as Prediction[]) : null;
    }
    try {
      const upstream = await fetchArrivals(lineIds, appKey);
      if (Array.isArray(upstream.body)) {
        cache.set(cacheKey, upstream.body);
        return upstream.body as Prediction[];
      }
      log(`leaderboard: TfL arrivals returned HTTP ${upstream.status}`);
      return null;
    } catch (err) {
      log(`leaderboard: TfL arrivals fetch failed: ${String(err)}`);
      const stale = cache.getStale(cacheKey);
      return Array.isArray(stale) ? (stale as Prediction[]) : null;
    }
  };
}

// ── the tracker ──

export interface LeaderboardDeps {
  log: (msg: string) => void;
  /** Directory for per-day archives; served by /api/export/leaderboard. */
  archiveDir: string;
  getBuses: () => readonly BusWire[];
  getVessels: () => readonly Vessel[];
  fetchTubePredictions: () => Promise<Prediction[] | null>;
  /** null when DARWIN_TOKEN / the rail graph is absent — NR ranking off. */
  nrSampler: { tick(now: number): Promise<readonly NrSampleRow[]> } | null;
  branchesByLine: Map<string, LineBranches>;
  lineNameById: Map<string, string>;
}

export class LeaderboardTracker {
  /** bucketKey ("day:2026-07-24") → vehicle id → running totals */
  private buckets = new Map<string, Map<string, VehicleTotal>>();
  private last = new Map<string, LastFix>();
  /** train key → segmentKey, feeds inference hysteresis across samples */
  private prevSegments = new Map<string, string>();
  private sampleTimer: ReturnType<typeof setInterval> | null = null;
  private persistTimer: ReturnType<typeof setInterval> | null = null;
  private sampling = false;
  private dirty = false;
  private readonly filePath: string;
  private readonly deps: LeaderboardDeps;

  constructor(deps: LeaderboardDeps) {
    this.deps = deps;
    // Standings are runtime-written state: PERSIST_DIR/leaderboard.json in
    // production (a mounted volume, so it survives redeploys), else
    // data/leaderboard.json locally — identical to the previous path.
    this.filePath = persistPath('leaderboard.json');
  }

  /** Live map sizes for /health. Unlike persistenceStatus() this touches no
   * disk, so it is safe to poll. */
  sizes(): Record<string, number> {
    let vehicleTotals = 0;
    for (const bucket of this.buckets.values()) vehicleTotals += bucket.size;
    return { lbBuckets: this.buckets.size, lbVehicleTotals: vehicleTotals, lbLastFixes: this.last.size };
  }

  /** Diagnostics for the persistence path (which file, does it exist, when saved). */
  persistenceStatus(): {
    persistDirSet: boolean;
    filePath: string;
    fileExists: boolean;
    savedAt: number | null;
    buckets: number;
  } {
    let fileExists = false;
    let savedAt: number | null = null;
    try {
      const raw = readFileSync(this.filePath, 'utf8');
      fileExists = true;
      savedAt = (JSON.parse(raw) as PersistedState).savedAt ?? null;
    } catch {
      /* not written yet */
    }
    return {
      persistDirSet: Boolean(process.env.PERSIST_DIR),
      filePath: this.filePath,
      fileExists,
      savedAt,
      buckets: this.buckets.size,
    };
  }

  start(): void {
    this.load();
    void this.sample();
    this.sampleTimer = setInterval(() => void this.sample(), SAMPLE_INTERVAL_MS);
    this.sampleTimer.unref();
    this.persistTimer = setInterval(() => this.persist(), PERSIST_INTERVAL_MS);
    this.persistTimer.unref();
  }

  stop(): void {
    if (this.sampleTimer) clearInterval(this.sampleTimer);
    if (this.persistTimer) clearInterval(this.persistTimer);
    this.sampleTimer = null;
    this.persistTimer = null;
    this.persist();
  }

  snapshot(
    period: LeaderboardPeriod,
    mode: LeaderboardApiMode,
    now: number = Date.now(),
  ): LeaderboardSnapshot {
    const key = londonPeriodKeys(now)[period];
    const bucket = this.buckets.get(`${period}:${key}`);
    const internalMode = API_MODES[mode];
    const totals = bucket ? [...bucket.values()].filter((t) => t.mode === internalMode) : [];
    const top = totals
      .sort((a, b) => b.m - a.m)
      .slice(0, TOP_N)
      .map((entry, index) => ({
        rank: index + 1,
        mode: entry.mode,
        id: entry.id,
        label: entry.label,
        ...(entry.lineId !== undefined ? { lineId: entry.lineId } : {}),
        km: Math.round(entry.m / 100) / 10,
      }));
    return { period, mode, key, totalVehicles: totals.length, top };
  }

  private rankCache = new Map<LeaderboardApiMode, RankCacheEntry>();

  /** Rank of one entry within its mode's DAY bucket, or null when unknown. */
  rank(mode: LeaderboardApiMode, id: string, now: number = Date.now()): RankInfo | null {
    const dayKey = londonPeriodKeys(now).day;
    let cached = this.rankCache.get(mode);
    if (!cached || cached.dayKey !== dayKey || now - cached.at > RANK_CACHE_TTL_MS) {
      const bucket = this.buckets.get(`day:${dayKey}`);
      const internalMode = API_MODES[mode];
      const sorted = bucket
        ? [...bucket.values()].filter((t) => t.mode === internalMode).sort((a, b) => b.m - a.m)
        : [];
      const byId = new Map(
        sorted.map((t, i) => [t.id, { rank: i + 1, km: Math.round(t.m / 100) / 10 }]),
      );
      cached = { at: now, dayKey, total: sorted.length, byId };
      this.rankCache.set(mode, cached);
    }
    const entry = cached.byId.get(id);
    return entry ? { rank: entry.rank, total: cached.total, km: entry.km } : null;
  }

  // ── sampling ──

  private async sample(): Promise<void> {
    if (this.sampling) return; // a slow TfL fetch must not stack samples
    this.sampling = true;
    try {
      const now = Date.now();
      const keys = londonPeriodKeys(now);
      this.sampleBuses(now, keys);
      this.sampleVessels(now, keys);
      await this.sampleTrains(now, keys);
      await this.sampleNrTrains(now, keys);
      this.pruneLastFixes(now);
    } catch (err) {
      this.deps.log(`leaderboard sample error: ${String(err)}`);
    } finally {
      this.sampling = false;
    }
  }

  private sampleBuses(now: number, keys: PeriodKeys): void {
    for (const bus of this.deps.getBuses()) {
      // bus.i is operator-qualified ("OPERATOR:VehicleRef") — show the fleet
      // ref so two vehicles on the same route stay distinguishable.
      const ref = bus.i.slice(bus.i.indexOf(':') + 1);
      const label = bus.l ? `Bus ${bus.l} · ${ref}` : `Bus ${ref}`;
      this.record('bus', `bus:${bus.i}`, label, undefined, bus.y, bus.x, now, keys);
    }
  }

  private sampleVessels(_now: number, keys: PeriodKeys): void {
    for (const vessel of this.deps.getVessels()) {
      const label = vessel.name || `MMSI ${vessel.mmsi}`;
      // Credit against the AIS fix time (lastSeen), NOT the sample tick: the
      // vessel table holds its last position through delivery gaps, so
      // tick-time crediting compresses the whole gap's real movement into one
      // 15 s window and the implied speed trips the ship teleport guard —
      // silently discarding most of a vessel's travel. With the fix time,
      // repeats of an unchanged fix yield gapMs = 0 (no-ops) and the catch-up
      // jump is divided by the true elapsed time.
      this.record('ship', `ship:${vessel.mmsi}`, label, undefined, vessel.lat, vessel.lon, vessel.lastSeen, keys);
    }
  }

  private async sampleTrains(now: number, keys: PeriodKeys): Promise<void> {
    const preds = await this.deps.fetchTubePredictions();
    if (!preds) return;
    const trains = inferTrains(preds, this.deps.branchesByLine, this.prevSegments);
    const nextSegments = new Map<string, string>();
    for (const train of trains) {
      if (train.segmentKey) nextSegments.set(train.key, train.segmentKey);
      // Synthetic keys (identity from currentLocation, not a vehicleId) are
      // unstable across polls — crediting them would invent distance.
      if (train.synthetic || !train.vehicleId) continue;
      const lineName = this.deps.lineNameById.get(train.lineId) ?? train.lineName;
      const isRiver = RIVER_LINE_IDS.has(train.lineId);
      const mode: LeaderboardMode = isRiver ? 'ship' : 'tube';
      const id = `${isRiver ? 'ship:tfl' : 'tube'}:${train.lineId}:${train.vehicleId}`;
      const label = `${lineName} ${train.vehicleId}`;
      this.record(mode, id, label, train.lineId, train.lngLat[1], train.lngLat[0], now, keys);
    }
    this.prevSegments = nextSegments;
  }

  /** National Rail trains rank alongside tube ("train" API mode). */
  private async sampleNrTrains(now: number, keys: PeriodKeys): Promise<void> {
    const sampler = this.deps.nrSampler;
    if (!sampler) return;
    const rows = await sampler.tick(now);
    for (const row of rows) {
      this.record('tube', row.id, row.label, undefined, row.lat, row.lon, now, keys);
    }
  }

  private record(
    mode: LeaderboardMode,
    id: string,
    label: string,
    lineId: string | undefined,
    lat: number,
    lon: number,
    now: number,
    keys: PeriodKeys,
  ): void {
    const prev = this.last.get(id);
    this.last.set(id, { lat, lon, at: now });
    if (!prev) return;
    const gapMs = now - prev.at;
    if (gapMs <= 0 || gapMs > MAX_GAP_MS) return; // long silence → restart track
    const meters = haversineMeters(prev.lat, prev.lon, lat, lon);
    if (meters < MIN_MOVE_M) return; // GPS/inference jitter
    const maxSpeed =
      mode === 'ship'
        ? MAX_SPEED_SHIP_MS
        : id.startsWith(NR_TRAIN_ID_PREFIX)
          ? MAX_SPEED_NR_TRAIN_MS
          : MAX_SPEED_RAIL_BUS_MS;
    if (meters / (gapMs / 1000) > maxSpeed) return; // teleport → feed glitch
    for (const period of PERIODS) {
      const bucketKey = `${period}:${keys[period]}`;
      let bucket = this.buckets.get(bucketKey);
      if (!bucket) {
        bucket = new Map<string, VehicleTotal>();
        this.buckets.set(bucketKey, bucket);
      }
      const entry = bucket.get(id);
      if (entry) {
        entry.m += meters;
        entry.label = label; // keep the freshest display label
      } else {
        bucket.set(id, { mode, id, label, ...(lineId !== undefined ? { lineId } : {}), m: meters });
      }
    }
    this.dirty = true;
  }

  private pruneLastFixes(now: number): void {
    const cutoff = now - LAST_SEEN_TTL_MS;
    for (const [id, fix] of this.last) {
      if (fix.at < cutoff) this.last.delete(id);
    }
  }

  // ── persistence ──

  private load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, 'utf8');
    } catch {
      return; // first boot: nothing persisted yet
    }
    try {
      const state = JSON.parse(raw) as PersistedState;
      for (const [bucketKey, totals] of Object.entries(state.buckets ?? {})) {
        const bucket = new Map<string, VehicleTotal>();
        for (const total of totals) {
          if (typeof total?.id === 'string' && Number.isFinite(total.m)) bucket.set(total.id, total);
        }
        if (bucket.size > 0) this.buckets.set(bucketKey, bucket);
      }
      const { archived, dropped } = this.archiveAndDropClosedBuckets(Date.now());
      this.pruneOldBuckets(Date.now());
      this.deps.log(
        `leaderboard: loaded ${this.buckets.size} open bucket(s) from ${this.filePath}` +
          (dropped > 0 ? `, archived ${archived} day(s) and released ${dropped} closed bucket(s)` : ''),
      );
    } catch (err) {
      this.deps.log(`leaderboard: persisted state unreadable, starting fresh: ${String(err)}`);
    }
  }

  private persist(): void {
    if (!this.dirty) return;
    this.archiveAndDropClosedBuckets(Date.now());
    this.pruneOldBuckets(Date.now());
    const state: PersistedState = { savedAt: Date.now(), buckets: {} };
    for (const [bucketKey, bucket] of this.buckets) {
      state.buckets[bucketKey] = [...bucket.values()];
    }
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const tmpPath = `${this.filePath}.tmp`;
      writeFileSync(tmpPath, JSON.stringify(state));
      renameSync(tmpPath, this.filePath); // atomic on POSIX: readers never see a torn file
      this.dirty = false;
    } catch (err) {
      this.deps.log(`leaderboard persist failed: ${String(err)}`);
    }
  }

  /**
   * Closed periods leave memory entirely. A finished day is written to
   * <archiveDir>/YYYY-MM-DD.json first — full per-vehicle detail, which
   * /api/export serves and the local archive syncs — so nothing is lost by
   * dropping it here. Week and month buckets are not archived because they
   * are sums of their days: one sample credits all three at once.
   *
   * A bucket whose archive could not be written stays in memory and is
   * retried on the next tick. Losing a day to a transient disk error would
   * be a far worse trade than holding it a minute longer.
   */
  private archiveAndDropClosedBuckets(now: number): { archived: number; dropped: number } {
    const open = openBucketKeys(now);
    let archived = 0;
    let dropped = 0;
    for (const [bucketKey, bucket] of this.buckets) {
      if (open.has(bucketKey)) continue;
      if (bucketKey.startsWith('day:')) {
        const outcome = this.writeDayArchive(bucketKey.slice('day:'.length), bucket);
        if (outcome === 'failed') continue;
        if (outcome === 'written') archived += 1;
      }
      this.buckets.delete(bucketKey);
      dropped += 1;
    }
    return { archived, dropped };
  }

  private writeDayArchive(
    day: string,
    bucket: ReadonlyMap<string, VehicleTotal>,
  ): 'written' | 'exists' | 'failed' {
    const path = join(this.deps.archiveDir, `${day}.json`);
    try {
      // Never rewrite: a finished day cannot change, and the local archive
      // skips files it already has.
      if (existsSync(path)) return 'exists';
      mkdirSync(this.deps.archiveDir, { recursive: true });
      const tmpPath = `${path}.tmp`;
      writeFileSync(tmpPath, JSON.stringify({ day, savedAt: Date.now(), totals: [...bucket.values()] }));
      renameSync(tmpPath, path);
      return 'written';
    } catch (err) {
      this.deps.log(`leaderboard: archiving ${day} failed, keeping it in memory: ${String(err)}`);
      return 'failed';
    }
  }

  private pruneOldBuckets(now: number): void {
    for (const bucketKey of this.buckets.keys()) {
      if (now - bucketStartMs(bucketKey) > BUCKET_RETENTION_MS) this.buckets.delete(bucketKey);
    }
  }
}

// ── route ──

interface LeaderboardQuery {
  readonly period?: string;
  readonly mode?: string;
}

interface RankQuery {
  readonly mode?: string;
  readonly id?: string;
}

function isPeriod(value: string): value is LeaderboardPeriod {
  return (PERIODS as readonly string[]).includes(value);
}

function isApiMode(value: string): value is LeaderboardApiMode {
  return value in API_MODES;
}

export function registerLeaderboardRoute(app: FastifyInstance, tracker: LeaderboardTracker): void {
  app.get<{ Querystring: LeaderboardQuery }>('/api/leaderboard', async (request, reply) => {
    const rawPeriod = request.query.period ?? 'day';
    if (!isPeriod(rawPeriod)) {
      return reply
        .code(400)
        .send({ error: 'Query parameter "period" must be one of: day, week, month.' });
    }
    const rawMode = request.query.mode;
    if (rawMode === undefined || !isApiMode(rawMode)) {
      return reply
        .code(400)
        .send({ error: 'Query parameter "mode" is required and must be one of: train, bus, ship.' });
    }
    return tracker.snapshot(rawPeriod, rawMode);
  });

  app.get<{ Querystring: RankQuery }>('/api/leaderboard-rank', async (request, reply) => {
    const rawMode = request.query.mode;
    if (rawMode === undefined || !isApiMode(rawMode)) {
      return reply
        .code(400)
        .send({ error: 'Query parameter "mode" is required and must be one of: train, bus, ship.' });
    }
    const rawId = request.query.id;
    if (rawId === undefined || rawId.length === 0) {
      return reply.code(400).send({ error: 'Query parameter "id" is required.' });
    }
    // Accept the public "train:" spelling for tube/rail entry ids too —
    // except "train:nr:*", which is a National Rail id stored verbatim.
    const id =
      rawId.startsWith('train:') && !rawId.startsWith(NR_TRAIN_ID_PREFIX)
        ? `tube:${rawId.slice('train:'.length)}`
        : rawId;
    const info = tracker.rank(rawMode, id);
    if (!info) return reply.code(404).send({ error: 'No ranking for that vehicle today.' });
    return info;
  });
}
