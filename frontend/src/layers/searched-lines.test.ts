// Unit tests for the shared bus-line search selection: the matching rule that
// every search-scoped layer compares route labels with, and the fan-out that
// keeps N layers down to ONE hook on buses.ts.
//
// ./buses is mocked wholesale — it value-imports maplibre-gl (Popup), and
// setBusRouteShapeHook is precisely the seam under test: capturing what gets
// registered is how "one hook regardless of subscriber count" is pinned, and
// calling it back is how a filter change is simulated.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Map as MaplibreMap } from 'maplibre-gl';

type RouteShapeHook = (map: MaplibreMap, lines: ReadonlySet<string> | null) => void | Promise<void>;

/** Every hook the module under test registered on buses.ts, this test run. */
let registeredHooks: readonly RouteShapeHook[] = [];

vi.mock('./buses', () => ({
  setBusRouteShapeHook: (hook: RouteShapeHook) => {
    registeredHooks = [...registeredHooks, hook];
  },
}));

/** The listener list, the latest selection and "have we hooked yet" are module
 * state that outlives a single test, so every test drives a fresh copy. */
async function freshModule(): Promise<typeof import('./searched-lines')> {
  vi.resetModules();
  registeredHooks = [];
  return await import('./searched-lines');
}

/** buses.ts hands hooks the map; this module ignores it, so a bare object does. */
const fakeMap = {} as MaplibreMap;

/** Simulate a real filter change: buses.ts calls every registered hook. */
function fireFilterChange(lines: ReadonlySet<string> | null): void {
  for (const hook of registeredHooks) hook(fakeMap, lines);
}

/** Let an async listener's rejection settle and its containment run. */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

beforeEach(() => {
  // The containment path logs; keep the expected warnings out of the run.
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('matchesSearch', () => {
  test('matches case-insensitively in both directions', async () => {
    // Arrange
    const { matchesSearch } = await freshModule();

    // Act
    const lowerLabel = matchesSearch('n1', new Set(['N1']));
    const upperLabel = matchesSearch('N1', new Set(['n1']));

    // Assert
    expect(lowerLabel).toBe(true);
    expect(upperLabel).toBe(true);
  });

  test('ignores a destination suffix on a diversion route label', async () => {
    // Arrange
    const { matchesSearch } = await freshModule();

    // Act
    const matched = matchesSearch('SL8 → Uxbridge', new Set(['SL8']));

    // Assert
    expect(matched).toBe(true);
  });

  test('never folds a zero-padded route into its unpadded twin', async () => {
    // Arrange — 025 (National Express) and 25 (a London bus) are both real and
    // are different roads; folding them would show a rider the wrong one.
    const { matchesSearch } = await freshModule();

    // Act
    const paddedLabelUnpaddedSearch = matchesSearch('025', new Set(['25']));
    const unpaddedLabelPaddedSearch = matchesSearch('25', new Set(['025']));
    const exact = matchesSearch('025', new Set(['025']));

    // Assert
    expect(paddedLabelUnpaddedSearch).toBe(false);
    expect(unpaddedLabelPaddedSearch).toBe(false);
    expect(exact).toBe(true);
  });

  test('matches nothing for an empty or whitespace-only label', async () => {
    // Arrange
    const { matchesSearch } = await freshModule();

    // Act
    const empty = matchesSearch('', new Set(['25']));
    const blank = matchesSearch('   ', new Set(['25']));
    const emptyAgainstEmpty = matchesSearch('', new Set(['']));

    // Assert
    expect(empty).toBe(false);
    expect(blank).toBe(false);
    expect(emptyAgainstEmpty).toBe(false);
  });

  test('trims surrounding whitespace around a real label', async () => {
    // Arrange
    const { matchesSearch } = await freshModule();

    // Act
    const matched = matchesSearch('  24  ', new Set(['24']));

    // Assert
    expect(matched).toBe(true);
  });

  test('matches nothing when nothing is searched for', async () => {
    // Arrange
    const { matchesSearch } = await freshModule();

    // Act
    const noSelection = matchesSearch('24', null);
    const emptySelection = matchesSearch('24', new Set<string>());

    // Assert
    expect(noSelection).toBe(false);
    expect(emptySelection).toBe(false);
  });
});

describe('onSearchedLines', () => {
  test('publishes the current selection to a late subscriber', async () => {
    // Arrange — the filter changed BEFORE this layer started.
    const { onSearchedLines } = await freshModule();
    onSearchedLines(() => {});
    fireFilterChange(new Set(['24']));
    const late = vi.fn();

    // Act
    onSearchedLines(late);

    // Assert
    expect(late).toHaveBeenCalledTimes(1);
    expect(late).toHaveBeenCalledWith(new Set(['24']));
  });

  test('publishes null to a subscriber that starts before any search', async () => {
    // Arrange
    const { onSearchedLines } = await freshModule();
    const listener = vi.fn();

    // Act
    onSearchedLines(listener);

    // Assert
    expect(listener).toHaveBeenCalledWith(null);
  });

  test('delivers one change to every subscriber', async () => {
    // Arrange
    const { onSearchedLines } = await freshModule();
    const first = vi.fn();
    const second = vi.fn();
    onSearchedLines(first);
    onSearchedLines(second);

    // Act
    fireFilterChange(new Set(['N1']));

    // Assert — the immediate publish on subscribe, then the change.
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(2);
    expect(first).toHaveBeenLastCalledWith(new Set(['N1']));
    expect(second).toHaveBeenLastCalledWith(new Set(['N1']));
  });

  test('stops delivering after unsubscribe', async () => {
    // Arrange
    const { onSearchedLines } = await freshModule();
    const dropped = vi.fn();
    const kept = vi.fn();
    const unsubscribe = onSearchedLines(dropped);
    onSearchedLines(kept);

    // Act
    unsubscribe();
    fireFilterChange(new Set(['24']));

    // Assert
    expect(dropped).toHaveBeenCalledTimes(1); // the subscribe-time publish only
    expect(kept).toHaveBeenCalledTimes(2);
  });

  test('registers exactly one buses.ts hook however many subscribe', async () => {
    // Arrange
    const { onSearchedLines, searchedLines } = await freshModule();

    // Act
    onSearchedLines(() => {});
    onSearchedLines(() => {});
    onSearchedLines(() => {});
    searchedLines();

    // Assert
    expect(registeredHooks).toHaveLength(1);
  });

  test('a throwing listener does not stop the ones behind it', async () => {
    // Arrange
    const { onSearchedLines } = await freshModule();
    const behind = vi.fn();
    onSearchedLines(() => {
      throw new Error('listener blew up');
    });
    onSearchedLines(behind);

    // Act
    fireFilterChange(new Set(['24']));

    // Assert
    expect(behind).toHaveBeenLastCalledWith(new Set(['24']));
  });

  test('a rejecting async listener does not surface an unhandled rejection', async () => {
    // Arrange
    const { onSearchedLines } = await freshModule();
    const behind = vi.fn();
    onSearchedLines(async () => {
      await Promise.reject(new Error('fetch failed'));
    });
    onSearchedLines(behind);

    // Act
    fireFilterChange(new Set(['24']));
    await flushMicrotasks();

    // Assert
    expect(behind).toHaveBeenLastCalledWith(new Set(['24']));
    expect(console.warn).toHaveBeenCalled();
  });
});

describe('searchedLines', () => {
  test('reports the latest selection', async () => {
    // Arrange
    const { onSearchedLines, searchedLines } = await freshModule();
    onSearchedLines(() => {});

    // Act
    fireFilterChange(new Set(['24', 'N1']));

    // Assert
    expect(searchedLines()).toEqual(new Set(['24', 'N1']));
  });

  test('reports null for a cleared filter and for an empty selection', async () => {
    // Arrange
    const { onSearchedLines, searchedLines } = await freshModule();
    const listener = vi.fn();
    onSearchedLines(listener);
    fireFilterChange(new Set(['24']));

    // Act
    fireFilterChange(new Set<string>());
    const afterEmpty = searchedLines();
    fireFilterChange(null);

    // Assert — an empty set is normalised away, so `if (!lines)` is complete.
    expect(afterEmpty).toBe(null);
    expect(searchedLines()).toBe(null);
    expect(listener).toHaveBeenLastCalledWith(null);
  });
});
