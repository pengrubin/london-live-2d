// Unit tests for the pure half of the bus-stop-closures layer: the in-force
// window rule (the whole point of the overlay), feature building, the popup,
// and the promise that a hidden overlay costs zero requests.
//
// bus-stop-closures.ts value-imports maplibre-gl (Popup) and util/lifecycle
// (which reaches for `window`), so both are stubbed to keep this in the fast
// node environment — the emergency-classify.test.ts pattern.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('maplibre-gl', () => ({ Popup: class {} }));

const registerPoll = vi.fn<(fn: () => void, ms: number) => void>();
vi.mock('../util/lifecycle', () => ({ registerPoll: (fn: () => void, ms: number) => registerPoll(fn, ms) }));

const {
  BUS_STOP_CLOSURES_HALO_LAYER_ID,
  BUS_STOP_CLOSURES_LAYER_IDS,
  BUS_STOP_CLOSURES_CORE_LAYER_ID,
  buildClosureFeatures,
  busStopClosuresStats,
  closurePopupHtml,
  closureState,
  closureWindowLabel,
  setBusStopClosuresVisible,
  startBusStopClosures,
  serverNowMs,
} = await import('./bus-stop-closures');

import type { BusStopClosure, ClosureProps } from './bus-stop-closures';

/** 2026-09-04T10:00:00Z — a Friday, British Summer Time, so London is UTC+1. */
const NOW = Date.parse('2026-09-04T10:00:00Z');

const stop = (over: Partial<BusStopClosure> = {}): BusStopClosure => ({
  id: '490000001A',
  name: 'Trafalgar Square',
  lat: 51.508,
  lon: -0.128,
  routes: ['24', '29', '176'],
  ty: 'Closure',
  f: '2026-09-01T08:00:00Z',
  d: 'Stop closed for footway works.',
  ...over,
});

const propsOf = (feature: GeoJSON.Feature): ClosureProps => feature.properties as ClosureProps;

describe('closureState — only a window covering now may be drawn', () => {
  test('an open-ended closure that has begun is in force', () => {
    // Arrange — started three days ago, TfL gave no end date
    const closure = stop({ f: '2026-09-01T08:00:00Z', t: undefined });

    // Act / Assert
    expect(closureState(closure, NOW)).toBe('in-force');
  });

  test('a closure whose window brackets now is in force', () => {
    expect(closureState(stop({ f: '2026-09-04T06:00:00Z', t: '2026-09-04T18:00:00Z' }), NOW)).toBe(
      'in-force',
    );
  });

  test('a closure that has not started yet is "not-yet"', () => {
    // The bug this rule exists for, mirrored: a weekend closure filed today
    // must not hatch a stop that is open right now.
    expect(closureState(stop({ f: '2026-09-05T00:00:00Z' }), NOW)).toBe('not-yet');
  });

  test('a closure whose window has already ended is "ended"', () => {
    expect(closureState(stop({ f: '2026-08-01T00:00:00Z', t: '2026-09-03T23:00:00Z' }), NOW)).toBe(
      'ended',
    );
  });

  test('a closure with no dates at all is in force', () => {
    // Nothing in the row bounds it, and it is in the current-disruption feed.
    expect(closureState(stop({ f: undefined, t: undefined }), NOW)).toBe('in-force');
  });

  test('an unreadable stamp is "unreadable", never guessed either way', () => {
    expect(closureState(stop({ f: 'not a date' }), NOW)).toBe('unreadable');
    expect(closureState(stop({ t: '' }), NOW)).toBe('unreadable');
  });
});

describe('serverNowMs', () => {
  test('anchors on the server clock and adds only elapsed local time', () => {
    // Arrange — a viewer clock running ten minutes fast
    const payloadT = Math.floor(NOW / 1000);
    const receivedAt = NOW + 600_000;

    // Act — 30 s of local time has passed since the body arrived
    const anchored = serverNowMs(payloadT, receivedAt, receivedAt + 30_000);

    // Assert — the skew cancels; only the 30 s survives
    expect(anchored).toBe(NOW + 30_000);
  });

  test('never runs backwards when the local clock jumps back', () => {
    const payloadT = Math.floor(NOW / 1000);
    expect(serverNowMs(payloadT, NOW, NOW - 5_000)).toBe(NOW);
  });
});

describe('buildClosureFeatures', () => {
  test('builds exactly one point feature per drawn stop', () => {
    // Arrange
    const stops = [
      stop({ id: 'A', name: 'Aldwych' }),
      stop({ id: 'B', name: 'Bank', lat: 51.513, lon: -0.089 }),
    ];

    // Act
    const built = buildClosureFeatures(stops, NOW);

    // Assert
    expect(built.features).toHaveLength(2);
    expect(built.features[0].geometry).toEqual({ type: 'Point', coordinates: [-0.128, 51.508] });
    expect(propsOf(built.features[1]).name).toBe('Bank');
    expect(built.droppedNoCoords).toBe(0);
    expect(built.droppedNotInForce).toBe(0);
  });

  test('skips a stop missing a coordinate and counts it', () => {
    // Arrange — the gazetteer failed to resolve this pole's position
    const stops = [stop({ id: 'A' }), stop({ id: 'B', lat: undefined }), stop({ id: 'C', lon: Number.NaN })];

    // Act
    const built = buildClosureFeatures(stops, NOW);

    // Assert — a stop with no position is never placed at a guessed one
    expect(built.features).toHaveLength(1);
    expect(propsOf(built.features[0]).id).toBe('A');
    expect(built.droppedNoCoords).toBe(2);
  });

  test('drops rows whose window does not cover now, and counts them apart', () => {
    // Arrange — one live, one future, one finished, one unreadable
    const stops = [
      stop({ id: 'live' }),
      stop({ id: 'future', f: '2026-09-06T00:00:00Z' }),
      stop({ id: 'past', t: '2026-09-02T00:00:00Z' }),
      stop({ id: 'broken', t: 'whenever' }),
    ];

    // Act
    const built = buildClosureFeatures(stops, NOW);

    // Assert
    expect(built.features.map((f) => propsOf(f).id)).toEqual(['live']);
    expect(built.droppedNotInForce).toBe(2);
    expect(built.droppedUnreadableWindow).toBe(1);
  });

  test('carries the routes list, direction and closure text onto the feature', () => {
    // Arrange
    const stops = [stop({ routes: ['176', '24', '9'], towards: 'Charing Cross' })];

    // Act
    const props = propsOf(buildClosureFeatures(stops, NOW).features[0]);

    // Assert — numeric-aware sort, like every other route list in the app
    expect(props.routes).toBe('9, 24, 176');
    expect(props.towards).toBe('Charing Cross');
    expect(props.description).toBe('Stop closed for footway works.');
  });
});

describe('closureWindowLabel', () => {
  test('reads an open-ended closure as "Since" in London time', () => {
    // 08:00 UTC on a September day is 09:00 in London (BST).
    const label = closureWindowLabel(stop({ f: '2026-09-01T08:00:00Z', t: undefined }));
    expect(label).toMatch(/^Since /);
    expect(label).toContain('09:00');
  });

  test('renders both ends when TfL states them', () => {
    const label = closureWindowLabel(stop({ f: '2026-09-01T08:00:00Z', t: '2026-09-07T16:30:00Z' }));
    expect(label).toContain('09:00');
    expect(label).toContain('17:30');
    expect(label).toContain('–');
  });

  test('says nothing when the row states no window', () => {
    expect(closureWindowLabel(stop({ f: undefined, t: undefined }))).toBe('');
  });
});

describe('closurePopupHtml', () => {
  test('escapes markup in the closure text and keeps an apostrophe as text', () => {
    // Arrange — the hostile-string case: TfL free text is echoed verbatim
    const stops = [
      stop({
        name: "Queen's Road <b>West</b>",
        d: "<script>alert('x')</script> Driver's cab works",
      }),
    ];

    // Act
    const html = closurePopupHtml(propsOf(buildClosureFeatures(stops, NOW).features[0]));

    // Assert — nothing executable survives; the apostrophe is harmless in text
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain("Driver's cab works");
    expect(html).toContain("Queen's Road");
  });

  test('renders the routes the stop serves, the direction and the window', () => {
    // Arrange
    const stops = [stop({ routes: ['24', '29'], towards: 'Camden Town' })];

    // Act
    const html = closurePopupHtml(propsOf(buildClosureFeatures(stops, NOW).features[0]));

    // Assert
    expect(html).toContain('24, 29');
    expect(html).toContain('Camden Town');
    expect(html).toContain('Since');
    expect(html).toContain('Trafalgar Square');
  });

  test('words the title from the row’s own type, never harder than it says', () => {
    const closure = propsOf(buildClosureFeatures([stop({ ty: 'Closure' })], NOW).features[0]);
    expect(closurePopupHtml(closure)).toContain('Bus stop closed');

    const other = propsOf(buildClosureFeatures([stop({ ty: 'Diversion' })], NOW).features[0]);
    const html = closurePopupHtml(other);
    expect(html).toContain('Diversion');
    expect(html).not.toContain('Bus stop closed');
  });
});

describe('poll gating', () => {
  /** Enough of a MapLibre map for the layer's own calls, recording setData. */
  function fakeMap() {
    const painted: GeoJSON.FeatureCollection[] = [];
    const layerIds = new Set<string>();
    const visibility = new Map<string, string>();
    const map = {
      addSource: () => {},
      addLayer: (layer: { id: string }) => layerIds.add(layer.id),
      getLayer: (id: string) => (layerIds.has(id) ? { id } : undefined),
      getSource: () => ({ setData: (data: GeoJSON.FeatureCollection) => painted.push(data) }),
      setLayoutProperty: (id: string, _prop: string, value: string) => visibility.set(id, value),
      queryRenderedFeatures: () => [],
      getCanvas: () => ({ style: {} }),
      on: () => {},
    };
    return {
      map: map as unknown as Parameters<typeof startBusStopClosures>[0],
      painted,
      layerIds,
      visibility,
    };
  }

  const body = (stops: BusStopClosure[]) => ({
    ok: true,
    json: async () => ({ t: Math.floor(NOW / 1000), stops }),
    headers: { get: () => null },
  });

  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    registerPoll.mockClear();
    fetchSpy = vi.fn(async () => body([stop()]));
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('makes zero requests while the overlay is off', async () => {
    // Arrange / Act — the overlay ships off, so start must not fetch
    const { map, layerIds } = fakeMap();
    await startBusStopClosures(map);

    // Assert
    expect(fetchSpy).not.toHaveBeenCalled();
    expect([...layerIds]).toEqual([...BUS_STOP_CLOSURES_LAYER_IDS]);

    // And the registered poller stays silent too, tick after tick.
    const tick = registerPoll.mock.calls[0]?.[0] as () => void;
    tick();
    await Promise.resolve();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('fetches as soon as the overlay is switched on, and shows both layers', async () => {
    // Arrange
    const { map, painted, visibility } = fakeMap();
    await startBusStopClosures(map);

    // Act
    setBusStopClosuresVisible(map, true);
    await vi.waitFor(() => expect(painted).toHaveLength(1));

    // Assert
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith('/api/bus-stop-closures');
    expect(painted[0].features).toHaveLength(1);
    expect(visibility.get(BUS_STOP_CLOSURES_HALO_LAYER_ID)).toBe('visible');
    expect(visibility.get(BUS_STOP_CLOSURES_CORE_LAYER_ID)).toBe('visible');

    // Switching back off stops the requests again.
    setBusStopClosuresVisible(map, false);
    const tick = registerPoll.mock.calls[0]?.[0] as () => void;
    tick();
    await Promise.resolve();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(visibility.get(BUS_STOP_CLOSURES_CORE_LAYER_ID)).toBe('none');
  });

  test('says on the console when a row is dropped for want of a position', async () => {
    // Arrange — one drawable pole, one the gazetteer never resolved
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchSpy.mockResolvedValue(body([stop({ id: 'A' }), stop({ id: 'B', lat: undefined })]));
    const { map, painted } = fakeMap();
    await startBusStopClosures(map);

    // Act
    setBusStopClosuresVisible(map, true);
    await vi.waitFor(() => expect(painted).toHaveLength(1));

    // Assert — the drop is both counted and spoken about
    expect(painted[0].features).toHaveLength(1);
    expect(busStopClosuresStats().droppedNoCoords).toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('without a position'));
    warn.mockRestore();
    setBusStopClosuresVisible(map, false);
  });

  test('counts and logs a payload it cannot stand behind instead of drawing it', async () => {
    // Arrange — a 200 from an intermediary, with no stops array
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchSpy.mockResolvedValue({ ok: true, json: async () => ({}), headers: { get: () => null } });
    const { map, painted } = fakeMap();
    await startBusStopClosures(map);
    const before = busStopClosuresStats().pollFailures;

    // Act
    setBusStopClosuresVisible(map, true);
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());

    // Assert — nothing reaches the map, and the reason is not swallowed
    expect(painted).toHaveLength(0);
    expect(busStopClosuresStats().pollFailures).toBe(before + 1);
    expect(busStopClosuresStats().lastPollError).not.toBe('');
    warn.mockRestore();
    setBusStopClosuresVisible(map, false);
  });
});
