interface CacheEntry<T> {
  readonly value: T;
  readonly storedAt: number;
}

/**
 * In-memory TTL cache (per ARCHITECTURE.md: a Map, no Redis until proven needed).
 * Entries past their TTL are still retrievable via `getStale` so the server can
 * degrade gracefully when the upstream is down or the rate budget is exhausted.
 */
export class TtlCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();

  constructor(private readonly ttlMs: number) {}

  /** Returns the value only if it is younger than the TTL. */
  getFresh(key: string, now: number = Date.now()): T | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    return now - entry.storedAt < this.ttlMs ? entry.value : undefined;
  }

  /** Returns the value regardless of age (for stale-serving fallbacks). */
  getStale(key: string): T | undefined {
    return this.entries.get(key)?.value;
  }

  set(key: string, value: T, now: number = Date.now()): void {
    this.entries.set(key, { value, storedAt: now });
  }

  /** Entry count. Nothing is ever evicted here — expired entries are kept on
   * purpose so `getStale` can degrade gracefully — so this only ever grows,
   * once per distinct key the process has seen. Reported on /health because
   * "how many keys has it seen" is exactly the question that matters for
   * caches keyed by stop or vehicle id. */
  get size(): number {
    return this.entries.size;
  }
}
