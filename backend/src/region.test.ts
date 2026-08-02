import { describe, expect, it } from 'vitest';
import {
  bboxToString,
  contains,
  loadRegion,
  parseBbox,
  parseFlag,
  parseLonLat,
  VALIDATION_MARGIN_DEG,
  widen,
  type EnvReader,
} from './region';

/** An env reader backed by a plain object; unset keys read as undefined. */
const envFrom =
  (vars: Record<string, string>): EnvReader =>
  (name) =>
    vars[name];

const noEnv: EnvReader = () => undefined;

describe('parseBbox', () => {
  it('parses four comma-separated numbers in lon,lat order', () => {
    expect(parseBbox('X', '-0.55,51.25,0.35,51.72')).toEqual({
      minLon: -0.55,
      minLat: 51.25,
      maxLon: 0.35,
      maxLat: 51.72,
    });
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseBbox('X', ' 1 , 2 , 3 , 4 ')).toEqual({
      minLon: 1,
      minLat: 2,
      maxLon: 3,
      maxLat: 4,
    });
  });

  it('names the offending variable in the error message', () => {
    expect(() => parseBbox('AIS_BBOX', 'nonsense')).toThrow(/AIS_BBOX/);
  });

  it('rejects the wrong number of components', () => {
    expect(() => parseBbox('X', '1,2,3')).toThrow();
    expect(() => parseBbox('X', '1,2,3,4,5')).toThrow();
  });

  it('rejects non-numeric components', () => {
    expect(() => parseBbox('X', '1,2,three,4')).toThrow();
  });

  it('rejects out-of-range coordinates', () => {
    expect(() => parseBbox('X', '-181,0,1,1')).toThrow(/longitude/);
    expect(() => parseBbox('X', '0,-91,1,1')).toThrow(/latitude/);
  });

  it('rejects inverted or degenerate boxes', () => {
    expect(() => parseBbox('X', '5,0,1,1')).toThrow(/strictly below/);
    expect(() => parseBbox('X', '0,0,0,1')).toThrow(/strictly below/);
  });
});

describe('parseLonLat', () => {
  it('parses lon before lat', () => {
    expect(parseLonLat('X', '-0.12,51.5')).toEqual({ lon: -0.12, lat: 51.5 });
  });

  it('rejects malformed or out-of-range points', () => {
    expect(() => parseLonLat('X', '51.5')).toThrow();
    expect(() => parseLonLat('X', '0,91')).toThrow(/latitude/);
    expect(() => parseLonLat('X', '181,0')).toThrow(/longitude/);
  });
});

describe('parseFlag', () => {
  it('falls back when unset or blank', () => {
    expect(parseFlag(undefined, true)).toBe(true);
    expect(parseFlag('   ', false)).toBe(false);
  });

  it('treats off/false/0/no as disabled, case-insensitively', () => {
    for (const raw of ['off', 'OFF', 'false', '0', 'no']) {
      expect(parseFlag(raw, true)).toBe(false);
    }
  });

  it('treats anything else as enabled', () => {
    for (const raw of ['on', 'true', '1', 'yes']) {
      expect(parseFlag(raw, false)).toBe(true);
    }
  });
});

describe('widen', () => {
  it('grows the box outwards on every side', () => {
    expect(widen({ minLon: 0, minLat: 0, maxLon: 1, maxLat: 1 }, 0.5)).toEqual({
      minLon: -0.5,
      minLat: -0.5,
      maxLon: 1.5,
      maxLat: 1.5,
    });
  });

  it('clamps to valid coordinate ranges', () => {
    const wide = widen({ minLon: -179.9, minLat: -89.9, maxLon: 179.9, maxLat: 89.9 }, 1);
    expect(wide).toEqual({ minLon: -180, minLat: -90, maxLon: 180, maxLat: 90 });
  });

  // Regression guard: the derived validation box must stay a superset of the
  // bounds that were hard-coded before this refactor, so no coordinate that
  // used to be accepted can start being rejected.
  it('covers the previous hard-coded London validation bounds', () => {
    const derived = widen(loadRegion(noEnv).bbox, VALIDATION_MARGIN_DEG);
    const PREVIOUS = { minLon: -0.7, minLat: 51.2, maxLon: 0.5, maxLat: 51.8 };
    expect(derived.minLon).toBeLessThanOrEqual(PREVIOUS.minLon);
    expect(derived.minLat).toBeLessThanOrEqual(PREVIOUS.minLat);
    expect(derived.maxLon).toBeGreaterThanOrEqual(PREVIOUS.maxLon);
    expect(derived.maxLat).toBeGreaterThanOrEqual(PREVIOUS.maxLat);
  });
});

describe('contains', () => {
  const box = { minLon: -1, minLat: 50, maxLon: 1, maxLat: 52 };

  it('accepts interior points and every edge', () => {
    expect(contains(box, 0, 51)).toBe(true);
    expect(contains(box, -1, 50)).toBe(true);
    expect(contains(box, 1, 52)).toBe(true);
  });

  it('rejects points outside on either axis', () => {
    expect(contains(box, -1.1, 51)).toBe(false);
    expect(contains(box, 0, 52.1)).toBe(false);
  });
});

describe('bboxToString', () => {
  it('round-trips through parseBbox', () => {
    const original = '-0.55,51.25,0.35,51.72';
    expect(bboxToString(parseBbox('X', original))).toBe(original);
  });
});

describe('loadRegion', () => {
  // The whole refactor rests on this: an environment that sets nothing must
  // reproduce the values that were previously hard-coded across the backend.
  it('defaults to the exact London geography used before the refactor', () => {
    const region = loadRegion(noEnv);
    expect(region.name).toBe('London');
    // bods-client boundingBox + ea-tides station filter
    expect(bboxToString(region.bbox)).toBe('-0.55,51.25,0.35,51.72');
    // frontend maxBounds
    expect(bboxToString(region.viewBounds)).toBe('-0.65,51.2,0.45,51.77');
    expect(region.centerLon).toBe(-0.1276);
    expect(region.centerLat).toBe(51.5072);
    expect(region.zoom).toBe(11);
    // ais-client THAMES_BOUNDING_BOXES
    expect(bboxToString(region.aisBbox)).toBe('-0.55,51.3,0.45,51.62');
    // routes/external ADSB point + radius
    expect(region.adsb).toEqual({ lon: -0.12, lat: 51.5, radiusNm: 30 });
    expect(region.tideGauges).toBe(true);
  });

  it('treats blank values as unset', () => {
    const region = loadRegion(envFrom({ REGION_NAME: '   ', REGION_ZOOM: '' }));
    expect(region.name).toBe('London');
    expect(region.zoom).toBe(11);
  });

  it('applies every override independently', () => {
    const region = loadRegion(
      envFrom({
        REGION_NAME: 'Elsewhere',
        REGION_BBOX: '54.85,24.75,55.65,25.45',
        REGION_VIEW_BOUNDS: '54.7,24.6,55.8,25.6',
        REGION_CENTER: '55.27,25.2',
        REGION_ZOOM: '10.5',
        AIS_BBOX: '54.5,24.4,55.9,25.8',
        ADSB_CENTER: '55.36,25.25',
        ADSB_RADIUS_NM: '45',
        TIDE_GAUGES: 'off',
      }),
    );
    expect(region.name).toBe('Elsewhere');
    expect(region.bbox.minLon).toBe(54.85);
    expect(region.viewBounds.maxLat).toBe(25.6);
    expect(region.centerLon).toBe(55.27);
    expect(region.zoom).toBe(10.5);
    expect(region.aisBbox.maxLon).toBe(55.9);
    expect(region.adsb).toEqual({ lon: 55.36, lat: 25.25, radiusNm: 45 });
    expect(region.tideGauges).toBe(false);
  });

  it('refuses to start on a malformed override rather than falling back', () => {
    expect(() => loadRegion(envFrom({ REGION_BBOX: '1,2,3' }))).toThrow(/REGION_BBOX/);
    expect(() => loadRegion(envFrom({ ADSB_CENTER: 'x,y' }))).toThrow(/ADSB_CENTER/);
    expect(() => loadRegion(envFrom({ REGION_ZOOM: '99' }))).toThrow(/REGION_ZOOM/);
    expect(() => loadRegion(envFrom({ ADSB_RADIUS_NM: '0' }))).toThrow(/ADSB_RADIUS_NM/);
  });
});
