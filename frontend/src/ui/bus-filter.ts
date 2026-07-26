// Bus line-filter view: type a route number (e.g. 24) to keep buses on that
// line red while every OTHER bus greys out — without hiding any of them, so the
// greyed buses stay on the map and remain clickable. Supports several lines at
// once via removable chips; an empty selection clears the filter. Rendered INTO
// a container supplied by the shared control panel (control-panel.ts).

import type { Map as MaplibreMap } from 'maplibre-gl';
import {
  countActiveBusesOnLines,
  listActiveBusLines,
  setBusLineFilter,
} from '../layers/buses';

/** How often the autocomplete list is refreshed to reflect currently-live routes. */
const SUGGEST_REFRESH_MS = 20_000;
const DATALIST_ID = 'bus-filter-lines';

/** Normalize typed input to the tracker's `line` form (BODS lines are unpadded). */
function normalizeLine(raw: string): string {
  return raw.trim().toUpperCase();
}

/** Build the bus filter view into `container` (a control-panel section). */
export function addBusFilter(container: HTMLElement, map: MaplibreMap): void {
  // The chosen lines; the single source of truth driving setBusLineFilter().
  const selected = new Set<string>();

  const wrap = document.createElement('div');
  wrap.className = 'legend-body bf-body';

  const hint = document.createElement('div');
  hint.className = 'bf-hint';
  hint.textContent = 'Type a route number to spotlight it — every other bus greys out.';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'bf-input';
  input.placeholder = 'e.g. 24';
  input.setAttribute('inputmode', 'numeric');
  input.setAttribute('list', DATALIST_ID);
  input.setAttribute('aria-label', 'Bus line number');

  // Native autocomplete, refreshed on an interval so it tracks live routes.
  const datalist = document.createElement('datalist');
  datalist.id = DATALIST_ID;

  const chips = document.createElement('div');
  chips.className = 'bf-chips';

  const feedback = document.createElement('div');
  feedback.className = 'bf-feedback';

  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'bf-clear';
  clear.textContent = 'Clear';

  wrap.append(hint, input, datalist, chips, feedback, clear);
  container.append(wrap);

  /** Push the current selection down to the map and refresh chips + feedback. */
  function apply(): void {
    setBusLineFilter(map, selected.size === 0 ? null : selected);
    renderChips();
    renderFeedback();
  }

  function renderChips(): void {
    chips.replaceChildren();
    for (const line of selected) {
      const chip = document.createElement('span');
      chip.className = 'bf-chip';
      const label = document.createElement('span');
      label.textContent = line;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'bf-chip-x';
      remove.textContent = '×';
      remove.setAttribute('aria-label', `Remove route ${line}`);
      remove.addEventListener('click', () => {
        selected.delete(line);
        apply();
      });
      chip.append(label, remove);
      chips.append(chip);
    }
  }

  function renderFeedback(): void {
    if (selected.size === 0) {
      feedback.textContent = 'No filter — all buses shown normally.';
      clear.disabled = true;
      return;
    }
    const live = countActiveBusesOnLines(selected);
    const routes = [...selected].join(', ');
    const noun = live === 1 ? 'bus' : 'buses';
    feedback.textContent = `route ${routes} · ${live} ${noun} live`;
    clear.disabled = false;
  }

  function addFromInput(): void {
    const line = normalizeLine(input.value);
    input.value = '';
    if (line === '' || selected.has(line)) return;
    selected.add(line);
    apply();
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addFromInput();
    }
  });
  // Picking a datalist suggestion fires `change` (not always `keydown`).
  input.addEventListener('change', addFromInput);

  clear.addEventListener('click', () => {
    if (selected.size === 0) return;
    selected.clear();
    apply();
  });

  function refreshSuggestions(): void {
    const lines = listActiveBusLines();
    datalist.replaceChildren(
      ...lines.map((line) => {
        const opt = document.createElement('option');
        opt.value = line;
        return opt;
      }),
    );
    // Live counts shift the numbers under an active filter — keep them fresh.
    if (selected.size > 0) renderFeedback();
  }

  refreshSuggestions();
  window.setInterval(refreshSuggestions, SUGGEST_REFRESH_MS);
  apply();
}
