// Append-only bus GPS trace log for the route learner.
//
// Every BODS poll hands its fixes to `record()`; new fixes (RecordedAtTime
// changed for that vehicle) are buffered as JSONL lines and flushed to
// data/bus-traces/YYYY-MM-DD.jsonl by a background timer — the poll loop
// never touches the filesystem. One line per fix:
//   {"k":"OPERATOR:line:direction","i":"OPERATOR:vehicleRef","x":lon,"y":lat,"t":epochSeconds}
// Journey continuity comes from `i` + timestamps: the learner groups by
// (k, i) and splits journeys on time gaps.
//
// Retention: files rotate daily (UTC), files older than RETENTION_DAYS are
// deleted, and total directory size is capped at MAX_TOTAL_BYTES by dropping
// the oldest files first.

import { appendFile, mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Bus } from './bods-client';

const FLUSH_INTERVAL_MS = 5_000;
const MAINTENANCE_INTERVAL_MS = 60 * 60_000;
const RETENTION_DAYS = 7;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB
/** Forget per-vehicle "last written fix time" after this long unseen. */
const SEEN_TTL_MS = 30 * 60_000;
/** Hard ceiling on buffered lines if the disk stalls — drop, don't grow. */
const MAX_BUFFERED_LINES = 500_000;

const TRACE_FILE_RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

function utcDateStamp(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Trace key: OPERATOR:line:direction (direction already normalized). */
export function traceKey(operator: string, line: string, direction: string): string {
  return `${operator}:${line}:${direction}`;
}

export class TraceWriter {
  private readonly dir: string;
  private readonly log: (msg: string) => void;
  /** Pending JSONL lines (without trailing newline). */
  private buffer: string[] = [];
  /** vehicleId → recordedAt of the last fix written (dedup across polls). */
  private lastWritten = new Map<string, number>();
  /** vehicleId → wall time last seen, for pruning lastWritten. */
  private lastSeen = new Map<string, number>();
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private maintenanceTimer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;
  private droppedLines = 0;

  constructor(dir: string, log: (msg: string) => void) {
    this.dir = dir;
    this.log = log;
  }

  start(): void {
    this.flushTimer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
    this.flushTimer.unref();
    this.maintenanceTimer = setInterval(() => void this.maintain(), MAINTENANCE_INTERVAL_MS);
    this.maintenanceTimer.unref();
    void this.maintain();
  }

  stop(): void {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    this.flushTimer = null;
    this.maintenanceTimer = null;
    void this.flush();
  }

  /** Buffer new fixes from one poll. Synchronous, allocation-only — no IO. */
  record(buses: readonly Bus[], now: number): void {
    for (const bus of buses) {
      if (bus.line === '') continue;
      this.lastSeen.set(bus.id, now);
      if (this.lastWritten.get(bus.id) === bus.recordedAt) continue;
      this.lastWritten.set(bus.id, bus.recordedAt);
      if (this.buffer.length >= MAX_BUFFERED_LINES) {
        this.droppedLines += 1;
        continue;
      }
      const key = traceKey(bus.operator, bus.line, bus.direction);
      this.buffer.push(
        `{"k":${JSON.stringify(key)},"i":${JSON.stringify(bus.id)},"x":${bus.lon},"y":${bus.lat},"t":${Math.round(bus.recordedAt / 1000)}}`,
      );
    }
    this.pruneSeen(now);
  }

  private pruneSeen(now: number): void {
    if (this.lastSeen.size < 20_000) return;
    const cutoff = now - SEEN_TTL_MS;
    for (const [id, seen] of this.lastSeen) {
      if (seen < cutoff) {
        this.lastSeen.delete(id);
        this.lastWritten.delete(id);
      }
    }
  }

  /** Write buffered lines to the current UTC-dated file. */
  private async flush(): Promise<void> {
    if (this.flushing || this.buffer.length === 0) return;
    this.flushing = true;
    const lines = this.buffer;
    this.buffer = [];
    try {
      await mkdir(this.dir, { recursive: true });
      const file = join(this.dir, `${utcDateStamp(Date.now())}.jsonl`);
      await appendFile(file, `${lines.join('\n')}\n`, 'utf8');
      if (this.droppedLines > 0) {
        this.log(`trace writer: dropped ${this.droppedLines} lines (buffer full)`);
        this.droppedLines = 0;
      }
    } catch (err) {
      // Losing a batch is fine; blocking or ballooning memory is not.
      this.log(`trace flush failed (batch of ${lines.length} dropped): ${String(err)}`);
    } finally {
      this.flushing = false;
    }
  }

  /** Delete traces older than the retention window; enforce the size cap. */
  private async maintain(): Promise<void> {
    try {
      await mkdir(this.dir, { recursive: true });
      const names = (await readdir(this.dir)).filter((n) => TRACE_FILE_RE.test(n)).sort();
      const cutoffStamp = utcDateStamp(Date.now() - RETENTION_DAYS * 86_400_000);
      const kept: { name: string; size: number }[] = [];
      for (const name of names) {
        const path = join(this.dir, name);
        if (name.slice(0, 10) < cutoffStamp) {
          await unlink(path);
          this.log(`trace retention: deleted ${name}`);
          continue;
        }
        const info = await stat(path);
        kept.push({ name, size: info.size });
      }
      let total = kept.reduce((sum, f) => sum + f.size, 0);
      // Oldest-first (kept is sorted by date-stamped name) until under the cap.
      for (const file of kept) {
        if (total <= MAX_TOTAL_BYTES) break;
        await unlink(join(this.dir, file.name));
        total -= file.size;
        this.log(`trace size cap: deleted ${file.name}`);
      }
    } catch (err) {
      this.log(`trace maintenance failed: ${String(err)}`);
    }
  }
}
