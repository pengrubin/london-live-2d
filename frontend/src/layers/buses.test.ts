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
