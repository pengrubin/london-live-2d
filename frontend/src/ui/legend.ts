// Collapsible legend panel: one row per line (colour swatch + name), click to
// toggle that line's visibility (lines, casing and its vehicles together).

import type { Map as MaplibreMap, FilterSpecification } from 'maplibre-gl';

const FILTERED_LAYERS = ['transit-lines-casing', 'transit-lines-line', 'trains-dots'];

export interface LegendLine {
  id: string;
  name: string;
  mode: string;
  color: string;
  displayColor?: string;
}

// Phones (portrait) get too little room for the panels; start them collapsed so
// the map stays visible and let the user tap the header to expand.
const MOBILE_MEDIA_QUERY = '(max-width: 640px)';

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

export function addLegend(
  map: MaplibreMap,
  lines: readonly LegendLine[],
  overlays: readonly OverlayToggle[] = [],
): void {
  const hidden = new Set<string>();

  const panel = document.createElement('div');
  panel.className = 'legend';
  const header = document.createElement('div');
  header.className = 'legend-header';
  header.textContent = 'LINES';
  const body = document.createElement('div');
  body.className = 'legend-body';
  panel.append(header, body);

  header.addEventListener('click', () => {
    panel.classList.toggle('collapsed');
  });

  if (window.matchMedia(MOBILE_MEDIA_QUERY).matches) panel.classList.add('collapsed');

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

  map.getContainer().append(panel);
}
