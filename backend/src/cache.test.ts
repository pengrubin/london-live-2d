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
