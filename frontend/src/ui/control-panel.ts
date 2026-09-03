// Shared floating control panel (docks top-left): one collapsible shell with a
// row of top-level tabs that swap the body between four views —
//   🏆 Board  — the leaderboard (leaderboard.ts)
//   🚌 Filter — the bus line filter (bus-filter.ts)
//   🗺 Lines  — the lines legend + overlays (legend.ts)
//   ℹ️ Info   — data sources, licences, acknowledgements (about.ts)
// Merging the former two separate panels (leaderboard top-left + legend
// top-right) into one frees screen space on phones and leaves the top-right
// corner clear for MapLibre's geolocate control.

import type { Map as MaplibreMap } from 'maplibre-gl';
import { addAbout } from './about';
import { addLeaderboard, type VehicleLocator } from './leaderboard';
import { addBusFilter } from './bus-filter';
import { addLegend, type LegendLine, type OverlayToggle } from './legend';
import {
  disruptionsConnectionLost,
  disruptionsExpired,
  onDisruptionsUpdate,
  serviceStripRows,
  STALE_SUFFIX,
} from '../layers/disruptions';
import { hasLayer } from '../region';

// Phones (portrait) start the panel collapsed so the map stays visible; tapping
// the header expands it.
const MOBILE_MEDIA_QUERY = '(max-width: 640px)';

type TabKey = 'board' | 'filter' | 'lines' | 'about';
const ALL_TABS: { key: TabKey; label: string }[] = [
  { key: 'board', label: '🏆 Board' },
  { key: 'filter', label: '🚌 Filter' },
  { key: 'lines', label: '🗺 Lines' },
  { key: 'about', label: 'ℹ️ Info' },
];

export function addControlPanel(
  map: MaplibreMap,
  lines: readonly LegendLine[],
  overlays: readonly OverlayToggle[],
  colorByLine: ReadonlyMap<string, string>,
  locator: VehicleLocator,
): void {
  // The bus route filter is meaningless without buses — a working-looking
  // "type a route number" box in a city that has none is worse than no tab.
  // Lines always stays: it also hosts the overlay toggles, which every
  // deployment has at least some of.
  const tabs = ALL_TABS.filter((tab) => tab.key !== 'filter' || hasLayer('buses'));
  const defaultTab: TabKey = tabs[0]?.key ?? 'lines';

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
    const active = tabs.find((t) => t.key === key);
    if (active) header.textContent = active.label;
  }

  for (const { key, label } of tabs) {
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
  const boardSection = sectionByKey.get('board');
  if (boardSection) addLeaderboard(boardSection, map, colorByLine, locator);
  const filterSection = sectionByKey.get('filter');
  if (filterSection) addBusFilter(filterSection, map);
  const linesSection = sectionByKey.get('lines');
  if (linesSection) {
    // Above the legend: line-scope disruptions draw nothing on the map by
    // design, so this strip is their only path to a phone screen.
    if (hasLayer('disruptions')) addServiceStrip(linesSection);
    addLegend(linesSection, map, lines, overlays);
  }
  const aboutSection = sectionByKey.get('about');
  if (aboutSection) addAbout(aboutSection);

  activate(defaultTab);
  if (window.matchMedia(MOBILE_MEDIA_QUERY).matches) panel.classList.add('collapsed');

  // On phones, tapping the map (which only fires for the canvas, never for taps
  // on the panel itself) means "let me see the map" — so collapse the panel.
  // Desktop leaves it open. matchMedia is re-checked per tap to follow rotation.
  map.on('click', () => {
    if (window.matchMedia(MOBILE_MEDIA_QUERY).matches && !panel.classList.contains('collapsed')) {
      panel.classList.add('collapsed');
    }
  });

  panel.append(header, tabStrip, cpBody);
  map.getContainer().append(panel);
}

/**
 * Compact Service strip: one row per item TfL localised to no place at all.
 * Every string is written with textContent and every attribute set as a DOM
 * property — the escape helpers here do not escape apostrophes.
 */
function addServiceStrip(container: HTMLElement): void {
  const strip = document.createElement('div');
  strip.className = 'svc-strip';
  strip.hidden = true;
  container.append(strip);

  function paint(): void {
    strip.replaceChildren();
    strip.hidden = false;
    if (disruptionsExpired()) {
      const row = document.createElement('div');
      row.className = 'svc-row svc-dim';
      // An outage and a genuine all-clear must never read the same.
      row.textContent = disruptionsConnectionLost()
        ? 'Disruption data unavailable'
        : 'No current disruption data';
      strip.append(row);
      return;
    }
    const rows = serviceStripRows();
    strip.hidden = rows.length === 0;
    for (const item of rows) {
      const row = document.createElement('div');
      row.className = item.stale ? 'svc-row svc-dim' : 'svc-row';
      row.title = item.reason;
      const swatch = document.createElement('span');
      swatch.className = 'legend-swatch';
      swatch.style.background = item.color;
      const label = document.createElement('span');
      label.className = 'svc-label';
      label.textContent = `${item.lineName}: ${item.text}`;
      const when = document.createElement('span');
      when.className = 'svc-when';
      // The map has already greyed this item's bands; say so here too.
      when.textContent = item.stale ? `${item.when}${STALE_SUFFIX}` : item.when;
      row.append(swatch, label, when);
      strip.append(row);
    }
  }

  // The layer publishes its first snapshot before the panel mounts, so paint
  // once now rather than waiting up to a minute for the next tick.
  paint();
  onDisruptionsUpdate(paint);
}
