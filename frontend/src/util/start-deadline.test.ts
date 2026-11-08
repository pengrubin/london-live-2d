import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LAYER_START_DEADLINE_MS, withStartDeadline } from './start-deadline';

const SHORT_MS = 1_000;

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void } {
  let resolve: () => void = () => {};
  let reject: (e: Error) => void = () => {};
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('withStartDeadline', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('resolves with the start when it settles inside the deadline, without calling onLate', async () => {
    // Arrange
    const start = deferred();
    const onLate = vi.fn();
    const guarded = withStartDeadline(start.promise, SHORT_MS, onLate);

    // Act
    start.resolve();
    await guarded;
    vi.advanceTimersByTime(SHORT_MS * 2);

    // Assert
    expect(onLate).not.toHaveBeenCalled();
  });

  it('propagates a rejection that happens inside the deadline', async () => {
    // Arrange
    const start = deferred();
    const onLate = vi.fn();
    const guarded = withStartDeadline(start.promise, SHORT_MS, onLate);

    // Act
    start.reject(new Error('manifest 404'));

    // Assert
    await expect(guarded).rejects.toThrow('manifest 404');
    expect(onLate).not.toHaveBeenCalled();
  });

  it('resolves at the deadline when the start is still pending, and reports it', async () => {
    // Arrange — a layer whose first poll hangs must not hold the panel back.
    const start = deferred();
    const onLate = vi.fn();
    const guarded = withStartDeadline(start.promise, SHORT_MS, onLate);
    let settled = false;
    void guarded.then(() => {
      settled = true;
    });

    // Act
    await vi.advanceTimersByTimeAsync(SHORT_MS - 1);
    const before = settled;
    await vi.advanceTimersByTimeAsync(1);

    // Assert
    expect(before).toBe(false);
    expect(settled).toBe(true);
    expect(onLate).toHaveBeenCalledWith('pending', undefined);
  });

  it('still reports a rejection that arrives after the deadline, without rethrowing it', async () => {
    // Arrange
    const start = deferred();
    const onLate = vi.fn();
    const guarded = withStartDeadline(start.promise, SHORT_MS, onLate);
    await vi.advanceTimersByTimeAsync(SHORT_MS);
    await guarded;

    // Act
    const reason = new Error('late failure');
    start.reject(reason);
    await vi.advanceTimersByTimeAsync(0);

    // Assert
    expect(onLate).toHaveBeenCalledWith('rejected', reason);
  });

  it('exports a deadline long enough for a slow first poll but short enough to notice', () => {
    expect(LAYER_START_DEADLINE_MS).toBeGreaterThanOrEqual(5_000);
    expect(LAYER_START_DEADLINE_MS).toBeLessThanOrEqual(15_000);
  });
});
