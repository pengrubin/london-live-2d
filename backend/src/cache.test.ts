import { describe, expect, test } from 'vitest';
import { TtlCache } from './cache';

const TTL_MS = 60_000;

describe('TtlCache.size', () => {
  test('counts distinct keys, not writes', () => {
    const cache = new TtlCache<string>(TTL_MS);

    cache.set('a', '1');
    cache.set('a', '2');
    cache.set('b', '1');

    expect(cache.size).toBe(2);
  });

  test('expired entries still count — nothing is evicted, by design', () => {
    // getStale() serves these when the upstream is down, so they are kept.
    // That is why size only ever grows, and why it is worth reporting for
    // caches keyed by stop or vehicle id.
    const cache = new TtlCache<string>(TTL_MS);
    const t0 = 1_000_000;

    cache.set('stop-490000001', 'arrivals', t0);
    const later = t0 + TTL_MS * 10;

    expect(cache.getFresh('stop-490000001', later)).toBeUndefined();
    expect(cache.getStale('stop-490000001')).toBe('arrivals');
    expect(cache.size).toBe(1);
  });
});

describe('TtlCache.getStale with maxAgeMs', () => {
  const MAX_AGE_MS = 600_000;

  test('serves an expired entry of any age when maxAgeMs is absent', () => {
    // Arrange
    const cache = new TtlCache<string>(TTL_MS);
    const t0 = 1_000_000;
    cache.set('k', 'v', t0);

    // Act
    const value = cache.getStale('k', undefined, t0 + MAX_AGE_MS * 100);

    // Assert
    expect(value).toBe('v');
  });

  test('serves an entry younger than maxAgeMs even though it is past the TTL', () => {
    // Arrange
    const cache = new TtlCache<string>(TTL_MS);
    const t0 = 1_000_000;
    cache.set('k', 'v', t0);

    // Act
    const value = cache.getStale('k', MAX_AGE_MS, t0 + MAX_AGE_MS - 1);

    // Assert
    expect(cache.getFresh('k', t0 + MAX_AGE_MS - 1)).toBeUndefined();
    expect(value).toBe('v');
  });

  test('returns undefined once the entry is maxAgeMs old — the same boundary as getFresh', () => {
    // A stale payload older than the bound must not be served: a lifted
    // suspension would otherwise keep its hatch for hours under an outage.
    // Arrange
    const cache = new TtlCache<string>(TTL_MS);
    const t0 = 1_000_000;
    cache.set('k', 'v', t0);

    // Act
    const value = cache.getStale('k', MAX_AGE_MS, t0 + MAX_AGE_MS);

    // Assert
    expect(value).toBeUndefined();
    expect(cache.size).toBe(1);
  });

  test('returns undefined for a key never stored, bounded or not', () => {
    // Arrange
    const cache = new TtlCache<string>(TTL_MS);

    // Act / Assert
    expect(cache.getStale('missing')).toBeUndefined();
    expect(cache.getStale('missing', MAX_AGE_MS, 1_000_000)).toBeUndefined();
  });
});
