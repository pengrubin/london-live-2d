// Samples rendered bus positions (buses-icons) at 1 Hz for 30 s and reports
// per-bus displacement, frozen spans, single-second jumps, and rAF frame timing.
import { chromium } from 'playwright-core';

const base = process.argv[2] ?? 'http://localhost:5173';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(`${base}/?z=14&lat=51.51&lon=-0.12`, { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForTimeout(20000);

await page.evaluate(() => {
  window.__samples = new Map(); // bus id → [{c:[lon,lat], t}]
  window.__frameDts = [];
  let last = performance.now();
  const loop = (ts) => {
    window.__frameDts.push(ts - last);
    last = ts;
    window.__frameRaf = requestAnimationFrame(loop);
  };
  window.__frameRaf = requestAnimationFrame(loop);
  window.__sampler = setInterval(() => {
    const t = Date.now();
    const feats = window.__map.queryRenderedFeatures(undefined, { layers: ['buses-icons'] });
    const seen = new Set();
    for (const f of feats) {
      const id = f.properties.id;
      if (seen.has(id)) continue;
      seen.add(id);
      const arr = window.__samples.get(id) ?? [];
      arr.push({ c: f.geometry.coordinates, t });
      window.__samples.set(id, arr);
    }
  }, 1000);
});
await page.waitForTimeout(31000);

const report = await page.evaluate(() => {
  clearInterval(window.__sampler);
  cancelAnimationFrame(window.__frameRaf);
  const M_LAT = 110540;
  const M_LON = 111320 * Math.cos((51.5 * Math.PI) / 180);
  const dist = (a, b) => Math.hypot((a[0] - b[0]) * M_LON, (a[1] - b[1]) * M_LAT);
  const buses = [];
  for (const [id, pts] of window.__samples) {
    if (pts.length < 28) continue; // present for (almost) the whole window
    let total = 0;
    let maxStep = 0;
    let frozenRun = 0;
    let maxFrozenRunS = 0;
    const steps = [];
    for (let i = 1; i < pts.length; i++) {
      const s = dist(pts[i - 1].c, pts[i].c);
      steps.push(Math.round(s * 10) / 10);
      total += s;
      maxStep = Math.max(maxStep, s);
      if (s < 0.5) {
        frozenRun++;
        maxFrozenRunS = Math.max(maxFrozenRunS, frozenRun);
      } else {
        frozenRun = 0;
      }
    }
    buses.push({
      id,
      samples: pts.length,
      totalM: Math.round(total),
      maxStepM: Math.round(maxStep * 10) / 10,
      maxFrozenSpanS: maxFrozenRunS,
      steps,
    });
  }
  buses.sort((a, b) => b.totalM - a.totalM);
  const globalMaxStep = buses.reduce((m, b) => Math.max(m, b.maxStepM), 0);
  const movers = buses.filter((b) => b.totalM > 50).length;
  const jumpBuses = buses.filter((b) => b.maxStepM > 200).length;
  const frozenMovers = buses.filter((b) => b.totalM > 50 && b.maxFrozenSpanS >= 10).length;
  const dts = window.__frameDts.slice().sort((a, b) => a - b);
  const p95 = dts.length ? dts[Math.floor(dts.length * 0.95)] : 0;
  const avg = dts.length ? dts.reduce((a, b) => a + b, 0) / dts.length : 0;
  const rendered = window.__map.queryRenderedFeatures(undefined, { layers: ['buses-icons'] }).length;
  return {
    trackedFullWindow: buses.length,
    moversOver50m: movers,
    busesWithJumpOver200m: jumpBuses,
    moversWithFrozen10sSpan: frozenMovers,
    globalMaxStepM: globalMaxStep,
    // 3 buses genuinely on the move for the whole window: moved > 50 m and
    // never idle 10 s (stationary buses legitimately freeze — velocity is 0).
    onTheMove3: buses.filter((b) => b.totalM > 50 && b.maxFrozenSpanS < 10).slice(0, 3),
    top3: buses.slice(0, 3),
    medianBus: buses[Math.floor(buses.length / 2)],
    p95FrameMs: Math.round(p95 * 10) / 10,
    avgFrameMs: Math.round(avg * 10) / 10,
    renderedFeatures: rendered,
  };
});
console.log(JSON.stringify(report, null, 1));
await browser.close();
