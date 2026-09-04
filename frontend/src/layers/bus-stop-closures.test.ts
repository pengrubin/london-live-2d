// Unit tests for the pure half of the bus-stop-closures layer: the in-force
// window rule (the whole point of the overlay), feature building, the popup,
// and the promise that a hidden overlay costs zero requests.
//
// bus-stop-closures.ts value-imports maplibre-gl (Popup) and util/lifecycle
// (which reaches for `window`), so both are stubbed to keep this in the fast
// node environment — the emergency-classify.test.ts pattern.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Map as MaplibreMap } from 'maplibre-gl';

vi.mock('maplibre-gl', () => ({ Popup: class {} }));

const registerPoll = vi.fn<(fn: () => void, ms: number) => void>();
vi.mock('../util/lifecycle', () => ({ registerPoll: (fn: () => void, ms: number) => registerPoll(fn, ms) }));

// layers/searched-lines is NOT mocked: the join it performs ("does this stop
// serve a line the rider typed?") is half of what is under test here, and a
// stubbed matcher would make the 46/146 case prove nothing. Only its dependency
// on ./buses is replaced — that module value-imports the whole map runtime, and
// capturing the hook it registers is how a real filter change is simulated.
type RouteShapeHook = (map: MaplibreMap, lines: ReadonlySet<string> | null) => void | Promise<void>;

let registeredHooks: readonly RouteShapeHook[] = [];

vi.mock('./buses', () => ({
  setBusRouteShapeHook: (hook: RouteShapeHook) => {
    registeredHooks = [...registeredHooks, hook];
  },
}));

/** Simulate a real bus-line filter change: buses.ts calls every hook it holds. */
function fireSearch(lines: ReadonlySet<string> | null): void {
  for (const hook of registeredHooks) hook({} as MaplibreMap, lines);
}

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

/** The layer keeps overlay/search/payload state across a start(), so every test
 * hands its own map back to a neutral state rather than inheriting the last. */
let lastStarted: ReturnType<typeof fakeMap> | null = null;

beforeEach(() => {
  registerPoll.mockClear();
  fetchSpy = vi.fn(async () => body([stop()]));
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  if (lastStarted) {
    fireSearch(null);
    setBusStopClosuresVisible(lastStarted.map, false);
    lastStarted = null;
  }
  vi.unstubAllGlobals();
});

/** Start the layer over a map of its own, serving `stops` from the feed. */
async function startWith(stops: BusStopClosure[]): Promise<ReturnType<typeof fakeMap>> {
  fetchSpy.mockResolvedValue(body(stops));
  const harness = fakeMap();
  lastStarted = harness;
  await startBusStopClosures(harness.map);
  return harness;
}

/** Ids of the features in the most recent paint. */
function drawnIds(painted: GeoJSON.FeatureCollection[]): string[] {
  const last = painted[painted.length - 1];
  return (last?.features ?? []).map((f) => (f.properties as ClosureProps).id);
}

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

  test('counts and logs a failure on the re-filter tick instead of losing it', async () => {
    // Arrange — a healthy first poll, then the map goes out from under the
    // layer. The minute tick fetches nothing, so poll()'s try/catch can never
    // see this: unguarded it becomes an untagged throw inside setInterval,
    // with no counter, no [bus-stop-closures] line and a clean-looking
    // busStopClosuresStats() while the layer has stopped re-deriving state.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { map, painted } = fakeMap();
    await startBusStopClosures(map);
    setBusStopClosuresVisible(map, true);
    await vi.waitFor(() => expect(painted).toHaveLength(1));
    const before = busStopClosuresStats().pollFailures;
    (map as unknown as { getSource: () => unknown }).getSource = () => {
      throw new Error('style reloaded under the layer');
    };

    // Act — registerPoll call 0 is the fetch poll, call 1 is the re-filter tick.
    const tick = registerPoll.mock.calls[1]?.[0] as () => void;
    expect(() => tick()).not.toThrow();

    // Assert
    expect(busStopClosuresStats().pollFailures).toBe(before + 1);
    expect(busStopClosuresStats().lastPollError).toContain('style reloaded');
    expect(error).toHaveBeenCalledWith('[bus-stop-closures]', expect.any(Error));

    // Switching off goes through the source too, so it is contained the same
    // way rather than throwing out of a legend click; the spy stays installed
    // over the cleanup that proves it.
    expect(() => setBusStopClosuresVisible(map, false)).not.toThrow();
    error.mockRestore();
  });

  test('registers the re-filter tick on its own interval', async () => {
    // Arrange / Act
    const { map } = fakeMap();
    await startBusStopClosures(map);

    // Assert — two pollers: the fetch and the fetch-less re-filter.
    expect(registerPoll).toHaveBeenCalledTimes(2);
    expect(registerPoll.mock.calls[1]?.[1]).toBe(60_000);
  });
});

describe('a row that states no type', () => {
  test('is never worded as closed, because the row never said so', () => {
    // Arrange — `ty` is optional in the contract, and an absent one claims
    // nothing. Defaulting it to "Closure" would make the map say the single
    // most specific thing it can about a row that said nothing at all.
    const untyped = propsOf(buildClosureFeatures([stop({ ty: undefined })], NOW).features[0]);

    // Act
    const html = closurePopupHtml(untyped);

    // Assert
    expect(untyped.ty).toBe('');
    expect(html).not.toContain('Bus stop closed');
    expect(html).not.toContain('⛔');
    expect(html).toContain('Disruption');
  });

  test('still draws, and still carries its name, routes and window', () => {
    // Arrange — the row is in force and positioned; only its type is missing,
    // so hiding it would lose a disruption TfL is actually reporting.
    const built = buildClosureFeatures([stop({ ty: undefined })], NOW);

    // Act
    const html = closurePopupHtml(propsOf(built.features[0]));

    // Assert
    expect(built.features).toHaveLength(1);
    expect(html).toContain('Trafalgar Square');
    expect(html).toContain('24, 29, 176');
    expect(html).toContain('Since');
  });

  test('keeps an empty-string type neutral too', () => {
    const blank = propsOf(buildClosureFeatures([stop({ ty: '' })], NOW).features[0]);
    expect(closurePopupHtml(blank)).not.toContain('Bus stop closed');
    expect(closurePopupHtml(blank)).toContain('Disruption');
  });
});

// ── search-scoped closures ──
// The overlay toggle and the Filter tab's bus-line search are two independent
// inputs, and every row of their truth table is pinned here. The two that
// matter most: an overlay that is ON keeps showing EVERYTHING (a search must
// never silently hide a stop the rider asked to see), and an overlay that is
// OFF with no search must still cost ZERO requests.
describe('search-scoped closures', () => {
  /** Two poles on lines that look alike to a substring match but are not. */
  const on46 = stop({ id: '46', name: 'Lauderdale Road', routes: ['46'] });
  const on146 = stop({ id: '146', name: 'Bromley Common', routes: ['146'], lat: 51.38, lon: 0.02 });

  test('overlay ON with no search draws every closed stop', async () => {
    // Arrange
    const { map, painted } = await startWith([on46, on146]);

    // Act
    setBusStopClosuresVisible(map, true);
    await vi.waitFor(() => expect(painted.length).toBeGreaterThan(0));

    // Assert
    expect(drawnIds(painted)).toEqual(['46', '146']);
  });

  test('overlay ON with a search STILL draws every closed stop', async () => {
    // Arrange — the overlay means "show me all of it"
    const { map, painted } = await startWith([on46, on146]);
    setBusStopClosuresVisible(map, true);
    await vi.waitFor(() => expect(painted.length).toBeGreaterThan(0));

    // Act
    fireSearch(new Set(['46']));

    // Assert — the search narrows nothing while the overlay is asking for all
    expect(drawnIds(painted)).toEqual(['46', '146']);
  });

  test('overlay OFF with a search draws only the stops a searched line serves', async () => {
    // Arrange — the overlay ships off and is never touched
    const { painted, visibility } = await startWith([on46, on146]);

    // Act — the rider types 46
    fireSearch(new Set(['46']));
    await vi.waitFor(() => expect(painted.length).toBeGreaterThan(0));

    // Assert — 146 is a different road, not a longer 46
    expect(drawnIds(painted)).toEqual(['46']);
    expect(busStopClosuresStats().droppedOffSearch).toBe(1);
    expect(visibility.get(BUS_STOP_CLOSURES_CORE_LAYER_ID)).toBe('visible');
    expect(visibility.get(BUS_STOP_CLOSURES_HALO_LAYER_ID)).toBe('visible');
  });

  test('overlay OFF with no search draws nothing and makes zero requests', async () => {
    // Arrange / Act — this is the shipped state
    const { painted } = await startWith([on46, on146]);

    // Assert — not a request, not a paint
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(painted).toHaveLength(0);

    // An EMPTY selection is no selection: searched-lines normalises it to null,
    // so it must not wake the feed either.
    fireSearch(new Set());
    const tick = registerPoll.mock.calls[0]?.[0] as () => void;
    tick();
    await Promise.resolve();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('a search alone pays for the feed, and the poller keeps it fresh', async () => {
    // Arrange — the invariant most likely to be broken later: the poll gate is
    // "EITHER input", not "the overlay".
    const { painted } = await startWith([on46]);
    expect(fetchSpy).not.toHaveBeenCalled();

    // Act
    fireSearch(new Set(['46']));
    await vi.waitFor(() => expect(painted.length).toBeGreaterThan(0));

    // Assert — one fetch on waking, and the registered poller now runs
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith('/api/bus-stop-closures');
    const tick = registerPoll.mock.calls[0]?.[0] as () => void;
    tick();
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
  });

  test('re-searching another line re-scopes from the payload in hand, without refetching', async () => {
    // Arrange
    const { painted } = await startWith([on46, on146]);
    fireSearch(new Set(['46']));
    await vi.waitFor(() => expect(painted.length).toBeGreaterThan(0));

    // Act — the rider types the other one
    fireSearch(new Set(['146']));

    // Assert — a keystroke costs a re-filter, not a request
    expect(drawnIds(painted)).toEqual(['146']);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test('turning the overlay off while a search is active keeps the searched subset', async () => {
    // Arrange — overlay on, everything drawn, then a search
    const { map, painted, visibility } = await startWith([on46, on146]);
    setBusStopClosuresVisible(map, true);
    await vi.waitFor(() => expect(painted.length).toBeGreaterThan(0));
    fireSearch(new Set(['46']));
    expect(drawnIds(painted)).toEqual(['46', '146']);

    // Act
    setBusStopClosuresVisible(map, false);

    // Assert — the layer stays on screen for the search, narrowed to it
    expect(drawnIds(painted)).toEqual(['46']);
    expect(visibility.get(BUS_STOP_CLOSURES_CORE_LAYER_ID)).toBe('visible');
  });

  test('clearing the search with the overlay off empties the layer and stops fetching', async () => {
    // Arrange
    const { painted, visibility } = await startWith([on46, on146]);
    fireSearch(new Set(['46']));
    await vi.waitFor(() => expect(painted.length).toBeGreaterThan(0));
    const fetches = fetchSpy.mock.calls.length;

    // Act
    fireSearch(null);

    // Assert — nothing left in the source, nothing left on screen, no requests
    expect(drawnIds(painted)).toEqual([]);
    expect(visibility.get(BUS_STOP_CLOSURES_CORE_LAYER_ID)).toBe('none');
    const tick = registerPoll.mock.calls[0]?.[0] as () => void;
    tick();
    await Promise.resolve();
    expect(fetchSpy).toHaveBeenCalledTimes(fetches);
  });

  test('a searched stop looks exactly like a toggled one, searched route first', async () => {
    // Arrange — styling never changes; only the ORDER of the routes line does,
    // so the reason this pin is on screen reads first.
    const { painted } = await startWith([stop({ routes: ['9', '24', '46'] })]);

    // Act
    fireSearch(new Set(['46']));
    await vi.waitFor(() => expect(painted.length).toBeGreaterThan(0));

    // Assert
    const props = propsOf(painted[painted.length - 1].features[0]);
    expect(props.routes).toBe('46, 9, 24');
    expect(closurePopupHtml(props)).toContain('Routes: 46, 9, 24');
    expect(closurePopupHtml(props)).toContain('Bus stop closed');
  });
});

describe('buildClosureFeatures — searched route ordering', () => {
  test('moves a searched line to the front and leaves the rest numerically sorted', () => {
    // Arrange
    const stops = [stop({ routes: ['9', '24', '176'] })];

    // Act
    const built = buildClosureFeatures(stops, NOW, new Set(['24']));

    // Assert
    expect(propsOf(built.features[0]).routes).toBe('24, 9, 176');
  });

  test('leaves the list alone when nothing on the stop was searched for', () => {
    // Arrange / Act — the rider is looking at another road entirely
    const built = buildClosureFeatures([stop({ routes: ['9', '24', '176'] })], NOW, new Set(['46']));

    // Assert
    expect(propsOf(built.features[0]).routes).toBe('9, 24, 176');
  });
});
