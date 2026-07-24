// Ship photo proxy: GET /api/ship-photo?mmsi=NNNNNNNNN.
//
// VesselFinder photo URLs are hashed (ship-photo/0-{mmsi}-{hash}/1), so the
// public details page is scraped for the image URL first, then the image
// bytes are proxied through — the browser never talks to VesselFinder, so
// referer-based hotlink protection can't bite. Results (including "no
// photo") are cached for 24 h; a small dedicated budget keeps us polite.

import type { FastifyInstance } from 'fastify';
import { TtlCache } from '../cache';
import { RateBudget } from '../rate-budget';
import { UPSTREAM_TIMEOUT_MS } from '../constants';

const MMSI_PATTERN = /^\d{9}$/;
const PHOTO_CACHE_TTL_MS = 24 * 60 * 60_000;
/** One lookup = up to two upstream requests (page + image); keep it modest. */
const PHOTO_BUDGET_LIMIT = 10;
const PHOTO_BUDGET_WINDOW_MS = 60_000;
/** VesselFinder serves its public pages to browsers; identify as one. */
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const DETAILS_URL_PREFIX = 'https://www.vesselfinder.com/vessels/details/';
const PHOTO_URL_PATTERN = /https:\/\/static\.vesselfinder\.net\/ship-photo\/[^"'\s\\]+/;
const BROWSER_CACHE_SECONDS = 86_400;

/** Cached lookup result; null means "checked, no photo available". */
interface CachedPhoto {
  readonly contentType: string;
  readonly bytes: Buffer;
}
type PhotoEntry = CachedPhoto | null;

async function fetchPhotoFromVesselFinder(mmsi: string): Promise<PhotoEntry> {
  const pageRes = await fetch(`${DETAILS_URL_PREFIX}${mmsi}`, {
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    headers: { 'user-agent': BROWSER_UA, accept: 'text/html' },
  });
  if (!pageRes.ok) return null;
  const photoUrl = PHOTO_URL_PATTERN.exec(await pageRes.text())?.[0];
  if (!photoUrl) return null;

  const imgRes = await fetch(photoUrl, {
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    headers: { 'user-agent': BROWSER_UA },
  });
  const contentType = imgRes.headers.get('content-type') ?? '';
  if (!imgRes.ok || !contentType.startsWith('image/')) return null;
  return { contentType, bytes: Buffer.from(await imgRes.arrayBuffer()) };
}

/** Ship photo by MMSI: GET /api/ship-photo?mmsi=235099766 → image bytes or 404 {}. */
export function registerShipPhotoRoute(app: FastifyInstance): void {
  const cache = new TtlCache<PhotoEntry>(PHOTO_CACHE_TTL_MS);
  const budget = new RateBudget(PHOTO_BUDGET_LIMIT, PHOTO_BUDGET_WINDOW_MS);

  app.get<{ Querystring: { mmsi?: string } }>('/api/ship-photo', async (request, reply) => {
    const mmsi = request.query.mmsi?.trim() ?? '';
    if (!MMSI_PATTERN.test(mmsi)) {
      return reply.code(400).send({ error: 'Query parameter "mmsi" must be 9 digits.' });
    }

    const sendEntry = (entry: PhotoEntry, state: string): unknown => {
      if (entry === null) return reply.code(404).header('x-cache', state).send({});
      return reply
        .header('x-cache', state)
        .header('content-type', entry.contentType)
        .header('cache-control', `public, max-age=${BROWSER_CACHE_SECONDS}`)
        .send(entry.bytes);
    };

    const fresh = cache.getFresh(mmsi);
    if (fresh !== undefined) return sendEntry(fresh, 'hit');

    if (!budget.tryConsume()) {
      const stale = cache.getStale(mmsi);
      if (stale !== undefined) return sendEntry(stale, 'stale');
      return reply.code(429).send({ error: 'Ship-photo budget exhausted; try again shortly.' });
    }

    try {
      const entry = await fetchPhotoFromVesselFinder(mmsi);
      cache.set(mmsi, entry);
      return sendEntry(entry, 'miss');
    } catch (err) {
      request.log.warn({ err, mmsi }, 'ship-photo upstream fetch failed');
      const stale = cache.getStale(mmsi);
      if (stale !== undefined) return sendEntry(stale, 'stale');
      return reply.code(502).send({ error: 'Ship-photo upstream fetch failed.' });
    }
  });
}
