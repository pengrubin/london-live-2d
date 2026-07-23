import { describe, expect, test } from 'vitest';
import { TrainInterpolator } from './interpolator';
import { metersBetween, pointAtFraction, projectFraction } from './geometry';
import type { Train } from './types';

// straight west→east test segment, ~1km
const SEGMENT: [number, number][] = [
  [0, 51.5],
  [0.0145, 51.5],
];
// an L-shaped segment to prove display stays ON the track through corners
const BENT_SEGMENT: [number, number][] = [
  [0, 51.5],
  [0.0145, 51.5],
  [0.0145, 51.509],
];

const train = (over: Partial<Train>): Train => ({
  key: 'victoria:1',
  lineId: 'victoria',
  lineName: 'Victoria',
  currentLocation: '',
  platformName: '',
  vehicleId: '1',
  nextStopId: 'B',
  nextStopName: 'Beta',
  timeToStation: 60,
  direction: 'outbound',
  destination: 'Gamma',
  lngLat: pointAtFraction(SEGMENT, 0).lngLat,
  bearing: 90,
  synthetic: false,
  segment: SEGMENT,
  segmentFrac: 0,
  segmentKey: 'victoria:0:outbound:1',
  ...over,
});

const at = (frac: number, seg = SEGMENT): Partial<Train> => ({
  segmentFrac: frac,
  lngLat: pointAtFraction(seg, frac).lngLat,
});

describe('TrainInterpolator (track space)', () => {
  test('a new train appears at its target immediately', () => {
    const itp = new TrainInterpolator();
    itp.update([train(at(0.5))], 0);
    const [d] = itp.frame(16);
    expect(metersBetween(d.lngLat, pointAtFraction(SEGMENT, 0.5).lngLat)).toBeLessThan(1);
  });

  test('eases toward a new target without teleporting, then converges', () => {
    const itp = new TrainInterpolator();
    itp.update([train(at(0))], 0);
    itp.frame(16);
    itp.update([train(at(0.8))], 10000);
    const [step1] = itp.frame(500);
    const frac1 = projectFraction(SEGMENT, step1.lngLat);
    expect(frac1).toBeGreaterThan(0);
    expect(frac1).toBeLessThan(0.8);
    let last = step1;
    for (let i = 0; i < 100; i++) [last] = itp.frame(500);
    expect(metersBetween(last.lngLat, pointAtFraction(SEGMENT, 0.8).lngLat)).toBeLessThan(2);
  });

  test('snaps to the track through corners (never cuts across)', () => {
    const itp = new TrainInterpolator();
    const bent = (frac: number): Train =>
      train({ ...at(frac, BENT_SEGMENT), segment: BENT_SEGMENT });
    itp.update([bent(0.1)], 0);
    itp.frame(16);
    itp.update([bent(0.95)], 10000);
    // sample the path across many frames; every point must lie on the polyline
    for (let i = 0; i < 40; i++) {
      const [d] = itp.frame(400);
      const back = pointAtFraction(BENT_SEGMENT, projectFraction(BENT_SEGMENT, d.lngLat));
      expect(metersBetween(d.lngLat, back.lngLat)).toBeLessThan(1);
    }
  });

  test('holds position on small backward target jitter instead of reversing', () => {
    const itp = new TrainInterpolator();
    itp.update([train(at(0.5))], 0);
    itp.frame(16);
    itp.update([train(at(0.45))], 10000); // ~50m backward — jitter
    const before = projectFraction(SEGMENT, itp.frame(16)[0].lngLat);
    for (let i = 0; i < 20; i++) itp.frame(400);
    const after = projectFraction(SEGMENT, itp.frame(16)[0].lngLat);
    expect(after).toBeGreaterThanOrEqual(before - 1e-6); // no visible reverse
  });

  test('never rewinds within a segment, even on a large backward retarget', () => {
    const itp = new TrainInterpolator();
    itp.update([train(at(0.9))], 0);
    itp.frame(16);
    itp.update([train(at(0.2))], 10000); // countdown regression — hold, not jump
    for (let i = 0; i < 20; i++) itp.frame(500);
    const [d] = itp.frame(16);
    expect(metersBetween(d.lngLat, pointAtFraction(SEGMENT, 0.9).lngLat)).toBeLessThan(5);
  });

  test('carries continuity onto the next segment via projection', () => {
    const NEXT: [number, number][] = [
      [0.0145, 51.5],
      [0.029, 51.5],
    ];
    const itp = new TrainInterpolator();
    itp.update([train(at(0.98))], 0);
    itp.frame(16);
    itp.update(
      [
        train({
          ...at(0.4, NEXT),
          segment: NEXT,
          segmentKey: 'victoria:0:outbound:2',
          nextStopId: 'C',
        }),
      ],
      10000,
    );
    const [d] = itp.frame(16);
    // displayed point continues from near the segment boundary, not from 40% in
    const frac = projectFraction(NEXT, d.lngLat);
    expect(frac).toBeLessThan(0.2);
  });

  test('coasts a missing train through 30s feed gaps, drops it after 60s', () => {
    const itp = new TrainInterpolator();
    itp.update([train({})], 0);
    itp.update([], 30000); // probe-observed worst gap
    expect(itp.size).toBe(1);
    itp.update([], 70000); // beyond retention
    expect(itp.size).toBe(0);
  });

  test('a train arrived at its OWN destination releases quickly (short workings)', () => {
    const itp = new TrainInterpolator();
    itp.update([train({ ...at(1), destinationId: 'B', nextStopId: 'B' })], 0);
    itp.update([], 15000); // past ARRIVED_RETAIN_MS, well under RETAIN_MS
    expect(itp.size).toBe(0);
  });

  test('a mid-route train with a further destination coasts but never leaves its segment', () => {
    const itp = new TrainInterpolator();
    itp.update(
      [train({ ...at(0.7), destinationId: 'Z', timeToStation: 20, receivedAt: 0, runTimeS: 80 })],
      0,
    );
    // absent for 40s while dead reckoning runs far past the countdown
    let last = itp.frame(16, 0)[0];
    for (let i = 0; i < 80; i++) [last] = itp.frame(500, i * 500);
    expect(itp.size).toBe(1);
    // capped at the segment end (next stop B), not beyond
    expect(metersBetween(last.lngLat, pointAtFraction(SEGMENT, 1).lngLat)).toBeLessThan(2);
  });

  test('fades out over the retention tail', () => {
    const itp = new TrainInterpolator();
    itp.update([train({})], 0);
    expect(itp.frame(16, 1000)[0].opacity).toBe(1);
    expect(itp.frame(16, 55000)[0].opacity).toBeGreaterThan(0);
    expect(itp.frame(16, 55000)[0].opacity).toBeLessThan(1);
  });

  test('smooths countdown oscillation across polls (EMA)', () => {
    const itp = new TrainInterpolator();
    itp.update([train({ ...at(0.5), timeToStation: 60, receivedAt: 0, runTimeS: 120 })], 0);
    // 10s later the feed regresses the countdown to 70s; carried = 50s
    itp.update([train({ ...at(0.5), timeToStation: 70, receivedAt: 10000, runTimeS: 120 })], 10000);
    const smoothed = itp.frame(16, 10000)[0].train.timeToStation;
    expect(smoothed).toBe(60); // 0.5*70 + 0.5*50
  });

  test('hands a drifted synthetic identity over to its successor without a blink', () => {
    const itp = new TrainInterpolator();
    const old = train({
      key: 'victoria|Between Alpha and Beta',
      synthetic: true,
      ...at(0.6),
    });
    itp.update([old], 0);
    itp.frame(16, 0);
    // next poll: the identity string moved on; a new key appears 0 m away
    const successor = train({
      key: 'victoria|Between Beta and Gamma',
      synthetic: true,
      ...at(0.7),
    });
    itp.update([successor], 10000);
    const [d] = itp.frame(16, 10000);
    expect(itp.size).toBe(1);
    // display continues from the OLD position, easing forward — no jump to 0.7
    const frac = projectFraction(SEGMENT, d.lngLat);
    expect(frac).toBeLessThan(0.65);
  });

  test('dead-reckons continuously between polls from the countdown', () => {
    const itp = new TrainInterpolator();
    // 1km segment, 100s run time, 50s out → target frac 0.5 at receivedAt
    itp.update(
      [train({ ...at(0.5), timeToStation: 50, receivedAt: 0, runTimeS: 100 })],
      0,
    );
    itp.frame(16, 0);
    // 30s later with NO new poll: countdown extrapolates to 20s → target 0.8
    let last = itp.frame(16, 30000)[0];
    for (let i = 0; i < 60; i++) last = itp.frame(500, 30000 + i * 500)[0];
    const frac = projectFraction(SEGMENT, last.lngLat);
    expect(frac).toBeGreaterThan(0.7); // moved well past the poll-time target
  });

  test('a countdown regression cannot pull the dead-reckoned dot backward', () => {
    const itp = new TrainInterpolator();
    itp.update([train({ ...at(0.6), timeToStation: 40, receivedAt: 0, runTimeS: 100 })], 0);
    for (let i = 0; i < 20; i++) itp.frame(500, i * 500); // advance to ~0.7
    const before = projectFraction(SEGMENT, itp.frame(16, 10000)[0].lngLat);
    // next poll: countdown regressed 40s → 55s (target frac 0.45, behind us)
    itp.update([train({ ...at(0.45), timeToStation: 55, receivedAt: 10000, runTimeS: 100 })], 10000);
    for (let i = 0; i < 20; i++) itp.frame(500, 10000 + i * 500);
    const after = projectFraction(SEGMENT, itp.frame(16, 20000)[0].lngLat);
    expect(after).toBeGreaterThanOrEqual(before - 1e-6);
  });

  test('exposes segment assignments for branch hysteresis', () => {
    const itp = new TrainInterpolator();
    itp.update([train({})], 0);
    expect(itp.segmentAssignments().get('victoria:1')).toBe('victoria:0:outbound:1');
  });
});
