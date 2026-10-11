import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Bus } from './bods-client';
import { TraceWriter } from './trace-writer';

const NOW = Date.parse('2026-10-10T14:24:00Z');

const BASE: Bus = {
  id: 'TFLO:LK62DVF',
  line: '28',
  operator: 'TFLO',
  direction: 'outbound',
  dest: 'Willesden Junction',
  lat: 51.46,
  lon: -0.19,
  bearing: 270,
  recordedAt: NOW - 20_000,
  originRef: '490015371W',
  aimedDeparture: Date.parse('2026-10-10T14:00:00Z'),
  destinationRef: '490008800N',
  journeyRef: '635695',
};

describe('TraceWriter line format', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'traces-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Record one bus and read back the single line it produced. */
  async function lineFor(bus: Bus): Promise<Record<string, unknown>> {
    const writer = new TraceWriter(dir, () => {});
    writer.record([bus], NOW);
    // flush() is private; stop() triggers the final flush.
    writer.stop();
    await new Promise((r) => setTimeout(r, 50));
    const file = join(dir, `${new Date().toISOString().slice(0, 10)}.jsonl`);
    const text = await readFile(file, 'utf8');
    const lines = text.trim().split('\n');
    expect(lines).toHaveLength(1);
    return JSON.parse(lines[0] as string) as Record<string, unknown>;
  }

  test('keeps k,i,x,y,t first and unchanged', async () => {
    const line = await lineFor(BASE);

    expect(Object.keys(line).slice(0, 5)).toEqual(['k', 'i', 'x', 'y', 't']);
    expect(line).toMatchObject({
      k: 'TFLO:28:outbound',
      i: 'TFLO:LK62DVF',
      x: -0.19,
      y: 51.46,
      t: Math.round((NOW - 20_000) / 1000),
    });
  });

  test('writes the journey fields under o, a, e, j when present', async () => {
    const line = await lineFor(BASE);

    expect(line).toMatchObject({
      o: '490015371W',
      a: Math.round(Date.parse('2026-10-10T14:00:00Z') / 1000),
      e: '490008800N',
      j: '635695',
    });
  });

  test('a is epoch seconds, not milliseconds', async () => {
    const line = await lineFor(BASE);

    expect(line.a).toBe(1791640800); // 2026-10-10T14:00:00Z
  });

  test('omits each journey key the feed did not supply', async () => {
    const line = await lineFor({ ...BASE, originRef: '', aimedDeparture: null, destinationRef: '', journeyRef: '' });

    expect(line).not.toHaveProperty('o');
    expect(line).not.toHaveProperty('a');
    expect(line).not.toHaveProperty('e');
    expect(line).not.toHaveProperty('j');
    expect(Object.keys(line)).toEqual(['k', 'i', 'x', 'y', 't']);
  });
});
