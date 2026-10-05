import { describe, expect, it } from 'vitest';
import type { NrBoard, NrCallingPoint, NrService } from '../darwin-client';
import { mergeBoard, parseTime, type NrStation, type NrTrackedTrain } from './nr-inference';

// A National Rail service is sighted on several hub boards over its run, each
// sighting carrying fresher estimated/actual times. These pin how a later
// sighting folds into the timeline already tracked for that rid: it updates
// the times it carries, never truncates, extends with stops it adds, and a
// board that was generated earlier never overrides a fresher one.

// 12:00Z on 2026-10-05 is 13:00 BST — every "HH:mm" below is London wall time.
const NOW = Date.parse('2026-10-05T12:00:00Z');
const at = (hhmm: string, now = NOW): number => parseTime(hhmm, now)!;
const MIN = 60_000;

const STATIONS: ReadonlyMap<string, NrStation> = new Map(
  (['WAT', 'VXH', 'CLJ', 'EAD', 'WIM', 'SUR'] as const).map((crs, i) => [
    crs,
    { crs, name: `${crs} station`, lat: 51.5 - i * 0.01, lon: -0.11 - i * 0.02 },
  ]),
);

function cp(crs: string, st: string, extra: Partial<NrCallingPoint> = {}): NrCallingPoint {
  return { crs, name: `${crs} station`, st, ...extra };
}

function service(callingPoints: NrCallingPoint[], extra: Partial<NrService> = {}): NrService {
  return {
    rid: 'R1',
    std: '12:50',
    operator: 'South Western Railway',
    origin: 'London Waterloo',
    destination: 'Surbiton',
    cancelled: false,
    callingPoints,
    ...extra,
  };
}

function board(crs: string, services: NrService[], generatedAt = ''): NrBoard {
  return { crs, locationName: `${crs} station`, generatedAt, services };
}

const timeline = (t: NrTrackedTrain | undefined): [string, number][] =>
  (t?.stops ?? []).map((s) => [s.crs, s.time]);

describe('mergeBoard — first sighting', () => {
  it('builds the timeline from the board station plus in-box calling points', () => {
    const trains = new Map<string, NrTrackedTrain>();

    mergeBoard(trains, board('WAT', [service([cp('CLJ', '13:00'), cp('SUR', '13:15')])]), STATIONS, NOW);

    expect(timeline(trains.get('R1'))).toEqual([
      ['WAT', at('12:50')],
      ['CLJ', at('13:00')],
      ['SUR', at('13:15')],
    ]);
  });
});

describe('mergeBoard — later sightings update the timeline', () => {
  it('a second sighting with the same calling points but a later estimate updates the time', () => {
    const trains = new Map<string, NrTrackedTrain>();
    mergeBoard(trains, board('WAT', [service([cp('CLJ', '13:00'), cp('SUR', '13:15')])]), STATIONS, NOW);

    mergeBoard(
      trains,
      board('WAT', [
        service([cp('CLJ', '13:00', { et: '13:04' }), cp('SUR', '13:15', { et: '13:19' })], { etd: '12:54' }),
      ]),
      STATIONS,
      NOW,
    );

    expect(timeline(trains.get('R1'))).toEqual([
      ['WAT', at('12:54')],
      ['CLJ', at('13:04')],
      ['SUR', at('13:19')],
    ]);
  });

  it('an actual time overrides an earlier estimate, and a later estimate does not override the actual', () => {
    const trains = new Map<string, NrTrackedTrain>();
    const now = at('13:05');
    mergeBoard(trains, board('WAT', [service([cp('CLJ', '13:00', { et: '13:03' }), cp('SUR', '13:15')])]), STATIONS, now);

    mergeBoard(trains, board('WAT', [service([cp('CLJ', '13:00', { at: '13:02' }), cp('SUR', '13:15')])]), STATIONS, now);
    const afterActual = trains.get('R1')?.stops.find((s) => s.crs === 'CLJ')?.time;
    mergeBoard(trains, board('WAT', [service([cp('CLJ', '13:00', { et: '13:06' }), cp('SUR', '13:15')])]), STATIONS, now);
    const afterLaterEstimate = trains.get('R1')?.stops.find((s) => s.crs === 'CLJ')?.time;

    expect(afterActual).toBe(at('13:02'));
    expect(afterLaterEstimate).toBe(at('13:02'));
  });

  it('a sighting with fewer calling points updates their times without truncating the timeline', () => {
    const trains = new Map<string, NrTrackedTrain>();
    mergeBoard(
      trains,
      board('WAT', [service([cp('VXH', '12:54'), cp('CLJ', '13:00'), cp('EAD', '13:05'), cp('SUR', '13:15')])]),
      STATIONS,
      NOW,
    );

    // Clapham Junction's own board: the train from CLJ onwards, now 3 min late.
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

  it('a sighting with more calling points extends the timeline (prepended origin, appended stop)', () => {
    const trains = new Map<string, NrTrackedTrain>();
    // first seen downstream, on Clapham Junction's board, without Surbiton
    mergeBoard(trains, board('CLJ', [service([cp('EAD', '13:05')], { std: '13:00' })]), STATIONS, NOW);

    mergeBoard(
      trains,
      board('WAT', [service([cp('VXH', '12:54'), cp('CLJ', '13:00'), cp('EAD', '13:05'), cp('SUR', '13:15')])]),
      STATIONS,
      NOW,
    );

    expect(trains.get('R1')?.stops.map((s) => s.crs)).toEqual(['WAT', 'VXH', 'CLJ', 'EAD', 'SUR']);
  });

  it('keeps calling points the new sighting adds even when it is shorter overall', () => {
    const trains = new Map<string, NrTrackedTrain>();
    mergeBoard(trains, board('WAT', [service([cp('CLJ', '13:00'), cp('EAD', '13:05')])]), STATIONS, NOW);

    mergeBoard(trains, board('EAD', [service([cp('SUR', '13:15')], { std: '13:05' })]), STATIONS, NOW);

    expect(trains.get('R1')?.stops.map((s) => s.crs)).toEqual(['WAT', 'CLJ', 'EAD', 'SUR']);
  });

  it('on an order conflict the longer list’s order wins and no station is duplicated', () => {
    const trains = new Map<string, NrTrackedTrain>();
    mergeBoard(
      trains,
      board('WAT', [service([cp('VXH', '12:54'), cp('CLJ', '13:00'), cp('EAD', '13:05'), cp('SUR', '13:15')])]),
      STATIONS,
      NOW,
    );

    // a (malformed) shorter sighting that lists EAD before CLJ
    mergeBoard(trains, board('VXH', [service([cp('EAD', '13:05'), cp('CLJ', '13:00')], { std: '12:54' })]), STATIONS, NOW);

    expect(trains.get('R1')?.stops.map((s) => s.crs)).toEqual(['WAT', 'VXH', 'CLJ', 'EAD', 'SUR']);
  });
});

describe('mergeBoard — sighting freshness', () => {
  it('a board generated earlier does not override a fresher estimate of the same precedence', () => {
    const trains = new Map<string, NrTrackedTrain>();
    const fresh = board('WAT', [service([cp('CLJ', '13:00', { et: '13:06' }), cp('SUR', '13:15', { et: '13:21' })])], '2026-10-05T12:58:30.1234567+01:00');
    const stale = board('WAT', [service([cp('CLJ', '13:00', { et: '13:02' }), cp('SUR', '13:15', { et: '13:17' })])], '2026-10-05T12:51:00.0000000+01:00');

    mergeBoard(trains, fresh, STATIONS, NOW);
    mergeBoard(trains, stale, STATIONS, NOW);

    expect(trains.get('R1')?.stops.find((s) => s.crs === 'CLJ')?.time).toBe(at('13:06'));
    expect(trains.get('R1')?.stops.find((s) => s.crs === 'SUR')?.time).toBe(at('13:21'));
  });

  it('without a parseable generatedAt, sightings are applied in arrival order', () => {
    const trains = new Map<string, NrTrackedTrain>();

    mergeBoard(trains, board('WAT', [service([cp('CLJ', '13:00', { et: '13:06' }), cp('SUR', '13:15')])]), STATIONS, NOW);
    mergeBoard(trains, board('WAT', [service([cp('CLJ', '13:00', { et: '13:02' }), cp('SUR', '13:15')])]), STATIONS, NOW + MIN);

    expect(trains.get('R1')?.stops.find((s) => s.crs === 'CLJ')?.time).toBe(at('13:02'));
  });
});

describe('mergeBoard — guard against estimates pulling the next stop into the past', () => {
  it('clamps an estimate earlier than now to now for a not-yet-reached stop after a departed one', () => {
    const trains = new Map<string, NrTrackedTrain>();
    const now = at('12:58');
    // WAT departed (12:50 < now), CLJ still ahead at 13:00
    mergeBoard(trains, board('WAT', [service([cp('CLJ', '13:00'), cp('SUR', '13:15')])]), STATIONS, now);

    // a lagging estimate claims CLJ at 12:57 — but there is no actual arrival
    mergeBoard(trains, board('WAT', [service([cp('CLJ', '13:00', { et: '12:57' }), cp('SUR', '13:15')])]), STATIONS, now);

    expect(trains.get('R1')?.stops.find((s) => s.crs === 'CLJ')?.time).toBe(now);
  });

  it('does not clamp an actual time', () => {
    const trains = new Map<string, NrTrackedTrain>();
    const now = at('12:58');
    mergeBoard(trains, board('WAT', [service([cp('CLJ', '13:00'), cp('SUR', '13:15')])]), STATIONS, now);

    mergeBoard(trains, board('WAT', [service([cp('CLJ', '13:00', { at: '12:57' }), cp('SUR', '13:15')])]), STATIONS, now);

    expect(trains.get('R1')?.stops.find((s) => s.crs === 'CLJ')?.time).toBe(at('12:57'));
  });
});

describe('mergeBoard — unchanged behaviour', () => {
  it('ignores cancelled services and keeps the existing timeline', () => {
    const trains = new Map<string, NrTrackedTrain>();
    mergeBoard(trains, board('WAT', [service([cp('CLJ', '13:00'), cp('SUR', '13:15')])]), STATIONS, NOW);

    mergeBoard(trains, board('WAT', [service([cp('CLJ', '13:00', { et: '13:30' }), cp('SUR', '13:15')], { cancelled: true })]), STATIONS, NOW);
    mergeBoard(trains, board('WAT', [service([cp('CLJ', '13:00')], { rid: 'R2', cancelled: true })]), STATIONS, NOW);

    expect(timeline(trains.get('R1'))).toEqual([
      ['WAT', at('12:50')],
      ['CLJ', at('13:00')],
      ['SUR', at('13:15')],
    ]);
    expect(trains.has('R2')).toBe(false);
  });

  it('skips sightings with fewer than two usable stops, new or existing', () => {
    const trains = new Map<string, NrTrackedTrain>();
    // only out-of-box calling points → just the board station survives
    mergeBoard(trains, board('WAT', [service([cp('XXX', '13:00')], { rid: 'R2' })]), STATIONS, NOW);
    mergeBoard(trains, board('WAT', [service([cp('CLJ', '13:00'), cp('SUR', '13:15')])]), STATIONS, NOW);

    mergeBoard(trains, board('XYZ', [service([cp('SUR', '13:15', { et: '13:40' })])]), STATIONS, NOW);

    expect(trains.has('R2')).toBe(false);
    expect(trains.get('R1')?.stops.find((s) => s.crs === 'SUR')?.time).toBe(at('13:15'));
  });

  it('collapses consecutive stops sharing a CRS and snaps gateways to their in-box node', () => {
    const trains = new Map<string, NrTrackedTrain>();
    const stations = new Map(STATIONS);
    stations.set('WBY', { crs: 'WBY', name: 'West Byfleet', lat: 51.33, lon: -0.5 });

    mergeBoard(trains, board('WAT', [service([cp('WAT', '12:50'), cp('CLJ', '13:00'), cp('WOK', '13:25')])]), stations, NOW);

    expect(trains.get('R1')?.stops.map((s) => s.crs)).toEqual(['WAT', 'CLJ', 'WBY']);
  });
});
