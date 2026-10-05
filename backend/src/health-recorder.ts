// The server's own /health series, so the memory model no longer depends on a
// laptop polling /health every 5 min — every hour the laptop was off was a
// permanent gap. Every HEALTH_SAMPLE_MS the recorder appends exactly what
// /health would have returned (same builder, so the two cannot drift) plus
// `at` (epoch seconds) to <base>/health-history/YYYY-MM-DD.jsonl (UTC days).
//
// Small: ~288 lines × ~1 KB per day, so files older than
// HEALTH_HISTORY_KEEP_DAYS are pruned on each UTC day rollover.
//
// Memory: the instance holds the timers, the dir string, the builder closure
// (whose referents — caches, leaderboard — are alive for the app's lifetime
// anyway) and the last day string. Each sample is serialised and dropped;
// nothing accumulates.

import { appendFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { MS_PER_DAY } from './shared/london-date';

/** /health is sampled at the cadence the laptop poller used, so the old series and this one join up. */
export const HEALTH_SAMPLE_MS = 5 * 60_000;
/** First sample ~30 s after boot so counters (caches, leaderboard sizes) are warm, not all zero. */
export const HEALTH_FIRST_SAMPLE_MS = 30_000;
/** A season of history for the memory model; at ~300 KB/day that is ~27 MB on the volume. */
export const HEALTH_HISTORY_KEEP_DAYS = 90;
export const HEALTH_HISTORY_SUBDIR = 'health-history';

const DAY_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export class HealthRecorder {
  private readonly dir: string;
  private readonly build: () => object;
  private readonly log: (msg: string) => void;
  private timer: ReturnType<typeof setInterval> | null = null;
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private lastDay: string | null = null;

  constructor(baseDir: string, build: () => object, log: (msg: string) => void) {
    this.dir = join(baseDir, HEALTH_HISTORY_SUBDIR);
    this.build = build;
    this.log = log;
  }

  start(): void {
    this.startTimer = setTimeout(() => {
      void this.sample();
      this.timer = setInterval(() => void this.sample(), HEALTH_SAMPLE_MS);
      this.timer.unref();
    }, HEALTH_FIRST_SAMPLE_MS);
    this.startTimer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.startTimer) clearTimeout(this.startTimer);
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Appends one sample. Never rejects: a full or missing volume is logged and
   * the next tick tries again — a writer must not throw into its timer.
   */
  async sample(nowMs: number = Date.now()): Promise<void> {
    if (this.stopped) return;
    try {
      const day = utcDay(nowMs);
      const line = `${JSON.stringify({ at: Math.floor(nowMs / 1000), ...this.build() })}\n`;
      await mkdir(this.dir, { recursive: true });
      await appendFile(join(this.dir, `${day}.jsonl`), line, 'utf8');
      if (day !== this.lastDay) {
        // First sample after boot counts as a rollover too, so a server that
        // restarts daily still prunes.
        this.lastDay = day;
        await this.prune(nowMs);
      }
    } catch (err) {
      this.log(`health-history: sample failed: ${String(err)}`);
    }
  }

  /** Deletes day files strictly older than KEEP_DAYS before `nowMs`'s UTC day. */
  private async prune(nowMs: number): Promise<void> {
    const cutoff = utcDay(nowMs - HEALTH_HISTORY_KEEP_DAYS * MS_PER_DAY);
    const names = await readdir(this.dir);
    for (const name of names) {
      const day = DAY_FILE_RE.exec(name)?.[1];
      if (day === undefined || day >= cutoff) continue;
      try {
        await unlink(join(this.dir, name));
      } catch (err) {
        this.log(`health-history: prune of ${name} failed: ${String(err)}`);
      }
    }
  }
}
