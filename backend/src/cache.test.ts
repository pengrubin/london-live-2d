import { describe, expect, test } from 'vitest';
import { DEFAULT_MAX_ENTRIES, TtlCache } from './cache';

const TTL_MS = 60_000;

describe('TtlCache.size', () => {
  test('counts distinct keys, not writes', () => {
    const cache = new TtlCache<string>(TTL_MS);

    cache.set('a', '1');
    cache.set('a', '2');
    cache.set('b', '1');

    expect(cache.size).toBe(2);
  });

  test('an expired entry is kept for getStale rather than dropped on read', () => {
    // getStale() serves these when the upstream is down, so expiry alone never
    // removes an entry; only the size ceiling does.
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

  test('an entry past maxAgeMs is refused without earning a reprieve from eviction', () => {
    // Arrange — the bound is not a use, so the entry stays first in line.
    const cache = new TtlCache<string>(TTL_MS, 2);
    const t0 = 1_000_000;
    cache.set('old', 'v', t0);
    cache.set('newer', 'v', t0 + 1);

    // Act
    expect(cache.getStale('old', MAX_AGE_MS, t0 + MAX_AGE_MS)).toBeUndefined();
    cache.set('newest', 'v', t0 + MAX_AGE_MS);

    // Assert
    expect(cache.getStale('old')).toBeUndefined();
    expect(cache.getStale('newer')).toBe('v');
  });
});

describe('TtlCache eviction', () => {
  test('holds at the ceiling instead of growing without bound', () => {
    // Arrange — a cache keyed the way /api/stop-arrivals is, asked for far
    // more distinct ids than it may hold. Before the ceiling existed this is
    // exactly what filled a 2 GB heap and killed the London service.
    const cache = new TtlCache<string>(TTL_MS, 3);

    // Act
    for (let i = 0; i < 100; i += 1) cache.set(`stop-${i}`, `body-${i}`);

    // Assert
    expect(cache.size).toBe(3);
    expect(cache.evictions).toBe(97);
  });

  test('evicts the least recently used, not the oldest written', () => {
    // Arrange
    const cache = new TtlCache<string>(TTL_MS, 3);
    cache.set('a', '1');
    cache.set('b', '2');
    cache.set('c', '3');

    // Act — reading 'a' makes it the most recent, so 'b' becomes the victim.
    expect(cache.getFresh('a')).toBe('1');
    cache.set('d', '4');

    // Assert
    expect(cache.getStale('b')).toBeUndefined();
    expect(cache.getFresh('a')).toBe('1');
    expect(cache.getFresh('c')).toBe('3');
    expect(cache.getFresh('d')).toBe('4');
  });

  test('serving stale rescues a key from eviction', () => {
    // An upstream outage must not cost the very entries the fallback leans on.
    const cache = new TtlCache<string>(TTL_MS, 2);
    const t0 = 1_000_000;
    cache.set('a', '1', t0);
    cache.set('b', '2', t0);

    expect(cache.getStale('a')).toBe('1');
    cache.set('c', '3', t0);

    expect(cache.getStale('b')).toBeUndefined();
    expect(cache.getStale('a')).toBe('1');
  });

  test('an expired entry does not earn a place at the back of the queue', () => {
    // A miss on an expired key is not a use, so it stays first in line to go.
    const cache = new TtlCache<string>(TTL_MS, 2);
    const t0 = 1_000_000;
    cache.set('stale', 'old', t0);
    // Written two TTLs later, so at `now` below it is 1 ms old while 'stale'
    // is long expired — the two must not share a fate.
    const now = t0 + TTL_MS * 2 + 1;
    cache.set('fresh', 'new', now - 1);

    expect(cache.getFresh('stale', now)).toBeUndefined();
    cache.set('newest', 'newer', now);

    expect(cache.getStale('stale')).toBeUndefined();
    expect(cache.getFresh('fresh', now)).toBe('new');
  });

  test('re-setting an existing key never evicts', () => {
    const cache = new TtlCache<string>(TTL_MS, 2);
    cache.set('a', '1');
    cache.set('b', '2');

    for (let i = 0; i < 50; i += 1) cache.set('a', `${i}`);

    expect(cache.size).toBe(2);
    expect(cache.evictions).toBe(0);
    expect(cache.getFresh('b')).toBe('2');
  });

  test('a fixed-key cache never reaches the ceiling, so its behaviour is unchanged', () => {
    // Most caches here hold exactly one key (bike points, tide gauges, road
    // disruptions). The default ceiling must be invisible to them.
    const cache = new TtlCache<string>(TTL_MS);

    for (let i = 0; i < 5_000; i += 1) cache.set('', `body-${i}`);

    expect(cache.size).toBe(1);
    expect(cache.evictions).toBe(0);
    expect(cache.getFresh('')).toBe('body-4999');
  });

  test('the default ceiling applies when a caller names none', () => {
    const cache = new TtlCache<string>(TTL_MS);

    for (let i = 0; i < DEFAULT_MAX_ENTRIES + 50; i += 1) cache.set(`k${i}`, 'v');

    expect(cache.size).toBe(DEFAULT_MAX_ENTRIES);
    expect(cache.evictions).toBe(50);
  });
});
