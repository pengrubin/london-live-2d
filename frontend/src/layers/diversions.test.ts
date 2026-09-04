// The diversion layer's pure halves — the freshness line, the search scope, the
// popup — and the two-input truth table that decides what reaches the map.
//
// Three module stubs, each for a reason:
//   • maplibre-gl, because diversions.ts value-imports Popup and this run stays
//     in the fast node environment (the bus-filter.test.ts pattern);
//   • util/lifecycle, because registerPoll reaches for `window`;
//   • ./buses, because searched-lines.ts registers its single hook there.
// searched-lines.ts itself is REAL: the matching rule is exactly what the
// substring and destination-suffix cases below are about, and calling the
// captured hook back is how a real filter change is simulated end to end.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Map as MaplibreMap } from 'maplibre-gl';

vi.mock('maplibre-gl', () => ({ Popup: class {} }));

const registerPoll = vi.fn<(fn: () => void, ms: number) => void>();
vi.mock('../util/lifecycle', () => ({
  registerPoll: (fn: () => void, ms: number) => registerPoll(fn, ms),
}));

type RouteShapeHook = (map: MaplibreMap, lines: ReadonlySet<string> | null) => void | Promise<void>;

/** Every hook searched-lines.ts registered on buses.ts, this test run. */
let registeredHooks: readonly RouteShapeHook[] = [];

vi.mock('./buses', () => ({
  setBusRouteShapeHook: (hook: RouteShapeHook) => {
    registeredHooks = [...registeredHooks, hook];
  },
}));

const {
  DIVERSIONS_SEGMENTS_LAYER_ID,
  buildDiversionFeatures,
  diversionPopupHtml,
  eventsOnSearchedLines,
  freshnessLabel,
} = await import('./diversions');

import type { DiversionEvent, DiversionProps } from './diversions';

const NOW = 1_788_100_000;

const SEGMENT: [number, number][] = [
  [-0.1, 51.5],
  [-0.11, 51.51],
];

const event = (over: Partial<DiversionEvent> = {}): DiversionEvent => ({
  id: 'e1',
  status: 'active',
  severity: 'road',
  startedAt: NOW - 3600,
  lastEvidenceAt: NOW - 300,
  routes: ['46'],
  vehicles: 3,
  segments: [SEGMENT],
  ...over,
});

const propsOf = (feature: GeoJSON.Feature): DiversionProps =>
  feature.properties as unknown as DiversionProps;

describe('freshnessLabel', () => {
  test('reads as "just now" inside the first minute', () => {
    expect(freshnessLabel(NOW - 30, NOW)).toBe('last diverting bus just now');
  });

  test('reports whole minutes under an hour', () => {
    expect(freshnessLabel(NOW - 16 * 60 - 40, NOW)).toBe('last diverting bus 16 min ago');
  });

  test('switches to hours and minutes past the hour', () => {
    expect(freshnessLabel(NOW - (2 * 3600 + 5 * 60), NOW)).toBe('last diverting bus 2 h 5 min ago');
  });

  test('says nothing when the timestamp is missing or in the future', () => {
    // A clock-skewed client must not render "last diverting bus -3 min ago".
    expect(freshnessLabel(0, NOW)).toBe('');
    expect(freshnessLabel(Number.NaN, NOW)).toBe('');
    expect(freshnessLabel(NOW + 180, NOW)).toBe('');
  });
});

describe('eventsOnSearchedLines', () => {
  test('surfaces an event that serves the searched line', () => {
    // Arrange
    const events = [event({ id: 'a', routes: ['46', '172'] }), event({ id: 'b', routes: ['12'] })];

    // Act
    const scoped = eventsOnSearchedLines(events, new Set(['46']));

    // Assert
    expect(scoped.map((ev) => ev.id)).toEqual(['a']);
  });

  test('does NOT surface 146, 460 or N46 when the rider searched 46', () => {
    // The properties MapLibre sees carry `routes` as a joined string, so an
    // `['in', '46', ['get','routes']]` filter would substring-match all three.
    // Arrange
    const events = [
      event({ id: 'one-four-six', routes: ['146'] }),
      event({ id: 'four-sixty', routes: ['460'] }),
      event({ id: 'night', routes: ['N46'] }),
      event({ id: 'wanted', routes: ['46'] }),
    ];

    // Act
    const scoped = eventsOnSearchedLines(events, new Set(['46']));

    // Assert
    expect(scoped.map((ev) => ev.id)).toEqual(['wanted']);
  });

  test('matches a route label carrying its destination sign', () => {
    // Arrange — diversion-events.ts labels a diverting route "SL8 → Uxbridge".
    const events = [event({ id: 'sl8', routes: ['SL8 → Uxbridge'] })];

    // Act
    const scoped = eventsOnSearchedLines(events, new Set(['SL8']));

    // Assert
    expect(scoped.map((ev) => ev.id)).toEqual(['sl8']);
  });

  test('surfaces nothing when the rider is not searching', () => {
    // Arrange
    const events = [event()];

    // Act / Assert
    expect(eventsOnSearchedLines(events, null)).toEqual([]);
  });

  test('keeps a zero-padded route apart from its unpadded twin', () => {
    // 025 is National Express, 25 is a London bus — different roads.
    // Arrange
    const events = [event({ id: 'natx', routes: ['025'] })];

    // Act / Assert
    expect(eventsOnSearchedLines(events, new Set(['25']))).toEqual([]);
    expect(eventsOnSearchedLines(events, new Set(['025'])).map((ev) => ev.id)).toEqual(['natx']);
  });
});

describe('buildDiversionFeatures', () => {
  test('draws a search-scoped event exactly like a toggled one', () => {
    // Search changes WHICH events are drawn, never how they look, so every
    // property the paint expressions read must be identical in both modes.
    // Arrange
    const events = [event({ routes: ['46', '172'], severity: 'partial', status: 'recovering' })];

    // Act
    const byToggle = propsOf(buildDiversionFeatures(events, false)[0]);
    const bySearch = propsOf(buildDiversionFeatures(events, true)[0]);

    // Assert
    const painted = ({ scoped: _scoped, ...rest }: DiversionProps) => rest;
    expect(painted(bySearch)).toEqual(painted(byToggle));
    expect(buildDiversionFeatures(events, true)[0].geometry).toEqual(
      buildDiversionFeatures(events, false)[0].geometry,
    );
  });

  test('keeps every route on the feature, not just the searched one', () => {
    // Arrange / Act
    const props = propsOf(buildDiversionFeatures([event({ routes: ['172', '46'] })], true)[0]);

    // Assert
    expect(props.routes).toBe('46, 172');
    expect(props.scoped).toBe(true);
  });
});

describe('diversionPopupHtml', () => {
  const propsFor = (over: Partial<DiversionEvent>, scoped: boolean): DiversionProps =>
    propsOf(buildDiversionFeatures([event(over)], scoped)[0]);

  test('names every affected route and disowns the shape when search drew it', () => {
    // The geometry merges the bracket slices of every route on the event, so a
    // popup opened from a search must not read as "your route goes this way".
    // Arrange
    const props = propsFor({ routes: ['46', '172'] }, true);

    // Act
    const html = diversionPopupHtml(props);

    // Assert
    expect(html).toContain('Affects routes 46, 172');
    expect(html).toContain('not one route’s path');
  });

  test('says nothing about scope when the overlay drew it', () => {
    // Arrange
    const props = propsFor({ routes: ['46', '172'] }, false);

    // Act
    const html = diversionPopupHtml(props);

    // Assert
    expect(html).not.toContain('Affects routes');
    expect(html).toContain('46, 172');
  });
});

describe('the two inputs that decide what is drawn', () => {
  /** Enough of a MapLibre map for the layer's own calls, recording every write. */
  function fakeMap() {
    const painted: GeoJSON.FeatureCollection[] = [];
    const layerIds = new Set<string>();
    const specs: { id: string; filter?: unknown }[] = [];
    const visibility = new Map<string, string>();
    const filters: unknown[] = [];
    const paints: string[] = [];
    const map = {
      addSource: () => {},
      addLayer: (layer: { id: string; filter?: unknown }) => {
        layerIds.add(layer.id);
        specs.push(layer);
      },
      getLayer: (id: string) => (layerIds.has(id) ? { id } : undefined),
      getSource: () => ({ setData: (data: GeoJSON.FeatureCollection) => painted.push(data) }),
      setLayoutProperty: (id: string, _prop: string, value: string) => visibility.set(id, value),
      setFilter: (_id: string, filter: unknown) => filters.push(filter),
      setPaintProperty: (_id: string, prop: string) => paints.push(prop),
      getCanvas: () => ({ style: {} }),
      on: () => {},
    };
    return { map: map as unknown as MaplibreMap, painted, visibility, filters, paints, specs };
  }

  const body = (events: DiversionEvent[]) => ({ ok: true, json: async () => ({ events }) });

  let fetchSpy: ReturnType<typeof vi.fn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  /** Module state (overlay, selection, cached events) outlives one test. */
  async function freshModule(): Promise<typeof import('./diversions')> {
    vi.resetModules();
    registeredHooks = [];
    registerPoll.mockClear();
    return await import('./diversions');
  }

  /** buses.ts hands hooks the map; searched-lines.ts ignores it. */
  function search(lines: readonly string[] | null): void {
    const selection = lines === null ? null : new Set(lines);
    for (const hook of registeredHooks) hook({} as MaplibreMap, selection);
  }

  const EVENTS = [
    event({ id: 'wanted', routes: ['46'] }),
    event({ id: 'lookalike', routes: ['146'] }),
    event({ id: 'other', routes: ['12'] }),
  ];

  const drawnRoutes = (fc: GeoJSON.FeatureCollection): string[] =>
    fc.features.map((f) => propsOf(f).routes);

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchSpy = vi.fn(async () => body(EVENTS));
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test('overlay off and nothing searched: hidden, and ZERO fetches', async () => {
    // Arrange / Act — the overlay ships off and no line is searched.
    const { map, visibility } = fakeMap();
    const { startDiversions } = await freshModule();
    await startDiversions(map);

    // Assert
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(visibility.get(DIVERSIONS_SEGMENTS_LAYER_ID)).toBe('none');

    // And the registered poller stays silent too, tick after tick.
    const tick = registerPoll.mock.calls[0]?.[0] as () => void;
    tick();
    await Promise.resolve();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('overlay off and a line searched: only that line’s events, from one fetch', async () => {
    // Arrange
    const { map, painted, visibility } = fakeMap();
    const { startDiversions } = await freshModule();
    await startDiversions(map);

    // Act
    search(['46']);

    // Assert — 146 is a different road and must not ride along.
    await vi.waitFor(() => expect(drawnRoutes(painted.at(-1)!)).toEqual(['46']));
    expect(visibility.get(DIVERSIONS_SEGMENTS_LAYER_ID)).toBe('visible');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith('/api/diversions');
  });

  test('overlay on: every event, searched line or not', async () => {
    // Arrange
    const { map, painted } = fakeMap();
    const { startDiversions, setDiversionsVisible } = await freshModule();
    await startDiversions(map);

    // Act
    setDiversionsVisible(map, true);
    await vi.waitFor(() => expect(drawnRoutes(painted.at(-1)!)).toEqual(['46', '146', '12']));

    // Assert — a search must not narrow what the toggle already asked for.
    search(['46']);
    expect(drawnRoutes(painted.at(-1)!)).toEqual(['46', '146', '12']);
  });

  test('turning the overlay off mid-search falls back to the searched line', async () => {
    // Arrange
    const { map, painted, visibility } = fakeMap();
    const { startDiversions, setDiversionsVisible } = await freshModule();
    await startDiversions(map);
    setDiversionsVisible(map, true);
    await vi.waitFor(() => expect(painted.at(-1)!.features).toHaveLength(3));
    search(['46']);

    // Act
    setDiversionsVisible(map, false);

    // Assert — still on screen, now scoped, and no refetch was needed.
    expect(drawnRoutes(painted.at(-1)!)).toEqual(['46']);
    expect(visibility.get(DIVERSIONS_SEGMENTS_LAYER_ID)).toBe('visible');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test('clearing the search with the overlay off empties and hides the layer', async () => {
    // Arrange
    const { map, painted, visibility } = fakeMap();
    const { startDiversions } = await freshModule();
    await startDiversions(map);
    search(['46']);
    await vi.waitFor(() => expect(painted.at(-1)!.features).toHaveLength(1));

    // Act
    search(null);

    // Assert
    expect(painted.at(-1)!.features).toEqual([]);
    expect(visibility.get(DIVERSIONS_SEGMENTS_LAYER_ID)).toBe('none');

    // And it is back to costing nothing.
    const tick = registerPoll.mock.calls[0]?.[0] as () => void;
    tick();
    await Promise.resolve();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test('a rider already searching when the layer starts gets one fetch, not two', async () => {
    // Arrange — subscribing replays the current selection synchronously, and
    // the awaited start-up poll must stay the only request that follows.
    const { map } = fakeMap();
    const { startDiversions } = await freshModule();
    await startDiversions(map);
    search(['46']);
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

    // Act — a second layer start with the selection already live.
    const second = fakeMap();
    await startDiversions(second.map);

    // Assert
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(drawnRoutes(second.painted.at(-1)!)).toEqual(['46']);
  });

  test('scopes in JS only — never a map filter, never a repaint', async () => {
    // A MapLibre filter would see `routes` already joined into one string and
    // substring-match; and the styling must be identical in both modes.
    // Arrange
    const { map, filters, paints, specs } = fakeMap();
    const { startDiversions, setDiversionsVisible } = await freshModule();
    await startDiversions(map);

    // Act
    search(['46']);
    setDiversionsVisible(map, true);
    setDiversionsVisible(map, false);

    // Assert
    expect(filters).toEqual([]);
    expect(paints).toEqual([]);
    expect(JSON.stringify(specs[0]?.filter)).not.toContain('routes');
  });
  // ── a failed fetch must never read as "your route is clear" ──
  // The layer keeps the last picture on a failure, which is right once there IS
  // one. Before the first good payload there is not: the scoped list is empty
  // and the map looks exactly like a route with no diversion on it. These pin
  // the two things that separate the cases — a loud, contextual log, and a
  // bounded fast retry so the blank window is seconds rather than an interval.

  test('a failed first poll says so loudly, naming what asked for the data', async () => {
    // Arrange — the rider is searching and the very first fetch fails, so there
    // is no previous picture to fall back on.
    const { map, painted } = fakeMap();
    fetchSpy.mockRejectedValue(new Error('offline'));
    const { startDiversions, diversionsStats } = await freshModule();
    await startDiversions(map);

    // Act
    search(['46']);
    await vi.waitFor(() => expect(diversionsStats().pollFailures).toBeGreaterThan(0));

    // Assert — console.error (not warn), and the line says which line was typed
    // and that nothing has ever been received.
    const line = String(errorSpy.mock.calls.at(-1)?.[0]);
    expect(line).toContain('[diversions]');
    expect(line).toContain('46');
    expect(line).toContain('NO payload');
    expect(diversionsStats().lastGoodFetchAt).toBe(0);
    expect(diversionsStats().lastPollError).toBe('offline');
    expect(painted.at(-1)?.features ?? []).toEqual([]);
  });

  test('retries within seconds while it has never held a payload', async () => {
    vi.useFakeTimers();
    try {
      // Arrange — first fetch fails, the next one would succeed.
      const { map, painted } = fakeMap();
      fetchSpy.mockRejectedValueOnce(new Error('offline'));
      const { startDiversions, DIVERSIONS_COLD_RETRY_MS } = await freshModule();
      await startDiversions(map);

      // Act
      search(['46']);
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(painted.at(-1)?.features ?? []).toEqual([]);
      await vi.advanceTimersByTimeAsync(DIVERSIONS_COLD_RETRY_MS);

      // Assert — the searched line's diversion is on screen long before the
      // 90 s poll would have come round.
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(drawnRoutes(painted.at(-1)!)).toEqual(['46']);
    } finally {
      vi.useRealTimers();
    }
  });

  test('gives up fast-retrying after the bounded limit', async () => {
    vi.useFakeTimers();
    try {
      // Arrange — everything fails, forever.
      const { map } = fakeMap();
      fetchSpy.mockRejectedValue(new Error('offline'));
      const { startDiversions, DIVERSIONS_COLD_RETRY_MS, DIVERSIONS_COLD_RETRY_LIMIT } =
        await freshModule();
      await startDiversions(map);

      // Act
      search(['46']);
      await vi.advanceTimersByTimeAsync(DIVERSIONS_COLD_RETRY_MS * (DIVERSIONS_COLD_RETRY_LIMIT + 4));

      // Assert — the opening attempt plus the bounded retries, and no more:
      // the 90 s poller carries it from here.
      expect(fetchSpy).toHaveBeenCalledTimes(DIVERSIONS_COLD_RETRY_LIMIT + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  test('a failure AFTER a good payload keeps that picture and does not fast-retry', async () => {
    vi.useFakeTimers();
    try {
      // Arrange — one good fetch, so there is a last picture worth keeping.
      const { map, painted } = fakeMap();
      const { startDiversions, DIVERSIONS_COLD_RETRY_MS, diversionsStats } = await freshModule();
      await startDiversions(map);
      search(['46']);
      await vi.advanceTimersByTimeAsync(0);
      expect(drawnRoutes(painted.at(-1)!)).toEqual(['46']);

      // Act — the next scheduled poll fails.
      fetchSpy.mockRejectedValueOnce(new Error('blip'));
      const tick = registerPoll.mock.calls[0]?.[0] as () => void;
      tick();
      await vi.advanceTimersByTimeAsync(DIVERSIONS_COLD_RETRY_MS * 3);

      // Assert — no extra requests beyond that failed tick, the picture stands,
      // and the log says what is still on screen rather than claiming nothing.
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(drawnRoutes(painted.at(-1)!)).toEqual(['46']);
      expect(diversionsStats().lastGoodFetchAt).toBeGreaterThan(0);
      expect(String(errorSpy.mock.calls.at(-1)?.[0])).toContain('last good fetch');
    } finally {
      vi.useRealTimers();
    }
  });

  test('a cold retry that lands after the search is cleared fetches nothing', async () => {
    vi.useFakeTimers();
    try {
      // Arrange
      const { map } = fakeMap();
      fetchSpy.mockRejectedValue(new Error('offline'));
      const { startDiversions, DIVERSIONS_COLD_RETRY_MS } = await freshModule();
      await startDiversions(map);
      search(['46']);
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // Act — the rider clears the box before the retry is due.
      search(null);
      await vi.advanceTimersByTimeAsync(DIVERSIONS_COLD_RETRY_MS * 3);

      // Assert — the gate still holds: nothing on screen, nothing fetched.
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
