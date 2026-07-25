// Mobile-only touch drag-to-pan for map popups, with native long-press text
// selection preserved. Desktop mouse behaviour is untouched — this only wires
// touch listeners.
//
// Discrimination (classic drag-vs-longpress):
//   touchstart → mode='undecided', start a ~400ms timer.
//   touchmove  → if still undecided and moved >8px BEFORE the timer fired,
//                mode='pan' (cancel timer): preventDefault + map.panBy the delta.
//   timer fires (finger stationary) → mode='select': hand off to the browser's
//                native selection/copy menu; never pan.
//   touchend/cancel → reset.
// Close button and <a> links are left to native handling. Multi-touch bails out
// of pan so pinch-zoom still works.

import type { Map as MaplibreMap, Popup } from 'maplibre-gl';

const LONG_PRESS_MS = 400;
const MOVE_THRESHOLD_PX = 8;

type DragMode = 'undecided' | 'pan' | 'select';

/** Elements whose touches must reach native handlers, not the pan gesture. */
const PASSTHROUGH_SELECTOR = '.maplibregl-popup-close-button, a';

/**
 * Wire mobile drag-to-pan onto a popup. Re-attaches on every open because
 * MapLibre recreates the popup container element each time it is added to the
 * map. Call once per Popup instance (e.g. right after `new Popup(...)`).
 */
export function enablePopupDragToPan(map: MaplibreMap, popup: Popup): void {
  popup.on('open', () => {
    const el = popup.getElement();
    if (el) attachDragToPan(map, el);
  });
}

/**
 * True while the user is actively selecting/copying text inside `el`, so a
 * follow-popup should FREEZE (skip its per-frame setLngLat / setHTML) rather
 * than yank the DOM out from under the browser's selection. Two signals:
 *   (a) the drag helper's long-press flag (`dataset.selecting`), which covers
 *       the brief gap before the OS actually materialises a selection, and
 *   (b) a live, non-collapsed selection anchored inside `el` — platform
 *       agnostic, so it also freezes desktop click-drag selection for free.
 * Returns false once the selection clears, letting the popup resume following.
 */
export function isPopupTextInteracting(el: HTMLElement): boolean {
  if (el.dataset.selecting === '1') return true;
  const s = window.getSelection();
  return !!s && !s.isCollapsed && !!s.anchorNode && el.contains(s.anchorNode);
}

function attachDragToPan(map: MaplibreMap, el: HTMLElement): void {
  let mode: DragMode = 'undecided';
  let startX = 0;
  let startY = 0;
  let lastX = 0;
  let lastY = 0;
  let timer: number | null = null;

  const clearTimer = (): void => {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
  };

  const reset = (): void => {
    mode = 'undecided';
    clearTimer();
    // Selection nascent-gap flag is cleared on touch release; from here the
    // live-selection branch of isPopupTextInteracting takes over.
    delete el.dataset.selecting;
  };

  const onTouchStart = (e: TouchEvent): void => {
    // Only single-touch drags; leave multi-touch to the map's pinch-zoom.
    if (e.touches.length !== 1) {
      reset();
      return;
    }
    const target = e.target as Element | null;
    // The close button and links keep their native tap behaviour.
    if (target?.closest(PASSTHROUGH_SELECTOR)) return;
    const t = e.touches[0];
    startX = lastX = t.clientX;
    startY = lastY = t.clientY;
    mode = 'undecided';
    clearTimer();
    timer = window.setTimeout(() => {
      // Finger held roughly stationary → yield to native text selection.
      if (mode === 'undecided') {
        mode = 'select';
        // Freeze the follow-popup through the ~100 ms gap before the OS
        // materialises the selection (then branch 1b takes over).
        el.dataset.selecting = '1';
      }
      timer = null;
    }, LONG_PRESS_MS);
  };

  const onTouchMove = (e: TouchEvent): void => {
    // A second finger arriving mid-gesture: bail out of panning so the map's
    // native pinch-zoom takes over.
    if (e.touches.length > 1) {
      if (mode === 'pan') mode = 'undecided';
      return;
    }
    const t = e.touches[0];
    if (!t) return;

    if (mode === 'undecided') {
      const movedFromStart = Math.hypot(t.clientX - startX, t.clientY - startY);
      // Moved past the threshold before the long-press fired → it's a drag.
      if (movedFromStart > MOVE_THRESHOLD_PX) {
        mode = 'pan';
        clearTimer();
      }
    }

    if (mode === 'pan') {
      // Forward the gesture to the map; block native scroll/selection.
      e.preventDefault();
      const dx = t.clientX - lastX;
      const dy = t.clientY - lastY;
      map.panBy([-dx, -dy], { animate: false });
    }
    // mode === 'select' → do nothing; let native selection run.

    lastX = t.clientX;
    lastY = t.clientY;
  };

  // passive:false on touchmove so preventDefault() actually suppresses scrolling.
  el.addEventListener('touchstart', onTouchStart, { passive: true });
  el.addEventListener('touchmove', onTouchMove, { passive: false });
  el.addEventListener('touchend', reset, { passive: true });
  el.addEventListener('touchcancel', reset, { passive: true });
}
