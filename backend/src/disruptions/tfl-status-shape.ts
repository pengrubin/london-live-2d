// Compact shape of a TfL line-status body. Both status forms — the Mode form
// (/Line/Mode/{modes}/Status) and the date-window form
// (/Line/{ids}/Status/{from}/to/{to}) — return the same Line[].lineStatuses[]
// structure (verified on a window sample, 2026-09-02), so one reducer serves
// the tube-status archive today and the disruptions route later. The short
// keys are the archive's on-disk format: every key added since the first
// archived day is optional, so older day files still serialize identically.

/** A validity window TfL attaches to a status (traffic day for live, planned window for works). */
export interface ValidityPeriod {
  /** fromDate, ISO 8601. */
  f: string;
  /**
   * toDate, ISO 8601. Omitted for RealTime statuses: TfL rolls a live
   * suspension's toDate forward on every poll (measured 2026-09-02: 23:17Z →
   * 23:23Z → 00:54Z across three fetches), which would defeat the change
   * detection dedup and write a ~40 KB row every 2 minutes for the whole incident.
   */
  t?: string;
  /** isNow — whether the window covers the moment of the snapshot. */
  n?: boolean;
}

/** One TfL route section the disruption touches, as a NaPTAN stop sequence. */
export interface AffectedRoute {
  id: string;
  /** Route name, e.g. "Earl's Court - Kensington (Olympia)". */
  n?: string;
  /** Direction, "inbound" / "outbound". */
  dir?: string;
  /** originationName. */
  o?: string;
  /** destinationName. */
  de?: string;
  /**
   * isEntireRouteSection. Measured 2026-09-02: true means the sequence is the
   * whole route (a line-wide status, no localisation value); false means it is
   * only the disrupted slice, contiguous ordinals, directly mappable to segments.
   */
  e?: boolean;
  /**
   * NaPTAN ids of routeSectionNaptanEntrySequence, in order. Omitted when
   * `e` is true: a whole-route list is 91% of the detail body and says nothing
   * a line id does not (measured: dropping it shrinks a window snapshot by 30%).
   */
  st?: string[];
}

/** One concurrent status on a line (a line can carry several at once). */
export interface LineStatusEntry {
  /** TfL statusSeverity code — 10 is Good Service, lower is worse. */
  s: number;
  /** Human description, e.g. "Minor Delays". */
  d: string;
  /** Free-text reason; only present when TfL provides one. */
  r?: string;
  /** disruption.category, e.g. "RealTime" / "PlannedWork". */
  c?: string;
  /** disruption.closureText, e.g. "partClosure" / "severeDelays". */
  ct?: string;
  /** validityPeriods. */
  v?: ValidityPeriod[];
  /** disruption.affectedRoutes — the ground truth for "which segments" a reason sentence means. */
  ar?: AffectedRoute[];
  /** disruption.affectedStops NaPTAN ids, deduplicated, in TfL order. */
  as?: string[];
}

export interface LineSnapshot {
  id: string;
  st: LineStatusEntry[];
}

// ── the upstream shape, every field optional: never trust TfL data ──

export interface TflStopPoint {
  naptanId?: string;
}

export interface TflRouteSectionEntry {
  stopPoint?: TflStopPoint;
}

export interface TflAffectedRoute {
  id?: string;
  name?: string;
  direction?: string;
  originationName?: string;
  destinationName?: string;
  isEntireRouteSection?: boolean;
  routeSectionNaptanEntrySequence?: TflRouteSectionEntry[];
}

export interface TflLineDisruption {
  category?: string;
  closureText?: string;
  affectedRoutes?: TflAffectedRoute[];
  affectedStops?: TflStopPoint[];
}

export interface TflValidityPeriod {
  fromDate?: string;
  toDate?: string;
  isNow?: boolean;
}

export interface TflLineStatus {
  statusSeverity?: number;
  statusSeverityDescription?: string;
  reason?: string;
  validityPeriods?: TflValidityPeriod[];
  /** affectedRoutes / affectedStops are only populated with ?detail=true. */
  disruption?: TflLineDisruption;
}

export interface TflLine {
  id?: string;
  lineStatuses?: TflLineStatus[];
}

const REAL_TIME_CATEGORY = 'RealTime';

const nonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

/** `keepEnd` is false for RealTime statuses, whose toDate is a rolling stamp (see ValidityPeriod.t). */
function compactValidity(raw: unknown, keepEnd: boolean): ValidityPeriod[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const periods: ValidityPeriod[] = [];
  for (const period of raw as (TflValidityPeriod | null)[]) {
    if (!nonEmptyString(period?.fromDate)) continue;
    const compacted: ValidityPeriod = { f: period.fromDate };
    if (keepEnd && nonEmptyString(period.toDate)) compacted.t = period.toDate;
    if (period.isNow === true) compacted.n = true;
    periods.push(compacted);
  }
  return periods.length > 0 ? periods : undefined;
}

/** NaPTAN ids of a stop list, deduplicated, in upstream order. */
export function naptanIds(stops: readonly (TflStopPoint | null | undefined)[]): string[] {
  const seen = new Set<string>();
  for (const stop of stops) {
    if (nonEmptyString(stop?.naptanId)) seen.add(stop.naptanId);
  }
  return [...seen];
}

function compactRoutes(raw: unknown): AffectedRoute[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const routes: AffectedRoute[] = [];
  for (const route of raw as (TflAffectedRoute | null)[]) {
    if (!nonEmptyString(route?.id)) continue;
    const compacted: AffectedRoute = { id: route.id };
    if (nonEmptyString(route.name)) compacted.n = route.name;
    if (nonEmptyString(route.direction)) compacted.dir = route.direction;
    if (nonEmptyString(route.originationName)) compacted.o = route.originationName;
    if (nonEmptyString(route.destinationName)) compacted.de = route.destinationName;
    const entire = route.isEntireRouteSection;
    if (typeof entire === 'boolean') compacted.e = entire;
    if (entire !== true) {
      const sequence = Array.isArray(route.routeSectionNaptanEntrySequence) ? route.routeSectionNaptanEntrySequence : [];
      compacted.st = naptanIds(sequence.map((entry) => entry?.stopPoint));
    }
    routes.push(compacted);
  }
  return routes.length > 0 ? routes : undefined;
}

/**
 * Structured fields TfL only populates with ?detail=true. Every key is optional
 * so snapshots recorded before detail was requested serialize identically,
 * which keeps the change-detection dedup and the archive analysis scripts stable.
 */
function compactDisruption(status: TflLineStatus): Partial<LineStatusEntry> {
  const out: Partial<LineStatusEntry> = {};
  const disruption = status.disruption;
  const isRealTime = disruption?.category === REAL_TIME_CATEGORY;
  const validity = compactValidity(status.validityPeriods, !isRealTime);
  if (validity) out.v = validity;
  if (!disruption || typeof disruption !== 'object') return out;
  if (nonEmptyString(disruption.category)) out.c = disruption.category;
  if (nonEmptyString(disruption.closureText)) out.ct = disruption.closureText;
  const routes = compactRoutes(disruption.affectedRoutes);
  if (routes) out.ar = routes;
  if (Array.isArray(disruption.affectedStops)) {
    const stops = naptanIds(disruption.affectedStops);
    if (stops.length > 0) out.as = stops;
  }
  return out;
}

/**
 * Reduces a TfL line-status body (Mode or date-window form) to the compact
 * archived form. Returns null when the body is not the expected array (error
 * payloads, HTML gateways, etc.) — never trust upstream data.
 */
export function compactStatus(body: unknown): LineSnapshot[] | null {
  if (!Array.isArray(body)) return null;
  const lines: LineSnapshot[] = [];
  for (const raw of body as TflLine[]) {
    if (typeof raw?.id !== 'string' || raw.id === '') continue;
    const statuses: LineStatusEntry[] = [];
    for (const status of raw.lineStatuses ?? []) {
      if (typeof status?.statusSeverity !== 'number') continue;
      const entry: LineStatusEntry = {
        s: status.statusSeverity,
        d: typeof status.statusSeverityDescription === 'string' ? status.statusSeverityDescription : '',
      };
      const reason = typeof status.reason === 'string' ? status.reason.trim() : '';
      if (reason !== '') entry.r = reason;
      statuses.push({ ...entry, ...compactDisruption(status) });
    }
    if (statuses.length === 0) continue;
    lines.push({ id: raw.id, st: statuses });
  }
  if (lines.length === 0) return null;
  lines.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return lines;
}
