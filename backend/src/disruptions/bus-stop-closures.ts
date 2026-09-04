// `/StopPoint/Mode/bus/Disruption` -> the bus-stop closures in force RIGHT NOW.
//
// The feed is a flat list of "disrupted points" keyed by `atcoCode`, measured
// 2026-09-04 at 304 rows over 275 distinct poles, 121 KB. It carries no
// coordinate and no route list: both come from the gazetteer beside this file.
//
// The owner's binding decision is that the overlay shows ONLY closures whose
// window covers this moment. That is not the same question as TfL's own
// category, and the difference has already produced a wrong map once: the rail
// layer split live from planned by category, and hatched the whole Waterloo &
// City line closed on a Friday morning while it was running. The mirror bug is
// worse — a closure that HAS begun filed as "planned" and therefore hidden. So
// the only test applied here is the window against a server-anchored `nowMs`,
// and a row whose dates cannot be read is dropped and counted rather than
// guessed in either direction.
import type { BusStop } from './bus-stop-gazetteer';

/** Longest free text a pin may carry; TfL's longest row measured 477 chars. */
export const MAX_DESCRIPTION_CHARS = 400;

/** Marks text the cap cut short, so a truncated sentence never reads as whole. */
const ELLIPSIS = '…';

/** Between the distinct sentences TfL filed against one pole. */
const DESCRIPTION_SEPARATOR = ' — ';

/** Between the distinct disruption types filed against one pole. */
const TYPE_SEPARATOR = ', ';

/** Where a row sits relative to `nowMs`, or that its dates cannot be read. */
export type WindowVerdict = 'in-force' | 'out-of-window' | 'unreadable';

/** One closed pole, merged from every row TfL filed against it. */
export interface ClosureStop {
  /** The ATCO id of the pole itself. */
  readonly id: string;
  readonly name: string;
  readonly lat: number;
  readonly lon: number;
  /** Routes serving the pole, from the gazetteer; TfL's rows carry none. */
  readonly routes: readonly string[];
  /** Every distinct `type` the merged rows carry, e.g. "Closure". */
  readonly ty: string;
  /** Earliest `fromDate` of the merged rows, verbatim as TfL wrote it. */
  readonly f?: string;
  /** Latest `toDate`; absent when any merged row is open-ended. */
  readonly t?: string;
  /** Every distinct description, whitespace-normalised and capped. */
  readonly d: string;
  /** The direction the pole serves, when the gazetteer states one. */
  readonly towards?: string;
}

export interface ClosureStats {
  /** Rows in the upstream body. */
  readonly rows: number;
  /** Rows whose window covers `nowMs`. */
  readonly inForce: number;
  /** Rows correctly filtered out: their window does not cover `nowMs`. */
  readonly notInForce: number;
  /** Rows that could not be read at all — no id, or dates that will not parse. */
  readonly dropped: number;
  /** Distinct in-force poles with no position in the gazetteer. */
  readonly unresolved: number;
  /** Pins emitted. */
  readonly stops: number;
}

export interface ShapeResult {
  readonly stops: readonly ClosureStop[];
  readonly stats: ClosureStats;
}

/** Called once per dropped row (or per unplaceable pole) so nothing is silent. */
export type OnDrop = (reason: string) => void;

type RawRow = Record<string, unknown>;

/** A row's dates, verbatim and parsed, once both are known to be readable. */
interface ClosureWindow {
  readonly from: string;
  readonly fromMs: number;
  /** Both absent for an open-ended closure. */
  readonly to?: string;
  readonly toMs?: number;
}

/** One readable row, before the gazetteer join. */
interface ClosureRow extends ClosureWindow {
  readonly id: string;
  readonly ty: string;
  readonly d: string;
}

/** A pole's merged rows, still awaiting its final text. */
interface Draft extends ClosureWindow {
  readonly stop: BusStop;
  readonly types: readonly string[];
  readonly descriptions: readonly string[];
}

/**
 * Is this row's window open at `nowMs`? Deliberately the ONLY question asked
 * of a row's dates, and deliberately its own function so the boundaries can be
 * tested directly: exactly at `fromDate` and exactly at `toDate` are both in
 * force, an absent `toDate` is open-ended, and anything unparseable — an absent
 * `fromDate` included — is `unreadable` rather than assumed either way.
 */
export function windowVerdict(fromDate: unknown, toDate: unknown, nowMs: number): WindowVerdict {
  const window = readWindow({ fromDate, toDate });
  if (window === null) return 'unreadable';
  return coversNow(window, nowMs) ? 'in-force' : 'out-of-window';
}

/** Both dates as TfL wrote them plus their instants, or null if either fails. */
function readWindow(record: RawRow): ClosureWindow | null {
  const from = readText(record['fromDate']);
  const fromMs = parseMs(from);
  if (from === null || fromMs === null) return null;
  if (isAbsent(record['toDate'])) return { from, fromMs };
  const to = readText(record['toDate']);
  const toMs = parseMs(to);
  if (to === null || toMs === null) return null;
  return { from, fromMs, to, toMs };
}

/** Closed at `nowMs`: both boundaries inclusive, an absent end open-ended. */
function coversNow(window: ClosureWindow, nowMs: number): boolean {
  return window.fromMs <= nowMs && (window.toMs === undefined || window.toMs >= nowMs);
}

/**
 * The distinct poles closed at `nowMs` — the only ids worth a gazetteer
 * lookup. Silent by design: this pass exists to spend network calls wisely,
 * and `shapeClosures` is where every drop is counted and named.
 */
export function liveClosureIds(feedBody: unknown, nowMs: number): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const entry of readRows(feedBody)) {
    const record = asRecord(entry);
    const id = record ? readText(record['atcoCode']) : null;
    if (!record || id === null || seen.has(id)) continue;
    const window = readWindow(record);
    if (window === null || !coversNow(window, nowMs)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/**
 * Turn the raw feed into the pins the map may draw: in force at `nowMs`,
 * positioned by the gazetteer, one pin per pole however many rows TfL filed.
 * Throws on a body that is not a row array — an unreadable feed must not
 * become an empty "no closures anywhere" map.
 */
export function shapeClosures(
  feedBody: unknown,
  gazetteer: ReadonlyMap<string, BusStop>,
  nowMs: number,
  onDrop: OnDrop,
): ShapeResult {
  const rows = readRows(feedBody);
  const drafts = new Map<string, Draft>();
  const unplaceable = new Set<string>();
  let inForce = 0;
  let notInForce = 0;
  let dropped = 0;

  for (const [index, entry] of rows.entries()) {
    const verdict = readRow(entry, index, nowMs);
    if (verdict.kind === 'drop') {
      dropped += 1;
      onDrop(verdict.reason);
      continue;
    }
    if (verdict.kind === 'not-in-force') {
      notInForce += 1;
      continue;
    }

    inForce += 1;
    const { row } = verdict;
    const stop = gazetteer.get(row.id);
    if (stop === undefined) {
      // Counted per POLE, not per row: the number answers "how many pins were
      // lost", and a pole named by three rows lost exactly one pin.
      if (!unplaceable.has(row.id)) {
        unplaceable.add(row.id);
        onDrop(`${row.id} dropped: no position in the bus-stop gazetteer`);
      }
      continue;
    }
    drafts.set(row.id, mergeDraft(drafts.get(row.id), row, stop));
  }

  const stops = [...drafts.values()].map(toClosureStop);
  return {
    stops,
    stats: {
      rows: rows.length,
      inForce,
      notInForce,
      dropped,
      unresolved: unplaceable.size,
      stops: stops.length,
    },
  };
}

/** What one raw entry turned out to be: usable, correctly filtered, or fallen. */
type RowVerdict =
  | { readonly kind: 'drop'; readonly reason: string }
  | { readonly kind: 'not-in-force' }
  | { readonly kind: 'in-force'; readonly row: ClosureRow };

function readRow(entry: unknown, index: number, nowMs: number): RowVerdict {
  const record = asRecord(entry);
  const id = record ? readText(record['atcoCode']) : null;
  if (!record || id === null) return { kind: 'drop', reason: `row ${index} has no atcoCode` };

  const window = readWindow(record);
  if (window === null) {
    const dates = `${String(record['fromDate'])}..${String(record['toDate'])}`;
    return { kind: 'drop', reason: `${id} dropped: window ${dates} is unreadable` };
  }
  if (!coversNow(window, nowMs)) return { kind: 'not-in-force' };

  const ty = readText(record['type']) ?? '';
  return { kind: 'in-force', row: { ...window, id, ty, d: normalizeText(record['description']) } };
}

/** Fold one more row into a pole's pin: union window, distinct type and text. */
function mergeDraft(existing: Draft | undefined, row: ClosureRow, stop: BusStop): Draft {
  if (existing === undefined) {
    return {
      stop,
      types: [row.ty],
      descriptions: row.d.length > 0 ? [row.d] : [],
      from: row.from,
      fromMs: row.fromMs,
      ...endOf(row),
    };
  }
  // Both windows contain `nowMs`, so their union is one interval around it.
  const earlier = row.fromMs < existing.fromMs ? row : existing;
  return {
    stop,
    types: append(existing.types, row.ty),
    descriptions: row.d.length > 0 ? append(existing.descriptions, row.d) : existing.descriptions,
    from: earlier.from,
    fromMs: earlier.fromMs,
    ...latestEnd(existing, row),
  };
}

/** An absent `toDate` on either row keeps the merged pin open-ended. */
function latestEnd(existing: Draft, row: ClosureRow): { to?: string; toMs?: number } {
  if (existing.toMs === undefined || row.toMs === undefined) return {};
  return existing.toMs >= row.toMs
    ? { to: existing.to, toMs: existing.toMs }
    : { to: row.to, toMs: row.toMs };
}

/** The end of a window, or nothing at all when the closure is open-ended. */
function endOf(window: ClosureWindow): { to?: string; toMs?: number } {
  return window.to === undefined || window.toMs === undefined
    ? {}
    : { to: window.to, toMs: window.toMs };
}

function toClosureStop(draft: Draft): ClosureStop {
  const { stop } = draft;
  const base: ClosureStop = {
    id: stop.id,
    name: stop.name,
    lat: stop.lat,
    lon: stop.lon,
    routes: stop.routes,
    ty: draft.types.join(TYPE_SEPARATOR),
    f: draft.from,
    d: capText(draft.descriptions.join(DESCRIPTION_SEPARATOR)),
  };
  const withEnd = draft.to === undefined ? base : { ...base, t: draft.to };
  return stop.towards === undefined ? withEnd : { ...withEnd, towards: stop.towards };
}

function readRows(feedBody: unknown): readonly unknown[] {
  if (!Array.isArray(feedBody)) {
    throw new Error('TfL bus stop disruption body was not an array of rows');
  }
  return feedBody;
}

/**
 * Countdown-display text arrives padded to the sign's line width, and its
 * breaks are LITERAL backslash-n: measured 2026-09-04, 909 of them across the
 * feed and not one real control character. Unfolded to spaces, because the
 * alternative is every popup reading "Bus Stop Closed\n\n\n". Only the escape
 * letters TfL actually writes are touched — nothing else is rewritten.
 */
const ESCAPED_BREAK = /\\[nrt]/g;

function normalizeText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(ESCAPED_BREAK, ' ').replace(/\s+/g, ' ').trim();
}

function capText(text: string): string {
  if (text.length <= MAX_DESCRIPTION_CHARS) return text;
  return `${text.slice(0, MAX_DESCRIPTION_CHARS - ELLIPSIS.length)}${ELLIPSIS}`;
}

function append(values: readonly string[], value: string): readonly string[] {
  return values.includes(value) ? values : [...values, value];
}

function parseMs(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** An open-ended closure: TfL omits, nulls or empties `toDate`. */
function isAbsent(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

function asRecord(value: unknown): RawRow | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as RawRow)
    : null;
}

function readText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
