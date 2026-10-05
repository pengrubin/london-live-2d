// Frontend copy of backend/src/shared/nr-rail-graph.test.ts (the primary
// suite): National Rail segments carry one polyline per direction of travel
// — `poly` for a→b, `polyRev` (already oriented b→a) where the pair has a
// second track — and pathing between calling points must use the polyline of
// the direction travelled, with the path cache keeping the two apart.
//
// nr-trains.ts value-imports maplibre-gl (Popup), so that module is stubbed to
// keep the test in the fast node environment — same pattern as nr-trains.test.ts.
import { describe, expect, test, vi } from 'vitest';
import { pointAtFraction, type LngLat } from './geometry';

vi.mock('maplibre-gl', () => ({ Popup: class {} }));

const { createRailPather, segmentPolyFrom } = await import('./nr-trains');
type NrSegment = Parameters<typeof createRailPather>[0][number];

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

describe('segmentPolyFrom (frontend copy)', () => {
  test('a→b yields poly, b→a yields polyRev', () => {
    expect(segmentPolyFrom(SEGMENTS[0], 'AAA')).toEqual(AB_DOWN);
    expect(segmentPolyFrom(SEGMENTS[0], 'BBB')).toEqual(AB_UP_FROM_B);
  });

  test('a segment without polyRev yields the reversed poly for b→a', () => {
    expect(segmentPolyFrom(SEGMENTS[1], 'BBB')).toEqual(BC);
    expect(segmentPolyFrom(SEGMENTS[1], 'CCC')).toEqual(reversed(BC));
  });
});

describe('createRailPather (frontend copy) — direction of travel', () => {
  test('uses poly from A to B and polyRev from B to A', () => {
    const railPath = createRailPather(SEGMENTS);
    expect(railPath('AAA', 'BBB')).toEqual(AB_DOWN);
    expect(railPath('BBB', 'AAA')).toEqual(AB_UP_FROM_B);
  });

  test('a single-track segment is the reversed poly in the b→a direction', () => {
    const railPath = createRailPather(SEGMENTS);
    expect(railPath('BBB', 'CCC')).toEqual(BC);
    expect(railPath('CCC', 'BBB')).toEqual(reversed(BC));
  });

  test('chains each segment in its own direction across a station', () => {
    const railPath = createRailPather(SEGMENTS);
    expect(railPath('AAA', 'CCC')).toEqual([...AB_DOWN, ...BC.slice(1)]);
    expect(railPath('CCC', 'AAA')).toEqual([...reversed(BC), ...AB_UP_FROM_B]);
  });

  test('the path cache does not return the other direction', () => {
    const railPath = createRailPather(SEGMENTS);
    expect(railPath('AAA', 'BBB')).toEqual(AB_DOWN);
    expect(railPath('BBB', 'AAA')).toEqual(AB_UP_FROM_B);
    expect(railPath('AAA', 'BBB')).toEqual(AB_DOWN);
    expect(railPath('BBB', 'AAA')).toEqual(AB_UP_FROM_B);
  });

  test('files without polyRev keep working (both directions on poly)', () => {
    const railPath = createRailPather([{ a: 'AAA', b: 'BBB', lenM: 700, poly: AB_DOWN }]);
    expect(railPath('AAA', 'BBB')).toEqual(AB_DOWN);
    expect(railPath('BBB', 'AAA')).toEqual(reversed(AB_DOWN));
  });

  test('the midpoint in time sits on each direction’s own track', () => {
    const railPath = createRailPather(SEGMENTS);
    expect(pointAtFraction(railPath('AAA', 'BBB')!, 0.5).lngLat[1]).toBeCloseTo(51.50002, 6);
    expect(pointAtFraction(railPath('BBB', 'AAA')!, 0.5).lngLat[1]).toBeCloseTo(51.49998, 6);
  });
});
