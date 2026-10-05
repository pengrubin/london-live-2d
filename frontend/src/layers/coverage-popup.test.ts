import { describe, expect, test } from 'vitest';
import { coveragePopupHtml, groupContributors, parseContributors } from './coverage-popup';

describe('parseContributors', () => {
  test('parses lines, direction codes and journeys in wire order', () => {
    expect(parseContributors('88 o:31;N88 i:12;R0:5')).toEqual([
      { line: '88', dir: 'o', journeysPerDay: 31 },
      { line: 'N88', dir: 'i', journeysPerDay: 12 },
      { line: 'R0', dir: '', journeysPerDay: 5 },
    ]);
  });

  test('keeps an underscore inside a line name', () => {
    expect(parseContributors('Cross_Bus_DRT o:2')).toEqual([
      { line: 'Cross_Bus_DRT', dir: 'o', journeysPerDay: 2 },
    ]);
  });

  test('tolerates empty input and skips malformed tokens', () => {
    expect(parseContributors('')).toEqual([]);
    expect(parseContributors('88 o:x;:4;N88 o:;N88 i:2')).toEqual([
      { line: 'N88', dir: 'i', journeysPerDay: 2 },
    ]);
  });
});

describe('groupContributors', () => {
  test('sums one line across operators when it runs one way only', () => {
    // two operators running "700" outbound on this road → one row, no split
    const rows = groupContributors(parseContributors('700 o:6;88 o:31;700 o:4'));

    expect(rows).toEqual([
      { line: '88', journeysPerDay: 31, byDir: [] },
      { line: '700', journeysPerDay: 10, byDir: [] },
    ]);
  });

  test('keeps the direction split only when both directions are listed', () => {
    const rows = groupContributors(parseContributors('88 o:16;N88 i:12;88 i:15'));

    expect(rows).toEqual([
      {
        line: '88',
        journeysPerDay: 31,
        byDir: [
          ['o', 16],
          ['i', 15],
        ],
      },
      { line: 'N88', journeysPerDay: 12, byDir: [] },
    ]);
  });

  test('orders rows busiest first, numeric-aware on ties', () => {
    const rows = groupContributors(parseContributors('10 o:5;9 o:5;N1 o:9'));

    expect(rows.map((r) => r.line)).toEqual(['N1', '9', '10']);
  });
});

describe('coveragePopupHtml', () => {
  test('heads with the approximate total and explains what it counts', () => {
    const html = coveragePopupHtml({ j: 120, b: 4, r: '88 o:31;N88 i:12' });

    expect(html).toContain('~120 journeys/day');
    expect(html).toContain('total of all routes on this road, both directions');
    expect(html).toContain('88 · 31/day');
    expect(html).toContain('N88 · 12/day');
    expect(html.indexOf('88 · 31/day')).toBeLessThan(html.indexOf('N88 · 12/day'));
  });

  test('shows directions only for a route listed both ways', () => {
    const html = coveragePopupHtml({ j: 43, b: 2, r: '88 o:16;88 i:15;N88 i:12' });

    expect(html).toContain('88 · 31/day');
    expect(html).toContain('outbound 16');
    expect(html).toContain('inbound 15');
    // N88 runs one way here: no direction words on its row
    expect(html).toMatch(/N88 · 12\/day<\/span><\/div>/);
  });

  test('escapes route names', () => {
    const html = coveragePopupHtml({ j: 5, b: 0, r: '<b>x o:5' });

    expect(html).not.toContain('<b>x');
    expect(html).toContain('&lt;b&gt;x · 5/day');
  });

  test('says so when no route reaches 1 journey/day', () => {
    const html = coveragePopupHtml({ j: 1, b: 0 });

    expect(html).toContain('~1 journey/day');
    expect(html).toContain('no single route averages 1 journey/day here');
  });

  test('notes when the list is capped at 8 route-directions', () => {
    const r = Array.from({ length: 8 }, (_, i) => `${i + 1} o:${20 - i}`).join(';');

    expect(coveragePopupHtml({ j: 200, b: 4, r })).toContain('busiest 8');
    expect(coveragePopupHtml({ j: 50, b: 2, r: '88 o:31' })).not.toContain('busiest 8');
  });
});
