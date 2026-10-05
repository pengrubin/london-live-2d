// The frontend's copy of the National Rail board merge (mirrors
// backend/src/shared/nr-inference.test.ts, which is the primary suite). A
// later sighting of a tracked rid updates the times it carries, never
// truncates, extends with stops it adds, and an older board never overrides a
// fresher one of the same precedence.
//
// nr-trains.ts value-imports maplibre-gl (Popup), so that module is stubbed to
// keep the test in the fast node environment — same pattern as buses.test.ts.
import { describe, expect, test, vi } from 'vitest';

vi.mock('maplibre-gl', () => ({ Popup: class {} }));

const { mergeBoard } = await import('./nr-trains');
type Mod = typeof import('./nr-trains');
type NrBoard = Parameters<Mod['mergeBoard']>[1];
type NrTrain = NonNullable<ReturnType<Parameters<Mod['mergeBoard']>[0]['get']>>;
type NrService = NrBoard['services'][number];
type NrCallingPoint = NrService['callingPoints'][number];

// frontend parseTime resolves "HH:mm" in the viewer's local timezone
const at = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(2026, 9, 5, h, m, 0, 0).getTime();
};
const NOW = at('13:00');
const MIN = 60_000;

const STATIONS = new Map(
  ['WAT', 'VXH', 'CLJ', 'EAD', 'WIM', 'SUR'].map((crs, i) => [
    crs,
    { crs, name: `${crs} station`, lat: 51.5 - i * 0.01, lon: -0.11 - i * 0.02 },
  ]),
);

const cp = (crs: string, st: string, extra: Partial<NrCallingPoint> = {}): NrCallingPoint => ({
  crs,
  name: `${crs} station`,
  st,
  ...extra,
});

const service = (callingPoints: NrCallingPoint[], extra: Partial<NrService> = {}): NrService => ({
  rid: 'R1',
  std: '12:50',
  operator: 'South Western Railway',
  origin: 'London Waterloo',
  destination: 'Surbiton',
  cancelled: false,
  callingPoints,
  ...extra,
});

const board = (crs: string, services: NrService[], generatedAt?: string): NrBoard => ({
  crs,
  services,
  ...(generatedAt ? { generatedAt } : {}),
});

const timeline = (t: NrTrain | undefined): [string, number][] =>
  (t?.stops ?? []).map((s) => [s.crs, s.time]);
const timeAt = (t: NrTrain | undefined, crs: string): number | undefined =>
  t?.stops.find((s) => s.crs === crs)?.time;

describe('mergeBoard (frontend copy)', () => {
  test('a second sighting with the same calling points but a later estimate updates the time', () => {
    const trains = new Map<string, NrTrain>();
    mergeBoard(trains, board('WAT', [service([cp('CLJ', '13:00'), cp('SUR', '13:15')])]), STATIONS, NOW);

    mergeBoard(
      trains,
      board('WAT', [service([cp('CLJ', '13:00', { et: '13:04' }), cp('SUR', '13:15', { et: '13:19' })], { etd: '12:54' })]),
      STATIONS,
      NOW,
    );

    expect(timeline(trains.get('R1'))).toEqual([
      ['WAT', at('12:54')],
      ['CLJ', at('13:04')],
      ['SUR', at('13:19')],
    ]);
  });

  test('an actual time overrides an earlier estimate and is not overridden by a later one', () => {
    const trains = new Map<string, NrTrain>();
    const now = at('13:05');
    mergeBoard(trains, board('WAT', [service([cp('CLJ', '13:00', { et: '13:03' }), cp('SUR', '13:15')])]), STATIONS, now);

    mergeBoard(trains, board('WAT', [service([cp('CLJ', '13:00', { at: '13:02' }), cp('SUR', '13:15')])]), STATIONS, now);
    mergeBoard(trains, board('WAT', [service([cp('CLJ', '13:00', { et: '13:06' }), cp('SUR', '13:15')])]), STATIONS, now);

    expect(timeAt(trains.get('R1'), 'CLJ')).toBe(at('13:02'));
  });

  test('a sighting with fewer calling points updates times without truncating the timeline', () => {
    const trains = new Map<string, NrTrain>();
    mergeBoard(
      trains,
      board('WAT', [service([cp('VXH', '12:54'), cp('CLJ', '13:00'), cp('EAD', '13:05'), cp('SUR', '13:15')])]),
      STATIONS,
      NOW,
    );

    mergeBoard(
      trains,
      board('CLJ', [service([cp('EAD', '13:05', { et: '13:08' }), cp('SUR', '13:15', { et: '13:18' })], { std: '13:00', etd: '13:03' })]),
      STATIONS,
      NOW,
    );

    expect(timeline(trains.get('R1'))).toEqual([
      ['WAT', at('12:50')],
      ['VXH', at('12:54')],
      ['CLJ', at('13:03')],
      ['EAD', at('13:08')],
      ['SUR', at('13:18')],
    ]);
  });

  test('a sighting with more calling points extends the timeline', () => {
    const trains = new Map<string, NrTrain>();
    mergeBoard(trains, board('CLJ', [service([cp('EAD', '13:05')], { std: '13:00' })]), STATIONS, NOW);

    mergeBoard(
      trains,
      board('WAT', [service([cp('VXH', '12:54'), cp('CLJ', '13:00'), cp('EAD', '13:05'), cp('SUR', '13:15')])]),
      STATIONS,
      NOW,
    );

    expect(trains.get('R1')?.stops.map((s) => s.crs)).toEqual(['WAT', 'VXH', 'CLJ', 'EAD', 'SUR']);
  });

  test('an older board does not override a fresher estimate; without generatedAt arrival order wins', () => {
    const dated = new Map<string, NrTrain>();
    mergeBoard(dated, board('WAT', [service([cp('CLJ', '13:00', { et: '13:06' }), cp('SUR', '13:15')])], '2026-10-05T12:58:30Z'), STATIONS, NOW);
    mergeBoard(dated, board('WAT', [service([cp('CLJ', '13:00', { et: '13:02' }), cp('SUR', '13:15')])], '2026-10-05T12:51:00Z'), STATIONS, NOW);
    const undated = new Map<string, NrTrain>();
    mergeBoard(undated, board('WAT', [service([cp('CLJ', '13:00', { et: '13:06' }), cp('SUR', '13:15')])]), STATIONS, NOW);
    mergeBoard(undated, board('WAT', [service([cp('CLJ', '13:00', { et: '13:02' }), cp('SUR', '13:15')])]), STATIONS, NOW + MIN);

    expect(timeAt(dated.get('R1'), 'CLJ')).toBe(at('13:06'));
    expect(timeAt(undated.get('R1'), 'CLJ')).toBe(at('13:02'));
  });

  test('clamps a lagging estimate for the not-yet-reached next stop to now', () => {
    const trains = new Map<string, NrTrain>();
    const now = at('12:58');
    mergeBoard(trains, board('WAT', [service([cp('CLJ', '13:00'), cp('SUR', '13:15')])]), STATIONS, now);

    mergeBoard(trains, board('WAT', [service([cp('CLJ', '13:00', { et: '12:57' }), cp('SUR', '13:15')])]), STATIONS, now);

    expect(timeAt(trains.get('R1'), 'CLJ')).toBe(now);
  });

  test('cancelled services and sightings with fewer than two stops behave as before', () => {
    const trains = new Map<string, NrTrain>();
    mergeBoard(trains, board('WAT', [service([cp('CLJ', '13:00'), cp('SUR', '13:15')])]), STATIONS, NOW);

    mergeBoard(trains, board('WAT', [service([cp('CLJ', '13:00', { et: '13:30' }), cp('SUR', '13:15')], { cancelled: true })]), STATIONS, NOW);
    mergeBoard(trains, board('XYZ', [service([cp('SUR', '13:15', { et: '13:40' })])]), STATIONS, NOW);
    mergeBoard(trains, board('WAT', [service([cp('XXX', '13:00')], { rid: 'R2' })]), STATIONS, NOW);

    expect(timeline(trains.get('R1'))).toEqual([
      ['WAT', at('12:50')],
      ['CLJ', at('13:00')],
      ['SUR', at('13:15')],
    ]);
    expect(trains.has('R2')).toBe(false);
  });
});
