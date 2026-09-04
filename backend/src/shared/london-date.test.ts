import { describe, expect, it } from 'vitest';
import { londonDay } from './london-date';

// TfL's date-window paths and the leaderboard's period buckets both key on the
// Europe/London calendar day, which parts from the UTC day for one hour every
// summer night. The two clock-change instants are the ones a UTC slice gets wrong.
describe('londonDay', () => {
  it('stays on the BST calendar day in the last hour before the clocks go back', () => {
    // 00:30Z on 2026-10-25 is 01:30 BST; BST ends at 01:00Z that morning.
    const now = new Date('2026-10-25T00:30:00Z');

    const day = londonDay(now);

    expect(day).toBe('2026-10-25');
  });

  it('is the same calendar day just after the clocks go forward', () => {
    // 01:30Z on 2026-03-29 is 02:30 BST; BST began at 01:00Z that morning.
    const now = new Date('2026-03-29T01:30:00Z');

    const day = londonDay(now);

    expect(day).toBe('2026-03-29');
  });

  it('rolls to the next London day at 23:00Z on a plain summer night', () => {
    const now = new Date('2026-07-15T23:30:00Z');

    const day = londonDay(now);

    expect(day).toBe('2026-07-16');
  });

  it('matches the UTC day on a plain winter night', () => {
    const now = new Date('2026-01-15T23:30:00Z');

    const day = londonDay(now);

    expect(day).toBe('2026-01-15');
  });
});
