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

const MODE_ORDER = ['tube', 'dlr', 'elizabeth-line', 'overground', 'river-bus'];
const MODE_LABEL: Record<string, string> = {
  tube: 'Underground',
  dlr: 'DLR',
  'elizabeth-line': 'Elizabeth line',
  overground: 'Overground',
  'river-bus': 'River',
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
}

/** Build the lines legend + overlays view into `container` (a control-panel section). */
export function addLegend(
  container: HTMLElement,
  map: MaplibreMap,
  lines: readonly LegendLine[],
  overlays: readonly OverlayToggle[] = [],
): void {
  const hidden = new Set<string>();

  // Keep a dedicated scroll body inside the section so long line lists scroll
  // internally rather than stretching the shared panel.
  const body = document.createElement('div');
  body.className = 'legend-body';
  container.append(body);

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
      if (overlay.startOff) row.classList.add('off');
      row.addEventListener('click', () => {
        const turningOff = !row.classList.contains('off');
        row.classList.toggle('off', turningOff);
        for (const id of overlay.layerIds) {
          if (map.getLayer(id)) {
            map.setLayoutProperty(id, 'visibility', turningOff ? 'none' : 'visible');
          }
        }
      });
      body.append(row);
    }
  }
}
