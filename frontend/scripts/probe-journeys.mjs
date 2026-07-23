// Long recording: where do trains vanish — at their stated destination (a
// genuine short-working/terminus) or mid-route (feed dropout)?
const LINES = 'victoria,central,jubilee,northern,metropolitan,district,piccadilly,bakerloo';
const POLLS = 72; // 12 minutes
const INTERVAL_MS = 10_000;
const GONE_AFTER = 4; // absent 4 consecutive polls (40s) = really gone

const journeys = new Map(); // key → {firstT,lastT,lastNext,lastNextId,destId,dest,lastLoc,absent}

for (let i = 0; i < POLLS; i++) {
  try {
    const res = await fetch(`http://localhost:3000/api/arrivals?lines=${LINES}`);
    const preds = await res.json();
    const byKey = new Map();
    for (const p of preds) {
      if (!p.vehicleId || p.vehicleId === '000') continue;
      const k = `${p.lineId}:${p.vehicleId}`;
      const cur = byKey.get(k);
      if (!cur || p.timeToStation < cur.timeToStation) byKey.set(k, p);
    }
    for (const [k, p] of byKey) {
      const j = journeys.get(k) ?? { firstT: i, absent: 0 };
      j.lastT = i;
      j.absent = 0;
      j.lastNext = (p.stationName ?? '').replace(/ Underground Station$/, '');
      j.lastNextId = p.naptanId;
      j.destId = p.destinationNaptanId;
      j.dest = (p.destinationName ?? '').replace(/ Underground Station$/, '');
      j.lastTts = p.timeToStation;
      j.lastLoc = p.currentLocation ?? '';
      journeys.set(k, j);
    }
    for (const [k, j] of journeys) {
      if (!byKey.has(k)) j.absent++;
    }
  } catch {
    // one failed poll shouldn't kill a 12-minute recording
  }
  if (i < POLLS - 1) await new Promise((r) => setTimeout(r, INTERVAL_MS));
}

let atDestination = 0;
let midRoute = 0;
let stillPresent = 0;
const midRouteExamples = [];
const atDestExamples = [];
for (const [k, j] of journeys) {
  if (j.absent < GONE_AFTER) {
    stillPresent++;
    continue;
  }
  // vanished: was its final prediction pointing at its own destination?
  const finishing = j.lastNextId && j.destId && j.lastNextId === j.destId && j.lastTts < 120;
  if (finishing) {
    atDestination++;
    if (atDestExamples.length < 5) {
      atDestExamples.push(`${k} ended at its destination ${j.dest} (tts=${j.lastTts}s)`);
    }
  } else {
    midRoute++;
    if (midRouteExamples.length < 8) {
      midRouteExamples.push(
        `${k} vanished mid-route: next ${j.lastNext} (tts=${j.lastTts}s) dest ${j.dest} loc "${j.lastLoc}"`,
      );
    }
  }
}
console.log(
  JSON.stringify(
    { tracked: journeys.size, vanishedAtOwnDestination: atDestination, vanishedMidRoute: midRoute, stillPresent },
    null,
    1,
  ),
);
console.log('--- at-destination examples ---');
for (const e of atDestExamples) console.log(e);
console.log('--- mid-route vanish examples ---');
for (const e of midRouteExamples) console.log(e);
