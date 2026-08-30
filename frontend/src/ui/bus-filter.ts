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

/** Live-line cache TTL — the bus feed itself only refreshes every ~15 s. */
const LINES_TTL_MS = 20_000;
/** Retry sooner while the list is empty (first bus poll not landed yet). */
const EMPTY_RETRY_MS = 2_000;
/**
 * Datalist cap. The old design kept ALL ~600-700 live routes in the datalist
 * and rebuilt them on a timer — mobile browsers choke matching/rendering a
 * list that size on every keystroke, and the rebuild could land mid-typing.
 */
export const MAX_SUGGESTIONS = 12;
const DATALIST_ID = 'bus-filter-lines';

/** Normalize typed input to the tracker's `line` form (BODS lines are unpadded). */
function normalizeLine(raw: string): string {
  return raw.trim().toUpperCase();
}

/**
 * Up to `cap` autocomplete suggestions for `typed`, case-insensitively:
 * prefix matches rank first, substring matches fill any remaining slots.
 * Empty input suggests nothing — that is what keeps the datalist tiny.
 */
export function suggestLines(
  lines: readonly string[],
  typed: string,
  cap: number = MAX_SUGGESTIONS,
): string[] {
  const q = normalizeLine(typed);
  if (q === '') return [];
  const prefix: string[] = [];
  const substring: string[] = [];
  for (const line of lines) {
    const upper = line.toUpperCase();
    if (upper.startsWith(q)) {
      prefix.push(line);
      if (prefix.length >= cap) break; // cap reached — substrings can't outrank
    } else if (substring.length < cap && upper.includes(q)) {
      substring.push(line);
    }
  }
  return [...prefix, ...substring].slice(0, cap);
}

/**
 * Resolve typed input against the live lines, case-insensitively. A live match
 * returns that line's CANONICAL casing (BODS names are mixed-case in the wild:
 * "Go2", "x80"); an unknown line passes through uppercased so it can still be
 * selected before its first bus of the day appears — the buses layer matches
 * case-insensitively either way.
 */
export function resolveLine(typed: string, lines: readonly string[]): string {
  const norm = normalizeLine(typed);
  if (norm === '') return '';
  const canonical = lines.find((line) => line.toUpperCase() === norm);
  return canonical ?? norm;
}

/** Build the bus filter view into `container` (a control-panel section). */
export function addBusFilter(container: HTMLElement, map: MaplibreMap): void {
  // The chosen lines; the single source of truth driving setBusLineFilter().
  const selected = new Set<string>();

  // Live-line list, cached with a short TTL and refreshed lazily on
  // focus/input. This replaces a 20 s setInterval datalist rebuild whose
  // replaceChildren could land mid-typing and stall mobile keyboards. An empty
  // result usually means the first /api/buses poll hasn't landed yet, so it is
  // retried on a much shorter TTL — but still a TTL, so a genuinely bus-less
  // night can't trigger a full fleet rescan on every keystroke.
  let cachedLines: string[] = [];
  let cachedAt = 0;
  function liveLines(): string[] {
    const now = Date.now();
    const ttl = cachedLines.length === 0 ? EMPTY_RETRY_MS : LINES_TTL_MS;
    if (cachedAt === 0 || now - cachedAt >= ttl) {
      cachedLines = listActiveBusLines();
      cachedAt = now;
    }
    return cachedLines;
  }

  const wrap = document.createElement('div');
  wrap.className = 'legend-body bf-body';

  const hint = document.createElement('div');
  hint.className = 'bf-hint';
  hint.textContent = 'Type a route number to spotlight it — every other bus greys out.';

  // Input + Add button on one row (.bf-row in index.html).
  const inputRow = document.createElement('div');
  inputRow.className = 'bf-row';

  const input = document.createElement('input');
  // `search` (with NO inputmode override) keeps the full mobile keyboard,
  // return key included — the old inputmode=numeric pad could not type
  // lettered routes (N25, X68, W7, Go2) and iOS's numeric pad has no
  // confirm key at all.
  input.type = 'search';
  input.className = 'bf-input';
  input.placeholder = 'e.g. 24';
  input.setAttribute('list', DATALIST_ID);
  input.setAttribute('aria-label', 'Bus line number');
  input.setAttribute('enterkeyhint', 'go');
  input.setAttribute('autocapitalize', 'characters'); // route letters are caps
  input.setAttribute('autocomplete', 'off'); // the datalist IS the autocomplete
  input.spellcheck = false;

  // Visible confirm button so ANY keyboard can submit (some mobile keyboards
  // surface no usable return key). Same path as Enter/datalist-pick.
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'bf-clear'; // reuses the quiet-button look
  add.textContent = 'Add';
  add.setAttribute('aria-label', 'Add route to filter');

  // Native autocomplete list, filled per keystroke with capped matches only.
  const datalist = document.createElement('datalist');
  datalist.id = DATALIST_ID;

  const chips = document.createElement('div');
  chips.className = 'bf-chips';

  const feedback = document.createElement('div');
  feedback.className = 'bf-feedback';

  // Shown only while a route path is drawn: the path is inferred from vehicle
  // GPS, which drifts between tall buildings, so it can differ from the road
  // the bus legally runs on.
  const note = document.createElement('div');
  note.className = 'bf-note';
  note.textContent = 'Beta · route path learned from bus GPS, which drifts in cities.';

  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'bf-clear';
  clear.textContent = 'Clear';

  inputRow.append(input, add);
  wrap.append(hint, inputRow, datalist, chips, feedback, note, clear);
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
    // The caveat belongs to the drawn path, so it tracks the same condition
    // the route-shape layer does: a non-empty selection.
    note.hidden = selected.size === 0;
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

  function renderSuggestions(): void {
    const matches = suggestLines(liveLines(), input.value);
    datalist.replaceChildren(
      ...matches.map((line) => {
        const opt = document.createElement('option');
        opt.value = line;
        return opt;
      }),
    );
  }

  function addFromInput(): void {
    const line = resolveLine(input.value, liveLines());
    input.value = '';
    renderSuggestions(); // input is empty now → clears the datalist
    if (line === '') return;
    // Case-insensitive dedupe: a canonical "Go2" chip and typed "GO2" are the
    // same route — never show both.
    const upper = line.toUpperCase();
    for (const existing of selected) {
      if (existing.toUpperCase() === upper) return;
    }
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
  add.addEventListener('click', addFromInput);

  // Focus/input replace the old refresh interval for suggestions. The "N buses
  // live" count only refreshes on focus and on apply — NOT per keystroke:
  // counting is a full fleet scan (~8-9k trackers), and counts only drift as
  // the 15 s bus polls land anyway.
  input.addEventListener('focus', () => {
    renderSuggestions();
    if (selected.size > 0) renderFeedback();
  });
  input.addEventListener('input', renderSuggestions);

  clear.addEventListener('click', () => {
    if (selected.size === 0) return;
    selected.clear();
    apply();
  });

  apply();
}
