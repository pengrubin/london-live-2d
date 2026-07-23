// Empirical probe: does TfL's timeToStation regress / linger at "due"?
// Polls the arrivals proxy and tracks per-vehicle countdown sequences.
const LINES = 'victoria,central,jubilee,northern';
const POLLS = 13;
const INTERVAL_MS = 10_000;

const timeline = new Map(); // vehKey → [{t, naptanId, stationName, tts}]

for (let i = 0; i < POLLS; i++) {
  const res = await fetch(`http://localhost:3000/api/arrivals?lines=${LINES}`);
  const preds = await res.json();
  const t = Math.round((i * INTERVAL_MS) / 1000);
  const byVeh = new Map();
  for (const p of preds) {
    if (!p.vehicleId || p.vehicleId === '000') continue;
    const k = `${p.lineId}:${p.vehicleId}`;
    (byVeh.get(k) ?? byVeh.set(k, []).get(k)).push(p);
  }
  for (const [k, list] of byVeh) {
    list.sort((a, b) => a.timeToStation - b.timeToStation);
    const nearest = list[0];
    (timeline.get(k) ?? timeline.set(k, []).get(k)).push({
      t,
      naptanId: nearest.naptanId,
      station: (nearest.stationName ?? '').replace(/ Underground Station$/, ''),
      tts: nearest.timeToStation,
      second: list[1]
        ? { station: (list[1].stationName ?? '').replace(/ Underground Station$/, ''), tts: list[1].timeToStation }
        : null,
    });
  }
  if (i < POLLS - 1) await new Promise((r) => setTimeout(r, INTERVAL_MS));
}

let regressions = 0;
let stuckDue = 0;
const examples = [];
for (const [k, seq] of timeline) {
  if (seq.length < 8) continue;
  // countdown regression at the same next-stop
  for (let i = 1; i < seq.length; i++) {
    if (seq[i].naptanId === seq[i - 1].naptanId && seq[i].tts > seq[i - 1].tts + 15) {
      regressions++;
      if (examples.length < 6) {
        examples.push(
          `REGRESS ${k} @${seq[i].station}: ${seq[i - 1].tts}s → ${seq[i].tts}s (t=${seq[i].t})`,
        );
      }
    }
  }
  // lingering "due": nearest pred pinned <=20s at same stop for 40s+ while the
  // SECOND pred (next stop ahead) keeps counting down = train actually moving
  let run = 0;
  for (let i = 0; i < seq.length; i++) {
    const s = seq[i];
    if (s.tts <= 20 && (i === 0 || s.naptanId === seq[i - 1].naptanId)) run++;
    else run = 0;
    if (run >= 4) {
      const secondFalling =
        seq[i].second && seq[i - 4]?.second &&
        seq[i].second.station === seq[i - 4].second.station &&
        seq[i].second.tts < seq[i - 4].second.tts - 20;
      if (secondFalling) {
        stuckDue++;
        if (examples.length < 12) {
          examples.push(
            `STUCK-DUE ${k} pinned at ${s.station} (tts=${s.tts}s for 40s+) while next-stop ${seq[i].second.station} fell ${seq[i - 4].second.tts}s→${seq[i].second.tts}s`,
          );
        }
        run = 0;
      }
    }
  }
}
console.log(
  JSON.stringify({ vehiclesTracked: [...timeline.values()].filter((s) => s.length >= 8).length, regressions, stuckDue }),
);
for (const e of examples) console.log(e);
