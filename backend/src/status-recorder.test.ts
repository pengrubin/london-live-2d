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
