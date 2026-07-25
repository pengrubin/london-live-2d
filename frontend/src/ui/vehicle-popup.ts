// Click-to-inspect detail card for vehicles: follows the moving marker, ticks
// its countdown, and enriches with the vehicle's onward calling pattern
// (TfL /Vehicle/{id}/Arrivals) plus the line's service status.

import { Popup, type Map as MaplibreMap } from 'maplibre-gl';
import type { DisplayedTrain } from '../realtime/interpolator';
import { injectPopupStyles, truncate } from './station-popup';
import { enablePopupDragToPan } from './popup-drag';
import { fetchRank, rankLineText } from './rank-line';
import { dimensionsLine, fetchShipPhoto, flagLine } from './ship-info';
import { stockPhotoUrl } from './stock-photos';

const CONTENT_REFRESH_MS = 1000;
const MAX_CALLING_STOPS = 5;
const GOOD_SERVICE = 'Good Service';
const STATUS_REASON_MAX_CHARS = 140;

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);

interface CallingStop {
  name: string;
  timeToStation: number;
}

interface VehicleDetail {
  receivedAt: number;
  callingPattern: CallingStop[];
  lineStatus: string | null; // non-null only when service is disrupted
  lineStatusReasons: string[]; // deduped human-readable disruption reasons
  vessel: MatchedVessel | null; // boats only: nearest live AIS ship
  /** blob URL for the matched vessel's photo, resolved after the detail */
  vesselPhotoUrl: string | null;
  /** today's leaderboard standing line, e.g. "Top 3 / 681 · 6.4 km today" */
  rankLine: string | null;
}

interface MatchedVessel {
  name: string;
  sogKnots: number | null;
  mmsi: number;
  lengthM: number | null;
  widthM: number | null;
  draughtM: number | null;
  flag: string | null;
}

interface AisVessel {
  mmsi: number;
  name: string;
  lat: number;
  lon: number;
  sog: number | null;
  lengthM?: number | null;
  widthM?: number | null;
  draughtM?: number | null;
  flag?: string | null;
}

/** A TfL boat and an AIS ship within this range are the same physical vessel. */
const VESSEL_MATCH_M = 500;
const M_PER_DEG_LAT = 110540;
const M_PER_DEG_LON = 111320 * Math.cos((51.5 * Math.PI) / 180);

function nearestVessel(vessels: AisVessel[], lngLat: readonly [number, number]): MatchedVessel | null {
  let best: { vessel: AisVessel; d: number } | null = null;
  for (const v of vessels) {
    if (!v.name) continue;
    const dx = (v.lon - lngLat[0]) * M_PER_DEG_LON;
    const dy = (v.lat - lngLat[1]) * M_PER_DEG_LAT;
    const d = Math.hypot(dx, dy);
    if (d <= VESSEL_MATCH_M && (!best || d < best.d)) best = { vessel: v, d };
  }
  if (!best) return null;
  const v = best.vessel;
  return {
    name: v.name,
    sogKnots: v.sog,
    mmsi: v.mmsi,
    lengthM: v.lengthM ?? null,
    widthM: v.widthM ?? null,
    draughtM: v.draughtM ?? null,
    flag: v.flag ?? null,
  };
}

interface VehicleArrivalPrediction {
  stationName?: string;
  timeToStation?: number;
  lineId?: string;
}

interface LineStatusEntry {
  id?: string;
  lineStatuses?: { statusSeverityDescription?: string; reason?: string }[];
}

function remainingSeconds(tts: number, receivedAt: number | undefined): number {
  const elapsed = receivedAt ? (Date.now() - receivedAt) / 1000 : 0;
  return Math.max(0, Math.round(tts - elapsed));
}

function countdownLabel(tts: number, receivedAt: number | undefined): string {
  const remaining = remainingSeconds(tts, receivedAt);
  if (remaining <= 15) return 'due';
  if (remaining < 60) return `${remaining}s`;
  return `${Math.floor(remaining / 60)}m ${remaining % 60}s`;
}

function cleanName(name: string): string {
  return name.replace(/ (Underground|Rail|DLR) Station$/, '') || '—';
}

async function fetchDetail(
  train: DisplayedTrain['train'],
  lngLat: readonly [number, number],
): Promise<VehicleDetail> {
  const receivedAt = Date.now();
  const detail: VehicleDetail = {
    receivedAt,
    callingPattern: [],
    lineStatus: null,
    lineStatusReasons: [],
    vessel: null,
    vesselPhotoUrl: null,
    rankLine: null,
  };
  const isBoat = train.lineId.startsWith('rb') || train.lineId === 'woolwich-ferry';
  // Leaderboard entry id: river boats rank as ships, everything else as trains.
  const rankPromise = train.vehicleId
    ? fetchRank(
        isBoat ? 'ship' : 'train',
        `${isBoat ? 'ship:tfl' : 'tube'}:${train.lineId}:${train.vehicleId}`,
      )
    : Promise.resolve(null);

  const [vehicleRes, statusRes, vesselsRes, rankRes] = await Promise.allSettled([
    train.vehicleId
      ? fetch(`/api/vehicle-arrivals?id=${encodeURIComponent(train.vehicleId)}`)
      : Promise.reject(new Error('no vehicleId')),
    fetch(`/api/line-status?lines=${encodeURIComponent(train.lineId)}`),
    isBoat ? fetch('/api/vessels') : Promise.reject(new Error('not a boat')),
    rankPromise,
  ]);

  if (rankRes.status === 'fulfilled' && rankRes.value) {
    detail.rankLine = rankLineText(rankRes.value);
  }

  if (vesselsRes.status === 'fulfilled' && vesselsRes.value.ok) {
    const vessels = (await vesselsRes.value.json()) as AisVessel[];
    if (Array.isArray(vessels)) detail.vessel = nearestVessel(vessels, lngLat);
  }

  if (vehicleRes.status === 'fulfilled' && vehicleRes.value.ok) {
    const preds = (await vehicleRes.value.json()) as VehicleArrivalPrediction[];
    if (Array.isArray(preds)) {
      // deep-tube 3-digit ids are recycled across lines — keep this line only
      const byStation = new Map<string, number>();
      for (const p of preds) {
        if (p.lineId && p.lineId !== train.lineId) continue;
        if (!p.stationName || typeof p.timeToStation !== 'number') continue;
        const cur = byStation.get(p.stationName);
        if (cur === undefined || p.timeToStation < cur) byStation.set(p.stationName, p.timeToStation);
      }
      detail.callingPattern = [...byStation.entries()]
        .map(([name, timeToStation]) => ({ name, timeToStation }))
        .sort((a, b) => a.timeToStation - b.timeToStation)
        .slice(0, MAX_CALLING_STOPS);
    }
  }

  if (statusRes.status === 'fulfilled' && statusRes.value.ok) {
    const entries = (await statusRes.value.json()) as LineStatusEntry[];
    if (Array.isArray(entries)) {
      const statuses = entries[0]?.lineStatuses ?? [];
      const descriptions = statuses
        .map((s) => s.statusSeverityDescription)
        .filter((s): s is string => Boolean(s));
      const disrupted = descriptions.filter((s) => s !== GOOD_SERVICE);
      detail.lineStatus = disrupted.length > 0 ? [...new Set(disrupted)].join(', ') : null;
      const reasons = statuses
        .map((s) => s.reason?.trim())
        .filter((r): r is string => Boolean(r));
      detail.lineStatusReasons = [...new Set(reasons)];
    }
  }

  return detail;
}

function popupHtml(d: DisplayedTrain, color: string, detail: VehicleDetail | null): string {
  const t = d.train;
  const isBoat = t.lineId.startsWith('rb') || t.lineId === 'woolwich-ferry';
  // Trains get their line's bundled rolling-stock photo; boats keep the live
  // VesselFinder photo flow further down.
  const stockPhoto = isBoat ? null : stockPhotoUrl(t.lineId);
  const parts: string[] = [
    ...(stockPhoto ? [`<img class="vp-photo" src="${esc(stockPhoto)}" alt="">`] : []),
    `<div class="vp-line" style="background:${esc(color)}">${esc(t.lineName)}</div>`,
    `<div class="vp-dest">→ ${esc(cleanName(t.destination))}</div>`,
    `<div>Next: <b>${esc(t.nextStopName)}</b> · ${countdownLabel(t.timeToStation, t.receivedAt)}</div>`,
  ];
  if (t.currentLocation) parts.push(`<div class="vp-dim">${esc(t.currentLocation)}</div>`);
  if (t.platformName && !/^\d+$/.test(t.platformName)) {
    parts.push(`<div class="vp-dim">${esc(t.platformName)}</div>`);
  }
  const meta: string[] = [];
  if (t.vehicleId) meta.push(`${isBoat ? 'Vessel' : 'Train'} #${esc(t.vehicleId)}`);
  if (t.direction) meta.push(esc(t.direction));
  if (meta.length) parts.push(`<div class="vp-dim">${meta.join(' · ')}</div>`);
  if (detail?.rankLine) parts.push(`<div class="vp-dim">${esc(detail.rankLine)}</div>`);

  if (detail?.vessel) {
    const v = detail.vessel;
    const speed = v.sogKnots !== null ? ` · ${v.sogKnots.toFixed(1)} kn` : '';
    parts.push(
      `<div class="vp-vessel">⚓ <b>${esc(v.name)}</b>${speed}</div>` +
        `<div class="vp-dim">MMSI ${v.mmsi}</div>`,
    );
    if (detail.vesselPhotoUrl) {
      parts.push(`<img class="vp-photo" src="${esc(detail.vesselPhotoUrl)}" alt="">`);
    }
    const dims = dimensionsLine(v.lengthM, v.widthM, v.draughtM);
    if (dims) parts.push(`<div class="vp-dim">${esc(dims)}</div>`);
    const flag = flagLine(v.flag);
    if (flag) parts.push(`<div class="vp-dim">${esc(flag)}</div>`);
  }

  if (detail?.lineStatus) {
    parts.push(`<div class="vp-status">⚠ ${esc(detail.lineStatus)}</div>`);
    for (const reason of detail.lineStatusReasons) {
      parts.push(`<div class="vp-reason">${esc(truncate(reason, STATUS_REASON_MAX_CHARS))}</div>`);
    }
  }
  if (detail && detail.callingPattern.length > 1) {
    const rows = detail.callingPattern
      .map(
        (s) => `<div class="sp-row">
          <span class="sp-dest">${esc(cleanName(s.name))}</span>
          <span class="sp-eta">${countdownLabel(s.timeToStation, detail.receivedAt)}</span>
        </div>`,
      )
      .join('');
    parts.push(`<div class="vp-section">Calling at</div>${rows}`);
  } else if (detail === null && t.vehicleId) {
    parts.push('<div class="vp-dim">Loading journey…</div>');
  }
  return `<div class="vp">${parts.join('')}</div>`;
}

export class VehiclePopup {
  private popup: Popup | null = null;
  private selectedKey: string | null = null;
  private lastContentAt = 0;
  private detail: VehicleDetail | null = null;
  private detailRequestedFor: string | null = null;
  private readonly map: MaplibreMap;
  private readonly colorByLine: ReadonlyMap<string, string>;

  constructor(map: MaplibreMap, colorByLine: ReadonlyMap<string, string>) {
    this.map = map;
    this.colorByLine = colorByLine;
    injectPopupStyles(); // .vp-reason lives in the shared injected style tag
  }

  get selected(): string | null {
    return this.selectedKey;
  }

  close(): void {
    this.popup?.remove();
    this.selectedKey = null;
  }

  select(key: string): void {
    this.selectedKey = key;
    this.lastContentAt = 0;
    this.detail = null;
    this.detailRequestedFor = null;
    if (!this.popup) {
      this.popup = new Popup({
        closeButton: true,
        closeOnClick: false,
        offset: 14,
        maxWidth: '300px',
      });
      this.popup.on('close', () => {
        this.selectedKey = null;
      });
      enablePopupDragToPan(this.map, this.popup);
    }
  }

  /** Call once per rendered frame with the currently displayed vehicles. */
  sync(displayed: readonly DisplayedTrain[]): void {
    if (!this.selectedKey || !this.popup) return;
    const d = displayed.find((x) => x.train.key === this.selectedKey);
    if (!d) {
      this.popup.remove();
      this.selectedKey = null;
      return;
    }
    if (this.detailRequestedFor !== this.selectedKey) {
      this.detailRequestedFor = this.selectedKey;
      const forKey = this.selectedKey;
      void fetchDetail(d.train, d.lngLat).then((detail) => {
        if (this.selectedKey !== forKey) return;
        this.detail = detail;
        this.lastContentAt = 0; // re-render with the enriched content
        if (!detail.vessel) return;
        void fetchShipPhoto(detail.vessel.mmsi).then((url) => {
          if (!url || this.selectedKey !== forKey || this.detail !== detail) return;
          this.detail = { ...detail, vesselPhotoUrl: url };
          this.lastContentAt = 0; // re-render with the photo
        });
      });
    }
    if (!this.popup.isOpen()) this.popup.addTo(this.map);
    this.popup.setLngLat(d.lngLat);
    const now = Date.now();
    if (now - this.lastContentAt >= CONTENT_REFRESH_MS) {
      this.lastContentAt = now;
      const color = this.colorByLine.get(d.train.lineId) ?? '#666';
      this.popup.setHTML(popupHtml(d, color, this.detail));
    }
  }
}
