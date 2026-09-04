// The line-filter fan-out buses.ts owns. setBusRouteShapeHook registers a LIST
// of listeners: while it was a single nullable slot, a second registrant
// silently overwrote the first and the white search polyline stopped drawing —
// no error, no type complaint, nothing red in a test. What is pinned here is
// that every registered hook is called with the same arguments, that one which
// throws does not take the ones behind it down (and says so in the log), and
// that the fan-out still fires ONLY on a real change of the selection.
//
// buses.ts value-imports maplibre-gl (Popup), so that module is stubbed to keep
// the test in the fast node environment — same pattern as bus-routes.test.ts.
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { Map as MaplibreMap } from 'maplibre-gl';

vi.mock('maplibre-gl', () => ({ Popup: class {} }));

/** A map that has no bus layers yet, so applyBusDisplay skips every paint,
 * filter and visibility call and the hook fan-out is the only visible effect. */
const fakeMap = (): MaplibreMap => ({ getLayer: () => undefined }) as unknown as MaplibreMap;

/** The hook list and the last filter are module state that outlives a single
 * test, so every test drives a freshly evaluated copy of the module. */
async function freshBuses(): Promise<typeof import('./buses')> {
  vi.resetModules();
  return await import('./buses');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('setBusRouteShapeHook', () => {
  test('notifies every registered hook with the same map and lines', async () => {
    // Arrange
    const { setBusLineFilter, setBusRouteShapeHook } = await freshBuses();
    const map = fakeMap();
    const lines = new Set(['24']);
    const first = vi.fn();
    const second = vi.fn();
    setBusRouteShapeHook(first);
    setBusRouteShapeHook(second);

    // Act
    setBusLineFilter(map, lines);

    // Assert — registering the second must not have displaced the first
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledWith(map, lines);
    expect(second).toHaveBeenCalledWith(map, lines);
  });

  test('notifies every registered hook when the filter is cleared', async () => {
    // Arrange
    const { setBusLineFilter, setBusRouteShapeHook } = await freshBuses();
    const map = fakeMap();
    const first = vi.fn();
    const second = vi.fn();
    setBusRouteShapeHook(first);
    setBusRouteShapeHook(second);
    setBusLineFilter(map, new Set(['24']));

    // Act
    setBusLineFilter(map, null);

    // Assert
    expect(first).toHaveBeenLastCalledWith(map, null);
    expect(second).toHaveBeenLastCalledWith(map, null);
  });

  test('keeps calling the later hooks when an earlier one throws, and logs it', async () => {
    // Arrange
    const { setBusLineFilter, setBusRouteShapeHook } = await freshBuses();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const boom = new Error('route shape resolve blew up');
    const failing = vi.fn(() => {
      throw boom;
    });
    const second = vi.fn();
    setBusRouteShapeHook(failing);
    setBusRouteShapeHook(second);

    // Act
    setBusLineFilter(fakeMap(), new Set(['24']));

    // Assert — the throw is contained, not swallowed
    expect(failing).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    const [message, logged] = warn.mock.calls[0];
    expect(String(message)).toContain('[buses] route-shape hook 0 failed');
    expect(logged).toBe(boom);
  });

  test('a hook throwing on one change does not unregister it for the next', async () => {
    // Arrange
    const { setBusLineFilter, setBusRouteShapeHook } = await freshBuses();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const map = fakeMap();
    const failing = vi.fn(() => {
      throw new Error('transient');
    });
    setBusRouteShapeHook(failing);

    // Act
    setBusLineFilter(map, new Set(['24']));
    setBusLineFilter(map, new Set(['N24']));

    // Assert
    expect(failing).toHaveBeenCalledTimes(2);
  });

  test('fires on a real change only, not on a re-push of the same selection', async () => {
    // Arrange
    const { setBusLineFilter, setBusRouteShapeHook } = await freshBuses();
    const map = fakeMap();
    const hook = vi.fn();
    setBusRouteShapeHook(hook);

    // Act — the filter UI re-pushes the whole selection per chip and the search
    // input's `change` also fires on blur, so identical repeats are the norm.
    setBusLineFilter(map, new Set(['n24'])); // real change — from no filter
    setBusLineFilter(map, new Set(['n24'])); // unchanged — a re-push
    setBusLineFilter(map, new Set(['N24'])); // unchanged — the filter is case-folded
    setBusLineFilter(map, new Set(['n24', '24'])); // real change — a chip added

    // Assert
    expect(hook).toHaveBeenCalledTimes(2);
  });

  test('no registered hooks is not an error', async () => {
    // Arrange
    const { setBusLineFilter } = await freshBuses();

    // Act + Assert — nothing is registered until the layers start
    expect(() => setBusLineFilter(fakeMap(), new Set(['24']))).not.toThrow();
  });
});

describe('setBusRouteShapeHook with an async hook', () => {
  test('logs a rejected async hook instead of letting it escape as unhandled', async () => {
    // Arrange — the next listener in line (a stop-closure highlight scoped to
    // the searched line) has to fetch, so it will be `async`. An async hook
    // does NOT throw to its caller: it returns a rejected promise, which a
    // plain try/catch never sees, and TypeScript allows the assignment because
    // a Promise<void> returner satisfies a void-returning callback type.
    const { setBusLineFilter, setBusRouteShapeHook } = await freshBuses();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const boom = new Error('closure fetch failed');
    const failing = vi.fn(async () => {
      await Promise.resolve();
      throw boom;
    });
    const second = vi.fn();
    setBusRouteShapeHook(failing);
    setBusRouteShapeHook(second);

    // Act
    setBusLineFilter(fakeMap(), new Set(['24']));
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());

    // Assert — same trail a synchronous throw leaves: index and cause.
    expect(second).toHaveBeenCalledTimes(1);
    const [message, logged] = warn.mock.calls[0];
    expect(String(message)).toContain('[buses] route-shape hook 0 failed');
    expect(logged).toBe(boom);
  });

  test('does not stop the fan-out reaching the hooks behind it', async () => {
    // Arrange — the rejection must not be awaited either: a hook that never
    // settles would otherwise hold up the white polyline behind it.
    const { setBusLineFilter, setBusRouteShapeHook } = await freshBuses();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const pending = vi.fn(() => new Promise<void>(() => {}));
    const second = vi.fn();
    setBusRouteShapeHook(pending);
    setBusRouteShapeHook(second);

    // Act
    setBusLineFilter(fakeMap(), new Set(['24']));

    // Assert — synchronously, in the same turn as the filter change.
    expect(second).toHaveBeenCalledTimes(1);
  });

  test('leaves a resolving async hook alone', async () => {
    // Arrange
    const { setBusLineFilter, setBusRouteShapeHook } = await freshBuses();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const hook = vi.fn(async () => {
      await Promise.resolve();
    });
    setBusRouteShapeHook(hook);

    // Act
    setBusLineFilter(fakeMap(), new Set(['24']));
    await Promise.resolve();
    await Promise.resolve();

    // Assert
    expect(hook).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });
});
