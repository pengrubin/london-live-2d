interface CacheEntry<T> {
  readonly value: T;
  readonly storedAt: number;
}

/**
 * Ceiling on entries in one cache, applied unless a caller names its own.
 *
 * It is a DEFAULT rather than an opt-in because several caches are keyed by an
 * id space far larger than any working set — NaPTAN stop id (~19,000 stops) for
 * stop-arrivals, stop-detail and crowding, vehicle id for vehicle-arrivals, and
 * aircraft callsign, on a one-hour TTL, for callsign — and opting in would
 * leave the next route keyed by an id free to grow without limit.
 *
 * History, because the comment here used to claim otherwise: this ceiling was
 * the first suspect for the 2026-09-04 out-of-memory crash and was NOT its
 * cause. A heap snapshot later named that: SIRI response strings retained by
 * slice views, fixed in `bods-client.ts`, which is where that incident is
 * written up. Bounding these caches was still worth doing.
 *
 * 300 is chosen against the working set, not the key space: a cache is useful
 * only for keys asked for again inside its TTL, which is 8 s for arrivals and
 * 10 min for stop detail. Watch `evictions` on /health and raise it if they
 * climb.
 *
 * **It bounds entries, not bytes.** A cache whose entries are megabytes needs
 * its own, far smaller ceiling — `/api/arrivals` bodies reach ~8.8 MB, so 300
 * of them would be 2.6 GB. See `ARRIVALS_MAX_ENTRIES` in app.ts.
 */
export const DEFAULT_MAX_ENTRIES = 300;

/**
 * In-memory TTL cache (per ARCHITECTURE.md: a Map, no Redis until proven needed).
 * Entries past their TTL are still retrievable via `getStale` so the server can
 * degrade gracefully when the upstream is down or the rate budget is exhausted.
 *
 * Bounded, least-recently-used. A Map iterates in insertion order, so "move a
 * key to the end whenever it is used, drop the first key when full" is exact
 * LRU with no second structure: the first key is by construction the one
 * nothing has touched for longest.
 */
export class TtlCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();
  private evicted = 0;

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number = DEFAULT_MAX_ENTRIES,
  ) {}

  /** Re-insert so this key becomes the most recently used. */
  private touch(key: string, entry: CacheEntry<T>): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
  }

  /** Returns the value only if it is younger than the TTL. */
  getFresh(key: string, now: number = Date.now()): T | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    // An expired entry is not a hit, so it does not earn a place at the back
    // of the queue: it should be the first thing evicted, not the last.
    if (now - entry.storedAt >= this.ttlMs) return undefined;
    this.touch(key, entry);
    return entry.value;
  }

  /**
   * Returns the value past its TTL (for stale-serving fallbacks). With
   * `maxAgeMs` the entry is served only while younger than that bound — the
   * same `<` boundary as `getFresh` — so a payload whose meaning decays (a
   * lifted suspension) is never served hours old; absent, any age is served.
   */
  getStale(key: string, maxAgeMs?: number, now: number = Date.now()): T | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    // Past the bound it is not served, so it is not a use either: it stays
    // where it is in the queue rather than earning a reprieve from eviction.
    if (maxAgeMs !== undefined && now - entry.storedAt >= maxAgeMs) return undefined;
    // Serving stale IS using the entry — an upstream outage must not cost the
    // very keys the fallback is holding up.
    this.touch(key, entry);
    return entry.value;
  }

  set(key: string, value: T, now: number = Date.now()): void {
    if (!this.entries.has(key) && this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) {
        this.entries.delete(oldest);
        this.evicted += 1;
      }
    }
    // Delete first so a re-set moves the key to the back of the queue rather
    // than updating it in place and leaving it looking stale to the evictor.
    this.entries.delete(key);
    this.entries.set(key, { value, storedAt: now });
  }

  /** Entry count, now bounded by `maxEntries`. Reported on /health because
   * "how many keys is it holding" is the question that matters for caches
   * keyed by stop or vehicle id. */
  get size(): number {
    return this.entries.size;
  }

  /** Keys dropped to stay under the ceiling. Zero means the working set fits;
   * a number that climbs steadily means `maxEntries` is too small for the
   * traffic and every eviction is a cache miss someone paid for. */
  get evictions(): number {
    return this.evicted;
  }
}
