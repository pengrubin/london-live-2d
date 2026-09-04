import { describe, expect, test } from 'vitest';
import { parseSiriVm } from './bods-client';

const NOW = Date.parse('2026-09-04T15:00:00Z');

function vehicleActivity(fields: Record<string, string>): string {
  const body = Object.entries(fields)
    .map(([tag, value]) => `<${tag}>${value}</${tag}>`)
    .join('');
  return `<VehicleActivity>${body}</VehicleActivity>`;
}

function siri(activities: string[]): string {
  return `<Siri version="2.0" xmlns="http://www.siri.org.uk/siri">${activities.join('')}</Siri>`;
}

const FULL = {
  RecordedAtTime: '2026-09-04T14:59:30Z',
  Longitude: '-0.15824',
  Latitude: '51.54389',
  OperatorRef: 'TFLO',
  VehicleRef: 'LTZ1234',
  PublishedLineName: '31',
  DirectionRef: 'inbound',
  DestinationName: 'Camden_Town',
};

describe('parseSiriVm', () => {
  test('reads every field of a well-formed vehicle', () => {
    // Arrange / Act
    const [bus] = parseSiriVm(siri([vehicleActivity(FULL)]), NOW);

    // Assert
    expect(bus).toMatchObject({
      id: 'TFLO:LTZ1234',
      line: '31',
      operator: 'TFLO',
      dest: 'Camden Town',
      lat: 51.54389,
      lon: -0.15824,
    });
  });

  test('falls back to LineRef when the published name is absent', () => {
    const { PublishedLineName: _drop, ...rest } = FULL;
    const [bus] = parseSiriVm(siri([vehicleActivity({ ...rest, LineRef: 'N31' })]), NOW);

    expect(bus?.line).toBe('N31');
  });

  test('drops a vehicle with no position, no id, or a stale timestamp', () => {
    const noPosition = vehicleActivity({ ...FULL, Longitude: '', Latitude: '' });
    const noId = vehicleActivity({ ...FULL, VehicleRef: '' });
    const stale = vehicleActivity({ ...FULL, RecordedAtTime: '2026-09-04T10:00:00Z' });

    expect(parseSiriVm(siri([noPosition, noId, stale]), NOW)).toHaveLength(0);
  });

  test('a missing bearing is null rather than NaN', () => {
    const [bus] = parseSiriVm(siri([vehicleActivity(FULL)]), NOW);

    expect(bus?.bearing).toBeNull();
  });

  test('the document header is not mistaken for a vehicle', () => {
    expect(parseSiriVm(siri([]), NOW)).toHaveLength(0);
  });

  /**
   * The regression that matters. `split`/`slice` return VIEWS in V8: they keep
   * a pointer to the whole parent string. Every field here is cut out of a
   * multi-megabyte SIRI document and then retained — in the vehicle table, the
   * wire buffer, the diversion event store — so before the fix one destination
   * name pinned the entire poll's XML. Sixty-six pinned bodies filled a 2 GB
   * heap and killed the service on 2026-09-04.
   *
   * There is no JavaScript API for "is this string a view", so this measures
   * the property that actually matters: parse several large documents, drop
   * them, and see whether the heap keeps them. Needs --expose-gc to be
   * trustworthy, so it skips rather than pretending when gc is unavailable.
   */
  test('retains the fields it parsed, not the documents they came from', () => {
    // vitest.config.ts runs the suite with --expose-gc precisely so this test
    // is never skipped. Assert that rather than skipping: a regression test
    // that quietly opts out still reports the suite green, which is how the
    // bug it guards would come back unnoticed.
    const gc = (globalThis as { gc?: () => void }).gc;
    expect(gc, 'the suite must run with --expose-gc; see vitest.config.ts').toBeTypeOf('function');
    if (!gc) return;

    // Arrange — documents far larger than the fields taken out of them.
    // The document must dwarf the fields taken out of it, or the buses' own
    // legitimate size swamps the signal: 200 vehicles of real data is well
    // under a megabyte, while each document is several.
    const FILLER = 'x'.repeat(40_000);
    const VEHICLES = 200;
    const DOCUMENTS = 4;
    const BYTES_PER_MB = 1_048_576;
    const makeDocument = (poll: number): string =>
      siri(
        Array.from({ length: VEHICLES }, (_unused, i) =>
          vehicleActivity({
            ...FULL,
            VehicleRef: `LTZ${poll}_${i}`,
            // `line` is stored raw, unlike `dest` which humanize() rewrites
            // and thereby flattens by accident. V8 only keeps a parent
            // pointer for a slice of 13 characters or more, so the field that
            // proves the bug must be long AND untouched after extraction.
            PublishedLineName: `Route ${poll}-${i} towards somewhere far away`,
            Filler: FILLER,
          }),
        ),
      );
    const documentMb = makeDocument(0).length / BYTES_PER_MB;

    gc();
    const before = process.memoryUsage().heapUsed;

    // Act — parse and keep only the buses, exactly as the poller does. The
    // document is held in a variable and cleared rather than passed inline:
    // V8 can keep the last temporary alive in a register, which would look
    // exactly like one pinned document and make this test lie.
    const kept = [];
    for (let poll = 0; poll < DOCUMENTS; poll += 1) {
      let document = makeDocument(poll);
      kept.push(parseSiriVm(document, NOW));
      document = '';
    }
    gc();
    gc();
    const retainedMb = (process.memoryUsage().heapUsed - before) / BYTES_PER_MB;

    // Assert — the buses are real, and the documents are gone. Half of one
    // document is a generous ceiling: the fields are a few percent of it, and
    // pinning even one would blow straight past this.
    expect(kept.flat()).toHaveLength(VEHICLES * DOCUMENTS);
    expect(retainedMb).toBeLessThan(documentMb / 2);
  });
});
