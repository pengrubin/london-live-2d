import type { TtlCache } from './cache';
import type { RateBudget } from './rate-budget';
import { fetchArrivals, type TflResponse } from './tfl-client';

const HTTP_OK = 200;

/**
 * How long a cached body is defended against an upstream answer whose feed
 * timestamp is OLDER than its own. Document 3 measured 10.2% of 30 s line-polls
 * returning a body older than one already served; once two fetches for a key
 * can no longer overlap (single-flight below), the remaining way back in time
 * is TfL itself answering from a lagging backend. Keeping the newer body is
 * right for a few seconds, but a body carrying a bad (future) timestamp must
 * not pin the cache for good: past this age the fetched body is stored
 * whatever its timestamp. ~4 cache TTLs (8 s): long enough to ride out a
 * lagging node across several polls, short enough that a bogus entry costs
 * at most half a minute of frozen trains.
 */
export const MONOTONIC_HOLD_MS = 30_000;

/**
 * Where a served body came from. `join` is a request that arrived while the
 * upstream fetch for its key was already in flight and awaited that fetch
 * instead of starting another (no budget unit spent): distinct from `miss` so
 * a browser-side recorder can count joiners.
 */
export type ArrivalsCacheState = 'hit' | 'miss' | 'join' | 'stale';

export type ArrivalsLookup =
  /** A body to serve, with the time it was cached (for `x-cache-age`). */
  | {
      readonly kind: 'body';
      readonly cacheState: ArrivalsCacheState;
      readonly body: unknown;
      readonly storedAt: number;
    }
  /** TfL answered with a non-array (error object): pass through, not cached. */
  | { readonly kind: 'upstream-error'; readonly cacheState: 'miss' | 'join'; readonly status: number; readonly body: unknown }
  /** Budget exhausted with nothing cached. */
  | { readonly kind: 'exhausted' }
  /** Upstream threw with nothing cached. */
  | { readonly kind: 'failed'; readonly error: unknown };

/** Outcome of one upstream flight, shared by every request awaiting it. */
type Flight =
  | { readonly kind: 'body'; readonly body: unknown; readonly storedAt: number }
  | { readonly kind: 'upstream-error'; readonly status: number; readonly body: unknown };

export interface ArrivalsSourceDeps {
  readonly appKey: string;
  readonly cache: TtlCache<unknown>;
  readonly budget: RateBudget;
  /** `fetchArrivals` unless a test injects a fake. */
  readonly fetchUpstream?: (lineIds: readonly string[], appKey: string) => Promise<TflResponse>;
  /** Clock behind cache ages and budget windows; `Date.now` unless a test injects one. */
  readonly now?: () => number;
  readonly log?: { debug: (obj: object, msg: string) => void };
}

/**
 * Feed timestamp of a TfL Line/Arrivals body: every prediction in one response
 * carries the same `timestamp`, so the first row speaks for the whole body and
 * nothing else is read. Undefined for an empty or non-array body.
 */
export function feedTimestamp(body: unknown): string | undefined {
  if (!Array.isArray(body)) return undefined;
  const first: unknown = body[0];
  if (typeof first !== 'object' || first === null) return undefined;
  const ts = (first as { timestamp?: unknown }).timestamp;
  return typeof ts === 'string' ? ts : undefined;
}

/** Epoch ms of a body's feed timestamp, or NaN when it has none or it is unparseable. */
const feedMs = (body: unknown): number => {
  const ts = feedTimestamp(body);
  return ts === undefined ? Number.NaN : Date.parse(ts);
};

/**
 * The one way to read TfL Line/Arrivals, shared by `/api/arrivals` and the
 * leaderboard's tube sampler. Both used to fetch on their own; with no
 * in-flight join, a frontend poll and a sampler tick (or two tabs) that missed
 * together each started a fetch, and the one that STARTED earlier could
 * FINISH later and overwrite the cache with the older body — the leading
 * explanation for the 10.2% of polls document 3 saw go back in time.
 *
 * One instance per cache, so the in-flight map is keyed exactly like the
 * cache: at most one upstream request per key at a time, one budget unit per
 * upstream request however many callers await it.
 */
export class ArrivalsSource {
  private readonly inflight = new Map<string, Promise<Flight>>();
  private readonly fetchUpstream: (lineIds: readonly string[], appKey: string) => Promise<TflResponse>;
  private readonly now: () => number;

  constructor(private readonly deps: ArrivalsSourceDeps) {
    this.fetchUpstream = deps.fetchUpstream ?? fetchArrivals;
    this.now = deps.now ?? Date.now;
  }

  /** The key the route redacts from TfL error bodies. */
  get appKey(): string {
    return this.deps.appKey;
  }

  /** The clock cache ages are measured on, so `x-cache-age` uses the same one. */
  clock(): number {
    return this.now();
  }

  /**
   * Fresh hit → join an in-flight fetch → spend one budget unit and fetch →
   * stale on exhaustion or failure. Ids are canonicalised (deduped, sorted)
   * here so every caller lands on the same key.
   */
  async lookup(lineIds: readonly string[]): Promise<ArrivalsLookup> {
    const ids = [...new Set(lineIds)].sort();
    const key = ids.join(',');
    const { cache, budget } = this.deps;

    if (cache.getFresh(key, this.now()) !== undefined) return this.served(key, 'hit');

    const pending = this.inflight.get(key);
    const cacheState = pending === undefined ? 'miss' : 'join';
    if (pending === undefined && !budget.tryConsume(this.now())) {
      return this.staleOr(key, { kind: 'exhausted' });
    }

    try {
      const flight = await (pending ?? this.startFlight(key, ids));
      if (flight.kind === 'upstream-error') return { ...flight, cacheState };
      return { kind: 'body', cacheState, body: flight.body, storedAt: flight.storedAt };
    } catch (error) {
      return this.staleOr(key, { kind: 'failed', error });
    }
  }

  private startFlight(key: string, ids: readonly string[]): Promise<Flight> {
    const flight = this.fetchAndStore(key, ids).finally(() => this.inflight.delete(key));
    this.inflight.set(key, flight);
    return flight;
  }

  private async fetchAndStore(key: string, ids: readonly string[]): Promise<Flight> {
    const upstream = await this.fetchUpstream(ids, this.deps.appKey);
    if (upstream.status !== HTTP_OK || !Array.isArray(upstream.body)) {
      return { kind: 'upstream-error', status: upstream.status, body: upstream.body };
    }
    return this.storeMonotonic(key, upstream.body);
  }

  /**
   * Stores `body` unless the cached one carries a newer feed timestamp and is
   * still inside MONOTONIC_HOLD_MS; either way returns what is now cached, so
   * every caller of this flight is served the newest body there is. Unknown
   * timestamps compare as NaN, i.e. never "newer", so the fetched body wins.
   */
  private storeMonotonic(key: string, body: unknown): Flight {
    const now = this.now();
    const current = this.deps.cache.peekEntry(key);
    if (
      current !== undefined &&
      now - current.storedAt < MONOTONIC_HOLD_MS &&
      feedMs(current.value) > feedMs(body)
    ) {
      this.deps.log?.debug(
        { key, cached: feedTimestamp(current.value), fetched: feedTimestamp(body) },
        'arrivals: discarded upstream body older than the cached one',
      );
      return { kind: 'body', body: current.value, storedAt: current.storedAt };
    }
    this.deps.cache.set(key, body, now);
    return { kind: 'body', body, storedAt: now };
  }

  private served(key: string, cacheState: ArrivalsCacheState): ArrivalsLookup {
    // Only called right after a successful get on the same key, so present.
    const entry = this.deps.cache.peekEntry(key);
    if (entry === undefined) return { kind: 'exhausted' };
    return { kind: 'body', cacheState, body: entry.value, storedAt: entry.storedAt };
  }

  private staleOr(key: string, fallback: ArrivalsLookup): ArrivalsLookup {
    // getStale (not peek) so serving stale counts as a use for the LRU.
    if (this.deps.cache.getStale(key, undefined, this.now()) === undefined) return fallback;
    return this.served(key, 'stale');
  }
}
