import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance, type LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DISRUPTIONS_MAX_STALE_MS,
  DISRUPTIONS_TTL_MS,
  registerDisruptionsRoute,
  type DisruptionsContext,
  type DisruptionsCounters,
} from './disruptions';
import { buildHopIndex } from '../disruptions/line-graph';
import { loadBranchData } from '../leaderboard';
import { TtlCache } from '../cache';
import { RateBudget } from '../rate-budget';
import type { AppConfig } from '../config';
import type { TflResponse } from '../tfl-client';

const DATA_DIR = fileURLToPath(new URL('../../../data/', import.meta.url));
const APP_KEY = 'test-app-key-0123';
const CONFIG = { tflAppKey: APP_KEY } as unknown as AppConfig;
const PATH = '/api/disruptions';
const BUDGET_LIMIT = 60;
const BUDGET_WINDOW_MS = 60_000;
/** 2026-09-03T19:30:30Z — a London summer evening, so BST is in play. */
const T0 = 1_788_463_830_000;
const EXPECTED_WINDOW = ['2026-09-02', '2026-09-10'];
const HTTP_NOT_FOUND = 404;
const HTTP_BAD_GATEWAY = 502;

// Real ids so the section survives the hop gate: Earl's Court → West Brompton
// is a baked District hop, Aldgate East is on the line but off this slice.
const EARLS_COURT = '940GZZLUECT';
const WEST_BROMPTON = '940GZZLUWBN';
const ALDGATE_EAST = '940GZZLUADE';

const stopPoint = (naptanId: string): { naptanId: string; commonName: string; lat: number; lon: number } => ({
  naptanId,
  // Fields the upstream really sends and the payload must never carry.
  commonName: 'Earl’s Court Underground Station',
  lat: 51.49,
  lon: -0.19,
});

/** A raw TfL window body: one disrupted line plus one Good Service line. */
const UPSTREAM_BODY = [
  {
    id: 'district',
    lineStatuses: [
      {
        statusSeverity: 5,
        statusSeverityDescription: 'Part Closure',
        reason: 'District Line: Saturday 5 September, no service between Earl’s Court and West Brompton.',
        validityPeriods: [{ fromDate: '2026-09-05T02:30:00Z', toDate: '2026-09-07T00:29:00Z', isNow: false }],
        disruption: {
          category: 'PlannedWork',
          closureText: 'partClosure',
          affectedRoutes: [
            {
              id: '1',
              name: 'Earl’s Court - West Brompton',
              direction: 'inbound',
              isEntireRouteSection: false,
              routeSectionNaptanEntrySequence: [
                { stopPoint: stopPoint(EARLS_COURT) },
                { stopPoint: stopPoint(WEST_BROMPTON) },
              ],
            },
          ],
          affectedStops: [stopPoint(EARLS_COURT), stopPoint(WEST_BROMPTON), stopPoint(ALDGATE_EAST)],
        },
      },
    ],
  },
  { id: 'victoria', lineStatuses: [{ statusSeverity: 10, statusSeverityDescription: 'Good Service' }] },
];

const branchData = loadBranchData(DATA_DIR, () => {});

interface Harness {
  readonly app: FastifyInstance;
  readonly fetchWindow: ReturnType<typeof vi.fn>;
  readonly counters: () => DisruptionsCounters;
  readonly advance: (ms: number) => void;
  readonly get: () => Promise<LightMyRequestResponse>;
}

const apps: FastifyInstance[] = [];

function harness(responses: (() => Promise<TflResponse>)[]): Harness {
  let clock = T0;
  const app = Fastify();
  apps.push(app);
  const fetchWindow = vi.fn(async (): Promise<TflResponse> => {
    const next = responses.shift();
    if (next === undefined) throw new Error('upstream called more often than the test allows');
    return next();
  });
  const ctx: DisruptionsContext = {
    lineIds: ['district', 'victoria'],
    resolve: { hops: buildHopIndex(branchData.branchesByLine), modeById: branchData.lineModeById, log: () => {} },
    fetchWindow,
  };
  const counters = registerDisruptionsRoute(
    app,
    {
      config: CONFIG,
      cache: new TtlCache<unknown>(DISRUPTIONS_TTL_MS),
      budget: new RateBudget(BUDGET_LIMIT, BUDGET_WINDOW_MS),
      now: () => clock,
    },
    ctx,
  );
  return {
    app,
    fetchWindow,
    counters,
    advance: (ms) => {
      clock += ms;
    },
    get: () => app.inject({ method: 'GET', url: PATH }),
  };
}

const ok = (body: unknown = UPSTREAM_BODY) => async (): Promise<TflResponse> => ({ status: 200, body });

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('GET /api/disruptions payload contract', () => {
  it('carries exactly the §4 keys — nothing upstream can leak through', async () => {
    // Arrange
    const h = harness([ok()]);

    // Act
    const res = await h.get();
    const payload = res.json() as Record<string, unknown>;

    // Assert
    expect(res.statusCode).toBe(200);
    expect(Object.keys(payload).sort()).toEqual(['items', 'pf', 't', 'w']);
    expect(payload['pf']).toBe(0);
    expect(payload['w']).toEqual(EXPECTED_WINDOW);
    expect(payload['t']).toBe(Math.floor(T0 / 1000));
  });

  it('carries exactly the §4 item keys, so a future upstream field cannot ride along', async () => {
    const h = harness([ok()]);

    const { items } = (await h.get()).json() as { items: Record<string, unknown>[] };

    expect(items).toHaveLength(1);
    expect(Object.keys(items[0] ?? {}).sort()).toEqual([
      'c',
      'd',
      'id',
      'k',
      'l',
      'm',
      'n',
      'pts',
      'r',
      's',
      'sc',
      'sec',
      'src',
      'v',
      'wl',
    ]);
  });

  it('draws only what TfL localised: the hop-validated slice and the on-line stops', async () => {
    const h = harness([ok()]);

    const { items } = (await h.get()).json() as {
      items: { sec: { st: string[]; dir: string }[]; pts: { id: string }[]; src: string; sc: string }[];
    };

    expect(items[0]?.sec).toEqual([{ st: [EARLS_COURT, WEST_BROMPTON], k: 'closed', dir: 'i' }]);
    expect(items[0]?.pts.map((p) => p.id)).toEqual([EARLS_COURT, WEST_BROMPTON, ALDGATE_EAST]);
    expect(items[0]).toMatchObject({ src: 's', sc: 'section' });
  });

  it('never serialises an upstream field name, a coordinate or the app key', async () => {
    const h = harness([ok()]);

    const body = (await h.get()).body;

    for (const leak of ['affectedRoutes', 'affectedStops', 'commonName', 'lat', 'lon', 'naptanId', APP_KEY]) {
      expect(body).not.toContain(leak);
    }
  });

  it('asks TfL for yesterday through today+7 as Europe/London days', async () => {
    const h = harness([ok()]);

    await h.get();

    expect(h.fetchWindow).toHaveBeenCalledWith(['district', 'victoria'], '2026-09-02', '2026-09-10', APP_KEY);
  });

  it('reports the resolver counters for /health', async () => {
    const h = harness([ok()]);

    await h.get();

    expect(h.counters()).toEqual({
      disruptionsItems: 1,
      disruptionsSections: 1,
      disruptionsSectionsDropped: 0,
      disruptionsLastParseMs: 0,
    });
  });
});

describe('GET /api/disruptions upstream failures', () => {
  const notFound = async (): Promise<TflResponse> => ({
    // A real TfL error body echoes the request URI, app key included.
    status: HTTP_NOT_FOUND,
    body: { message: `The following line id is not recognised: /Line/x/Status?app_key=${APP_KEY}` },
  });

  it('THROWS on a non-200 instead of forwarding the key-echoing error body', async () => {
    // Arrange — no cached copy, so the throw can only end as a 502.
    const h = harness([notFound]);

    // Act
    const res = await h.get();

    // Assert
    expect(res.statusCode).toBe(HTTP_BAD_GATEWAY);
    expect(res.body).not.toContain(APP_KEY);
    expect(res.json()).toEqual({ error: 'Upstream TfL request failed.' });
  });

  it('serves the last good payload as stale when the upstream then fails', async () => {
    const h = harness([ok(), notFound]);
    await h.get();

    // Act — past the TTL and past the failure back-off, so a second fetch runs.
    h.advance(DISRUPTIONS_TTL_MS + 1);
    const res = await h.get();

    // Assert
    expect(res.headers['x-cache']).toBe('stale');
    expect((res.json() as { items: unknown[] }).items).toHaveLength(1);
  });

  it('stops serving a payload older than the max-stale bound', async () => {
    const h = harness([ok(), notFound]);
    await h.get();

    h.advance(DISRUPTIONS_MAX_STALE_MS + 1);
    const res = await h.get();

    expect(res.statusCode).toBe(HTTP_BAD_GATEWAY);
  });

  it('throws on a body that is not a line array rather than caching nonsense', async () => {
    const h = harness([ok({ message: 'unexpected' })]);

    const res = await h.get();

    expect(res.statusCode).toBe(HTTP_BAD_GATEWAY);
  });

  it('answers 503 with no TfL key configured, and never calls the upstream', async () => {
    const app = Fastify();
    apps.push(app);
    const fetchWindow = vi.fn();
    registerDisruptionsRoute(
      app,
      {
        config: { tflAppKey: undefined } as unknown as AppConfig,
        cache: new TtlCache<unknown>(DISRUPTIONS_TTL_MS),
        budget: new RateBudget(BUDGET_LIMIT, BUDGET_WINDOW_MS),
      },
      {
        lineIds: ['district'],
        resolve: { hops: buildHopIndex(branchData.branchesByLine), modeById: branchData.lineModeById, log: () => {} },
        fetchWindow,
      },
    );

    const res = await app.inject({ method: 'GET', url: PATH });

    expect(res.statusCode).toBe(503);
    expect(fetchWindow).not.toHaveBeenCalled();
  });
});
