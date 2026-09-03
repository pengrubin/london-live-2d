// How much of the disruption picture TfL already states as machine-readable
// NaPTAN ids — the measurement that decides whether a sentence parser is worth
// building at all.
//
//   node scripts/disruption-coverage.mjs [archiveDir] [--by-sentence]
//
// Default archiveDir is ~/bus-archive/tube-status. Rows written before the
// recorder started asking TfL for ?detail=true carry no structured fields and
// are reported separately rather than counted as misses — they prove nothing.
//
// Each non-good status entry falls into exactly one bucket:
//   section   at least one affectedRoutes entry that is a real slice (e:false)
//             with >= 2 stop ids — the map can draw the closed track itself
//   stops     no slice, but affectedStops ids — the map can ring the stations
//   wholeLine severity 1/2/20, or every affectedRoutes entry is a whole route:
//             the notice genuinely has no location, so line-level is correct
//   textOnly  none of the above — only a parser could place this one
//
// The decision rule: a parser (spec P1) earns its keep only if textOnly is a
// meaningful share of what riders actually see. wholeLine is not a miss.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const GOOD_SERVICE = 10;
const NO_ISSUES = 18;
const WHOLE_LINE_SEVERITIES = new Set([1, 2, 20]);
const MIN_SECTION_IDS = 2;
/** Best-to-worst, so a sentence keeps its most locatable observation. */
const RANK = { section: 0, stops: 1, wholeLine: 2, textOnly: 3 };

const args = process.argv.slice(2);
const bySentence = args.includes('--by-sentence');
const dir = args.find((a) => !a.startsWith('--')) ?? join(homedir(), 'bus-archive/tube-status');

/** Which bucket one status entry belongs to. */
function classify(entry) {
  const routes = Array.isArray(entry.ar) ? entry.ar : [];
  const sections = routes.filter((r) => r.e !== true && Array.isArray(r.st) && r.st.length >= MIN_SECTION_IDS);
  if (sections.length > 0) return 'section';
  if (Array.isArray(entry.as) && entry.as.length > 0) return 'stops';
  if (WHOLE_LINE_SEVERITIES.has(entry.s)) return 'wholeLine';
  if (routes.length > 0 && routes.every((r) => r.e === true)) return 'wholeLine';
  return 'textOnly';
}

/** True once the row was written by a recorder asking for detail=true. */
function rowIsDetailed(row) {
  return row.lines.some((l) => l.st.some((s) => s.c !== undefined || s.ar !== undefined || s.v !== undefined));
}

const days = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort();
const totals = { section: 0, stops: 0, wholeLine: 0, textOnly: 0 };
const sentences = new Map(); // canonical sentence -> { bucket, count, lines:Set }
const perDay = [];
let preDetailRows = 0;
let preDetailStatuses = 0;

for (const file of days) {
  const day = file.replace('.jsonl', '');
  const counts = { section: 0, stops: 0, wholeLine: 0, textOnly: 0 };
  let rows = 0;
  let detailedRows = 0;

  for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!Array.isArray(row.lines)) continue;
    rows += 1;

    const detailed = rowIsDetailed(row);
    if (detailed) detailedRows += 1;

    for (const l of row.lines) {
      for (const st of l.st ?? []) {
        if (st.s === GOOD_SERVICE || st.s === NO_ISSUES) continue;
        if (!detailed) {
          preDetailStatuses += 1;
          continue;
        }
        const bucket = classify(st);
        counts[bucket] += 1;
        totals[bucket] += 1;
        const key = (st.r ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
        if (!key) continue;
        const seen = sentences.get(key);
        if (seen) {
          seen.count += 1;
          seen.lines.add(l.id);
          // A sentence keeps its best observed bucket: TfL sometimes publishes
          // the ids a poll or two after the text.
          if (RANK[bucket] < RANK[seen.bucket]) seen.bucket = bucket;
        } else {
          sentences.set(key, { bucket, count: 1, lines: new Set([l.id]), text: st.r });
        }
      }
    }
  }

  preDetailRows += rows - detailedRows;
  if (detailedRows > 0) perDay.push({ day, rows, detailedRows, ...counts });
}


const sum = totals.section + totals.stops + totals.wholeLine + totals.textOnly;
const pct = (n) => (sum === 0 ? '—' : `${((n / sum) * 100).toFixed(1)}%`);

console.log(`archive: ${dir}`);
console.log(`days with detail=true rows: ${perDay.length} of ${days.length}`);
if (preDetailRows > 0) {
  console.log(`ignored: ${preDetailRows} rows / ${preDetailStatuses} statuses written before detail=true (no structured fields to have)`);
}
if (sum === 0) {
  console.log('\nNo detailed statuses yet. Let the recorder run, then re-run this.');
  process.exit(0);
}

console.log('\nper day (non-good status entries):');
console.log('day         rows  detail  section  stops  wholeLine  textOnly');
for (const d of perDay) {
  console.log(
    `${d.day}  ${String(d.rows).padStart(4)}  ${String(d.detailedRows).padStart(6)}  ` +
      `${String(d.section).padStart(7)}  ${String(d.stops).padStart(5)}  ` +
      `${String(d.wholeLine).padStart(9)}  ${String(d.textOnly).padStart(8)}`,
  );
}

console.log('\nby occurrence (what a rider actually sees):');
console.log(`  drawable as track sections : ${totals.section} (${pct(totals.section)})`);
console.log(`  drawable as station rings  : ${totals.stops} (${pct(totals.stops)})`);
console.log(`  genuinely line-wide        : ${totals.wholeLine} (${pct(totals.wholeLine)})`);
console.log(`  only a parser could place  : ${totals.textOnly} (${pct(totals.textOnly)})`);

const placed = totals.section + totals.stops;
console.log(
  `\n  => ${pct(placed)} lands on the map from TfL's own ids; ` +
    `${pct(totals.wholeLine)} is honestly line-wide; ${pct(totals.textOnly)} would need P1.`,
);

if (bySentence) {
  const distinct = [...sentences.values()].sort((a, b) => b.count - a.count);
  const byBucket = { section: 0, stops: 0, wholeLine: 0, textOnly: 0 };
  for (const s of distinct) byBucket[s.bucket] += 1;
  console.log(`\ndistinct sentences: ${distinct.length}`);
  for (const b of ['section', 'stops', 'wholeLine', 'textOnly']) {
    console.log(`  ${b.padEnd(10)}: ${byBucket[b]}`);
  }
  const misses = distinct.filter((s) => s.bucket === 'textOnly').slice(0, 15);
  if (misses.length > 0) {
    console.log('\ntop text-only sentences (the P1 backlog, most frequent first):');
    for (const m of misses) {
      console.log(`  ${String(m.count).padStart(4)}x [${[...m.lines].join(',')}] ${m.text?.slice(0, 110)}`);
    }
  }
}
