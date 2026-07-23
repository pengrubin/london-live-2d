// Samples performance.memory.usedJSHeapSize + DOM node count on an idle map
// page for a configurable duration. Usage:
//   node scripts/measure-memory.mjs [base] [durationMin] [sampleSec]
import { chromium } from 'playwright-core';

const base = process.argv[2] ?? 'http://localhost:5173';
const DURATION_MIN = Number(process.argv[3] ?? 8);
const SAMPLE_S = Number(process.argv[4] ?? 10);

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-precise-memory-info'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(`${base}/?z=12&lat=51.51&lon=-0.12`, { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForTimeout(8000); // let all layers boot

const samples = [];
const t0 = Date.now();
const totalSamples = Math.round((DURATION_MIN * 60) / SAMPLE_S);
for (let i = 0; i <= totalSamples; i++) {
  const s = await page.evaluate(() => ({
    heapMB: Math.round(performance.memory.usedJSHeapSize / 1048576 * 10) / 10,
    totalMB: Math.round(performance.memory.totalJSHeapSize / 1048576 * 10) / 10,
    dom: document.getElementsByTagName('*').length,
    detachedPopups: document.querySelectorAll('.maplibregl-popup').length,
  }));
  s.tS = Math.round((Date.now() - t0) / 1000);
  samples.push(s);
  console.log(JSON.stringify(s));
  if (i < totalSamples) await page.waitForTimeout(SAMPLE_S * 1000);
}

const at = (sec) => samples.reduce((b, s) => (Math.abs(s.tS - sec) < Math.abs(b.tS - sec) ? s : b));
const twoMin = at(120);
const final = samples[samples.length - 1];
console.log(
  JSON.stringify({
    summary: true,
    startMB: samples[0].heapMB,
    twoMinMB: twoMin.heapMB,
    finalMB: final.heapMB,
    ratioFinalToTwoMin: Math.round((final.heapMB / twoMin.heapMB) * 100) / 100,
    domStart: samples[0].dom,
    domFinal: final.dom,
  }),
);
await browser.close();
