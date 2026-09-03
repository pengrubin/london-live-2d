// Permanent archives of TfL feeds that have no historical endpoint — anything
// not recorded the moment it happens is lost forever. One generic snapshot
// recorder (poll → compact → dedupe → append to <base>/<subdir>/YYYY-MM-DD.jsonl,
// UTC days, never pruned) drives every such feed via a RecorderFeed config:
//
//   tube-status       — line status every 2 min, deduped + 30 min heartbeat
//                       (a quiet network costs a handful of lines per day);
//                       fetched through the date-window form with detail=true
//                       so each reason sentence is archived next to the NaPTAN
//                       ids TfL says it covers, planned works days ahead included
//   road-disruptions  — roadworks/closures every 6 h, written unconditionally
//                       (the gold standard for validating bus diversion
//                       detection: was there a known event on that road?)
//
// Both are a few MB per year at most.

import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { compactStatus } from './disruptions/tfl-status-shape';
import { londonDay, MS_PER_DAY } from './shared/london-date';
import {
  fetchLineStatusByModes,
  fetchLineStatusWindow,
  fetchRoadDisruptions,
  type TflResponse,
} from './tfl-client';

// The archive's line-status shape lives in disruptions/tfl-status-shape.ts so
// the disruptions route can share it; the recorder stays the import path the
// archive scripts and tests know.
export { compactStatus } from './disruptions/tfl-status-shape';
export type {
  AffectedRoute,
  LineSnapshot,
  LineStatusEntry,
  ValidityPeriod,
} from './disruptions/tfl-status-shape';

export const STARTUP_DELAY_MS = 10_000;
const HTTP_OK = 200;

/** TfL modes of every rail line the tube-status archive covers — the Mode-form fallback URL. */
export const STATUS_MODES: readonly string[] = ['tube', 'overground', 'dlr', 'elizabeth-line', 'tram'];

/**
 * Bounds of the date-window status call. Yesterday, so a live status that
 * began before London midnight is not lost at the day boundary; a week ahead,
 * so planned works are archived with their structured fields days before
 * they start (the Mode form returns only what is live now).
 */
const WINDOW_LOOKBACK_DAYS = 1;
const WINDOW_LOOKAHEAD_DAYS = 7;

const TUBE_STATUS_LABEL = 'tube-status';

/** How a feed reports; the recorder's own logger, prefixed by the feed label. */
export type FeedLog = (msg: string) => void;

/** One archived feed: where it lands, how often, and how to shrink it. */
export interface RecorderFeed {
  /** Log prefix and human name. */
  readonly label: string;
  /** Directory under the bus data dir day files append into. */
  readonly subdir: string;
  /** JSON key the compacted payload is written under. */
  readonly payloadKey: string;
  readonly pollMs: number;
  /** Unchanged payloads are still written this often (0 = write every poll). */
  readonly heartbeatMs: number;
  fetchSnapshot(appKey: string, log: FeedLog): Promise<{ status: number; body: unknown }>;
  /** Untrusted upstream body → compact archived form; null = skip snapshot. */
  compact(body: unknown): unknown[] | null;
}

/** Compact archived form of one TfL road disruption. */
export interface DisruptionSnapshot {
  id: string;
  /** category, e.g. Works / Incident / Event. */
  cat?: string;
  /** severity, e.g. Serious / Moderate / Minimal. */
  sev?: string;
  /** location text, truncated. */
  loc?: string;
  /** comments text, truncated. */
  com?: string;
  /** startDateTime / endDateTime as provided (ISO strings). */
  start?: string;
  end?: string;
  /** TfL point, a "[lon,lat]" string — kept verbatim for geo matching. */
  pt?: string;
}

const LOC_MAX = 200;
const COM_MAX = 300;

interface TflDisruption {
  id?: string;
  category?: string;
  severity?: string;
  location?: string;
  comments?: string;
  startDateTime?: string;
  endDateTime?: string;
  point?: string;
}

/**
 * Reduces a TfL /Road/all/Disruption body to the compact archived form.
 * An empty array is VALID (a genuinely quiet network) and is recorded as
 * such; only a non-array payload returns null.
 */
export function compactDisruptions(body: unknown): DisruptionSnapshot[] | null {
  if (!Array.isArray(body)) return null;
  const out: DisruptionSnapshot[] = [];
  for (const raw of body as TflDisruption[]) {
    if (typeof raw?.id !== 'string' || raw.id === '') continue;
    const entry: DisruptionSnapshot = { id: raw.id };
    if (typeof raw.category === 'string') entry.cat = raw.category;
    if (typeof raw.severity === 'string') entry.sev = raw.severity;
    if (typeof raw.location === 'string') entry.loc = raw.location.slice(0, LOC_MAX);
    if (typeof raw.comments === 'string') entry.com = raw.comments.slice(0, COM_MAX);
    if (typeof raw.startDateTime === 'string') entry.start = raw.startDateTime;
    if (typeof raw.endDateTime === 'string') entry.end = raw.endDateTime;
    if (typeof raw.point === 'string') entry.pt = raw.point;
    out.push(entry);
  }
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

/**
 * A snapshot is written when the payload changed, when the heartbeat interval
 * elapsed (0 = every poll), or when nothing has been written yet (fresh
 * start / new day file).
 */
export function shouldWrite(
  prevSerialized: string | null,
  nextSerialized: string,
  lastWriteMs: number | null,
  nowMs: number,
  heartbeatMs: number,
): boolean {
  if (prevSerialized === null || lastWriteMs === null) return true;
  if (nextSerialized !== prevSerialized) return true;
  return nowMs - lastWriteMs >= heartbeatMs;
}

/** The manifest lines the tube-status archive covers: rail modes only, never cable car or river bus. */
export function statusLineIds(lineIds: readonly string[], modeById: ReadonlyMap<string, string>): string[] {
  return lineIds.filter((id) => STATUS_MODES.includes(modeById.get(id) ?? ''));
}

/**
 * Window form first; the Mode form only when TfL refuses the window (its
 * body is live statuses only, so the archive would lose planned works). The
 * refusal is logged on purpose: a window form that fails every poll — a
 * changed TfL route, a bad id list — must show up, not hide behind a
 * working fallback.
 */
async function fetchTubeStatus(lineIds: readonly string[], appKey: string, log: FeedLog): Promise<TflResponse> {
  const nowMs = Date.now();
  const fromDate = londonDay(new Date(nowMs - WINDOW_LOOKBACK_DAYS * MS_PER_DAY));
  const toDate = londonDay(new Date(nowMs + WINDOW_LOOKAHEAD_DAYS * MS_PER_DAY));
  const window = await fetchLineStatusWindow(lineIds, fromDate, toDate, appKey);
  if (window.status === HTTP_OK) return window;
  log(`${TUBE_STATUS_LABEL}: window form returned ${window.status}, falling back to /Line/Mode/${STATUS_MODES.join(',')}/Status`);
  return fetchLineStatusByModes(STATUS_MODES, appKey, undefined, true);
}

/**
 * The line-status archive feed. A factory rather than a constant because the
 * window form names its lines explicitly, and the ids come from
 * data/manifest.json, which app.ts owns.
 */
export function makeTubeStatusFeed(lineIds: readonly string[]): RecorderFeed {
  return {
    label: TUBE_STATUS_LABEL,
    subdir: 'tube-status',
    payloadKey: 'lines',
    pollMs: 2 * 60_000,
    heartbeatMs: 30 * 60_000,
    // detail=true pairs each reason sentence with TfL's own affectedRoutes /
    // affectedStops (NaPTAN ids): the ground truth the disruption-geolocation
    // parser is evaluated against. Without it the archive holds only prose.
    fetchSnapshot: (appKey, log) => fetchTubeStatus(lineIds, appKey, log),
    compact: compactStatus,
  };
}

export const ROAD_DISRUPTIONS_FEED: RecorderFeed = {
  label: 'road-disruptions',
  subdir: 'road-disruptions',
  payloadKey: 'disruptions',
  pollMs: 6 * 60 * 60_000,
  // Every poll is written: 4 snapshots/day is the whole point (how the
  // disruption set evolved), and dedupe would save almost nothing.
  heartbeatMs: 0,
  fetchSnapshot: (appKey) => fetchRoadDisruptions(appKey),
  compact: compactDisruptions,
};

export class SnapshotRecorder {
  private readonly dir: string;
  private readonly appKey: string;
  private readonly log: FeedLog;
  private readonly feed: RecorderFeed;
  private timer: ReturnType<typeof setInterval> | null = null;
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  /** Serialized payload of the last written snapshot, per current day file. */
  private lastSerialized: string | null = null;
  private lastWriteMs: number | null = null;
  private lastDay: string | null = null;

  constructor(baseDir: string, appKey: string, log: FeedLog, feed: RecorderFeed) {
    this.dir = join(baseDir, feed.subdir);
    this.appKey = appKey;
    this.log = log;
    this.feed = feed;
  }

  start(): void {
    this.startTimer = setTimeout(() => {
      void this.poll();
      this.timer = setInterval(() => void this.poll(), this.feed.pollMs);
      this.timer.unref();
    }, STARTUP_DELAY_MS);
    this.startTimer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.startTimer) clearTimeout(this.startTimer);
    if (this.timer) clearInterval(this.timer);
  }

  private async poll(): Promise<void> {
    if (this.stopped) return;
    try {
      const response = await this.feed.fetchSnapshot(this.appKey, this.log);
      if (response.status !== HTTP_OK) {
        this.log(`${this.feed.label}: TfL returned ${response.status}, skipping snapshot`);
        return;
      }
      const payload = this.feed.compact(response.body);
      if (payload === null) {
        this.log(`${this.feed.label}: unrecognised TfL payload, skipping snapshot`);
        return;
      }
      await this.record(payload, Date.now());
    } catch (err) {
      this.log(`${this.feed.label}: poll failed: ${String(err)}`);
    }
  }

  private async record(payload: unknown[], nowMs: number): Promise<void> {
    const day = new Date(nowMs).toISOString().slice(0, 10);
    if (day !== this.lastDay) {
      // Each day file opens with an unconditional snapshot so it reads standalone.
      this.lastDay = day;
      this.lastSerialized = null;
      this.lastWriteMs = null;
    }
    const serialized = JSON.stringify(payload);
    if (!shouldWrite(this.lastSerialized, serialized, this.lastWriteMs, nowMs, this.feed.heartbeatMs)) {
      return;
    }
    await mkdir(this.dir, { recursive: true });
    const line = `{"t":${Math.floor(nowMs / 1000)},"${this.feed.payloadKey}":${serialized}}\n`;
    await appendFile(join(this.dir, `${day}.jsonl`), line, 'utf8');
    this.lastSerialized = serialized;
    this.lastWriteMs = nowMs;
  }
}
