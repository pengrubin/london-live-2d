// Region configuration — the geography this deployment covers.
//
// Every geographic constant that used to be hard-coded to London lives here and
// is overridable by environment variable, so one codebase can serve more than
// one city: the London deployment sets nothing and behaves exactly as before,
// a second deployment sets these vars and gets its own map.
//
// There is deliberately NO "which city am I" switch. A deployment declares what
// it *has* (a bbox, a key, a centre point), never who it *is*; the capabilities
// route then reports the resulting layer set to the frontend. That keeps city
// names out of the code and avoids `if (city === …)` branches entirely.
//
// COORDINATE ORDER: every value in this file is lon-before-lat (GeoJSON order,
// and the order the BODS boundingBox parameter already used). Upstreams that
// want lat-first (aisstream, adsb.lol) are converted at their call sites.

/** Axis-aligned geographic box, lon-before-lat. */
export interface Bbox {
  readonly minLon: number;
  readonly minLat: number;
  readonly maxLon: number;
  readonly maxLat: number;
}

/** A point plus a radius, for upstreams that query by circle (ADS-B). */
export interface CirclePoint {
  readonly lon: number;
  readonly lat: number;
  readonly radiusNm: number;
}

export interface RegionConfig {
  /** Display name, e.g. for page titles. Never used for branching. */
  readonly name: string;
  /** Canonical data bbox: bus feed query + tide-gauge filter + input validation. */
  readonly bbox: Bbox;
  /** Map pan limit — slightly wider than `bbox` so panning never hits a wall. */
  readonly viewBounds: Bbox;
  readonly centerLon: number;
  readonly centerLat: number;
  readonly zoom: number;
  /** Vessel subscription box; separate from `bbox` because ships range offshore. */
  readonly aisBbox: Bbox;
  readonly adsb: CirclePoint;
  /** Environment Agency tide gauges are England-only; off outside the UK. */
  readonly tideGauges: boolean;
  /**
   * Basemap extract for this region. Reported to the frontend rather than
   * compiled into it, so one bundle serves every deployment; unset leaves the
   * frontend on its build-time default.
   */
  readonly pmtilesUrl: string | undefined;
}

// ── London defaults ──────────────────────────────────────────────────────────
// These reproduce the previously hard-coded values byte for byte, so a
// deployment that sets no REGION_* variable is unchanged by this refactor.

const DEFAULT_NAME = 'London';
/** bods-client's boundingBox + ea-tides' station filter (identical boxes). */
const DEFAULT_BBOX = '-0.55,51.25,0.35,51.72';
/** frontend maxBounds — wider than DEFAULT_BBOX by design. */
const DEFAULT_VIEW_BOUNDS = '-0.65,51.2,0.45,51.77';
const DEFAULT_CENTER = '-0.1276,51.5072';
const DEFAULT_ZOOM = 11;
const DEFAULT_AIS_BBOX = '-0.55,51.3,0.45,51.62';
const DEFAULT_ADSB_CENTER = '-0.12,51.5';
const DEFAULT_ADSB_RADIUS_NM = 30;

/**
 * Slack added around `bbox` when validating caller-supplied coordinates. Chosen
 * so the derived London box is a strict superset of the previous hard-coded
 * validation bounds (lon -0.7..0.5, lat 51.2..51.8) — no request that used to be
 * accepted can start being rejected by this refactor.
 */
export const VALIDATION_MARGIN_DEG = 0.2;

const MAX_LON = 180;
const MAX_LAT = 90;
const MIN_ZOOM = 0;
const MAX_ZOOM = 22;
const MAX_RADIUS_NM = 250;

/** Reads an env var, treating empty strings as unset. */
export type EnvReader = (name: string) => string | undefined;

function fail(name: string, raw: string, expected: string): never {
  throw new Error(`${name} is malformed ("${raw}"). Expected ${expected}.`);
}

/**
 * Parses "minLon,minLat,maxLon,maxLat". Throws on anything malformed rather
 * than falling back silently: a wrong box yields an empty map with no error,
 * which is far harder to diagnose than a refusal to start.
 */
export function parseBbox(name: string, raw: string): Bbox {
  const parts = raw.split(',').map((p) => Number.parseFloat(p.trim()));
  const BBOX_PARTS = 4;
  if (parts.length !== BBOX_PARTS || parts.some((n) => !Number.isFinite(n))) {
    fail(name, raw, 'four comma-separated numbers "minLon,minLat,maxLon,maxLat"');
  }
  const [minLon, minLat, maxLon, maxLat] = parts as [number, number, number, number];
  if (Math.abs(minLon) > MAX_LON || Math.abs(maxLon) > MAX_LON) {
    fail(name, raw, `longitudes within ±${MAX_LON}`);
  }
  if (Math.abs(minLat) > MAX_LAT || Math.abs(maxLat) > MAX_LAT) {
    fail(name, raw, `latitudes within ±${MAX_LAT}`);
  }
  if (minLon >= maxLon || minLat >= maxLat) {
    fail(name, raw, 'min values strictly below max values');
  }
  return { minLon, minLat, maxLon, maxLat };
}

/** Parses "lon,lat". */
export function parseLonLat(name: string, raw: string): { lon: number; lat: number } {
  const parts = raw.split(',').map((p) => Number.parseFloat(p.trim()));
  const POINT_PARTS = 2;
  if (parts.length !== POINT_PARTS || parts.some((n) => !Number.isFinite(n))) {
    fail(name, raw, 'two comma-separated numbers "lon,lat"');
  }
  const [lon, lat] = parts as [number, number];
  if (Math.abs(lon) > MAX_LON) fail(name, raw, `a longitude within ±${MAX_LON}`);
  if (Math.abs(lat) > MAX_LAT) fail(name, raw, `a latitude within ±${MAX_LAT}`);
  return { lon, lat };
}

function parseBoundedNumber(name: string, raw: string, min: number, max: number): number {
  const value = Number.parseFloat(raw.trim());
  if (!Number.isFinite(value) || value < min || value > max) {
    fail(name, raw, `a number between ${min} and ${max}`);
  }
  return value;
}

/** Env flags: "off"/"false"/"0" disable, anything else (incl. unset) enables. */
export function parseFlag(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === '') return fallback;
  return !['off', 'false', '0', 'no'].includes(raw.trim().toLowerCase());
}

/** Grows a box outwards by a fixed number of degrees, clamped to valid ranges. */
export function widen(bbox: Bbox, marginDeg: number): Bbox {
  return {
    minLon: Math.max(-MAX_LON, bbox.minLon - marginDeg),
    minLat: Math.max(-MAX_LAT, bbox.minLat - marginDeg),
    maxLon: Math.min(MAX_LON, bbox.maxLon + marginDeg),
    maxLat: Math.min(MAX_LAT, bbox.maxLat + marginDeg),
  };
}

/** True when [lon, lat] falls inside the box (inclusive on all edges). */
export function contains(bbox: Bbox, lon: number, lat: number): boolean {
  return lon >= bbox.minLon && lon <= bbox.maxLon && lat >= bbox.minLat && lat <= bbox.maxLat;
}

/** Serialises back to the "minLon,minLat,maxLon,maxLat" form upstreams expect. */
export function bboxToString(bbox: Bbox): string {
  return `${bbox.minLon},${bbox.minLat},${bbox.maxLon},${bbox.maxLat}`;
}

/**
 * Builds the region from the environment, falling back to London throughout.
 * Throws (fail fast at startup) if any supplied value is malformed.
 */
export function loadRegion(readEnv: EnvReader): RegionConfig {
  const raw = (name: string, fallback: string): string => {
    const value = readEnv(name);
    return value === undefined || value.trim() === '' ? fallback : value;
  };

  const center = parseLonLat('REGION_CENTER', raw('REGION_CENTER', DEFAULT_CENTER));
  const adsbCenter = parseLonLat('ADSB_CENTER', raw('ADSB_CENTER', DEFAULT_ADSB_CENTER));

  return {
    name: raw('REGION_NAME', DEFAULT_NAME),
    bbox: parseBbox('REGION_BBOX', raw('REGION_BBOX', DEFAULT_BBOX)),
    viewBounds: parseBbox('REGION_VIEW_BOUNDS', raw('REGION_VIEW_BOUNDS', DEFAULT_VIEW_BOUNDS)),
    centerLon: center.lon,
    centerLat: center.lat,
    zoom: parseBoundedNumber('REGION_ZOOM', raw('REGION_ZOOM', String(DEFAULT_ZOOM)), MIN_ZOOM, MAX_ZOOM),
    aisBbox: parseBbox('AIS_BBOX', raw('AIS_BBOX', DEFAULT_AIS_BBOX)),
    adsb: {
      lon: adsbCenter.lon,
      lat: adsbCenter.lat,
      radiusNm: parseBoundedNumber(
        'ADSB_RADIUS_NM',
        raw('ADSB_RADIUS_NM', String(DEFAULT_ADSB_RADIUS_NM)),
        1,
        MAX_RADIUS_NM,
      ),
    },
    tideGauges: parseFlag(readEnv('TIDE_GAUGES'), true),
    pmtilesUrl: readEnv('REGION_PMTILES_URL')?.trim() || undefined,
  };
}
