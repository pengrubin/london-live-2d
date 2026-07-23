// Pure display smoothing in TRACK space: each train's rendered position is an
// arc-length fraction along its current segment polyline, eased toward the
// inferred target. The dot therefore never leaves the rails (snapping), and a
// monotonicity rule stops prediction jitter from dragging it backwards.

import type { Train } from './types';
import {
  metersBetween,
  pointAtFraction,
  polylineLength,
  projectFraction,
  type LngLat,
} from './geometry';

/** Exponential-approach time constant: ~63% of the arc gap closed per TAU. */
const TAU_MS = 4000;
/** A retarget further than this is a re-identification — snap, don't glide. */
const SNAP_M = 1500;
/**
 * Coasting retention. The feed drops vehicles for 1–3 polls routinely (probe:
 * 44 flickers / 281 vehicles in 2 min, gaps up to 30s) — keep them running on
 * dead reckoning meanwhile. Coasting is capped at the current segment's end,
 * so an absent train can never overshoot its route.
 */
const RETAIN_MS = 60000;
/**
 * A train whose next stop IS its own destination and whose countdown has run
 * out has terminated (short workings end mid-line) — release it quickly.
 */
const ARRIVED_RETAIN_MS = 12000;
/** Fade to transparent over the last stretch of retention. */
const FADE_MS = 10000;
/** Blend factor for countdown smoothing across polls (0 = trust old, 1 = new). */
const TTS_BLEND = 0.5;
/** A reborn synthetic identity within this range is the same physical train. */
const SUCCESSION_M = 300;

export interface DisplayedTrain {
  train: Train;
  lngLat: LngLat;
  bearing: number;
  /** 1 while live; eases to 0 while a coasting train fades out */
  opacity: number;
}

interface DisplayState {
  train: Train;
  segment: LngLat[] | null;
  segmentKey: string;
  segmentLenM: number;
  /** displayed position, fraction of segment arc */
  frac: number;
  targetFrac: number;
  lngLat: LngLat;
  bearing: number;
  lastSeen: number;
}

function freshState(t: Train, now: number): DisplayState {
  const segmentLenM = t.segment ? polylineLength(t.segment) : 0;
  return {
    train: t,
    segment: t.segment,
    segmentKey: t.segmentKey,
    segmentLenM,
    frac: t.segmentFrac,
    targetFrac: t.segmentFrac,
    lngLat: t.lngLat,
    bearing: t.bearing,
    lastSeen: now,
  };
}

export class TrainInterpolator {
  private states = new Map<string, DisplayState>();

  /** segmentKey per train key — feed back into inferTrains for branch hysteresis. */
  segmentAssignments(): Map<string, string> {
    const out = new Map<string, string>();
    for (const [key, s] of this.states) {
      if (s.segmentKey) out.set(key, s.segmentKey);
    }
    return out;
  }

  /** Feed a fresh inference result (call once per poll). */
  update(trains: Train[], now: number): void {
    const bornKeys: string[] = [];
    for (const t of trains) {
      const prev = this.states.get(t.key);
      if (!prev || !t.segment || metersBetween(prev.lngLat, t.lngLat) > SNAP_M) {
        this.states.set(t.key, freshState(t, now));
        if (!prev) bornKeys.push(t.key);
        continue;
      }
      // Countdown EMA: blend the new figure with the old one advanced by the
      // elapsed time — absorbs the feed's ±10s oscillation before positioning.
      if (
        prev.segmentKey === t.segmentKey &&
        prev.train.receivedAt !== undefined &&
        t.receivedAt !== undefined
      ) {
        const elapsedS = Math.max(0, (t.receivedAt - prev.train.receivedAt) / 1000);
        const carried = Math.max(0, prev.train.timeToStation - elapsedS);
        t.timeToStation = Math.round(TTS_BLEND * t.timeToStation + (1 - TTS_BLEND) * carried);
      }
      prev.train = t;
      prev.lastSeen = now;
      if (prev.segmentKey === t.segmentKey && prev.segment) {
        // Same segment: adopt the new target, but frame() only ever moves the
        // dot FORWARD — TfL countdown regressions (probe: 94 in 2 min) can
        // therefore never drag a train backwards. Genuine re-identifications
        // are caught by the segment-change path or the SNAP_M guard above.
        prev.targetFrac = t.segmentFrac;
      } else {
        // advanced to a new segment: carry the displayed point onto it by
        // projection (old segment's end is the new one's start, so this is
        // continuous), then keep easing forward toward the new target
        const carried = projectFraction(t.segment, prev.lngLat);
        prev.segment = t.segment;
        prev.segmentKey = t.segmentKey;
        prev.segmentLenM = polylineLength(t.segment);
        prev.frac = Math.min(carried, t.segmentFrac);
        prev.targetFrac = t.segmentFrac;
      }
    }
    // ── absence handling ──
    const freshKeys = new Set(trains.map((t) => t.key));
    for (const [key, s] of this.states) {
      if (freshKeys.has(key)) continue;
      if (s.train.synthetic) {
        // Synthetic identities drift as the train moves ("Between A and B" →
        // "Between B and C"). Before deleting, look for a just-born key on the
        // same line/direction nearby: same physical train — hand the display
        // state over so the dot glides instead of blinking.
        const heir = bornKeys
          .map((k) => this.states.get(k))
          .find(
            (h) =>
              h &&
              h.train.synthetic &&
              h.train.lineId === s.train.lineId &&
              h.train.direction === s.train.direction &&
              metersBetween(h.train.lngLat, s.lngLat) < SUCCESSION_M,
          );
        if (heir?.segment) {
          heir.lngLat = s.lngLat;
          heir.bearing = s.bearing;
          heir.frac = Math.min(heir.targetFrac, projectFraction(heir.segment, s.lngLat));
        }
        this.states.delete(key);
        continue;
      }
      if (now - s.lastSeen > this.retentionFor(s)) this.states.delete(key);
    }
  }

  /** Terminated trains (next stop = own destination, countdown spent) go fast. */
  private retentionFor(s: DisplayState): number {
    const t = s.train;
    const arrived =
      t.destinationId !== undefined && t.destinationId === t.nextStopId && s.frac >= 0.97;
    return arrived ? ARRIVED_RETAIN_MS : RETAIN_MS;
  }

  /**
   * Advance displayed positions by dtMs and return them (call per frame).
   * When a train carries runTimeS + receivedAt, its target is dead-reckoned
   * every frame from the extrapolated countdown — continuous motion between
   * polls, and backward data (countdown regressions) simply never pulls the
   * dot back because frac only advances.
   */
  frame(dtMs: number, nowEpochMs: number = Date.now()): DisplayedTrain[] {
    const ease = 1 - Math.exp(-dtMs / TAU_MS);
    const out: DisplayedTrain[] = [];
    for (const s of this.states.values()) {
      if (s.segment && s.segmentLenM > 0) {
        const t = s.train;
        let target = s.targetFrac;
        if (t.runTimeS && t.receivedAt !== undefined) {
          const elapsedS = Math.max(0, (nowEpochMs - t.receivedAt) / 1000);
          const effTts = Math.max(0, t.timeToStation - elapsedS);
          target = Math.max(target, 1 - Math.min(1, effTts / t.runTimeS));
        }
        const gap = target - s.frac;
        if (gap > 0) {
          s.frac = Math.min(target, s.frac + gap * ease);
        }
        const pt = pointAtFraction(s.segment, s.frac);
        s.lngLat = pt.lngLat;
        // keep the last travel bearing while dwelling so the nose stays aligned
        if (gap * s.segmentLenM > 2) s.bearing = pt.bearing;
      } else {
        s.lngLat = s.train.lngLat;
        s.bearing = s.train.bearing;
      }
      // fade out over the tail of the retention window
      const absentMs = Math.max(0, nowEpochMs - s.lastSeen);
      const remaining = this.retentionFor(s) - absentMs;
      const opacity = Math.max(0, Math.min(1, remaining / FADE_MS));
      out.push({ train: s.train, lngLat: s.lngLat, bearing: s.bearing, opacity });
    }
    return out;
  }

  get size(): number {
    return this.states.size;
  }
}
