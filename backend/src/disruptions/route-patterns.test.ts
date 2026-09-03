import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadBranchData } from '../leaderboard';
import { loadRoutePatterns, type Pattern, type PatternDirection } from './route-patterns';
import type { LineBranches } from '../shared/types';

// The committed baked data — these tests pin what TfL actually publishes, so
// they run against data/ itself, never a fixture copy (§5.4: a row whose baked
// value differs from the spec is a P0 finding, not a test to relax).
const DATA_DIR = fileURLToPath(new URL('../../../data/', import.meta.url));

const RAIL_LINE_IDS = [
  'bakerloo',
  'central',
  'circle',
  'district',
  'hammersmith-city',
  'jubilee',
  'metropolitan',
  'northern',
  'piccadilly',
  'victoria',
  'waterloo-city',
  'dlr',
  'elizabeth',
  'liberty',
  'lioness',
  'mildmay',
  'suffragette',
  'weaver',
  'windrush',
  'tram',
] as const;

// ── measured on the 2026-09-03 bake ──
const MEASURED_DROPPED_HOPS = 0;
// TfL's real Circle patterns are NOT rings that list the endpoint at both ends
// (the shape the spec inferred from data/branches/circle.json): each direction
// is one 37-stop Hammersmith → Edgware Road → ring → Edgware Road run in which
// only Edgware Road (Circle Line) repeats. The closest-pair rule's premise (an
// endpoint listed twice in one pattern) therefore holds for that id alone.
const CIRCLE_PATTERN_STOPS = 37;
const CIRCLE_REPEATED_ID = '940GZZLUERC';
const CIRCLE_REPEATED_AT: Record<string, number[]> = { inbound: [0, 27], outbound: [9, 36] };

/** Two stops that are consecutive on a real branch, and one pair that is not. */
const STOP_A = { id: 'A', name: 'A', lon: 0, lat: 0 };
const STOP_B = { id: 'B', name: 'B', lon: 0, lat: 1 };
const STOP_C = { id: 'C', name: 'C', lon: 0, lat: 2 };
const SYNTHETIC_LINE: LineBranches = {
  lineId: 'synthetic',
  branches: [
    { branchId: 0, direction: 'outbound', stops: [STOP_A, STOP_B, STOP_C], segments: [[], []] },
  ],
};

function indexesOf(ids: readonly string[], id: string): number[] {
  return ids.flatMap((candidate, i) => (candidate === id ? [i] : []));
}

/**
 * Inclusive stop count between the CLOSEST occurrences of aId and bId in one
 * pattern (the §5.4 closest-pair rule: a ring listing its endpoint twice must
 * never yield the wrap-around). null when either id is absent.
 */
function stopsBetween(ids: readonly string[], aId: string, bId: string): number | null {
  const aAt = indexesOf(ids, aId);
  const bAt = indexesOf(ids, bId);
  if (aAt.length === 0 || bAt.length === 0) return null;
  const distances = aAt.flatMap((i) => bAt.map((j) => Math.abs(i - j) + 1));
  return Math.min(...distances);
}

/** stopsBetween for every pattern containing both ids (and `via`, when given), with its direction. */
function stopCounts(
  patterns: readonly Pattern[],
  aId: string,
  bId: string,
  via?: string,
): { dir: PatternDirection; stops: number }[] {
  return patterns
    .filter((p) => via === undefined || p.ids.includes(via))
    .flatMap((p) => {
      const stops = stopsBetween(p.ids, aId, bId);
      return stops === null ? [] : [{ dir: p.dir, stops }];
    });
}

/** Minimum over the line's patterns containing both ids; null when none does. */
function minStopsOnLine(
  patterns: readonly Pattern[],
  aId: string,
  bId: string,
  via?: string,
): number | null {
  const counts = stopCounts(patterns, aId, bId, via).map((c) => c.stops);
  return counts.length === 0 ? null : Math.min(...counts);
}

function indexesIn(patterns: readonly Pattern[], dir: PatternDirection, id: string): number[][] {
  return patterns.filter((p) => p.dir === dir).map((p) => indexesOf(p.ids, id));
}

/** Ids listed more than once in a pattern. */
function repeatedIds(ids: readonly string[]): string[] {
  return [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
}

function stationIdsOf(lineId: string): Set<string> {
  const file = JSON.parse(readFileSync(join(DATA_DIR, 'stations', `${lineId}.json`), 'utf8')) as {
    features: { properties: { id: string } }[];
  };
  return new Set(file.features.map((f) => f.properties.id));
}

function branchStopIdsOf(line: LineBranches): Set<string> {
  return new Set(line.branches.flatMap((b) => b.stops.map((s) => s.id)));
}

describe('loadRoutePatterns hop validation (synthetic data)', () => {
  let dataDir: string;
  let logged: string[];
  const log = (msg: string): void => {
    logged = [...logged, msg];
  };
  const branchesByLine = new Map([[SYNTHETIC_LINE.lineId, SYNTHETIC_LINE]]);

  const writePatterns = async (patterns: unknown[]): Promise<void> => {
    await mkdir(join(dataDir, 'route-patterns'), { recursive: true });
    await writeFile(
      join(dataDir, 'route-patterns', 'synthetic.json'),
      JSON.stringify({ lineId: 'synthetic', bakedAt: '2026-09-03T00:00:00.000Z', patterns }),
    );
  };

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'route-patterns-test-'));
    logged = [];
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('keeps a pattern whose every hop is a branch edge, in either direction', async () => {
    // Arrange — C > B > A walks branch 0 backwards; edges are undirected.
    await writePatterns([{ dir: 'inbound', name: 'C to A', ids: ['C', 'B', 'A'] }]);

    // Act
    const result = loadRoutePatterns(dataDir, branchesByLine, log);

    // Assert
    expect(result.patterns.get('synthetic')).toEqual([
      { dir: 'inbound', name: 'C to A', ids: ['C', 'B', 'A'] },
    ]);
    expect(result.loaded).toBe(1);
    expect(result.dropped).toBe(0);
    expect(logged).toEqual([]);
  });

  it('drops a pattern with a hop that is not a branch edge and logs the pair and line', async () => {
    // Arrange — A > C skips B, so it is not a consecutive-stop pair on any branch.
    await writePatterns([
      { dir: 'outbound', name: 'good', ids: ['A', 'B'] },
      { dir: 'outbound', name: 'skips B', ids: ['A', 'C'] },
    ]);

    // Act
    const result = loadRoutePatterns(dataDir, branchesByLine, log);

    // Assert
    expect(result.patterns.get('synthetic')?.map((p) => p.name)).toEqual(['good']);
    expect(result.loaded).toBe(1);
    expect(result.dropped).toBe(1);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('synthetic');
    expect(logged[0]).toContain('A > C');
  });

  it('drops a malformed pattern (unknown direction, too few ids) instead of trusting the file', async () => {
    // Arrange
    await writePatterns([
      { dir: 'sideways', name: 'bad dir', ids: ['A', 'B'] },
      { dir: 'inbound', name: 'one stop', ids: ['A'] },
    ]);

    // Act
    const result = loadRoutePatterns(dataDir, branchesByLine, log);

    // Assert — a line with zero valid patterns has no Tier 1 geometry (§5.4).
    expect(result.patterns.has('synthetic')).toBe(false);
    expect(result.dropped).toBe(2);
    expect(logged).toHaveLength(2);
  });

  it('gives a line with no file no patterns and exactly one log line', () => {
    // Arrange — nothing written under dataDir.

    // Act
    const result = loadRoutePatterns(dataDir, branchesByLine, log);

    // Assert
    expect(result.patterns.size).toBe(0);
    expect(result.loaded).toBe(0);
    expect(result.dropped).toBe(0);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('synthetic');
  });
});

describe('committed data/route-patterns against data/branches', () => {
  // Arrange (shared): the real branches, the real files, a silent log we inspect.
  const logged: string[] = [];
  const { branchesByLine } = loadBranchData(DATA_DIR, () => {});
  const result = loadRoutePatterns(DATA_DIR, branchesByLine, (msg) => logged.push(msg));
  const patternsOf = (lineId: string): Pattern[] => result.patterns.get(lineId) ?? [];

  it('has a baked file for every one of the 20 rail lines', () => {
    const files = readdirSync(join(DATA_DIR, 'route-patterns')).sort();

    expect(files).toEqual([...RAIL_LINE_IDS].map((id) => `${id}.json`).sort());
  });

  it('loads every rail line with the measured number of dropped hops', () => {
    for (const lineId of RAIL_LINE_IDS) {
      expect(result.patterns.get(lineId)?.length ?? 0, lineId).toBeGreaterThan(0);
    }
    expect(result.dropped).toBe(MEASURED_DROPPED_HOPS);
    expect(logged.filter((l) => l.includes('not a branch edge'))).toHaveLength(MEASURED_DROPPED_HOPS);
  });

  it('lists only station ids that are on the line — no HUB ids in naptanIds', () => {
    for (const lineId of RAIL_LINE_IDS) {
      const line = branchesByLine.get(lineId);
      if (!line) throw new Error(`branches missing for ${lineId}`);
      const known = new Set([...branchStopIdsOf(line), ...stationIdsOf(lineId)]);
      const unknown = patternsOf(lineId).flatMap((p) => p.ids.filter((id) => !known.has(id)));

      expect(unknown, lineId).toEqual([]);
    }
  });

  it('circle: one 37-stop pattern per direction, never the same id at both ends', () => {
    const circle = patternsOf('circle');

    expect(circle.map((p) => p.dir).sort()).toEqual(['inbound', 'outbound']);
    for (const p of circle) {
      expect(p.ids, p.name).toHaveLength(CIRCLE_PATTERN_STOPS);
      expect(p.ids[0], p.name).not.toBe(p.ids[p.ids.length - 1]);
    }
  });

  it('circle: Edgware Road (Circle Line) is the only repeated id, at the measured indices', () => {
    const circle = patternsOf('circle');

    for (const p of circle) expect(repeatedIds(p.ids), p.name).toEqual([CIRCLE_REPEATED_ID]);
    expect(indexesIn(circle, 'inbound', CIRCLE_REPEATED_ID)).toEqual([CIRCLE_REPEATED_AT['inbound']]);
    expect(indexesIn(circle, 'outbound', CIRCLE_REPEATED_ID)).toEqual([CIRCLE_REPEATED_AT['outbound']]);
  });

  // §5.4 table rows. `spec` is what the spec expected; the assertion pins the
  // value measured on the baked files (differences are P0 findings, reported
  // in measurements.tableDiffs — never fixed by editing data). `measured` is
  // the MINIMUM over patterns, so a fast pattern that skips a stop wins.
  const ROWS: {
    label: string;
    line: string;
    from: string;
    to: string;
    via?: string;
    spec: number;
    measured: number;
  }[] = [
    { label: 'circle Hammersmith → Paddington (H&C)', line: 'circle', from: '940GZZLUHSC', to: '940GZZLUPAH', spec: 9, measured: 9 },
    { label: 'circle Hammersmith → Paddington (main, the twin-rule trap)', line: 'circle', from: '940GZZLUHSC', to: '940GZZLUPAC', spec: 36, measured: 36 },
    { label: 'circle Hammersmith → Baker Street', line: 'circle', from: '940GZZLUHSC', to: '940GZZLUBST', spec: 11, measured: 11 },
    { label: 'circle Edgware Road → Paddington (H&C), closest pair', line: 'circle', from: '940GZZLUERC', to: '940GZZLUPAH', spec: 2, measured: 2 },
    { label: 'circle Edgware Road → Baker Street, closest pair', line: 'circle', from: '940GZZLUERC', to: '940GZZLUBST', spec: 2, measured: 2 },
    { label: 'district Edgware Road → Wimbledon', line: 'district', from: '940GZZLUERC', to: '940GZZLUWIM', spec: 14, measured: 14 },
    { label: 'metropolitan Harrow-on-the-Hill → Aldgate', line: 'metropolitan', from: '940GZZLUHOH', to: '940GZZLUALD', spec: 15, measured: 14 },
    { label: 'metropolitan Baker Street → Harrow-on-the-Hill', line: 'metropolitan', from: '940GZZLUBST', to: '940GZZLUHOH', spec: 7, measured: 6 },
    { label: 'central Leytonstone → Epping', line: 'central', from: '940GZZLULYS', to: '940GZZLUEPG', spec: 9, measured: 9 },
    { label: 'dlr Poplar → Bank', line: 'dlr', from: '940GZZDLPOP', to: '940GZZDLBNK', spec: 5, measured: 5 },
    { label: 'windrush Highbury & Islington → West Croydon', line: 'windrush', from: '910GHGHI', to: '910GWCROYDN', spec: 21, measured: 21 },
    { label: 'elizabeth Hayes & Harlington → Heathrow Terminal 4', line: 'elizabeth', from: '910GHAYESAH', to: '910GHTRWTM4', spec: 3, measured: 3 },
    { label: 'elizabeth Hayes & Harlington → Heathrow Terminal 5', line: 'elizabeth', from: '910GHAYESAH', to: '910GHTRWTM5', spec: 3, measured: 3 },
    { label: 'dlr Stratford International → Woolwich Arsenal', line: 'dlr', from: '940GZZDLSIT', to: '940GZZDLWLA', spec: 12, measured: 12 },
    { label: 'dlr Canning Town → Stratford International', line: 'dlr', from: '940GZZDLCGT', to: '940GZZDLSIT', spec: 7, measured: 7 },
    { label: 'northern Camden Town → Kennington via Bank', line: 'northern', from: '940GZZLUCTN', to: '940GZZLUKNG', via: '940GZZLUBNK', spec: 11, measured: 11 },
    { label: 'northern Camden Town → Kennington via Charing Cross', line: 'northern', from: '940GZZLUCTN', to: '940GZZLUKNG', via: '940GZZLUCHX', spec: 11, measured: 11 },
    { label: 'northern Colindale → Battersea Power Station', line: 'northern', from: '940GZZLUCND', to: '940GZZBPSUST', spec: 20, measured: 20 },
    { label: 'northern Morden → Camden Town', line: 'northern', from: '940GZZLUMDN', to: '940GZZLUCTN', spec: 22, measured: 22 },
    { label: 'piccadilly Acton Town → Heathrow Terminal 4', line: 'piccadilly', from: '940GZZLUACT', to: '940GZZLUHR4', spec: 11, measured: 10 },
  ];

  it.each(ROWS)('$label: $measured stops (spec $spec)', (row) => {
    expect(minStopsOnLine(patternsOf(row.line), row.from, row.to, row.via)).toBe(row.measured);
  });

  it('metropolitan: the all-stations 15 / 7-stop patterns exist, but only outbound (Amersham ↔ Aldgate)', () => {
    // The spec's "skip-stop nesting in both directions" premise: inbound has
    // only 14 / 6-stop fast patterns, so the 15 / 7 superset can come from the
    // cross-direction step alone (§5.4 step 3), never from inbound nesting.
    const met = patternsOf('metropolitan');
    const harrowAldgate = stopCounts(met, '940GZZLUHOH', '940GZZLUALD');
    const bakerHarrow = stopCounts(met, '940GZZLUBST', '940GZZLUHOH');

    expect(harrowAldgate.filter((c) => c.stops === 15).map((c) => c.dir)).toEqual(['outbound']);
    expect(harrowAldgate.filter((c) => c.dir === 'inbound').map((c) => c.stops)).toEqual([14, 14, 14, 14]);
    expect(bakerHarrow.filter((c) => c.stops === 7).map((c) => c.dir)).toEqual(['outbound']);
    expect(bakerHarrow.filter((c) => c.dir === 'inbound').map((c) => c.stops)).toEqual([6, 6, 6, 6]);
  });

  it('northern: the via-Bank slice never contains Mornington Crescent', () => {
    const MORNINGTON_CRESCENT = '940GZZLUMTC';
    const viaBank = patternsOf('northern').filter((p) => p.ids.includes('940GZZLUBNK'));

    expect(viaBank.length).toBeGreaterThan(0);
    for (const p of viaBank) expect(p.ids, p.name).not.toContain(MORNINGTON_CRESCENT);
  });

  it('piccadilly: Acton Town → Heathrow Terminal 4 is 10 stops inbound and 11 outbound (T4 loop)', () => {
    // One Terminal 4 pattern per direction; the outbound run passes Terminals
    // 2 & 3 before Terminal 4, the inbound run reaches Terminal 4 directly.
    const counts = stopCounts(patternsOf('piccadilly'), '940GZZLUACT', '940GZZLUHR4');

    expect(counts.sort((a, b) => a.dir.localeCompare(b.dir))).toEqual([
      { dir: 'inbound', stops: 10 },
      { dir: 'outbound', stops: 11 },
    ]);
  });
});
