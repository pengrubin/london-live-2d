// Collapsible top-left leaderboard panel: ranks vehicles by cumulative
// distance travelled, with Day / Week / Month tabs and a mode row that
// ranks Trains / Buses / Ships separately. Double-clicking a row flies the
// map to that vehicle (with a pulse highlight) when it is currently live;
// otherwise the row briefly shows "not running".
// Styled by reusing the legend classes plus .leaderboard/.lb-* overrides.

import { Marker, type Map as MaplibreMap } from 'maplibre-gl';

const REFRESH_INTERVAL_MS = 30_000;
const LOCATE_ZOOM = 14.5;
const LOCATE_FLY_MS = 1_500;
const PULSE_LIFETIME_MS = 3_000;
const NOT_RUNNING_MS = 2_000;
const PERIODS = ['day', 'week', 'month'] as const;
type Period = (typeof PERIODS)[number];
const PERIOD_LABEL: Record<Period, string> = { day: 'Day', week: 'Week', month: 'Month' };

const MODES = ['train', 'bus', 'ship'] as const;
type Mode = (typeof MODES)[number];
const MODE_LABEL: Record<Mode, string> = {
  train: '🚇 Trains',
  bus: '🚌 Buses',
  ship: '⛴ Ships',
};

const BUS_CHIP_COLOR = '#DA291C'; // London bus red
const SHIP_CHIP_COLOR = '#2E86DE';
const FALLBACK_CHIP_COLOR = '#8a94a0';

interface LeaderboardRow {
  rank: number;
  mode: 'tube' | 'bus' | 'ship';
  id: string;
  label: string;
  lineId?: string;
  km: number;
}

interface LeaderboardResponse {
  period: Period;
  mode: Mode;
  key: string;
  totalVehicles: number;
  top: LeaderboardRow[];
}

/** Per-mode live position lookups, wired from main.ts. */
export interface VehicleLocator {
  /** train key is "lineId:vehicleId" (also used by TfL river vehicles) */
  findTrain: (key: string) => [number, number] | null;
  /** bus id is the operator-qualified vehicle id "OPERATOR:VehicleRef" */
  findBus: (id: string) => [number, number] | null;
  findVessel: (mmsi: number) => [number, number] | null;
}

const TUBE_ID_PREFIX = 'tube:';
const RIVER_ID_PREFIX = 'ship:tfl:';
const BUS_ID_PREFIX = 'bus:';
const AIS_ID_PREFIX = 'ship:';

/** Map a leaderboard entry id onto the matching live-layer lookup. */
function lookupPosition(id: string, locator: VehicleLocator): [number, number] | null {
  if (id.startsWith(TUBE_ID_PREFIX)) return locator.findTrain(id.slice(TUBE_ID_PREFIX.length));
  if (id.startsWith(RIVER_ID_PREFIX)) return locator.findTrain(id.slice(RIVER_ID_PREFIX.length));
  if (id.startsWith(BUS_ID_PREFIX)) return locator.findBus(id.slice(BUS_ID_PREFIX.length));
  if (id.startsWith(AIS_ID_PREFIX)) {
    const mmsi = Number(id.slice(AIS_ID_PREFIX.length));
    return Number.isFinite(mmsi) ? locator.findVessel(mmsi) : null;
  }
  return null;
}

function chipColor(row: LeaderboardRow, colorByLine: ReadonlyMap<string, string>): string {
  if (row.lineId) {
    const lineColor = colorByLine.get(row.lineId);
    if (lineColor) return lineColor;
  }
  if (row.mode === 'bus') return BUS_CHIP_COLOR;
  if (row.mode === 'ship') return SHIP_CHIP_COLOR;
  return FALLBACK_CHIP_COLOR;
}

export function addLeaderboard(
  map: MaplibreMap,
  colorByLine: ReadonlyMap<string, string>,
  locator: VehicleLocator,
): void {
  let activePeriod: Period = 'day';
  let activeMode: Mode = 'train';
  let pulseMarker: Marker | null = null;
  let pulseTimer: number | null = null;

  /** Fly to the vehicle and drop a short-lived pulse highlight on it. */
  function showPulse(lngLat: [number, number]): void {
    if (pulseTimer !== null) window.clearTimeout(pulseTimer);
    pulseMarker?.remove();
    // MapLibre positions the marker element itself via style.transform, so the
    // animated ripple must live on a CHILD — animating transform on the marker
    // element would override that translate and pin the ripple to (0,0).
    const anchor = document.createElement('div');
    anchor.className = 'lb-pulse-anchor';
    const ripple = document.createElement('div');
    ripple.className = 'lb-pulse';
    anchor.append(ripple);
    pulseMarker = new Marker({ element: anchor }).setLngLat(lngLat).addTo(map);
    pulseTimer = window.setTimeout(() => {
      pulseMarker?.remove();
      pulseMarker = null;
      pulseTimer = null;
    }, PULSE_LIFETIME_MS);
  }

  /** Briefly swap the row's km cell for a dim "not running" label. */
  function showNotRunning(kmEl: HTMLElement, kmText: string): void {
    const pending = kmEl.dataset.restoreTimer;
    if (pending !== undefined) window.clearTimeout(Number(pending));
    kmEl.textContent = 'not running';
    kmEl.classList.add('lb-not-running');
    const timer = window.setTimeout(() => {
      kmEl.textContent = kmText;
      kmEl.classList.remove('lb-not-running');
      delete kmEl.dataset.restoreTimer;
    }, NOT_RUNNING_MS);
    kmEl.dataset.restoreTimer = String(timer);
  }

  function locateVehicle(row: LeaderboardRow, kmEl: HTMLElement, kmText: string): void {
    const position = lookupPosition(row.id, locator);
    if (position) {
      map.flyTo({ center: position, zoom: LOCATE_ZOOM, duration: LOCATE_FLY_MS });
      showPulse(position);
    } else {
      showNotRunning(kmEl, kmText);
    }
  }

  const panel = document.createElement('div');
  panel.className = 'legend leaderboard';
  const header = document.createElement('div');
  header.className = 'legend-header';
  header.textContent = '🏆 LEADERBOARD';
  header.addEventListener('click', () => {
    panel.classList.toggle('collapsed');
  });

  const tabs = document.createElement('div');
  tabs.className = 'lb-tabs';
  const tabByPeriod = new Map<Period, HTMLElement>();
  for (const period of PERIODS) {
    const tab = document.createElement('div');
    tab.className = 'lb-tab';
    tab.textContent = PERIOD_LABEL[period];
    if (period === activePeriod) tab.classList.add('active');
    tab.addEventListener('click', () => {
      if (period === activePeriod) return;
      activePeriod = period;
      for (const [p, el] of tabByPeriod) el.classList.toggle('active', p === period);
      void refresh();
    });
    tabByPeriod.set(period, tab);
    tabs.append(tab);
  }

  const modeTabs = document.createElement('div');
  modeTabs.className = 'lb-tabs lb-modes';
  const tabByMode = new Map<Mode, HTMLElement>();
  for (const mode of MODES) {
    const tab = document.createElement('div');
    tab.className = 'lb-tab';
    tab.textContent = MODE_LABEL[mode];
    if (mode === activeMode) tab.classList.add('active');
    tab.addEventListener('click', () => {
      if (mode === activeMode) return;
      activeMode = mode;
      for (const [m, el] of tabByMode) el.classList.toggle('active', m === mode);
      void refresh();
    });
    tabByMode.set(mode, tab);
    modeTabs.append(tab);
  }

  const body = document.createElement('div');
  body.className = 'legend-body lb-body';
  panel.append(header, tabs, modeTabs, body);

  function render(data: LeaderboardResponse): void {
    body.replaceChildren();
    if (data.top.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'lb-empty';
      empty.textContent = 'No movement recorded yet.';
      body.append(empty);
      return;
    }
    for (const row of data.top) {
      const rowEl = document.createElement('div');
      rowEl.className = 'legend-row lb-row';
      const rank = document.createElement('span');
      rank.className = 'lb-rank';
      rank.textContent = String(row.rank);
      const chip = document.createElement('span');
      chip.className = 'legend-swatch lb-chip';
      chip.style.background = chipColor(row, colorByLine);
      const label = document.createElement('span');
      label.className = 'lb-label';
      label.textContent = row.label;
      label.title = row.id;
      const km = document.createElement('span');
      km.className = 'lb-km';
      const kmText = `${row.km.toFixed(1)} km`;
      km.textContent = kmText;
      // Double-click locates the vehicle; single-click intentionally does nothing.
      rowEl.addEventListener('dblclick', () => locateVehicle(row, km, kmText));
      rowEl.append(rank, chip, label, km);
      body.append(rowEl);
    }
    const total = document.createElement('div');
    total.className = 'lb-total';
    total.textContent = `${data.totalVehicles} vehicles tracked · ${data.key}`;
    body.append(total);
  }

  async function refresh(): Promise<void> {
    const requestedPeriod = activePeriod;
    const requestedMode = activeMode;
    try {
      const res = await fetch(`/api/leaderboard?period=${requestedPeriod}&mode=${requestedMode}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as LeaderboardResponse;
      // Ignore stale responses: either selector may have changed mid-flight.
      if (requestedPeriod === activePeriod && requestedMode === activeMode) render(data);
    } catch (err) {
      console.error('[leaderboard] refresh failed:', err);
    }
  }

  void refresh();
  window.setInterval(() => void refresh(), REFRESH_INTERVAL_MS);

  map.getContainer().append(panel);
}
