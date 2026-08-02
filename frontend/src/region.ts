// The region this build is currently rendering — fetched once at startup from
// the backend's /api/capabilities, never compiled in.
//
// One frontend bundle serves every deployment. It asks the backend where it is
// and what it has, then builds only those layers. Nothing here knows a city by
// name; a deployment is described entirely by a centre, some bounds and a set
// of booleans.
//
// The latitude also decides the metres-per-degree-longitude scale used for
// dead reckoning. Baking that at London's latitude is wrong anywhere else: the
// factor is cos(lat), so 51.5° gives 69,297 m/° against 25°'s 100,873 — a ship
// moved with the London figure covers ~45% too much ground east-west.

/** Layer names the backend reports. Unknown keys read as absent. */
export interface Capabilities {
  readonly region: {
    readonly name: string;
    readonly center: readonly [number, number];
    readonly zoom: number;
    readonly maxBounds: readonly [readonly [number, number], readonly [number, number]];
    /** Basemap URL for this region; falls back to the build-time default. */
    readonly pmtilesUrl?: string;
  };
  readonly layers: Readonly<Record<string, boolean>>;
}

const EARTH_M_PER_DEG_EQUATOR = 111_320;
/** Latitude scale barely varies with position; longitude is the one that does. */
export const M_PER_DEG_LAT = 110_540;

const LONDON_FALLBACK: Capabilities = {
  region: {
    name: 'London',
    center: [-0.1276, 51.5072],
    zoom: 11,
    maxBounds: [
      [-0.65, 51.2],
      [0.45, 51.77],
    ],
  },
  // Optimistic: if the backend cannot be reached, assume the full London layer
  // set rather than a stripped map. Each layer already fails independently, so
  // an over-generous guess costs a few failed fetches; an under-generous one
  // would silently hide working layers.
  layers: {
    transitLines: true,
    trainPositions: true,
    lineStatus: true,
    stopArrivals: true,
    jamCams: true,
    roadDisruptions: true,
    bikePoints: true,
    buses: true,
    nationalRail: true,
    bikeStations: true,
    vessels: true,
    tideGauges: true,
    aircraft: true,
    rainRadar: true,
  },
};

const CAPABILITIES_TIMEOUT_MS = 5_000;

let active: Capabilities = LONDON_FALLBACK;
/** Cached so hot render loops read a number, not a cosine, per frame. */
let mPerDegLon = EARTH_M_PER_DEG_EQUATOR * Math.cos((51.5072 * Math.PI) / 180);

/**
 * Metres per degree of longitude at the active region's latitude.
 *
 * Read this per call rather than caching it in a module-level `const`: a
 * module constant would be evaluated at import time, before the region is
 * known, and would silently pin every consumer to London. Hot loops should
 * still lift it into a local at function entry.
 */
export function metersPerDegLon(): number {
  return mPerDegLon;
}

export function region(): Capabilities['region'] {
  return active.region;
}

/** True when the backend reports this layer as available. Unknown → false. */
export function hasLayer(name: string): boolean {
  return active.layers[name] === true;
}

/**
 * Fetches capabilities, falling back to London on any failure. Never rejects:
 * a backend hiccup must degrade the layer set, not blank the page — before
 * this existed the map rendered regardless of what the API did, and that
 * property is worth keeping.
 */
export async function loadCapabilities(): Promise<Capabilities> {
  try {
    const response = await fetch('/api/capabilities', {
      signal: AbortSignal.timeout(CAPABILITIES_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as Partial<Capabilities>;
    if (!body.region || !body.layers) throw new Error('malformed capabilities payload');
    active = body as Capabilities;
  } catch (error) {
    console.warn('[region] /api/capabilities unavailable, assuming London:', error);
    active = LONDON_FALLBACK;
  }
  mPerDegLon = EARTH_M_PER_DEG_EQUATOR * Math.cos((active.region.center[1] * Math.PI) / 180);
  return active;
}
