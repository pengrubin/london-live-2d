// Permanent archives of TfL feeds that have no historical endpoint — anything
// not recorded the moment it happens is lost forever. One generic snapshot
// recorder (poll → compact → dedupe → append to <base>/<subdir>/YYYY-MM-DD.jsonl,
// UTC days, never pruned) drives every such feed via a RecorderFeed config:
//
//   tube-status       — line status every 2 min, deduped + 30 min heartbeat
//                       (a quiet network costs a handful of lines per day);
//                       fetched with detail=true so each reason sentence is
//                       archived next to the NaPTAN ids TfL says it covers
//   road-disruptions  — roadworks/closures every 6 h, written unconditionally
//                       (the gold standard for validating bus diversion
//                       detection: was there a known event on that road?)
//
// Both are a few MB per year at most.

import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fetchLineStatusByModes, fetchRoadDisruptions } from './tfl-client';

const STARTUP_DELAY_MS = 10_000;
const STATUS_MODES = ['tube', 'overground', 'dlr', 'elizabeth-line', 'tram'] as const;

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
  fetchSnapshot(appKey: string): Promise<{ status: number; body: unknown }>;
  /** Untrusted upstream body → compact archived form; null = skip snapshot. */
  compact(body: unknown): unknown[] | null;
}

/** A validity window TfL attaches to a status (traffic day for live, planned window for works). */
interface ValidityPeriod {
  /** fromDate, ISO 8601. */
  f: string;
  /**
   * toDate, ISO 8601. Omitted for RealTime statuses: TfL rolls a live
   * suspension's toDate forward on every poll (measured 2026-09-02: 23:17Z →
   * 23:23Z → 00:54Z across three fetches), which would defeat the change
   * detection dedup and write a ~40 KB row every 2 minutes for the whole incident.
   */
  t?: string;
  /** isNow — whether the window covers the moment of the snapshot. */
  n?: boolean;
}

/** One TfL route section the disruption touches, as a NaPTAN stop sequence. */
interface AffectedRoute {
  id: string;
  /** Route name, e.g. "Earl's Court - Kensington (Olympia)". */
  n?: string;
  /** Direction, "inbound" / "outbound". */
  dir?: string;
  /** originationName. */
  o?: string;
  /** destinationName. */
  de?: string;
  /**
   * isEntireRouteSection. Measured 2026-09-02: true means the sequence is the
   * whole route (a line-wide status, no localisation value); false means it is
   * only the disrupted slice, contiguous ordinals, directly mappable to segments.
   */
  e?: boolean;
  /**
   * NaPTAN ids of routeSectionNaptanEntrySequence, in order. Omitted when
   * `e` is true: a whole-route list is 91% of the detail body and says nothing
   * a line id does not (measured: dropping it shrinks a window snapshot by 30%).
   */
  st?: string[];
}

/** One concurrent status on a line (a line can carry several at once). */
interface LineStatusEntry {
  /** TfL statusSeverity code — 10 is Good Service, lower is worse. */
  s: number;
  /** Human description, e.g. "Minor Delays". */
  d: string;
  /** Free-text reason; only present when TfL provides one. */
  r?: string;
  /** disruption.category, e.g. "RealTime" / "PlannedWork". */
  c?: string;
  /** disruption.closureText, e.g. "partClosure" / "severeDelays". */
  ct?: string;
  /** validityPeriods. */
  v?: ValidityPeriod[];
  /** disruption.affectedRoutes — the ground truth for "which segments" a reason sentence means. */
  ar?: AffectedRoute[];
  /** disruption.affectedStops NaPTAN ids, deduplicated, in TfL order. */
  as?: string[];
}

export interface LineSnapshot {
  id: string;
  st: LineStatusEntry[];
}

interface TflStopPoint {
  naptanId?: string;
}

interface TflRouteSectionEntry {
  stopPoint?: TflStopPoint;
}

interface TflAffectedRoute {
  id?: string;
  name?: string;
  direction?: string;
  originationName?: string;
  destinationName?: string;
  isEntireRouteSection?: boolean;
  routeSectionNaptanEntrySequence?: TflRouteSectionEntry[];
}

interface TflLineDisruption {
  category?: string;
  closureText?: string;
  affectedRoutes?: TflAffectedRoute[];
  affectedStops?: TflStopPoint[];
}

interface TflValidityPeriod {
  fromDate?: string;
  toDate?: string;
  isNow?: boolean;
}

interface TflLineStatus {
  statusSeverity?: number;
  statusSeverityDescription?: string;
  reason?: string;
  validityPeriods?: TflValidityPeriod[];
  /** affectedRoutes / affectedStops are only populated with ?detail=true. */
  disruption?: TflLineDisruption;
}

interface TflLine {
  id?: string;
  lineStatuses?: TflLineStatus[];
}

const nonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

/** `keepEnd` is false for RealTime statuses, whose toDate is a rolling stamp (see ValidityPeriod.t). */
function compactValidity(raw: unknown, keepEnd: boolean): ValidityPeriod[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const periods: ValidityPeriod[] = [];
  for (const period of raw as (TflValidityPeriod | null)[]) {
    if (!nonEmptyString(period?.fromDate)) continue;
    const compacted: ValidityPeriod = { f: period.fromDate };
    if (keepEnd && nonEmptyString(period.toDate)) compacted.t = period.toDate;
    if (period.isNow === true) compacted.n = true;
    periods.push(compacted);
  }
  return periods.length > 0 ? periods : undefined;
}

/** NaPTAN ids of a stop list, deduplicated, in upstream order. */
function naptanIds(stops: readonly (TflStopPoint | null | undefined)[]): string[] {
  const seen = new Set<string>();
  for (const stop of stops) {
    if (nonEmptyString(stop?.naptanId)) seen.add(stop.naptanId);
  }
  return [...seen];
}

function compactRoutes(raw: unknown): AffectedRoute[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const routes: AffectedRoute[] = [];
  for (const route of raw as (TflAffectedRoute | null)[]) {
    if (!nonEmptyString(route?.id)) continue;
    const compacted: AffectedRoute = { id: route.id };
    if (nonEmptyString(route.name)) compacted.n = route.name;
    if (nonEmptyString(route.direction)) compacted.dir = route.direction;
    if (nonEmptyString(route.originationName)) compacted.o = route.originationName;
    if (nonEmptyString(route.destinationName)) compacted.de = route.destinationName;
    const entire = route.isEntireRouteSection;
    if (typeof entire === 'boolean') compacted.e = entire;
    if (entire !== true) {
      const sequence = Array.isArray(route.routeSectionNaptanEntrySequence) ? route.routeSectionNaptanEntrySequence : [];
      compacted.st = naptanIds(sequence.map((entry) => entry?.stopPoint));
    }
    routes.push(compacted);
  }
  return routes.length > 0 ? routes : undefined;
}

/**
 * Structured fields TfL only populates with ?detail=true. Every key is optional
 * so snapshots recorded before detail was requested serialize identically,
 * which keeps the change-detection dedup and the archive analysis scripts stable.
 */
function compactDisruption(status: TflLineStatus): Partial<LineStatusEntry> {
  const out: Partial<LineStatusEntry> = {};
  const disruption = status.disruption;
  const isRealTime = disruption?.category === 'RealTime';
  const validity = compactValidity(status.validityPeriods, !isRealTime);
  if (validity) out.v = validity;
  if (!disruption || typeof disruption !== 'object') return out;
  if (nonEmptyString(disruption.category)) out.c = disruption.category;
  if (nonEmptyString(disruption.closureText)) out.ct = disruption.closureText;
  const routes = compactRoutes(disruption.affectedRoutes);
  if (routes) out.ar = routes;
  if (Array.isArray(disruption.affectedStops)) {
    const stops = naptanIds(disruption.affectedStops);
    if (stops.length > 0) out.as = stops;
  }
  return out;
}

/**
 * Reduces a TfL /Line/Mode/.../Status body to the compact archived form.
 * Returns null when the body is not the expected array (error payloads,
 * HTML gateways, etc.) — never trust upstream data.
 */
export function compactStatus(body: unknown): LineSnapshot[] | null {
  if (!Array.isArray(body)) return null;
  const lines: LineSnapshot[] = [];
  for (const raw of body as TflLine[]) {
    if (typeof raw?.id !== 'string' || raw.id === '') continue;
    const statuses: LineStatusEntry[] = [];
    for (const status of raw.lineStatuses ?? []) {
      if (typeof status?.statusSeverity !== 'number') continue;
      const entry: LineStatusEntry = {
        s: status.statusSeverity,
        d: typeof status.statusSeverityDescription === 'string' ? status.statusSeverityDescription : '',
      };
      const reason = typeof status.reason === 'string' ? status.reason.trim() : '';
      if (reason !== '') entry.r = reason;
      statuses.push({ ...entry, ...compactDisruption(status) });
    }
    if (statuses.length === 0) continue;
    lines.push({ id: raw.id, st: statuses });
  }
  if (lines.length === 0) return null;
  lines.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return lines;
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

export const TUBE_STATUS_FEED: RecorderFeed = {
  label: 'tube-status',
  subdir: 'tube-status',
  payloadKey: 'lines',
  pollMs: 2 * 60_000,
  heartbeatMs: 30 * 60_000,
  // detail=true pairs each reason sentence with TfL's own affectedRoutes /
  // affectedStops (NaPTAN ids): the ground truth the disruption-geolocation
  // parser is evaluated against. Without it the archive holds only prose.
  fetchSnapshot: (appKey) => fetchLineStatusByModes(STATUS_MODES, appKey, undefined, true),
  compact: compactStatus,
};

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
  private readonly log: (msg: string) => void;
  private readonly feed: RecorderFeed;
  private timer: ReturnType<typeof setInterval> | null = null;
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  /** Serialized payload of the last written snapshot, per current day file. */
  private lastSerialized: string | null = null;
  private lastWriteMs: number | null = null;
  private lastDay: string | null = null;

  constructor(baseDir: string, appKey: string, log: (msg: string) => void, feed: RecorderFeed) {
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
      const response = await this.feed.fetchSnapshot(this.appKey);
      if (response.status !== 200) {
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
