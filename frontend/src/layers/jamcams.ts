// TfL JamCams: ~880 traffic cameras. Dots appear on zoom-in; clicking shows
// the live still, refreshed every 10 s while the popup stays open.

import { Popup, type Map as MaplibreMap, type MapLayerMouseEvent } from 'maplibre-gl';
import { below } from '../util/layer-order';

export const JAMCAMS_LAYER_ID = 'jamcams-dots';
const SOURCE_ID = 'jamcams';
const MIN_ZOOM = 11.5;
/** clips are ~10 s; re-fetch a fresh one when the loop would go stale */
const VIDEO_REFRESH_MS = 60_000;

interface TflPlace {
  id?: string;
  commonName?: string;
  lat?: number;
  lon?: number;
  additionalProperties?: { key?: string; value?: string }[];
}

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);

export async function addJamCams(map: MaplibreMap): Promise<void> {
  const res = await fetch('/api/jamcams');
  if (!res.ok) return;
  const places = (await res.json()) as TflPlace[];
  if (!Array.isArray(places)) return;

  const features = places.flatMap((p) => {
    const props = new Map((p.additionalProperties ?? []).map((a) => [a.key, a.value]));
    const imageUrl = props.get('imageUrl');
    if (!imageUrl || props.get('available') === 'false') return [];
    if (typeof p.lat !== 'number' || typeof p.lon !== 'number') return [];
    return [
      {
        type: 'Feature' as const,
        properties: {
          name: (p.commonName ?? 'Camera').replace(/^JamCams?[_ ]?/i, ''),
          imageUrl,
        },
        geometry: { type: 'Point' as const, coordinates: [p.lon, p.lat] },
      },
    ];
  });

  map.addSource(SOURCE_ID, {
    type: 'geojson',
    data: { type: 'FeatureCollection', features },
  });
  map.addLayer(
    {
      id: JAMCAMS_LAYER_ID,
      type: 'circle',
      source: SOURCE_ID,
      minzoom: MIN_ZOOM,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], MIN_ZOOM, 2, 15, 4.5],
        'circle-color': '#c98f2a',
        'circle-stroke-color': '#0a0a0a',
        'circle-stroke-width': 1,
        'circle-opacity': 0.85,
      },
    },
    below(map, 'stations-circle'), // cameras sit beneath station dots and vehicles
  );

  const tip = new Popup({ closeButton: false, closeOnClick: false, offset: 10, className: 'hover-tip' });
  map.on('mousemove', JAMCAMS_LAYER_ID, (e: MapLayerMouseEvent) => {
    const p = e.features?.[0]?.properties as { name?: string } | undefined;
    if (!p) return;
    map.getCanvas().style.cursor = 'pointer';
    tip
      .setLngLat(e.lngLat)
      .setHTML(`<div class="vp">📷 ${esc(p.name ?? 'Camera')}<div class="vp-dim">click for live view</div></div>`)
      .addTo(map);
  });
  map.on('mouseleave', JAMCAMS_LAYER_ID, () => {
    map.getCanvas().style.cursor = '';
    tip.remove();
  });

  const viewer = new Popup({ closeButton: true, closeOnClick: true, offset: 12, maxWidth: '520px' });
  let refreshTimer: number | undefined;
  viewer.on('close', () => {
    if (refreshTimer !== undefined) clearInterval(refreshTimer);
    refreshTimer = undefined;
  });
  map.on('click', JAMCAMS_LAYER_ID, (e: MapLayerMouseEvent) => {
    const p = e.features?.[0]?.properties as { name?: string; imageUrl?: string } | undefined;
    if (!p?.imageUrl) return;
    tip.remove();
    const name = p.name ?? 'Camera';
    // TfL also publishes a ~10 s video clip alongside each still (same key,
    // .mp4) — motion reads far better than the 352×288 still ever can.
    const videoUrl = (p.imageUrl ?? '').replace(/\.jpg$/i, '.mp4');
    const media = (): string =>
      videoUrl !== p.imageUrl
        ? `<video src="${esc(videoUrl)}?t=${Date.now()}" width="480" autoplay muted loop playsinline
             style="border-radius:4px;display:block;background:#000"
             onerror="this.outerHTML='<img src=&quot;${esc(p.imageUrl ?? '')}?t=${Date.now()}&quot; width=&quot;480&quot; style=&quot;border-radius:4px;display:block&quot;/>'"></video>`
        : `<img src="${esc(p.imageUrl ?? '')}?t=${Date.now()}" width="480" style="border-radius:4px;display:block" alt="${esc(name)}"/>`;
    const render = (): string =>
      `<div class="vp"><div class="sp-title">📷 ${esc(name)}</div>
      ${media()}
      <div class="vp-dim">TfL refreshes each clip ~every 5 min · source is 352×288</div></div>`;
    viewer.setLngLat(e.lngLat).setHTML(render()).addTo(map);
    if (refreshTimer !== undefined) clearInterval(refreshTimer);
    refreshTimer = window.setInterval(() => {
      if (viewer.isOpen()) viewer.setHTML(render());
    }, VIDEO_REFRESH_MS);
  });
}
