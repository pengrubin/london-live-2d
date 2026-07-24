// Environment Agency flood-monitoring API client for Thames tide gauges.
// Aggregates three EA lookups into one list: the tidal-station catalogue
// (near-static, cached here for an hour), one batched latest-readings call for
// current levels, and one short readings history per surviving station for the
// rising/falling trend. The EA publishes new readings every 15 minutes.

import { UPSTREAM_TIMEOUT_MS } from './constants';

const EA_BASE = 'https://environment.data.gov.uk/flood-monitoring';
const TIDAL_QUERY = 'parameter=level&qualifier=Tidal%20Level';

/** Same bbox as the frontend map bounds (tidal Thames, Teddington to Tilbury). */
const BBOX = { minLat: 51.25, maxLat: 51.72, minLon: -0.55, maxLon: 0.35 };

/** How far back to look when deciding whether the tide is rising or falling. */
const TREND_WINDOW_MS = 50 * 60_000;
/** Level change smaller than this across the window counts as "steady". */
const TREND_THRESHOLD_M = 0.03;
/** The station catalogue barely changes; refetch it hourly. */
const STATIONS_TTL_MS = 3_600_000;
/** 15-minute mean/instantaneous series — preferred over 1-minute spot values. */
const PREFERRED_PERIOD_S = 900;

export type TideTrend = 'rising' | 'falling' | 'steady';

export interface TideGauge {
  readonly ref: string;
  readonly label: string;
  readonly lat: number;
  readonly lon: number;
  readonly levelM: number;
  readonly readingAt: string;
  readonly trend: TideTrend;
}

interface EaMeasure {
  readonly '@id'?: string;
  readonly period?: number;
}

interface EaStation {
  readonly stationReference?: string;
  readonly label?: string | readonly string[];
  readonly lat?: number;
  readonly long?: number;
  readonly measures?: readonly EaMeasure[];
}

interface EaReading {
  readonly dateTime?: string;
  readonly measure?: string;
  readonly value?: number;
}

interface CandidateStation {
  readonly ref: string;
  readonly label: string;
  readonly lat: number;
  readonly lon: number;
  /** Full measure @id URLs, 15-minute series first. */
  readonly measureIds: readonly string[];
}

async function eaFetchItems<T>(url: string): Promise<readonly T[]> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`EA upstream returned ${response.status}`);
  const body = (await response.json()) as { items?: T[] };
  return Array.isArray(body.items) ? body.items : [];
}

function firstLabel(label: string | readonly string[] | undefined): string {
  if (Array.isArray(label)) return String(label[0] ?? 'Tide gauge');
  return typeof label === 'string' ? label : 'Tide gauge';
}

function toCandidate(station: EaStation): CandidateStation | undefined {
  const { stationReference: ref, lat, long: lon } = station;
  if (typeof ref !== 'string' || ref === '') return undefined;
  // DIFF_* entries are synthetic gauge-to-gauge difference series, not places.
  if (ref.startsWith('DIFF')) return undefined;
  if (typeof lat !== 'number' || typeof lon !== 'number') return undefined;
  if (lat < BBOX.minLat || lat > BBOX.maxLat || lon < BBOX.minLon || lon > BBOX.maxLon) {
    return undefined;
  }
  const measures = (station.measures ?? []).flatMap((m) =>
    typeof m['@id'] === 'string' ? [{ id: m['@id'], period: m.period ?? 0 }] : [],
  );
  const measureIds = [...measures]
    .sort((a, b) => Number(b.period === PREFERRED_PERIOD_S) - Number(a.period === PREFERRED_PERIOD_S))
    .map((m) => m.id);
  if (measureIds.length === 0) return undefined;
  return { ref, label: firstLabel(station.label), lat, lon, measureIds };
}

let stationsCache: { readonly at: number; readonly stations: readonly CandidateStation[] } | undefined;

async function fetchStations(now: number): Promise<readonly CandidateStation[]> {
  if (stationsCache && now - stationsCache.at < STATIONS_TTL_MS) return stationsCache.stations;
  const items = await eaFetchItems<EaStation>(`${EA_BASE}/id/stations?${TIDAL_QUERY}`);
  const stations = items.flatMap((s) => {
    const candidate = toCandidate(s);
    return candidate ? [candidate] : [];
  });
  stationsCache = { at: now, stations };
  return stations;
}

/** One call for the latest reading of every tidal-level measure nationwide. */
async function fetchLatestByMeasure(): Promise<ReadonlyMap<string, EaReading>> {
  const items = await eaFetchItems<EaReading>(`${EA_BASE}/data/readings?${TIDAL_QUERY}&latest`);
  return new Map(
    items.flatMap((r) =>
      typeof r.measure === 'string' && typeof r.value === 'number' && typeof r.dateTime === 'string'
        ? [[r.measure, r] as const]
        : [],
    ),
  );
}

async function fetchTrend(ref: string, measureId: string, now: number): Promise<TideTrend> {
  const since = new Date(now - TREND_WINDOW_MS).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const url = `${EA_BASE}/id/stations/${encodeURIComponent(ref)}/readings?since=${since}&_sorted`;
  const readings = await eaFetchItems<EaReading>(url);
  const values = readings
    .filter(
      (r): r is EaReading & { dateTime: string; value: number } =>
        r.measure === measureId && typeof r.value === 'number' && typeof r.dateTime === 'string',
    )
    .sort((a, b) => a.dateTime.localeCompare(b.dateTime))
    .map((r) => r.value);
  const newest = values.at(-1);
  const oldest = values.at(0);
  if (values.length < 2 || newest === undefined || oldest === undefined) return 'steady';
  const delta = newest - oldest;
  if (delta > TREND_THRESHOLD_M) return 'rising';
  if (delta < -TREND_THRESHOLD_M) return 'falling';
  return 'steady';
}

/** Several EA entries share one physical site (barrier east/west piers, lock
 * head/tail) — keep the freshest reading per coordinate so markers don't stack. */
function dedupeByCoordinate(
  gauges: readonly Omit<TideGauge, 'trend'>[],
): readonly Omit<TideGauge, 'trend'>[] {
  const byCoord = new Map<string, Omit<TideGauge, 'trend'>>();
  for (const gauge of gauges) {
    const key = `${gauge.lat.toFixed(4)},${gauge.lon.toFixed(4)}`;
    const existing = byCoord.get(key);
    if (!existing || gauge.readingAt > existing.readingAt) byCoord.set(key, gauge);
  }
  return [...byCoord.values()];
}

/** Full pipeline: stations → latest levels → dedupe → per-station trends. */
export async function fetchTideGauges(now: number = Date.now()): Promise<readonly TideGauge[]> {
  const [stations, latestByMeasure] = await Promise.all([
    fetchStations(now),
    fetchLatestByMeasure(),
  ]);

  const withLevels = stations.flatMap((station) => {
    const measureId = station.measureIds.find((id) => latestByMeasure.has(id));
    const latest = measureId === undefined ? undefined : latestByMeasure.get(measureId);
    if (measureId === undefined || latest === undefined) return [];
    return [
      {
        gauge: {
          ref: station.ref,
          label: station.label,
          lat: station.lat,
          lon: station.lon,
          levelM: latest.value as number,
          readingAt: latest.dateTime as string,
        },
        measureId,
      },
    ];
  });

  const deduped = dedupeByCoordinate(withLevels.map((w) => w.gauge));
  const measureByRef = new Map(withLevels.map((w) => [w.gauge.ref, w.measureId]));

  return Promise.all(
    deduped.map(async (gauge) => {
      const measureId = measureByRef.get(gauge.ref);
      const trend =
        measureId === undefined
          ? ('steady' as const)
          : await fetchTrend(gauge.ref, measureId, now).catch(() => 'steady' as const);
      return { ...gauge, trend };
    }),
  );
}
