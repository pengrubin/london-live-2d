// The undirected hop index over the baked branches: which pairs of NaPTAN ids
// are one track segment apart on a given line, and which ids the line calls at
// at all. It is the single geometry gate of the whole disruption feature —
// route-patterns.ts validates TfL's service patterns with it and resolver.ts
// validates TfL's structured `affectedRoutes` slices with it, so both refuse
// exactly the same thing (docs/DISRUPTION_GEOLOCATION_SPEC.md §5.1-a, §5.5).
//
// `Branch.segments[i]` is the polyline between `stops[i]` and `stops[i+1]`
// (backend/src/shared/types.ts), which is why consecutive stop pairs — and
// nothing else — are drawable: a pair that is not a hop has no baked geometry,
// and the alternative (joining the two ends with a straight line, or searching
// the graph for a path) is what §2.2 forbids.
//
// frontend/src/layers/disruptions.ts rebuilds the same hop index in the browser
// to re-check a section before drawing it; divergence fails closed (the client
// drops the section) rather than drawing a phantom path.
import type { LineBranches } from '../shared/types';

const HOP_KEY_SEPARATOR = '>';
/** A drawable section needs at least one hop. */
const MIN_HOP_IDS = 2;

/** Per-line hop and stop sets. Plain sets, built once at boot, read-only after. */
export interface HopIndex {
  /** lineId → undirected hop keys of every consecutive branch stop pair. */
  readonly hopsByLine: ReadonlyMap<string, ReadonlySet<string>>;
  /** lineId → every id the line's branches call at. */
  readonly stopsByLine: ReadonlyMap<string, ReadonlySet<string>>;
}

/** Undirected edge key — the same for a→b and b→a. */
export function hopKey(a: string, b: string): string {
  return a < b ? `${a}${HOP_KEY_SEPARATOR}${b}` : `${b}${HOP_KEY_SEPARATOR}${a}`;
}

/** Consecutive `(ids[i], ids[i+1])` pairs; the `?? b` only satisfies noUncheckedIndexedAccess. */
function consecutivePairs(ids: readonly string[]): [string, string][] {
  return ids.slice(1).map((b, i) => [ids[i] ?? b, b]);
}

/** Every consecutive stop pair across all branches of one line, undirected. */
function lineHops(line: LineBranches): Set<string> {
  return new Set(
    line.branches.flatMap((branch) =>
      consecutivePairs(branch.stops.map((s) => s.id)).map(([a, b]) => hopKey(a, b)),
    ),
  );
}

/** Every id any branch of one line calls at. */
function lineStops(line: LineBranches): Set<string> {
  return new Set(line.branches.flatMap((branch) => branch.stops.map((s) => s.id)));
}

/**
 * Builds the hop and stop sets for every baked line. Lines are kept apart on
 * purpose: an id or a hop that is real on the Circle line is not evidence for
 * a District closure, and the whole point of the structured tier is that TfL's
 * ids are checked against the line they were published for.
 */
export function buildHopIndex(branchesByLine: ReadonlyMap<string, LineBranches>): HopIndex {
  const hopsByLine = new Map<string, ReadonlySet<string>>();
  const stopsByLine = new Map<string, ReadonlySet<string>>();
  for (const [lineId, line] of branchesByLine) {
    hopsByLine.set(lineId, lineHops(line));
    stopsByLine.set(lineId, lineStops(line));
  }
  return { hopsByLine, stopsByLine };
}

/** Whether `a` and `b` are one baked segment apart on `lineId`. Unknown line → false. */
export function isHop(index: HopIndex, lineId: string, a: string, b: string): boolean {
  return index.hopsByLine.get(lineId)?.has(hopKey(a, b)) ?? false;
}

/** Whether `lineId` calls at `id` at all. Unknown line → false. */
export function isLineStop(index: HopIndex, lineId: string, id: string): boolean {
  return index.stopsByLine.get(lineId)?.has(id) ?? false;
}

/**
 * First consecutive pair of `ids` that is not a hop of `lineId`, or null when
 * every pair is. A list shorter than one hop has no bad hop — callers decide
 * separately whether such a list is usable (it never describes a section).
 */
export function firstBadHop(
  index: HopIndex,
  lineId: string,
  ids: readonly string[],
): [string, string] | null {
  if (ids.length < MIN_HOP_IDS) return null;
  return consecutivePairs(ids).find(([a, b]) => !isHop(index, lineId, a, b)) ?? null;
}
