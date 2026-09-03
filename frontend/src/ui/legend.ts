// Lines legend view: one row per line (colour swatch + name), click to toggle
// that line's visibility (lines, casing and its vehicles together), plus the
// Overlays section. Rendered INTO a container supplied by the shared control
// panel (control-panel.ts) — it no longer owns its own floating panel/header.

import type { Map as MaplibreMap, FilterSpecification } from 'maplibre-gl';
import { isMobile, isPowerSaver, onPowerSaverChange, setPowerSaver } from '../util/lifecycle';
import { linePip, onDisruptionsUpdate } from '../layers/disruptions';

// Hiding a line hides its disruption bands and rings too. Ids are spelled out
// rather than imported so this list stays a plain string table, as it was for
// the transit layers — and because applyFilter REPLACES a layer's filter, none
// of these layers may carry a filter of its own.
const FILTERED_LAYERS = [
  'transit-lines-casing',
  'transit-lines-line',
  'trains-dots',
  'disruptions-wash',
  'disruptions-core',
  'disruptions-hatch',
  'disruptions-stations-ring',
  'disruptions-planned',
  'disruptions-stations-planned',
];

export interface LegendLine {
  id: string;
  name: string;
  mode: string;
  color: string;
  displayColor?: string;
}

// Cable Car and Tram sit last: both are geographically isolated and rarely used,
// so they belong below the everyday network rather than mixed into it.
const MODE_ORDER = ['tube', 'dlr', 'elizabeth-line', 'overground', 'river-bus', 'cable-car', 'tram'];
const MODE_LABEL: Record<string, string> = {
  tube: 'Underground',
  dlr: 'DLR',
  'elizabeth-line': 'Elizabeth line',
  overground: 'Overground',
  'river-bus': 'River',
  'cable-car': 'Cable Car',
  tram: 'Trams',
};

function applyFilter(map: MaplibreMap, hidden: ReadonlySet<string>): void {
  const filter: FilterSpecification | null =
    hidden.size === 0
      ? null
      : (['!', ['in', ['get', 'lineId'], ['literal', [...hidden]]]] as FilterSpecification);
  for (const layer of FILTERED_LAYERS) {
    if (map.getLayer(layer)) map.setFilter(layer, filter);
  }
}

export interface OverlayToggle {
  label: string;
  layerIds: string[];
  /** start in the off state (layer ships with visibility 'none') */
  startOff?: boolean;
  /**
   * Custom visibility handler. When present the legend delegates this overlay's
   * visibility to it (and does NOT touch layerIds directly) — used by Buses,
   * whose visibility is resolved against the line filter, not a plain toggle.
   */
  onToggle?: (visible: boolean) => void;
}

/** Build the lines legend + overlays view into `container` (a control-panel section). */
export function addLegend(
  container: HTMLElement,
  map: MaplibreMap,
  lines: readonly LegendLine[],
  overlays: readonly OverlayToggle[] = [],
): void {
  const hidden = new Set<string>();
  // Every line row and every overlay row, so Select all / Unselect all can flip
  // them in one pass.
  const lineRows: { id: string; row: HTMLElement }[] = [];
  const pips: { id: string; pip: HTMLElement }[] = [];
  const overlayRows: { overlay: OverlayToggle; row: HTMLElement }[] = [];

  /** Toggle one overlay's row state + its map layers (or its custom handler). */
  function setOverlay(entry: { overlay: OverlayToggle; row: HTMLElement }, off: boolean): void {
    entry.row.classList.toggle('off', off);
    if (entry.overlay.onToggle) {
      entry.overlay.onToggle(!off);
      return;
    }
    for (const id of entry.overlay.layerIds) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', off ? 'none' : 'visible');
    }
  }

  // Bulk actions pinned above the scroll body so they never scroll out of reach.
  const actions = document.createElement('div');
  actions.className = 'legend-actions';
  const selectAllBtn = document.createElement('button');
  selectAllBtn.type = 'button';
  selectAllBtn.className = 'legend-action';
  selectAllBtn.textContent = 'Select all';
  selectAllBtn.addEventListener('click', () => {
    hidden.clear();
    for (const { row } of lineRows) row.classList.remove('off');
    applyFilter(map, hidden);
    for (const entry of overlayRows) setOverlay(entry, false);
  });
  const clearAllBtn = document.createElement('button');
  clearAllBtn.type = 'button';
  clearAllBtn.className = 'legend-action';
  clearAllBtn.textContent = 'Unselect all';
  clearAllBtn.addEventListener('click', () => {
    hidden.clear();
    for (const { id, row } of lineRows) {
      hidden.add(id);
      row.classList.add('off');
    }
    applyFilter(map, hidden);
    for (const entry of overlayRows) setOverlay(entry, true);
  });
  actions.append(selectAllBtn, clearAllBtn);

  // Keep a dedicated scroll body inside the section so long line lists scroll
  // internally rather than stretching the shared panel.
  const body = document.createElement('div');
  body.className = 'legend-body';
  container.append(actions, body);

  const sorted = [...lines].sort(
    (a, b) =>
      MODE_ORDER.indexOf(a.mode) - MODE_ORDER.indexOf(b.mode) || a.name.localeCompare(b.name),
  );

  let currentMode = '';
  for (const line of sorted) {
    if (line.mode !== currentMode) {
      currentMode = line.mode;
      const group = document.createElement('div');
      group.className = 'legend-group';
      group.textContent = MODE_LABEL[line.mode] ?? line.mode;
      body.append(group);
    }
    const row = document.createElement('div');
    row.className = 'legend-row';
    const swatch = document.createElement('span');
    swatch.className = 'legend-swatch';
    swatch.style.background = line.displayColor ?? line.color;
    const label = document.createElement('span');
    label.textContent = line.name;
    // Disruption pip: the only trace a line-scope item leaves outside the
    // Lines tab. Colour says the worst class on this line, blue says the only
    // items are planned works.
    const pip = document.createElement('span');
    pip.className = 'legend-pip';
    pip.hidden = true;
    paintPip(pip, line.id);
    pips.push({ id: line.id, pip });
    row.append(swatch, label, pip);
    row.addEventListener('click', () => {
      if (hidden.has(line.id)) hidden.delete(line.id);
      else hidden.add(line.id);
      row.classList.toggle('off', hidden.has(line.id));
      applyFilter(map, hidden);
    });
    body.append(row);
    lineRows.push({ id: line.id, row });
  }

  if (overlays.length > 0) {
    const group = document.createElement('div');
    group.className = 'legend-group';
    group.textContent = 'Overlays';
    body.append(group);
    for (const overlay of overlays) {
      const row = document.createElement('div');
      row.className = 'legend-row';
      const swatch = document.createElement('span');
      swatch.className = 'legend-swatch';
      swatch.style.background = '#8a94a0';
      const label = document.createElement('span');
      label.textContent = overlay.label;
      row.append(swatch, label);
      const entry = { overlay, row };
      if (overlay.startOff) row.classList.add('off');
      row.addEventListener('click', () => {
        setOverlay(entry, !row.classList.contains('off'));
      });
      body.append(row);
      overlayRows.push(entry);
    }
  }

  onDisruptionsUpdate(() => {
    for (const entry of pips) paintPip(entry.pip, entry.id);
  });

  addBatterySaver(body);
}

/** `title` and colour are set as DOM properties: the escape helpers in this
 * codebase leave `'` alone, so no upstream string is ever interpolated into
 * markup. */
function paintPip(pip: HTMLElement, lineId: string): void {
  const state = linePip(lineId);
  pip.hidden = state === null;
  if (!state) return;
  pip.style.background = state.color;
  pip.title = state.title;
}

/**
 * Battery-saver preference row (bottom of the Lines tab). Distinct from the
 * line/overlay toggles above — it doesn't touch any layer, it eases the
 * animation cadence to spare the GPU. Defaults on.
 *
 * MOBILE ONLY, and deliberately so: pausing the pollers while the page is
 * hidden used to be the other half of this switch, but that is now
 * unconditional (see util/lifecycle), and easing the cadence is gated on
 * isMobile. On desktop the switch would therefore do nothing at all, and a
 * visible control that does nothing is worse than no control.
 */
function addBatterySaver(body: HTMLElement): void {
  if (!isMobile) return;

  const wrap = document.createElement('div');
  wrap.className = 'legend-saver';

  const row = document.createElement('div');
  row.className = 'legend-row legend-saver-row';

  const label = document.createElement('span');
  label.className = 'legend-saver-label';
  label.textContent = '🔋 Battery saver';

  const state = document.createElement('span');
  state.className = 'legend-saver-state';

  const hint = document.createElement('div');
  hint.className = 'legend-saver-hint';
  hint.textContent = 'Eases the animation to save power. Updates always pause when the map is hidden.';

  function paint(): void {
    const on = isPowerSaver();
    row.classList.toggle('off', !on);
    state.textContent = on ? 'On' : 'Off';
  }

  row.addEventListener('click', () => setPowerSaver(!isPowerSaver()));
  onPowerSaverChange(paint);
  paint();

  row.append(label, state);
  wrap.append(row, hint);
  body.append(wrap);
}
