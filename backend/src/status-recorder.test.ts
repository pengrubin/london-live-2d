import { describe, expect, it } from 'vitest';
import { compactDisruptions, compactStatus, shouldWrite } from './status-recorder';

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
