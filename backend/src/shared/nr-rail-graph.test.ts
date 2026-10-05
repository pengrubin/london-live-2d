import { describe, expect, it } from 'vitest';
import type { LngLat } from './geometry';
import {
  NrRailGraph,
  segmentPolyFrom,
  trainPositionAt,
  type NrSegment,
  type NrStation,
  type NrTrackedTrain,
} from './nr-inference';

// National Rail segments carry one polyline per direction of travel: `poly`
// for a→b and, where the pair has a second track, `polyRev` for b→a (already
// oriented b→a). These pin that pathing between calling points picks the
// polyline of the direction actually travelled, and that the path cache
// never hands one direction the other's track.

const STATIONS: NrStation[] = [
  { crs: 'AAA', name: 'A', lat: 51.5, lon: -0.1 },
  { crs: 'BBB', name: 'B', lat: 51.5, lon: -0.09 },
  { crs: 'CCC', name: 'C', lat: 51.5, lon: -0.08 },
];

// A–B is double track: the a→b ("down") track runs 4 m north of the b→a one.
const AB_DOWN: LngLat[] = [
  [-0.1, 51.50002],
  [-0.095, 51.50002],
  [-0.09, 51.50002],
];
const AB_UP_FROM_B: LngLat[] = [
  [-0.09, 51.49998],
  [-0.095, 51.49998],
  [-0.1, 51.49998],
];
// B–C is single track: no polyRev. It leaves B from the end of the down track.
const BC: LngLat[] = [
  [-0.09, 51.50002],
  [-0.085, 51.5],
  [-0.08, 51.5],
];

const SEGMENTS: NrSegment[] = [
  { a: 'AAA', b: 'BBB', lenM: 700, poly: AB_DOWN, polyRev: AB_UP_FROM_B },
  { a: 'BBB', b: 'CCC', lenM: 700, poly: BC },
];

const reversed = (pts: LngLat[]): LngLat[] => [...pts].reverse();

describe('segmentPolyFrom', () => {
  it('a→b yields poly, b→a yields polyRev', () => {
    expect(segmentPolyFrom(SEGMENTS[0]!, 'AAA')).toEqual(AB_DOWN);
    expect(segmentPolyFrom(SEGMENTS[0]!, 'BBB')).toEqual(AB_UP_FROM_B);
  });

  it('a segment without polyRev yields the reversed poly for b→a', () => {
    expect(segmentPolyFrom(SEGMENTS[1]!, 'BBB')).toEqual(BC);
    expect(segmentPolyFrom(SEGMENTS[1]!, 'CCC')).toEqual(reversed(BC));
  });
});

describe('NrRailGraph.railPath — direction of travel', () => {
  it('uses poly from A to B and polyRev from B to A', () => {
    const graph = new NrRailGraph(STATIONS, SEGMENTS);
    expect(graph.railPath('AAA', 'BBB')).toEqual(AB_DOWN);
    expect(graph.railPath('BBB', 'AAA')).toEqual(AB_UP_FROM_B);
  });

  it('a single-track segment is the reversed poly in the b→a direction', () => {
    const graph = new NrRailGraph(STATIONS, SEGMENTS);
    expect(graph.railPath('BBB', 'CCC')).toEqual(BC);
    expect(graph.railPath('CCC', 'BBB')).toEqual(reversed(BC));
  });

  it('chains each segment in its own direction across a station', () => {
    const graph = new NrRailGraph(STATIONS, SEGMENTS);
    // A→C: down track to B, then B–C; the shared point at B appears once
    expect(graph.railPath('AAA', 'CCC')).toEqual([...AB_DOWN, ...BC.slice(1)]);
    // C→A: B–C reversed, then the up track — its first point differs from
    // the last one drawn, so both are kept (a short hop between tracks)
    expect(graph.railPath('CCC', 'AAA')).toEqual([...reversed(BC), ...AB_UP_FROM_B]);
  });

  it('the path cache does not return the other direction', () => {
    const graph = new NrRailGraph(STATIONS, SEGMENTS);
    expect(graph.railPath('AAA', 'BBB')).toEqual(AB_DOWN); // caches A>B
    expect(graph.railPath('BBB', 'AAA')).toEqual(AB_UP_FROM_B); // must not reuse A>B
    expect(graph.railPath('AAA', 'BBB')).toEqual(AB_DOWN); // cached A>B still a→b
    expect(graph.railPath('BBB', 'AAA')).toEqual(AB_UP_FROM_B); // cached B>A still b→a
  });

  it('files without polyRev keep working (both directions on poly)', () => {
    const legacy: NrSegment[] = [{ a: 'AAA', b: 'BBB', lenM: 700, poly: AB_DOWN }];
    const graph = new NrRailGraph(STATIONS, legacy);
    expect(graph.railPath('AAA', 'BBB')).toEqual(AB_DOWN);
    expect(graph.railPath('BBB', 'AAA')).toEqual(reversed(AB_DOWN));
  });
});

describe('trainPositionAt — per-direction track', () => {
  const T0 = Date.parse('2026-10-05T12:00:00Z');
  const MIN = 60_000;
  const train = (from: string, to: string): NrTrackedTrain => ({
    rid: `${from}-${to}`,
    operator: 'Test',
    destination: to,
    stops: [
      { crs: from, name: from, time: T0, rank: 2, seenAt: T0 },
      { crs: to, name: to, time: T0 + 2 * MIN, rank: 1, seenAt: T0 },
    ],
  });

  it('draws an a→b train on poly and a b→a train on polyRev', () => {
    const graph = new NrRailGraph(STATIONS, SEGMENTS);
    const down = trainPositionAt(train('AAA', 'BBB'), T0 + MIN, graph)!;
    const up = trainPositionAt(train('BBB', 'AAA'), T0 + MIN, graph)!;
    expect(down[1]).toBeCloseTo(51.50002, 6);
    expect(up[1]).toBeCloseTo(51.49998, 6);
    expect(down[0]).toBeCloseTo(-0.095, 6);
    expect(up[0]).toBeCloseTo(-0.095, 6);
  });

  it('the time ratio runs along the direction’s own polyline length', () => {
    // b→a track with a long kink: halfway in time is halfway along ITS length
    const kinked: LngLat[] = [
      [-0.09, 51.49998],
      [-0.09, 51.49],
      [-0.1, 51.49],
      [-0.1, 51.49998],
    ];
    const graph = new NrRailGraph(STATIONS, [{ a: 'AAA', b: 'BBB', lenM: 700, poly: AB_DOWN, polyRev: kinked }]);
    const mid = trainPositionAt(train('BBB', 'AAA'), T0 + MIN, graph)!;
    expect(mid[1]).toBeCloseTo(51.49, 6); // on the kink's far leg, not on poly
    expect(mid[0]).toBeGreaterThan(-0.1);
    expect(mid[0]).toBeLessThan(-0.09);
  });
});
