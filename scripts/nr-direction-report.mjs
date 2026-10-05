// Bake report for the per-direction NR tracks (see nr-direction-tracks.mjs).
// Prints how many segments got a distinct b→a track, how far apart the two
// directions run, which pairs fell back to the shared reference, and which
// pairs ended up with a→b on the RIGHT of b→a (a keep-left inversion, caused
// by a direction tag or by tracks that swap sides). BAKE_DEBUG=<file> also
// dumps the per-segment decisions as JSON; BAKE_DEBUG_PAIR=<A-B> dumps one
// pair's corridor nodes (arc, lateral, adjacency, tags) and both paths to
// data/osm-cache/debug-<A-B>.json.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFrame, samplePolyline, separationSamples } from './nr-direction-tracks.mjs';

const quantile = (sorted, q) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : NaN;
const median = (xs) => quantile([...xs].sort((p, q) => p - q), 0.5);

// Signed offset of polyRev from poly, positive = polyRev LEFT of a→b travel.
function revSideMedian(poly, polyRev) {
  const frame = makeFrame(poly);
  const lat = samplePolyline(polyRev, 20).map((p) => frame.project(p).lateral);
  return median(lat);
}

export function reportDirections(directed, segmentsOut, prevBytes, newBytes) {
  const decisions = [];
  const pooled = [];
  const perSegMedian = [];
  let halfAt2p5 = 0;
  let halfAt5 = 0;
  const inverted = [];
  for (let k = 0; k < directed.length; k++) {
    const { seg, fwd, rev, corridorNodes } = directed[k];
    const out = segmentsOut[k];
    const d = {
      a: seg.a,
      b: seg.b,
      lenM: out.lenM,
      distinct: !!out.polyRev,
      corridorNodes,
      fwd: { fallback: fwd.fallback, wrongWayM: Math.round(fwd.wrongWayM), wrongWayAt: fwd.wrongWayAt ?? null },
      rev: { fallback: rev.fallback, wrongWayM: Math.round(rev.wrongWayM), wrongWayAt: rev.wrongWayAt ?? null },
    };
    if (out.polyRev) {
      const sep = separationSamples(out.poly, out.polyRev, 10);
      pooled.push(...sep);
      const m = median(sep);
      perSegMedian.push(m);
      if (sep.filter((x) => x >= 2.5).length * 2 >= sep.length) halfAt2p5++;
      if (sep.filter((x) => x >= 5).length * 2 >= sep.length) halfAt5++;
      d.sepMedianM = Math.round(m * 10) / 10;
      d.revSideM = Math.round(revSideMedian(out.poly, out.polyRev) * 10) / 10;
      if (d.revSideM > 0) inverted.push(d);
    }
    decisions.push(d);
  }
  const distinct = perSegMedian.length;
  const sortedPooled = pooled.sort((p, q) => p - q);
  const sortedSeg = [...perSegMedian].sort((p, q) => p - q);
  const fallbacks = decisions.filter((d) => d.fwd.fallback || d.rev.fallback);
  const wrongWay = decisions.filter((d) => d.fwd.wrongWayM > 0 || d.rev.wrongWayM > 0);

  console.log('\n── directions ──');
  console.log(`segments with a distinct polyRev: ${distinct}/${segmentsOut.length}`);
  console.log(
    `separation a→b vs b→a where distinct (10 m samples): median ${quantile(sortedPooled, 0.5).toFixed(1)} m, ` +
      `p90 ${quantile(sortedPooled, 0.9).toFixed(1)} m`,
  );
  console.log(
    `per-segment median separation: median ${quantile(sortedSeg, 0.5).toFixed(1)} m, ` +
      `p90 ${quantile(sortedSeg, 0.9).toFixed(1)} m`,
  );
  console.log(`distinct pairs apart >= 2.5 m on >= half their length: ${halfAt2p5}/${distinct}; >= 5 m: ${halfAt5}/${distinct}`);
  console.log(`corridor search fell back to the shared reference: ${fallbacks.length} segment(s)` +
    (fallbacks.length ? ` (${fallbacks.slice(0, 10).map((d) => `${d.a}-${d.b}`).join(', ')})` : ''));
  console.log(
    `segments running against a direction tag somewhere: ${wrongWay.length} ` +
      `(total ${wrongWay.reduce((s, d) => s + d.fwd.wrongWayM + d.rev.wrongWayM, 0)} m)`,
  );
  console.log(`keep-left inversions (a→b drawn right of b→a): ${inverted.length}` +
    (inverted.length ? ` — ${inverted.slice(0, 15).map((d) => `${d.a}-${d.b} (${d.revSideM} m)`).join(', ')}` : ''));
  console.log(
    `segments.json: ${(prevBytes / 1024).toFixed(0)} KB before → ${(newBytes / 1024).toFixed(0)} KB after ` +
      `(${prevBytes ? (newBytes / prevBytes).toFixed(2) : '–'}×)`,
  );
  if (process.env.BAKE_DEBUG) {
    writeFileSync(process.env.BAKE_DEBUG, JSON.stringify(decisions, null, 1));
    console.log(`decisions written to ${process.env.BAKE_DEBUG}`);
  }
}

export function dumpDebugPair(pair, directed, graph, dir) {
  const [pa, pb] = pair.split('-');
  const d = directed.find(({ seg }) => (seg.a === pa && seg.b === pb) || (seg.a === pb && seg.b === pa));
  if (!d) return;
  const nodes = [...d.nodes].map(([i, p]) => ({
    i,
    c: graph.coords[i],
    ...p,
    adj: graph.adjLists[i].filter((_, k) => k % 2 === 0),
    tags: graph.adjTags[i],
  }));
  writeFileSync(
    join(dir, `debug-${pair}.json`),
    JSON.stringify({ ref: d.seg.path, fwd: d.fwd.pts, rev: d.rev.pts, nodes }),
  );
}
