import { describe, expect, test } from 'vitest';
import {
  compactBucket,
  londonPeriodKeys,
  openBucketKeys,
  type VehicleTotal,
} from './leaderboard';

const NOW = Date.UTC(2026, 8, 2, 9, 0); // 2026-09-02, a Wednesday

function bucket(entries: readonly VehicleTotal[]): Map<string, VehicleTotal> {
  return new Map(entries.map((entry) => [entry.id, entry]));
}

const totals = (mode: VehicleTotal['mode'], count: number, from = 0): VehicleTotal[] =>
  Array.from({ length: count }, (_, i) => ({
    mode,
    id: `${mode}-${i}`,
    label: `${mode} ${i}`,
    m: from + i, // higher index ⇒ further travelled
  }));

describe('openBucketKeys', () => {
  test('names exactly the three periods accumulating right now', () => {
    const keys = londonPeriodKeys(NOW);

    expect(openBucketKeys(NOW)).toEqual(
      new Set([`day:${keys.day}`, `week:${keys.week}`, `month:${keys.month}`]),
    );
  });

  test('yesterday is not open — that is what makes it compactable', () => {
    expect(openBucketKeys(NOW).has('day:2026-09-01')).toBe(false);
  });
});

describe('compactBucket', () => {
  test('keeps the top N of EVERY mode, not the top N overall', () => {
    // Tube vehicles cover far more ground, so a global cut would erase ships.
    const full = bucket([...totals('tube', 300, 100_000), ...totals('bus', 300, 10_000), ...totals('ship', 5, 10)]);

    const kept = compactBucket(full, 200);

    const byMode = (mode: VehicleTotal['mode']): number =>
      [...kept.values()].filter((t) => t.mode === mode).length;
    expect(byMode('tube')).toBe(200);
    expect(byMode('bus')).toBe(200);
    expect(byMode('ship')).toBe(5); // fewer than the cap: all survive
    expect(kept.size).toBe(405);
  });

  test('keeps the furthest travelled and drops the tail', () => {
    const full = bucket(totals('bus', 10));

    const kept = compactBucket(full, 3);

    expect([...kept.values()].map((t) => t.m).sort((a, b) => b - a)).toEqual([9, 8, 7]);
    expect(kept.has('bus-0')).toBe(false);
  });

  test('a bucket already under the cap is returned intact', () => {
    const full = bucket(totals('ship', 4));

    expect(compactBucket(full, 200).size).toBe(4);
  });
});
