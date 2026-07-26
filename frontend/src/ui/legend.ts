// Lines legend view: one row per line (colour swatch + name), click to toggle
// that line's visibility (lines, casing and its vehicles together), plus the
// Overlays section. Rendered INTO a container supplied by the shared control
// panel (control-panel.ts) — it no longer owns its own floating panel/header.

import type { Map as MaplibreMap, FilterSpecification } from 'maplibre-gl';

const FILTERED_LAYERS = ['transit-lines-casing', 'transit-lines-line', 'trains-dots'];

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
  /** stable handle so other views can force this overlay on (e.g. 'buses'). */
  key?: string;
}

/** Imperative hooks the control panel wires between views. */
export interface LegendHandle {
  /**
   * Force an overlay on by key, syncing its row + map layers. Used by the bus
   * filter: filtering is pointless if the Buses overlay was toggled off, so the
   * filter re-enables it. No-op if the overlay is already on or the key is unknown.
   */
  ensureOverlayOn(key: string): void;
}

/** Build the lines legend + overlays view into `container` (a control-panel section). */
export function addLegend(
  container: HTMLElement,
  map: MaplibreMap,
  lines: readonly LegendLine[],
  overlays: readonly OverlayToggle[] = [],
): LegendHandle {
  const hidden = new Set<string>();
  // Every line row and every overlay row, so Select all / Unselect all can flip
  // them in one pass, and ensureOverlayOn() can target one by key.
  const lineRows: { id: string; row: HTMLElement }[] = [];
  const overlayRows: { overlay: OverlayToggle; row: HTMLElement }[] = [];
  const overlayByKey = new Map<string, { overlay: OverlayToggle; row: HTMLElement }>();

  /** Toggle one overlay's row state + its map layers together. */
  function setOverlay(entry: { overlay: OverlayToggle; row: HTMLElement }, off: boolean): void {
    entry.row.classList.toggle('off', off);
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
    row.append(swatch, label);
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
      if (overlay.key) overlayByKey.set(overlay.key, entry);
    }
  }

  return {
    ensureOverlayOn(key: string): void {
      const entry = overlayByKey.get(key);
      if (entry && entry.row.classList.contains('off')) setOverlay(entry, false);
    },
  };
}
