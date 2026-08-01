// Behavioural spec for the 1-D arc-length Kalman filter (bus-kalman.ts).
// Scenarios use synthetic fix sequences with hand-crafted noise (no RNG — the
// suite must be deterministic) and assert on convergence, gating, and the
// covariance staying healthy. See docs/BUS_KALMAN.md for parameter derivations.

import { describe, expect, test } from 'vitest';
import {
  KF_COAST_TAU_S,
  KF_MAX_REJECTS,
  KF_MAX_SPEED_MS,
  KF_MEAS_SIGMA_FLOOR_M,
  KF_DEFAULT_MEAS_SIGMA_M,
  type BusKfState,
  kfCoastS,
  kfInit,
  kfStep,
  measurementVariance,
  cumulativeLengthsM,
  pointAtArclen,
  tangentSpeedMs,
  type ArcPoint,
} from './bus-kalman';

/** Typical measurement variance: a decent learned route (σ ≈ 15 m). */
const R_TYPICAL = 15 * 15;

/** Feed a run of noiseless constant-speed fixes; returns the final state. */
function runConstantSpeed(
  st: BusKfState,
  vTrue: number,
  dtS: number,
  n: number,
  noise: readonly number[] = [],
  r = R_TYPICAL,
): BusKfState {
  let truth = st.s;
  let t = st.t;
  for (let i = 0; i < n; i += 1) {
    truth += vTrue * dtS;
    t += dtS * 1000;
    kfStep(st, truth + (noise[i % Math.max(noise.length, 1)] ?? 0), t, r);
  }
  return st;
}

describe('measurementVariance', () => {
  test('typical learned-route residual maps through the 1.25 MAD→σ factor', () => {
    // σ = 1.25 × 12.3 ≈ 15.4 m — well above the floor, so the factor applies.
    expect(measurementVariance(12.3)).toBeCloseTo((1.25 * 12.3) ** 2, 6);
  });

  test('very clean routes are clamped to the GPS noise floor', () => {
    expect(measurementVariance(2)).toBeCloseTo(KF_MEAS_SIGMA_FLOOR_M ** 2, 6);
  });

  test('missing or invalid residual falls back to the conservative default', () => {
    expect(measurementVariance(undefined)).toBeCloseTo(KF_DEFAULT_MEAS_SIGMA_M ** 2, 6);
    expect(measurementVariance(Number.NaN)).toBeCloseTo(KF_DEFAULT_MEAS_SIGMA_M ** 2, 6);
    expect(measurementVariance(-5)).toBeCloseTo(KF_DEFAULT_MEAS_SIGMA_M ** 2, 6);
  });
});

describe('kfInit', () => {
  test('seeds state and clamps an implausible initial speed', () => {
    const st = kfInit(1000, 5, 1_700_000_000_000);
    expect(st.s).toBe(1000);
    expect(st.v).toBe(5);
    expect(st.t).toBe(1_700_000_000_000);
    expect(st.rejects).toBe(0);
    expect(st.pS).toBeGreaterThan(0);
    expect(st.pV).toBeGreaterThan(0);

    // Raw-velocity seeds can be GPS-glitch garbage — init must clamp them.
    expect(kfInit(0, 55, 0).v).toBe(KF_MAX_SPEED_MS);
    expect(kfInit(0, -55, 0).v).toBe(-KF_MAX_SPEED_MS);
  });
});

describe('kfStep — convergence', () => {
  test('locks onto a constant-speed bus from noiseless fixes', () => {
    const st = kfInit(0, 0, 0);
    runConstantSpeed(st, 8, 20, 10);
    expect(st.v).toBeCloseTo(8, 0.5);
    // s is the position at the LAST fix time (200 s → truth 1600 m).
    expect(Math.abs(st.s - 1600)).toBeLessThan(10);
  });

  test('keeps a stable speed estimate through ±15 m measurement noise', () => {
    const st = kfInit(0, 8, 0);
    // Zero-mean hand-crafted noise, σ ≈ 12 m.
    runConstantSpeed(st, 8, 20, 16, [18, -12, 9, -15, 6, -10, 14, -7]);
    expect(Math.abs(st.v - 8)).toBeLessThan(2);
  });

  test('tracks a reversed polyline (negative arc-length velocity)', () => {
    const st = kfInit(5000, 0, 0);
    runConstantSpeed(st, -8, 20, 10);
    expect(st.v).toBeLessThan(-6);
  });

  test('never exceeds the speed clamp even under persistent fast fixes', () => {
    const st = kfInit(0, 18, 0);
    // Fixes implying 22 m/s arrive close together (small dt keeps them in-gate).
    let truth = 0;
    let t = 0;
    for (let i = 0; i < 30; i += 1) {
      truth += 22 * 10;
      t += 10_000;
      kfStep(st, truth, t, R_TYPICAL);
      expect(st.v).toBeLessThanOrEqual(KF_MAX_SPEED_MS);
    }
  });
});

describe('kfStep — gating', () => {
  /** A filter that has settled on 8 m/s with fixes every 20 s. */
  function settled(): BusKfState {
    const st = kfInit(0, 8, 0);
    return runConstantSpeed(st, 8, 20, 8);
  }

  test('a teleporting fix is rejected and barely moves the state', () => {
    const st = settled();
    const sBefore = st.s;
    const vBefore = st.v;
    // Next fix 20 s later but 400 m off the prediction — a GPS glitch.
    const result = kfStep(st, sBefore + 8 * 20 + 400, st.t + 20_000, R_TYPICAL);
    expect(result).toBe('gated');
    expect(st.rejects).toBe(1);
    // State advanced by prediction only (≈ v·dt), not toward the outlier.
    expect(Math.abs(st.s - (sBefore + 8 * 20))).toBeLessThan(1);
    expect(st.v).toBeCloseTo(vBefore, 5);
  });

  test('an accepted fix resets the consecutive-reject counter', () => {
    const st = settled();
    kfStep(st, st.s + 8 * 20 + 400, st.t + 20_000, R_TYPICAL); // gated
    const good = st.s + 8 * 20; // plausible follow-up
    expect(kfStep(st, good, st.t + 20_000, R_TYPICAL)).toBe('accepted');
    expect(st.rejects).toBe(0);
  });

  test('persistent disagreement asks for a reset after KF_MAX_REJECTS', () => {
    const st = settled();
    const results: string[] = [];
    for (let i = 1; i <= KF_MAX_REJECTS; i += 1) {
      // Fixes consistently ~5 km ahead — a cross-town relocation (vehicle
      // reassigned). It must stay OUTSIDE the gate for all three fixes: each
      // gated predict widens the gate (that's by design — moderate offsets
      // get wide-gated back in, which is reset-in-all-but-name), so only a
      // disagreement that outruns the widening exercises the reset path.
      results.push(kfStep(st, st.s + 8 * 20 + 5_000, st.t + 20_000, R_TYPICAL));
    }
    expect(results.slice(0, -1).every((r) => r === 'gated')).toBe(true);
    expect(results[results.length - 1]).toBe('reset');
  });

  test('the gate widens with the fix gap — honest 2-minute gaps are not rejected', () => {
    const st = settled();
    // 120 s silent, then a fix 150 m off the constant-speed prediction: within
    // what a bus stuck at / released from a light can plausibly do.
    const z = st.s + 8 * 120 - 150;
    expect(kfStep(st, z, st.t + 120_000, R_TYPICAL)).toBe('accepted');
  });
});

describe('kfStep — robustness', () => {
  test('out-of-order fix timestamps do not crash or rewind time', () => {
    const st = kfInit(1000, 8, 100_000);
    const tBefore = st.t;
    expect(() => kfStep(st, 995, 90_000, R_TYPICAL)).not.toThrow();
    expect(st.t).toBeGreaterThanOrEqual(tBefore);
    expect(Number.isFinite(st.s)).toBe(true);
  });

  test('covariance stays positive and consistent over a long mixed run', () => {
    const st = kfInit(0, 0, 0);
    const noise = [22, -19, 8, -3, 31, -27, 12, 0, -14, 6];
    let truth = 0;
    let t = 0;
    for (let i = 0; i < 200; i += 1) {
      const dt = i % 7 === 0 ? 95 : 18; // occasional long gaps
      truth += 7 * dt;
      t += dt * 1000;
      kfStep(st, truth + (noise[i % noise.length] ?? 0), t, R_TYPICAL);
      expect(st.pS).toBeGreaterThan(0);
      expect(st.pV).toBeGreaterThan(0);
      // Cauchy–Schwarz: the cross term can never exceed the marginals.
      expect(st.pSV * st.pSV).toBeLessThanOrEqual(st.pS * st.pV * (1 + 1e-9));
    }
  });
});

describe('kfCoastS — decaying coast', () => {
  const st = kfInit(1000, 10, 0);

  test('matches plain extrapolation for the first seconds after a fix', () => {
    // Fresh fixes deserve near-full trust in v: within 2 s the decayed
    // advance must be within ~10% of linear v·Δt.
    const coasted = kfCoastS(st, 2_000) - 1000;
    expect(coasted).toBeGreaterThan(10 * 2 * 0.9);
    expect(coasted).toBeLessThanOrEqual(10 * 2);
  });

  test('slows monotonically and never exceeds the v·τ coast budget', () => {
    let prev = kfCoastS(st, 0);
    let prevT = 0;
    let prevSpeed = Infinity;
    for (const t of [5, 10, 20, 40, 80, 160, 320]) {
      const cur = kfCoastS(st, t * 1000);
      const speed = (cur - prev) / (t - prevT); // mean speed over the window
      expect(cur).toBeGreaterThanOrEqual(prev); // keeps creeping forward…
      expect(speed).toBeLessThan(prevSpeed); // …but ever slower (decelerating)
      prev = cur;
      prevT = t;
      prevSpeed = speed;
    }
    // Hard bound: a silent bus can never coast further than v·τ.
    expect(kfCoastS(st, 3_600_000)).toBeLessThanOrEqual(1000 + 10 * KF_COAST_TAU_S);
    expect(kfCoastS(st, 3_600_000)).toBeCloseTo(1000 + 10 * KF_COAST_TAU_S, 1);
  });

  test('a reversed-polyline bus coasts backwards toward its own bound', () => {
    const rev = kfInit(5000, -8, 0);
    expect(kfCoastS(rev, 3_600_000)).toBeCloseTo(5000 - 8 * KF_COAST_TAU_S, 1);
  });

  test('clock skew / same-ms render never extrapolates backwards in time', () => {
    expect(kfCoastS(st, -5_000)).toBeCloseTo(1000, 6);
    expect(kfCoastS(st, 0)).toBeCloseTo(1000, 6);
  });
});

describe('arc-length geometry', () => {
  // L-shaped test line: 300 m east, then 400 m north (total 700 m).
  const xs = new Float64Array([0, 300, 300]);
  const ys = new Float64Array([0, 0, 400]);
  const cum = cumulativeLengthsM(xs, ys);

  test('cumulativeLengthsM accumulates per-vertex arc length', () => {
    expect([...cum]).toEqual([0, 300, 700]);
  });

  const at = (s: number, hint = 0): ArcPoint => {
    const out: ArcPoint = { x: 0, y: 0, seg: 0, bearing: 0 };
    pointAtArclen(xs, ys, cum, s, hint, out);
    return out;
  };

  test('interpolates mid-segment with the segment tangent as bearing', () => {
    const p = at(150);
    expect(p.x).toBeCloseTo(150, 6);
    expect(p.y).toBeCloseTo(0, 6);
    expect(p.seg).toBe(0);
    expect(p.bearing).toBeCloseTo(90, 6); // due east

    const q = at(500);
    expect(q.x).toBeCloseTo(300, 6);
    expect(q.y).toBeCloseTo(200, 6);
    expect(q.seg).toBe(1);
    expect(q.bearing).toBeCloseTo(0, 6); // due north
  });

  test('clamps beyond both ends of the polyline', () => {
    const start = at(-50);
    expect(start.x).toBeCloseTo(0, 6);
    expect(start.y).toBeCloseTo(0, 6);
    const end = at(9999);
    expect(end.x).toBeCloseTo(300, 6);
    expect(end.y).toBeCloseTo(400, 6);
  });

  test('walks to the right segment from a stale hint in either direction', () => {
    expect(at(500, 0).seg).toBe(1); // hint behind → walks forward
    expect(at(100, 1).seg).toBe(0); // hint ahead → walks back
  });

  test('tangentSpeedMs signs the seed speed by travel direction', () => {
    // Segment 0 points due east: eastward velocity is positive s-direction…
    expect(tangentSpeedMs(xs, ys, 0, 7, 0)).toBeCloseTo(7, 6);
    // …westward is negative (reversed polyline / bus reversing at a stand)…
    expect(tangentSpeedMs(xs, ys, 0, -7, 0)).toBeCloseTo(-7, 6);
    // …and perpendicular motion contributes nothing along the route.
    expect(tangentSpeedMs(xs, ys, 0, 0, 5)).toBeCloseTo(0, 6);
  });

  test('tangentSpeedMs returns 0 on a degenerate zero-length segment', () => {
    const dxs = new Float64Array([10, 10]);
    const dys = new Float64Array([20, 20]);
    expect(tangentSpeedMs(dxs, dys, 0, 9, 9)).toBe(0);
  });
});
