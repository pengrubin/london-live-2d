// Aircraft photo lookup: GET /api/aircraft-photo?reg=G-XWBA&hex=406b5b.
//
// Proxies the free Planespotters public photo API (registration preferred,
// ICAO24 hex as fallback) and returns a compact {src, photographer, link}.
// The image src is a plain CDN link (t.plnspttrs.net) that hotlinks fine, so
// only the JSON is proxied — the browser fetches the image bytes directly.
// Planespotters requires a descriptive User-Agent and photographer
// attribution; the frontend renders the attribution line. Results (including
// "no photo") are cached for 24 h behind a small dedicated budget.

import type { FastifyInstance } from 'fastify';
import { TtlCache } from '../cache';
import { RateBudget } from '../rate-budget';
import { UPSTREAM_TIMEOUT_MS } from '../constants';

const PARAM_PATTERN = /^[A-Za-z0-9-]{2,10}$/;
const PHOTO_CACHE_TTL_MS = 24 * 60 * 60_000;
const PHOTO_BUDGET_LIMIT = 20;
const PHOTO_BUDGET_WINDOW_MS = 60_000;
const API_BASE = 'https://api.planespotters.net/pub/photos';
/** Planespotters rejects generic UAs; identify the app with a contact URL. */
const API_USER_AGENT = 'london-live-2d/1.0 (+https://london-live.up.railway.app)';

/** Cached lookup result; null means "checked, no photo available". */
interface AircraftPhoto {
  readonly src: string;
  readonly photographer: string;
  readonly link: string;
}
type PhotoEntry = AircraftPhoto | null;

interface PlanespottersResponse {
  photos?: {
    thumbnail_large?: { src?: string };
    photographer?: string;
    link?: string;
  }[];
}

async function fetchFromPlanespotters(pathSegment: string): Promise<PhotoEntry> {
  const res = await fetch(`${API_BASE}/${pathSegment}`, {
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    headers: { accept: 'application/json', 'user-agent': API_USER_AGENT },
  });
  if (!res.ok) return null;
  const body = (await res.json()) as PlanespottersResponse;
  const photo = body.photos?.[0];
  const src = photo?.thumbnail_large?.src;
  if (!src) return null;
  return { src, photographer: photo?.photographer ?? '', link: photo?.link ?? '' };
}

/** Registration first (better matches), then the hex fallback. */
async function lookupPhoto(reg: string, hex: string): Promise<PhotoEntry> {
  if (reg) {
    const byReg = await fetchFromPlanespotters(`reg/${reg}`);
    if (byReg !== null) return byReg;
  }
  if (hex) return fetchFromPlanespotters(`hex/${hex}`);
  return null;
}

/** Aircraft photo: GET /api/aircraft-photo?reg=…&hex=… → {src, photographer, link} or 404 {}. */
export function registerAircraftPhotoRoute(app: FastifyInstance): void {
  const cache = new TtlCache<PhotoEntry>(PHOTO_CACHE_TTL_MS);
  const budget = new RateBudget(PHOTO_BUDGET_LIMIT, PHOTO_BUDGET_WINDOW_MS);

  app.get<{ Querystring: { reg?: string; hex?: string } }>(
    '/api/aircraft-photo',
    async (request, reply) => {
      const rawReg = request.query.reg?.trim() ?? '';
      const rawHex = request.query.hex?.trim() ?? '';
      const reg = PARAM_PATTERN.test(rawReg) ? rawReg.toUpperCase() : '';
      const hex = PARAM_PATTERN.test(rawHex) ? rawHex.toLowerCase() : '';
      if (!reg && !hex) {
        return reply
          .code(400)
          .send({ error: 'Provide "reg" or "hex" matching [A-Za-z0-9-]{2,10}.' });
      }

      const sendEntry = (entry: PhotoEntry, state: string): unknown => {
        if (entry === null) return reply.code(404).header('x-cache', state).send({});
        return reply.header('x-cache', state).send(entry);
      };

      const key = `${reg}|${hex}`;
      const fresh = cache.getFresh(key);
      if (fresh !== undefined) return sendEntry(fresh, 'hit');

      if (!budget.tryConsume()) {
        const stale = cache.getStale(key);
        if (stale !== undefined) return sendEntry(stale, 'stale');
        return reply
          .code(429)
          .send({ error: 'Aircraft-photo budget exhausted; try again shortly.' });
      }

      try {
        const entry = await lookupPhoto(reg, hex);
        cache.set(key, entry);
        return sendEntry(entry, 'miss');
      } catch (err) {
        request.log.warn({ err, reg, hex }, 'aircraft-photo upstream fetch failed');
        const stale = cache.getStale(key);
        if (stale !== undefined) return sendEntry(stale, 'stale');
        return reply.code(502).send({ error: 'Aircraft-photo upstream fetch failed.' });
      }
    },
  );
}
