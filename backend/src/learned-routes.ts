// Loader for the learner's per-key polylines (<busDataDir>/bus-routes/learned/
// *.json, each { key, poly, quality: { journeys, meanResidualM, coverage? } })
// into the grid-indexed form the diversion detector projects against. Pure IO
// + parsing; the detector owns when it runs (boot + every 24 h).

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildRouteIndex, type LonLat, type RouteIndex } from './route-projection';

/** Yield to the event loop every this many built indexes — a full London
 * build is ~1,800 keys and must not stall the BODS poll it rides beside. */
const INDEX_BUILD_YIELD_EVERY = 100;

/**
 * Learned shapes covering less than this fraction of their own key's journey
 * fixes are not indexed. quality.coverage (scripts/learn-bus-routes.mjs) is
 * the share of ALL the key's fixes inside the shape's adaptive corridor, so a
 * low value means a partial polyline. Below this the uncovered part of the
 * route generates kilometres-off "excursions" by construction, and the
 * per-route shape gate is blind to it: its |d| median is taken over the
 * covered part only. 0.8 cuts below the bulk of the production distribution
 * (2026-10-04 snapshot, 1,834 keys with coverage: p18 0.80, lower quartile
 * 0.85, median 0.91), so it drops the long tail (330 keys, 50 of them TfL)
 * without touching ordinary routes.
 *
 * Keys with NO coverage field (learner output from before coverage was
 * measured) are trusted, so a deployment on old data keeps working.
 */
export const DETECTOR_MIN_COVERAGE = 0.8;

export interface LearnedRoute {
  poly: LonLat[];
  index: RouteIndex;
}

export interface SkippedRoute {
  key: string;
  coverage: number;
}

export interface LearnedRouteLoad {
  routes: Map<string, LearnedRoute>;
  /** keys left out because their learned shape covers too little of the route */
  skippedLowCoverage: SkippedRoute[];
}

function isPoly(poly: unknown): poly is LonLat[] {
  return (
    Array.isArray(poly) &&
    poly.length >= 2 &&
    poly.every((p) => Array.isArray(p) && typeof p[0] === 'number' && typeof p[1] === 'number')
  );
}

export async function loadLearnedRoutes(learnedDir: string): Promise<LearnedRouteLoad> {
  let names: string[] = [];
  try {
    names = (await readdir(learnedDir)).filter((n) => !n.startsWith('.') && n.endsWith('.json'));
  } catch {
    // dir vanished after the boot check — detector idles with zero routes
  }
  const routes = new Map<string, LearnedRoute>();
  const skippedLowCoverage: SkippedRoute[] = [];
  let built = 0;
  for (const name of names) {
    try {
      const doc = JSON.parse(await readFile(join(learnedDir, name), 'utf8')) as {
        key?: unknown;
        poly?: unknown;
        quality?: { coverage?: unknown };
      };
      const { key, poly } = doc;
      const coverage = doc.quality?.coverage;
      if (typeof key === 'string' && typeof coverage === 'number' && coverage < DETECTOR_MIN_COVERAGE) {
        skippedLowCoverage.push({ key, coverage });
      } else if (typeof key === 'string' && isPoly(poly)) {
        routes.set(key, { poly, index: buildRouteIndex(poly) });
        built += 1;
      }
    } catch {
      // one unreadable learned file must not sink the detector
    }
    if (built % INDEX_BUILD_YIELD_EVERY === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  skippedLowCoverage.sort((a, b) => a.key.localeCompare(b.key));
  return { routes, skippedLowCoverage };
}
