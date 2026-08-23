// Permanent archive of TfL line status. TfL's Unified API only serves the
// present moment — there is no historical endpoint — so any analysis of how
// disruptions start, spread, and recover needs its own recording, started as
// early as possible. Snapshots are appended to <base>/tube-status/YYYY-MM-DD.jsonl
// (UTC days), deduplicated against the previous snapshot so a quiet network
// costs a handful of lines per day. Nothing here is ever pruned: a full year
// of status history is a few MB.

import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fetchLineStatusByModes } from './tfl-client';

const POLL_INTERVAL_MS = 2 * 60_000;
/** Unchanged status is still written this often, so gaps mean "recorder down". */
const HEARTBEAT_INTERVAL_MS = 30 * 60_000;
const STARTUP_DELAY_MS = 10_000;
const STATUS_MODES = ['tube', 'overground', 'dlr', 'elizabeth-line', 'tram'] as const;
const SUBDIR = 'tube-status';

/** One concurrent status on a line (a line can carry several at once). */
interface LineStatusEntry {
  /** TfL statusSeverity code — 10 is Good Service, lower is worse. */
  s: number;
  /** Human description, e.g. "Minor Delays". */
  d: string;
  /** Free-text reason; only present when TfL provides one. */
  r?: string;
}

export interface LineSnapshot {
  id: string;
  st: LineStatusEntry[];
}

interface TflLineStatus {
  statusSeverity?: number;
  statusSeverityDescription?: string;
  reason?: string;
}

interface TflLine {
  id?: string;
  lineStatuses?: TflLineStatus[];
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
      statuses.push(entry);
    }
    if (statuses.length === 0) continue;
    lines.push({ id: raw.id, st: statuses });
  }
  if (lines.length === 0) return null;
  lines.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return lines;
}

/**
 * A snapshot is written when the status changed, when the heartbeat interval
 * elapsed, or when nothing has been written yet (fresh start / new day file).
 */
export function shouldWrite(
  prevSerialized: string | null,
  nextSerialized: string,
  lastWriteMs: number | null,
  nowMs: number,
): boolean {
  if (prevSerialized === null || lastWriteMs === null) return true;
  if (nextSerialized !== prevSerialized) return true;
  return nowMs - lastWriteMs >= HEARTBEAT_INTERVAL_MS;
}

export class TubeStatusRecorder {
  private readonly dir: string;
  private readonly appKey: string;
  private readonly log: (msg: string) => void;
  private timer: ReturnType<typeof setInterval> | null = null;
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  /** Serialized `lines` of the last written snapshot, per current day file. */
  private lastSerialized: string | null = null;
  private lastWriteMs: number | null = null;
  private lastDay: string | null = null;

  constructor(baseDir: string, appKey: string, log: (msg: string) => void) {
    this.dir = join(baseDir, SUBDIR);
    this.appKey = appKey;
    this.log = log;
  }

  start(): void {
    this.startTimer = setTimeout(() => {
      void this.poll();
      this.timer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
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
      const response = await fetchLineStatusByModes(STATUS_MODES, this.appKey);
      if (response.status !== 200) {
        this.log(`tube-status: TfL returned ${response.status}, skipping snapshot`);
        return;
      }
      const lines = compactStatus(response.body);
      if (lines === null) {
        this.log('tube-status: unrecognised TfL payload, skipping snapshot');
        return;
      }
      await this.record(lines, Date.now());
    } catch (err) {
      this.log(`tube-status: poll failed: ${String(err)}`);
    }
  }

  private async record(lines: LineSnapshot[], nowMs: number): Promise<void> {
    const day = new Date(nowMs).toISOString().slice(0, 10);
    if (day !== this.lastDay) {
      // Each day file opens with an unconditional snapshot so it reads standalone.
      this.lastDay = day;
      this.lastSerialized = null;
      this.lastWriteMs = null;
    }
    const serialized = JSON.stringify(lines);
    if (!shouldWrite(this.lastSerialized, serialized, this.lastWriteMs, nowMs)) return;
    await mkdir(this.dir, { recursive: true });
    const line = `{"t":${Math.floor(nowMs / 1000)},"lines":${serialized}}\n`;
    await appendFile(join(this.dir, `${day}.jsonl`), line, 'utf8');
    this.lastSerialized = serialized;
    this.lastWriteMs = nowMs;
  }
}
