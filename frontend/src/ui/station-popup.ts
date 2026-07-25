// Click-to-inspect popup for stations/piers: fetches a live departure board
// from the backend proxy and renders the next few services, then enriches the
// card with zone/facilities, live crowding, lift disruptions and nearby bike
// docks once those slower lookups resolve.

import { Popup, type LngLat, type Map as MaplibreMap, type MapLayerMouseEvent } from 'maplibre-gl';
import { enablePopupDragToPan } from './popup-drag';

const STATIONS_LAYER_ID = 'stations-circle';
const MAX_DEPARTURES = 8;
const MAX_BIKE_DOCKS = 2;
const LIFT_MESSAGE_MAX_CHARS = 90;

interface StopPrediction {
  lineId: string;
  lineName?: string;
  destinationName?: string;
  towards?: string;
  timeToStation: number;
  platformName?: string;
}

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);

export function truncate(s: string, maxChars: number): string {
  return s.length > maxChars ? `${s.slice(0, maxChars - 1).trimEnd()}…` : s;
}

// ── injected styles for enrichment classes (index.html is owned elsewhere) ──

const ENRICH_STYLE_ID = 'sp-enrich-styles';

/** Appends the enrichment CSS once; safe to call from any popup module. */
export function injectPopupStyles(): void {
  if (document.getElementById(ENRICH_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = ENRICH_STYLE_ID;
  style.textContent = `
    .sp-footer { border-top: 1px solid #222; margin-top: 6px; padding-top: 6px; }
    .sp-tags { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 3px; }
    .sp-tag {
      background: #23262c; border: 1px solid #333; border-radius: 3px;
      padding: 0 5px; font-size: 10px; color: #aab;
    }
    .sp-fact { color: #888; font-size: 11px; }
    .sp-warn { color: #da3; font-size: 11px; margin-top: 2px; }
    .vp-reason { color: #888; font-size: 11px; margin: 1px 0 3px; }
    .vp-photo {
      display: block; width: 100%; max-width: 280px; border-radius: 6px;
      margin: 0 0 6px;
    }
    .vp-credit {
      display: block; color: #777; font-size: 10px; margin: -3px 0 6px;
      text-decoration: none;
    }
    a.vp-credit:hover { color: #aab; text-decoration: underline; }
  `;
  document.head.appendChild(style);
}

function minutesLabel(tts: number): string {
  if (tts < 45) return 'due';
  return `${Math.round(tts / 60)} min`;
}

function cleanName(name: string): string {
  return name.replace(/ (Underground|Rail|DLR) Station$/, '');
}

function boardRowsHtml(preds: StopPrediction[], colorByLine: ReadonlyMap<string, string>): string {
  const rows = [...preds]
    .sort((a, b) => a.timeToStation - b.timeToStation)
    .slice(0, MAX_DEPARTURES)
    .map((p) => {
      const color = colorByLine.get(p.lineId) ?? '#666';
      const dest = cleanName(p.destinationName ?? p.towards ?? '—');
      // "Eastbound - Platform 2" → "P2"; keep boards compact
      const platform = /Platform (\w+)/.exec(p.platformName ?? '')?.[1];
      const platformTag = platform ? `<span class="sp-plat">P${esc(platform)}</span>` : '';
      return `<div class="sp-row">
        <span class="sp-chip" style="background:${esc(color)}"></span>
        <span class="sp-dest">${esc(dest)}</span>
        ${platformTag}
        <span class="sp-eta">${minutesLabel(p.timeToStation)}</span>
      </div>`;
    });
  return rows.length
    ? rows.join('')
    : '<div class="vp-dim">No departures in the next 30 minutes</div>';
}

// ── enrichment: stop detail, crowding, lift disruptions, bike docks ──

interface TflProperty {
  category?: string;
  key?: string;
  value?: string;
}

interface StopDetailBody {
  additionalProperties?: TflProperty[];
  children?: StopDetailBody[];
}

interface CrowdingBody {
  dataAvailable?: boolean;
  percentageOfBaseline?: number;
}

interface LiftDisruptionEntry {
  stationUniqueId?: string;
  stopPointName?: string;
  message?: string;
}

interface BikePointPlace {
  commonName?: string;
  distance?: number;
  additionalProperties?: TflProperty[];
}

interface BikeDock {
  name: string;
  bikes: number;
  emptyDocks: number;
}

interface Enrichment {
  zone: string | null;
  facilities: string[];
  crowdingPercent: number | null;
  liftMessage: string | null;
  bikeDocks: BikeDock[];
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<unknown>;
}

/** Top-level properties first, then children's, so station-level values win. */
function collectProperties(body: StopDetailBody): TflProperty[] {
  const own = body.additionalProperties ?? [];
  const fromChildren = (body.children ?? []).flatMap((c) => c.additionalProperties ?? []);
  return [...own, ...fromChildren];
}

function extractZone(props: TflProperty[]): string | null {
  // TfL files Zone under category "Geo" (verified live); accept any category.
  const zone = props.find((p) => p.key === 'Zone' && p.value)?.value;
  return zone ? `Zone ${zone}` : null;
}

/** "no" / "0" / "none" mean absent; anything else ("yes", counts) is present. */
function isPresentValue(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized !== '' && normalized !== 'no' && normalized !== '0' && normalized !== 'none';
}

function extractFacilities(props: TflProperty[]): string[] {
  const byKey = new Map<string, string>();
  for (const p of props) {
    if (p.category !== 'Facility' || !p.key || p.value === undefined) continue;
    if (!byKey.has(p.key)) byKey.set(p.key, p.value);
  }
  const labels: string[] = [];
  if (byKey.get('WiFi')?.trim().toLowerCase() === 'yes') labels.push('WiFi');
  if (isPresentValue(byKey.get('Toilets'))) labels.push('Toilets');
  const liftCount = Number.parseInt(byKey.get('Lifts') ?? '', 10);
  if (liftCount > 0) labels.push(`Lifts ×${liftCount}`);
  if (isPresentValue(byKey.get('Car park'))) labels.push('Car park');
  return labels;
}

function parseCrowding(body: unknown): number | null {
  const crowding = body as CrowdingBody;
  if (crowding?.dataAvailable !== true) return null;
  const fraction = crowding.percentageOfBaseline;
  // Verified live: percentageOfBaseline is a 0..~2 fraction of the baseline.
  return typeof fraction === 'number' ? Math.round(fraction * 100) : null;
}

function findLiftDisruption(body: unknown, naptanId: string, stationName: string): string | null {
  if (!Array.isArray(body)) return null;
  const lowerName = stationName.trim().toLowerCase();
  const matches = (entry: LiftDisruptionEntry): boolean => {
    const uid = entry.stationUniqueId ?? '';
    if (uid && (uid === naptanId || naptanId.startsWith(uid) || uid.startsWith(naptanId))) {
      return true;
    }
    if (entry.stopPointName?.toLowerCase().includes(lowerName)) return true;
    // Messages open with the station name, e.g. "WEMBLEY PARK STATION: ..."
    return Boolean(lowerName) && (entry.message ?? '').slice(0, 60).toLowerCase().includes(lowerName);
  };
  const hit = (body as LiftDisruptionEntry[]).find((entry) => entry.message && matches(entry));
  return hit?.message ? truncate(hit.message, LIFT_MESSAGE_MAX_CHARS) : null;
}

function numericProperty(props: TflProperty[], key: string): number | null {
  const value = Number.parseInt(props.find((p) => p.key === key)?.value ?? '', 10);
  return Number.isFinite(value) ? value : null;
}

function parseBikeDocks(body: unknown): BikeDock[] {
  const places = (body as { places?: BikePointPlace[] })?.places;
  if (!Array.isArray(places)) return [];
  return [...places]
    .sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity))
    .slice(0, MAX_BIKE_DOCKS)
    .flatMap((place) => {
      const props = place.additionalProperties ?? [];
      const bikes = numericProperty(props, 'NbBikes');
      const emptyDocks = numericProperty(props, 'NbEmptyDocks');
      if (!place.commonName || bikes === null || emptyDocks === null) return [];
      return [{ name: place.commonName.replace(/\s+,\s*/g, ', ').trim(), bikes, emptyDocks }];
    });
}

async function fetchEnrichment(
  naptanId: string,
  stationName: string,
  lngLat: LngLat,
): Promise<Enrichment> {
  const [detail, crowding, lifts, bikes] = await Promise.allSettled([
    fetchJson(`/api/stop-detail?id=${encodeURIComponent(naptanId)}`),
    fetchJson(`/api/crowding?id=${encodeURIComponent(naptanId)}`),
    fetchJson('/api/lift-disruptions'),
    fetchJson(`/api/bike-points?lat=${lngLat.lat.toFixed(5)}&lon=${lngLat.lng.toFixed(5)}`),
  ]);
  const props =
    detail.status === 'fulfilled' ? collectProperties(detail.value as StopDetailBody) : [];
  return {
    zone: extractZone(props),
    facilities: extractFacilities(props),
    crowdingPercent: crowding.status === 'fulfilled' ? parseCrowding(crowding.value) : null,
    liftMessage:
      lifts.status === 'fulfilled' ? findLiftDisruption(lifts.value, naptanId, stationName) : null,
    bikeDocks: bikes.status === 'fulfilled' ? parseBikeDocks(bikes.value) : [],
  };
}

function footerHtml(enrichment: Enrichment): string {
  const parts: string[] = [];
  const tags = [
    ...(enrichment.zone ? [enrichment.zone] : []),
    ...enrichment.facilities,
  ].map((label) => `<span class="sp-tag">${esc(label)}</span>`);
  if (tags.length) parts.push(`<div class="sp-tags">${tags.join('')}</div>`);
  if (enrichment.crowdingPercent !== null) {
    parts.push(`<div class="sp-fact">Crowding: ${enrichment.crowdingPercent}% of typical</div>`);
  }
  if (enrichment.liftMessage) {
    parts.push(`<div class="sp-warn">⚠ Lift: ${esc(enrichment.liftMessage)}</div>`);
  }
  for (const dock of enrichment.bikeDocks) {
    parts.push(
      `<div class="sp-fact">🚲 ${esc(dock.name)}: ${dock.bikes} bikes / ${dock.emptyDocks} docks</div>`,
    );
  }
  return parts.length ? `<div class="sp-footer">${parts.join('')}</div>` : '';
}

const VEHICLES_LAYER_ID = 'trains-dots';

export function setupStationPopups(
  map: MaplibreMap,
  colorByLine: ReadonlyMap<string, string>,
  onOpen?: () => void,
): void {
  injectPopupStyles();
  const popup = new Popup({ closeButton: true, closeOnClick: true, offset: 10, maxWidth: '300px' });
  enablePopupDragToPan(map, popup);
  let clickSeq = 0;

  map.on('click', STATIONS_LAYER_ID, (e: MapLayerMouseEvent) => {
    // A vehicle sitting on the station owns the click — its popup handles it.
    if (map.queryRenderedFeatures(e.point, { layers: [VEHICLES_LAYER_ID] }).length > 0) return;
    const feature = e.features?.[0];
    if (!feature) return;
    onOpen?.();
    const props = feature.properties as { id?: string; name?: string };
    const naptanId = props.id;
    const name = props.name ?? 'Station';
    if (!naptanId) return;

    const seq = ++clickSeq;
    let boardBody = '<div class="vp-dim">Loading departures…</div>';
    let footer = '';
    const wrap = (): string =>
      `<div class="vp"><div class="sp-title">${esc(name)}</div>${boardBody}${footer}</div>`;
    const render = (): void => {
      if (popup.isOpen() && seq === clickSeq) popup.setHTML(wrap());
    };

    popup.setLngLat(e.lngLat).setHTML(wrap()).addTo(map);

    // Departures board first — it should stay fast.
    void (async () => {
      try {
        const preds = await fetchJson(`/api/stop-arrivals?id=${encodeURIComponent(naptanId)}`);
        boardBody = boardRowsHtml(Array.isArray(preds) ? (preds as StopPrediction[]) : [], colorByLine);
      } catch {
        boardBody = '<div class="vp-dim">Departures unavailable</div>';
      }
      render();
    })();

    // Enrichment in parallel; appended as a footer when it resolves.
    void fetchEnrichment(naptanId, name, e.lngLat).then((enrichment) => {
      footer = footerHtml(enrichment);
      if (footer) render();
    });
  });
}
