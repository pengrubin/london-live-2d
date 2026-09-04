import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildHopIndex, type HopIndex } from './line-graph';
import {
  canonicalSentence,
  renderClass,
  resolveSnapshot,
  type DisruptionItem,
  type ResolveContext,
} from './resolver';
import { loadBranchData } from '../leaderboard';
import type { LineSnapshot } from './tfl-status-shape';
import type { LineBranches } from '../shared/types';

// The committed baked data — the real branches the resolver validates against,
// never a hand-made copy, so a re-bake that moved a stop fails here loudly.
const DATA_DIR = fileURLToPath(new URL('../../../data/', import.meta.url));

/**
 * One real archived snapshot (data/tube-status/2026-09-03.jsonl, last row,
 * already through compactStatus, key-scrubbed): 12 non-Good statuses over 7
 * lines, five of them carrying structured NaPTAN ids. Every number below was
 * read off TfL's own fields — no sentence was parsed to produce any of it.
 */
const FIXTURE = JSON.parse(
  readFileSync(new URL('./fixtures/snapshot-2026-09-03.json', import.meta.url), 'utf8'),
) as { t: number; lines: LineSnapshot[] };

const branchData = loadBranchData(DATA_DIR, () => {});
const realCtx = (log: (msg: string) => void = () => {}): ResolveContext => ({
  hops: buildHopIndex(branchData.branchesByLine),
  modeById: branchData.lineModeById,
  log,
});

// ── measured on the 2026-09-03 snapshot ──
const EXPECTED_ITEMS = 12;
const DISTRICT_SECTION_IDS = [
  '940GZZLUECT', // Earl's Court
  '940GZZLUWBN',
  '940GZZLUFBY',
  '940GZZLUPSG',
  '940GZZLUPYB',
  '940GZZLUEPY',
  '940GZZLUSFS',
  '940GZZLUWIP',
  '940GZZLUWIM', // Wimbledon
];
const DISTRICT_STOP_COUNT = 14;
/** TfL published the same slice inbound and outbound, three times over. */
const DISTRICT_SECTION_COUNT = 2;

const stop = (id: string): { id: string; name: string; lon: number; lat: number } => ({
  id,
  name: id,
  lon: 0,
  lat: 0,
});

/** A synthetic line A-B-C-D with one off-line id (Z) available for the drop tests. */
const SYNTHETIC: LineBranches = {
  lineId: 'testline',
  branches: [
    {
      branchId: 0,
      direction: 'outbound',
      stops: ['A', 'B', 'C', 'D'].map(stop),
      segments: [[], [], []],
    },
  ],
};

function syntheticCtx(log: (msg: string) => void = () => {}): ResolveContext {
  const hops: HopIndex = buildHopIndex(new Map([['testline', SYNTHETIC]]));
  return { hops, modeById: new Map([['testline', 'tube']]), log };
}

const item = (items: readonly DisruptionItem[], lineId: string, severity: number): DisruptionItem => {
  const found = items.find((i) => i.l === lineId && i.s === severity);
  if (found === undefined) throw new Error(`no item for ${lineId} s=${severity}`);
  return found;
};

describe('resolveSnapshot on the real 2026-09-03 snapshot', () => {
  it('resolves one item per (line, sentence) and nothing for Good Service', () => {
    // Arrange — 20 lines, 12 of whose statuses are not Good Service / No Issues.
    // Act
    const { items, stats } = resolveSnapshot(FIXTURE.lines, realCtx());

    // Assert
    expect(items).toHaveLength(EXPECTED_ITEMS);
    expect(stats.items).toBe(EXPECTED_ITEMS);
    expect(items.every((i) => i.s !== 10 && i.s !== 18)).toBe(true);
    expect(items.map((i) => i.l)).toEqual([
      'central',
      'district',
      'elizabeth',
      'elizabeth',
      'suffragette',
      'suffragette',
      'waterloo-city',
      'weaver',
      'windrush',
      'windrush',
      'windrush',
      'windrush',
    ]);
  });

  it('draws the District closure as TfL published it: Earl’s Court to Wimbledon, 14 stops', () => {
    // Arrange / Act
    const { items } = resolveSnapshot(FIXTURE.lines, realCtx());
    const district = item(items, 'district', 5);

    // Assert — the 9-stop slice is TfL's own ordered id list, hop-validated.
    expect(district.sec).toHaveLength(DISTRICT_SECTION_COUNT);
    const wimbledon = district.sec.find((s) => s.st.length === DISTRICT_SECTION_IDS.length);
    expect(wimbledon?.st).toEqual(DISTRICT_SECTION_IDS);
    expect(wimbledon?.k).toBe('closed');
    // Inbound and outbound copies of one slice are one section, drawn once.
    expect(wimbledon?.dir).toBe('b');
    expect(district.pts).toHaveLength(DISTRICT_STOP_COUNT);
    expect(district.pts.every((p) => p.role === 'stop')).toBe(true);
    expect(district).toMatchObject({ k: 'closed', sc: 'section', src: 's', wl: 0, c: 'P', n: 0 });
  });

  it('leaves the Central minor delays at line scope, drawing nothing at all', () => {
    // Arrange — 10 affectedRoutes, every one isEntireRouteSection: true. TfL
    // attaches its whole route list to routine Minor Delays, so "every route
    // entire" is NOT evidence of a line-wide closure: §4 gates every route to
    // `wl` behind the CLOSED class, and §8.1 pins minor delays at `sc: line`.
    // Hatching the Central line for train cancellations would over-claim.
    // Act
    const { items } = resolveSnapshot(FIXTURE.lines, realCtx());
    const central = item(items, 'central', 9);

    // Assert
    expect(central).toMatchObject({ wl: 0, k: 'minor', sc: 'line', src: 'f', n: 1 });
    expect(central.sec).toEqual([]);
    expect(central.pts).toEqual([]);
    // The sentence still travels — as text, which is the whole fallback.
    expect(central.r).toContain('Minor delays');
  });

  it('makes the Waterloo & City weekend closure whole-line (spec §8.1)', () => {
    // Two affectedRoutes, both entire, AND severity 4 (Planned Closure) —
    // the two conjuncts §4 requires. Central has the same all-entire route
    // list but severity 9, which is exactly why the class gate exists.
    const { items } = resolveSnapshot(FIXTURE.lines, realCtx());
    const wc = item(items, 'waterloo-city', 4);

    expect(wc).toMatchObject({ wl: 1, k: 'closed', src: 's', c: 'I' });
    expect(wc.sec).toEqual([]);
    expect(wc.pts).toEqual([]);
  });

  it('hatches a closure whose affectedStops cover the line but whose slices drew nothing', () => {
    // Arrange — §4's third route to `wl`: a closed status with no drawable
    // section whose `as` names all but a tenth of the line's baked stops.
    const stops = [...(realCtx().hops.stopsByLine.get('waterloo-city') ?? [])];
    const snapshot = [
      {
        id: 'waterloo-city',
        st: [{ s: 3, d: 'Part Suspended', r: 'Waterloo & City line: no service.', as: stops }],
      },
    ];

    // Act
    const { items } = resolveSnapshot(snapshot, realCtx());

    // Assert
    expect(items[0]).toMatchObject({ wl: 1, k: 'closed', sc: 'section' });
    expect(items[0]?.pts).toEqual([]);
  });

  it('does NOT hatch a line-wide stop list when the severity is not a closure', () => {
    // Arrange — the same full stop list under Minor Delays. A rider must not
    // see the whole line hatched because TfL listed every station.
    const stops = [...(realCtx().hops.stopsByLine.get('waterloo-city') ?? [])];
    const snapshot = [
      {
        id: 'waterloo-city',
        st: [{ s: 9, d: 'Minor Delays', r: 'Waterloo & City line: minor delays.', as: stops }],
      },
    ];

    // Act
    const { items } = resolveSnapshot(snapshot, realCtx());

    // Assert — rings at the stops TfL named, and no whole-line claim.
    expect(items[0]).toMatchObject({ wl: 0, k: 'minor', sc: 'station' });
    expect(items[0]?.pts.length).toBe(stops.length);
  });

  it('validates every structured id and hop TfL sent — nothing is dropped', () => {
    // The whole tier rests on this: TfL's ids agree with the baked branches.
    const { stats } = resolveSnapshot(FIXTURE.lines, realCtx());

    expect(stats.sectionsDropped).toBe(0);
    expect(stats.stopsDropped).toBe(0);
    // district 2, elizabeth 2 + 2, suffragette 1 + 1, weaver 2, windrush 1 + 1 + 1.
    // TfL publishes the same slice once per service pattern (Elizabeth sends
    // one 3-id slice 16 times over); an undirected duplicate is drawn once.
    expect(stats.sections).toBe(13);
    expect(stats.stops).toBe(67);
  });

  it('caps the sentence and the description, and never leaks an upstream field', () => {
    const { items } = resolveSnapshot(FIXTURE.lines, realCtx());

    for (const i of items) {
      expect(i.r.length).toBeLessThanOrEqual(600);
      expect(i.d.length).toBeLessThanOrEqual(300);
      expect(Object.keys(i)).not.toContain('ar');
      expect(Object.keys(i)).not.toContain('as');
    }
  });
});

describe('structured section validation', () => {
  const sectioned = (st: string[], as: string[] = []): LineSnapshot[] => [
    {
      id: 'testline',
      st: [
        {
          s: 5,
          d: 'Part Closure',
          r: 'Testline: no service between A and D.',
          ar: [
            { id: '1', e: false, dir: 'outbound', st },
            { id: '2', e: false, dir: 'outbound', st: ['A', 'B'] },
          ],
          ...(as.length > 0 ? { as } : {}),
        },
      ],
    },
  ];

  it('drops ONLY the route entry whose hop is not a baked edge', () => {
    // Arrange — A→C skips B; the second entry (A→B) is a real hop.
    const logs: string[] = [];

    // Act
    const { items, stats } = resolveSnapshot(sectioned(['A', 'C']), syntheticCtx((m) => logs.push(m)));

    // Assert
    expect(stats.sectionsDropped).toBe(1);
    expect(items[0]?.sec).toEqual([{ st: ['A', 'B'], k: 'closed', dir: 'o' }]);
    expect(logs.join('\n')).toContain('bake-drift line=testline');
  });

  it('drops a route entry carrying an id that is not on the line', () => {
    const { items, stats } = resolveSnapshot(sectioned(['A', 'Z']), syntheticCtx());

    expect(stats.sectionsDropped).toBe(1);
    expect(items[0]?.sec).toHaveLength(1);
  });

  it('drops a route entry with fewer than two ids — one id is not a section', () => {
    const { items, stats } = resolveSnapshot(sectioned(['A']), syntheticCtx());

    expect(stats.sectionsDropped).toBe(1);
    expect(items[0]?.sec).toHaveLength(1);
  });

  it('keeps station rings only for ids the line actually calls at', () => {
    const { items, stats } = resolveSnapshot(sectioned(['A', 'B'], ['C', 'Z']), syntheticCtx());

    expect(items[0]?.pts).toEqual([{ id: 'C', role: 'stop' }]);
    expect(stats.stopsDropped).toBe(1);
  });

  it('names the refused stop in the log, so a drift is diagnosable without a repro', () => {
    // Arrange
    const logs: string[] = [];

    // Act
    resolveSnapshot(sectioned(['A', 'B'], ['C', 'Z']), syntheticCtx((m) => logs.push(m)));

    // Assert
    expect(logs.join('\n')).toContain('bake-drift line=testline stop=Z');
  });

  it('collapses an inbound/outbound pair of the same slice into one both-ways section', () => {
    const snapshot: LineSnapshot[] = [
      {
        id: 'testline',
        st: [
          {
            s: 5,
            d: 'Part Closure',
            r: 'Testline: no service between A and C.',
            ar: [
              { id: '1', e: false, dir: 'inbound', st: ['A', 'B', 'C'] },
              { id: '2', e: false, dir: 'outbound', st: ['C', 'B', 'A'] },
            ],
          },
        ],
      },
    ];

    const { items } = resolveSnapshot(snapshot, syntheticCtx());

    expect(items[0]?.sec).toEqual([{ st: ['A', 'B', 'C'], k: 'closed', dir: 'b' }]);
  });
});

describe('fallback and whole-line tiers', () => {
  const bare = (s: number, reason: string | undefined, extra = {}): LineSnapshot[] => [
    { id: 'testline', st: [{ s, d: 'Severe Delays', ...(reason === undefined ? {} : { r: reason }), ...extra }] },
  ];

  it('carries a status with no structured field as TEXT ONLY', () => {
    // Arrange — no affectedRoutes, no affectedStops: nothing may be drawn.
    const { items } = resolveSnapshot(bare(6, 'Severe delays somewhere between here and there.'), syntheticCtx());

    // Assert
    expect(items[0]).toMatchObject({ src: 'f', sc: 'line', wl: 0, k: 'severe' });
    expect(items[0]?.sec).toEqual([]);
    expect(items[0]?.pts).toEqual([]);
    expect(items[0]?.r).toContain('Severe delays');
  });

  it('never promotes an EMPTY affectedRoutes list to a whole-line closure', () => {
    // An absent structured field is not evidence of a line-wide closure.
    const { items } = resolveSnapshot(bare(6, 'Something happened.', { ar: [] }), syntheticCtx());

    expect(items[0]?.wl).toBe(0);
    expect(items[0]?.src).toBe('f');
  });

  it('hatches the whole line for Suspended and Service Closed severities', () => {
    for (const severity of [1, 2, 20]) {
      const { items } = resolveSnapshot(bare(severity, 'No service.'), syntheticCtx());
      expect(items[0]?.wl).toBe(1);
    }
  });

  it('drops a whole-line status’s stop list — a hatched line needs no rings', () => {
    const { items } = resolveSnapshot(bare(2, 'No service.', { as: ['A', 'B'] }), syntheticCtx());

    expect(items[0]).toMatchObject({ wl: 1, sc: 'section' });
    expect(items[0]?.pts).toEqual([]);
  });

  it('emits nothing for Good Service and No Issues', () => {
    const { items, stats } = resolveSnapshot(
      [{ id: 'testline', st: [{ s: 10, d: 'Good Service' }, { s: 18, d: 'No Issues' }] }],
      syntheticCtx(),
    );

    expect(items).toEqual([]);
    expect(stats.statuses).toBe(0);
  });
});

describe('renderClass', () => {
  it('maps every TfL severity code from the code table alone, never from text', () => {
    // Arrange — /Line/Meta/Severity is 0..20 (spec §4, measured D2).
    const byCode = Object.fromEntries([...Array(21).keys()].map((s) => [s, renderClass(s)]));

    // Assert
    expect(byCode).toEqual({
      0: 'closed',
      1: 'closed',
      2: 'closed',
      3: 'closed',
      4: 'closed',
      5: 'closed',
      6: 'severe',
      7: 'minor',
      8: 'minor',
      9: 'minor',
      10: 'info',
      11: 'closed',
      12: 'info',
      13: 'info',
      14: 'minor',
      15: 'minor',
      16: 'closed',
      17: 'info',
      18: 'info',
      19: 'info',
      20: 'closed',
    });
  });

  it('falls back to info for a severity TfL has not published yet', () => {
    expect(renderClass(99)).toBe('info');
  });
});

describe('merging by (line, sentence)', () => {
  const twoStatuses: LineSnapshot[] = [
    {
      id: 'testline',
      st: [
        {
          s: 5,
          d: 'Part Closure',
          ct: 'partClosure',
          c: 'PlannedWork',
          r: 'Testline: no service between A and C.',
          ar: [{ id: '1', e: false, dir: 'inbound', st: ['A', 'B'] }],
          as: ['A'],
          v: [{ f: '2026-09-05T02:30:00Z', t: '2026-09-07T00:29:00Z' }],
        },
        {
          s: 6,
          d: 'Severe Delays',
          ct: 'severeDelays',
          c: 'RealTime',
          r: '  TESTLINE:  no service  between A and C. ',
          ar: [{ id: '2', e: false, dir: 'outbound', st: ['C', 'D'] }],
          as: ['D'],
          v: [{ f: '2026-09-05T02:30:00Z', t: '2026-09-07T00:29:00Z' }, { f: '2026-09-08T02:30:00Z' }],
        },
      ],
    },
  ];

  it('merges two statuses whose sentences differ only in case and whitespace', () => {
    // Act
    const { items } = resolveSnapshot(twoStatuses, syntheticCtx());

    // Assert — one item, the union of both geometries, the worst severity.
    expect(items).toHaveLength(1);
    expect(items[0]?.sec.map((s) => s.st)).toEqual([
      ['A', 'B'],
      ['C', 'D'],
    ]);
    expect(items[0]?.pts).toEqual([
      { id: 'A', role: 'stop' },
      { id: 'D', role: 'stop' },
    ]);
    expect(items[0]).toMatchObject({ s: 5, d: 'Part Closure', k: 'closed' });
  });

  it('tags each merged section with ITS OWN carrying status’s class', () => {
    const { items } = resolveSnapshot(twoStatuses, syntheticCtx());

    expect(items[0]?.sec.map((s) => s.k)).toEqual(['closed', 'severe']);
  });

  it('deduplicates validity periods, earliest first', () => {
    const { items } = resolveSnapshot(twoStatuses, syntheticCtx());

    expect(items[0]?.v).toEqual([
      { f: '2026-09-05T02:30:00Z', t: '2026-09-07T00:29:00Z' },
      { f: '2026-09-08T02:30:00Z' },
    ]);
  });
});

describe('item id', () => {
  const withDates = (from: string, reason: string): LineSnapshot[] => [
    {
      id: 'testline',
      st: [{ s: 5, d: 'Part Closure', ct: 'partClosure', r: reason, v: [{ f: from }] }],
    },
  ];
  const SENTENCE = 'Testline: no service between A and C.';

  it('is stable when TfL rewrites fromDate mid-incident (no date in the id)', () => {
    // Arrange — the same sentence, a rewritten validity start.
    const first = resolveSnapshot(withDates('2026-09-03T19:09:31Z', SENTENCE), syntheticCtx());
    const second = resolveSnapshot(withDates('2026-09-03T21:03:01Z', SENTENCE), syntheticCtx());

    // Assert
    expect(first.items[0]?.id).toBe(second.items[0]?.id);
    expect(first.items[0]?.id).toMatch(/^testline:[0-9a-f]{8}:partClosure$/);
  });

  it('is stable across case and whitespace edits, and changes with the sentence', () => {
    const base = resolveSnapshot(withDates('2026-09-03T19:09:31Z', SENTENCE), syntheticCtx());
    const noisy = resolveSnapshot(
      withDates('2026-09-03T19:09:31Z', ' TESTLINE:  no service between A and  C. '),
      syntheticCtx(),
    );
    const other = resolveSnapshot(
      withDates('2026-09-03T19:09:31Z', 'Testline: no service between B and D.'),
      syntheticCtx(),
    );

    expect(noisy.items[0]?.id).toBe(base.items[0]?.id);
    expect(other.items[0]?.id).not.toBe(base.items[0]?.id);
  });

  it('says `none` when TfL sent no closureText', () => {
    const snapshot: LineSnapshot[] = [
      { id: 'testline', st: [{ s: 9, d: 'Minor Delays', r: SENTENCE }] },
    ];

    expect(resolveSnapshot(snapshot, syntheticCtx()).items[0]?.id).toMatch(/:none$/);
  });
});

describe('canonicalSentence', () => {
  it('normalises case, whitespace and quoting only — it does not parse', () => {
    expect(canonicalSentence("  District Line:  Earl’s Court  ")).toBe(
      'district line: earls court',
    );
  });

  it('strips HTML so a tag edit does not churn every item id', () => {
    expect(canonicalSentence('No service <a href="x">here</a>.')).toBe('no service here');
  });
});
