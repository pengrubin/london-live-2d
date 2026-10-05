// Which routes make up a coverage corridor — the data behind the Bus Flow
// tap-to-inspect popup ("~120 journeys/day: 88 · 31/day, N88 · 12/day, …").
//
// Per-piece membership is the expensive thing the corridor merge already
// refused once: ~440k per-piece Sets cost ~800 MB RSS (see the piece-store
// note in coverage-writer.ts). So contributors live in FIXED SLOTS instead —
// CONTRIBUTOR_SLOTS per piece in two parallel typed arrays plus a fill count:
//   ~440k pieces → capacity doubles to 2^19 = 524 288 slots-rows
//   × 8 slots × (4 B Int32 route + 4 B Float32 journeys) + 1 B count
//   ≈ 34 MB of typed arrays, transient (one build, then garbage).
// That buys the top 8 per piece, which is all the popup lists anyway.
//
// The wire form (`r` on each feature) is one string, not an array of tuples:
//   "88 o:31;N88 i:12;700 c:1"
// token = `${line} ${dirCode}:${journeysPerDay}`, tokens joined by ';'.
// Unambiguous because line names are sanitized learner keys
// ([A-Za-z0-9_.-] only — no space, ':' or ';'), and the direction code is a
// single lowercase letter. Keys that do not have the OPERATOR_LINE_DIR shape
// (tests, future feeds) emit the bare name with no direction: "R0:20".
// A JSON array of arrays would cost ~8 extra bytes per token in brackets and
// quotes across ~20k features, which is exactly the growth budget.
//
// Journeys are INTEGERS, and a route that rounds to 0/day is dropped. Measured
// on the 2026-10-01 local artifact (22k features, 2.2 tokens each) at the
// brotli q4 the server actually sends: one-decimal values cost +21.6% over
// the r-less artifact, integers +19.2%. Number entropy, not names, is what
// the budget pays for; dropping the direction code saved under 1 point and
// would lose the inbound/outbound split, so it stays.

/** Slots per piece. The popup lists at most this many routes. */
export const CONTRIBUTOR_SLOTS = 8;

export interface ContributorSlots {
  /** Filled slots per piece, 0..CONTRIBUTOR_SLOTS. */
  count: Uint8Array;
  /** Route index per slot, piece-major: piece * SLOTS + slot. */
  route: Int32Array;
  /** That route's journeys/day mean per slot. Float32 is ample: the values
   * are day-averaged counts shown rounded to integers. */
  journeys: Float32Array;
}

export function makeContributorSlots(pieceCapacity: number): ContributorSlots {
  return {
    count: new Uint8Array(pieceCapacity),
    route: new Int32Array(pieceCapacity * CONTRIBUTOR_SLOTS),
    journeys: new Float32Array(pieceCapacity * CONTRIBUTOR_SLOTS),
  };
}

/** A copy sized for `pieceCapacity` pieces, carrying every existing slot.
 * Returns a new object; the caller swaps it into its (build-local) store. */
export function growContributorSlots(
  slots: ContributorSlots,
  pieceCapacity: number,
): ContributorSlots {
  const next = makeContributorSlots(pieceCapacity);
  next.count.set(slots.count);
  next.route.set(slots.route);
  next.journeys.set(slots.journeys);
  return next;
}

/**
 * Record that `routeIdx` contributes `journeys` to `piece`. While slots are
 * free it takes the next one; once full it evicts the smallest-journeys slot,
 * and only when the newcomer is strictly larger.
 *
 * Routes are walked busiest-first, so in the real build the first 8 arrivals
 * already ARE the top 8 and the eviction branch never fires. It stays because
 * that ordering is a property of the caller, not of this structure: a future
 * caller (or a tie-break change) feeding routes in another order must still
 * end up with the top 8, not the first 8.
 *
 * Callers guarantee one add per (piece, route) — the walk's lastRoute guard
 * does — so no duplicate scan is spent here. Mutates the typed arrays in
 * place: they are build-local scratch and copying per add would be absurd.
 */
export function addContributor(
  slots: ContributorSlots,
  piece: number,
  routeIdx: number,
  journeys: number,
): void {
  const base = piece * CONTRIBUTOR_SLOTS;
  const filled = slots.count[piece] ?? 0;
  if (filled < CONTRIBUTOR_SLOTS) {
    slots.route[base + filled] = routeIdx;
    slots.journeys[base + filled] = journeys;
    slots.count[piece] = filled + 1;
    return;
  }
  let minSlot = 0;
  let minJourneys = Infinity;
  for (let s = 0; s < CONTRIBUTOR_SLOTS; s += 1) {
    const j = slots.journeys[base + s] ?? 0;
    if (j < minJourneys) {
      minJourneys = j;
      minSlot = s;
    }
  }
  if (journeys > minJourneys) {
    slots.route[base + minSlot] = routeIdx;
    slots.journeys[base + minSlot] = journeys;
  }
}

/**
 * Union of a run's piece slots: per route, the sum of its journeys over the
 * run's pieces divided by the run LENGTH — a per-point mean on the same
 * footing as the feature's `j` (a route covering half the run counts half).
 * Sorted busiest-first (route index breaks ties, so output is deterministic)
 * and cut to CONTRIBUTOR_SLOTS. Allocates one Map per run; runs number in
 * the tens of thousands per daily build, not per frame.
 */
export function unionContributors(
  slots: ContributorSlots,
  run: readonly number[],
): Array<[routeIdx: number, journeysPerDay: number]> {
  if (run.length === 0) return [];
  const sums = new Map<number, number>();
  for (const piece of run) {
    const base = piece * CONTRIBUTOR_SLOTS;
    const filled = slots.count[piece] ?? 0;
    for (let s = 0; s < filled; s += 1) {
      const route = slots.route[base + s] ?? 0;
      sums.set(route, (sums.get(route) ?? 0) + (slots.journeys[base + s] ?? 0));
    }
  }
  return [...sums]
    .map(([route, sum]): [number, number] => [route, sum / run.length])
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, CONTRIBUTOR_SLOTS);
}

/**
 * Learned-route key → the display token prefix "line dirCode".
 *
 * Keys are the learner's sanitized `OPERATOR_LINE_DIRECTION`
 * (`TFLO_88_outbound`, `TMSB_17A_anticlockwise`). The line is everything
 * between the first and last underscore — lines themselves may contain one
 * (`GOCH_Cross_Bus_DRT_outbound`) but operators (NOC codes) and directions
 * never do. That middle part is the BODS PublishedLineName, i.e. the same
 * name space the Filter tab searches ("88", "N88", "025" ≠ "25"). The
 * direction is reduced to its first letter: every direction pair seen in the
 * learned index (inbound/outbound, clockwise/anticlockwise,
 * eastbound/westbound) differs in it.
 */
export function routeLabel(key: string): string {
  const first = key.indexOf('_');
  const last = key.lastIndexOf('_');
  if (first <= 0 || last <= first + 1 || last === key.length - 1) return key;
  const line = key.slice(first + 1, last);
  const dirCode = key.charAt(last + 1).toLowerCase();
  return `${line} ${dirCode}`;
}

/** Serialise `[label, journeysPerDay]` pairs (already sorted) into the `r`
 * string. Values are rounded to whole journeys/day (see the size note at the
 * top); entries that round to 0 are dropped — the popup says so when that
 * leaves a quiet road with no listed route. */
export function encodeContributors(
  entries: ReadonlyArray<readonly [label: string, journeysPerDay: number]>,
): string {
  const tokens: string[] = [];
  for (const [label, journeys] of entries) {
    const rounded = Math.round(journeys);
    if (rounded > 0) tokens.push(`${label}:${rounded}`);
  }
  return tokens.join(';');
}

export interface Contributor {
  /** PublishedLineName, e.g. "88", "N88". */
  line: string;
  /** One-letter direction code ('i', 'o', 'c', 'a', …) or '' when unknown. */
  dir: string;
  journeysPerDay: number;
}

/**
 * Parse an `r` string back into contributors. Tolerant: a malformed token is
 * skipped rather than failing the whole popup.
 *
 * COPY in frontend/src/layers/coverage-popup.ts — keep the two in sync
 * (frontend and backend share no package; see CLAUDE.md "copied shared files").
 */
export function parseContributors(encoded: string): Contributor[] {
  const out: Contributor[] = [];
  if (encoded === '') return out;
  for (const token of encoded.split(';')) {
    const colon = token.lastIndexOf(':');
    if (colon <= 0) continue;
    const text = token.slice(colon + 1);
    const journeysPerDay = Number(text);
    if (text === '' || !Number.isFinite(journeysPerDay)) continue;
    const head = token.slice(0, colon);
    const space = head.lastIndexOf(' ');
    const line = space === -1 ? head : head.slice(0, space);
    const dir = space === -1 ? '' : head.slice(space + 1);
    if (line === '') continue;
    out.push({ line, dir, journeysPerDay });
  }
  return out;
}
