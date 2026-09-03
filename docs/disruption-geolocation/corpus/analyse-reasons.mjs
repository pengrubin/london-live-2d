#!/usr/bin/env node
// analyse-reasons.mjs — TASK B2: TfL line-status reason corpus vs the baked station gazetteer.
// Zero dependencies, local files only. Writes report.md + results.json next to itself.
//
//   node analyse-reasons.mjs            # defaults below
//   CORPUS_DIR=… DATA_DIR=… OUT_DIR=… node analyse-reasons.mjs
//
// Three resolution tiers are reported side by side:
//   STRICT  — exactly the task's normalisation (lowercase, '&'→'and', straight apostrophes, collapsed ws)
//   RELAXED — + apostrophe/period/hyphen folding, parenthetical + "Tram Stop" suffix strip,
//             "London X"→"X" alias, slash-compound split, lowercase-word extension, trailing
//             parenthetical strip
//   ALIASED — + a 10-entry hand alias table (Heathrow family, King's Cross, New Cross ELL), line-scoped
//             name-prefix, phrase-prefix, and Damerau-Levenshtein<=1 typo rescue
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS_DIR = process.env.CORPUS_DIR ?? '/Users/hongweipeng/bus-archive/tube-status';
const DATA_DIR = process.env.DATA_DIR ?? '/Users/hongweipeng/claude_running/london-live-2d/data';
const OUT_DIR = process.env.OUT_DIR ?? HERE;
const TOP_N = 40;
const TYPO_MIN_LEN = 8;      // only try edit-distance rescue on names this long (avoids bank/bark)
const CAUSE_WINDOW = 70;     // chars before "at X" scanned for cause vocabulary

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------
const strictNorm = (s) => s
  .replace(/[‘’ʼ′]/g, "'")
  .replace(/[“”]/g, '"')
  .replace(/[–—]/g, '-')
  .replace(/&/g, ' and ')
  .replace(/\s+/g, ' ')
  .trim()
  .toLowerCase();

const RELAX_PAREN_RE = / \((?:london|berks|kent|essex|surrey|battersea|bakerloo|central|circle line|h and c line|dist and picc line|for [a-z ]+)\)(?=$| )/g;
const RELAX_SUFFIX_RE = / (?:tram stop|underground station|dlr station|rail station|station)$/;
const relaxNorm = (s) => strictNorm(s)
  .replace(/['.]/g, '')                         // earl's/earls, st./st
  .replace(/-underground$/, '')                 // "Paddington (H&C Line)-Underground"
  .replace(RELAX_PAREN_RE, '')
  .replace(/ \(olympia\)/, ' olympia')          // keep the word, drop the parens
  .replace(RELAX_SUFFIX_RE, '')
  .replace(/-/g, ' ')                           // harrow-on-the-hill == "harrow-on-the- hill" (feed typo, 116 occ)
  .replace(/\s+/g, ' ')
  .trim();

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');

// Hand alias table (ALIASED tier). Keys/values are relaxNorm'd. A value list means a
// branch/set — resolves if ANY member is on the stated line.
const HAND_ALIASES = {
  'heathrow': ['heathrow terminals 2 and 3', 'heathrow terminal 4', 'heathrow terminal 5'],
  'heathrow terminals': ['heathrow terminals 2 and 3', 'heathrow terminal 4', 'heathrow terminal 5'],
  'heathrow airport': ['heathrow terminals 2 and 3', 'heathrow terminal 4', 'heathrow terminal 5'],
  'terminal 5': ['heathrow terminal 5'],
  'terminal 4': ['heathrow terminal 4'],
  'terminals 2 and 3': ['heathrow terminals 2 and 3'],
  'heathrow terminal 2': ['heathrow terminals 2 and 3'],
  'heathrow terminal 3': ['heathrow terminals 2 and 3'],
  'kings cross': ['kings cross st pancras'],
  'new cross': ['new cross ell'],          // windrush.json names it "New Cross ELL"
};

// ---------------------------------------------------------------------------
// Gazetteer
// ---------------------------------------------------------------------------
function loadGazetteer() {
  const entries = [];
  for (const f of readdirSync(join(DATA_DIR, 'stations')).filter((f) => f.endsWith('.json'))) {
    const fc = JSON.parse(readFileSync(join(DATA_DIR, 'stations', f), 'utf8'));
    for (const ft of fc.features ?? []) {
      const p = ft.properties ?? {};
      if (p.name && p.id && p.lineId) entries.push({ name: p.name, id: p.id, lineId: p.lineId, source: 'tfl' });
    }
  }
  const nr = JSON.parse(readFileSync(join(DATA_DIR, 'nr', 'stations.json'), 'utf8'));
  for (const s of nr) if (s.name && s.crs) entries.push({ name: s.name, id: s.crs, lineId: 'nr', source: 'nr' });

  const index = (keyFn, extraAliases) => {
    const map = new Map();
    const add = (k, e) => { if (!k) return; const a = map.get(k) ?? []; if (!a.includes(e)) a.push(e); map.set(k, a); };
    for (const e of entries) add(keyFn(e.name), e);
    if (extraAliases) for (const e of entries) for (const k of extraAliases(keyFn(e.name), map)) add(k, e);
    return map;
  };
  const strict = index(strictNorm);
  const relaxed = index(relaxNorm, (k, map) => {
    const m = /^london (.+)$/.exec(k);
    return m && map.has(m[1]) ? [m[1]] : [];   // "london euston"→"euston", never "london bridge"→"bridge"
  });
  return { entries, strict, relaxed };
}

function buildMatcher(map) {
  const keys = [...map.keys()].sort((a, b) => b.length - a.length || a.localeCompare(b));
  const re = new RegExp(`(?<![a-z0-9])(?:${keys.map(escapeRe).join('|')})(?![a-z0-9])`, 'g');
  return { re, keys };
}

// Damerau-Levenshtein (optimal string alignment), early-exit above 1.
function editDistance1(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  const d = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) d[i][0] = i;
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    const cost = a[i - 1] === b[j - 1] ? 0 : 1;
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[a.length][b.length] <= 1;
}

// ---------------------------------------------------------------------------
// Corpus
// ---------------------------------------------------------------------------
function loadCorpus() {
  const reasons = new Map();
  let snapshots = 0, occurrences = 0, badLines = 0;
  const lineIds = new Set(), days = new Set();
  const files = readdirSync(CORPUS_DIR).filter((f) => f.endsWith('.jsonl')).sort();
  for (const f of files) {
    for (const raw of readFileSync(join(CORPUS_DIR, f), 'utf8').split('\n')) {
      if (!raw.trim()) continue;
      let snap;
      try { snap = JSON.parse(raw); } catch { badLines++; continue; }
      snapshots++;
      const day = typeof snap.t === 'number' ? new Date(snap.t * 1000).toISOString().slice(0, 10) : f.replace('.jsonl', '');
      days.add(day);
      for (const line of snap.lines ?? []) {
        lineIds.add(line.id);
        for (const st of line.st ?? []) {
          if (typeof st.r !== 'string') continue;
          occurrences++;
          const rec = reasons.get(st.r) ?? { text: st.r, count: 0, lineIds: new Set(), days: new Set(), statuses: new Set(), sev: new Set() };
          rec.count++; rec.lineIds.add(line.id); rec.days.add(day); rec.statuses.add(st.d); rec.sev.add(st.s);
          reasons.set(st.r, rec);
        }
      }
    }
  }
  return { reasons: [...reasons.values()], snapshots, occurrences, badLines, lineIds, days, files };
}

// ---------------------------------------------------------------------------
// Phrase extraction on the ORIGINAL text
// ---------------------------------------------------------------------------
const TOKEN = String.raw`(?:St\.|[A-Z][A-Za-z0-9'’\-]*)`;
const FOLLOW = String.raw`(?:${TOKEN}|\d+|&|\/|\((?:[A-Za-z0-9&'’. ]+)\))`;
const PHRASE_RE = new RegExp(String.raw`\b(between|and|at|from|to|via|towards)\s+(${TOKEN}(?:\s+${FOLLOW})*)`, 'g');
const DIR_SUFFIX_RE = /\s+((?:East|West|North|South)bound)$/;
const DIR_AFTER_RE = /^\s+((?:east|west|north|south)bound)(\s+only)?/i;
const NEXT_WORD_RE = /^\s+([a-z][a-z'’]*)/;
const LINE_LOOKAHEAD = /^(?:line|lines|light|railway|railways|express|trains)$/;

const DAY_MONTH = /\b(mondays?|tuesdays?|wednesdays?|thursdays?|fridays?|saturdays?|sundays?|january|february|march|april|may|june|july|august|september|october|november|december|holiday|christmas|new year|weekends?)\b/;
const OPERATOR = /\b(line|lines|railway|railways|trains|buses|bus|tramlink|trams|express|rail|underground|overground|dlr|c2c|anglia|southern|southeastern|south eastern|great northern|thameslink|chiltern|great western|gwr|south west|south western|london northwestern|night tube|tickets|tfl|transport for london|london buses|northern rail|stansted)\b/;
const STATUS_WORD = /^(?:severe|minor|good|no|special|reduced|part|planned|suspended|delays|service|services|closure|closed|night|please|use|until|from|replacement|there|trains|customers|eastbound|westbound|northbound|southbound)$/;
const CAUSE_RE = /\b(fire|alert|failure|fault|faulty|incident|casualty|trespass\w*|obstruction|crowding|event|work|damage|police|person|passenger|signal|signalling|points|track|power|flooding|derail\w*|collision|problem|vandalism|carnival|late finish|emergency|alarm|defective|broken|leak|closed)\b[^.]{0,40}$/i;

function classifyPhrase(raw, nextWord) {
  const n = strictNorm(raw);
  if (/^\d/.test(n) || DAY_MONTH.test(n)) return 'DATE';
  if (OPERATOR.test(n) || (nextWord && LINE_LOOKAHEAD.test(nextWord))) return 'OPERATOR';
  if (n.split(' ').every((w) => STATUS_WORD.test(w))) return 'STATUS';
  return 'LOC';
}

// Try extending a phrase with following lowercase words ("Baker" + "street") when the
// extension is a gazetteer name (relaxed). Deterministic, at most 3 words.
function extendLowercase(text, endIdx, raw, relaxedMap) {
  const tail = text.slice(endIdx);
  const m = /^((?:\s+[a-z][a-z'’\-]*){1,3})/.exec(tail);
  if (!m) return null;
  const words = m[1].trim().split(/\s+/);
  for (let n = words.length; n >= 1; n--) {
    const cand = `${raw} ${words.slice(0, n).join(' ')}`;
    if (relaxedMap.has(relaxNorm(cand))) return cand;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Sentence scoping. Only the stated line's own disruption sentence(s) should drive
// attachment; replacement-bus, other-line, other-operator, ticket and advice
// sentences name places that are NOT the disrupted section.
// ---------------------------------------------------------------------------
const LINE_NAME_PATTERNS = {
  bakerloo: /\bbakerloo\b/i, central: /\bcentral line\b/i, circle: /\bcircle line\b/i, district: /\bdistrict line\b/i,
  dlr: /\b(?:docklands light railway|dlr)\b/i, elizabeth: /\belizabeth line\b/i, 'hammersmith-city': /\bhammersmith (?:and|&) city\b/i,
  jubilee: /\bjubilee\b/i, liberty: /\bliberty line\b/i, lioness: /\blioness line\b/i, metropolitan: /\bmetropolitan\b/i,
  mildmay: /\bmildmay line\b/i, northern: /\bnorthern line\b/i, piccadilly: /\bpiccadilly line\b/i, suffragette: /\bsuffragette line\b/i,
  tram: /\b(?:london trams?|tramlink)\b/i, victoria: /\bvictoria line\b/i, 'waterloo-city': /\bwaterloo (?:and|&) city\b/i,
  weaver: /\bweaver line\b/i, windrush: /\bwindrush line\b/i,
};
const OTHER_OPERATOR_RE = /\b(?:southern|southeastern|south eastern|thameslink|greater anglia|chiltern|great northern|great western|c2c|south western|london northwestern|stansted express|heathrow express|london overground|national rail|night bus)\b/i;
const SECONDARY_RE = /\b(?:replacement bus(?:es)?|rail replacement|use |please use|tickets?|accepted|accepting|will not operate|are running|continue to operate|continues? to serve|travelling|travel to|change at|change there|interchange|local (?:london )?buses|last through trains?|terminates? at|the \d{4}|check before you travel|diverted via|usually call at|will not run|next train|board the first train)\b/i;
const SENTENCE_SPLIT_RE = /(?:\r?\n)+|(?<=[.;!?])\s+(?=[A-Z"(])/;

function splitSentences(text, stated) {
  const out = [];
  let pos = 0;
  for (const part of text.split(SENTENCE_SPLIT_RE)) {
    const start = text.indexOf(part, pos);
    const end = start + part.length;
    pos = end;
    let kind = 'PRIMARY';
    const otherLine = Object.entries(LINE_NAME_PATTERNS).some(([id, re]) => !stated.has(id) && re.test(part));
    if (SECONDARY_RE.test(part)) kind = 'SECONDARY';
    else if (otherLine || OTHER_OPERATOR_RE.test(part)) kind = 'OTHER_LINE';
    out.push({ start, end, kind, text: part });
  }
  return out;
}

function extractPhrases(text, relaxedMap, stated) {
  const sentences = splitSentences(text, stated);
  const sentenceOf = (idx) => sentences.find((s) => idx >= s.start && idx < s.end) ?? sentences[sentences.length - 1];
  const out = [];
  for (const m of text.matchAll(PHRASE_RE)) {
    let raw = m[2].replace(/[.,;:]+$/, '');
    let dir = null;
    const ds = DIR_SUFFIX_RE.exec(raw);
    if (ds) { dir = ds[1].toLowerCase(); raw = raw.replace(DIR_SUFFIX_RE, ''); }
    const end = m.index + m[0].length;
    const after = text.slice(end);
    const da = DIR_AFTER_RE.exec(after);
    if (da) dir = da[1].toLowerCase() + (da[2] ? ' only' : '');
    const nw = NEXT_WORD_RE.exec(after);
    const nextWord = nw ? nw[1] : null;
    const cls = classifyPhrase(raw, nextWord);
    const extended = cls === 'LOC' ? extendLowercase(text, end, raw, relaxedMap) : null;
    out.push({ kw: m[1].toLowerCase(), raw, rawExt: extended ?? raw, extended: !!extended, dir, cls, index: m.index, end, before: text.slice(Math.max(0, m.index - CAUSE_WINDOW), m.index), sentence: sentenceOf(m.index).kind });
  }
  // roles
  let expect = null, pairClosedAt = -1;
  for (let i = 0; i < out.length; i++) {
    const p = out[i];
    const gap = i > 0 ? text.slice(out[i - 1].end, p.index) : text.slice(0, p.index);
    const adjacent = /^[,\s]*$/.test(gap);
    if (p.cls !== 'LOC') { p.role = 'NONLOC'; if (p.cls !== 'DATE') expect = null; continue; }
    if (p.kw === 'between') { p.role = 'SECTION'; expect = 'and'; }
    else if (p.kw === 'from') {
      // "from X to Y" is a section; a lone "from X" ("travelling to/from Wembley Arena") is a mention
      const nxt = out[i + 1];
      const pairs = nxt && nxt.kw === 'to' && nxt.cls === 'LOC' && /^[,\s]*$/.test(text.slice(p.end, nxt.index));
      p.role = pairs ? 'SECTION' : 'MENTION'; expect = pairs ? 'to' : null;
    }
    else if (p.kw === 'and' && expect === 'and' && adjacent) { p.role = 'SECTION'; expect = null; pairClosedAt = i; }
    else if (p.kw === 'to' && expect === 'to' && adjacent) { p.role = 'SECTION'; expect = null; }
    else if (p.kw === 'and' && pairClosedAt === i - 1 && adjacent && out[i + 1]?.kw === 'and' && out[i + 1].cls === 'LOC' && /^[,\s]*$/.test(text.slice(p.end, out[i + 1].index))) {
      p.role = 'SECTION'; out[i + 1].role = 'SECTION'; out[i + 1].secondPair = true; p.secondPair = true; pairClosedAt = i + 1; i++;   // "between A and B, and C and D"
    }
    else if (p.kw === 'at') { p.role = CAUSE_RE.test(p.before) ? 'CAUSE' : 'AT'; expect = null; }
    else if (p.kw === 'via') { p.role = 'ROUTE'; }
    else if (p.kw === 'towards') { p.role = 'DIRECTION'; expect = null; }
    else { p.role = 'MENTION'; expect = null; }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------
function hitsOnLine(hits, statedLineIds) { return hits.some((h) => statedLineIds.has(h.lineId)); }

function resolveStrict(raw, map, stated) {
  const key = strictNorm(raw);
  const hits = map.get(key) ?? [];
  return { parts: [{ key, hits, rule: hits.length ? 'exact' : null }], resolved: hits.length > 0, onLine: hitsOnLine(hits, stated) };
}

function resolvePart(key, map, stated, tier, entries) {
  let hits = map.get(key) ?? [];
  // hand aliases are unioned with exact hits: "New Cross" is an NR station AND windrush's "New Cross ELL"
  const aliasHits = tier === 'aliased' && HAND_ALIASES[key] ? HAND_ALIASES[key].flatMap((k) => map.get(k) ?? []) : [];
  if (hits.length) return { key, hits: [...hits, ...aliasHits], rule: aliasHits.length ? 'exact+hand-alias' : 'exact' };
  // relaxed: trailing parenthetical strip  "Totteridge & Whetstone (Whetstone High Road)"
  const noParen = key.replace(/\s*\([^)]*\)\s*$/, '').trim();
  if (noParen !== key && map.has(noParen)) return { key: noParen, hits: map.get(noParen), rule: 'paren-strip' };
  if (tier !== 'aliased') return { key, hits: [], rule: null };
  // aliased: hand table
  if (HAND_ALIASES[key]) {
    hits = HAND_ALIASES[key].flatMap((k) => map.get(k) ?? []);
    if (hits.length) return { key, hits, rule: 'hand-alias' };
  }
  // aliased: phrase is a prefix of exactly one station name ON THE STATED LINE ("Dalston" → Dalston Junction on windrush)
  const linePrefix = entries.filter((e) => stated.has(e.lineId) && relaxNorm(e.name).startsWith(key + ' '));
  const uniq = [...new Set(linePrefix.map((e) => relaxNorm(e.name)))];
  if (uniq.length === 1) return { key, hits: map.get(uniq[0]), rule: 'line-scoped name-prefix' };
  // aliased: longest gazetteer name that is a prefix of the phrase ("Aldgate Jubilee", "Camden Town Golders Green")
  const words = key.split(' ');
  for (let n = words.length - 1; n >= 1; n--) {
    const cand = words.slice(0, n).join(' ');
    if (map.has(cand)) return { key: cand, hits: map.get(cand), rule: 'phrase-prefix' };
  }
  // aliased: single-edit typo on a long name ("Seven Sister", "West Ruilsip")
  if (key.length >= TYPO_MIN_LEN) {
    const cands = [...map.keys()].filter((k) => k.length >= TYPO_MIN_LEN && editDistance1(key, k));
    if (cands.length === 1) return { key: cands[0], hits: map.get(cands[0]), rule: 'edit-distance-1' };
  }
  return { key, hits: [], rule: null };
}

function resolveTier(rawExt, map, stated, tier, entries) {
  const parts = rawExt.split(/\s*\/\s*/).map((p) => relaxNorm(p)).filter(Boolean).map((k) => resolvePart(k, map, stated, tier, entries));
  const resolved = parts.length > 0 && parts.every((p) => p.hits.length > 0);
  const onLine = resolved && parts.every((p) => hitsOnLine(p.hits, stated));
  // "Clapham Junction / Battersea Park": alternative endpoints — attach the on-line one, drop the other
  const anyPartOnLine = resolved && parts.some((p) => hitsOnLine(p.hits, stated));
  return { parts, resolved, onLine, anyPartOnLine, isCompound: parts.length > 1, rules: [...new Set(parts.map((p) => p.rule).filter(Boolean))] };
}

// ---------------------------------------------------------------------------
// Skeletons
// ---------------------------------------------------------------------------
const LINE_NAME_RE = /\b(?:(?:bakerloo|central|circle|district|hammersmith and city|jubilee|metropolitan|northern|piccadilly|victoria|waterloo and city|elizabeth|mildmay|windrush|weaver|suffragette|liberty|lioness|london overground|overground) lines?|london trams|london tramlink|docklands light railway|dlr|london underground|night tube|national rail)\b/g;
const STATION_CONTEXT_GUARD = [/^bank(?= holiday)/, /^bank(?=\/public)/];
const ANCHOR_RE = /(?:\b(?:between|and|at|from|to|via|towards)|,|\/|<STN>)$/;

function makeSkeletoniser(matcher, normFn) {
  return (text) => {
    const norm = normFn(text).replace(LINE_NAME_RE, '<LINE>');
    const matches = [];
    let suppressed = 0;
    const l1 = norm.replace(matcher.re, (name, index, whole) => {
      if (STATION_CONTEXT_GUARD.some((g) => g.test(whole.slice(index)))) { suppressed++; return name; }
      const before = whole.slice(0, index).trimEnd();
      matches.push({ name, index, anchored: ANCHOR_RE.test(before), context: whole.slice(Math.max(0, index - 30), index + name.length + 20) });
      return '<STN>';
    });
    return { l1, matches, suppressed };
  };
}

function skeletonL2(l1) {
  return l1
    .replace(/^(?:<LINE>|[a-z ]+ lines?|london trams|london tramlink|docklands light railway):\s*/, '')
    .replace(/\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?\b/g, '<DAY>')
    .replace(/\b<DAY>\s+\d{1,2}(?:\s+(?:january|february|march|april|may|june|july|august|september|october|november|december))?(?:\s+\d{4})?\b/g, '<DATE>')
    .replace(/\b\d{1,2}\s+(?:january|february|march|april|may|june|july|august|september|october|november|december)(?:\s+\d{4})?\b/g, '<DATE>')
    .replace(/\b\d{1,2}:\d{2}\b/g, '<TIME>')
    .replace(/\b(?:[01]\d|2[0-3])[0-5]\d\b/g, '<TIME>')
    .replace(/\b(?:bus service|night bus|bus|route) [a-z]{0,2}\d{1,3}\b/g, (m) => m.replace(/[a-z]{0,2}\d{1,3}$/, '<ROUTE>'))
    .replace(/\b20\d\d\b/g, '<YEAR>')
    .replace(/\b\d+\b/g, '<N>')
    .replace(/(?:<STN>, )+<STN>(?: and <STN>)?/g, '<STN-LIST>')
    .replace(/\s+/g, ' ')
    .replace(/[.\s]+$/, '')
    .trim();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const gaz = loadGazetteer();
const strictMatcher = buildMatcher(gaz.strict);
const relaxedMatcher = buildMatcher(gaz.relaxed);
const skelStrict = makeSkeletoniser(strictMatcher, strictNorm);
const skelRelaxed = makeSkeletoniser(relaxedMatcher, relaxNorm);
const corpus = loadCorpus();

const TIERS = ['strict', 'relaxed', 'aliased'];
const rows = corpus.reasons.map((rec) => {
  const phrases = extractPhrases(rec.text, gaz.relaxed, rec.lineIds).map((p) => ({
    ...p,
    strict: resolveStrict(p.raw, gaz.strict, rec.lineIds),
    relaxed: resolveTier(p.rawExt, gaz.relaxed, rec.lineIds, 'relaxed', gaz.entries),
    aliased: resolveTier(p.rawExt, gaz.relaxed, rec.lineIds, 'aliased', gaz.entries),
  }));
  const loc = phrases.filter((p) => p.cls === 'LOC');
  const attach = loc.filter((p) => p.role !== 'MENTION');
  const classify = (tokens, tier, requireOnLine = true) => {
    if (tokens.length === 0) return 'NONE';
    return tokens.every((p) => p[tier].resolved && (!requireOnLine || p[tier].onLine)) ? 'FULL' : 'PARTIAL';
  };
  const cls = {};
  for (const t of TIERS) { cls[`all_${t}`] = classify(loc, t); cls[`attach_${t}`] = classify(attach, t); cls[`attachAnyLine_${t}`] = classify(attach, t, false); }
  // POLICY: primary-sentence tokens only; SECTION/ROUTE/DIRECTION must have an on-line part
  // (alternative endpoints keep the on-line one); CAUSE/AT may be any gazetteer station.
  const primary = attach.filter((p) => p.sentence === 'PRIMARY');
  const policyOk = (p, tier) => p[tier].resolved && ((p.role === 'CAUSE' || p.role === 'AT') ? true : p[tier].anyPartOnLine);
  for (const t of ['relaxed', 'aliased']) cls[`policy_${t}`] = primary.length === 0 ? 'NONE' : primary.every((p) => policyOk(p, t)) ? 'FULL' : 'PARTIAL';
  const secondaryTokens = attach.filter((p) => p.sentence !== 'PRIMARY');
  const s = skelStrict(rec.text), r = skelRelaxed(rec.text);
  return { ...rec, phrases, loc, attach, primary, secondaryTokens, cls, skelStrictL1: s.l1, skelStrictMatches: s.matches, skelRelaxedL1: r.l1, skelRelaxedMatches: r.matches, suppressedRelaxed: r.suppressed, skelRelaxedL2: skeletonL2(r.l1), skelStrictL2: skeletonL2(s.l1) };
});

// ---- (a) ----
const byCount = [...rows].sort((a, b) => b.count - a.count || a.text.localeCompare(b.text));
const multiLine = rows.filter((r) => r.lineIds.size > 1);
const statusDist = new Map();
for (const r of rows) for (const d of r.statuses) { const e = statusDist.get(d) ?? { distinct: 0, occurrences: 0 }; e.distinct++; e.occurrences += r.count; statusDist.set(d, e); }

// ---- (b) ----
function topSkeletons(keyFn) {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    const e = m.get(k) ?? { skeleton: k, distinct: 0, occurrences: 0, example: r.text, exampleCount: -1, lineIds: new Set() };
    e.distinct++; e.occurrences += r.count; for (const l of r.lineIds) e.lineIds.add(l);
    if (r.count > e.exampleCount) { e.example = r.text; e.exampleCount = r.count; }
    m.set(k, e);
  }
  return { total: m.size, list: [...m.values()].sort((a, b) => b.distinct - a.distinct || b.occurrences - a.occurrences) };
}
const skStrictL1 = topSkeletons((r) => r.skelStrictL1);
const skRelaxedL1 = topSkeletons((r) => r.skelRelaxedL1);
const skRelaxedL2 = topSkeletons((r) => r.skelRelaxedL2);

// ---- (c) ----
const phraseAgg = new Map();
for (const r of rows) for (const p of r.phrases) {
  const k = p.raw;
  const e = phraseAgg.get(k) ?? { raw: p.raw, cls: p.cls, kws: new Set(), roles: new Set(), distinct: 0, occurrences: 0, strictHit: false, relaxedHit: false, aliasedHit: false, rules: new Set(), lines: new Set(), canonical: new Set(), dir: new Set() };
  e.kws.add(p.kw); e.roles.add(p.role); e.distinct++; e.occurrences += r.count; for (const l of r.lineIds) e.lines.add(l);
  if (p.strict.resolved) e.strictHit = true;
  if (p.relaxed.resolved) { e.relaxedHit = true; for (const x of p.relaxed.parts) for (const h of x.hits) e.canonical.add(h.name); }
  if (p.aliased.resolved) { e.aliasedHit = true; for (const ru of p.aliased.rules) e.rules.add(ru); if (!p.relaxed.resolved) for (const x of p.aliased.parts) for (const h of x.hits) e.canonical.add(h.name); }
  if (p.dir) e.dir.add(p.dir);
  if (p.extended) e.rules.add(`lowercase-extend→"${p.rawExt}"`);
  phraseAgg.set(k, e);
}
const allPhrases = [...phraseAgg.values()];
const locPhrases = allPhrases.filter((p) => p.cls === 'LOC');
const byDistinct = (a, b) => b.distinct - a.distinct || b.occurrences - a.occurrences || a.raw.localeCompare(b.raw);
const unmatchedStrict = allPhrases.filter((p) => !p.strictHit).sort(byDistinct);
const fixedByRelax = locPhrases.filter((p) => !p.strictHit && p.relaxedHit).sort(byDistinct);
const fixedByAlias = locPhrases.filter((p) => !p.relaxedHit && p.aliasedHit).sort(byDistinct);
const unmatchedAliased = locPhrases.filter((p) => !p.aliasedHit).sort(byDistinct);

// ---- (d) ----
const tally = (key, weighted = false) => rows.reduce((acc, r) => { acc[r.cls[key]] += weighted ? r.count : 1; return acc; }, { FULL: 0, PARTIAL: 0, NONE: 0 });
const naive = {
  'LOC-class phrase after any of the 7 keywords': rows.filter((r) => r.loc.length > 0).length,
  'attachable LOC phrase (role != MENTION)': rows.filter((r) => r.attach.length > 0).length,
  'attachable LOC phrase in the PRIMARY (own-line disruption) sentence': rows.filter((r) => r.primary.length > 0).length,
  'has attachable tokens ONLY in secondary/other-line sentences': rows.filter((r) => r.primary.length === 0 && r.secondaryTokens.length > 0).length,
  'SECTION phrase (between/from…to pair)': rows.filter((r) => r.attach.some((p) => p.role === 'SECTION')).length,
  'CAUSE/AT phrase only, no SECTION': rows.filter((r) => !r.attach.some((p) => p.role === 'SECTION') && r.attach.some((p) => p.role === 'CAUSE' || p.role === 'AT')).length,
  'regex /\\b(between|at|from|to|via|towards)\\s+[A-Z]/': rows.filter((r) => /\b(between|at|from|to|via|towards)\s+[A-Z]/.test(r.text)).length,
  'regex /\\bbetween\\s+[A-Z]/': rows.filter((r) => /\bbetween\s+[A-Z]/.test(r.text)).length,
  'regex /\\b(between|at)\\s+[A-Z]/': rows.filter((r) => /\b(between|at)\s+[A-Z]/.test(r.text)).length,
  'regex /\\b(between|at|via|towards)\\s+[A-Z]/': rows.filter((r) => /\b(between|at|via|towards)\s+[A-Z]/.test(r.text)).length,
  'regex /\\b(between|from)\\s+[A-Z]/': rows.filter((r) => /\b(between|from)\s+[A-Z]/.test(r.text)).length,
  'any STRICT gazetteer name anywhere in text': rows.filter((r) => r.skelStrictMatches.length > 0).length,
  'any RELAXED gazetteer name anywhere in text': rows.filter((r) => r.skelRelaxedMatches.length > 0).length,
};
const policyOkReport = (p) => p.aliased.resolved && ((p.role === 'CAUSE' || p.role === 'AT') ? true : p.aliased.anyPartOnLine);
const failing = (r, tier, tokens) => tokens.filter((p) => !(p[tier].resolved && p[tier].onLine)).map((p) => `${p.role}:${p.kw} "${p.raw}"` + (p[tier].resolved ? ` [on ${[...new Set(p[tier].parts.flatMap((x) => x.hits.map((h) => h.lineId)))].join('/')}, not ${[...r.lineIds].join('/')}]` : ' [no hit]'));

// ---- (e) ----
const multiIdNames = new Map();
for (const [k, hits] of gaz.relaxed) if (new Set(hits.map((h) => h.id)).size > 1) multiIdNames.set(k, hits);
const resolvedKeys = new Set();
for (const r of rows) for (const p of r.loc) for (const part of p.aliased.parts) if (part.hits.length) resolvedKeys.add(part.key);
const multiIdInCorpus = [...multiIdNames.entries()].filter(([k]) => resolvedKeys.has(k)).map(([k, hits]) => ({ name: k, ids: [...new Set(hits.map((h) => `${h.lineId}:${h.id}`))] }));
const multiSection = rows.filter((r) => (r.skelRelaxedL1.match(/\bbetween\b/g) ?? []).length >= 2 || r.attach.some((p) => p.secondPair));
const directional = rows.filter((r) => /\b(east|west|north|south)bound\b|in both directions|-bound\b|\btowards\b/i.test(r.text));
const viaRows = rows.filter((r) => /\bvia\b/i.test(r.text));
const viaStation = viaRows.filter((r) => /via <STN>/.test(r.skelRelaxedL1));
const restOfLine = rows.filter((r) => /rest of the line|all other routes|on the rest of|rest of the route|entire line/i.test(r.text));
const dated = rows.filter((r) => /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(r.text) && /\b\d{1,2}\b/.test(r.text));
const replacementBus = rows.filter((r) => /replacement bus/i.test(r.text));
const ticketAcceptance = rows.filter((r) => /tickets? (will be|are being|are|being) accepted|accepting tickets|accepted on/i.test(r.text));
const bareXtoY = rows.filter((r) => /(?<!from )<STN> to <STN>/.test(r.skelRelaxedL1));
const offLine = { section: [], cause: [], mention: [] };
for (const r of rows) for (const p of r.loc) if (p.aliased.resolved && !p.aliased.onLine) {
  const bucket = p.role === 'SECTION' ? 'section' : (p.role === 'CAUSE' || p.role === 'AT') ? 'cause' : 'mention';
  offLine[bucket].push({ phrase: p.raw, role: p.role, stated: [...r.lineIds].join('/'), on: [...new Set(p.aliased.parts.flatMap((x) => x.hits.map((h) => h.lineId)))].join('/'), text: r.text, count: r.count });
}
const unanchored = new Map();
for (const r of rows) for (const m of r.skelRelaxedMatches) if (!m.anchored) { const k = `${m.name}|${m.context}`; const e = unanchored.get(k) ?? { name: m.name, context: m.context, distinct: 0 }; e.distinct++; unanchored.set(k, e); }
const suppressedTotal = rows.reduce((a, r) => a + r.suppressedRelaxed, 0);
const noneStrings = rows.filter((r) => r.cls.all_strict === 'NONE');
const roleCounts = {};
for (const r of rows) for (const p of r.loc) roleCounts[p.role] = (roleCounts[p.role] ?? 0) + 1;
const dirPhrases = locPhrases.filter((p) => p.dir.size);

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const q = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
const trunc = (s, n = 160) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const L = [];
const H = (s) => L.push('', s, '');
L.push('# TASK B2 — TfL line-status reason corpus vs baked station gazetteer', '');
L.push(`Generated by \`analyse-reasons.mjs\` (zero deps, local files only) on ${new Date().toISOString()}. Sidecar: \`results.json\`.`, '');
{
  const pa = tally('policy_aliased'), paw = tally('policy_aliased', true), st = tally('all_strict'), rx = tally('all_relaxed'), al = tally('all_aliased'), pr = tally('policy_relaxed');
  const pct = (n, d) => `${(100 * n / d).toFixed(1)}%`;
  H('## Key findings');
  L.push(`1. Corpus: ${rows.length} distinct reason strings, ${corpus.occurrences} occurrences, ${corpus.days.size} days, ${corpus.snapshots} snapshots, ${corpus.lineIds.size} line ids.`);
  L.push(`2. "Carries a location phrase": **${naive['LOC-class phrase after any of the 7 keywords']}/${rows.length}** distinct strings have a capitalised location phrase after between/and/at/from/to/via/towards (${naive['regex /\\bbetween\\s+[A-Z]/']} with "between"; ${naive['CAUSE/AT phrase only, no SECTION']} have only an "at <cause station>"). The earlier 428/604 figure is not reproduced by any definition tried (see the reconciliation table in section d) — treat it as superseded.`);
  L.push(`3. Gazetteer fit: of ${locPhrases.length} distinct location phrases, STRICT normalisation matches ${locPhrases.filter((p) => p.strictHit).length}; RELAXED rules (tram "Tram Stop" suffix, "(H&C Line)"/"(London)" parentheticals, apostrophes, hyphens, "London X") lift that to ${locPhrases.filter((p) => p.relaxedHit).length}; a ${Object.keys(HAND_ALIASES).length}-entry hand alias table (Heathrow family, King's Cross) plus prefix/typo rules reach ${locPhrases.filter((p) => p.aliasedHit).length}; ${unmatchedAliased.length} remain unmatched (${unmatchedAliased.map((p) => `"${p.raw}"`).join(', ')}) — none is a station on the map.`);
  L.push(`4. Parseability ladder (FULL / PARTIAL / NONE of ${rows.length}): STRICT as specified ${st.FULL}/${st.PARTIAL}/${st.NONE} → RELAXED ${rx.FULL}/${rx.PARTIAL}/${rx.NONE} → ALIASED ${al.FULL}/${al.PARTIAL}/${al.NONE} → policy contract (own-line sentence only, cause stations may be off-line, alternative endpoints keep the on-line one) RELAXED ${pr.FULL}/${pr.PARTIAL}/${pr.NONE}, **ALIASED ${pa.FULL}/${pa.PARTIAL}/${pa.NONE}** = ${pct(pa.FULL, rows.length)} of distinct strings and ${pct(paw.FULL, corpus.occurrences)} of occurrences fully placeable; ${pct(paw.NONE, corpus.occurrences)} of occurrences are line-wide by construction.`);
  L.push(`5. The single biggest STRICT failure is the "at <cause station>" token on a line that does not stop there (Neasden/Kilburn on the Metropolitan, South Kensington on the H&C, Royal Oak/Westbourne Park on District/Met): ${offLine.cause.length} token instances. Section endpoints off the stated line are rare (${offLine.section.length} instances) and all sit in secondary sentences (other line / replacement bus) except Dalston Kingsland (an other-line clause) — and, before the alias, New Cross, which windrush.json names "New Cross ELL".`);
  L.push(`6. Structure to handle: "… and SEVERE DELAYS on the rest of the line" in ${restOfLine.length} strings (two severities per string); multi-section in ${multiSection.length}; direction qualifiers in ${directional.length}; "via <STN>" routing in ${viaStation.length} (Circle "via Victoria"/"via High Street Kensington", Northern "via Charing Cross"/"via Bank", Central "via Newbury Park"); dated planned closures in ${dated.length}; replacement-bus sentences in ${replacementBus.length}; ticket-acceptance sentences in ${ticketAcceptance.length}.`);
  L.push(`6b. Empty reasons: ${rows.filter((r) => r.skelRelaxedL2 === '').length} distinct strings (${rows.filter((r) => r.skelRelaxedL2 === '').reduce((a, r) => a + r.count, 0)} occurrences) are just the line-name prefix with no text ("Liberty Line:") — must be treated as no-reason.`);
  L.push(`7. Name→id ambiguity: ${multiIdInCorpus.length} resolved names map to different station ids on different lines (e.g. Paddington tube 940GZZLUPAC vs Elizabeth 910GPADTLL; Canary Wharf has three ids) — the stated line id must pick the id.`);
  L.push(`8. Anywhere-matching of station names is unsafe: "Bank" in "Bank Holiday", "Arena" (tram) inside "Wembley Arena", "Notting Hill Gate" inside "Notting Hill Gate carnival", and ${unanchored.size} keyword-unanchored contexts (section e10). Keyword-anchored extraction avoids all of them.`);
}
H('## Corpus');
L.push(`- Source: \`${CORPUS_DIR}/*.jsonl\` — ${corpus.files.length} files: ${corpus.files.join(', ')}`);
L.push(`- Snapshots (JSONL lines parsed): ${corpus.snapshots}; malformed lines skipped: ${corpus.badLines}`);
L.push(`- Distinct calendar days (UTC, from \`t\`): ${corpus.days.size} — ${[...corpus.days].sort().join(', ')}`);
L.push(`- Reason occurrences (every \`st[].r\`): ${corpus.occurrences}`);
L.push(`- **Distinct reason strings: ${rows.length}**`);
L.push(`- Line ids seen: ${[...corpus.lineIds].sort().join(', ')} (${corpus.lineIds.size})`);
L.push(`- Distinct strings published under 2+ line ids: ${multiLine.length}` + (multiLine.length ? ' — ' + multiLine.map((r) => `[${[...r.lineIds].join('/')}] "${trunc(r.text, 70)}"`).join('; ') : ''));
L.push('', '### Status-description distribution (per distinct string; a string can carry several)', '', '| d | distinct | occurrences |', '|---|---|---|');
for (const [d, e] of [...statusDist.entries()].sort((a, b) => b[1].distinct - a[1].distinct)) L.push(`| ${d} | ${e.distinct} | ${e.occurrences} |`);
H('## Gazetteer');
L.push(`- \`${DATA_DIR}/stations/*.json\`: ${gaz.entries.filter((e) => e.source === 'tfl').length} (name,id,lineId) features across ${new Set(gaz.entries.filter((e) => e.source === 'tfl').map((e) => e.lineId)).size} lineIds; distinct names ${new Set(gaz.entries.filter((e) => e.source === 'tfl').map((e) => e.name)).size}`);
L.push(`- \`${DATA_DIR}/nr/stations.json\`: ${gaz.entries.filter((e) => e.source === 'nr').length} entries (crs as id, lineId="nr")`);
L.push(`- STRICT keys: ${gaz.strict.size}; RELAXED keys: ${gaz.relaxed.size}; hand aliases (ALIASED tier): ${Object.keys(HAND_ALIASES).length}`);
L.push(`- Longest-match-first regex alternatives: strict ${strictMatcher.keys.length}, relaxed ${relaxedMatcher.keys.length}; longest key "${strictMatcher.keys[0]}"`);
L.push('- Gazetteer quirks that break STRICT matching: every tram name ends in " Tram Stop" (39); rail names carry "London " prefixes and "(London)" suffixes; tube disambiguators "(H&C Line)", "(Dist&Picc Line)", "(Circle Line)", "(Bakerloo)", "(Central)"; "Paddington (H&C Line)-Underground"; curly apostrophe in "St Mary’s Wandsworth Pier".');

H('## (a) Distinct reason strings — top 40 by occurrence');
L.push('| n | days | line ids | status | reason |', '|---|---|---|---|---|');
for (const r of byCount.slice(0, 40)) L.push(`| ${r.count} | ${r.days.size} | ${[...r.lineIds].join('/')} | ${[...r.statuses].join('/')} | ${q(trunc(r.text, 200))} |`);
L.push('', `All ${rows.length} are in \`results.json\` → \`reasons[]\` (text, count, lineIds, days, statuses, classification, skeleton, tokens).`);

H('## (b) Skeletons — station names → `<STN>`, longest match first');
const skelSection = (title, sk, note) => {
  L.push('', `### ${title}`, '', note, '', `Distinct skeletons: **${sk.total}** (from ${rows.length} distinct strings)`, '', '| distinct | occ | lines | skeleton | example |', '|---|---|---|---|---|');
  for (const e of sk.list.slice(0, TOP_N)) L.push(`| ${e.distinct} | ${e.occurrences} | ${[...e.lineIds].join('/')} | ${q(trunc(e.skeleton, 170))} | ${q(trunc(e.example, 110))} |`);
};
skelSection('b1. STRICT normalisation, stations only (as specified)', skStrictL1, 'Line names are masked to `<LINE>` first so "Victoria line" / "Waterloo & City line" / "Hammersmith & City line" cannot be mistaken for Victoria / Waterloo / Hammersmith stations. Nothing else is masked, so dates and times keep most skeletons unique.');
skelSection('b2. RELAXED normalisation, stations only', skRelaxedL1, 'As b1 with the relaxed gazetteer (tram suffix, parentheticals, apostrophes, hyphens, "London X").');
skelSection('b3. RELAXED + `<DATE> <TIME> <ROUTE> <N> <STN-LIST>` masked, "X line:" prefix stripped', skRelaxedL2, 'The template inventory a deterministic parser would target.');

H('## (c) Capitalised phrases after between / and / at / from / to / via / towards');
L.push(`Distinct raw phrases: ${allPhrases.length} — LOC ${locPhrases.length}, DATE ${allPhrases.filter((p) => p.cls === 'DATE').length}, OPERATOR ${allPhrases.filter((p) => p.cls === 'OPERATOR').length}, STATUS ${allPhrases.filter((p) => p.cls === 'STATUS').length}.`);
L.push(`LOC phrases: STRICT hit ${locPhrases.filter((p) => p.strictHit).length}, RELAXED hit ${locPhrases.filter((p) => p.relaxedHit).length}, ALIASED hit ${locPhrases.filter((p) => p.aliasedHit).length}, still unmatched ${unmatchedAliased.length}.`);
L.push(`LOC token instances by role (over distinct strings): ${Object.entries(roleCounts).map(([k, v]) => `${k} ${v}`).join(', ')}.`);
L.push('', `### c1. LOC misses under STRICT fixed by RELAXED rules (${fixedByRelax.length}) — seen → canonical`, '', '| distinct | occ | kw | seen | canonical | rule | lines |', '|---|---|---|---|---|---|---|');
for (const p of fixedByRelax) L.push(`| ${p.distinct} | ${p.occurrences} | ${[...p.kws].join('/')} | ${q(p.raw)} | ${q([...p.canonical].join(' / '))} | ${[...p.rules].join('; ') || 'normalisation'} | ${[...p.lines].join('/')} |`);
L.push('', `### c2. LOC misses under RELAXED fixed by ALIASED rules (${fixedByAlias.length}) — hand alias / prefix / typo`, '', '| distinct | occ | kw | seen | canonical | rule | lines |', '|---|---|---|---|---|---|---|');
for (const p of fixedByAlias) L.push(`| ${p.distinct} | ${p.occurrences} | ${[...p.kws].join('/')} | ${q(p.raw)} | ${q([...p.canonical].join(' / '))} | ${[...p.rules].join('; ')} | ${[...p.lines].join('/')} |`);
L.push('', `### c3. LOC phrases unmatched after all tiers (${unmatchedAliased.length}) — non-stations, off-map places, feed typos`, '', '| distinct | occ | kw | role | phrase | lines |', '|---|---|---|---|---|---|');
for (const p of unmatchedAliased) L.push(`| ${p.distinct} | ${p.occurrences} | ${[...p.kws].join('/')} | ${[...p.roles].join('/')} | ${q(p.raw)} | ${[...p.lines].join('/')} |`);
L.push('', `### c4. Non-location capitalised phrases after the keywords (${unmatchedStrict.filter((p) => p.cls !== 'LOC').length}) — the noise a parser must skip`, '', '| class | distinct | kw | phrase |', '|---|---|---|---|');
for (const p of unmatchedStrict.filter((p) => p.cls !== 'LOC')) L.push(`| ${p.cls} | ${p.distinct} | ${[...p.kws].join('/')} | ${q(p.raw)} |`);
L.push('', `### c5. Phrases carrying a direction suffix/qualifier (${dirPhrases.length})`, '', '| distinct | phrase | dir |', '|---|---|---|');
for (const p of dirPhrases) L.push(`| ${p.distinct} | ${q(p.raw)} | ${[...p.dir].join('/')} |`);

H('## (d) Parseability classification');
L.push('FULL = every location token resolves to a station whose `lineId` is the line the string was published under (slash compounds part-wise; hand-alias sets if any member is on-line). PARTIAL = at least one token fails. NONE = no location token (line-wide).', '');
L.push('Two token sets: **all** = every LOC-class phrase (the task definition; includes ticket-acceptance and advice mentions); **attach** = roles SECTION/CAUSE/AT/ROUTE/DIRECTION only, i.e. tokens a map would actually attach (MENTION excluded). `attach (any line)` drops the on-line requirement — a cause station on a shared corridor (Neasden on the Metropolitan) still resolves to a real place.', '');
L.push('| tier | token set | FULL | PARTIAL | NONE | FULL occ | PARTIAL occ | NONE occ |', '|---|---|---|---|---|---|---|---|');
for (const t of TIERS) for (const set of ['all', 'attach', 'attachAnyLine']) { const c = tally(`${set}_${t}`), w = tally(`${set}_${t}`, true); L.push(`| ${t.toUpperCase()} | ${set === 'attachAnyLine' ? 'attach (any line)' : set} | ${c.FULL} | ${c.PARTIAL} | ${c.NONE} | ${w.FULL} | ${w.PARTIAL} | ${w.NONE} |`); }
for (const t of ['relaxed', 'aliased']) { const c = tally(`policy_${t}`), w = tally(`policy_${t}`, true); L.push(`| ${t.toUpperCase()} | **policy** | ${c.FULL} | ${c.PARTIAL} | ${c.NONE} | ${w.FULL} | ${w.PARTIAL} | ${w.NONE} |`); }
L.push('', '**policy** = the recommended parser contract: only tokens in the stated line\'s own PRIMARY sentence (sentences containing replacement-bus / ticket / "use …" / "will not operate" / "are running" / timetable text, or naming another line or operator, are ignored); SECTION / ROUTE / DIRECTION tokens need at least one on-line resolution (alternative endpoints "A / B" keep the on-line one); CAUSE / AT tokens may resolve to any gazetteer station (rendered as a point, not tied to the line).', '');
{
  const secOnly = rows.filter((r) => r.primary.length === 0 && r.secondaryTokens.length > 0);
  L.push(`Strings whose attachable tokens are ALL in secondary/other-line sentences (policy → NONE, i.e. line-wide, although the text names places): ${secOnly.length} — ${secOnly.slice(0, 8).map((r) => `[${[...r.lineIds].join('/')}] "${trunc(r.text, 90)}"`).join('; ')}`);
}
const policyPartial = rows.filter((r) => r.cls.policy_aliased === 'PARTIAL').sort((a, b) => b.count - a.count);
L.push('', `### d0. PARTIAL under the policy contract, ALIASED tier (${policyPartial.length}) — the true residue`, '', '| line | occ | failing tokens | reason |', '|---|---|---|---|');
for (const r of policyPartial) L.push(`| ${[...r.lineIds].join('/')} | ${r.count} | ${q(r.primary.filter((p) => !policyOkReport(p)).map((p) => `${p.role}:${p.kw} "${p.raw}"` + (p.aliased.resolved ? ` [on ${[...new Set(p.aliased.parts.flatMap((x) => x.hits.map((h) => h.lineId)))].join('/')}, not ${[...r.lineIds].join('/')}]` : ' [no hit]')).join('; '))} | ${q(trunc(r.text, 150))} |`);
L.push('', '### "Carries a location phrase" — reconciling the earlier 428/604', '', '| definition | distinct strings |', '|---|---|');
for (const [k, v] of Object.entries(naive)) L.push(`| ${q(k)} | ${v} |`);
const partialAttach = rows.filter((r) => r.cls.attach_aliased === 'PARTIAL').sort((a, b) => b.count - a.count);
L.push('', `### d1. PARTIAL — attach set, ALIASED tier (${partialAttach.length}) — the residue a deterministic parser cannot place on-line`, '', '| line | occ | failing tokens | reason |', '|---|---|---|---|');
for (const r of partialAttach) L.push(`| ${[...r.lineIds].join('/')} | ${r.count} | ${q(failing(r, 'aliased', r.attach).join('; '))} | ${q(trunc(r.text, 150))} |`);
const partialAllOnly = rows.filter((r) => r.cls.all_aliased === 'PARTIAL' && r.cls.attach_aliased !== 'PARTIAL').sort((a, b) => b.count - a.count);
L.push('', `### d2. PARTIAL only because of MENTION-role tokens, ALIASED tier (${partialAllOnly.length}) — ticket acceptance / advice / timetable lines naming other lines' stations`, '', '| line | occ | failing MENTION tokens | reason |', '|---|---|---|---|');
for (const r of partialAllOnly) L.push(`| ${[...r.lineIds].join('/')} | ${r.count} | ${q(failing(r, 'aliased', r.loc).join('; '))} | ${q(trunc(r.text, 150))} |`);
const partialStrictOnly = rows.filter((r) => r.cls.all_strict === 'PARTIAL' && r.cls.all_aliased !== 'PARTIAL').sort((a, b) => b.count - a.count);
L.push('', `### d3. PARTIAL under STRICT, FULL after RELAXED/ALIASED (${partialStrictOnly.length}) — first 60`, '', '| line | occ | failing tokens (strict) | reason |', '|---|---|---|---|');
for (const r of partialStrictOnly.slice(0, 60)) L.push(`| ${[...r.lineIds].join('/')} | ${r.count} | ${q(failing(r, 'strict', r.loc).join('; '))} | ${q(trunc(r.text, 130))} |`);
L.push('', `### d4. NONE (line-wide) — ${noneStrings.length} strings, grouped by L2 skeleton`, '', '| distinct | occ | skeleton |', '|---|---|---|');
{ const m = new Map(); for (const r of noneStrings) { const e = m.get(r.skelRelaxedL2) ?? { distinct: 0, occ: 0 }; e.distinct++; e.occ += r.count; m.set(r.skelRelaxedL2, e); }
  for (const [k, e] of [...m.entries()].sort((a, b) => b[1].distinct - a[1].distinct).slice(0, 40)) L.push(`| ${e.distinct} | ${e.occ} | ${q(trunc(k, 170))} |`); }

H('## (e) Ambiguity cases');
L.push(`### e1. Resolved names that exist on 2+ lines with DIFFERENT station ids — ${multiIdInCorpus.length} of the ${multiIdNames.size} such names in the gazetteer occur as resolved tokens`, '', '| name | lineId:id |', '|---|---|');
for (const x of multiIdInCorpus.sort((a, b) => a.name.localeCompare(b.name))) L.push(`| ${x.name} | ${x.ids.join(', ')} |`);
L.push('', `### e2. Multi-section strings (2+ "between", or "between A and B, and C and D") — ${multiSection.length}`, '', '| line | occ | reason |', '|---|---|---|');
for (const r of multiSection.sort((a, b) => b.count - a.count)) L.push(`| ${[...r.lineIds].join('/')} | ${r.count} | ${q(trunc(r.text, 220))} |`);
L.push('', `### e3. Direction suffixes / "towards" / "in both directions" — ${directional.length}`, '', '| line | occ | reason |', '|---|---|---|');
for (const r of directional.sort((a, b) => b.count - a.count)) L.push(`| ${[...r.lineIds].join('/')} | ${r.count} | ${q(trunc(r.text, 220))} |`);
L.push('', `### e4. "via" — ${viaRows.length} strings; "via <STN>" routing ${viaStation.length}; the rest are "via any reasonable route" ticket text`, '', '| line | occ | via <STN>? | reason |', '|---|---|---|---|');
for (const r of viaRows.sort((a, b) => (viaStation.includes(b) - viaStation.includes(a)) || b.count - a.count)) L.push(`| ${[...r.lineIds].join('/')} | ${r.count} | ${viaStation.includes(r) ? 'yes' : 'no'} | ${q(trunc(r.text, 200))} |`);
L.push('', `### e5. "rest of the line" / "all other routes" / "entire line" — ${restOfLine.length} strings (one string carries a section severity AND a different line-wide severity) — top 30`, '', '| line | occ | reason |', '|---|---|---|');
for (const r of restOfLine.sort((a, b) => b.count - a.count).slice(0, 30)) L.push(`| ${[...r.lineIds].join('/')} | ${r.count} | ${q(trunc(r.text, 200))} |`);
L.push('', `### e6. Dated planned closures (weekday + day number) — ${dated.length} strings; statuses: ${[...new Set(dated.flatMap((r) => [...r.statuses]))].join(', ')}`, '', '| line | occ | status | reason |', '|---|---|---|---|');
for (const r of dated.sort((a, b) => b.count - a.count)) L.push(`| ${[...r.lineIds].join('/')} | ${r.count} | ${[...r.statuses].join('/')} | ${q(trunc(r.text, 200))} |`);
L.push('', `### e7. "Replacement bus" sentences — ${replacementBus.length} strings (the bus's own between/via stations are on the same line, so a naive parser widens the closure)`, '', '| line | occ | reason |', '|---|---|---|');
for (const r of replacementBus.sort((a, b) => b.count - a.count)) L.push(`| ${[...r.lineIds].join('/')} | ${r.count} | ${q(trunc(r.text, 260))} |`);
L.push('', `### e8. Resolved stations NOT on the stated line (ALIASED) — SECTION ${offLine.section.length}, CAUSE/AT ${offLine.cause.length}, MENTION ${offLine.mention.length} token instances; ticket-acceptance strings: ${ticketAcceptance.length}`);
for (const [b, title] of [['section', 'e8a. SECTION tokens off-line (a "between" endpoint the stated line does not serve)'], ['cause', 'e8b. CAUSE/AT tokens off-line (incident at a station on a shared corridor or a non-stop pass-through)'], ['mention', 'e8c. MENTION tokens off-line (other operators\' places in ticket/advice text) — first 40']]) {
  L.push('', `#### ${title}`, '', '| phrase | role | stated | exists on | occ | reason |', '|---|---|---|---|---|---|');
  for (const x of offLine[b].slice(0, b === 'mention' ? 40 : 200)) L.push(`| ${q(x.phrase)} | ${x.role} | ${x.stated} | ${x.on} | ${x.count} | ${q(trunc(x.text, 120))} |`);
}
L.push('', `### e9. Bare "X to Y" sections with no "from" — ${bareXtoY.length} strings (e.g. "Severe delays Baker Street to Aldgate")`, '', '| line | occ | reason |', '|---|---|---|');
for (const r of bareXtoY) L.push(`| ${[...r.lineIds].join('/')} | ${r.count} | ${q(trunc(r.text, 200))} |`);
L.push('', `### e10. Station names matched by the anywhere-matcher but NOT anchored to a keyword / list separator — ${unanchored.size} contexts (false-positive risk if a parser matched names anywhere)`, '', '| distinct | name | context |', '|---|---|---|');
for (const e of [...unanchored.values()].sort((a, b) => b.distinct - a.distinct)) L.push(`| ${e.distinct} | ${e.name} | …${q(e.context)}… |`);
L.push('', `### e11. Context guard: "Bank" suppressed before "holiday" / "/public" in ${suppressedTotal} positions. Without it the anywhere-matcher tags Bank station in "Bank Holiday Monday".`);

writeFileSync(join(OUT_DIR, 'report.md'), L.join('\n') + '\n');
const ser = (k, v) => (v instanceof Set ? [...v] : v);
const summary = {
  corpus: { files: corpus.files, snapshots: corpus.snapshots, occurrences: corpus.occurrences, distinct: rows.length, days: corpus.days.size, lineIds: [...corpus.lineIds].sort(), multiLineStrings: multiLine.length },
  gazetteer: { entries: gaz.entries.length, strictKeys: gaz.strict.size, relaxedKeys: gaz.relaxed.size, handAliases: Object.keys(HAND_ALIASES).length },
  skeletons: { strictL1: skStrictL1.total, relaxedL1: skRelaxedL1.total, relaxedL2: skRelaxedL2.total },
  phrases: { distinctRaw: allPhrases.length, loc: locPhrases.length, byClass: { DATE: allPhrases.filter((p) => p.cls === 'DATE').length, OPERATOR: allPhrases.filter((p) => p.cls === 'OPERATOR').length, STATUS: allPhrases.filter((p) => p.cls === 'STATUS').length }, locStrictHit: locPhrases.filter((p) => p.strictHit).length, locRelaxedHit: locPhrases.filter((p) => p.relaxedHit).length, locAliasedHit: locPhrases.filter((p) => p.aliasedHit).length, locUnmatched: unmatchedAliased.length, roleCounts },
  classification: Object.fromEntries([...TIERS.flatMap((t) => ['all', 'attach', 'attachAnyLine'].map((s) => `${s}_${t}`)), 'policy_relaxed', 'policy_aliased'].map((k) => [k, { ...tally(k), occ: tally(k, true) }])),
  hasLocationPhrase: naive,
  ambiguities: { multiIdNamesInCorpus: multiIdInCorpus.length, multiIdNamesInGazetteer: multiIdNames.size, multiSection: multiSection.length, directional: directional.length, via: viaRows.length, viaStation: viaStation.length, restOfLine: restOfLine.length, dated: dated.length, replacementBus: replacementBus.length, ticketAcceptance: ticketAcceptance.length, offLineSection: offLine.section.length, offLineCause: offLine.cause.length, offLineMention: offLine.mention.length, bareXtoY: bareXtoY.length, unanchoredContexts: unanchored.size, bankGuardSuppressed: suppressedTotal },
};
writeFileSync(join(OUT_DIR, 'results.json'), JSON.stringify({
  ...summary,
  topSkeletonsL2: skRelaxedL2.list.slice(0, TOP_N).map((e) => ({ skeleton: e.skeleton, distinct: e.distinct, occurrences: e.occurrences, example: e.example, lineIds: [...e.lineIds] })),
  aliasesFixedByRelax: fixedByRelax.map((p) => ({ seen: p.raw, canonical: [...p.canonical], rules: [...p.rules], distinct: p.distinct, occurrences: p.occurrences })),
  aliasesFixedByAliased: fixedByAlias.map((p) => ({ seen: p.raw, canonical: [...p.canonical], rules: [...p.rules], distinct: p.distinct, occurrences: p.occurrences })),
  unmatchedLoc: unmatchedAliased.map((p) => ({ phrase: p.raw, roles: [...p.roles], kws: [...p.kws], distinct: p.distinct, occurrences: p.occurrences, lines: [...p.lines] })),
  multiIdInCorpus,
  reasons: rows.map((r) => ({ text: r.text, count: r.count, lineIds: [...r.lineIds], days: [...r.days], statuses: [...r.statuses], cls: r.cls, skeletonL2: r.skelRelaxedL2, tokens: r.loc.map((p) => ({ kw: p.kw, role: p.role, sentence: p.sentence, raw: p.raw, rawExt: p.rawExt, dir: p.dir, strict: [p.strict.resolved, p.strict.onLine], relaxed: [p.relaxed.resolved, p.relaxed.onLine], aliased: [p.aliased.resolved, p.aliased.onLine, p.aliased.rules] })) })),
}, ser, 2));
console.log(JSON.stringify(summary, ser, 2));
