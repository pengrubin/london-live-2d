// All-London live buses (BODS SIRI-VM via /api/buses, ~8-9k vehicles).
// Two-tier rendering keeps the main thread calm at fleet scale:
//   • below zoom 12.5 — circle layer, ALL buses as small red dots, rebuilt at
//     1 Hz from the shared per-bus tracker (displayed positions), no per-frame work;
//   • at/above 12.5 — symbol layer with oriented bus bullets, rebuilt per frame
//     ONLY from the viewport subset (+20 % margin).
// Motion model: a per-bus tracker (kept across polls) derives a velocity vector
// from the last two distinct fixes, extrapolates the newest fix forward (capped
// at 45 s), and eases the displayed position toward that target with an
// exponential approach (tau ≈ 2.5 s). BODS fixes are often already 10–30 s old
// on arrival, so extrapolating from RecordedAtTime with a real velocity — not a
// short capped drift — is what keeps buses visibly moving between 15 s polls.
// Route snapping: learned route polylines (backend learner, keyed by
// operator:line:direction) are lazy-loaded from /api/bus-routes-index +
// /bus-routes/learned/<key>.json. A bus with a learned route renders at its
// projection onto the polyline while the raw eased position stays within
// SNAP_ON_M (released past SNAP_OFF_M — hysteresis, per-bus state), and its
// icon follows the polyline tangent. The raw motion model is untouched —
// snapping is a pure display transform; buses without routes render as before.

import {
  Popup,
  type GeoJSONSource,
  type Map as MaplibreMap,
  type MapLayerMouseEvent,
} from 'maplibre-gl';
import { isLayerShown, makeRenderGate, SYMBOL_TIER_INTERVAL_MS } from '../util/render-gate';

export const BUSES_DOTS_LAYER_ID = 'buses-dots';
export const BUSES_ICONS_LAYER_ID = 'buses-icons';
const DOTS_SOURCE_ID = 'buses-dots-src';
const ICONS_SOURCE_ID = 'buses-icons-src';
const POLL_INTERVAL_MS = 15_000;
/** Zoom at which dots hand over to oriented bullets. */
const TIER_SPLIT_ZOOM = 12.5;
const TFL_BUS_RED = '#DA2C43';
/** Fallback dead-reckoning speed along reported Bearing, m/s. */
const FALLBACK_SPEED_MS = 8;
/** Two fixes closer than this can't give a trustworthy velocity. */
const VELOCITY_MIN_DT_S = 3;
/** Two fixes further apart than this are too stale to give a velocity. */
const VELOCITY_MAX_DT_S = 120;
/** Implied speeds above this are GPS glitches — fall back to Bearing. */
const MAX_IMPLIED_SPEED_MS = 20;
/** Never extrapolate a track-derived velocity further than this. */
const MAX_EXTRAPOLATION_S = 45;
/** Bearing-fallback velocity is low confidence — extrapolate it less. */
const MAX_FALLBACK_EXTRAPOLATION_S = 20;
/** Exponential-approach time constant for displayed positions, seconds. */
const EASE_TAU_S = 2.5;
/** Displayed position snaps (no easing) when this far from its target. */
const SNAP_DISTANCE_M = 400;
/** Easing never closes a gap faster than this, m/s (keeps catch-up glides sane). */
const MAX_CATCHUP_SPEED_MS = 120;
/** Displayed movement needed before icon rotation follows actual motion. */
const ROTATE_MIN_MOVE_M = 2;
/** Trackers unseen in polls for this long are pruned. */
const TRACKER_TTL_MS = 5 * 60_000;
/** Circle-tier (low zoom) refresh cadence. */
const DOTS_REFRESH_MS = 1_000;
/** Viewport margin for the symbol tier, as a fraction of the view span. */
const VIEW_MARGIN = 0.2;
const M_PER_DEG_LAT = 110540;
const M_PER_DEG_LON = 111320 * Math.cos((51.5 * Math.PI) / 180);
/** Snap the displayed position to a learned route when this close… */
const SNAP_ON_M = 50;
/** …and release again only once the raw position drifts this far. */
const SNAP_OFF_M = 80;
/** Segments each side of the last hit searched per frame (with periodic full scans). */
const SNAP_LOCAL_WINDOW = 30;
/** Full-polyline re-search at least this often per bus. */
const SNAP_FULL_SEARCH_MS = 3_000;

/** Wire row from /api/buses (short keys — see backend bods-client). */
interface BusWire {
  i: string; // operator-qualified vehicle id
  l: string; // line
  o: string; // operator
  r: string; // normalized direction ("outbound" | "inbound" | …)
  d: string; // destination
  x: number; // lon
  y: number; // lat
  b: number | null; // bearing, degrees
  t: number; // recordedAt epoch ms
}

/** Learned route geometry in local meter space (fast projection math). */
interface LearnedRoute {
  xs: Float64Array;
  ys: Float64Array;
}

interface RouteProjection {
  seg: number;
  dist: number;
  x: number; // meters
  y: number; // meters
  bearing: number; // polyline tangent, degrees clockwise from north
}

interface Fix {
  x: number; // lon
  y: number; // lat
  t: number; // recordedAt epoch ms
}

/** Per-bus motion state, kept across polls. */
interface BusTracker {
  prevFix: Fix;
  lastFix: Fix;
  /** Displayed (eased) position. */
  disp: { x: number; y: number };
  /** Wall time of the last disp advance, ms. */
  dispT: number;
  /** Estimated velocity, degrees/second. */
  velLon: number;
  velLat: number;
  /** Icon rotation actually shown, degrees. */
  bearingDisp: number;
  /** Where disp was when bearingDisp last updated — rotation reference. */
  rotRef: { x: number; y: number };
  /** True when velocity came from the fix pair (not the Bearing fallback). */
  hasTrackVelocity: boolean;
  /** Wall time this bus last appeared in a poll, ms. */
  lastSeen: number;
  line: string;
  operator: string;
  dest: string;
  bearing: number | null;
  /** Sanitized operator:line:direction — addresses a learned route file. */
  routeFileKey: string;
  /** Attached learned route, once the index + geometry have loaded. */
  route: LearnedRoute | null;
  /** Snap hysteresis state (display-only — the motion model never sees it). */
  snapped: boolean;
  /** Last matched segment — local-window search hint. */
  snapSeg: number;
  /** Wall time of the last full-polyline search, ms. */
  snapFullT: number;
  /** Snapped display position (degrees) and bearing; valid while `snapped`. */
  snapX: number;
  snapY: number;
  snapBearing: number;
}

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);

/** Must match the backend learner: route key → served file basename. */
const sanitizeKey = (key: string): string => key.replace(/[^A-Za-z0-9_.-]/g, '_');

/** Sanitized keys with a learned route on the server; null until loaded. */
let routeIndex: Set<string> | null = null;
/** fileKey → geometry, or a load-state marker. */
const routeCache = new Map<string, LearnedRoute | 'pending' | 'absent'>();
/** Cache cap — oldest settled entry evicted first (trackers keep their own ref). */
const ROUTE_CACHE_MAX = 600;

async function loadRouteIndex(): Promise<void> {
  try {
    const res = await fetch('/api/bus-routes-index');
    if (!res.ok) return;
    const list: unknown = await res.json();
    if (!Array.isArray(list)) return;
    routeIndex = new Set(list.filter((k): k is string => typeof k === 'string'));
  } catch {
    // no learner output yet — every bus simply renders unsnapped
  }
}

/** Lazy-load one learned route (dev: Vite publicDir; prod: backend route). */
function requestRoute(fileKey: string): void {
  if (routeCache.has(fileKey)) return;
  if (routeCache.size >= ROUTE_CACHE_MAX) {
    for (const [key, value] of routeCache) {
      if (value !== 'pending') {
        routeCache.delete(key);
        break;
      }
    }
  }
  routeCache.set(fileKey, 'pending');
  void (async () => {
    try {
      const res = await fetch(`/bus-routes/learned/${fileKey}.json`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { poly?: [number, number][] };
      const poly = body.poly;
      if (!Array.isArray(poly) || poly.length < 2) throw new Error('bad poly');
      const xs = new Float64Array(poly.length);
      const ys = new Float64Array(poly.length);
      for (let i = 0; i < poly.length; i += 1) {
        xs[i] = poly[i][0] * M_PER_DEG_LON;
        ys[i] = poly[i][1] * M_PER_DEG_LAT;
      }
      routeCache.set(fileKey, { xs, ys });
    } catch {
      routeCache.set(fileKey, 'absent');
    }
  })();
}

/** Nearest point on route segments [from,to) to (px,py), meter space. */
function projectRange(
  route: LearnedRoute,
  px: number,
  py: number,
  from: number,
  to: number,
): RouteProjection | null {
  const { xs, ys } = route;
  const lo = Math.max(0, from);
  const hi = Math.min(xs.length - 1, to);
  let best: RouteProjection | null = null;
  for (let i = lo; i < hi; i += 1) {
    const ax = xs[i];
    const ay = ys[i];
    const vx = xs[i + 1] - ax;
    const vy = ys[i + 1] - ay;
    const len2 = vx * vx + vy * vy;
    const u = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((px - ax) * vx + (py - ay) * vy) / len2));
    const qx = ax + vx * u;
    const qy = ay + vy * u;
    const dist = Math.hypot(px - qx, py - qy);
    if (best === null || dist < best.dist) {
      const bearing = ((Math.atan2(vx, vy) * 180) / Math.PI + 360) % 360;
      best = { seg: i, dist, x: qx, y: qy, bearing };
    }
  }
  return best;
}

/** Velocity along reported bearing at the fallback speed; zero when no bearing. */
function fallbackVelocity(bearing: number | null): { velLon: number; velLat: number } {
  if (bearing === null) return { velLon: 0, velLat: 0 };
  const rad = (bearing * Math.PI) / 180;
  return {
    velLon: (FALLBACK_SPEED_MS * Math.sin(rad)) / M_PER_DEG_LON,
    velLat: (FALLBACK_SPEED_MS * Math.cos(rad)) / M_PER_DEG_LAT,
  };
}

/** Rounded-rect bus bullet, nose up: TfL bus red, white outline + windscreen. */
function makeBusIcon(): ImageData {
  const c = document.createElement('canvas');
  c.width = 28;
  c.height = 44;
  const x = c.getContext('2d');
  if (!x) throw new Error('2d canvas unavailable');
  x.translate(14, 22);
  const w = 16;
  const h = 32;
  const r = 6;
  x.beginPath();
  x.roundRect(-w / 2, -h / 2, w, h, [r, r, 4, 4]);
  x.fillStyle = TFL_BUS_RED;
  x.fill();
  x.strokeStyle = '#ffffff';
  x.lineWidth = 2;
  x.stroke();
  // windscreen strip marks the front
  x.beginPath();
  x.roundRect(-w / 2 + 3, -h / 2 + 3, w - 6, 4, 2);
  x.fillStyle = '#ffffff';
  x.fill();
  return x.getImageData(0, 0, 28, 44);
}

export async function startBuses(map: MaplibreMap): Promise<void> {
  if (!map.hasImage('bus-bullet')) map.addImage('bus-bullet', makeBusIcon(), { pixelRatio: 2 });

  const empty = { type: 'FeatureCollection' as const, features: [] };
  map.addSource(DOTS_SOURCE_ID, { type: 'geojson', data: empty });
  map.addSource(ICONS_SOURCE_ID, { type: 'geojson', data: empty });

  // Beneath the TfL vehicle bullets so tube/rail markers stay readable.
  const beforeId = map.getLayer('trains-dots') ? 'trains-dots' : undefined;
  map.addLayer(
    {
      id: BUSES_DOTS_LAYER_ID,
      type: 'circle',
      source: DOTS_SOURCE_ID,
      maxzoom: TIER_SPLIT_ZOOM,
      paint: {
        'circle-color': TFL_BUS_RED,
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 1.5, TIER_SPLIT_ZOOM, 3],
        'circle-opacity': 0.85,
      },
    },
    beforeId,
  );
  map.addLayer(
    {
      id: BUSES_ICONS_LAYER_ID,
      type: 'symbol',
      source: ICONS_SOURCE_ID,
      minzoom: TIER_SPLIT_ZOOM,
      layout: {
        'icon-image': 'bus-bullet',
        'icon-size': ['interpolate', ['linear'], ['zoom'], TIER_SPLIT_ZOOM, 0.62, 16, 1],
        'icon-rotate': ['get', 'bearing'],
        'icon-rotation-alignment': 'map',
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
    },
    beforeId,
  );

  /** Per-bus motion trackers, keyed by operator-qualified vehicle id. */
  const trackers = new Map<string, BusTracker>();

  function setSource(sourceId: string, features: GeoJSON.Feature[]): void {
    const src = map.getSource(sourceId);
    if (src && 'setData' in src) {
      (src as GeoJSONSource).setData({ type: 'FeatureCollection', features });
    }
  }

  /**
   * Velocity from the last two distinct fixes when their spacing and implied
   * speed are plausible; otherwise the Bearing fallback (or zero).
   */
  function updateVelocity(tr: BusTracker): void {
    const dtS = (tr.lastFix.t - tr.prevFix.t) / 1000;
    if (dtS >= VELOCITY_MIN_DT_S && dtS <= VELOCITY_MAX_DT_S) {
      const velLon = (tr.lastFix.x - tr.prevFix.x) / dtS;
      const velLat = (tr.lastFix.y - tr.prevFix.y) / dtS;
      const speedMs = Math.hypot(velLon * M_PER_DEG_LON, velLat * M_PER_DEG_LAT);
      if (speedMs <= MAX_IMPLIED_SPEED_MS) {
        tr.velLon = velLon;
        tr.velLat = velLat;
        tr.hasTrackVelocity = true;
        return;
      }
    }
    const fb = fallbackVelocity(tr.bearing);
    tr.velLon = fb.velLon;
    tr.velLat = fb.velLat;
    tr.hasTrackVelocity = false;
  }

  /** Fold one polled row into its tracker (creating it on first sight). */
  function ingest(bus: BusWire, now: number): void {
    const routeFileKey = sanitizeKey(`${bus.o}:${bus.l}:${bus.r}`);
    const existing = trackers.get(bus.i);
    if (!existing) {
      const fix: Fix = { x: bus.x, y: bus.y, t: bus.t };
      const fb = fallbackVelocity(bus.b);
      // Fixes are often already 10-30 s old on arrival: start the displayed
      // position at the extrapolated target so new buses don't glide on entry.
      const staleS = Math.min(Math.max((now - bus.t) / 1000, 0), MAX_FALLBACK_EXTRAPOLATION_S);
      trackers.set(bus.i, {
        prevFix: fix,
        lastFix: fix,
        disp: { x: bus.x + fb.velLon * staleS, y: bus.y + fb.velLat * staleS },
        dispT: now,
        velLon: fb.velLon,
        velLat: fb.velLat,
        bearingDisp: bus.b ?? 0,
        rotRef: { x: bus.x, y: bus.y },
        hasTrackVelocity: false,
        lastSeen: now,
        line: bus.l,
        operator: bus.o,
        dest: bus.d,
        bearing: bus.b,
        routeFileKey,
        route: null,
        snapped: false,
        snapSeg: -1,
        snapFullT: 0,
        snapX: 0,
        snapY: 0,
        snapBearing: 0,
      });
      return;
    }
    existing.lastSeen = now;
    existing.line = bus.l;
    existing.operator = bus.o;
    existing.dest = bus.d;
    existing.bearing = bus.b;
    if (existing.routeFileKey !== routeFileKey) {
      // Reassigned to another line/direction — drop the old route binding.
      existing.routeFileKey = routeFileKey;
      existing.route = null;
      existing.snapped = false;
      existing.snapSeg = -1;
    }
    if (bus.t !== existing.lastFix.t) {
      existing.prevFix = existing.lastFix;
      existing.lastFix = { x: bus.x, y: bus.y, t: bus.t };
      updateVelocity(existing);
    }
    // Without a track-derived velocity the reported Bearing is the best
    // rotation we have; movement-derived rotation takes over once it moves.
    if (!existing.hasTrackVelocity && bus.b !== null) existing.bearingDisp = bus.b;
  }

  /**
   * Advance a tracker's displayed position to `now`: extrapolate the newest fix
   * along the velocity (capped), ease toward it (snap when far), and steer the
   * icon by the actual displayed movement once it accumulates.
   */
  function advance(tr: BusTracker, now: number): void {
    const horizonS = tr.hasTrackVelocity ? MAX_EXTRAPOLATION_S : MAX_FALLBACK_EXTRAPOLATION_S;
    const extraS = Math.min(Math.max((now - tr.lastFix.t) / 1000, 0), horizonS);
    const targetX = tr.lastFix.x + tr.velLon * extraS;
    const targetY = tr.lastFix.y + tr.velLat * extraS;
    const dtS = Math.max((now - tr.dispT) / 1000, 0);
    tr.dispT = now;
    const dx = targetX - tr.disp.x;
    const dy = targetY - tr.disp.y;
    const gapM = Math.hypot(dx * M_PER_DEG_LON, dy * M_PER_DEG_LAT);
    if (gapM > SNAP_DISTANCE_M) {
      // mutate in place — advance() runs per bus per tick; fresh objects here
      // were a measurable share of the frame-loop garbage
      tr.disp.x = targetX;
      tr.disp.y = targetY;
    } else {
      const alpha = 1 - Math.exp(-dtS / EASE_TAU_S);
      const stepM = gapM * alpha;
      const maxStepM = MAX_CATCHUP_SPEED_MS * dtS;
      const k = stepM > maxStepM && stepM > 0 ? (alpha * maxStepM) / stepM : alpha;
      tr.disp.x += dx * k;
      tr.disp.y += dy * k;
    }
    const moveLonM = (tr.disp.x - tr.rotRef.x) * M_PER_DEG_LON;
    const moveLatM = (tr.disp.y - tr.rotRef.y) * M_PER_DEG_LAT;
    if (Math.hypot(moveLonM, moveLatM) > ROTATE_MIN_MOVE_M) {
      tr.bearingDisp = ((Math.atan2(moveLonM, moveLatM) * 180) / Math.PI + 360) % 360;
      tr.rotRef.x = tr.disp.x;
      tr.rotRef.y = tr.disp.y;
    }
    updateSnap(tr, now);
  }

  /** Attach a learned route to the tracker once index + geometry are ready. */
  function resolveRoute(tr: BusTracker): void {
    if (tr.route !== null || routeIndex === null || !routeIndex.has(tr.routeFileKey)) return;
    const cached = routeCache.get(tr.routeFileKey);
    if (cached === undefined) {
      requestRoute(tr.routeFileKey);
      return;
    }
    if (cached !== 'pending' && cached !== 'absent') tr.route = cached;
  }

  /**
   * Display-only route snapping with hysteresis: project the raw eased
   * position onto the learned polyline (local window around the last hit,
   * periodic full re-search), snap under SNAP_ON_M, release past SNAP_OFF_M.
   */
  function updateSnap(tr: BusTracker, now: number): void {
    resolveRoute(tr);
    const route = tr.route;
    if (route === null) {
      tr.snapped = false;
      return;
    }
    const px = tr.disp.x * M_PER_DEG_LON;
    const py = tr.disp.y * M_PER_DEG_LAT;
    let proj: RouteProjection | null = null;
    if (tr.snapSeg >= 0 && now - tr.snapFullT < SNAP_FULL_SEARCH_MS) {
      proj = projectRange(route, px, py, tr.snapSeg - SNAP_LOCAL_WINDOW, tr.snapSeg + SNAP_LOCAL_WINDOW);
    }
    // Full scan when the hint is cold, stale, or clearly lost the bus.
    if (proj === null || proj.dist > SNAP_OFF_M) {
      proj = projectRange(route, px, py, 0, route.xs.length);
      tr.snapFullT = now;
    }
    if (proj === null) {
      tr.snapped = false;
      return;
    }
    tr.snapSeg = proj.seg;
    if (!tr.snapped && proj.dist < SNAP_ON_M) tr.snapped = true;
    else if (tr.snapped && proj.dist > SNAP_OFF_M) tr.snapped = false;
    if (!tr.snapped) return;
    tr.snapX = proj.x / M_PER_DEG_LON;
    tr.snapY = proj.y / M_PER_DEG_LAT;
    // The polyline tangent is bidirectional — keep the half-plane that agrees
    // with the motion-derived heading so buses never render nose-backwards.
    const diff = Math.abs(((proj.bearing - tr.bearingDisp + 540) % 360) - 180);
    tr.snapBearing = diff > 90 ? (proj.bearing + 180) % 360 : proj.bearing;
  }

  /** What actually gets drawn: snapped pose when snapped, raw pose otherwise. */
  function displayOf(tr: BusTracker): { x: number; y: number; bearing: number } {
    return tr.snapped
      ? { x: tr.snapX, y: tr.snapY, bearing: tr.snapBearing }
      : { x: tr.disp.x, y: tr.disp.y, bearing: tr.bearingDisp };
  }

  /** Drop trackers for buses absent from polls for longer than the TTL. */
  function prune(now: number): void {
    for (const [id, tr] of trackers) {
      if (now - tr.lastSeen > TRACKER_TTL_MS) trackers.delete(id);
    }
  }

  /** Dots tier: full fleet at displayed positions — refreshed at 1 Hz. */
  function renderDots(): void {
    if (map.getZoom() >= TIER_SPLIT_ZOOM) return; // layer hidden; skip the work
    if (!isLayerShown(map, BUSES_DOTS_LAYER_ID)) return; // legend-toggled off
    const now = Date.now();
    const features: GeoJSON.Feature[] = [];
    for (const tr of trackers.values()) {
      advance(tr, now);
      const pose = displayOf(tr);
      features.push({
        type: 'Feature' as const,
        properties: {},
        geometry: { type: 'Point' as const, coordinates: [pose.x, pose.y] },
      });
    }
    setSource(DOTS_SOURCE_ID, features);
  }

  async function poll(): Promise<void> {
    try {
      const res = await fetch('/api/buses');
      if (!res.ok) return;
      const list = (await res.json()) as BusWire[];
      if (!Array.isArray(list)) return;
      const now = Date.now();
      for (const bus of list) ingest(bus, now);
      prune(now);
    } catch {
      // keep the previous picture
    }
  }

  /** Symbol tier: viewport subset only, tracker-eased, capped at ~15 Hz. */
  const iconsGate = makeRenderGate(SYMBOL_TIER_INTERVAL_MS);
  let iconsWereEmpty = true;
  function renderIcons(frameNow: number): void {
    if (!iconsGate(frameNow) || !isLayerShown(map, BUSES_ICONS_LAYER_ID)) {
      requestAnimationFrame(renderIcons);
      return;
    }
    if (map.getZoom() < TIER_SPLIT_ZOOM) {
      if (!iconsWereEmpty) {
        setSource(ICONS_SOURCE_ID, []);
        iconsWereEmpty = true;
      }
      requestAnimationFrame(renderIcons);
      return;
    }
    const bounds = map.getBounds();
    const lonMargin = (bounds.getEast() - bounds.getWest()) * VIEW_MARGIN;
    const latMargin = (bounds.getNorth() - bounds.getSouth()) * VIEW_MARGIN;
    const west = bounds.getWest() - lonMargin;
    const east = bounds.getEast() + lonMargin;
    const south = bounds.getSouth() - latMargin;
    const north = bounds.getNorth() + latMargin;
    const now = Date.now();
    const features: GeoJSON.Feature[] = [];
    for (const [id, tr] of trackers) {
      const { x, y } = tr.disp;
      if (x < west || x > east || y < south || y > north) continue;
      advance(tr, now);
      const pose = displayOf(tr);
      features.push({
        type: 'Feature',
        properties: {
          id,
          line: tr.line,
          operator: tr.operator,
          dest: tr.dest,
          bearing: pose.bearing,
        },
        geometry: { type: 'Point', coordinates: [pose.x, pose.y] },
      });
    }
    setSource(ICONS_SOURCE_ID, features);
    iconsWereEmpty = features.length === 0;
    requestAnimationFrame(renderIcons);
  }

  // ── hover + click (symbol tier only — dots are too small to target) ──
  const tip = new Popup({ closeButton: false, closeOnClick: false, offset: 12, className: 'hover-tip' });
  map.on('mousemove', BUSES_ICONS_LAYER_ID, (e: MapLayerMouseEvent) => {
    const p = e.features?.[0]?.properties as Record<string, string | number> | undefined;
    if (!p) return;
    map.getCanvas().style.cursor = 'pointer';
    const dest = String(p.dest).trim();
    tip
      .setLngLat(e.lngLat)
      .setHTML(
        `<div class="vp"><b>${esc(String(p.line))}</b>${dest ? ` <span class="vp-dim">to ${esc(dest)}</span>` : ''}</div>`,
      )
      .addTo(map);
  });
  map.on('mouseleave', BUSES_ICONS_LAYER_ID, () => {
    map.getCanvas().style.cursor = '';
    tip.remove();
  });

  const detail = new Popup({ closeButton: true, closeOnClick: true, offset: 14, maxWidth: '280px' });
  map.on('click', BUSES_ICONS_LAYER_ID, (e: MapLayerMouseEvent) => {
    const p = e.features?.[0]?.properties as Record<string, string | number> | undefined;
    if (!p) return;
    tip.remove();
    const id = String(p.id);
    const vehicleRef = id.slice(id.indexOf(':') + 1);
    const dest = String(p.dest).trim();
    detail
      .setLngLat(e.lngLat)
      .setHTML(
        `<div class="vp"><div class="sp-title">🚌 Route ${esc(String(p.line))}</div>
        <div>Operator ${esc(String(p.operator))}</div>
        ${dest ? `<div class="vp-dim">to ${esc(dest)}</div>` : ''}
        <div class="vp-dim">Vehicle ${esc(vehicleRef)}</div></div>`,
      )
      .addTo(map);
  });

  void loadRouteIndex(); // fire-and-forget: snapping activates when it lands
  await poll();
  renderDots();
  window.setInterval(() => void poll(), POLL_INTERVAL_MS);
  window.setInterval(renderDots, DOTS_REFRESH_MS);
  requestAnimationFrame(renderIcons);
}
