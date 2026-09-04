// Real TfL service patterns (`orderedLineRoutes`) baked by
// scripts/bake-route-patterns.mjs into data/route-patterns/<lineId>.json.
// Tier 1 (parsed) disruption geometry is only ever a slice of one of these
// patterns (docs/DISRUPTION_GEOLOCATION_SPEC.md §5.4); a line without a
// valid file has no Tier 1 geometry at all — there is no fragment fallback.
// The section slicer itself is P1 and does not live here. The hop index every
// pattern is validated against lives in line-graph.ts, shared with the Tier 0
// resolver so both refuse exactly the same geometry.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildHopIndex, firstBadHop, type HopIndex } from './line-graph';
import type { LineBranches } from '../shared/types';

export type PatternDirection = 'inbound' | 'outbound';

/** One TfL service pattern: the ordered NaPTAN ids a train actually calls at. */
export interface Pattern {
  dir: PatternDirection;
  name: string;
  ids: string[];
}

export interface RoutePatternsResult {
  /** lineId → validated patterns. A line absent here has Tier 1 disabled. */
  patterns: Map<string, Pattern[]>;
  /** Patterns kept across all lines. */
  loaded: number;
  /** Patterns dropped across all lines (bad hop or malformed entry). */
  dropped: number;
}

type Verdict = { pattern: Pattern; reason: null } | { pattern: null; reason: string };
type FileRead = { ok: true; patterns: unknown[] } | { ok: false; reason: string };

const ROUTE_PATTERNS_DIR = 'route-patterns';
/** A pattern needs at least one hop to describe a section. */
const MIN_PATTERN_IDS = 2;
/** How much of a malformed entry to echo in the log line. */
const MAX_REASON_CHARS = 120;
const DIRECTIONS: readonly string[] = ['inbound', 'outbound'];

function isPattern(value: unknown): value is Pattern {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as Record<string, unknown>;
  const ids = p['ids'];
  return (
    typeof p['dir'] === 'string' &&
    DIRECTIONS.includes(p['dir']) &&
    typeof p['name'] === 'string' &&
    Array.isArray(ids) &&
    ids.length >= MIN_PATTERN_IDS &&
    ids.every((id) => typeof id === 'string')
  );
}

function judge(candidate: unknown, index: HopIndex, lineId: string): Verdict {
  if (!isPattern(candidate)) {
    const shown = JSON.stringify(candidate)?.slice(0, MAX_REASON_CHARS) ?? String(candidate);
    return { pattern: null, reason: `malformed pattern ${shown}` };
  }
  const bad = firstBadHop(index, lineId, candidate.ids);
  if (bad) {
    return {
      pattern: null,
      reason: `"${candidate.name}" (${candidate.dir}) hop ${bad[0]} > ${bad[1]} is not a branch edge`,
    };
  }
  return { pattern: candidate, reason: null };
}

/**
 * A file is usable only if `patterns` is a NON-EMPTY array: a well-formed
 * `{ "patterns": [] }` would otherwise pass every check, contribute 0/0 to the
 * counters and disable Tier 1 for the line without a single log line — which
 * is exactly the silent failure §13 item 1 forbids.
 */
function readPatternFile(dataDir: string, lineId: string): FileRead {
  const path = join(dataDir, ROUTE_PATTERNS_DIR, `${lineId}.json`);
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { patterns?: unknown };
    if (!Array.isArray(parsed.patterns)) return { ok: false, reason: '`patterns` is not an array' };
    if (parsed.patterns.length === 0) return { ok: false, reason: '`patterns` is empty' };
    return { ok: true, patterns: parsed.patterns };
  } catch (err) {
    return { ok: false, reason: String(err) };
  }
}

/**
 * Reads data/route-patterns/<lineId>.json for every line in `branchesByLine`
 * and keeps only patterns whose every consecutive pair is a consecutive-stop
 * pair of some baked branch of that line (undirected). Anything else is
 * dropped and logged with the offending pair; a line with no usable file
 * (missing, unparsable, `patterns` absent or empty) is logged once and gets
 * no entry. Because an empty file never reaches validation, a line that ends
 * up with zero patterns has always produced at least one log line.
 */
export function loadRoutePatterns(
  dataDir: string,
  branchesByLine: ReadonlyMap<string, LineBranches>,
  log: (msg: string) => void,
): RoutePatternsResult {
  const index = buildHopIndex(branchesByLine);
  const patterns = new Map<string, Pattern[]>();
  let loaded = 0;
  let dropped = 0;
  for (const lineId of [...branchesByLine.keys()].sort()) {
    const file = readPatternFile(dataDir, lineId);
    if (!file.ok) {
      log(`route-patterns: ${lineId} has no usable pattern file, Tier 1 disabled: ${file.reason}`);
      continue;
    }
    const verdicts = file.patterns.map((candidate) => judge(candidate, index, lineId));
    const kept = verdicts.flatMap((v) => (v.pattern ? [v.pattern] : []));
    for (const v of verdicts) {
      if (v.reason) log(`route-patterns: ${lineId} dropped ${v.reason}`);
    }
    loaded += kept.length;
    dropped += verdicts.length - kept.length;
    if (kept.length > 0) patterns.set(lineId, kept);
  }
  return { patterns, loaded, dropped };
}
