import { describe, expect, test } from 'vitest';
import { inferTrains, RUN_HORIZON_S } from './position-inference';
import type { LineBranches, Prediction } from './types';

// ── fixtures: a straight 3-stop test line, 1km between stops, west→east ──
// 0.001° lon ≈ 69 m at London latitude; stops at lon 0, 0.0145, 0.029 ≈ 1km apart.
const STOP_A = { id: 'A', name: 'Alpha', lon: 0, lat: 51.5 };
const STOP_B = { id: 'B', name: 'Beta', lon: 0.0145, lat: 51.5 };
const STOP_C = { id: 'C', name: 'Gamma', lon: 0.029, lat: 51.5 };

function straightLine(lineId: string): LineBranches {
  const seg = (a: typeof STOP_A, b: typeof STOP_A): [number, number][] => [
    [a.lon, a.lat],
    [b.lon, b.lat],
  ];
  return {
    lineId,
    branches: [
      {
        branchId: 0,
        direction: 'outbound',
        stops: [STOP_A, STOP_B, STOP_C],
        segments: [seg(STOP_A, STOP_B), seg(STOP_B, STOP_C)],
      },
      {
        branchId: 1,
        direction: 'inbound',
        stops: [STOP_C, STOP_B, STOP_A],
        segments: [seg(STOP_C, STOP_B), seg(STOP_B, STOP_A)],
      },
    ],
  };
}

const branchesFor = (...lineIds: string[]): Map<string, LineBranches> =>
  new Map(lineIds.map((id) => [id, straightLine(id)]));

// Same geometry as straightLine, but the middle stop carries a real-world name
// with punctuation (apostrophe / "St." / hyphen) to exercise name normalization.
function namedMiddleLine(lineId: string, bName: string): Map<string, LineBranches> {
  const line = straightLine(lineId);
  for (const br of line.branches) {
    for (const s of br.stops) if (s.id === 'B') (s as { name: string }).name = bName;
  }
  return new Map([[lineId, line]]);
}

const pred = (over: Partial<Prediction>): Prediction => ({
  lineId: 'victoria',
  naptanId: 'B',
  timeToStation: 60,
  ...over,
});

describe('basic placement', () => {
  test('places train on the segment approaching its next stop', () => {
    const trains = inferTrains(
      [pred({ vehicleId: '123', direction: 'outbound', currentLocation: 'Between Alpha and Beta' })],
      branchesFor('victoria'),
    );
    expect(trains).toHaveLength(1);
    const [t] = trains;
    expect(t.nextStopId).toBe('B');
    // 1km segment at 12 m/s → ~83s run; 60s out → ~28% along from Alpha
    expect(t.lngLat[0]).toBeGreaterThan(STOP_A.lon);
    expect(t.lngLat[0]).toBeLessThan(STOP_B.lon);
    expect(t.lngLat[1]).toBeCloseTo(51.5, 5);
  });

  test('a nearly-arrived train sits at the platform', () => {
    const trains = inferTrains(
      [pred({ vehicleId: '123', direction: 'outbound', timeToStation: 5, currentLocation: 'At Platform' })],
      branchesFor('victoria'),
    );
    expect(trains[0].lngLat).toEqual([STOP_B.lon, STOP_B.lat]);
  });

  test('closer countdown places the train closer to the station', () => {
    const at = (tts: number): number =>
      inferTrains(
        [pred({ vehicleId: '1', direction: 'outbound', timeToStation: tts, currentLocation: 'x' })],
        branchesFor('victoria'),
      )[0].lngLat[0];
    expect(at(20)).toBeGreaterThan(at(40));
    expect(at(40)).toBeGreaterThan(at(70));
  });
});

describe('departed trains are never pinned at the previous stop', () => {
  test('"Between X and Y" with countdown above the schedule still places past the stop', () => {
    // 1km test segment ≈ 83s scheduled, but countdown says 200s — without the
    // currentLocation override the ratio would clamp the train onto Alpha
    const [t] = inferTrains(
      [pred({ vehicleId: '7', naptanId: 'B', timeToStation: 200, direction: 'outbound', currentLocation: 'Between Alpha and Beta' })],
      branchesFor('victoria'),
    );
    expect(t.lngLat[0]).toBeGreaterThan(STOP_A.lon); // strictly departed
    expect(t.lngLat[0]).toBeLessThan(STOP_B.lon);
    expect(t.runTimeS).toBeGreaterThan(200); // stretched bound feeds dead reckoning
  });

  test('a dwelling train ("At Platform") is still allowed to sit at the stop', () => {
    const [t] = inferTrains(
      [pred({ vehicleId: '7', naptanId: 'B', timeToStation: 200, direction: 'outbound', currentLocation: 'At Platform' })],
      branchesFor('victoria'),
    );
    expect(t.lngLat[0]).toBeCloseTo(STOP_A.lon, 5);
  });
});

describe('at-platform handoff (stale "due" cannot pin a departed train)', () => {
  const both = (ttsB: number, ttsC: number): Prediction[] => [
    pred({ vehicleId: '9', naptanId: 'B', timeToStation: ttsB, direction: 'outbound', currentLocation: 'At Platform' }),
    pred({ vehicleId: '9', naptanId: 'C', timeToStation: ttsC, direction: 'outbound', currentLocation: 'At Platform' }),
  ];

  test('while dwelling, the successor countdown holds the train at the stop', () => {
    // 1km segment ≈ 83s scheduled; 200s to C means it has not departed yet
    const [t] = inferTrains(both(5, 200), branchesFor('victoria'));
    expect(t.nextStopId).toBe('C');
    expect(t.lngLat[0]).toBeCloseTo(STOP_B.lon, 5);
  });

  test('a lingering "due" at the left-behind stop no longer pins the train', () => {
    // stale due at B, but only 40s to C → the train is visibly en route to C
    const [t] = inferTrains(both(5, 40), branchesFor('victoria'));
    expect(t.nextStopId).toBe('C');
    expect(t.lngLat[0]).toBeGreaterThan(STOP_B.lon);
    expect(t.lngLat[0]).toBeLessThan(STOP_C.lon);
  });

  test('no successor prediction (terminus) keeps the train at the platform', () => {
    const [t] = inferTrains(
      [pred({ vehicleId: '9', naptanId: 'C', timeToStation: 5, direction: 'outbound', currentLocation: 'At Platform' })],
      branchesFor('victoria'),
    );
    expect(t.lngLat).toEqual([STOP_C.lon, STOP_C.lat]);
  });
});

describe('currentLocation ARRIVING/AT compensation (Metropolitan lag fix)', () => {
  // (a) "Approaching <next stop>" with a laggy-high countdown: the raw ratio
  // (1km ≈ 83s run, 70s out → ~0.16) would strand it near the previous stop.
  test('"Approaching <nextStop>" with laggy-high tts is advanced to >= 0.85', () => {
    const [t] = inferTrains(
      [pred({ vehicleId: '11', naptanId: 'B', timeToStation: 70, direction: 'outbound', currentLocation: 'Approaching Beta' })],
      branchesFor('victoria'),
    );
    expect(t.nextStopId).toBe('B');
    expect(t.segmentFrac).toBeGreaterThanOrEqual(0.85); // advanced near the platform
    expect(t.lngLat[0]).toBeGreaterThanOrEqual(STOP_A.lon + 0.85 * (STOP_B.lon - STOP_A.lon));
    expect(t.lngLat[0]).toBeLessThanOrEqual(STOP_B.lon);
  });

  // (b) "At <next stop> Platform" with tts still high: today (tts 40 > 15) it
  // would sit mid-segment (~0.52); the 'At X' arm places it AT the station.
  test('"At <nextStop> Platform" with tts=40 is placed AT the station (frac=1)', () => {
    const [t] = inferTrains(
      [pred({ vehicleId: '12', naptanId: 'B', timeToStation: 40, direction: 'outbound', currentLocation: 'At Beta Platform' })],
      branchesFor('victoria'),
    );
    expect(t.nextStopId).toBe('B');
    expect(t.segmentFrac).toBe(1);
    expect(t.lngLat).toEqual([STOP_B.lon, STOP_B.lat]);
  });

  // (b′) with a successor prediction, "At <nextStop>" fires the handoff even
  // above AT_PLATFORM_S: the train pulls away toward C on C's countdown.
  test('"At <nextStop> Platform" above AT_PLATFORM_S fires the successor handoff', () => {
    const [t] = inferTrains(
      [
        pred({ vehicleId: '13', naptanId: 'B', timeToStation: 40, direction: 'outbound', currentLocation: 'At Beta Platform' }),
        pred({ vehicleId: '13', naptanId: 'C', timeToStation: 45, direction: 'outbound', currentLocation: 'At Beta Platform' }),
      ],
      branchesFor('victoria'),
    );
    expect(t.nextStopId).toBe('C'); // handed off to the successor stop
    expect(t.lngLat[0]).toBeGreaterThan(STOP_B.lon);
    expect(t.lngLat[0]).toBeLessThan(STOP_C.lon);
  });

  // (c) false-positive guard: the named station is NOT the next stop → no snap.
  test('"At <otherStation> Platform" (not the next stop) does NOT snap the train', () => {
    const [t] = inferTrains(
      // next stop is Beta, but the string names Gamma (a real stop, not next)
      [pred({ vehicleId: '14', naptanId: 'B', timeToStation: 40, direction: 'outbound', currentLocation: 'At Gamma Platform' })],
      branchesFor('victoria'),
    );
    expect(t.nextStopId).toBe('B');
    expect(t.segmentFrac).toBeLessThan(0.85); // left where the countdown puts it
    expect(t.lngLat[0]).toBeGreaterThan(STOP_A.lon);
    expect(t.lngLat[0]).toBeLessThan(STOP_B.lon);
  });

  // (d) name normalization: apostrophe / "St." / hyphen variants still match.
  test('normalized name variants match ("Kings Cross St Pancras", hyphen forms)', () => {
    const apos = inferTrains(
      [pred({ lineId: 'metropolitan', vehicleId: '15', naptanId: 'B', timeToStation: 40, direction: 'outbound', currentLocation: 'At Kings Cross St Pancras Platform 3' })],
      namedMiddleLine('metropolitan', "King's Cross St. Pancras"),
    )[0];
    expect(apos.segmentFrac).toBe(1); // matched despite apostrophe + "St." variance

    const hyphen = inferTrains(
      [pred({ lineId: 'metropolitan', vehicleId: '16', naptanId: 'B', timeToStation: 70, direction: 'outbound', currentLocation: 'Approaching Harrow-on-the-Hill' })],
      namedMiddleLine('metropolitan', 'Harrow-on-the-Hill'),
    )[0];
    expect(hyphen.segmentFrac).toBeGreaterThanOrEqual(0.85);
  });

  // (e) a normal, well-calibrated case is unaffected: currentLocation matches
  // neither arm ("Between …"), so positioning is the plain ratio as before.
  test('an accurate-line train with a non-matching currentLocation is unchanged', () => {
    const withArm = inferTrains(
      [pred({ lineId: 'district', vehicleId: '17', naptanId: 'B', timeToStation: 40, direction: 'outbound', currentLocation: 'Between Alpha and Beta' })],
      branchesFor('district'),
    )[0];
    // 1km ≈ 83s run, 40s out → ~0.52 along; not clamped, not snapped
    expect(withArm.segmentFrac).toBeGreaterThan(0.4);
    expect(withArm.segmentFrac).toBeLessThan(0.6);
  });
});

describe('identity resolution', () => {
  test('synthesizes a stable identity from currentLocation when vehicleId is missing', () => {
    const echoes = [
      pred({ naptanId: 'B', timeToStation: 40, currentLocation: 'Between Alpha and Beta', direction: 'outbound' }),
      pred({ naptanId: 'C', timeToStation: 200, currentLocation: 'Between Alpha and Beta', direction: 'outbound' }),
    ];
    const trains = inferTrains(echoes, branchesFor('victoria'));
    expect(trains).toHaveLength(1); // both echoes collapse onto one train
    expect(trains[0].nextStopId).toBe('B'); // positioned by the nearest echo
    expect(trains[0].synthetic).toBe(true);
  });

  test('id-less echoes do not spawn a twin of a vehicleId train at the same block', () => {
    const loc = 'Between Alpha and Beta';
    const trains = inferTrains(
      [
        pred({ vehicleId: '77', currentLocation: loc, direction: 'outbound', timeToStation: 45 }),
        pred({ currentLocation: loc, direction: 'outbound', naptanId: 'C', timeToStation: 250 }),
      ],
      branchesFor('victoria'),
    );
    expect(trains).toHaveLength(1);
    expect(trains[0].vehicleId).toBe('77');
  });

  test('two id-less trains sharing a block but heading opposite ways stay apart', () => {
    const loc = 'Near Beta';
    const trains = inferTrains(
      [
        pred({ currentLocation: loc, direction: 'outbound', naptanId: 'C', timeToStation: 60 }),
        pred({ currentLocation: loc, direction: 'inbound', naptanId: 'A', timeToStation: 60 }),
      ],
      branchesFor('victoria'),
    );
    expect(trains).toHaveLength(2);
  });
});

describe('cross-line ghost dedup (shared sub-surface stock)', () => {
  test('keeps only the most-live listing of a District train cross-listed on Circle', () => {
    const trains = inferTrains(
      [
        pred({ lineId: 'district', vehicleId: '42', timeToStation: 30, direction: 'outbound', currentLocation: 'x' }),
        pred({ lineId: 'circle', vehicleId: '42', timeToStation: 400, direction: 'outbound', currentLocation: 'x' }),
      ],
      branchesFor('district', 'circle'),
    );
    expect(trains).toHaveLength(1);
    expect(trains[0].lineId).toBe('district');
  });

  test('deep-tube lines recycle ids independently and must NOT merge', () => {
    const trains = inferTrains(
      [
        pred({ lineId: 'victoria', vehicleId: '052', timeToStation: 30, direction: 'outbound', currentLocation: 'x' }),
        pred({ lineId: 'bakerloo', vehicleId: '052', timeToStation: 30, direction: 'outbound', currentLocation: 'x' }),
      ],
      branchesFor('victoria', 'bakerloo'),
    );
    expect(trains).toHaveLength(2);
  });
});

describe('DLR leading-edge dedup', () => {
  test('collapses multi-stop echoes of one DLR train to its leading edge', () => {
    const dlr = (naptanId: string, tts: number): Prediction =>
      pred({ lineId: 'dlr', vehicleId: undefined, currentLocation: undefined, naptanId, timeToStation: tts, direction: 'outbound', destinationName: 'Gamma' });
    const trains = inferTrains([dlr('B', 50), dlr('C', 300)], branchesFor('dlr'));
    expect(trains).toHaveLength(1);
    expect(trains[0].nextStopId).toBe('B');
  });

  test('two DLR trains to the same terminus at different stops both survive', () => {
    const dlr = (naptanId: string, tts: number): Prediction =>
      pred({ lineId: 'dlr', vehicleId: undefined, currentLocation: undefined, naptanId, timeToStation: tts, direction: 'outbound', destinationName: 'Gamma' });
    // train 1 approaching B (50s); train 2 approaching C (100s) — but B also has
    // a 380s echo of... no: leading-edge keeps C only if B's echo isn't sooner.
    // Here C at 100s with B at 50s means C IS an echo of the B train — collapsed.
    // Distinct trains need the rear one behind a stop the front one passed:
    const trains = inferTrains([dlr('C', 60), dlr('B', 90)], branchesFor('dlr'));
    // C due sooner than B → C's train is ahead; B is a separate following train.
    expect(trains).toHaveLength(2);
  });
});

describe('timetable horizon filter', () => {
  test('drops position-less predictions beyond the horizon (not yet departed)', () => {
    const trains = inferTrains(
      [pred({ lineId: 'elizabeth', timeToStation: RUN_HORIZON_S + 60, direction: 'outbound' })],
      branchesFor('elizabeth'),
    );
    expect(trains).toHaveLength(0);
  });

  test('keeps position-less predictions inside the horizon', () => {
    const trains = inferTrains(
      [pred({ lineId: 'elizabeth', timeToStation: 120, direction: 'outbound' })],
      branchesFor('elizabeth'),
    );
    expect(trains).toHaveLength(1);
  });

  test('a vehicleId timetable listing with no live position is still horizon-filtered', () => {
    // Overground/Elizabeth stamp unique vehicleIds on pure-timetable journeys ~2h out
    const trains = inferTrains(
      [pred({ lineId: 'elizabeth', vehicleId: '227010', timeToStation: 3600, direction: 'outbound' })],
      branchesFor('elizabeth'),
    );
    expect(trains).toHaveLength(0);
  });

  test('live-positioned trains are exempt from the horizon', () => {
    const trains = inferTrains(
      [pred({ vehicleId: '9', currentLocation: 'x', direction: 'outbound', timeToStation: RUN_HORIZON_S + 60, naptanId: 'B' })],
      branchesFor('victoria'),
    );
    expect(trains).toHaveLength(1);
  });
});
