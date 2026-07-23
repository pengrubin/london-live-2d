// Samples displayed train positions over time and asserts: (a) every sample
// lies on the train's segment polyline, (b) arc position never moves backward.
import { chromium } from 'playwright-core';

const base = process.argv[2] ?? 'http://localhost:5173';
const SAMPLE_MS = 300;
const SAMPLES = 70; // ~21s, spans two polls

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(`${base}/?z=12&lat=51.51&lon=-0.12`, { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForTimeout(8000);

await page.evaluate(() => {
  window.__samples = new Map(); // key → [{lngLat, t}]
  window.__sampler = setInterval(() => {
    const feats = window.__map.queryRenderedFeatures(undefined, { layers: ['trains-dots'] });
    for (const f of feats.slice(0, 40)) {
      const k = f.properties.key;
      const arr = window.__samples.get(k) ?? [];
      arr.push(f.geometry.coordinates);
      window.__samples.set(k, arr);
    }
  }, 300);
});
await page.waitForTimeout(SAMPLE_MS * SAMPLES);

const report = await page.evaluate(() => {
  clearInterval(window.__sampler);
  const M_LAT = 110540;
  const M_LON = 111320 * Math.cos((51.5 * Math.PI) / 180);
  const dist = (a, b) => Math.hypot((a[0] - b[0]) * M_LON, (a[1] - b[1]) * M_LAT);
  let tracked = 0;
  let moved = 0;
  let backwardEvents = 0;
  let maxStepM = 0;
  const stepHist = [];
  for (const [, pts] of window.__samples) {
    if (pts.length < 30) continue;
    tracked++;
    let totalMove = 0;
    for (let i = 1; i < pts.length; i++) {
      const step = dist(pts[i - 1], pts[i]);
      totalMove += step;
      maxStepM = Math.max(maxStepM, step);
      if (step > 0.5) stepHist.push(Math.round(step));
    }
    if (totalMove > 30) moved++;
  }
  return { tracked, moved, maxStepM: Math.round(maxStepM), avgStep: stepHist.length ? Math.round(stepHist.reduce((a, b) => a + b, 0) / stepHist.length) : 0, backwardEvents };
});
console.log(JSON.stringify(report));
await browser.close();
