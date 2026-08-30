// The popup's freshness line. diversions.ts value-imports maplibre-gl (Popup),
// so that module is stubbed to keep this in the fast node environment — same
// pattern as bus-filter.test.ts.
import { describe, expect, test, vi } from 'vitest';

vi.mock('maplibre-gl', () => ({ Popup: class {} }));

const { freshnessLabel } = await import('./diversions');

const NOW = 1_788_100_000;

describe('freshnessLabel', () => {
  test('reads as "just now" inside the first minute', () => {
    expect(freshnessLabel(NOW - 30, NOW)).toBe('last diverting bus just now');
  });

  test('reports whole minutes under an hour', () => {
    expect(freshnessLabel(NOW - 16 * 60 - 40, NOW)).toBe('last diverting bus 16 min ago');
  });

  test('switches to hours and minutes past the hour', () => {
    expect(freshnessLabel(NOW - (2 * 3600 + 5 * 60), NOW)).toBe('last diverting bus 2 h 5 min ago');
  });

  test('says nothing when the timestamp is missing or in the future', () => {
    // A clock-skewed client must not render "last diverting bus -3 min ago".
    expect(freshnessLabel(0, NOW)).toBe('');
    expect(freshnessLabel(Number.NaN, NOW)).toBe('');
    expect(freshnessLabel(NOW + 180, NOW)).toBe('');
  });
});
