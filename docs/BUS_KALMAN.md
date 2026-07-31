# Bus arc-length Kalman filter

Why the bus motion model was changed (2026-07-31), how the filter works, and
what every parameter means. Code: `frontend/src/realtime/bus-kalman.ts`
(filter + arc-length geometry, pure functions, unit-tested) and
`frontend/src/layers/buses.ts` (integration).

## Why

The previous motion model derived a velocity from the **last two distinct
fixes** and dead-reckoned along it in a straight lat/lon line. Two observed
failure modes, both rooted in trusting every fix 100%:

1. **One drifted fix hijacks the motion.** BODS fixes carry urban-canyon GPS
   drift (verified on the ground: some spots drift tens of meters,
   consistently). A single bad fix in the two-fix pair corrupts both speed and
   heading for the whole 45 s extrapolation window.
2. **Straight-line extrapolation overshoots corners.** Fixes arrive ~80 s
   apart per bus and 10–30 s stale; between them the bus flew off-street at
   every bend (user report from a signal-processing researcher, 2026-07-30 —
   "buses moving orthogonal to the streets").

Both are addressed by filtering **along the learned route polyline**:

- Projecting each fix onto the polyline **discards the lateral drift
  component entirely** — the filter only has to manage along-route noise.
  (This matters because the observed drift is *biased*, not zero-mean; no
  filter can remove bias, but projection can throw its lateral part away.)
- Between fixes the bus advances **along the polyline arc**, so it follows
  corners by construction.
- Each fix is folded in weighted by uncertainty (the Kalman gain), so a
  suspect fix **nudges** the estimate instead of owning it, and the speed
  estimate becomes a filtered state rather than a fragile two-fix difference.

## What deliberately did NOT change

- **The raw motion model is untouched and keeps running for every bus.** It
  still decides snap engagement/release (hysteresis on the raw eased position,
  SNAP_ON_M 50 / SNAP_OFF_M 80), seeds the filter, and renders the ~0.2% of
  buses without a learned route exactly as before. The filter never votes on
  its own engagement — that would let a confidently-wrong filter keep itself
  alive.
- **No uncertainty visualisation.** The filter's position variance could
  drive icon opacity ("less sure = more transparent"); this was explicitly
  deferred — a different presentation is planned for a future version.
- **The learning pipeline is untouched.** It already stored
  `quality.meanResidualM` in every learned-route JSON; the filter merely
  starts reading it. Traces fed to the learner remain raw BODS fixes — the
  filter is display-only and can never contaminate training data.
- **Backend: zero changes.**

## How it works

State per snapped bus — 5 floats: arc length `s` (m), signed line speed `v`
(m/s), covariance `pS, pV, pSV`. State time is the **fix timestamp** (BODS
RecordedAtTime), never wall clock, mirroring how the raw model extrapolates
from RecordedAtTime.

```
poll ingest (new fix)                      render tick (≤15 Hz)
────────────────────                       ────────────────────
project fix → arc length z                 target = s + v·(now − t)   [cap 45 s]
PREDICT state to fix time:                 ease kfDispS toward target (τ 2.5 s)
  s += v·dt;  P grows by Q(dt)             pointAtArclen(kfDispS) → x, y, tangent
GATE:  |z − s| > 3σ → reject               → snapX / snapY / snapBearing
UPDATE: K = pS/(pS+R)
  s += K·(z−s);  v += Kv·(z−s);  P shrinks
```

Design choices worth knowing when debugging:

- **Covariance math runs only per fix** (~110 updates/s fleet-wide), not per
  tick. The per-tick path is one extrapolation + one eased scalar + an O(1)
  amortised segment walk — cheaper than the trig the raw model already does.
- **Prediction disambiguates projection.** The measurement projection
  searches a local window around the filter's current segment first, so
  self-overlapping routes (terminal loops) resolve to the branch the filter
  expects instead of whichever is nearest.
- **`v` is signed** and clamped to ±20 m/s. Learned polylines are usually
  oriented along travel, but a reversed one must track as negative `v` —
  clamping at zero would freeze those buses. Icon heading reuses the existing
  half-plane correction against the motion-derived bearing.
- **Gating vs reset.** A fix beyond 3σ is rejected (state advances by
  prediction only). Three *consecutive* rejections mean the disagreement is
  real (vehicle reassigned, GPS recovered from a cold start) — the filter
  re-seeds at the fix, with speed from the raw two-fix model (whose fix pair
  is post-relocation by then; the filter's own speed is exactly the estimate
  that got rejected). One glitch can't reset it; a real relocation converges
  in ≤3 fixes.
- **Graceful degradation.** If the filter can't seed (the fix projects
  off-route while the eased position is on it — rare and transient), the
  snapped pose falls back to the pre-filter behaviour: projection of the
  eased position. Failed seeds are memoized on the fix timestamp — the
  full-polyline seed scan reruns only when a new fix arrives, keeping the
  per-tick path O(1). Unsnap always nulls the filter; re-snap re-seeds it.

## Parameters

All in `bus-kalman.ts`, each with the derivation in a comment:

| Parameter | Value | Why this value |
|---|---|---|
| `KF_PROCESS_NOISE_M2_S3` (q) | 2 m²/s³ | Continuous white-noise-acceleration model. London buses are stop-and-go (a stop every 300–400 m): speed swings the full 0↔8–13 m/s within one 20–30 s fix gap, so σ_v(25 s) = √(q·25) ≈ 7 m/s ⇒ q ≈ 2. **Field-revised 2026-07-31** from 0.2 (a smooth-cruising derivation over the average 80 s cadence): the tight model made the 3σ gate reject 20–36% of honest braking/departure fixes in stop-and-go simulation, which in production showed as fleet-wide surge-and-stall — buses sailing past stops on stale speed, snapping back on reset, then sprinting to catch up. |
| `KF_GATE_SIGMA` | 3 | Standard 3σ innovation gate (~99.7% of honest fixes pass). The gate widens with elapsed time automatically; at q = 2 a settled filter's half-width is roughly 250 m after a 20 s gap and grows steeply with longer gaps, so only genuine teleports get gated. Note the gate also widens after each *rejected* fix (gated predicts inflate the covariance) — moderate persistent offsets get wide-gated back in within a fix or two, which is reset-in-all-but-name; the explicit reset path is the backstop for cross-town relocations. |
| `KF_MAX_REJECTS` | 3 | Consecutive gated fixes before re-seeding. 1 would let a single glitch reset the filter; 3 costs ≤ ~4 min of frozen progress in the worst case while being robust to glitch pairs. |
| `KF_INIT_SIGMA_S_M` | 30 m | Initial position σ — matches the learner's corridor start: a fresh snap knows the bus about this well. |
| `KF_INIT_SIGMA_V_MS` | 3 m/s | Initial speed σ — the seed comes from the raw two-fix model, so keep healthy doubt. |
| `KF_MEAS_SIGMA_FLOOR_M` | 8 m | Per-route σ floor: consumer GPS under open sky rarely beats this, however clean the learned residuals. |
| `KF_DEFAULT_MEAS_SIGMA_M` | 44 m | Used when a route JSON has no usable `quality` field (older bakes may predate it). Equals the worst quality the learner's gate can ship: 35 m mean residual × 1.25 (MAD→σ) ≈ 44 — an unknown-quality route gets no more trust than the worst known one. |
| `MAD_TO_SIGMA` | 1.25 | `meanResidualM` is a mean *absolute* deviation; for a zero-mean Gaussian σ = E\|x\|·√(π/2) ≈ 1.25·E\|x\|. |
| `KF_MAX_SPEED_MS` | 20 m/s | Same ceiling the raw model uses (`MAX_IMPLIED_SPEED_MS`) — 72 km/h, generous for London buses. |

**Measurement noise R is per-route, not global**: R = (max(8, 1.25 ×
`quality.meanResidualM`))², read from the learned-route JSON the frontend
already downloads. Central-London canyon routes get a large R (their fixes are
trusted less); open suburban routes get a small one. This is the main reason
the filter needed no new data: the learner had been measuring R all along.

Reused display constants (unchanged values, same meaning in 1-D):
`MAX_EXTRAPOLATION_S` 45 s (freeze-don't-run-away horizon), `EASE_TAU_S` 2.5 s
(display easing), `SNAP_DISTANCE_M` 400 m (jump instead of glide),
`MAX_CATCHUP_SPEED_MS` 120 m/s (glide cap).

## Behaviour you should expect on the map

- Buses on learned routes follow corners between fixes instead of cutting
  them; heading comes from the polyline tangent.
- A single teleporting fix visibly does ~nothing (gated); the bus keeps
  rolling at its filtered speed.
- After long gaps (>45 s) buses freeze rather than run away — same as before.
- Buses without learned routes, and buses outside the snap corridor, behave
  **exactly** as before this change.

## Tuning guide (if the map looks wrong)

| Symptom | Knob |
|---|---|
| Fleet-wide surge-and-stall rhythm (buses sprint, then crawl, in sync) | q too LOW for the stop-and-go dynamics — honest braking/departure fixes are being gated. This exact symptom occurred in production on 2026-07-31 with q = 0.2; verify with the stop-and-go simulation before touching anything else. |
| Snapped buses lag behind reality | raise q (trust fixes more) |
| Snapped buses jitter along the route | lower q, or check the route's `meanResidualM` is honest |
| Buses stick when drivers genuinely divert | lower `KF_MAX_REJECTS` to 2 |
| Occasional backwards jumps at terminal loops | widen the ingest projection window (`SNAP_LOCAL_WINDOW`) |

## Testing

`frontend/src/realtime/bus-kalman.test.ts` — 21 deterministic behavioural
tests (no RNG): convergence on constant speed, stability under crafted noise,
reversed-polyline (negative v) tracking, speed clamping, outlier gating,
reject-counter reset, reset-after-persistent-disagreement, gate widening with
fix gaps, out-of-order timestamps, covariance health (positive, Cauchy–Schwarz
consistent) over a 200-step mixed run, extrapolation capping, signed
tangent-speed seeding, and the arc-length geometry (cumulative lengths,
interpolation, end clamping, hint walks).
Run: `cd frontend && npx vitest run src/realtime/bus-kalman.test.ts`.

Known coverage gap, accepted deliberately: the buses.ts integration glue
(snap-state transitions, seed memoization, the reset re-seed call site) lives
in closures inside `startBuses(map)` and has no test seam — extracting it
would mean refactoring the layer's structure for testability alone. The glue
is thin (every branch delegates to a tested pure function) and is exercised
visually on the live map; revisit if it grows real branching.

## Future work (explicitly out of scope here)

- Uncertainty-driven presentation (deferred by design — see above).
- MLAT aircraft (the only other layer where a filter would pay: multilaterated
  positions jitter by hundreds of meters). Ships/ADS-B aircraft carry accurate
  positions + velocities, so a filter's gain would sit at ≈1 — pointless; the
  tube has no position measurements at all and its heuristic pipeline encodes
  feed-specific pathologies a generic filter would smear over.
