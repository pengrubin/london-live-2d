import { describe, expect, it } from 'vitest';
import {
  MAX_DESCRIPTION_CHARS,
  liveClosureIds,
  shapeClosures,
  windowVerdict,
  type ClosureStop,
} from './bus-stop-closures';
import type { BusStop } from './bus-stop-gazetteer';

/** 2026-09-04T08:06:36Z — the clock the whole file compares windows against. */
const NOW = Date.parse('2026-09-04T08:06:36Z');
const SECOND_MS = 1_000;

const POLE = '490006655CG';
const OTHER_POLE = '490009477N';

const stop = (id: string, extra: Partial<BusStop> = {}): BusStop => ({
  id,
  name: `Stop ${id}`,
  lat: 51.54389,
  lon: -0.15824,
  routes: ['31', 'N31'],
  match: 'exact',
  ...extra,
});

const gazetteerOf = (...stops: readonly BusStop[]): Map<string, BusStop> =>
  new Map(stops.map((entry) => [entry.id, entry]));

/** A row shaped exactly like the live feed's, defaults in force at NOW. */
function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    $type: 'Tfl.Api.Presentation.Entities.DisruptedPoint, Tfl.Api.Presentation.Entities',
    atcoCode: POLE,
    fromDate: '2026-08-24T05:00:00Z',
    toDate: '2026-10-02T18:00:00Z',
    description: 'Bus Stop Closed\n\n\n',
    commonName: 'Eton Road',
    type: 'Closure',
    mode: 'bus',
    stationAtcoCode: '490G00006655',
    appearance: 'Information',
    ...overrides,
  };
}

const silent = (): void => {};

function shape(
  body: unknown,
  gazetteer: ReadonlyMap<string, BusStop> = gazetteerOf(stop(POLE)),
  drops: string[] = [],
): ReturnType<typeof shapeClosures> {
  return shapeClosures(body, gazetteer, NOW, (reason) => drops.push(reason));
}

describe('windowVerdict', () => {
  const FROM = '2026-09-04T08:00:00Z';
  const TO = '2026-09-04T09:00:00Z';
  const fromMs = Date.parse(FROM);
  const toMs = Date.parse(TO);

  it('is in force exactly at fromDate', () => {
    // Arrange / Act / Assert — the mirror of the Waterloo & City bug: a closure
    // that HAS begun must never be filed away as not yet started.
    expect(windowVerdict(FROM, TO, fromMs)).toBe('in-force');
  });

  it('is out of window one second before fromDate', () => {
    expect(windowVerdict(FROM, TO, fromMs - SECOND_MS)).toBe('out-of-window');
  });

  it('is in force exactly at toDate', () => {
    expect(windowVerdict(FROM, TO, toMs)).toBe('in-force');
  });

  it('is out of window one second after toDate', () => {
    // The bug that hatched a running line closed: an expired window must go.
    expect(windowVerdict(FROM, TO, toMs + SECOND_MS)).toBe('out-of-window');
  });

  it('is in force one second inside each edge', () => {
    expect(windowVerdict(FROM, TO, fromMs + SECOND_MS)).toBe('in-force');
    expect(windowVerdict(FROM, TO, toMs - SECOND_MS)).toBe('in-force');
  });

  it('treats a missing toDate as open-ended rather than as expired', () => {
    expect(windowVerdict(FROM, undefined, toMs + SECOND_MS)).toBe('in-force');
    expect(windowVerdict(FROM, null, toMs + SECOND_MS)).toBe('in-force');
    expect(windowVerdict(FROM, '', toMs + SECOND_MS)).toBe('in-force');
  });

  it('calls an unparseable date unreadable rather than guessing either way', () => {
    expect(windowVerdict('not a date', TO, fromMs)).toBe('unreadable');
    expect(windowVerdict(FROM, 'not a date', fromMs)).toBe('unreadable');
    expect(windowVerdict(undefined, TO, fromMs)).toBe('unreadable');
    expect(windowVerdict(42, TO, fromMs)).toBe('unreadable');
  });
});

describe('shapeClosures window filtering', () => {
  it('draws a closure whose window covers now', () => {
    // Arrange
    const body = [row()];

    // Act
    const { stops, stats } = shape(body);

    // Assert
    expect(stops).toHaveLength(1);
    expect(stats).toMatchObject({ rows: 1, inForce: 1, notInForce: 0, dropped: 0, stops: 1 });
  });

  it('does not draw a closure that has not started yet', () => {
    // Arrange — filed today, in force from next week.
    const body = [row({ fromDate: '2026-09-11T05:00:00Z' })];

    // Act
    const { stops, stats } = shape(body);

    // Assert
    expect(stops).toEqual([]);
    expect(stats).toMatchObject({ inForce: 0, notInForce: 1, dropped: 0 });
  });

  it('does not draw a closure that has already ended', () => {
    const body = [row({ toDate: '2026-09-04T08:06:35Z' })];

    const { stops, stats } = shape(body);

    expect(stops).toEqual([]);
    expect(stats.notInForce).toBe(1);
  });

  it('draws an open-ended closure that has begun', () => {
    const body = [row({ toDate: null })];

    const { stops } = shape(body);

    expect(stops).toHaveLength(1);
    expect(stops[0]?.t).toBeUndefined();
  });

  it('drops a row with an unreadable date, counting and naming it', () => {
    // Arrange
    const drops: string[] = [];
    const body = [row({ fromDate: 'shortly' })];

    // Act
    const { stops, stats } = shape(body, gazetteerOf(stop(POLE)), drops);

    // Assert — never shown, never silent.
    expect(stops).toEqual([]);
    expect(stats.dropped).toBe(1);
    expect(drops).toHaveLength(1);
    expect(drops[0]).toContain(POLE);
  });
});

describe('shapeClosures gazetteer join', () => {
  it('takes position, routes and direction from the gazetteer, never from the feed', () => {
    // Arrange
    const gazetteer = gazetteerOf(
      stop(POLE, { name: 'Eton Road', routes: ['31', 'N31'], towards: 'Camden Town' }),
    );

    // Act
    const { stops } = shape([row()], gazetteer);

    // Assert
    expect(stops[0]).toEqual({
      id: POLE,
      name: 'Eton Road',
      lat: 51.54389,
      lon: -0.15824,
      routes: ['31', 'N31'],
      ty: 'Closure',
      f: '2026-08-24T05:00:00Z',
      t: '2026-10-02T18:00:00Z',
      d: 'Bus Stop Closed',
      towards: 'Camden Town',
    } satisfies ClosureStop);
  });

  it('drops an id the gazetteer cannot place rather than guessing a position', () => {
    // Arrange — resolution already failed for this pole upstream of the shape.
    const drops: string[] = [];

    // Act
    const { stops, stats } = shape([row()], gazetteerOf(), drops);

    // Assert
    expect(stops).toEqual([]);
    expect(stats).toMatchObject({ inForce: 1, unresolved: 1, stops: 0 });
    expect(drops[0]).toContain(POLE);
  });

  it('counts an unplaceable pole once however many rows name it', () => {
    // Arrange — the counter answers "how many pins were lost", not "how many rows".
    const drops: string[] = [];
    const body = [row(), row({ description: 'Bus Stop Closed\n see tfl.gov.uk' })];

    // Act
    const { stats } = shape(body, gazetteerOf(), drops);

    // Assert
    expect(stats.unresolved).toBe(1);
    expect(drops).toHaveLength(1);
  });

  it('omits towards when the gazetteer states none', () => {
    const { stops } = shape([row()], gazetteerOf(stop(POLE)));

    expect(Object.keys(stops[0] ?? {})).not.toContain('towards');
  });
});

describe('shapeClosures pole merge', () => {
  it('merges two rows on one pole into a single pin keeping both descriptions', () => {
    // Arrange — TfL files 304 rows over 275 poles; duplicate pins are wrong.
    const body = [
      row({
        fromDate: '2026-08-26T15:07:00Z',
        toDate: '2026-09-09T17:00:00Z',
        description: 'Bus stop closed.\n    Please use the next stop',
      }),
      row({
        fromDate: '2026-08-26T15:58:00Z',
        toDate: '2026-09-30T17:00:00Z',
        description: 'STOP CLOSED\n   DUE TO RESURFACING WORKS',
      }),
    ];

    // Act
    const { stops, stats } = shape(body);

    // Assert — one pin, the union window, and neither sentence lost.
    expect(stops).toHaveLength(1);
    expect(stats).toMatchObject({ rows: 2, inForce: 2, stops: 1 });
    expect(stops[0]?.f).toBe('2026-08-26T15:07:00Z');
    expect(stops[0]?.t).toBe('2026-09-30T17:00:00Z');
    expect(stops[0]?.d).toBe(
      'Bus stop closed. Please use the next stop — STOP CLOSED DUE TO RESURFACING WORKS',
    );
  });

  it('lets an open-ended row keep the merged pin open-ended', () => {
    const body = [row({ toDate: '2026-09-09T17:00:00Z' }), row({ toDate: undefined })];

    const { stops } = shape(body);

    expect(stops).toHaveLength(1);
    expect(stops[0]?.t).toBeUndefined();
  });

  it('keeps one copy of a description the feed repeats with different whitespace', () => {
    // Arrange — "Bus Stop Closed\n\n\n" and "Bus Stop Closed" are one sentence.
    const body = [row({ description: 'Bus Stop Closed\n\n\n' }), row({ description: 'Bus Stop Closed' })];

    // Act
    const { stops } = shape(body);

    // Assert
    expect(stops[0]?.d).toBe('Bus Stop Closed');
  });

  it('keeps every distinct type a merged pole carries', () => {
    const body = [row({ type: 'Closure' }), row({ type: 'Information' })];

    const { stops } = shape(body);

    expect(stops[0]?.ty).toBe('Closure, Information');
  });

  it('emits one pin per pole, in the order the feed first names them', () => {
    const gazetteer = gazetteerOf(stop(POLE), stop(OTHER_POLE));
    const body = [row({ atcoCode: OTHER_POLE }), row(), row({ atcoCode: OTHER_POLE })];

    const { stops } = shape(body, gazetteer);

    expect(stops.map((s) => s.id)).toEqual([OTHER_POLE, POLE]);
  });
});

describe('shapeClosures free text', () => {
  it(`caps the merged description at ${MAX_DESCRIPTION_CHARS} characters`, () => {
    // Arrange — the live feed's longest row measured 477 characters.
    const long = `WILLESDEN JUNCTION STATION ${'x'.repeat(500)}`;

    // Act
    const { stops } = shape([row({ description: long })]);

    // Assert
    const text = stops[0]?.d ?? '';
    expect(text.length).toBe(MAX_DESCRIPTION_CHARS);
    expect(text.endsWith('…')).toBe(true);
    expect(MAX_DESCRIPTION_CHARS).toBe(400);
  });

  it('unfolds the LITERAL backslash-n TfL writes instead of a real newline', () => {
    // Arrange — measured 2026-09-04: 909 occurrences across the feed, and not
    // one real control character. Left alone, every popup reads "…Closed\n\n\n".
    const body = [row({ description: 'Bus Stop Closed\\n   see tfl.gov.uk/bus/status\\n' })];

    // Act
    const { stops } = shape(body);

    // Assert
    expect(stops[0]?.d).toBe('Bus Stop Closed see tfl.gov.uk/bus/status');
  });

  it('merges the escaped and unescaped spellings of one sentence into one copy', () => {
    const body = [row({ description: 'Bus Stop Closed\\n\\n\\n' }), row({ description: 'Bus Stop Closed' })];

    const { stops } = shape(body);

    expect(stops[0]?.d).toBe('Bus Stop Closed');
  });

  it('ships an empty string when the row states no description', () => {
    const { stops } = shape([row({ description: undefined })]);

    expect(stops[0]?.d).toBe('');
  });
});

describe('shapeClosures malformed input', () => {
  it('ships the good rows when one row is malformed, counting the drop', () => {
    // Arrange — a null entry, an entry with no atcoCode, and a real closure.
    const drops: string[] = [];
    const body = [null, { fromDate: '2026-08-24T05:00:00Z', type: 'Closure' }, row()];

    // Act
    const { stops, stats } = shape(body, gazetteerOf(stop(POLE)), drops);

    // Assert
    expect(stops.map((s) => s.id)).toEqual([POLE]);
    expect(stats).toMatchObject({ rows: 3, dropped: 2, stops: 1 });
    expect(drops).toHaveLength(2);
  });

  it('throws on a body that is not a row array rather than reporting "all clear"', () => {
    // A closure map that silently empties itself is worse than a stale one.
    expect(() => shape({ message: 'unexpected' })).toThrow(/array/i);
  });
});

describe('liveClosureIds', () => {
  it('names only the distinct poles whose window covers now', () => {
    // Arrange
    const body = [
      row(),
      row(),
      row({ atcoCode: OTHER_POLE, fromDate: '2026-09-11T05:00:00Z' }),
      row({ atcoCode: '490000000X', toDate: undefined }),
      { atcoCode: '', fromDate: '2026-08-24T05:00:00Z', toDate: null },
    ];

    // Act
    const ids = liveClosureIds(body, NOW);

    // Assert — the future closure and the blank id are not worth resolving.
    expect(ids).toEqual([POLE, '490000000X']);
  });
});
