// Unit tests for the route-shape layer: line → learned-file-key resolution, the
// fallback fetch caps, the region test, the FeatureCollection built from
// resolved geometry, and the progressive paint.
//
// ./buses is mocked wholesale — it value-imports maplibre-gl (Popup), and the
// fleet/index/geometry accessors are exactly the seams these tests drive.
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { BusRouteKey } from './bus-route-shape';
// Types only — vi.mock below replaces the module's runtime exports, not these.
import type { BusRouteIndex } from './buses';

const loadRouteGeometry = vi.fn<(fileKey: string) => Promise<[number, number][] | null>>();
const forgetRouteGeometry = vi.fn<(fileKey: string) => void>();
const activeBusRoutes = vi.fn<() => Iterable<{ line: string; routeFileKey: string }>>(() => []);
const busRouteIndex = vi.fn<() => BusRouteIndex | null>(() => null);

vi.mock('./buses', () => ({
  BUSES_DOTS_LAYER_ID: 'buses-dots',
  activeBusRoutes: () => activeBusRoutes(),
  busRouteIndex: () => busRouteIndex(),
  forgetRouteGeometry: (key: string) => forgetRouteGeometry(key),
  loadRouteGeometry: (key: string) => loadRouteGeometry(key),
  setBusRouteShapeHook: () => {},
}));

const {
  BUS_ROUTE_SHAPE_LINE_LAYER_ID,
  buildRouteShapeData,
  capRouteKeys,
  indexedKey,
  insideFraction,
  parseRouteStem,
  resolveRouteKeys,
  setBusRouteShapeLines,
  startBusRouteShapes,
} = await import('./bus-route-shape');

/** The fold buses.ts builds at index load, rebuilt here so the fixture below
 * is a plain list of stems. */
function index(stems: readonly string[]): BusRouteIndex {
  const set = new Set(stems);
  const folded = new Map<string, string>();
  for (const stem of set) {
    const lower = stem.toLowerCase();
    if (!folded.has(lower)) folded.set(lower, stem);
  }
  return { stems: set, folded };
}

/** Real stems from the learner output, plus its own run marker. ARHE_724 is
 * inbound-only, as it genuinely is in data/bus-routes/learned. */
const INDEX = index([
  '.last-run',
  'ARHE_20_inbound',
  'ARHE_20_outbound',
  'ARHE_724_inbound',
  'ENSB_x80_inbound',
  'GOCH_Go2_outbound',
  'LGEN_HE_clockwise',
  'METR_460_inbound',
  'METR_460_outbound',
  'NATX_032_inbound',
  'NATX_460_inbound',
  'NATX_460_outbound',
  'TFLO_20_inbound',
  'TFLO_24_inbound',
  'TFLO_24_outbound',
  'TFLO_32_inbound',
  'TFLO_460_inbound',
  'TFLO_460_outbound',
  'TMSB_20_outbound',
]);

const live = (line: string, routeFileKey: string) => ({ line, routeFileKey });

const key = (k: string, line: string, source: 'live' | 'index'): BusRouteKey => ({
  key: k,
  line,
  source,
});

/** `inside` vertices in central London followed by `outside` ones in Oxford.
 * region.ts is untouched here, so the active region is its London fallback. */
function polyline(inside: number, outside: number): [number, number][] {
  const poly: [number, number][] = [];
  for (let i = 0; i < inside; i += 1) poly.push([-0.12 + i * 0.001, 51.5]);
  for (let i = 0; i < outside; i += 1) poly.push([-1.25 + i * 0.001, 51.75]);
  return poly;
}

describe('parseRouteStem', () => {
  test('splits operator / line / direction', () => {
    // Arrange + Act
    const parsed = parseRouteStem('TFLO_24_outbound');

    // Assert
    expect(parsed).toEqual({ operator: 'TFLO', line: '24', direction: 'outbound' });
  });

  test('accepts directions beyond inbound/outbound', () => {
    expect(parseRouteStem('LGEN_HE_clockwise')).toEqual({
      operator: 'LGEN',
      line: 'HE',
      direction: 'clockwise',
    });
  });

  test('joins the middle segments so a sanitized line survives', () => {
    // Arrange — a BODS line containing a space sanitizes to an underscore
    // Act
    const parsed = parseRouteStem('TFLO_SL8_A_inbound');

    // Assert
    expect(parsed).toEqual({ operator: 'TFLO', line: 'SL8_A', direction: 'inbound' });
  });

  test('rejects the learner run marker the index also lists', () => {
    // '.last-run'.split('_') is ['.last', 'run'] — without the guard this would
    // parse as operator '.last' with an empty line.
    expect(parseRouteStem('.last-run')).toBeNull();
    expect(parseRouteStem('TFLO_24')).toBeNull();
  });
});

describe('indexedKey', () => {
  test('returns the index spelling for a key that differs only by case', () => {
    // Arrange + Act + Assert — the file is served by exact name off a
    // case-sensitive filesystem, so the tracker's own casing would 404
    expect(indexedKey('GOCH_go2_outbound', INDEX)).toBe('GOCH_Go2_outbound');
  });

  test('returns an exactly-indexed key untouched', () => {
    expect(indexedKey('TFLO_24_inbound', INDEX)).toBe('TFLO_24_inbound');
  });

  test('returns the key unchanged when nothing in the index folds onto it', () => {
    expect(indexedKey('NOPE_999_inbound', INDEX)).toBe('NOPE_999_inbound');
  });

  test('returns the key unchanged before the index has loaded', () => {
    expect(indexedKey('GOCH_go2_outbound', null)).toBe('GOCH_go2_outbound');
  });
});

describe('resolveRouteKeys', () => {
  test('uses the keys of the buses actually running the line', () => {
    // Arrange — the index also lists TFLO_24_outbound, but only inbound is live
    const fleet = [live('24', 'TFLO_24_inbound'), live('24', 'TFLO_24_inbound')];

    // Act
    const keys = resolveRouteKeys(new Set(['24']), fleet, INDEX);

    // Assert — deduplicated, and the outbound stem is NOT pulled in
    expect(keys).toEqual([{ key: 'TFLO_24_inbound', line: '24', source: 'live' }]);
  });

  test('falls back to every indexed stem when the line has no live bus', () => {
    // Act
    const keys = resolveRouteKeys(new Set(['24']), [], INDEX);

    // Assert
    expect(keys).toEqual([
      { key: 'TFLO_24_inbound', line: '24', source: 'index' },
      { key: 'TFLO_24_outbound', line: '24', source: 'index' },
    ]);
  });

  test('falls through to the index when the live key is not a file that exists', () => {
    // Arrange — ARHE runs 724 in both directions but the learner only ever
    // wrote the inbound shape, so half the fleet names a guaranteed 404
    const fleet = [live('724', 'ARHE_724_outbound'), live('724', 'ARHE_724_outbound')];

    // Act
    const keys = resolveRouteKeys(new Set(['724']), fleet, INDEX);

    // Assert — the missing key is neither fetched nor allowed to suppress the
    // fallback: selecting 724 draws the inbound shape rather than nothing
    expect(keys).toEqual([{ key: 'ARHE_724_inbound', line: '724', source: 'index' }]);
  });

  test('a live key that does exist still suppresses the fallback for its line', () => {
    // Arrange — both directions of 460 are indexed; only one is running
    const fleet = [live('460', 'TFLO_460_inbound')];

    // Act
    const keys = resolveRouteKeys(new Set(['460']), fleet, INDEX);

    // Assert
    expect(keys).toEqual([{ key: 'TFLO_460_inbound', line: '460', source: 'live' }]);
  });

  test('resolves live and fallback lines independently in one selection', () => {
    // Arrange — 24 is running, 460 is not
    const fleet = [live('24', 'TFLO_24_outbound')];

    // Act
    const keys = resolveRouteKeys(new Set(['24', '460']), fleet, INDEX);

    // Assert
    expect(keys.filter((k) => k.line === '24')).toEqual([
      { key: 'TFLO_24_outbound', line: '24', source: 'live' },
    ]);
    expect(keys.filter((k) => k.line === '460').map((k) => k.key)).toEqual([
      'METR_460_inbound',
      'METR_460_outbound',
      'NATX_460_inbound',
      'NATX_460_outbound',
      'TFLO_460_inbound',
      'TFLO_460_outbound',
    ]);
  });

  test('a multi-operator line yields one fallback key per operator+direction', () => {
    // Act
    const keys = resolveRouteKeys(new Set(['20']), [], INDEX);

    // Assert
    expect(keys.map((k) => k.key)).toEqual([
      'ARHE_20_inbound',
      'ARHE_20_outbound',
      'TFLO_20_inbound',
      'TMSB_20_outbound',
    ]);
    expect(keys.every((k) => k.source === 'index')).toBe(true);
  });

  test('matches lines case-insensitively (typed GO2 vs BODS Go2)', () => {
    // Arrange — the tracker keeps BODS casing, the chip may be uppercased
    const fleet = [live('Go2', 'GOCH_go2_outbound')];

    // Act
    const keys = resolveRouteKeys(new Set(['GO2']), fleet, INDEX);

    // Assert — the INDEX spelling wins, because the file is served by exact
    // name off a case-sensitive filesystem
    expect(keys).toEqual([{ key: 'GOCH_Go2_outbound', line: 'GO2', source: 'live' }]);
  });

  test('finds a lowercase indexed stem for an uppercased line', () => {
    expect(resolveRouteKeys(new Set(['X80']), [], INDEX)).toEqual([
      { key: 'ENSB_x80_inbound', line: 'X80', source: 'index' },
    ]);
  });

  test('never conflates a zero-padded coach line with the London one', () => {
    // Act
    const padded = resolveRouteKeys(new Set(['032']), [], INDEX);
    const plain = resolveRouteKeys(new Set(['32']), [], INDEX);

    // Assert
    expect(padded.map((k) => k.key)).toEqual(['NATX_032_inbound']);
    expect(plain.map((k) => k.key)).toEqual(['TFLO_32_inbound']);
  });

  test('skips the run marker and unknown lines without throwing', () => {
    expect(resolveRouteKeys(new Set(['N7']), [], INDEX)).toEqual([]);
    expect(resolveRouteKeys(new Set([]), [], INDEX)).toEqual([]);
  });

  test('works before the index has loaded, on live keys alone', () => {
    // Act — with no index there is nothing to check the key against, so it is
    // taken at face value
    const keys = resolveRouteKeys(new Set(['24']), [live('24', 'TFLO_24_inbound')], null);

    // Assert
    expect(keys).toEqual([{ key: 'TFLO_24_inbound', line: '24', source: 'live' }]);
  });
});

describe('insideFraction', () => {
  test('counts vertices within the region bounds', () => {
    expect(insideFraction(polyline(8, 2))).toBeCloseTo(0.8, 6);
    expect(insideFraction(polyline(0, 5))).toBe(0);
    expect(insideFraction(polyline(5, 0))).toBe(1);
  });

  test('treats the bounds as inclusive at their corners', () => {
    // Arrange — exactly [[west, south], [east, north]] of the London fallback
    const corners: [number, number][] = [
      [-0.65, 51.2],
      [0.45, 51.77],
    ];

    // Act + Assert
    expect(insideFraction(corners)).toBe(1);
  });

  test('is 0 for an empty polyline rather than NaN', () => {
    expect(insideFraction([])).toBe(0);
  });
});

describe('capRouteKeys', () => {
  test('leaves live keys alone — they are already cached, not fetches', () => {
    // Arrange — more live keys than either fallback cap allows
    const keys = Array.from({ length: 20 }, (_, i) => key(`TFLO_24_${i}`, '24', 'live'));

    // Act
    const capped = capRouteKeys(keys);

    // Assert
    expect(capped).toHaveLength(20);
  });

  test('caps fallback stems per line at the corpus maximum', () => {
    // Arrange — more stems than any real line carries
    const keys = Array.from({ length: 10 }, (_, i) => key(`OP${i}_20_inbound`, '20', 'index'));

    // Act
    const capped = capRouteKeys(keys);

    // Assert
    expect(capped.map((k) => k.key)).toEqual([
      'OP0_20_inbound',
      'OP1_20_inbound',
      'OP2_20_inbound',
      'OP3_20_inbound',
      'OP4_20_inbound',
      'OP5_20_inbound',
    ]);
  });

  test('keeps the local operator when the per-line cap truncates', () => {
    // Arrange — the alphabetically-last operator is the London one, as TFLO is
    // for the real 460 (METR_/NATX_/TFLO_ inbound+outbound)
    const keys = [
      ...Array.from({ length: 8 }, (_, i) => key(`AAA${i}_460_inbound`, '460', 'index')),
      key('TFLO_460_inbound', '460', 'index'),
      key('TFLO_460_outbound', '460', 'index'),
    ];

    // Act
    const capped = capRouteKeys(keys);

    // Assert — the out-of-town coaches must not crowd out the route the user
    // actually typed
    expect(capped.slice(0, 2).map((k) => k.key)).toEqual([
      'TFLO_460_inbound',
      'TFLO_460_outbound',
    ]);
    expect(capped).toHaveLength(6);
  });

  test('ranks the local operator first even when nothing is truncated', () => {
    // Arrange — the real 460 index order
    const keys = resolveRouteKeys(new Set(['460']), [], INDEX);

    // Act
    const capped = capRouteKeys(keys);

    // Assert
    expect(capped.map((k) => k.key)).toEqual([
      'TFLO_460_inbound',
      'TFLO_460_outbound',
      'METR_460_inbound',
      'METR_460_outbound',
      'NATX_460_inbound',
      'NATX_460_outbound',
    ]);
  });

  test('gives every selected line a stem when the global ceiling binds', () => {
    // Arrange — five lines × ten stems each; 6 per line would be 30
    const lines = ['20', '21', '22', '242', '251'];
    const keys = lines.flatMap((line) =>
      Array.from({ length: 10 }, (_, i) => key(`OP${i}_${line}_inbound`, line, 'index')),
    );

    // Act
    const capped = capRouteKeys(keys);

    // Assert — the ceiling costs each line depth, never its whole shape: two
    // full rounds of five, then the remaining two go to the first two lines
    expect(capped).toHaveLength(12);
    for (const line of lines) {
      const forLine = capped.filter((k) => k.line === line).map((k) => k.key);
      expect(forLine.length).toBeGreaterThanOrEqual(2);
      expect(forLine.slice(0, 2)).toEqual([`OP0_${line}_inbound`, `OP1_${line}_inbound`]);
    }
  });

  test('keeps the local operator for every line when the ceiling binds', () => {
    // Arrange — six lines, so only two stems each fit under the ceiling
    const lines = ['20', '21', '22', '242', '251', '460'];
    const keys = lines.flatMap((line) => [
      key(`AAAA_${line}_inbound`, line, 'index'),
      key(`BBBB_${line}_inbound`, line, 'index'),
      key(`TFLO_${line}_inbound`, line, 'index'),
    ]);

    // Act
    const capped = capRouteKeys(keys);

    // Assert
    expect(capped).toHaveLength(12);
    for (const line of lines) {
      expect(capped.some((k) => k.key === `TFLO_${line}_inbound`)).toBe(true);
    }
  });

  test('keeps every live key while capping the fallback ones beside it', () => {
    // Arrange
    const keys = [
      ...Array.from({ length: 6 }, (_, i) => key(`TFLO_24_${i}`, '24', 'live')),
      ...Array.from({ length: 10 }, (_, i) => key(`OP${i}_20_inbound`, '20', 'index')),
    ];

    // Act
    const capped = capRouteKeys(keys);

    // Assert — live first, then at most six fallbacks
    expect(capped.filter((k) => k.source === 'live')).toHaveLength(6);
    expect(capped.filter((k) => k.source === 'index')).toHaveLength(6);
    expect(capped.slice(0, 6).every((k) => k.source === 'live')).toBe(true);
  });
});

describe('buildRouteShapeData', () => {
  test('an empty selection produces an empty FeatureCollection', () => {
    // Act
    const data = buildRouteShapeData([], []);

    // Assert
    expect(data).toEqual({ type: 'FeatureCollection', features: [] });
  });

  test('a selection with geometry produces one LineString per key', () => {
    // Arrange
    const keys = [key('TFLO_24_inbound', '24', 'live'), key('TFLO_24_outbound', '24', 'live')];
    const geometries = [polyline(4, 0), polyline(6, 0)];

    // Act
    const data = buildRouteShapeData(keys, geometries);

    // Assert
    expect(data.features).toHaveLength(2);
    expect(data.features[0].geometry).toEqual({ type: 'LineString', coordinates: geometries[0] });
    // `line` is carried for a future hover/tap; nothing in the paint reads it.
    expect(data.features.map((f) => f.properties)).toEqual([
      { line: '24', key: 'TFLO_24_inbound' },
      { line: '24', key: 'TFLO_24_outbound' },
    ]);
  });

  test('drops an index-derived shape that mostly lies outside the region', () => {
    // Arrange — an Oxford-Tube-shaped coach: 16% of its vertices inside London
    const keys = [key('SCOX_TUBE_outbound', 'TUBE', 'index')];

    // Act
    const data = buildRouteShapeData(keys, [polyline(4, 21)]);

    // Assert
    expect(data.features).toEqual([]);
  });

  test('keeps an outer-London index shape that is mostly inside', () => {
    // Arrange — 72% inside, like the real METR_460 stems
    const keys = [key('METR_460_inbound', '460', 'index')];

    // Act
    const data = buildRouteShapeData(keys, [polyline(18, 7)]);

    // Assert
    expect(data.features).toHaveLength(1);
  });

  test('never region-drops a live shape — a running bus is proof of region', () => {
    // Arrange — same geometry that was dropped as an index key above
    const keys = [key('SCOX_TUBE_outbound', 'TUBE', 'live')];

    // Act
    const data = buildRouteShapeData(keys, [polyline(4, 21)]);

    // Assert
    expect(data.features).toHaveLength(1);
  });

  test('skips missing and degenerate geometry without shifting the others', () => {
    // Arrange — key/geometry arrays stay index-aligned across the skips
    const keys = [
      key('TFLO_24_inbound', '24', 'live'),
      key('TFLO_88_inbound', '88', 'live'),
      key('TFLO_29_inbound', '29', 'live'),
    ];
    const geometries = [null, polyline(1, 0), polyline(3, 0)];

    // Act
    const data = buildRouteShapeData(keys, geometries);

    // Assert — only the third key survives, and it keeps its own properties
    expect(data.features).toHaveLength(1);
    expect(data.features[0].properties).toEqual({ line: '29', key: 'TFLO_29_inbound' });
  });
});

describe('setBusRouteShapeLines', () => {
  /** Enough of a MapLibre map for the layer's own calls, recording setData. */
  function fakeMap() {
    const painted: GeoJSON.FeatureCollection[] = [];
    const layers = new Set<string>();
    const map = {
      addSource: () => {},
      addLayer: (layer: { id: string }) => layers.add(layer.id),
      getLayer: (id: string) => (layers.has(id) ? { id } : undefined),
      getSource: () => ({ setData: (data: GeoJSON.FeatureCollection) => painted.push(data) }),
      setLayoutProperty: () => {},
    };
    return { map: map as unknown as Parameters<typeof startBusRouteShapes>[0], painted };
  }

  /** A deferred promise, so a test can hold one key's fetch open. */
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  beforeEach(() => {
    vi.clearAllMocks();
    activeBusRoutes.mockReturnValue([]);
    busRouteIndex.mockReturnValue(INDEX);
  });

  test('paints a resolved key without waiting for a slow one', async () => {
    // Arrange — line 24's two indexed stems; the outbound fetch never settles
    const { map, painted } = fakeMap();
    await startBusRouteShapes(map);
    const stalled = deferred<[number, number][] | null>();
    loadRouteGeometry.mockImplementation(async (fileKey) =>
      fileKey === 'TFLO_24_outbound' ? stalled.promise : polyline(6, 0),
    );

    // Act
    setBusRouteShapeLines(map, new Set(['24']));
    await flush();

    // Assert — the inbound shape is on screen while outbound is still in flight
    const last = painted[painted.length - 1];
    expect(last.features).toHaveLength(1);
    expect(last.features[0].properties).toEqual({ line: '24', key: 'TFLO_24_inbound' });

    // Act — and the slow one merges in when it finally lands
    stalled.resolve(polyline(4, 0));
    await flush();

    // Assert
    expect(painted[painted.length - 1].features).toHaveLength(2);
  });

  test('a superseded selection never paints, however late it resolves', async () => {
    // Arrange
    const { map, painted } = fakeMap();
    await startBusRouteShapes(map);
    const stalled = deferred<[number, number][] | null>();
    loadRouteGeometry.mockImplementation(async (fileKey) =>
      fileKey.startsWith('TFLO_24') ? stalled.promise : polyline(6, 0),
    );

    // Act — select 24, then switch to 32 before 24 resolves
    setBusRouteShapeLines(map, new Set(['24']));
    await flush();
    setBusRouteShapeLines(map, new Set(['32']));
    await flush();
    const afterSwitch = painted.length;
    stalled.resolve(polyline(9, 0));
    await flush();

    // Assert — the abandoned selection landed on nothing
    expect(painted).toHaveLength(afterSwitch);
    expect(painted[afterSwitch - 1].features[0].properties).toEqual({
      line: '32',
      key: 'TFLO_32_inbound',
    });
  });

  test('releases index-derived geometry so it cannot evict the snapping cache', async () => {
    // Arrange
    const { map } = fakeMap();
    await startBusRouteShapes(map);
    activeBusRoutes.mockReturnValue([live('24', 'TFLO_24_inbound')]);
    loadRouteGeometry.mockResolvedValue(polyline(6, 0));

    // Act — 24 is live (its key stays cached for snapping), 460 is a fallback
    setBusRouteShapeLines(map, new Set(['24', '460']));
    await flush();

    // Assert
    const released = forgetRouteGeometry.mock.calls.map(([k]) => k);
    expect(released).not.toContain('TFLO_24_inbound');
    expect(new Set(released)).toEqual(
      new Set([
        'TFLO_460_inbound',
        'TFLO_460_outbound',
        'METR_460_inbound',
        'METR_460_outbound',
        'NATX_460_inbound',
        'NATX_460_outbound',
      ]),
    );
  });

  test('clearing the filter empties the source and hides the layers', async () => {
    // Arrange
    const { map, painted } = fakeMap();
    await startBusRouteShapes(map);
    loadRouteGeometry.mockResolvedValue(polyline(6, 0));
    setBusRouteShapeLines(map, new Set(['24']));
    await flush();

    // Act
    setBusRouteShapeLines(map, null);
    await flush();

    // Assert
    expect(painted[painted.length - 1]).toEqual({ type: 'FeatureCollection', features: [] });
    expect(loadRouteGeometry).not.toHaveBeenCalledWith(expect.stringContaining('_32_'));
  });

  test('does nothing in a region that never built the layer', () => {
    // Arrange — a map without the bus-route-shape layers
    const { map, painted } = fakeMap();

    // Act
    setBusRouteShapeLines(map, new Set(['24']));

    // Assert
    expect(painted).toEqual([]);
    expect(map.getLayer(BUS_ROUTE_SHAPE_LINE_LAYER_ID)).toBeUndefined();
  });
});
