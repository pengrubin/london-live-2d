import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadBranchData } from './leaderboard';
import {
  compactDisruptions,
  compactStatus,
  makeTubeStatusFeed,
  shouldWrite,
  SnapshotRecorder,
  STARTUP_DELAY_MS,
  STATUS_MODES,
  statusLineIds,
} from './status-recorder';

const GOOD_SERVICE = {
  id: 'victoria',
  lineStatuses: [{ statusSeverity: 10, statusSeverityDescription: 'Good Service' }],
};

const PART_SUSPENDED = {
  id: 'district',
  lineStatuses: [
    {
      statusSeverity: 4,
      statusSeverityDescription: 'Part Suspended',
      reason: 'DISTRICT LINE: No service between Tower Hill and Barking due to a signal failure.',
    },
    { statusSeverity: 9, statusSeverityDescription: 'Minor Delays' },
  ],
};

describe('compactStatus', () => {
  it('keeps every concurrent status and its reason for a disrupted line', () => {
    const lines = compactStatus([PART_SUSPENDED]);

    expect(lines).toHaveLength(1);
    expect(lines?.[0]?.id).toBe('district');
    expect(lines?.[0]?.st).toHaveLength(2);
    expect(lines?.[0]?.st[0]?.s).toBe(4);
    expect(lines?.[0]?.st[0]?.r).toContain('signal failure');
    expect(lines?.[0]?.st[1]?.s).toBe(9);
    expect(lines?.[0]?.st[1]?.r).toBeUndefined();
  });

  it('sorts lines by id so serialized snapshots compare stably', () => {
    const lines = compactStatus([PART_SUSPENDED, GOOD_SERVICE]);

    expect(lines?.map((l) => l.id)).toEqual(['district', 'victoria']);
  });

  it('returns null for non-array payloads (error objects, HTML gateways)', () => {
    expect(compactStatus({ httpStatusCode: 429, message: 'rate limited' })).toBeNull();
    expect(compactStatus('<html>Bad Gateway</html>')).toBeNull();
    expect(compactStatus(null)).toBeNull();
  });

  it('drops malformed entries but keeps valid ones', () => {
    const lines = compactStatus([
      GOOD_SERVICE,
      { lineStatuses: [{ statusSeverity: 10 }] }, // no id
      { id: 'bakerloo' }, // no statuses
      { id: 'central', lineStatuses: [{ statusSeverityDescription: 'no code' }] },
      null,
    ]);

    expect(lines?.map((l) => l.id)).toEqual(['victoria']);
  });

  it('returns null when nothing valid remains', () => {
    expect(compactStatus([{ id: 'x' }, null])).toBeNull();
    expect(compactStatus([])).toBeNull();
  });
});

describe('compactDisruptions', () => {
  it('keeps the archived fields, truncates free text, sorts by id', () => {
    const out = compactDisruptions([
      {
        id: 'TIMS-2',
        category: 'Works',
        severity: 'Serious',
        location: 'B'.repeat(300),
        comments: 'C'.repeat(400),
        startDateTime: '2026-08-20T00:00:00Z',
        endDateTime: '2026-09-30T00:00:00Z',
        point: '[-0.1,51.5]',
      },
      { id: 'TIMS-1', category: 'Incident' },
    ]);

    expect(out?.map((d) => d.id)).toEqual(['TIMS-1', 'TIMS-2']);
    expect(out?.[1]?.loc).toHaveLength(200);
    expect(out?.[1]?.com).toHaveLength(300);
    expect(out?.[1]?.pt).toBe('[-0.1,51.5]');
    expect(out?.[0]).toEqual({ id: 'TIMS-1', cat: 'Incident' });
  });

  it('records a genuinely quiet network as an empty array, not a skip', () => {
    expect(compactDisruptions([])).toEqual([]);
  });

  it('rejects non-array payloads', () => {
    expect(compactDisruptions({ httpStatusCode: 429 })).toBeNull();
    expect(compactDisruptions('<html>Bad Gateway</html>')).toBeNull();
  });

  it('drops entries without a usable id', () => {
    expect(compactDisruptions([{ category: 'Works' }, null, { id: '' }])).toEqual([]);
  });
});

describe('shouldWrite', () => {
  const T0 = 1_755_900_000_000;
  const HEARTBEAT = 30 * 60_000;

  it('always writes the first snapshot of a file', () => {
    expect(shouldWrite(null, '[]', null, T0, HEARTBEAT)).toBe(true);
  });

  it('writes when the status changed', () => {
    expect(shouldWrite('[a]', '[b]', T0, T0 + 120_000, HEARTBEAT)).toBe(true);
  });

  it('skips an unchanged status inside the heartbeat window', () => {
    expect(shouldWrite('[a]', '[a]', T0, T0 + 120_000, HEARTBEAT)).toBe(false);
  });

  it('writes an unchanged status once the heartbeat interval elapses', () => {
    expect(shouldWrite('[a]', '[a]', T0, T0 + 30 * 60_000, HEARTBEAT)).toBe(true);
  });

  it('a zero heartbeat writes every poll even when unchanged', () => {
    expect(shouldWrite('[a]', '[a]', T0, T0 + 1, 0)).toBe(true);
  });
});

// --- structured disruption fields (TfL ?detail=true) -------------------------

const stop = (naptanId: string, commonName: string) => ({ naptanId, commonName });

const DETAILED_PART_CLOSURE = {
  id: 'district',
  lineStatuses: [
    {
      statusSeverity: 4,
      statusSeverityDescription: 'Part Closure',
      reason: 'District Line: No service between Earl\'s Court and Kensington (Olympia).',
      validityPeriods: [{ fromDate: '2026-09-05T04:30:00Z', toDate: '2026-09-06T01:29:00Z', isNow: true }],
      disruption: {
        category: 'PlannedWork',
        closureText: 'partClosure',
        description: 'District Line: No service between Earl\'s Court and Kensington (Olympia).',
        affectedRoutes: [
          {
            id: '2105',
            name: "Earl's Court - Kensington (Olympia)",
            direction: 'outbound',
            originationName: "Earl's Court",
            destinationName: 'Kensington (Olympia)',
            isEntireRouteSection: false,
            routeSectionNaptanEntrySequence: [
              { ordinal: 0, stopPoint: stop('940GZZLUECT', "Earl's Court") },
              { ordinal: 1, stopPoint: stop('940GZZLUKOY', 'Kensington (Olympia)') },
            ],
          },
        ],
        affectedStops: [
          stop('940GZZLUECT', "Earl's Court"),
          stop('940GZZLUKOY', 'Kensington (Olympia)'),
          stop('940GZZLUECT', "Earl's Court"), // defensive: archive each id once
        ],
      },
    },
  ],
};

describe('compactStatus structured disruption fields', () => {
  it('archives validity, category, closure text, affected routes and stops', () => {
    const entry = compactStatus([DETAILED_PART_CLOSURE])?.[0]?.st[0];

    expect(entry?.c).toBe('PlannedWork');
    expect(entry?.ct).toBe('partClosure');
    expect(entry?.v).toEqual([{ f: '2026-09-05T04:30:00Z', t: '2026-09-06T01:29:00Z', n: true }]);
    expect(entry?.ar).toEqual([
      {
        id: '2105',
        n: "Earl's Court - Kensington (Olympia)",
        dir: 'outbound',
        o: "Earl's Court",
        de: 'Kensington (Olympia)',
        e: false,
        st: ['940GZZLUECT', '940GZZLUKOY'],
      },
    ]);
    expect(entry?.as).toEqual(['940GZZLUECT', '940GZZLUKOY']);
  });

  it('omits every structured key when TfL sends none, so old archives stay byte-compatible', () => {
    const entry = compactStatus([GOOD_SERVICE])?.[0]?.st[0];

    expect(entry).toEqual({ s: 10, d: 'Good Service' });
    expect(JSON.stringify(entry)).toBe('{"s":10,"d":"Good Service"}');
  });

  it('drops malformed routes and stops but keeps the well-formed ones', () => {
    const entry = compactStatus([
      {
        id: 'central',
        lineStatuses: [
          {
            statusSeverity: 6,
            statusSeverityDescription: 'Severe Delays',
            validityPeriods: 'not-an-array',
            disruption: {
              category: 42,
              affectedRoutes: [
                { name: 'no id' },
                {
                  id: '2330',
                  routeSectionNaptanEntrySequence: [
                    { ordinal: 0, stopPoint: { commonName: 'no naptan' } },
                    { ordinal: 1, stopPoint: stop('940GZZLUEBY', 'Ealing Broadway') },
                    null,
                  ],
                },
                null,
              ],
              affectedStops: [null, { commonName: 'no id' }, stop('940GZZLUEBY', 'Ealing Broadway')],
            },
          },
        ],
      },
    ])?.[0]?.st[0];

    expect(entry?.v).toBeUndefined();
    expect(entry?.c).toBeUndefined();
    expect(entry?.ar).toEqual([{ id: '2330', st: ['940GZZLUEBY'] }]);
    expect(entry?.as).toEqual(['940GZZLUEBY']);
  });

  it('omits empty affected lists rather than archiving []', () => {
    const entry = compactStatus([
      {
        id: 'jubilee',
        lineStatuses: [
          {
            statusSeverity: 9,
            statusSeverityDescription: 'Minor Delays',
            disruption: { category: 'RealTime', affectedRoutes: [], affectedStops: [] },
          },
        ],
      },
    ])?.[0]?.st[0];

    expect(entry?.c).toBe('RealTime');
    expect(entry?.ar).toBeUndefined();
    expect(entry?.as).toBeUndefined();
  });
});

// --- archive-size guards (measured 2026-09-02, see docs/DISRUPTION_GEOLOCATION.md §8) ---

describe('compactStatus archive-size guards', () => {
  it('drops the stop list of an entire-route section (whole line, no localisation value) but keeps its flag', () => {
    const entry = compactStatus([
      {
        id: 'northern',
        lineStatuses: [
          {
            statusSeverity: 9,
            statusSeverityDescription: 'Minor Delays',
            disruption: {
              category: 'RealTime',
              affectedRoutes: [
                {
                  id: '2330',
                  name: 'Edgware - Morden via Bank',
                  isEntireRouteSection: true,
                  routeSectionNaptanEntrySequence: [
                    { ordinal: 0, stopPoint: stop('940GZZLUEGW', 'Edgware') },
                    { ordinal: 1, stopPoint: stop('940GZZLUBTK', 'Burnt Oak') },
                  ],
                },
                {
                  id: '2105',
                  isEntireRouteSection: false,
                  routeSectionNaptanEntrySequence: [
                    { ordinal: 0, stopPoint: stop('940GZZLUEGW', 'Edgware') },
                    { ordinal: 1, stopPoint: stop('940GZZLUBTK', 'Burnt Oak') },
                  ],
                },
              ],
            },
          },
        ],
      },
    ])?.[0]?.st[0];

    expect(entry?.ar).toEqual([
      { id: '2330', n: 'Edgware - Morden via Bank', e: true },
      { id: '2105', e: false, st: ['940GZZLUEGW', '940GZZLUBTK'] },
    ]);
  });

  it('keeps only the start of a RealTime validity period, because TfL rolls its end forward every poll', () => {
    const realtime = compactStatus([
      {
        id: 'windrush',
        lineStatuses: [
          {
            statusSeverity: 3,
            statusSeverityDescription: 'Part Suspended',
            validityPeriods: [{ fromDate: '2026-09-02T21:03:01Z', toDate: '2026-09-03T00:54:21Z', isNow: true }],
            disruption: { category: 'RealTime' },
          },
        ],
      },
    ])?.[0]?.st[0];
    const planned = compactStatus([
      {
        id: 'district',
        lineStatuses: [
          {
            statusSeverity: 5,
            statusSeverityDescription: 'Part Closure',
            validityPeriods: [{ fromDate: '2026-09-05T02:30:00Z', toDate: '2026-09-07T00:29:00Z', isNow: false }],
            disruption: { category: 'PlannedWork' },
          },
        ],
      },
    ])?.[0]?.st[0];

    expect(realtime?.v).toEqual([{ f: '2026-09-02T21:03:01Z', n: true }]);
    expect(planned?.v).toEqual([{ f: '2026-09-05T02:30:00Z', t: '2026-09-07T00:29:00Z' }]);
  });

  it('serializes two polls of the same live suspension identically when only the rolling end moved', () => {
    const poll = (toDate: string) =>
      compactStatus([
        {
          id: 'windrush',
          lineStatuses: [
            {
              statusSeverity: 3,
              statusSeverityDescription: 'Part Suspended',
              reason: 'Windrush Line: No service between Clapham Junction and Surrey Quays.',
              validityPeriods: [{ fromDate: '2026-09-02T21:03:01Z', toDate, isNow: true }],
              disruption: { category: 'RealTime', closureText: 'partSuspended' },
            },
          ],
        },
      ]);

    expect(JSON.stringify(poll('2026-09-03T00:54:21Z'))).toBe(JSON.stringify(poll('2026-09-03T00:56:30Z')));
  });
});

// --- dedup guard on the window form (spec §14.4 item 1) ---------------------

describe('compactStatus dedup guard, two window-form polls 5 minutes apart', () => {
  // One live suspension (RealTime, rolling toDate) and one planned closure
  // (PlannedWork, fixed window), both with the structured fields the window
  // form returns — the archive row a real poll produces.
  const windowPoll = (realTimeToDate: string, plannedToDate: string) =>
    compactStatus([
      {
        id: 'windrush',
        lineStatuses: [
          {
            statusSeverity: 3,
            statusSeverityDescription: 'Part Suspended',
            reason: 'Windrush Line: No service between Clapham Junction and Surrey Quays.',
            validityPeriods: [{ fromDate: '2026-09-02T21:03:01Z', toDate: realTimeToDate, isNow: true }],
            disruption: {
              category: 'RealTime',
              closureText: 'partSuspended',
              affectedRoutes: [
                {
                  id: '4',
                  name: 'Highbury & Islington - Clapham Junction',
                  isEntireRouteSection: true,
                  routeSectionNaptanEntrySequence: [{ stopPoint: stop('910GHIGHBYA', 'Highbury & Islington') }],
                },
                {
                  id: '5',
                  isEntireRouteSection: false,
                  routeSectionNaptanEntrySequence: [
                    { stopPoint: stop('910GCLPHMJC', 'Clapham Junction') },
                    { stopPoint: stop('910GWNDSWRD', 'Wandsworth Road') },
                  ],
                },
              ],
              affectedStops: [stop('910GCLPHMJC', 'Clapham Junction'), stop('910GSURREYQ', 'Surrey Quays')],
            },
          },
        ],
      },
      {
        id: 'district',
        lineStatuses: [
          {
            statusSeverity: 5,
            statusSeverityDescription: 'Part Closure',
            reason: 'District Line: No service between Edgware Road and Wimbledon.',
            validityPeriods: [{ fromDate: '2026-09-05T02:30:00Z', toDate: plannedToDate, isNow: false }],
            disruption: {
              category: 'PlannedWork',
              closureText: 'partClosure',
              affectedRoutes: [
                {
                  id: '9',
                  isEntireRouteSection: false,
                  routeSectionNaptanEntrySequence: [
                    { stopPoint: stop('940GZZLUERC', 'Edgware Road') },
                    { stopPoint: stop('940GZZLUPAC', 'Paddington') },
                  ],
                },
              ],
            },
          },
        ],
      },
    ]);

  it('serializes identically when only the RealTime toDate rolled forward between the polls', () => {
    const first = windowPoll('2026-09-03T00:54:21Z', '2026-09-07T00:29:00Z');
    const fiveMinutesLater = windowPoll('2026-09-03T00:59:21Z', '2026-09-07T00:29:00Z');

    expect(JSON.stringify(fiveMinutesLater)).toBe(JSON.stringify(first));
  });

  it('serializes differently when a PlannedWork toDate changed — an edit the archive must keep', () => {
    const first = windowPoll('2026-09-03T00:54:21Z', '2026-09-07T00:29:00Z');
    const fiveMinutesLater = windowPoll('2026-09-03T00:54:21Z', '2026-09-08T00:29:00Z');

    expect(JSON.stringify(fiveMinutesLater)).not.toBe(JSON.stringify(first));
  });
});

// --- tube-status feed on the window form (spec §2.1 A, §14.4 item 2) --------

const DATA_DIR = fileURLToPath(new URL('../../data/', import.meta.url));

/** The 20 rail lines of data/manifest.json, sorted as loadBranchData yields them. */
const RAIL_LINE_IDS = [
  'bakerloo',
  'central',
  'circle',
  'district',
  'dlr',
  'elizabeth',
  'hammersmith-city',
  'jubilee',
  'liberty',
  'lioness',
  'metropolitan',
  'mildmay',
  'northern',
  'piccadilly',
  'suffragette',
  'tram',
  'victoria',
  'waterloo-city',
  'weaver',
  'windrush',
];

const MODE_PATH = `/Line/Mode/${STATUS_MODES.join(',')}/Status`;
const windowPath = (from: string, to: string): string =>
  `/Line/${RAIL_LINE_IDS.join(',')}/Status/${from}/to/${to}`;

const WINDOW_BODY = [
  {
    id: 'district',
    lineStatuses: [
      {
        statusSeverity: 5,
        statusSeverityDescription: 'Part Closure',
        reason: 'District Line: No service between Edgware Road and Wimbledon.',
        validityPeriods: [{ fromDate: '2026-09-05T02:30:00Z', toDate: '2026-09-07T00:29:00Z', isNow: false }],
        disruption: {
          category: 'PlannedWork',
          closureText: 'partClosure',
          affectedRoutes: [
            {
              id: '9',
              isEntireRouteSection: false,
              routeSectionNaptanEntrySequence: [
                { stopPoint: stop('940GZZLUERC', 'Edgware Road') },
                { stopPoint: stop('940GZZLUPAC', 'Paddington') },
              ],
            },
          ],
        },
      },
    ],
  },
];

const MODE_BODY = [{ id: 'victoria', lineStatuses: [{ statusSeverity: 10, statusSeverityDescription: 'Good Service' }] }];

const NOT_FOUND = { status: 404, body: { httpStatusCode: 404, message: 'not found' } };

/**
 * Routes fetch by pathname. An unlisted path answers 404, so a wrong URL fails
 * the test instead of passing by accident. Plain objects rather than Response
 * keep the body read free of stream machinery under fake timers.
 */
function stubFetchByPath(routes: Record<string, { status: number; body: unknown }>): URL[] {
  const urls: URL[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: URL | string) => {
      const url = new URL(String(input));
      urls.push(url);
      const route = routes[url.pathname] ?? NOT_FOUND;
      return { status: route.status, json: async () => route.body } as unknown as Response;
    }),
  );
  return urls;
}

describe('makeTubeStatusFeed', () => {
  const noLog = (): void => {};

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('keeps the feed identity the archive layout and the log lines depend on', () => {
    const feed = makeTubeStatusFeed(RAIL_LINE_IDS);

    expect(feed.label).toBe('tube-status');
    expect(feed.subdir).toBe('tube-status');
    expect(feed.payloadKey).toBe('lines');
    expect(feed.pollMs).toBe(2 * 60_000);
    expect(feed.heartbeatMs).toBe(30 * 60_000);
    expect(feed.compact).toBe(compactStatus);
  });

  it('asks the window form for every rail line from yesterday to a week ahead, with detail', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-03T12:00:00Z'));
    const expectedPath = windowPath('2026-09-02', '2026-09-10');
    const urls = stubFetchByPath({ [expectedPath]: { status: 200, body: WINDOW_BODY } });
    const logs: string[] = [];

    const response = await makeTubeStatusFeed(RAIL_LINE_IDS).fetchSnapshot('test-key', (msg) => logs.push(msg));

    expect(response).toEqual({ status: 200, body: WINDOW_BODY });
    expect(urls).toHaveLength(1);
    expect(urls[0]?.pathname).toBe(expectedPath);
    expect(urls[0]?.searchParams.get('detail')).toBe('true');
    expect(logs).toEqual([]);
  });

  it('bounds the window by the London calendar day, not the UTC one', async () => {
    // 23:30Z on 15 July is already 16 July in London; a UTC slice would ask 07-14 → 07-22.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-15T23:30:00Z'));
    const expectedPath = windowPath('2026-07-15', '2026-07-23');
    const urls = stubFetchByPath({ [expectedPath]: { status: 200, body: WINDOW_BODY } });

    await makeTubeStatusFeed(RAIL_LINE_IDS).fetchSnapshot('test-key', noLog);

    expect(urls[0]?.pathname).toBe(expectedPath);
  });

  it('falls back once to the Mode form when the window form is refused, and logs the refusal', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-03T12:00:00Z'));
    const urls = stubFetchByPath({ [MODE_PATH]: { status: 200, body: MODE_BODY } });
    const logs: string[] = [];

    const response = await makeTubeStatusFeed(RAIL_LINE_IDS).fetchSnapshot('test-key', (msg) => logs.push(msg));

    expect(response).toEqual({ status: 200, body: MODE_BODY });
    expect(urls.map((u) => u.pathname)).toEqual([windowPath('2026-09-02', '2026-09-10'), MODE_PATH]);
    expect(urls[1]?.searchParams.get('detail')).toBe('true');
    expect(logs).toEqual([`tube-status: window form returned 404, falling back to ${MODE_PATH}`]);
  });

  it("reaches the recorder's existing skip path when both forms fail, writing nothing", async () => {
    vi.useFakeTimers();
    stubFetchByPath({ [MODE_PATH]: { status: 503, body: { httpStatusCode: 503 } } });
    const dir = await mkdtemp(join(tmpdir(), 'tube-status-test-'));
    const logs: string[] = [];
    const recorder = new SnapshotRecorder(dir, 'test-key', (msg) => logs.push(msg), makeTubeStatusFeed(RAIL_LINE_IDS));

    try {
      recorder.start();
      await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS);

      expect(logs).toEqual([
        `tube-status: window form returned 404, falling back to ${MODE_PATH}`,
        'tube-status: TfL returned 503, skipping snapshot',
      ]);
      expect(await readdir(dir)).toEqual([]);
    } finally {
      recorder.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('compacts a window body into the same LineSnapshot shape the Mode form produced', () => {
    const lines = makeTubeStatusFeed(RAIL_LINE_IDS).compact(WINDOW_BODY);

    expect(lines).toEqual([
      {
        id: 'district',
        st: [
          {
            s: 5,
            d: 'Part Closure',
            r: 'District Line: No service between Edgware Road and Wimbledon.',
            v: [{ f: '2026-09-05T02:30:00Z', t: '2026-09-07T00:29:00Z' }],
            c: 'PlannedWork',
            ct: 'partClosure',
            ar: [{ id: '9', e: false, st: ['940GZZLUERC', '940GZZLUPAC'] }],
          },
        ],
      },
    ]);
  });
});

describe('statusLineIds', () => {
  it('selects exactly the 20 rail lines of data/manifest.json — no cable car, no river bus', () => {
    const branchData = loadBranchData(DATA_DIR, () => {});

    const ids = statusLineIds(branchData.lineIds, branchData.lineModeById);

    expect(ids).toEqual(RAIL_LINE_IDS);
  });

  it('drops a line whose mode is unknown rather than guessing', () => {
    const modeById = new Map([
      ['victoria', 'tube'],
      ['rb1', 'river-bus'],
    ]);

    const ids = statusLineIds(['rb1', 'unlisted', 'victoria'], modeById);

    expect(ids).toEqual(['victoria']);
  });
});
