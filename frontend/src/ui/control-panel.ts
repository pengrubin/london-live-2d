// Shared floating control panel (docks top-left): one collapsible shell with a
// row of top-level tabs that swap the body between three views —
//   🏆 Board  — the leaderboard (leaderboard.ts)
//   🚌 Filter — the bus line filter (bus-filter.ts)
//   🗺 Lines  — the lines legend + overlays (legend.ts)
// Merging the former two separate panels (leaderboard top-left + legend
// top-right) into one frees screen space on phones and leaves the top-right
// corner clear for MapLibre's zoom + geolocate controls.

import type { Map as MaplibreMap } from 'maplibre-gl';
import { addLeaderboard, type VehicleLocator } from './leaderboard';
import { addBusFilter } from './bus-filter';
import { addLegend, type LegendLine, type OverlayToggle } from './legend';

// Phones (portrait) start the panel collapsed so the map stays visible; tapping
// the header expands it.
const MOBILE_MEDIA_QUERY = '(max-width: 640px)';

type TabKey = 'board' | 'filter' | 'lines';
const TABS: { key: TabKey; label: string }[] = [
  { key: 'board', label: '🏆 Board' },
  { key: 'filter', label: '🚌 Filter' },
  { key: 'lines', label: '🗺 Lines' },
];
const DEFAULT_TAB: TabKey = 'board';

export function addControlPanel(
  map: MaplibreMap,
  lines: readonly LegendLine[],
  overlays: readonly OverlayToggle[],
  colorByLine: ReadonlyMap<string, string>,
  locator: VehicleLocator,
): void {
  const panel = document.createElement('div');
  panel.className = 'legend control-panel';

  // Header doubles as the collapse toggle and shows the active view's label so
  // it stays meaningful even while collapsed.
  const header = document.createElement('div');
  header.className = 'legend-header';
  header.addEventListener('click', () => panel.classList.toggle('collapsed'));

  const tabStrip = document.createElement('div');
  tabStrip.className = 'cp-tabs';

  const cpBody = document.createElement('div');
  cpBody.className = 'cp-body';

  const tabByKey = new Map<TabKey, HTMLElement>();
  const sectionByKey = new Map<TabKey, HTMLElement>();

  function activate(key: TabKey): void {
    for (const [k, tab] of tabByKey) tab.classList.toggle('active', k === key);
    for (const [k, section] of sectionByKey) section.classList.toggle('active', k === key);
    const active = TABS.find((t) => t.key === key);
    if (active) header.textContent = active.label;
  }

  for (const { key, label } of TABS) {
    const tab = document.createElement('div');
    tab.className = 'cp-tab';
    tab.textContent = label;
    tab.addEventListener('click', () => activate(key));
    tabByKey.set(key, tab);
    tabStrip.append(tab);

    const section = document.createElement('div');
    section.className = 'cp-section';
    sectionByKey.set(key, section);
    cpBody.append(section);
  }

  // Mount each view into its own section. Order is irrelevant to visibility
  // (tabs drive that) but matches the tab order for readability.
  addLeaderboard(sectionByKey.get('board')!, map, colorByLine, locator);
  addBusFilter(sectionByKey.get('filter')!, map);
  addLegend(sectionByKey.get('lines')!, map, lines, overlays);

  activate(DEFAULT_TAB);
  if (window.matchMedia(MOBILE_MEDIA_QUERY).matches) panel.classList.add('collapsed');

  panel.append(header, tabStrip, cpBody);
  map.getContainer().append(panel);
}
