import { describe, expect, test } from 'vitest';
import {
  addContributor,
  CONTRIBUTOR_SLOTS,
  encodeContributors,
  growContributorSlots,
  makeContributorSlots,
  parseContributors,
  routeLabel,
  unionContributors,
} from './coverage-contributors';

/** Slot contents of one piece as [route, journeys] pairs, slot order. */
function slotsOf(
  slots: ReturnType<typeof makeContributorSlots>,
  piece: number,
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let s = 0; s < (slots.count[piece] ?? 0); s += 1) {
    const i = piece * CONTRIBUTOR_SLOTS + s;
    out.push([slots.route[i] ?? -1, slots.journeys[i] ?? -1]);
  }
  return out;
}

describe('contributor slots', () => {
  test('fill: the first K routes take consecutive slots of their piece only', () => {
    const slots = makeContributorSlots(4);

    addContributor(slots, 2, 7, 30);
    addContributor(slots, 2, 9, 12);

    expect(slotsOf(slots, 2)).toEqual([
      [7, 30],
      [9, 12],
    ]);
    expect(slots.count[1]).toBe(0);
    expect(slots.count[3]).toBe(0);
  });

  test('full piece: a larger newcomer evicts the smallest slot', () => {
    const slots = makeContributorSlots(1);
    for (let r = 0; r < CONTRIBUTOR_SLOTS; r += 1) addContributor(slots, 0, r, 10 + r);
    // slot 0 holds the minimum (route 0, 10/day)

    addContributor(slots, 0, 99, 50);

    const held = slotsOf(slots, 0);
    expect(held).toHaveLength(CONTRIBUTOR_SLOTS);
    expect(held.map(([r]) => r)).not.toContain(0);
    expect(held).toContainEqual([99, 50]);
  });

  test('full piece: a newcomer no larger than the smallest is dropped', () => {
    const slots = makeContributorSlots(1);
    for (let r = 0; r < CONTRIBUTOR_SLOTS; r += 1) addContributor(slots, 0, r, 10 + r);
    const before = slotsOf(slots, 0);

    addContributor(slots, 0, 98, 10); // ties the minimum — not larger
    addContributor(slots, 0, 99, 3);

    expect(slotsOf(slots, 0)).toEqual(before);
  });

  test('busiest-first input keeps exactly the top K', () => {
    const slots = makeContributorSlots(1);
    for (let r = 0; r < CONTRIBUTOR_SLOTS + 4; r += 1) addContributor(slots, 0, r, 100 - r);

    expect(slotsOf(slots, 0).map(([r]) => r)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  test('growing keeps every filled slot', () => {
    const slots = makeContributorSlots(2);
    addContributor(slots, 1, 4, 20);

    const grown = growContributorSlots(slots, 8);
    addContributor(grown, 6, 5, 3);

    expect(grown.count).toHaveLength(8);
    expect(slotsOf(grown, 1)).toEqual([[4, 20]]);
    expect(slotsOf(grown, 6)).toEqual([[5, 3]]);
  });
});

describe('unionContributors', () => {
  test('per-route mean over the run length, busiest first', () => {
    const slots = makeContributorSlots(4);
    // route 0 on all 4 pieces at 30; route 1 on 2 of 4 pieces at 20;
    // route 2 on 1 of 4 pieces at 40
    for (const p of [0, 1, 2, 3]) addContributor(slots, p, 0, 30);
    for (const p of [2, 3]) addContributor(slots, p, 1, 20);
    addContributor(slots, 3, 2, 40);

    const union = unionContributors(slots, [0, 1, 2, 3]);

    expect(union).toEqual([
      [0, 30], // 120 / 4
      [1, 10], // 40 / 4
      [2, 10], // 40 / 4 — tie broken by route index
    ]);
  });

  test('keeps at most K routes across the run', () => {
    const slots = makeContributorSlots(2);
    // 6 distinct routes on each piece → 12 across the run
    for (let r = 0; r < 6; r += 1) addContributor(slots, 0, r, 60 - r);
    for (let r = 6; r < 12; r += 1) addContributor(slots, 1, r, 60 - r);

    const union = unionContributors(slots, [0, 1]);

    expect(union).toHaveLength(CONTRIBUTOR_SLOTS);
    expect(union.map(([r]) => r)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  test('an empty run yields nothing', () => {
    expect(unionContributors(makeContributorSlots(1), [])).toEqual([]);
  });
});

describe('routeLabel', () => {
  test('learner keys become "line dirCode" in the Filter tab name space', () => {
    expect(routeLabel('TFLO_88_outbound')).toBe('88 o');
    expect(routeLabel('TFLO_N88_inbound')).toBe('N88 i');
    expect(routeLabel('TMSB_17A_anticlockwise')).toBe('17A a');
    expect(routeLabel('NATX_025_inbound')).toBe('025 i'); // never unpadded
  });

  test('a line containing an underscore keeps it', () => {
    expect(routeLabel('GOCH_Cross_Bus_DRT_outbound')).toBe('Cross_Bus_DRT o');
  });

  test('keys without the OPERATOR_LINE_DIR shape pass through bare', () => {
    expect(routeLabel('R0')).toBe('R0');
    expect(routeLabel('A_outbound')).toBe('A_outbound');
  });
});

describe('encodeContributors / parseContributors', () => {
  test('round-trips lines, direction codes and journeys', () => {
    const encoded = encodeContributors([
      ['88 o', 31.4],
      ['N88 i', 12],
      ['Cross_Bus_DRT o', 0.6],
      ['R0', 5],
    ]);

    expect(encoded).toBe('88 o:31;N88 i:12;Cross_Bus_DRT o:1;R0:5');
    expect(parseContributors(encoded)).toEqual([
      { line: '88', dir: 'o', journeysPerDay: 31 },
      { line: 'N88', dir: 'i', journeysPerDay: 12 },
      { line: 'Cross_Bus_DRT', dir: 'o', journeysPerDay: 1 },
      { line: 'R0', dir: '', journeysPerDay: 5 },
    ]);
  });

  test('rounds to whole journeys and drops entries that round to zero', () => {
    expect(encodeContributors([['88 o', 0.49]])).toBe('');
    expect(encodeContributors([['88 o', 2.5], ['N88 i', 0.2]])).toBe('88 o:3');
  });

  test('parsing tolerates empty input and malformed tokens', () => {
    expect(parseContributors('')).toEqual([]);
    expect(parseContributors('88 o:x;:4;N88 i:2')).toEqual([
      { line: 'N88', dir: 'i', journeysPerDay: 2 },
    ]);
  });
});
