// Tap-to-inspect card for the Bus Flow (coverage) overlay. Pure string
// building, no maplibre import, so it is unit-testable and coverage.ts only
// has to wire the click.
//
// Each corridor feature carries j (total journeys/day, a run MEAN — hence
// "~j"), b (bucket) and r, the top contributing routes as
// "88 o:31;N88 i:12" (line, one-letter direction code, journeys/day).

/** Matches backend CONTRIBUTOR_SLOTS: at most this many tokens per feature. */
const CONTRIBUTOR_SLOTS = 8;

/** Direction codes are the first letter of the learner's direction word;
 * every pair in the learned index differs in it. */
const DIRECTION_WORDS: Record<string, string> = {
  i: 'inbound',
  o: 'outbound',
  c: 'clockwise',
  a: 'anticlockwise',
  n: 'northbound',
  s: 'southbound',
  e: 'eastbound',
  w: 'westbound',
};

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);

export interface Contributor {
  /** PublishedLineName, e.g. "88", "N88" — the Filter tab's name space. */
  line: string;
  /** One-letter direction code ('i', 'o', 'c', 'a', …) or '' when unknown. */
  dir: string;
  journeysPerDay: number;
}

/**
 * Parse an `r` string. Tolerant: a malformed token is skipped rather than
 * failing the whole popup.
 *
 * COPY of parseContributors in backend/src/coverage-contributors.ts (which
 * also documents the format and owns the encoder) — keep the two in sync;
 * frontend and backend share no package.
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

export interface ContributorRow {
  line: string;
  /** Summed over directions AND operators running this line name here. */
  journeysPerDay: number;
  /** Per-direction totals, busiest first — only when more than one direction
   * of the line is listed; empty otherwise (one-way-here routes need no
   * direction word: the headline already says "both directions"). */
  byDir: Array<[dir: string, journeysPerDay: number]>;
}

/** One row per line name, busiest first (numeric-aware tiebreak, the
 * listActiveBusLines idiom, so "9" sorts before "10"). */
export function groupContributors(list: readonly Contributor[]): ContributorRow[] {
  const byLine = new Map<string, Map<string, number>>();
  for (const { line, dir, journeysPerDay } of list) {
    const dirs = byLine.get(line) ?? new Map<string, number>();
    dirs.set(dir, (dirs.get(dir) ?? 0) + journeysPerDay);
    byLine.set(line, dirs);
  }
  return [...byLine]
    .map(([line, dirs]): ContributorRow => {
      const split = [...dirs].sort((a, b) => b[1] - a[1]);
      return {
        line,
        journeysPerDay: split.reduce((sum, [, j]) => sum + j, 0),
        byDir: split.length > 1 ? split : [],
      };
    })
    .sort(
      (a, b) =>
        b.journeysPerDay - a.journeysPerDay ||
        a.line.localeCompare(b.line, undefined, { numeric: true }),
    );
}

/** Feature properties as MapLibre hands them back; r is absent when no
 * route on the corridor rounds to at least 1 journey/day. */
export interface CoverageProps {
  j: number;
  b: number;
  r?: string;
}

function rowHtml(row: ContributorRow): string {
  const head = `<span>${esc(row.line)} · ${Math.round(row.journeysPerDay)}/day</span>`;
  if (row.byDir.length === 0) return `<div class="sp-row">${head}</div>`;
  const split = row.byDir
    .map(([dir, j]) => `${esc(DIRECTION_WORDS[dir] ?? dir)} ${Math.round(j)}`)
    .join(' · ');
  return `<div class="sp-row">${head}<span class="vp-dim">${split}</span></div>`;
}

export function coveragePopupHtml(p: CoverageProps): string {
  const total = Math.round(Number(p.j) || 0);
  const title = total < 1 ? 'under 1 journey/day' : `~${total} journey${total === 1 ? '' : 's'}/day`;
  const contributors = parseContributors(typeof p.r === 'string' ? p.r : '');
  const rows = groupContributors(contributors);
  const list =
    rows.length === 0
      ? '<div class="vp-dim">no single route averages 1 journey/day here</div>'
      : rows.map(rowHtml).join('');
  // A full slot set means quieter routes may have been cut, so the rows can
  // sum to less than the headline — say so rather than let it look wrong.
  const capped =
    contributors.length >= CONTRIBUTOR_SLOTS
      ? `<div class="vp-dim">busiest ${CONTRIBUTOR_SLOTS} route-directions shown</div>`
      : '';
  return `<div class="vp"><div class="sp-title">${title}</div>
    <div class="vp-dim">total of all routes on this road, both directions</div>
    <div class="vp-section">Routes</div>
    ${list}${capped}</div>`;
}
