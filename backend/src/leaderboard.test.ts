import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { LeaderboardTracker, londonPeriodKeys, openBucketKeys } from './leaderboard';

describe('openBucketKeys', () => {
  const NOW = Date.UTC(2026, 8, 2, 9, 0);

  test('names exactly the three periods accumulating right now', () => {
    const keys = londonPeriodKeys(NOW);

    expect(openBucketKeys(NOW)).toEqual(
      new Set([`day:${keys.day}`, `week:${keys.week}`, `month:${keys.month}`]),
    );
  });

  test('a finished day is not open — that is what makes it archivable', () => {
    expect(openBucketKeys(NOW).has('day:2026-09-01')).toBe(false);
  });
});

describe('closed-day archiving', () => {
  let dir: string;
  let archiveDir: string;
  const previousPersistDir = process.env.PERSIST_DIR;

  const yesterday = (): string => {
    const now = Date.now();
    return londonPeriodKeys(now - 86_400_000).day;
  };

  function tracker(): LeaderboardTracker {
    return new LeaderboardTracker({
      log: () => {},
      archiveDir,
      getBuses: () => [],
      getVessels: () => [],
      fetchTubePredictions: async () => null,
      nrSampler: null,
      branchesByLine: new Map(),
      lineNameById: new Map(),
    });
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lb-archive-'));
    archiveDir = join(dir, 'leaderboard');
    process.env.PERSIST_DIR = dir;
  });

  afterEach(() => {
    if (previousPersistDir === undefined) delete process.env.PERSIST_DIR;
    else process.env.PERSIST_DIR = previousPersistDir;
    rmSync(dir, { recursive: true, force: true });
  });

  function writePersisted(buckets: Record<string, unknown[]>): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'leaderboard.json'), JSON.stringify({ savedAt: Date.now(), buckets }));
  }

  test('a finished day is written out in full, then released from memory', () => {
    const day = yesterday();
    const today = londonPeriodKeys(Date.now()).day;
    writePersisted({
      [`day:${day}`]: [
        { mode: 'bus', id: 'b1', label: 'route 24', m: 42_000 },
        { mode: 'tube', id: 't1', label: 'Central 004', m: 90_000 },
      ],
      [`day:${today}`]: [{ mode: 'bus', id: 'b2', label: 'route 88', m: 5_000 }],
    });

    const lb = tracker();
    lb.start();
    try {
      const archived = JSON.parse(readFileSync(join(archiveDir, `${day}.json`), 'utf8')) as {
        day: string;
        totals: Array<{ id: string; m: number }>;
      };

      // Full detail on disk — every vehicle, not a top-N summary.
      expect(archived.day).toBe(day);
      expect(archived.totals.map((t) => t.id).sort()).toEqual(['b1', 't1']);
      // …and gone from memory, which is the whole point.
      expect(lb.sizes().lbBuckets).toBe(1);
      expect(lb.sizes().lbVehicleTotals).toBe(1);
    } finally {
      lb.stop();
    }
  });

  test("today's totals survive a restart — the one thing this must never lose", () => {
    const today = londonPeriodKeys(Date.now()).day;
    writePersisted({
      [`day:${today}`]: [{ mode: 'bus', id: 'b2', label: 'route 88', m: 5_000 }],
    });

    const lb = tracker();
    lb.start();
    try {
      expect(lb.snapshot('day', 'bus').top[0]).toMatchObject({ id: 'b2', km: 5 });
    } finally {
      lb.stop();
    }
  });

  test('an existing archive is never rewritten', () => {
    const day = yesterday();
    mkdirSync(archiveDir, { recursive: true });
    writeFileSync(join(archiveDir, `${day}.json`), '{"day":"kept","totals":[]}');
    writePersisted({ [`day:${day}`]: [{ mode: 'bus', id: 'b1', label: 'route 24', m: 42_000 }] });

    const lb = tracker();
    lb.start();
    try {
      expect(existsSync(join(archiveDir, `${day}.json`))).toBe(true);
      expect(readFileSync(join(archiveDir, `${day}.json`), 'utf8')).toContain('"kept"');
      expect(lb.sizes().lbBuckets).toBe(0);
    } finally {
      lb.stop();
    }
  });
});
