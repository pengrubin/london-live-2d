// One subscription to "which bus lines is the rider searching for?", shared by
// every layer that scopes itself to the Filter tab's selection.
//
// buses.ts fires setBusRouteShapeHook on a REAL filter change only. Two things
// follow, and this module exists to handle both once instead of in every layer:
//
//   • ONE hook, many listeners. The hook list tolerates several registrants
//     (buses.ts:316-321), but a layer that registers its own has no way to learn
//     what the selection ALREADY is, and every extra hook is another thing
//     buses.ts must contain on each change. So exactly one hook is registered
//     here, ever, and fanned out from there.
//   • LATE SUBSCRIBERS ARE PUBLISHED TO. "On change only" means a layer whose
//     start() resolves after the rider has already typed would otherwise sit
//     blank until the next keystroke. Subscribing hands you the current value
//     immediately, so a listener never has to ask how it got there.
//
// ── THE MATCHING RULE — derived from live data. Do not "improve" it. ──
//
// Both name spaces are BODS `PublishedLineName` (backend/src/bods-client.ts:95),
// so a route label needs no normalisation beyond these four steps:
//
//   1. Strip a destination suffix. diversion-events.ts:206 labels a diverting
//      route `${line} → ${dest}` when the majority destination sign is known
//      ("SL8 → Uxbridge"), and the bare line when it is not. The live feed and
//      the closure feed never carry one.
//   2. Compare case-folded and EXACT. BODS ships mixed case in the wild ("Go2",
//      "x80", "N1"), so "n1" typed by the rider must match "N1" on the wire.
//   3. NEVER strip leading zeros and NEVER compare numerically. A zero-padded
//      route and its unpadded namesake are DIFFERENT ROADS. Measured today,
//      seven padded routes are live and every one has an unpadded twin run by a
//      different operator — 007/7, 022/22, 025/25, 030/30, 032/32, 035/35 and
//      040/40. All seven padded ones are National Express and NOTHING else
//      (NATX_0xx in the learned index); every unpadded twin is served by TFLO,
//      a London bus. The same seven, and only those seven, appear in the
//      diversion archive too, so the two feeds agree exactly and neither needs
//      padding-tolerant matching. Reproduce with:
//        ls data/bus-routes/learned | sed -E 's/\.json$//; s/^[A-Za-z0-9]+_//; s/_[a-z]+$//' | sort -u | grep -E '^0[0-9]+$'
//        cat ~/bus-archive/diversions/*.jsonl | grep -o '"routes":\[[^]]*\]' | grep -oE '"0[0-9]+"' | sort -u
//      Folding 025 into 25 would put a rider on the wrong road.
//   4. Trim surrounding whitespace; an empty label matches nothing.

import { setBusRouteShapeHook } from './buses';

/** Separator diversion-events.ts puts between a line and its destination sign.
 * Matched on the arrow alone rather than " → " because step 4's trim absorbs
 * the spaces either way, and an arrow never occurs inside a PublishedLineName. */
const DESTINATION_SEPARATOR = '→';

/**
 * Handed the new selection on every real filter change, and once on subscribing.
 * `Promise<void>` is spelled out because a listener that fetches is expected
 * (the stop-closure scope does) and TypeScript would silently accept an async
 * one against a `=> void` slot — saying so is what makes the rejection handling
 * in `callListener` part of the contract instead of an accident.
 */
export type SearchedLinesListener = (lines: ReadonlySet<string> | null) => void | Promise<void>;

/** Drops a listener registered with onSearchedLines. Idempotent. */
export type Unsubscribe = () => void;

let listeners: readonly SearchedLinesListener[] = [];

/** The latest selection, already normalised: never an empty set. */
let selection: ReadonlySet<string> | null = null;

let hookRegistered = false;

/** An empty selection is no selection. Normalising here means `searchedLines()`
 * never returns an empty set, so a consumer's `if (!lines)` is a complete test
 * for "the rider is not searching" and cannot miss the empty-set case. */
function normalizeSelection(lines: ReadonlySet<string> | null): ReadonlySet<string> | null {
  if (!lines || lines.size === 0) return null;
  return lines;
}

function logListenerFailure(index: number, error: unknown): void {
  console.warn(`[searched-lines] listener ${index} failed`, error);
}

/** True for anything with a `.then` — an async listener's return value. */
function isThenable(value: void | Promise<void>): value is Promise<void> {
  return typeof (value as Promise<void> | undefined)?.then === 'function';
}

/**
 * Calls one listener, contained. Two containments, because there are two ways to
 * fail: a synchronous throw lands in the catch, while an async listener throws
 * nothing here at all and instead returns a rejected promise that would sail
 * past into an unhandled rejection. Neither may take down the listeners behind
 * it — the same containment buses.ts applies to its own hooks.
 *
 * The rejection is observed, never awaited: a listener must reach the map in the
 * same turn as the filter change, and a slow one must not hold up the rest.
 */
function callListener(listener: SearchedLinesListener, index: number): void {
  try {
    const result = listener(selection);
    if (isThenable(result)) result.catch((error: unknown) => logListenerFailure(index, error));
  } catch (error) {
    logListenerFailure(index, error);
  }
}

/** Registers the single buses.ts hook, on first use of this module. */
function ensureRouteShapeHook(): void {
  if (hookRegistered) return;
  // Set before registering, so a listener that subscribes from inside the very
  // first delivery cannot register a second hook.
  hookRegistered = true;
  setBusRouteShapeHook((_map, lines) => publish(lines));
}

/** Fan a new selection out to every listener. */
function publish(lines: ReadonlySet<string> | null): void {
  selection = normalizeSelection(lines);
  // forEach walks the array captured now; a listener that unsubscribes mid-fanout
  // replaces `listeners` rather than mutating it, so this pass stays intact.
  listeners.forEach(callListener);
}

/**
 * Subscribe to the searched lines. The listener is called immediately with the
 * current selection, then on every real filter change. Returns an unsubscribe.
 */
export function onSearchedLines(listener: SearchedLinesListener): Unsubscribe {
  ensureRouteShapeHook();
  const index = listeners.length;
  listeners = [...listeners, listener];
  callListener(listener, index);
  return () => {
    listeners = listeners.filter((registered) => registered !== listener);
  };
}

/** The lines currently searched for, or null when the rider is not searching. */
export function searchedLines(): ReadonlySet<string> | null {
  ensureRouteShapeHook();
  return selection;
}

/** The comparable form of a route label: destination dropped, trimmed, folded. */
function foldLabel(label: string): string {
  const arrow = label.indexOf(DESTINATION_SEPARATOR);
  const line = arrow === -1 ? label : label.slice(0, arrow);
  return line.trim().toLowerCase();
}

/**
 * Does `routeLabel` — a line from a diversion event or a closed stop — belong to
 * the searched set? See THE MATCHING RULE at the top of this file.
 */
export function matchesSearch(routeLabel: string, lines: ReadonlySet<string> | null): boolean {
  if (!lines || lines.size === 0) return false;
  // Feed payloads are external data: a malformed `routes` entry must not throw.
  if (typeof routeLabel !== 'string') return false;
  const wanted = foldLabel(routeLabel);
  if (wanted === '') return false;
  for (const line of lines) {
    if (foldLabel(line) === wanted) return true;
  }
  return false;
}
