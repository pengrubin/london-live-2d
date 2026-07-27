// Battery-saver lifecycle. A single user-facing switch — "power saver" —
// defaulting ON for touch/mobile devices and OFF for desktop, drives two
// measures:
//   (A) pause every realtime poller while the page is hidden (tab switched
//       away, screen locked), resuming — with an immediate refresh — on return;
//   (D) throttle the symbol-tier render loops on mobile so the GPU isn't
//       redrawing moving vehicles at ~15 Hz when battery matters.
// Layers register their pollers here (registerPoll) instead of calling
// setInterval directly, so all pausing/resuming happens in one place. Desktop
// with the switch OFF behaves exactly as before — pollers never pause.

import { SYMBOL_TIER_INTERVAL_MS } from './render-gate';

/** Touch-primary, no mouse-hover — our proxy for "phone / tablet". */
export const isMobile =
  typeof window !== 'undefined' &&
  window.matchMedia('(hover: none) and (pointer: coarse)').matches;

/** Symbol-tier cadence on mobile while saving power: ~3 Hz instead of ~15 Hz. */
const POWER_SAVE_SYMBOL_INTERVAL_MS = 300;

interface PollEntry {
  fn: () => void;
  ms: number;
  timer?: number;
}

const polls: PollEntry[] = [];
const changeListeners = new Set<(on: boolean) => void>();

// Default: save on mobile, run full-speed on desktop.
let powerSaverOn = isMobile;

/** Pollers run unless the saver is on AND the page is currently hidden. */
function pollShouldRun(): boolean {
  return !(powerSaverOn && document.hidden);
}

function startPolls(): void {
  for (const entry of polls) {
    if (entry.timer === undefined) {
      entry.fn(); // refresh immediately — data may be stale after a pause
      entry.timer = window.setInterval(entry.fn, entry.ms);
    }
  }
}

function stopPolls(): void {
  for (const entry of polls) {
    if (entry.timer !== undefined) {
      clearInterval(entry.timer);
      entry.timer = undefined;
    }
  }
}

function sync(): void {
  if (pollShouldRun()) startPolls();
  else stopPolls();
}

/**
 * Register a polling function — the drop-in replacement for
 * `window.setInterval(fn, ms)` in the realtime layers. The poller starts
 * immediately (unless already paused) and is paused/resumed by the saver.
 */
export function registerPoll(fn: () => void, ms: number): void {
  const entry: PollEntry = { fn, ms };
  polls.push(entry);
  if (pollShouldRun()) entry.timer = window.setInterval(fn, ms);
}

/**
 * Current symbol-tier render interval. Pass this function itself to
 * makeRenderGate so the cadence follows the saver live (mobile only).
 */
export function symbolTierIntervalMs(): number {
  return isMobile && powerSaverOn ? POWER_SAVE_SYMBOL_INTERVAL_MS : SYMBOL_TIER_INTERVAL_MS;
}

/** Flip the power-saver preference (driven by the Lines-tab toggle). */
export function setPowerSaver(on: boolean): void {
  if (on === powerSaverOn) return;
  powerSaverOn = on;
  sync();
  for (const cb of changeListeners) cb(on);
}

export function isPowerSaver(): boolean {
  return powerSaverOn;
}

/** Subscribe to changes so a toggle's UI can stay in sync. */
export function onPowerSaverChange(cb: (on: boolean) => void): void {
  changeListeners.add(cb);
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', sync);
}
