// Page lifecycle, driving two independent measures:
//   (A) pause every realtime poller while the page is hidden (tab switched
//       away, window minimised), resuming — with an immediate refresh — on
//       return. This is UNCONDITIONAL and not part of the power-saver switch:
//       a hidden page renders nothing, so every byte it polls is wasted, and
//       the origin is billed per byte for it. Browsers only throttle
//       background timers (Chrome settles around one tick a minute); stopping
//       them outright takes that to zero.
//   (D) throttle the symbol-tier render loops on mobile so the GPU isn't
//       redrawing moving vehicles at ~15 Hz when battery matters. This one IS
//       the user-facing "power saver" switch — ON by default for touch/mobile
//       devices, OFF for desktop.
// Layers register their pollers here (registerPoll) instead of calling
// setInterval directly, so all pausing/resuming happens in one place.
//
// A visible window on a second monitor is NOT hidden, so leaving the map up as
// a dashboard keeps polling at full rate — only genuinely backgrounded pages
// stop.

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

/** Pollers run whenever the page is visible, saver or not. */
function pollShouldRun(): boolean {
  return !document.hidden;
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

/**
 * Flip the power-saver preference (driven by the Lines-tab toggle). No sync()
 * here: the saver no longer gates polling, only the render cadence, which the
 * gates read live via symbolTierIntervalMs.
 */
export function setPowerSaver(on: boolean): void {
  if (on === powerSaverOn) return;
  powerSaverOn = on;
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
