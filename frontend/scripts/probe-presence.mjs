// Probe: how often do vehicles vanish from the Arrivals feed and come back?
// Tracks per-key presence across polls; also dumps one full raw prediction.
const LINES = 'victoria,central,jubilee,northern,metropolitan,district,waterloo-city';
const POLLS = 12;
const INTERVAL_MS = 10_000;

const presence = new Map(); // key → array of 0/1 per poll
const keyKind = new Map(); // key → 'vehicleId' | 'synthetic'
let rawSample = null;

for (let i = 0; i < POLLS; i++) {
  const res = await fetch(`http://localhost:3000/api/arrivals?lines=${LINES}`);
  const preds = await res.json();
  if (!rawSample && preds.length) {
    rawSample = preds.find((p) => p.currentLocation) ?? preds[0];
  }
  const seen = new Set();
  for (const p of preds) {
    let key;
    if (p.vehicleId && p.vehicleId !== '000') {
      key = `${p.lineId}:${p.vehicleId}`;
      keyKind.set(key, 'vehicleId');
    } else if (p.currentLocation) {
      key = `${p.lineId}|${p.currentLocation}`;
      keyKind.set(key, 'synthetic');
    } else continue;
    seen.add(key);
  }
  for (const key of new Set([...presence.keys(), ...seen])) {
    const arr = presence.get(key) ?? Array(i).fill(0);
    while (arr.length < i) arr.push(0);
    arr.push(seen.has(key) ? 1 : 0);
    presence.set(key, arr);
  }
  if (i < POLLS - 1) await new Promise((r) => setTimeout(r, INTERVAL_MS));
}

// analyse: flicker = present, absent for 1-3 polls, present again
const stats = { vehicleId: { keys: 0, flickers: 0, longestGapReturned: 0 }, synthetic: { keys: 0, flickers: 0, longestGapReturned: 0 } };
const flickerExamples = [];
for (const [key, arr] of presence) {
  const kind = keyKind.get(key);
  const s = stats[kind];
  s.keys++;
  const str = arr.join('');
  // gaps: 1..N zeros between ones
  const gaps = [...str.matchAll(/1(0+)1/g)].map((m) => m[1].length);
  if (gaps.length) {
    s.flickers += gaps.length;
    s.longestGapReturned = Math.max(s.longestGapReturned, ...gaps);
    if (flickerExamples.length < 10 && kind === 'vehicleId') {
      flickerExamples.push(`${key}: ${str}`);
    }
  }
}
// synthetic key churn: how many synthetic keys lived only 1-2 polls (identity drift)
let shortLivedSynthetic = 0;
for (const [key, arr] of presence) {
  if (keyKind.get(key) !== 'synthetic') continue;
  const total = arr.reduce((a, b) => a + b, 0);
  if (total <= 2) shortLivedSynthetic++;
}

console.log('=== RAW PREDICTION SAMPLE ===');
console.log(JSON.stringify(rawSample, null, 1));
console.log('=== PRESENCE STATS (12 polls / 2 min) ===');
console.log(JSON.stringify({ ...stats, shortLivedSynthetic }, null, 1));
console.log('=== vehicleId FLICKER EXAMPLES (1=present 0=absent) ===');
for (const e of flickerExamples) console.log(e);
