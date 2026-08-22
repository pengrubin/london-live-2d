import { describe, expect, test } from 'vitest';
import { aggregateTraceLines } from './rollup-writer';

// ~11.1 m per 0.0001° of latitude — used to build fixes with known speeds.
const LAT_STEP = 0.0001;

function line(k: string, i: string, x: number, y: number, t: number): string {
  return JSON.stringify({ k, i, x, y, t });
}

describe('aggregateTraceLines', () => {
  test('groups fixes by route and counts distinct vehicles', async () => {
    const rollup = await aggregateTraceLines(
      [
        line('TFLO:88:outbound', 'TFLO:V1', -0.1, 51.5, 1000),
        line('TFLO:88:outbound', 'TFLO:V2', -0.1, 51.5, 1000),
        line('TFLO:88:outbound', 'TFLO:V1', -0.1, 51.5, 1030),
        line('GOAH:x80:inbound', 'GOAH:V9', -0.2, 51.4, 1000),
      ],
      '2026-08-10',
    );

    expect(rollup.day).toBe('2026-08-10');
    expect(rollup.totals).toMatchObject({ fixes: 4, vehicles: 3, routes: 2, journeys: 3 });
    expect(rollup.routes['TFLO:88:outbound']).toMatchObject({ fixes: 3, vehicles: 2, journeys: 2 });
    expect(rollup.routes['GOAH:x80:inbound']).toMatchObject({ fixes: 1, vehicles: 1, journeys: 1 });
  });

  test('splits a vehicle into a new journey after a 600 s gap', async () => {
    const rollup = await aggregateTraceLines(
      [
        line('TFLO:88:outbound', 'TFLO:V1', -0.1, 51.5, 1000),
        line('TFLO:88:outbound', 'TFLO:V1', -0.1, 51.5, 1300), // same journey
        line('TFLO:88:outbound', 'TFLO:V1', -0.1, 51.5, 2000), // gap 700 s → new journey
      ],
      '2026-08-10',
    );

    expect(rollup.routes['TFLO:88:outbound']?.journeys).toBe(2);
  });

  test('measures implied speed from consecutive fixes', async () => {
    // 0.001° of latitude every 20 s ≈ 111.2 m / 20 s ≈ 5.56 m/s.
    const lines: string[] = [];
    for (let n = 0; n < 10; n += 1) {
      lines.push(line('TFLO:88:outbound', 'TFLO:V1', -0.1, 51.5 + n * 10 * LAT_STEP, 1000 + n * 20));
    }
    const rollup = await aggregateTraceLines(lines, '2026-08-10');

    const speed = rollup.routes['TFLO:88:outbound']?.speedMs;
    expect(speed).not.toBeNull();
    expect(speed?.samples).toBe(9);
    expect(speed?.p50).toBeGreaterThan(5);
    expect(speed?.p50).toBeLessThan(6);
  });

  test('ignores glitch speeds and too-small time deltas', async () => {
    const rollup = await aggregateTraceLines(
      [
        line('TFLO:88:outbound', 'TFLO:V1', -0.1, 51.5, 1000),
        line('TFLO:88:outbound', 'TFLO:V1', -0.1, 52.5, 1020), // ~111 km in 20 s → glitch
        line('TFLO:88:outbound', 'TFLO:V1', -0.1, 52.5001, 1022), // dt 2 s < minimum
      ],
      '2026-08-10',
    );

    expect(rollup.routes['TFLO:88:outbound']?.speedMs).toBeNull();
    expect(rollup.routes['TFLO:88:outbound']?.fixes).toBe(3);
  });

  test('tolerates malformed lines and BODS timestamp rewinds', async () => {
    const rollup = await aggregateTraceLines(
      [
        'not json at all',
        '{"k":"TFLO:88:outbound","i":42,"x":-0.1,"y":51.5,"t":1000}', // wrong type for i
        line('TFLO:88:outbound', 'TFLO:V1', -0.1, 51.5, 1000),
        line('TFLO:88:outbound', 'TFLO:V1', -0.1, 51.501, 990), // rewind — skipped
        line('TFLO:88:outbound', 'TFLO:V1', -0.1, 51.501, 1030),
      ],
      '2026-08-10',
    );

    expect(rollup.totals.malformedLines).toBe(2);
    expect(rollup.routes['TFLO:88:outbound']?.fixes).toBe(3);
    expect(rollup.routes['TFLO:88:outbound']?.journeys).toBe(1);
  });

  test('never writes vehicle identifiers into the rollup', async () => {
    const rollup = await aggregateTraceLines(
      [
        line('TFLO:88:outbound', 'TFLO:LTZ1234', -0.1, 51.5, 1000),
        line('TFLO:88:outbound', 'TFLO:LTZ5678', -0.1, 51.5, 1015),
      ],
      '2026-08-10',
    );

    const serialized = JSON.stringify(rollup);
    expect(serialized).not.toContain('LTZ1234');
    expect(serialized).not.toContain('LTZ5678');
    expect(rollup.routes['TFLO:88:outbound']?.vehicles).toBe(2);
  });
});
