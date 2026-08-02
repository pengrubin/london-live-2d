// Docked bike-share availability from any GBFS feed.
//
// GBFS is an open standard used by several hundred systems worldwide, so this
// client is deliberately city-agnostic: point GBFS_URL at a system's
// discovery document and the layer appears. Nothing here knows about any
// particular operator.
//
// Two endpoints, two very different refresh rates: station_information is a
// near-static catalogue (names, positions, dock counts), station_status is the
// live part. Polling them together would re-download the catalogue every
// minute for nothing.

import { contains, type Bbox } from './region';

const STATUS_POLL_MS = 60_000;
/** Names and positions barely move; re-read the catalogue a few times a day. */
const INFO_REFRESH_MS = 6 * 3_600_000;
const FETCH_TIMEOUT_MS = 15_000;
/** A status row older than this is treated as offline rather than shown stale. */
const STALE_AFTER_MS = 30 * 60_000;

/** Compact wire row for /api/bikes — short keys, hundreds of stations. */
export interface BikeStationWire {
  readonly i: string;
  readonly n: string;
  readonly x: number;
  readonly y: number;
  /** vehicles available now */
  readonly b: number;
  /** empty docks */
  readonly d: number;
  /** total docks, when the feed states it */
  readonly c: number | null;
  /** 1 when the station is currently renting */
  readonly r: 0 | 1;
}

interface StationInfo {
  readonly id: string;
  readonly name: string;
  readonly lon: number;
  readonly lat: number;
  readonly capacity: number | null;
}

/**
 * GBFS 3.0 made localisable fields arrays of {text, language}; 1.x and 2.x use
 * a plain string. Feeds in the wild serve both, so accept either.
 */
function readName(raw: unknown): string | null {
  if (typeof raw === 'string') return raw.trim() || null;
  if (Array.isArray(raw)) {
    const entries = raw as Array<{ text?: unknown; language?: unknown }>;
    const english = entries.find((e) => e.language === 'en' && typeof e.text === 'string');
    const first = entries.find((e) => typeof e.text === 'string');
    const text = (english ?? first)?.text;
    return typeof text === 'string' ? text.trim() || null : null;
  }
  return null;
}

function readNumber(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/** Pulls the feed URLs out of a discovery document, across GBFS versions. */
function findFeeds(discovery: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const data = (discovery as { data?: unknown })?.data;
  if (!data || typeof data !== 'object') return out;
  // 3.0: data.feeds. 1.x/2.x: data.<language>.feeds.
  const candidates: unknown[] = [
    (data as { feeds?: unknown }).feeds,
    ...Object.values(data as Record<string, unknown>).map(
      (v) => (v as { feeds?: unknown })?.feeds,
    ),
  ];
  for (const feeds of candidates) {
    if (!Array.isArray(feeds)) continue;
    for (const feed of feeds as Array<{ name?: unknown; url?: unknown }>) {
      if (typeof feed.name === 'string' && typeof feed.url === 'string' && !out.has(feed.name)) {
        out.set(feed.name, feed.url);
      }
    }
  }
  return out;
}

export class GbfsClient {
  private stations: BikeStationWire[] = [];
  private info = new Map<string, StationInfo>();
  private infoFetchedAt = 0;
  private statusUrl: string | null = null;
  private infoUrl: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;

  constructor(
    private readonly discoveryUrl: string,
    private readonly bbox: Bbox,
    private readonly log: (msg: string) => void,
  ) {}

  start(): void {
    void this.poll();
    this.timer = setInterval(() => void this.poll(), STATUS_POLL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Latest merged snapshot for /api/bikes. */
  list(): BikeStationWire[] {
    return this.stations;
  }

  private async resolveFeeds(): Promise<void> {
    if (this.statusUrl && this.infoUrl) return;
    const feeds = findFeeds(await fetchJson(this.discoveryUrl));
    const info = feeds.get('station_information');
    const status = feeds.get('station_status');
    if (!info || !status) {
      throw new Error(`discovery document lists no station feeds (${[...feeds.keys()].join(',')})`);
    }
    this.infoUrl = info;
    this.statusUrl = status;
  }

  private async refreshInfo(now: number): Promise<void> {
    if (this.infoUrl === null) return;
    if (this.info.size > 0 && now - this.infoFetchedAt < INFO_REFRESH_MS) return;
    const body = (await fetchJson(this.infoUrl)) as { data?: { stations?: unknown } };
    const rows = body.data?.stations;
    if (!Array.isArray(rows)) throw new Error('station_information has no stations array');

    const next = new Map<string, StationInfo>();
    let outside = 0;
    for (const row of rows as Array<Record<string, unknown>>) {
      const id = typeof row['station_id'] === 'string' ? row['station_id'] : null;
      const name = readName(row['name']);
      const lon = readNumber(row['lon']);
      const lat = readNumber(row['lat']);
      if (id === null || name === null || lon === null || lat === null) continue;
      // Feeds carry stray rows — Dubai's lists one at longitude 39.6, in the
      // Red Sea. Without this the map's auto-fit would be dragged across a
      // continent by a single bad record.
      if (!contains(this.bbox, lon, lat)) {
        outside += 1;
        continue;
      }
      next.set(id, { id, name, lon, lat, capacity: readNumber(row['capacity']) });
    }
    this.info = next;
    this.infoFetchedAt = now;
    this.log(`GBFS: ${next.size} stations in region${outside ? `, ${outside} outside dropped` : ''}`);
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const now = Date.now();
      await this.resolveFeeds();
      await this.refreshInfo(now);
      if (this.statusUrl === null) return;

      const body = (await fetchJson(this.statusUrl)) as { data?: { stations?: unknown } };
      const rows = body.data?.stations;
      if (!Array.isArray(rows)) throw new Error('station_status has no stations array');

      const merged: BikeStationWire[] = [];
      for (const row of rows as Array<Record<string, unknown>>) {
        const id = typeof row['station_id'] === 'string' ? row['station_id'] : null;
        if (id === null) continue;
        const info = this.info.get(id);
        if (!info) continue; // outside the region, or absent from the catalogue

        const reportedAt = Date.parse(String(row['last_reported'] ?? ''));
        const stale = Number.isFinite(reportedAt) && now - reportedAt > STALE_AFTER_MS;
        // 3.0 renamed num_bikes_available; accept both spellings.
        const bikes =
          readNumber(row['num_vehicles_available']) ?? readNumber(row['num_bikes_available']) ?? 0;
        const docks = readNumber(row['num_docks_available']) ?? 0;
        const renting = row['is_renting'] !== false && row['is_installed'] !== false && !stale;

        merged.push({
          i: id,
          n: info.name,
          x: info.lon,
          y: info.lat,
          b: bikes,
          d: docks,
          c: info.capacity,
          r: renting ? 1 : 0,
        });
      }
      this.stations = merged;
    } catch (error) {
      // Keep the previous snapshot; a bike layer freezing beats it vanishing.
      this.log(`GBFS poll error: ${String(error)}`);
    } finally {
      this.polling = false;
    }
  }
}
