// Tier 0 of the disruption resolver: turn a compact line-status snapshot into
// the drawable items of docs/DISRUPTION_GEOLOCATION_SPEC.md §4, using ONLY the
// structured NaPTAN ids TfL publishes (`ar[].st` route slices and `as[]` stop
// lists) plus the severity code. No sentence is ever read for geometry — the
// reason text travels as text and nothing else (§5.1, §5.5). A status whose
// structured fields are missing, off-line or not hop-contiguous becomes a
// line-level item carrying its sentence, which is the fail-closed outcome the
// spec asks for: the map says "this line, somewhere" rather than guessing.
//
// Pure: same snapshot in, same items out. The route calls it once per cache
// miss (backend/src/routes/disruptions.ts).
import { firstBadHop, isLineStop, type HopIndex } from './line-graph';
import type { AffectedRoute, LineSnapshot, LineStatusEntry, ValidityPeriod } from './tfl-status-shape';

/** Render class — derived from the TfL severity code ONLY, never from text. */
export type RenderClass = 'closed' | 'severe' | 'minor' | 'info';
/** b both | i inbound | o outbound. Popup qualifier only; geometry is undirected. */
export type SectionDirection = 'b' | 'i' | 'o';
/** What the map may draw for this item. */
export type ItemScope = 'line' | 'section' | 'station';
/** s structured (TfL ids) | f fallback (nothing localised). Tier 1 ("p") cannot occur here. */
export type ItemSource = 's' | 'f';

export interface DisruptionSection {
  /** Ordered NaPTAN ids; every consecutive pair is a baked branch hop. */
  readonly st: readonly string[];
  readonly k: RenderClass;
  readonly dir: SectionDirection;
}

export interface DisruptionPoint {
  readonly id: string;
  /** Tier 0 knows one role: a stop TfL listed in `affectedStops`. */
  readonly role: 'stop';
}

export interface DisruptionValidity {
  /** fromDate, ISO. */
  readonly f: string;
  /** toDate, ISO — PlannedWork only; a RealTime toDate is a rolling stamp. */
  readonly t?: string;
}

export interface DisruptionItem {
  /** `<lineId>:<fnv1a32 of the canonical sentence>:<closureText|none>` — no dates. */
  readonly id: string;
  readonly l: string;
  /** Manifest mode; absent when the line is not in the manifest. */
  readonly m?: string;
  readonly s: number;
  readonly d: string;
  readonly k: RenderClass;
  /** disruption.category initial: R | P | I. Absent when TfL sent none. */
  readonly c?: string;
  /** 1 when any validity period was current at fetch time. */
  readonly n: 0 | 1;
  readonly v?: readonly DisruptionValidity[];
  readonly sc: ItemScope;
  readonly src: ItemSource;
  /** 1 = whole line; the client hatches every hop and no geometry is sent. */
  readonly wl: 0 | 1;
  readonly sec: readonly DisruptionSection[];
  readonly pts: readonly DisruptionPoint[];
  readonly r: string;
}

export interface ResolveStats {
  /** Non-Good statuses considered. */
  readonly statuses: number;
  readonly items: number;
  readonly sections: number;
  readonly stops: number;
  /** Route entries refused because an id or a hop did not match the baked branches. */
  readonly sectionsDropped: number;
  /** affectedStops ids refused because the line does not call there. */
  readonly stopsDropped: number;
}

export interface ResolveContext {
  readonly hops: HopIndex;
  /** manifest line id → mode, for the item's `m`. */
  readonly modeById: ReadonlyMap<string, string>;
  readonly log: (msg: string) => void;
}

/** Severities that are not a disruption at all (Good Service, No Issues). */
const GOOD_SEVERITIES: ReadonlySet<number> = new Set([10, 18]);
/** Severities that are line-wide by definition: Closed, Suspended, Service Closed. */
const WHOLE_LINE_SEVERITIES: ReadonlySet<number> = new Set([1, 2, 20]);

/**
 * TfL's /Line/Meta/Severity table (0..20, measured 2026-09-02), the ONLY input
 * to the render class. Codes 10 and 18 are filtered out before this is read.
 */
const CLASS_BY_SEVERITY: Readonly<Record<number, RenderClass>> = {
  0: 'closed', // Special Service
  1: 'closed', // Closed
  2: 'closed', // Suspended
  3: 'closed', // Part Suspended
  4: 'closed', // Planned Closure
  5: 'closed', // Part Closure
  6: 'severe', // Severe Delays
  7: 'minor', // Reduced Service
  8: 'minor', // Bus Service
  9: 'minor', // Minor Delays
  11: 'closed', // Part Closed
  14: 'minor', // Change of frequency
  15: 'minor', // Diverted
  16: 'closed', // Not Running
  20: 'closed', // Service Closed
};

/** Worst first: which class wins when several statuses merge into one item. */
const CLASS_RANK: Readonly<Record<RenderClass, number>> = {
  closed: 0,
  severe: 1,
  minor: 2,
  info: 3,
};

const MIN_SECTION_IDS = 2;
const MAX_REASON_CHARS = 600;
const MAX_DESCRIPTION_CHARS = 300;
const NO_CLOSURE_TEXT = 'none';
const ELLIPSIS = '…';
/** How many ids of a refused route entry the log line echoes. */
const MAX_LOG_IDS_CHARS = 200;
const ID_HASH_HEX_CHARS = 8;
const HEX_RADIX = 16;
const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const MERGE_KEY_SEPARATOR = '\u0000';
const SEQUENCE_SEPARATOR = '>';

/** The render class of a severity code; anything TfL adds later is `info`. */
export function renderClass(severity: number): RenderClass {
  return CLASS_BY_SEVERITY[severity] ?? 'info';
}

/**
 * Whitespace, case and quoting normalisation — NOT parsing. It exists so the
 * same notice keeps one identity when TfL re-issues it with a different case,
 * a doubled space or an HTML tag around a link, and so two statuses under one
 * sentence merge into one item.
 */
export function canonicalSentence(text: string): string {
  return text
    .normalize('NFC')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .toLowerCase()
    .replace(/'/g, '')
    .replace(/-\s+/g, '-')
    .replace(/\.\s+\./g, '.')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.,;:\s]+$/, '');
}

/** FNV-1a 32-bit, as 8 hex chars: short, stable across processes, no crypto need. */
function fnv1a32Hex(text: string): string {
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return (hash >>> 0).toString(HEX_RADIX).padStart(ID_HASH_HEX_CHARS, '0');
}

/** Trims to `max` characters INCLUDING the ellipsis, so the cap is a real bound. */
function capText(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - ELLIPSIS.length)}${ELLIPSIS}`;
}

/** Undirected identity of an ordered id list: the smaller of it and its reverse. */
function sequenceKey(ids: readonly string[]): string {
  const forward = ids.join(SEQUENCE_SEPARATOR);
  const backward = [...ids].reverse().join(SEQUENCE_SEPARATOR);
  return forward < backward ? forward : backward;
}

function directionOf(route: AffectedRoute): SectionDirection {
  if (route.dir === 'inbound') return 'i';
  if (route.dir === 'outbound') return 'o';
  return 'b';
}

/** Two directions of one slice are one section drawn both ways. */
function mergeDirections(a: SectionDirection, b: SectionDirection): SectionDirection {
  return a === b ? a : 'b';
}

function worseClass(a: RenderClass, b: RenderClass): RenderClass {
  return CLASS_RANK[a] <= CLASS_RANK[b] ? a : b;
}

/**
 * Collapses duplicate slices: TfL publishes one disrupted section once per
 * service pattern and once per direction (measured 2026-09-03: the Elizabeth
 * line sent one 3-id slice 16 times), and drawing it 16 times would stack 16
 * translucent bands on one corridor. Order of first appearance is kept.
 */
function dedupeSections(sections: readonly DisruptionSection[]): DisruptionSection[] {
  const byKey = new Map<string, DisruptionSection>();
  for (const section of sections) {
    const key = sequenceKey(section.st);
    const seen = byKey.get(key);
    byKey.set(
      key,
      seen === undefined
        ? section
        : {
            st: seen.st,
            k: worseClass(seen.k, section.k),
            dir: mergeDirections(seen.dir, section.dir),
          },
    );
  }
  return [...byKey.values()];
}

interface SectionsResult {
  readonly sections: DisruptionSection[];
  readonly dropped: number;
}

/**
 * The one geometry gate. A route entry survives only if every id is a stop of
 * the line AND every consecutive pair is a baked hop — all or nothing, because
 * TfL's ordinals are contiguous on real partial sections, so a gap means the
 * bake and the feed disagree and the slice cannot be trusted (§5.1-a).
 */
function resolveSections(
  lineId: string,
  entry: LineStatusEntry,
  k: RenderClass,
  ctx: ResolveContext,
): SectionsResult {
  const candidates = (entry.ar ?? []).filter((route) => route.e !== true);
  const sections: DisruptionSection[] = [];
  let dropped = 0;
  for (const route of candidates) {
    const ids = route.st ?? [];
    const reason = refusalReason(lineId, ids, ctx.hops);
    if (reason !== null) {
      dropped += 1;
      ctx.log(
        `disruptions: bake-drift line=${lineId} ids=${capText(ids.join(','), MAX_LOG_IDS_CHARS)} ${reason}`,
      );
      continue;
    }
    sections.push({ st: ids, k, dir: directionOf(route) });
  }
  return { sections: dedupeSections(sections), dropped };
}

/** Why this id list may not be drawn on `lineId`, or null when it may. */
function refusalReason(lineId: string, ids: readonly string[], hops: HopIndex): string | null {
  if (ids.length < MIN_SECTION_IDS) return `only ${ids.length} id(s), not a section`;
  const offLine = ids.find((id) => !isLineStop(hops, lineId, id));
  if (offLine !== undefined) return `${offLine} is not a stop of the line`;
  const badHop = firstBadHop(hops, lineId, ids);
  if (badHop !== null) return `hop ${badHop[0]} > ${badHop[1]} is not a branch edge`;
  return null;
}

interface PointsResult {
  readonly points: DisruptionPoint[];
  readonly dropped: number;
}

/** `affectedStops` ids the line actually calls at; the rest are counted and dropped. */
function resolvePoints(lineId: string, entry: LineStatusEntry, ctx: ResolveContext): PointsResult {
  const ids = entry.as ?? [];
  const kept = ids.filter((id) => isLineStop(ctx.hops, lineId, id));
  return {
    points: kept.map((id) => ({ id, role: 'stop' })),
    dropped: ids.length - kept.length,
  };
}

/**
 * Whole line when the severity says the line is closed outright, or when every
 * route TfL attached is an ENTIRE route section — a status about the line as a
 * whole. An absent or empty `ar` is not evidence of either: it is the ordinary
 * shape of a status with no structured field, which must fall back to text.
 */
function isWholeLine(entry: LineStatusEntry): boolean {
  if (WHOLE_LINE_SEVERITIES.has(entry.s)) return true;
  const routes = entry.ar ?? [];
  return routes.length > 0 && routes.every((route) => route.e === true);
}

interface StatusResolution {
  readonly entry: LineStatusEntry;
  readonly k: RenderClass;
  readonly wholeLine: boolean;
  readonly sections: readonly DisruptionSection[];
  readonly points: readonly DisruptionPoint[];
  readonly sectionsDropped: number;
  readonly stopsDropped: number;
}

const EMPTY_RESOLUTION = { sections: [], points: [], sectionsDropped: 0, stopsDropped: 0 } as const;

function resolveStatus(lineId: string, entry: LineStatusEntry, ctx: ResolveContext): StatusResolution {
  const k = renderClass(entry.s);
  // A hatched line carries no sections and no rings: the whole line is the mark.
  if (isWholeLine(entry)) return { entry, k, wholeLine: true, ...EMPTY_RESOLUTION };
  const sections = resolveSections(lineId, entry, k, ctx);
  const points = resolvePoints(lineId, entry, ctx);
  return {
    entry,
    k,
    wholeLine: false,
    sections: sections.sections,
    points: points.points,
    sectionsDropped: sections.dropped,
    stopsDropped: points.dropped,
  };
}

interface Group {
  readonly lineId: string;
  readonly canon: string;
  readonly parts: readonly StatusResolution[];
}

/** The status whose class — then whose severity — is worst; it names the item. */
function worstEntry(parts: readonly StatusResolution[]): StatusResolution {
  return parts.reduce((worst, part) => {
    const byClass = CLASS_RANK[part.k] - CLASS_RANK[worst.k];
    if (byClass < 0) return part;
    if (byClass > 0) return worst;
    return part.entry.s < worst.entry.s ? part : worst;
  });
}

/** Validity periods of every merged status, deduplicated, earliest first. */
function mergeValidity(parts: readonly StatusResolution[]): DisruptionValidity[] {
  const byKey = new Map<string, DisruptionValidity>();
  for (const period of parts.flatMap((part): ValidityPeriod[] => part.entry.v ?? [])) {
    const value: DisruptionValidity = period.t === undefined ? { f: period.f } : { f: period.f, t: period.t };
    byKey.set(`${value.f}|${value.t ?? ''}`, value);
  }
  return [...byKey.values()].sort((a, b) => (a.f < b.f ? -1 : a.f > b.f ? 1 : 0));
}

function mergePoints(parts: readonly StatusResolution[]): DisruptionPoint[] {
  const byId = new Map<string, DisruptionPoint>();
  for (const point of parts.flatMap((part) => part.points)) byId.set(point.id, point);
  return [...byId.values()];
}

function scopeOf(sections: readonly unknown[], points: readonly unknown[], wl: 0 | 1): ItemScope {
  if (sections.length > 0 || wl === 1) return 'section';
  return points.length > 0 ? 'station' : 'line';
}

/** The raw sentence to show: the worst status's, else the first one that has any. */
function itemReason(worst: StatusResolution, parts: readonly StatusResolution[]): string {
  const reason = worst.entry.r ?? parts.find((part) => part.entry.r !== undefined)?.entry.r ?? '';
  return capText(reason, MAX_REASON_CHARS);
}

function buildItem(group: Group, ctx: ResolveContext): DisruptionItem {
  const worst = worstEntry(group.parts);
  const sec = dedupeSections(group.parts.flatMap((part) => part.sections));
  const pts = mergePoints(group.parts);
  // Geometry wins over a whole-line promotion: when one status of a sentence
  // localised the disruption, drawing the whole line instead would be a
  // wider claim than TfL's own ids support.
  const wl: 0 | 1 = group.parts.some((part) => part.wholeLine) && sec.length === 0 && pts.length === 0 ? 1 : 0;
  const v = mergeValidity(group.parts);
  const mode = ctx.modeById.get(group.lineId);
  const category = worst.entry.c;
  const localised = sec.length > 0 || pts.length > 0 || wl === 1;
  return {
    id: `${group.lineId}:${fnv1a32Hex(group.canon)}:${worst.entry.ct ?? NO_CLOSURE_TEXT}`,
    l: group.lineId,
    ...(mode === undefined ? {} : { m: mode }),
    s: worst.entry.s,
    d: capText(worst.entry.d, MAX_DESCRIPTION_CHARS),
    k: worst.k,
    ...(category === undefined || category === '' ? {} : { c: category.slice(0, 1).toUpperCase() }),
    n: group.parts.some((part) => (part.entry.v ?? []).some((period) => period.n === true)) ? 1 : 0,
    ...(v.length === 0 ? {} : { v }),
    sc: scopeOf(sec, pts, wl),
    src: localised ? 's' : 'f',
    wl,
    sec,
    pts,
    r: itemReason(worst, group.parts),
  };
}

/**
 * Resolves one compact snapshot into drawable items. One item per (line id,
 * canonical sentence): TfL routinely publishes several statuses under one
 * sentence — one per suspended section — and they are one notice to a rider.
 */
export function resolveSnapshot(
  lines: readonly LineSnapshot[],
  ctx: ResolveContext,
): { items: DisruptionItem[]; stats: ResolveStats } {
  const groups = new Map<string, Group>();
  let statuses = 0;
  let sectionsDropped = 0;
  let stopsDropped = 0;
  for (const line of lines) {
    for (const entry of line.st) {
      if (GOOD_SEVERITIES.has(entry.s)) continue;
      statuses += 1;
      const resolution = resolveStatus(line.id, entry, ctx);
      sectionsDropped += resolution.sectionsDropped;
      stopsDropped += resolution.stopsDropped;
      const canon = canonicalSentence(entry.r ?? '');
      const key = `${line.id}${MERGE_KEY_SEPARATOR}${canon}`;
      const group = groups.get(key);
      groups.set(
        key,
        group === undefined
          ? { lineId: line.id, canon, parts: [resolution] }
          : { ...group, parts: [...group.parts, resolution] },
      );
    }
  }
  const items = [...groups.values()].map((group) => buildItem(group, ctx));
  return {
    items,
    stats: {
      statuses,
      items: items.length,
      sections: items.reduce((total, item) => total + item.sec.length, 0),
      stops: items.reduce((total, item) => total + item.pts.length, 0),
      sectionsDropped,
      stopsDropped,
    },
  };
}
