/**
 * How long main.ts waits on one layer's start() before mounting the control
 * panel anyway.
 *
 * Ten layers end their start() with `await poll()` — the first fetch, with no
 * timeout — and the panel mounts only after every start has settled. On
 * 2026-11-06 the backend's /api/disruptions and /api/road-disruptions stopped
 * answering (a wedged upstream flight, see proxy-route.ts) and the map came up
 * with no panel at all: not an error anywhere, just two awaits that never
 * returned. The layers' own semantics are fine — first frame with data, then
 * the poll loop — so the deadline lives here, at the one place that gathers
 * them. Every layer adds its map layers synchronously before that first
 * await, so by the deadline the Lines-tab rows see them already; only the
 * data is late. Ten seconds: longer than any healthy first poll (the slowest,
 * tide gauges, averages 2 s), short enough that a viewer on a bad connection
 * still gets the panel before giving up.
 */
export const LAYER_START_DEADLINE_MS = 10_000;

export type LateOutcome = 'pending' | 'rejected';

/**
 * Resolves with `start`, or at `deadlineMs` if `start` is still pending.
 *
 * Inside the deadline the start's own outcome propagates untouched, so a
 * layer that fails fast still reaches the caller's rejected-branch logging.
 * Past it, `onLate('pending')` is called and the promise resolves; a
 * rejection arriving later is handed to `onLate('rejected', reason)` instead
 * of becoming an unhandled rejection, because a failing layer and an all-clear
 * must never look the same in the console.
 */
export function withStartDeadline(
  start: Promise<unknown>,
  deadlineMs: number,
  onLate: (outcome: LateOutcome, reason?: unknown) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let late = false;
    const timer = setTimeout(() => {
      late = true;
      onLate('pending', undefined);
      resolve();
    }, deadlineMs);
    start.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (reason: unknown) => {
        clearTimeout(timer);
        if (late) onLate('rejected', reason);
        else reject(reason instanceof Error ? reason : new Error(String(reason)));
      },
    );
  });
}
