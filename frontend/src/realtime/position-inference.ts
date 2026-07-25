// Pure inference: TfL Arrivals predictions → concrete train positions.
//
// TfL gives no coordinates — only "train X is N seconds from station Y" — and the
// feed is dirty in mode-specific ways. The heuristics here follow the approach
// proven by Zone One (london.jamespotter.dev):
//   • some trains carry no vehicleId → currentLocation is the stable identity
//   • one physical sub-surface train is listed on several lines that share
//     S-stock (District/Circle/H&C/Met) → keep only the most-live listing
//   • DLR predictions carry NO vehicleId and NO currentLocation, and each train
//     is listed against every stop ahead → keep only the leading edge
//   • Overground/Elizabeth predictions are timetable-reaching (~2h ahead) →
//     a position-less prediction due beyond the horizon hasn't departed yet

import type { Branch, LineBranches, Prediction, Train } from './types';
import { pointAtFraction, polylineLength } from './geometry';

/** Position-less predictions further out than this are timetable, not live. */
export const RUN_HORIZON_S = 480;
/** Average in-service speed (m/s) used to size per-segment run times. */
const AVG_SPEED_MS = 12;
const MIN_SEGMENT_RUN_S = 45;
const MAX_SEGMENT_RUN_S = 300;
/** Below this countdown the train is effectively at the platform. */
const AT_PLATFORM_S = 15;

const NO_VEHICLE_ID = '000';
const SIDINGS = /sidings?\b/i;
/** currentLocation prefixes proving the train has left its previous stop. */
const DEPARTED = /^(between|left) /i;
const DEPARTED_MARGIN_S = 20;
/**
 * Near-platform clamp for the ARRIVING arm. When currentLocation says the train
 * is "Approaching <its own next stop>", TfL's timeToStation is often laggy-high
 * (the Metropolitan-line failure: tts freezes ~45-60s stale while the train is
 * already at/near the platform). Place the dot at least this far along the
 * approach so it tracks reality; never move it BACKWARD (max, not set).
 */
const APPROACHING_FRAC = 0.85;

/**
 * Tolerant station-name equality for matching TfL's currentLocation string
 * against a branch stop name. Normalizes real-world spelling variants so that
 * "At King's Cross St. Pancras Platform 3" matches the baked "King's Cross
 * St. Pancras", and "Approaching Harrow-on-the-Hill" matches "Harrow-on-the-Hill":
 *   • lowercase; apostrophes dropped (King's → kings)
 *   • "St." / "St", hyphens, underscores flattened to spaces (so St. == St)
 *   • trailing "Underground/DLR/Rail Station" and "Platform N" adornments removed
 *   • any remaining punctuation → space; whitespace collapsed
 */
function normStation(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+(underground|dlr|rail)?\s*station\b.*$/g, ' ')
    .replace(/\s+platform\b.*$/g, ' ')
    .replace(/['`‘’]/g, '')
    .replace(/[.\-_/]/g, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const APPROACHING_RE = /^\s*approaching\s+(.+)$/i;
const AT_RE = /^\s*at\s+(.+)$/i;

/** currentLocation → the station it names, and whether the train is AT vs APPROACHING it. */
function locationTarget(
  currentLocation: string | undefined,
): { kind: 'at' | 'approaching'; name: string } | null {
  if (!currentLocation) return null;
  const app = APPROACHING_RE.exec(currentLocation);
  if (app) return { kind: 'approaching', name: normStation(app[1]) };
  const at = AT_RE.exec(currentLocation);
  if (at) return { kind: 'at', name: normStation(at[1]) };
  return null;
}

/**
 * Which currentLocation arm (if any) applies to a train's OWN next stop.
 *
 * CRITICAL guard: the arms may act ONLY when the named station equals the
 * train's next stop (the naptan/stationName the prediction is for). "At Aldgate
 * Platform" while the next stop is Liverpool Street — or "At Fulham Broadway"
 * while next is Parsons Green — is a terminus/interchange dwell of a different
 * listing; snapping on it caused the false jumps seen in diagnosis. A bare
 * "At Platform" (no station named) normalizes to "platform" and matches nothing.
 */
function currentLocationArm(
  currentLocation: string | undefined,
  nextStopName: string,
): 'at' | 'approaching' | null {
  const target = locationTarget(currentLocation);
  if (!target || !target.name) return null;
  return target.name === normStation(nextStopName) ? target.kind : null;
}

/** Lines sharing physical rolling stock: a vehicleId is one train group-wide. */
const STOCK_GROUP = new Map<string, string>([
  ['district', 'sub'],
  ['circle', 'sub'],
  ['hammersmith-city', 'sub'],
  ['metropolitan', 'sub'],
  ['mildmay', 'og'],
  ['windrush', 'og'],
  ['weaver', 'og'],
  ['lioness', 'og'],
  ['suffragette', 'og'],
  ['liberty', 'og'],
]);

const hasVehicleId = (p: Prediction): boolean =>
  Boolean(p.vehicleId) && p.vehicleId !== NO_VEHICLE_ID;

const hasLocation = (p: Prediction): boolean =>
  Boolean(p.currentLocation?.trim()) && !SIDINGS.test(p.currentLocation ?? '');

const blockKey = (p: Prediction): string => `${p.lineId}|${p.currentLocation}`;

/** dir|stopId → ids of stops immediately before it, per line. */
function buildPrevStops(line: LineBranches): Map<string, string[]> {
  const prev = new Map<string, string[]>();
  for (const br of line.branches) {
    for (let i = 1; i < br.stops.length; i++) {
      const k = `${br.direction}|${br.stops[i].id}`;
      const list = prev.get(k) ?? [];
      list.push(br.stops[i - 1].id);
      prev.set(k, list);
    }
  }
  return prev;
}

/** DLR-style leading-edge dedup: keys of predictions that are a train's front. */
function dlrLeadingEdges(preds: Prediction[], line: LineBranches | undefined): Set<string> {
  const leads = new Set<string>();
  if (!line) return leads;
  const prevStops = buildPrevStops(line);
  const idKey = (p: Prediction): string =>
    `${p.direction ?? ''}|${p.destinationName ?? ''}|${p.naptanId}`;
  const minT = new Map<string, number>();
  for (const p of preds) {
    if (p.timeToStation > RUN_HORIZON_S) continue;
    const k = idKey(p);
    const cur = minT.get(k);
    if (cur === undefined || p.timeToStation < cur) minT.set(k, p.timeToStation);
  }
  for (const [k, t] of minT) {
    const [dir, dest, napt] = k.split('|');
    const echoed = (prevStops.get(`${dir}|${napt}`) ?? []).some((prevId) => {
      const pt = minT.get(`${dir}|${dest}|${prevId}`);
      return pt !== undefined && pt < t;
    });
    if (!echoed) leads.add(k);
  }
  return leads;
}

interface Candidate {
  branch: Branch;
  stopIndex: number; // index of the NEXT stop (naptanId) in branch.stops
}

function findCandidates(line: LineBranches, p: Prediction): Candidate[] {
  const out: Candidate[] = [];
  for (const branch of line.branches) {
    if (p.direction && branch.direction !== p.direction) continue;
    const idx = branch.stops.findIndex((s) => s.id === p.naptanId);
    if (idx >= 0) out.push({ branch, stopIndex: idx });
  }
  return out;
}

/**
 * Prefer, in order: the branch the train was already assigned to (hysteresis —
 * prediction jitter must not teleport it between branches), then a branch whose
 * terminus matches the stated destination.
 */
function pickCandidate(
  cands: Candidate[],
  p: Prediction,
  prevSegmentKey: string | undefined,
): Candidate | undefined {
  if (cands.length === 0) return undefined;
  if (prevSegmentKey) {
    const [, prevBranchId, prevDirection] = prevSegmentKey.split(':');
    const sticky = cands.find(
      (c) =>
        String(c.branch.branchId) === prevBranchId && c.branch.direction === prevDirection,
    );
    if (sticky) return sticky;
  }
  const dest = (p.destinationName ?? p.towards ?? '').toLowerCase();
  if (dest) {
    const match = cands.find((c) => {
      const last = c.branch.stops[c.branch.stops.length - 1].name.toLowerCase();
      return dest.includes(last) || last.includes(dest.replace(/ (underground|rail|dlr) station$/, ''));
    });
    if (match) return match;
  }
  // Otherwise prefer a mid-branch match (a train "approaching" a terminus start
  // is usually better explained by the branch where that stop is en route).
  return cands.find((c) => c.stopIndex > 0) ?? cands[0];
}

function segmentKeyFor(lineId: string, branch: Branch, stopIndex: number): string {
  return `${lineId}:${branch.branchId}:${branch.direction}:${stopIndex}`;
}

/**
 * Scheduled run time for the approach segment when the timetable bake provides
 * one; otherwise estimated from track length at average in-service speed.
 * frac = elapsed/scheduled is the statistical-ratio positioning.
 */
/**
 * TfL timetables carry whole-minute granularity and exclude terminal dwell, so
 * the raw scheduled figure systematically undershoots the observed countdown
 * (probe: 60s scheduled vs 74–89s live). A dwell buffer keeps the ratio from
 * clamping trains onto the previous platform for half their journey.
 */
const DWELL_BUFFER_S = 30;

function segmentRunTime(branch: Branch, stopIndex: number): number {
  const scheduled = branch.runTimes?.[stopIndex - 1];
  if (typeof scheduled === 'number' && scheduled >= 20) {
    return Math.min(MAX_SEGMENT_RUN_S, scheduled + DWELL_BUFFER_S);
  }
  const segment = branch.segments[stopIndex - 1];
  return Math.max(
    MIN_SEGMENT_RUN_S,
    Math.min(MAX_SEGMENT_RUN_S, polylineLength(segment) / AVG_SPEED_MS),
  );
}

function positionOnBranch(cand: Candidate, p: Prediction): Train | undefined {
  const { branch, stopIndex } = cand;
  const nextStop = branch.stops[stopIndex];
  const base = {
    key: '',
    lineId: p.lineId,
    lineName: p.lineName ?? p.lineId,
    vehicleId: hasVehicleId(p) ? p.vehicleId : undefined,
    nextStopId: nextStop.id,
    nextStopName: nextStop.name,
    timeToStation: p.timeToStation,
    currentLocation: p.currentLocation ?? '',
    platformName: p.platformName ?? '',
    direction: p.direction ?? branch.direction,
    destination: p.destinationName ?? p.towards ?? '',
    destinationId: p.destinationNaptanId,
    synthetic: false,
  };
  // currentLocation is measured ~25-30s more truthful than tts exactly when tts
  // is worst. "At <this next stop> Platform" ⇒ treat as arrived even if the
  // countdown is still laggy-high (Option 2's 'At X' arm).
  const arm = currentLocationArm(p.currentLocation, nextStop.name);
  if (stopIndex === 0 || p.timeToStation <= AT_PLATFORM_S || arm === 'at') {
    // Dwelling trains still face along the track: use the bearing at the end of
    // the approach segment (or the start of the departure segment at a terminus).
    const hasApproach = stopIndex > 0;
    const segment = hasApproach
      ? branch.segments[stopIndex - 1]
      : branch.segments.length > 0
        ? branch.segments[0]
        : null;
    const bearing = segment ? pointAtFraction(segment, hasApproach ? 1 : 0).bearing : 0;
    return {
      ...base,
      lngLat: [nextStop.lon, nextStop.lat],
      bearing,
      segment: hasApproach ? segment : null,
      segmentFrac: 1,
      segmentKey: hasApproach ? segmentKeyFor(p.lineId, branch, stopIndex) : '',
    };
  }
  const segment = branch.segments[stopIndex - 1];
  let runTime = segmentRunTime(branch, stopIndex);
  // TfL says the train has physically departed ("Between X and Y" / "Left X").
  // If the countdown still exceeds our scheduled run time, the schedule is the
  // wrong bound — stretch it so the ratio stays past the platform and keeps
  // advancing instead of pinning a moving train at the stop it already left.
  if (DEPARTED.test(p.currentLocation ?? '') && p.timeToStation + DEPARTED_MARGIN_S > runTime) {
    runTime = p.timeToStation + DEPARTED_MARGIN_S;
  }
  let frac = 1 - Math.min(1, p.timeToStation / runTime);
  // "Approaching <this next stop>": place near the platform despite a laggy-high
  // countdown. Forward-only (max) keeps it monotonic so it composes with the
  // interpolator and never drags a well-positioned dot backward.
  if (arm === 'approaching') frac = Math.max(frac, APPROACHING_FRAC);
  const pt = pointAtFraction(segment, frac);
  return {
    ...base,
    lngLat: pt.lngLat,
    bearing: pt.bearing,
    segment,
    segmentFrac: frac,
    segmentKey: segmentKeyFor(p.lineId, branch, stopIndex),
    runTimeS: runTime,
  };
}

/**
 * Resolve raw batched Arrivals predictions into positioned trains.
 * Pure: (predictions, baked branches) in → trains out.
 */
export function inferTrains(
  preds: Prediction[],
  branchesByLine: Map<string, LineBranches>,
  prevSegments?: ReadonlyMap<string, string>,
): Train[] {
  // ── cross-line ghost dedup for shared rolling stock ──
  const grpOwner = new Map<string, { line: string; tts: number }>();
  for (const p of preds) {
    const g = STOCK_GROUP.get(p.lineId);
    if (!g || !hasVehicleId(p)) continue;
    const k = `${g}|${p.vehicleId}`;
    const cur = grpOwner.get(k);
    if (!cur || p.timeToStation < cur.tts) {
      grpOwner.set(k, { line: p.lineId, tts: p.timeToStation });
    }
  }

  // ── blocks already owned by a vehicleId train, and id-less direction splits ──
  const vidLocs = new Set<string>();
  const idlessDirs = new Map<string, Set<string>>();
  for (const p of preds) {
    if (!hasLocation(p)) continue;
    if (hasVehicleId(p)) {
      vidLocs.add(blockKey(p));
    } else if (p.direction) {
      const k = blockKey(p);
      const set = idlessDirs.get(k) ?? new Set<string>();
      set.add(p.direction);
      idlessDirs.set(k, set);
    }
  }

  // ── DLR leading edges (per line without ids or locations) ──
  const dlrPreds = preds.filter((p) => p.lineId === 'dlr' && !hasVehicleId(p) && !hasLocation(p));
  const dlrLeads = dlrLeadingEdges(dlrPreds, branchesByLine.get('dlr'));
  const dlrKey = (p: Prediction): string =>
    `${p.direction ?? ''}|${p.destinationName ?? ''}|${p.naptanId}`;

  // ── collapse predictions onto one per physical train ──
  const best = new Map<string, Prediction>();
  // every stop's freshest prediction per train — the at-platform handoff below
  // needs the successor stop's countdown, not just the nearest one
  const byKeyStop = new Map<string, Map<string, Prediction>>();
  const syntheticKeys = new Set<string>();
  for (const p of preds) {
    let key: string;
    if (hasVehicleId(p)) {
      const g = STOCK_GROUP.get(p.lineId);
      if (g) {
        const owner = grpOwner.get(`${g}|${p.vehicleId}`);
        if (owner && owner.line !== p.lineId) continue; // ghost on a sibling line
      }
      key = `${p.lineId}:${p.vehicleId}`;
    } else if (hasLocation(p)) {
      if (vidLocs.has(blockKey(p))) continue; // same train as a vehicleId listing
      const dirs = idlessDirs.get(blockKey(p));
      if (dirs && dirs.size >= 2) {
        if (!p.direction) continue; // ambiguous echo between two real trains
        key = `${blockKey(p)}|${p.direction}`;
      } else {
        key = blockKey(p);
      }
      syntheticKeys.add(key);
    } else if (p.lineId === 'dlr') {
      const k = dlrKey(p);
      if (!dlrLeads.has(k)) continue;
      key = `dlr:${k}`;
      syntheticKeys.add(key);
    } else {
      // No id, no location, not DLR: timetable-only listing (Overground/Elizabeth).
      if (p.timeToStation > RUN_HORIZON_S) continue; // hasn't departed yet
      key = `${p.lineId}:tt:${p.destinationName ?? ''}:${p.naptanId}`;
      syntheticKeys.add(key);
    }
    const cur = best.get(key);
    if (!cur || p.timeToStation < cur.timeToStation) best.set(key, p);
    const stopMap = byKeyStop.get(key) ?? new Map<string, Prediction>();
    const curAtStop = stopMap.get(p.naptanId);
    if (!curAtStop || p.timeToStation < curAtStop.timeToStation) stopMap.set(p.naptanId, p);
    byKeyStop.set(key, stopMap);
  }

  // ── place each train on its branch geometry ──
  const trains: Train[] = [];
  for (const [key, p] of best) {
    // Overground/Elizabeth predictions reach ~2h ahead with a vehicleId but no
    // live position: a position-less train due beyond the horizon hasn't
    // departed yet, whatever id it carries. Live-positioned trains are exempt.
    if (!hasLocation(p) && p.timeToStation > RUN_HORIZON_S) continue;
    const line = branchesByLine.get(p.lineId);
    if (!line) continue;
    const cand = pickCandidate(findCandidates(line, p), p, prevSegments?.get(key));
    if (!cand) continue;
    // ── at-platform handoff ──
    // TfL leaves a stale "due" at the stop a train just left, which would pin
    // the dot there. Once the nearest countdown says "at platform", position by
    // the SUCCESSOR stop's countdown instead: while genuinely dwelling that
    // countdown exceeds the scheduled run time (ratio clamps to the stop), and
    // the moment it drops below, the train pulls away — stale dues can't hold it.
    // "At <next stop> Platform" fires the handoff even when tts is laggy-high
    // (Option 2's 'At X' arm): currentLocation is the more truthful signal here.
    const atNextStop =
      p.timeToStation <= AT_PLATFORM_S ||
      currentLocationArm(p.currentLocation, cand.branch.stops[cand.stopIndex].name) === 'at';
    let placePred = p;
    let placeCand = cand;
    if (atNextStop && cand.stopIndex < cand.branch.stops.length - 1) {
      const successorId = cand.branch.stops[cand.stopIndex + 1].id;
      const successor = byKeyStop.get(key)?.get(successorId);
      if (successor) {
        placePred = { ...successor, direction: p.direction || successor.direction };
        placeCand = { branch: cand.branch, stopIndex: cand.stopIndex + 1 };
      }
    }
    const train = positionOnBranch(placeCand, placePred);
    if (!train) continue;
    train.key = key;
    train.synthetic = syntheticKeys.has(key);
    trains.push(train);
  }
  return trains;
}
