// ATCO bus-stop id -> coordinate, name and serving routes.
//
// `/StopPoint/Mode/bus/Disruption` names every closed stop by `atcoCode` and
// nothing else: no position, no routes (docs/DISRUPTION_GEOLOCATION_SPEC.md:444,
// open question 10 at :552). Nothing else in the repo can close that gap —
// `scripts/fetch-bus-prior.mjs:250-260` sees `<AtcoCode>` beside its Easting /
// Northing and throws the id away at :316-320.
//
// The owner's decision is resolve-on-demand, cache permanently: never a 19,000
// stop bulk bake, just the ids a closure actually mentions, resolved once
// through `GET /StopPoint/{ids}` and kept forever, because a stop's position
// never changes.
//
// Two things make the walk non-obvious:
//   * asking for a POLE id ("490006655CG") answers with its PAIR
//     ("490G00006655", stopType NaptanOnstreetBusCoachStopPair) and hides the
//     pole in `children[]`. Only the pole carries the right side of the road
//     and the "Towards" direction, so the exact node always wins and a pair
//     centroid is recorded as such rather than passed off as a pole.
//   * `lines[]` is the ONLY place the serving routes appear. TfL's closure rows
//     carry no route at all, so "the closures on the route you searched" has no
//     join key unless it is captured here. Names are stored verbatim: TfL spells
//     them lower-case ("n1", "el1"), BODS and the learned files upper-case, and
//     "032" (a coach) is a different route from "32".
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Measured 2026-09-03: 20 ids per URL answer 200, 25 answer HTTP 400. */
export const STOPPOINT_BATCH_MAX = 20;

/** Gap between batches, so a long resolve never arrives as one burst. */
export const BATCH_GAP_MS = 500;

/** `additionalProperties` key holding the direction a pole serves. */
const TOWARDS_KEY = 'Towards';

/** TfL writes 0,0 for "position unknown"; the Gulf of Guinea has no bus stops. */
const NULL_ISLAND_EPSILON = 1e-9;

/** How much of an oversized upstream message to keep in a reason string. */
const MAX_REASON_CHARS = 120;

/** Which node the coordinate came from: the pole itself, or its stop pair. */
export type MatchKind = 'exact' | 'parent';

export interface BusStop {
  /** The requested ATCO id, always — never the pair id it resolved through. */
  readonly id: string;
  readonly name: string;
  readonly lat: number;
  readonly lon: number;
  /** `lines[].name` verbatim (falling back to `lines[].id`); never normalised. */
  readonly routes: readonly string[];
  readonly match: MatchKind;
  /** The pole's "Towards" destination, when TfL states one. */
  readonly towards?: string;
}

/** The shape `tfl-client.fetchStopPoints` returns; kept structural for stubs. */
export interface StopPointResponse {
  readonly status: number;
  readonly body: unknown;
}

export interface GazetteerDeps {
  /** Injected so tests never touch the network. */
  readonly fetchStopPoints: (ids: readonly string[]) => Promise<StopPointResponse>;
  readonly log: (message: string) => void;
  /** Ids already known; a hit is never re-fetched. */
  readonly cached?: ReadonlyMap<string, BusStop>;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface ResolveStats {
  /** Distinct ids asked for. */
  readonly requested: number;
  readonly fromCache: number;
  /** Newly resolved through the network this run. */
  readonly fetched: number;
  /** Coordinate read off the requested pole itself. */
  readonly exact: number;
  /** Coordinate read off the stop pair because the pole was absent. */
  readonly parent: number;
  readonly withRoutes: number;
  readonly upstreamCalls: number;
  readonly failedBatches: number;
}

export interface ResolveResult {
  readonly resolved: Map<string, BusStop>;
  readonly unresolved: string[];
  /** Why each unresolved id was dropped — no id is ever lost silently. */
  readonly reasons: ReadonlyMap<string, string>;
  readonly stats: ResolveStats;
}

type RawNode = Record<string, unknown>;

interface Position {
  readonly lat: number;
  readonly lon: number;
}

interface NodeIndex {
  /** Every node in the returned forest, by its own id. */
  readonly byId: ReadonlyMap<string, RawNode>;
  /** Child id -> the node it hangs under. */
  readonly parentOf: ReadonlyMap<string, RawNode>;
  /** Id -> the node to use when the id has no positioned node of its own. */
  readonly fallbackOf: ReadonlyMap<string, RawNode>;
}

type Pick = { ok: true; stop: BusStop } | { ok: false; reason: string };

interface Counters {
  fetched: number;
  exact: number;
  parent: number;
  withRoutes: number;
  upstreamCalls: number;
  failedBatches: number;
}

/**
 * Resolve ATCO ids to positioned stops, batching at STOPPOINT_BATCH_MAX,
 * skipping anything already cached, and degrading a rejected batch into
 * halves (down to single lookups) so one bad id never costs the other 19.
 */
export async function resolveStops(
  ids: readonly string[],
  deps: GazetteerDeps,
): Promise<ResolveResult> {
  const wanted = distinct(ids);
  const cached = deps.cached ?? new Map<string, BusStop>();
  const resolved = new Map<string, BusStop>();
  for (const id of wanted) {
    const hit = cached.get(id);
    if (hit) resolved.set(id, hit);
  }

  const missing = wanted.filter((id) => !resolved.has(id));
  const reasons = new Map<string, string>();
  const counters = newCounters();

  const batches = chunk(missing, STOPPOINT_BATCH_MAX);
  for (const [index, batch] of batches.entries()) {
    if (index > 0) await pause(deps);
    await resolveBatch(batch, deps, resolved, reasons, counters);
  }

  const unresolved = wanted.filter((id) => !resolved.has(id));
  for (const id of unresolved) {
    if (!reasons.has(id)) reasons.set(id, 'not attempted');
  }

  return {
    resolved,
    unresolved,
    reasons,
    stats: { ...counters, requested: wanted.length, fromCache: wanted.length - missing.length },
  };
}

function newCounters(): Counters {
  return { fetched: 0, exact: 0, parent: 0, withRoutes: 0, upstreamCalls: 0, failedBatches: 0 };
}

/** One upstream call; on failure, split and retry rather than drop the batch. */
async function resolveBatch(
  batch: readonly string[],
  deps: GazetteerDeps,
  resolved: Map<string, BusStop>,
  reasons: Map<string, string>,
  counters: Counters,
): Promise<void> {
  if (batch.length === 0) return;

  counters.upstreamCalls += 1;
  let nodes: RawNode[];
  try {
    const response = await deps.fetchStopPoints(batch);
    if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
    nodes = toNodes(response.body);
  } catch (error) {
    counters.failedBatches += 1;
    await degrade(batch, describe(error), deps, resolved, reasons, counters);
    return;
  }

  const index = indexNodes(nodes);
  for (const id of batch) {
    const picked = resolveOne(index, id);
    if (!picked.ok) {
      reasons.set(id, picked.reason);
      deps.log(`bus-gazetteer: ${id} unresolved — ${picked.reason}`);
      continue;
    }
    resolved.set(id, picked.stop);
    counters.fetched += 1;
    if (picked.stop.match === 'exact') counters.exact += 1;
    else counters.parent += 1;
    if (picked.stop.routes.length > 0) counters.withRoutes += 1;
  }
}

/** Halve a rejected batch; a single id that still fails is recorded and named. */
async function degrade(
  batch: readonly string[],
  reason: string,
  deps: GazetteerDeps,
  resolved: Map<string, BusStop>,
  reasons: Map<string, string>,
  counters: Counters,
): Promise<void> {
  const single = batch.length === 1 ? batch[0] : undefined;
  if (single) {
    const why = `upstream failed: ${reason}`;
    reasons.set(single, why);
    deps.log(`bus-gazetteer: ${single} unresolved — ${why}`);
    return;
  }

  deps.log(`bus-gazetteer: batch of ${batch.length} failed (${reason}) — splitting`);
  const mid = Math.ceil(batch.length / 2);
  await resolveBatch(batch.slice(0, mid), deps, resolved, reasons, counters);
  await pause(deps);
  await resolveBatch(batch.slice(mid), deps, resolved, reasons, counters);
}

/** The node to trust for one requested id, or why there is none. */
function resolveOne(index: NodeIndex, id: string): Pick {
  const exact = index.byId.get(id);
  const fallback = index.fallbackOf.get(id);
  if (!exact && !fallback) return { ok: false, reason: 'absent from the StopPoint response' };

  // Only the pole itself has the right side of the road and its direction.
  const exactAt = exact ? positionOf(exact) : null;
  if (exact && exactAt) {
    return { ok: true, stop: buildStop(id, exact, exactAt, index.parentOf.get(id), 'exact') };
  }

  const fallbackAt = fallback ? positionOf(fallback) : null;
  if (fallback && fallbackAt) {
    return { ok: true, stop: buildStop(id, fallback, fallbackAt, undefined, 'parent') };
  }

  return { ok: false, reason: 'no usable coordinate on the stop or its pair' };
}

function buildStop(
  id: string,
  node: RawNode,
  at: Position,
  parent: RawNode | undefined,
  match: MatchKind,
): BusStop {
  const own = readRoutes(node);
  // A pole with an empty `lines[]` would lose the only join key a later wave
  // has, so it inherits the pair's list rather than shipping nothing.
  const routes = own.length > 0 || !parent ? own : readRoutes(parent);
  const name = readName(node) ?? (parent ? readName(parent) : null) ?? id;
  const stop: BusStop = { id, name, lat: at.lat, lon: at.lon, routes, match };
  const towards = readTowards(node);
  return towards ? { ...stop, towards } : stop;
}

/** Index the returned forest: own ids, tree parents, and `lineGroup` claims. */
function indexNodes(roots: readonly RawNode[]): NodeIndex {
  const byId = new Map<string, RawNode>();
  const parentOf = new Map<string, RawNode>();
  const fallbackOf = new Map<string, RawNode>();

  const walk = (node: RawNode, parent: RawNode | null): void => {
    const id = readId(node);
    if (id && !byId.has(id)) byId.set(id, node);
    if (id && parent && !parentOf.has(id)) parentOf.set(id, parent);
    for (const claimed of readClaims(node)) {
      if (!fallbackOf.has(claimed)) fallbackOf.set(claimed, node);
    }
    for (const child of readChildren(node)) walk(child, node);
  };
  for (const root of roots) walk(root, null);

  // A real tree parent beats a `lineGroup` claim wherever both exist.
  for (const [id, parent] of parentOf) fallbackOf.set(id, parent);
  return { byId, parentOf, fallbackOf };
}

/** Load the permanent cache. Missing file means empty; a broken one throws. */
export async function loadCache(path: string): Promise<Map<string, BusStop>> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (isNotFound(error)) return new Map();
    throw new Error(`bus-stop gazetteer cache ${path} unreadable: ${describe(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`bus-stop gazetteer cache ${path} is not JSON: ${describe(error)}`);
  }

  const record = asRecord(parsed);
  if (!record) throw new Error(`bus-stop gazetteer cache ${path} is not a JSON object`);

  const stops = new Map<string, BusStop>();
  for (const [id, value] of Object.entries(record)) stops.set(id, toCachedStop(path, id, value));
  return stops;
}

/** Write the cache as a plain JSON object, tmp + rename so no reader tears. */
export async function saveCache(path: string, stops: ReadonlyMap<string, BusStop>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const sorted = [...stops.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const tmpPath = `${path}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(Object.fromEntries(sorted))}\n`, 'utf8');
  await rename(tmpPath, path);
}

function toCachedStop(path: string, id: string, value: unknown): BusStop {
  const record = asRecord(value);
  const lat = record ? readNumber(record['lat']) : null;
  const lon = record ? readNumber(record['lon']) : null;
  const routes = record ? readStrings(record['routes']) : null;
  if (!record || lat === null || lon === null || !routes) {
    throw new Error(`bus-stop gazetteer cache ${path}: entry ${id} is malformed`);
  }
  const name = typeof record['name'] === 'string' ? record['name'] : id;
  const match: MatchKind = record['match'] === 'parent' ? 'parent' : 'exact';
  const stop: BusStop = { id, name, lat, lon, routes, match };
  const towards = record['towards'];
  return typeof towards === 'string' && towards.length > 0 ? { ...stop, towards } : stop;
}

function toNodes(body: unknown): RawNode[] {
  if (Array.isArray(body)) return body.map(asRecord).filter((node): node is RawNode => !!node);
  const single = asRecord(body);
  return single ? [single] : [];
}

function readId(node: RawNode): string | null {
  return readText(node['id']) ?? readText(node['naptanId']);
}

function readName(node: RawNode): string | null {
  return readText(node['commonName']);
}

function readChildren(node: RawNode): RawNode[] {
  const children = node['children'];
  return Array.isArray(children)
    ? children.map(asRecord).filter((child): child is RawNode => !!child)
    : [];
}

/** Pole ids a pair node speaks for, even when `children[]` is empty. */
function readClaims(node: RawNode): string[] {
  const groups = node['lineGroup'];
  if (!Array.isArray(groups)) return [];
  const claims: string[] = [];
  for (const entry of groups) {
    const group = asRecord(entry);
    const ref = group ? readText(group['naptanIdReference']) : null;
    if (ref) claims.push(ref);
  }
  return claims;
}

/** `lines[].name`, falling back to `lines[].id`. Casing is never touched. */
function readRoutes(node: RawNode): string[] {
  const lines = node['lines'];
  if (!Array.isArray(lines)) return [];
  const routes: string[] = [];
  for (const entry of lines) {
    const record = asRecord(entry);
    if (!record) continue;
    const name = readText(record['name']) ?? readText(record['id']);
    if (name && !routes.includes(name)) routes.push(name);
  }
  return routes;
}

function readTowards(node: RawNode): string | null {
  const properties = node['additionalProperties'];
  if (!Array.isArray(properties)) return null;
  for (const entry of properties) {
    const record = asRecord(entry);
    if (!record || record['key'] !== TOWARDS_KEY) continue;
    const value = readText(record['value']);
    if (value) return value;
  }
  return null;
}

function positionOf(node: RawNode): Position | null {
  const lat = readNumber(node['lat']);
  const lon = readNumber(node['lon']);
  if (lat === null || lon === null) return null;
  const atNullIsland =
    Math.abs(lat) <= NULL_ISLAND_EPSILON && Math.abs(lon) <= NULL_ISLAND_EPSILON;
  return atNullIsland ? null : { lat, lon };
}

function asRecord(value: unknown): RawNode | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as RawNode)
    : null;
}

function readText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readStrings(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const strings = value.filter((entry): entry is string => typeof entry === 'string');
  return strings.length === value.length ? strings : null;
}

function isNotFound(error: unknown): boolean {
  return asRecord(error)?.['code'] === 'ENOENT';
}

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, MAX_REASON_CHARS);
}

function distinct(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function chunk(ids: readonly string[], size: number): string[][] {
  const batches: string[][] = [];
  for (let start = 0; start < ids.length; start += size) {
    batches.push(ids.slice(start, start + size));
  }
  return batches;
}

async function pause(deps: GazetteerDeps): Promise<void> {
  if (deps.sleep) {
    await deps.sleep(BATCH_GAP_MS);
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, BATCH_GAP_MS));
}
