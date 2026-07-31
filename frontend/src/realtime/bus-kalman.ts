// 1-D Kalman filter along a learned bus-route polyline, plus the arc-length
// geometry it needs. Consumed by layers/buses.ts for snapped buses only; buses
// without a learned route keep the straight-line dead-reckoning model.
//
// Why a filter at all: BODS fixes are sparse (~80 s per bus) and carry urban
// GPS drift, and the previous model derived velocity from the last two fixes —
// one drifted fix could fully hijack speed AND heading for the whole
// extrapolation window. The filter weights every fix by uncertainty instead,
// so a suspect fix nudges the estimate rather than owning it.
//
// Why 1-D: the learned polyline (backend learner, quality-gated at
// mean residual ≤ 35 m) already answers "where can this bus be" — projecting
// each fix onto it discards the lateral drift component entirely, and the
// filter then only has to manage along-route noise. State is (s, v): arc
// length in meters and signed line speed in m/s. All covariance math is
// scalar — no matrix library, ~5 floats per bus.
//
// Time base: state time `t` is the FIX timestamp (BODS RecordedAtTime), never
// wall clock — fixes arrive 10-30 s stale and display code extrapolates the
// state forward to `now` (kfTargetS), exactly like the raw model extrapolates
// from RecordedAtTime. Full design + parameter derivations: docs/BUS_KALMAN.md.

/**
 * Process noise spectral density q, m²/s³ (continuous white-noise acceleration
 * model). Calibrated so that after a typical 80 s fix gap the filter admits
 * σ_v ≈ √(q·80) ≈ 4 m/s of speed change — a bus caught by a red light or
 * released from a stop. Larger q = trust fixes more; smaller = trust motion.
 */
export const KF_PROCESS_NOISE_M2_S3 = 0.2;
/** Innovation gate, in σ of the innovation variance: reject beyond 3σ (~99.7%). */
export const KF_GATE_SIGMA = 3;
/** Consecutive gated fixes before the caller should re-seed the filter — the
 * bus genuinely IS elsewhere (rerouted / GPS recovered), not glitching. */
export const KF_MAX_REJECTS = 3;
/** Initial position σ, m — matches the learner's corridor start (30 m): a
 * fresh snap knows the bus roughly this well. */
export const KF_INIT_SIGMA_S_M = 30;
/** Initial speed σ, m/s — the raw-model seed is a two-fix difference, so keep
 * healthy doubt about it. */
export const KF_INIT_SIGMA_V_MS = 3;
/** Per-route measurement σ floor, m — consumer GPS under open sky rarely does
 * better, however clean the learned residuals look. */
export const KF_MEAS_SIGMA_FLOOR_M = 8;
/** Measurement σ when the route JSON carries no usable quality field, m —
 * the worst residual the learner's gate ships is 35 m, i.e. σ = 1.25·35 ≈ 44:
 * an unknown-quality route gets no more trust than the worst known one. */
export const KF_DEFAULT_MEAS_SIGMA_M = 44;
/** |v| clamp, m/s — same ceiling the raw model uses (MAX_IMPLIED_SPEED_MS).
 * Signed: learned polylines are usually oriented along travel, but a reversed
 * one must track as negative v, not freeze at zero. */
export const KF_MAX_SPEED_MS = 20;
/** Mean-absolute-deviation → σ for a zero-mean Gaussian: σ = E|x|·√(π/2) ≈
 * 1.25·E|x|. The learner's meanResidualM is a MAD, not a σ. */
const MAD_TO_SIGMA = 1.25;

/** Filter state for one snapped bus. Mutated in place by kfStep — these live
 * in per-bus trackers updated from poll ingest (~110 updates/s fleet-wide). */
export interface BusKfState {
  /** Arc length along the learned polyline at time t, m. */
  s: number;
  /** Signed line speed, m/s (negative = travelling toward decreasing s). */
  v: number;
  /** Covariance: var(s), var(v), cov(s,v). */
  pS: number;
  pV: number;
  pSV: number;
  /** Timestamp of the state estimate — the last processed fix, epoch ms. */
  t: number;
  /** Consecutive gated (rejected) fixes; kfStep asks for a reset at the cap. */
  rejects: number;
}

export type KfStepResult = 'accepted' | 'gated' | 'reset';

/** Point on a polyline resolved from an arc length — reused per call site to
 * keep the per-tick display path allocation-free. */
export interface ArcPoint {
  x: number; // meters
  y: number; // meters
  seg: number;
  /** Polyline tangent at the point, degrees clockwise from north, oriented
   * along increasing s. Callers half-plane-correct against the bus heading. */
  bearing: number;
}

/** Fresh filter state from a projected fix (s0, m), a seed speed (v0, m/s —
 * clamped, it comes from the raw two-fix model) and the fix timestamp. */
export function kfInit(s0: number, v0: number, tMs: number): BusKfState {
  return {
    s: s0,
    v: Math.max(-KF_MAX_SPEED_MS, Math.min(KF_MAX_SPEED_MS, v0)),
    pS: KF_INIT_SIGMA_S_M * KF_INIT_SIGMA_S_M,
    pV: KF_INIT_SIGMA_V_MS * KF_INIT_SIGMA_V_MS,
    pSV: 0,
    t: tMs,
    rejects: 0,
  };
}

/**
 * Measurement variance R (m²) for a learned route, from the learner's stored
 * mean residual. Uses the MAD→σ factor, floored at consumer-GPS noise;
 * missing/invalid quality falls back to a conservative default.
 */
export function measurementVariance(meanResidualM: number | undefined): number {
  const sigma =
    meanResidualM !== undefined && Number.isFinite(meanResidualM) && meanResidualM >= 0
      ? Math.max(KF_MEAS_SIGMA_FLOOR_M, MAD_TO_SIGMA * meanResidualM)
      : KF_DEFAULT_MEAS_SIGMA_M;
  return sigma * sigma;
}

/**
 * Fold one projected fix (arc length zS at fix time zTMs) into the state:
 * predict to the fix time, gate the innovation at KF_GATE_SIGMA, and correct
 * (s, v) by the Kalman gain. Mutates `st` in place.
 *
 * Returns 'accepted' (normal), 'gated' (fix rejected as an outlier — state
 * advanced by prediction only), or 'reset' (KF_MAX_REJECTS consecutive gated
 * fixes: stop filtering and re-seed from this fix — the disagreement is real).
 */
export function kfStep(st: BusKfState, zS: number, zTMs: number, rVar: number): KfStepResult {
  // Out-of-order fixes (BODS occasionally rewinds RecordedAtTime): treat as
  // same-time — never step time backwards, the gate still judges the value.
  const dt = Math.max(0, (zTMs - st.t) / 1000);
  const q = KF_PROCESS_NOISE_M2_S3;

  // Predict to the fix time (constant-velocity model, continuous white-noise
  // acceleration: Q = q·[[dt³/3, dt²/2], [dt²/2, dt]]).
  st.s += st.v * dt;
  st.pS += 2 * st.pSV * dt + st.pV * dt * dt + (q * dt * dt * dt) / 3;
  st.pSV += st.pV * dt + (q * dt * dt) / 2;
  st.pV += q * dt;
  if (zTMs > st.t) st.t = zTMs;

  // Gate: innovation beyond KF_GATE_SIGMA·σ is an outlier, not information.
  const y = zS - st.s;
  const S = st.pS + rVar;
  if (y * y > KF_GATE_SIGMA * KF_GATE_SIGMA * S) {
    st.rejects += 1;
    return st.rejects >= KF_MAX_REJECTS ? 'reset' : 'gated';
  }
  st.rejects = 0;

  // Correct. H = [1, 0] (we only measure position), so the gain is scalar.
  const kS = st.pS / S;
  const kV = st.pSV / S;
  st.s += kS * y;
  st.v = Math.max(-KF_MAX_SPEED_MS, Math.min(KF_MAX_SPEED_MS, st.v + kV * y));
  // P ← (I − K·H)·P; pSV must be read before it is overwritten for pV.
  const pSVold = st.pSV;
  st.pS *= 1 - kS;
  st.pSV *= 1 - kS;
  st.pV -= kV * pSVold;
  return 'accepted';
}

/**
 * Display target: the state extrapolated from its fix time to `nowMs`, capped
 * at `horizonS` — the same "freeze rather than run away" behaviour the raw
 * model gets from MAX_EXTRAPOLATION_S. Clock skew never extrapolates backwards.
 */
export function kfTargetS(st: BusKfState, nowMs: number, horizonS: number): number {
  const extraS = Math.min(Math.max((nowMs - st.t) / 1000, 0), horizonS);
  return st.s + st.v * extraS;
}

/**
 * Signed speed (m/s) of a meter-space velocity vector along segment `seg` of
 * a polyline: the projection onto the local tangent, positive toward
 * increasing arc length. Seeds the filter's v from the raw model's velocity —
 * both on first snap and on reset re-seed, where the filter's own v must NOT
 * be reused (it is exactly the estimate that just got rejected). Returns 0
 * for a degenerate zero-length segment.
 */
export function tangentSpeedMs(
  xs: Float64Array,
  ys: Float64Array,
  seg: number,
  vxMs: number,
  vyMs: number,
): number {
  const dx = xs[seg + 1] - xs[seg];
  const dy = ys[seg + 1] - ys[seg];
  const len = Math.hypot(dx, dy);
  return len > 0 ? (vxMs * dx + vyMs * dy) / len : 0;
}

/** Cumulative arc length (m) at each vertex of a meter-space polyline. */
export function cumulativeLengthsM(xs: Float64Array, ys: Float64Array): Float64Array {
  const cum = new Float64Array(xs.length);
  for (let i = 1; i < xs.length; i += 1) {
    cum[i] = cum[i - 1] + Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]);
  }
  return cum;
}

/**
 * Resolve an arc length to a point on the polyline. `hint` is the segment the
 * caller last landed on — s moves a few meters per tick, so the walk is O(1)
 * amortised. Fills `out` (no allocation — this runs per snapped bus per tick)
 * and clamps s beyond either end to the endpoints.
 */
export function pointAtArclen(
  xs: Float64Array,
  ys: Float64Array,
  cum: Float64Array,
  s: number,
  hint: number,
  out: ArcPoint,
): void {
  const lastSeg = xs.length - 2;
  const sc = Math.max(0, Math.min(cum[cum.length - 1], s));
  let seg = Math.max(0, Math.min(lastSeg, hint));
  while (seg > 0 && cum[seg] > sc) seg -= 1;
  while (seg < lastSeg && cum[seg + 1] < sc) seg += 1;
  const segLen = cum[seg + 1] - cum[seg];
  const u = segLen > 0 ? (sc - cum[seg]) / segLen : 0;
  const dx = xs[seg + 1] - xs[seg];
  const dy = ys[seg + 1] - ys[seg];
  out.x = xs[seg] + dx * u;
  out.y = ys[seg] + dy * u;
  out.seg = seg;
  out.bearing = ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
}
