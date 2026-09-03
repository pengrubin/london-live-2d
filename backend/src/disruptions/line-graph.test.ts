import { describe, expect, it } from 'vitest';
import { buildHopIndex, firstBadHop, isHop, isLineStop } from './line-graph';
import type { LineBranches } from '../shared/types';

const stop = (id: string, lat: number): { id: string; name: string; lon: number; lat: number } => ({
  id,
  name: id,
  lon: 0,
  lat,
});

/** Two branches sharing A: A-B-C and A-D. C and D are never adjacent. */
const LINE: LineBranches = {
  lineId: 'testline',
  branches: [
    {
      branchId: 0,
      direction: 'outbound',
      stops: [stop('A', 0), stop('B', 1), stop('C', 2)],
      segments: [[], []],
    },
    { branchId: 1, direction: 'inbound', stops: [stop('A', 0), stop('D', 3)], segments: [[]] },
  ],
};

const OTHER_LINE: LineBranches = {
  lineId: 'otherline',
  branches: [
    { branchId: 0, direction: 'outbound', stops: [stop('X', 0), stop('Y', 1)], segments: [[]] },
  ],
};

const index = buildHopIndex(new Map([LINE, OTHER_LINE].map((line) => [line.lineId, line])));

describe('isHop', () => {
  it('accepts a consecutive branch pair in both directions', () => {
    // Arrange — A-B is a baked consecutive pair on branch 0.
    // Act / Assert — the index is undirected, so both orders hold.
    expect(isHop(index, 'testline', 'A', 'B')).toBe(true);
    expect(isHop(index, 'testline', 'B', 'A')).toBe(true);
  });

  it('rejects a pair that skips a stop', () => {
    // Arrange — A and C are on one branch but not adjacent.
    expect(isHop(index, 'testline', 'A', 'C')).toBe(false);
  });

  it('rejects a pair whose stops sit on different branches of the line', () => {
    // C (branch 0) and D (branch 1) are both on the line and never adjacent:
    // a graph search would join them through A, an edge index must not.
    expect(isHop(index, 'testline', 'C', 'D')).toBe(false);
  });

  it('rejects an edge that belongs to a DIFFERENT line', () => {
    // Arrange — X-Y is a real hop, but not of testline.
    expect(isHop(index, 'otherline', 'X', 'Y')).toBe(true);
    expect(isHop(index, 'testline', 'X', 'Y')).toBe(false);
  });

  it('rejects every pair on an unknown line rather than falling back to another', () => {
    expect(isHop(index, 'not-a-line', 'A', 'B')).toBe(false);
  });
});

describe('isLineStop', () => {
  it('knows the stops of each line and keeps the lines apart', () => {
    expect(isLineStop(index, 'testline', 'D')).toBe(true);
    expect(isLineStop(index, 'testline', 'X')).toBe(false);
    expect(isLineStop(index, 'not-a-line', 'A')).toBe(false);
  });
});

describe('firstBadHop', () => {
  it('returns null when every consecutive pair is an edge', () => {
    expect(firstBadHop(index, 'testline', ['C', 'B', 'A', 'D'])).toBeNull();
  });

  it('returns the FIRST offending pair so the log names one cause, not all of them', () => {
    // Arrange — two bad hops; only the first is reported.
    const ids = ['A', 'C', 'X'];

    // Act
    const bad = firstBadHop(index, 'testline', ids);

    // Assert
    expect(bad).toEqual(['A', 'C']);
  });

  it('treats a list shorter than one hop as having no bad hop', () => {
    expect(firstBadHop(index, 'testline', ['A'])).toBeNull();
  });
});
