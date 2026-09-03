// Pure half of the disruptions layer: the /api/disruptions contract, the hop
// index, feature building, the popup, and the view models the Lines tab and
// the station popup read. No maplibre import, so it stays testable in node.
// The map wiring and every paint expression live in disruptions.ts, which
// re-exports this module's public surface.
//
// MIRRORED ALGORITHM (the nr-inference.ts:1-8 convention): the undirected hop
// index built here over `branch.stops` consecutive pairs is the same index the
// backend's LineGraph builds. Divergence fails closed — a section whose hop is
// missing from this index is dropped and counted, never bridged with a
// straight line between two stations.

import type { BranchStop, LineBranches } from '../realtime/types';

// ── payload contract (spec §4; unknown keys are ignored on purpose) ──

export type DisruptionClass = 'closed' | 'severe' | 'minor' | 'info';
/** s structured (TfL ids) · p parsed from prose · f nothing localised. */
export type DisruptionSource = 's' | 'p' | 'f';

export interface DisruptionValidity {
  /** ISO UTC start. */
  f?: string;
  /** ISO UTC end — PlannedWork only; a RealTime period never has one. */
  t?: string;
}

export interface DisruptionSection {
  st?: string[];
  k?: DisruptionClass;
  dir?: string;
}

export interface DisruptionPoint {
  id?: string;
  role?: string;
}

export interface DisruptionItem {
  id?: string;
  l?: string;
  m?: string;
  s?: number;
  d?: string;
  k?: DisruptionClass;
  c?: string;
  n?: number;
  v?: DisruptionValidity[];
  sc?: 'line' | 'section' | 'station';
  src?: DisruptionSource;
  wl?: number;
  sec?: DisruptionSection[];
  pts?: DisruptionPoint[];
  rest?: string;
  r?: string;
}

export interface DisruptionsPayload {
  t?: number;
  w?: string[];
  pf?: number;
  items?: DisruptionItem[];
}

// ── constants ──

/** Older than this and the picture is greyed… */
const STALE_AFTER_MS = 300_000;
/** …older than this and nothing is drawn at all. */
const CLEAR_AFTER_MS = 600_000;
/** A section is a path, so it needs at least one hop. */
const MIN_SECTION_STOPS = 2;
/** A cause pin is honest only for a closure or something at least as bad as
 * severe delays; a Minor-Delays cause is popup text (spec §6.2). */
const CAUSE_PIN_MAX_SEVERITY = 6;
const LONDON_TIME_ZONE = 'Europe/London';

export const CLOSED_COLOR = '#ff4d4d';
export const SEVERE_COLOR = '#f7b04a';
export const MINOR_COLOR = '#ffd84a';
export const INFO_COLOR = '#7fb3ff';
export const HATCH_COLOR = '#0a0a0a';
export const PLANNED_COLOR = '#9aa7ff';
export const STALE_COLOR = '#8a94a0';

const SEVERITY_WORDS: Record<DisruptionClass, string> = {
  closed: '⛔ No service',
  severe: '⚠ Severe delays',
  minor: '⚠ Minor delays',
  info: 'ℹ Information',
};

const REST_WORDS: Record<string, string> = {
  good: 'Good service on the rest of the line',
  minor: 'Minor delays on the rest of the line',
  severe: 'Severe delays on the rest of the line',
};

/** Structured `dir` is i/o/b; the prose words never reach the map in this
 * phase but are mapped so a future flag needs no second table. */
const DIRECTION_WORDS: Record<string, string> = {
  i: 'inbound only',
  o: 'outbound only',
  e: 'eastbound only',
  w: 'westbound only',
  n: 'northbound only',
  s: 'southbound only',
  cw: 'clockwise only',
  acw: 'anticlockwise only',
};

const SOURCE_WORDS: Record<DisruptionSource, string> = {
  s: 'from TfL data',
  p: 'read from the notice',
  f: 'line-wide',
};

/** Does not escape `'` — every attribute is therefore set as a DOM property,
 * never interpolated into a markup string. */
const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);

// ── geometry: the hop index the backend's LineGraph mirrors ──

type Coord = [number, number];

interface Hop {
  readonly coords: readonly Coord[];
  /** NaPTAN id the stored polyline starts at, so a backward hop reverses. */
  readonly from: string;
}

interface LineIndex {
  readonly hops: ReadonlyMap<string, Hop>;
  readonly stops: ReadonlyMap<string, BranchStop>;
}

/** Undirected: one key per unordered pair. */
const hopKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

function buildLineIndex(branches: LineBranches | null | undefined): LineIndex {
  const hops = new Map<string, Hop>();
  const stops = new Map<string, BranchStop>();
  for (const branch of branches?.branches ?? []) {
    const branchStops = branch.stops ?? [];
    for (const stop of branchStops) if (stop?.id && !stops.has(stop.id)) stops.set(stop.id, stop);
    for (let i = 0; i + 1 < branchStops.length; i += 1) {
      const from = branchStops[i];
      const to = branchStops[i + 1];
      const coords = branch.segments?.[i];
      if (!from?.id || !to?.id) continue;
      if (!Array.isArray(coords) || coords.length < MIN_SECTION_STOPS) continue;
      const key = hopKey(from.id, to.id);
      if (!hops.has(key)) hops.set(key, { coords: coords as Coord[], from: from.id });
    }
  }
  return { hops, stops };
}

function geometryFromHops(st: readonly string[], hops: LineIndex['hops']): Coord[][] | null {
  if (st.length < MIN_SECTION_STOPS) return null;
  const parts: Coord[][] = [];
  for (let i = 0; i + 1 < st.length; i += 1) {
    const a = st[i];
    const b = st[i + 1];
    const hop = a && b ? hops.get(hopKey(a, b)) : undefined;
    // Fail closed: a gap is a bake/feed mismatch, and a straight line between
    // two stations would assert track that may not exist.
    if (!hop) return null;
    parts.push(hop.from === a ? [...hop.coords] : [...hop.coords].reverse());
  }
  return parts;
}

/**
 * MultiLineString coordinates for one section's NaPTAN path, each hop oriented
 * along the path, or `null` when any hop is missing from the line's branches.
 */
export function sectionGeometry(
  section: DisruptionSection | null | undefined,
  branches: LineBranches | null | undefined,
): Coord[][] | null {
  return geometryFromHops(section?.st ?? [], buildLineIndex(branches).hops);
}

function sectionHopKeys(st: readonly string[]): string[] {
  const keys: string[] = [];
  for (let i = 0; i + 1 < st.length; i += 1) {
    const a = st[i];
    const b = st[i + 1];
    if (a && b) keys.push(hopKey(a, b));
  }
  return keys;
}

// ── currency: server-anchored, immune to a skewed viewer clock ──

export interface PayloadArrival {
  /** How old the body already was when the server sent it. */
  readonly serverAgeMs: number;
  /** Viewer clock at arrival — only ever used as a difference. */
  readonly receivedAt: number;
}

export type Currency = 'fresh' | 'stale' | 'expired';

/**
 * Age of the payload now. Comparing the viewer clock to the server's `t` would
 * make a client whose clock runs 10 minutes fast draw nothing, ever; this adds
 * elapsed local time (a difference, so skew cancels) to the age the server
 * itself reported.
 */
export function payloadAgeMs(arrival: PayloadArrival, now: number): number {
  return Math.max(0, arrival.serverAgeMs) + Math.max(0, now - arrival.receivedAt);
}

export function currencyOf(ageMs: number): Currency {
  if (ageMs >= CLEAR_AFTER_MS) return 'expired';
  if (ageMs >= STALE_AFTER_MS) return 'stale';
  return 'fresh';
}

/** Server-side age at send time, from the response `Date` header and `t`.
 * Both come from the server's clock, so their difference carries no skew. */
export function serverAgeMs(payloadT: number | undefined, dateHeader: string | null): number {
  if (typeof payloadT !== 'number' || !Number.isFinite(payloadT) || !dateHeader) return 0;
  const sentAt = Date.parse(dateHeader);
  if (!Number.isFinite(sentAt)) return 0;
  return Math.max(0, sentAt - payloadT * 1000);
}

// ── time labels ──

function londonLabel(iso: string | undefined, withDate: boolean): string {
  if (!iso) return '';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const timeOnly: Intl.DateTimeFormatOptions = {
    timeZone: LONDON_TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
  };
  if (!withDate) return at.toLocaleTimeString([], timeOnly);
  return at.toLocaleString([], { ...timeOnly, weekday: 'short', day: 'numeric', month: 'short' });
}

const isPlannedItem = (item: DisruptionItem): boolean => item.c === 'P';

function earliestFrom(item: DisruptionItem): string | undefined {
  return (item.v ?? [])
    .map((period) => period.f)
    .filter((f): f is string => Boolean(f))
    .sort()[0];
}

/**
 * Window words. A RealTime item shows only "since HH:MM": TfL's `toDate` on a
 * RealTime period is a rolling now+2-3 h stamp, so it is never an end time and
 * the backend does not even send it.
 */
function whenLabel(item: DisruptionItem): string {
  if (!isPlannedItem(item)) {
    const from = londonLabel(earliestFrom(item), false);
    return from ? `Since ${from}` : '';
  }
  const period = (item.v ?? []).find((entry) => entry.f);
  const from = londonLabel(period?.f, true);
  const to = londonLabel(period?.t, true);
  if (!from) return 'Planned work';
  return to ? `${from} – ${to}` : from;
}

/** A planned closure whose every window has ended is over: the backend's
 * window opens yesterday, so finished works are still in the payload. */
function isFinishedPlanned(item: DisruptionItem, nowMs: number): boolean {
  if (!isPlannedItem(item)) return false;
  const periods = item.v ?? [];
  if (periods.length === 0) return false;
  return periods.every((period) => {
    const end = period.t ? Date.parse(period.t) : Number.NaN;
    return Number.isFinite(end) && end < nowMs;
  });
}

// ── feature building ──

/** Flat: maplibre JSON-round-trips feature properties, so a nested object
 * would come back out of queryRenderedFeatures as a string. */
export interface BandProps {
  id: string;
  lineId: string;
  lineName: string;
  k: DisruptionClass;
  color: string;
  stale: boolean;
  planned: boolean;
  role: string;
  title: string;
  status: string;
  sections: string;
  cause: string;
  rest: string;
  also: string;
  when: string;
  source: string;
  reason: string;
}

export interface FeatureContext {
  readonly branchesByLine: ReadonlyMap<string, LineBranches>;
  readonly colorByLine: ReadonlyMap<string, string>;
  readonly nameByLine: ReadonlyMap<string, string>;
  /** Server-anchored "now", used for the finished-planned-work rule. */
  readonly nowMs: number;
  readonly stale: boolean;
}

export interface BuiltFeatures {
  readonly live: GeoJSON.Feature[];
  readonly planned: GeoJSON.Feature[];
  readonly liveStations: GeoJSON.Feature[];
  readonly plannedStations: GeoJSON.Feature[];
  readonly sectionsDrawn: number;
  readonly sectionsDroppedMissingHop: number;
}

interface ResolvedSection {
  readonly st: readonly string[];
  readonly k: DisruptionClass;
  readonly dir?: string;
  readonly coords: Coord[][];
}

interface ResolvedItem {
  readonly item: DisruptionItem;
  readonly index: LineIndex;
  readonly sections: readonly ResolvedSection[];
  readonly wholeLine: Coord[][] | null;
  readonly hopKeys: readonly string[];
  readonly planned: boolean;
}

/**
 * Sections this payload allows on the map. `pf: 1` is the only state in which
 * a prose-derived section may draw, and this phase never sets it — an item
 * marked `src: 'p'` under `pf: 0` is treated as line-level.
 */
function drawableSections(item: DisruptionItem, parsedEnabled: boolean): DisruptionSection[] {
  if (item.src === 'p' && !parsedEnabled) return [];
  return item.sec ?? [];
}

function resolveItems(
  payload: DisruptionsPayload,
  ctx: FeatureContext,
): { resolved: ResolvedItem[]; dropped: number } {
  const parsedEnabled = payload.pf === 1;
  const indexByLine = new Map<string, LineIndex>();
  const resolved: ResolvedItem[] = [];
  let dropped = 0;

  for (const item of payload.items ?? []) {
    const lineId = item.l;
    if (!lineId || isFinishedPlanned(item, ctx.nowMs)) continue;
    let index = indexByLine.get(lineId);
    if (!index) {
      index = buildLineIndex(ctx.branchesByLine.get(lineId));
      indexByLine.set(lineId, index);
    }
    const sections: ResolvedSection[] = [];
    const hopKeys: string[] = [];
    for (const section of drawableSections(item, parsedEnabled)) {
      const st = section.st ?? [];
      const coords = geometryFromHops(st, index.hops);
      if (!coords) {
        dropped += 1; // silently: a gap is never bridged
        continue;
      }
      sections.push({ st, k: section.k ?? item.k ?? 'info', dir: section.dir, coords });
      hopKeys.push(...sectionHopKeys(st));
    }
    // A whole-line closure hatches every hop of the line; no geometry is sent.
    const wholeLine = item.wl === 1 ? [...index.hops.values()].map((hop) => [...hop.coords]) : null;
    if (wholeLine) hopKeys.push(...index.hops.keys());
    resolved.push({ item, index, sections, wholeLine, hopKeys, planned: isPlannedItem(item) });
  }
  return { resolved, dropped };
}

/** Other lines whose branches share a hop this item draws and that have no
 * item of their own on it — "not reported affected". */
function coCorridorLines(
  target: ResolvedItem,
  all: readonly ResolvedItem[],
  ctx: FeatureContext,
): string[] {
  if (target.hopKeys.length === 0) return [];
  const claimed = new Set<string>();
  for (const other of all) {
    if (other.item.l === target.item.l) continue;
    for (const key of other.hopKeys) claimed.add(`${other.item.l}${key}`);
  }
  const names: string[] = [];
  for (const [lineId, branches] of ctx.branchesByLine) {
    if (lineId === target.item.l) continue;
    const { hops } = buildLineIndex(branches);
    const shares = target.hopKeys.some((key) => hops.has(key) && !claimed.has(`${lineId}${key}`));
    if (shares) names.push(ctx.nameByLine.get(lineId) ?? lineId);
  }
  return names.sort((a, b) => a.localeCompare(b));
}

function sectionLabel(section: ResolvedSection, index: LineIndex): string {
  const name = (id: string | undefined): string =>
    (id ? index.stops.get(id)?.name : undefined) ?? id ?? '';
  const base = `${name(section.st[0])} ↔ ${name(section.st[section.st.length - 1])}`;
  const dir = section.dir ? DIRECTION_WORDS[section.dir] : undefined;
  return dir ? `${base} · ${dir}` : base;
}

function bandProps(resolved: ResolvedItem, also: readonly string[], ctx: FeatureContext): BandProps {
  const { item, index } = resolved;
  const lineId = item.l ?? '';
  const k = item.k ?? 'info';
  const causeNames = (item.pts ?? [])
    .filter((point) => point.role === 'cause' && point.id)
    .map((point) => index.stops.get(point.id ?? '')?.name ?? point.id ?? '');
  return {
    id: item.id ?? '',
    lineId,
    lineName: ctx.nameByLine.get(lineId) ?? lineId,
    k,
    color: ctx.colorByLine.get(lineId) ?? STALE_COLOR,
    stale: ctx.stale,
    planned: resolved.planned,
    role: 'band',
    title: SEVERITY_WORDS[k],
    status: item.d ?? '',
    sections: resolved.sections.map((section) => sectionLabel(section, index)).join('\n'),
    cause: causeNames.length > 0 ? `Reported at ${causeNames.join(', ')}` : '',
    rest: item.rest ? (REST_WORDS[item.rest] ?? '') : '',
    also: also.join(', '),
    when: whenLabel(item),
    source: SOURCE_WORDS[item.src ?? 'f'],
    reason: item.r ?? '',
  };
}

function ringFeatures(resolved: ResolvedItem, props: BandProps): GeoJSON.Feature[] {
  const { item, index } = resolved;
  const features: GeoJSON.Feature[] = [];
  const seen = new Set<string>();
  const add = (id: string | undefined, role: string): void => {
    if (!id || seen.has(id)) return;
    const stop = index.stops.get(id);
    if (!stop) return;
    seen.add(id);
    features.push({
      type: 'Feature',
      properties: { ...props, role },
      geometry: { type: 'Point', coordinates: [stop.lon, stop.lat] },
    });
  };
  for (const section of resolved.sections) {
    // Endpoint rings only for a section that is actually drawn.
    add(section.st[0], 'end');
    add(section.st[section.st.length - 1], 'end');
    if (section.k !== 'closed') continue;
    for (const id of section.st.slice(1, -1)) add(id, 'mid');
  }
  const severity = item.s ?? Number.POSITIVE_INFINITY;
  const pinnable = item.k === 'closed' || severity <= CAUSE_PIN_MAX_SEVERITY;
  for (const point of item.pts ?? []) {
    if (point.role === 'affected') add(point.id, 'affected');
    if (point.role === 'cause' && pinnable) add(point.id, 'cause');
  }
  return features;
}

/** Splits the payload into the four sources. Line-scope items contribute no
 * feature at all — that is the whole point of the phase. */
export function toFeatures(payload: DisruptionsPayload, ctx: FeatureContext): BuiltFeatures {
  const { resolved, dropped } = resolveItems(payload, ctx);
  const live: GeoJSON.Feature[] = [];
  const planned: GeoJSON.Feature[] = [];
  const liveStations: GeoJSON.Feature[] = [];
  const plannedStations: GeoJSON.Feature[] = [];
  let sectionsDrawn = 0;

  for (const entry of resolved) {
    const props = bandProps(entry, coCorridorLines(entry, resolved, ctx), ctx);
    const bands = entry.planned ? planned : live;
    const rings = entry.planned ? plannedStations : liveStations;
    for (const section of entry.sections) {
      sectionsDrawn += 1;
      bands.push({
        type: 'Feature',
        properties: { ...props, k: section.k },
        geometry: { type: 'MultiLineString', coordinates: section.coords },
      });
    }
    if (entry.wholeLine && entry.wholeLine.length > 0) {
      bands.push({
        type: 'Feature',
        properties: { ...props },
        geometry: { type: 'MultiLineString', coordinates: entry.wholeLine },
      });
    }
    rings.push(...ringFeatures(entry, props));
  }
  return {
    live,
    planned,
    liveStations,
    plannedStations,
    sectionsDrawn,
    sectionsDroppedMissingHop: dropped,
  };
}

// ── popup ──

const textLine = (text: string, className?: string): string =>
  text ? `<div${className ? ` class="${className}"` : ''}>${esc(text)}</div>` : '';

export function disruptionPopupHtml(props: BandProps): string {
  const badge = props.planned
    ? '<span class="dz-badge dz-planned">PLANNED</span>'
    : '<span class="dz-badge dz-live">LIVE</span>';
  const chip = `<span class="vp-line" style="background:${esc(props.color)}">${esc(props.lineName)}</span>`;
  const sections = props.sections
    .split('\n')
    .filter(Boolean)
    .map((text) => textLine(text))
    .join('');
  const also = props.also
    ? textLine(`Also on this track: ${props.also} (not reported affected)`, 'vp-dim')
    : '';
  return `<div class="vp"><div class="sp-title">${esc(props.title)} ${badge}</div>
    <div>${chip}</div>
    ${textLine(props.status, 'vp-dim')}
    ${sections}
    ${textLine(props.cause)}
    ${textLine(props.rest)}
    ${also}
    ${textLine(props.when, 'vp-status')}
    ${textLine(props.reason, 'vp-reason')}
    ${textLine(`Section ${props.source}${props.stale ? ' · status may be stale' : ''}`, 'vp-dim')}</div>`;
}

// ── shared state for the Lines tab, the legend pips and the station popup ──

export interface Snapshot {
  readonly items: readonly DisruptionItem[];
  readonly names: ReadonlyMap<string, string>;
  readonly colors: ReadonlyMap<string, string>;
  readonly expired: boolean;
}

export const EMPTY_SNAPSHOT: Snapshot = {
  items: [],
  names: new Map(),
  colors: new Map(),
  expired: true,
};

let snapshot: Snapshot = EMPTY_SNAPSHOT;
const updateListeners = new Set<() => void>();

const stats = {
  polls: 0,
  items: 0,
  sectionsDrawn: 0,
  sectionsDroppedMissingHop: 0,
  staleCleared: 0,
  lastPayloadAt: 0,
};

/** Live counters for acceptance tooling (spec §6.4). */
export function disruptionsStats(): typeof stats {
  return stats;
}

/** Subscribe to every rebuild (legend pips, Lines-tab strip). */
export function onDisruptionsUpdate(cb: () => void): void {
  updateListeners.add(cb);
}

/** Called by the layer after each rebuild; the only writer of the snapshot. */
export function publishSnapshot(next: Snapshot): void {
  snapshot = next;
  for (const cb of updateListeners) cb();
}

/** True while there is no payload young enough to stand behind. */
export function disruptionsExpired(): boolean {
  return snapshot.expired;
}

/** Items that touch this station: a section through it, or one of its points. */
export function disruptionsForStation(naptanId: string): DisruptionItem[] {
  if (!naptanId || snapshot.expired) return [];
  return snapshot.items.filter(
    (item) =>
      (item.sec ?? []).some((section) => (section.st ?? []).includes(naptanId)) ||
      (item.pts ?? []).some((point) => point.id === naptanId),
  );
}

export interface StationNoticeLine {
  readonly headline: string;
  readonly reason: string;
}

/** One plain-text notice per item at this station. Plain text on purpose: the
 * station popup escapes and truncates it with its own helpers. */
export function stationDisruptionLines(naptanId: string): StationNoticeLine[] {
  return disruptionsForStation(naptanId).map((item) => ({
    headline: `${SEVERITY_WORDS[item.k ?? 'info']} · ${snapshot.names.get(item.l ?? '') ?? item.l ?? ''}`,
    reason: item.r ?? '',
  }));
}

export interface ServiceRow {
  readonly lineId: string;
  readonly lineName: string;
  readonly color: string;
  readonly text: string;
  readonly when: string;
  readonly reason: string;
}

/** Line-scope items only — the ones that deliberately draw nothing, and would
 * otherwise be invisible on a phone. */
export function serviceStripRows(): ServiceRow[] {
  if (snapshot.expired) return [];
  return snapshot.items
    .filter((item) => item.sc === 'line' && item.wl !== 1)
    .map((item) => {
      const lineId = item.l ?? '';
      return {
        lineId,
        lineName: snapshot.names.get(lineId) ?? lineId,
        color: snapshot.colors.get(lineId) ?? STALE_COLOR,
        text: item.d ?? SEVERITY_WORDS[item.k ?? 'info'],
        when: isPlannedItem(item) ? 'PLANNED' : whenLabel(item),
        reason: item.r ?? '',
      };
    });
}

const CLASS_RANK: Record<DisruptionClass, number> = { closed: 3, severe: 2, minor: 1, info: 0 };

export function classColor(k: DisruptionClass): string {
  if (k === 'closed') return CLOSED_COLOR;
  if (k === 'severe') return SEVERE_COLOR;
  if (k === 'minor') return MINOR_COLOR;
  return INFO_COLOR;
}

/** Pip colour + title for one line row, or null when the line is unaffected. */
export function linePip(lineId: string): { color: string; title: string } | null {
  if (snapshot.expired) return null;
  const items = snapshot.items.filter((item) => item.l === lineId);
  if (items.length === 0) return null;
  const worst = items.reduce((a, b) =>
    CLASS_RANK[b.k ?? 'info'] > CLASS_RANK[a.k ?? 'info'] ? b : a,
  );
  return {
    color: items.every(isPlannedItem) ? PLANNED_COLOR : classColor(worst.k ?? 'info'),
    title: items
      .map((item) => item.d ?? '')
      .filter(Boolean)
      .join(' · '),
  };
}
