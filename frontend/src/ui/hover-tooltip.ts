// Lightweight hover tooltips for vehicles and stations. Hovering shows a quick
// one-liner; clicking (handled elsewhere) opens the detailed card.

import { Popup, type Map as MaplibreMap, type MapLayerMouseEvent } from 'maplibre-gl';

const VEHICLES_LAYER_ID = 'trains-dots';
const STATIONS_LAYER_ID = 'stations-circle';
const LINES_LAYER_ID = 'transit-lines-line';

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);

interface VehicleHoverProps {
  key: string;
  lineName: string;
  color: string;
  destination: string;
  nextStop: string;
  timeToStation: number;
  receivedAt: number;
}

interface StationHoverProps {
  name: string;
  lineIds: string;
}

function countdown(tts: number, receivedAt: number): string {
  const elapsed = receivedAt ? (Date.now() - receivedAt) / 1000 : 0;
  const remaining = Math.max(0, Math.round(tts - elapsed));
  if (remaining <= 15) return 'due';
  if (remaining < 60) return `${remaining}s`;
  return `${Math.floor(remaining / 60)}m`;
}

function cleanName(name: string): string {
  return name.replace(/ (Underground|Rail|DLR) Station$/, '');
}

function vehicleTipHtml(p: VehicleHoverProps): string {
  return `<div class="vp">
    <span class="vp-line" style="background:${esc(p.color)}">${esc(p.lineName)}</span>
    <span class="tip-dest">→ ${esc(cleanName(p.destination) || '—')}</span>
    <div class="vp-dim">${esc(p.nextStop)} · ${countdown(p.timeToStation, p.receivedAt)} · click for details</div>
  </div>`;
}

function stationTipHtml(p: StationHoverProps, colorByLine: ReadonlyMap<string, string>): string {
  const chips = p.lineIds
    .split(',')
    .filter(Boolean)
    .map(
      (id) =>
        `<span class="sp-chip" style="background:${esc(colorByLine.get(id) ?? '#666')}"></span>`,
    )
    .join('');
  return `<div class="vp">
    <b>${esc(p.name)}</b> <span class="tip-chips">${chips}</span>
    <div class="vp-dim">click for live departures</div>
  </div>`;
}

function linesTipHtml(
  lineIds: readonly string[],
  colorByLine: ReadonlyMap<string, string>,
  nameByLine: ReadonlyMap<string, string>,
): string {
  const rows = lineIds
    .map(
      (id) =>
        `<div class="sp-row"><span class="sp-chip" style="background:${esc(
          colorByLine.get(id) ?? '#666',
        )}"></span><span>${esc(nameByLine.get(id) ?? id)}</span></div>`,
    )
    .join('');
  return `<div class="vp">${rows}</div>`;
}

export function setupHoverTooltips(
  map: MaplibreMap,
  colorByLine: ReadonlyMap<string, string>,
  nameByLine: ReadonlyMap<string, string>,
  isVehicleSelected: (key: string) => boolean,
): void {
  const tip = new Popup({
    closeButton: false,
    closeOnClick: false,
    offset: 12,
    maxWidth: '260px',
    className: 'hover-tip',
  });
  let shownFor: string | null = null;

  const hide = (): void => {
    tip.remove();
    shownFor = null;
  };

  map.on('mousemove', VEHICLES_LAYER_ID, (e: MapLayerMouseEvent) => {
    const props = e.features?.[0]?.properties as VehicleHoverProps | undefined;
    if (!props) return;
    map.getCanvas().style.cursor = 'pointer';
    if (isVehicleSelected(props.key)) {
      hide(); // its detail card is already following it
      return;
    }
    tip.setLngLat(e.lngLat);
    const id = `v:${props.key}`;
    if (shownFor !== id) {
      shownFor = id;
      tip.setHTML(vehicleTipHtml(props));
    }
    if (!tip.isOpen()) tip.addTo(map);
  });
  map.on('mouseleave', VEHICLES_LAYER_ID, () => {
    map.getCanvas().style.cursor = '';
    hide();
  });

  map.on('mousemove', STATIONS_LAYER_ID, (e: MapLayerMouseEvent) => {
    // vehicles drawn on top own the hover when overlapping
    if (map.queryRenderedFeatures(e.point, { layers: [VEHICLES_LAYER_ID] }).length > 0) return;
    const props = e.features?.[0]?.properties as StationHoverProps | undefined;
    if (!props) return;
    map.getCanvas().style.cursor = 'pointer';
    tip.setLngLat(e.lngLat);
    const id = `s:${props.name}`;
    if (shownFor !== id) {
      shownFor = id;
      tip.setHTML(stationTipHtml(props, colorByLine));
    }
    if (!tip.isOpen()) tip.addTo(map);
  });
  map.on('mouseleave', STATIONS_LAYER_ID, () => {
    map.getCanvas().style.cursor = '';
    hide();
  });

  map.on('mousemove', LINES_LAYER_ID, (e: MapLayerMouseEvent) => {
    // vehicles and stations own the hover when overlapping the line
    const busy = map.queryRenderedFeatures(e.point, {
      layers: [VEHICLES_LAYER_ID, STATIONS_LAYER_ID],
    });
    if (busy.length > 0) return;
    // shared corridors: list every line under the cursor, not just the top one
    const lineIds = [
      ...new Set(
        map
          .queryRenderedFeatures(e.point, { layers: [LINES_LAYER_ID] })
          .map((f) => f.properties?.lineId as string)
          .filter(Boolean),
      ),
    ].sort();
    if (lineIds.length === 0) return;
    map.getCanvas().style.cursor = 'pointer';
    tip.setLngLat(e.lngLat);
    const id = `l:${lineIds.join(',')}`;
    if (shownFor !== id) {
      shownFor = id;
      tip.setHTML(linesTipHtml(lineIds, colorByLine, nameByLine));
    }
    if (!tip.isOpen()) tip.addTo(map);
  });
  map.on('mouseleave', LINES_LAYER_ID, () => {
    map.getCanvas().style.cursor = '';
    hide();
  });

  // any click transitions from hover-preview to a detail card — drop the tip
  map.on('click', hide);
}
