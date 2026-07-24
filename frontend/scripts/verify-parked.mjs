// Dev-only acceptance helper for the parked-bus indicator.
// Parked needs 20 min of observed no-movement, so this runs ~21-26 min:
// load z=14 central London, wait past the threshold, then count parked vs
// moving in both tiers and screenshot a parked cluster at z=14.
// Usage: node scripts/verify-parked.mjs [outfile]
import { chromium } from 'playwright-core';

const OUT = process.argv[2] ?? '/tmp/parked-buses.png';
const PARKED_AFTER_MS = 20 * 60_000;
const EXTRA_WAIT_MS = 90_000; // one poll cycle + slack past the threshold
const MAX_WAIT_MS = 26 * 60_000;
const CHECK_EVERY_MS = 60_000;

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));

await page.goto('http://localhost:5173/?z=14&lat=51.51&lon=-0.12', {
  waitUntil: 'networkidle',
  timeout: 30_000,
});
await page.waitForTimeout(6_000);
const t0 = Date.now();
console.log('loaded z=14 central London at', new Date(t0).toISOString());

const countIcons = () =>
  page.evaluate(() => {
    const map = window.__map;
    const feats = map.queryRenderedFeatures({ layers: ['buses-icons'] });
    const parked = feats.filter((f) => f.properties.parked === 1).length;
    return { zoom: map.getZoom(), total: feats.length, parked, moving: feats.length - parked };
  });

// ── wait out the threshold, logging progress each minute ──
while (Date.now() - t0 < PARKED_AFTER_MS + EXTRA_WAIT_MS) {
  await page.waitForTimeout(CHECK_EVERY_MS);
  const c = await countIcons();
  console.log(`t+${((Date.now() - t0) / 60_000).toFixed(1)}min icons:`, JSON.stringify(c));
  if (Date.now() - t0 > MAX_WAIT_MS) break;
}

const centralIcons = await countIcons();

// ── dots tier, city-wide at z=11: counts + parked coordinates ──
const dotsScan = await page.evaluate(async () => {
  const map = window.__map;
  map.jumpTo({ center: [-0.12, 51.5], zoom: 11 });
  await new Promise((r) => setTimeout(r, 4_000)); // dots rebuild at 1 Hz
  const feats = map.queryRenderedFeatures({ layers: ['buses-dots'] });
  const parkedCoords = feats
    .filter((f) => f.properties.parked === 1)
    .map((f) => f.geometry.coordinates);
  return { total: feats.length, parked: parkedCoords.length, parkedCoords };
});
console.log('z11 dots:', JSON.stringify({ total: dotsScan.total, parked: dotsScan.parked }));

// ── screenshot: densest parked cluster at z=14 (fallback: central London) ──
let target = [-0.12, 51.51];
if (dotsScan.parkedCoords.length > 0) {
  let best = dotsScan.parkedCoords[0];
  let bestN = -1;
  for (const c of dotsScan.parkedCoords) {
    const n = dotsScan.parkedCoords.filter(
      (d) => Math.abs(d[0] - c[0]) < 0.01 && Math.abs(d[1] - c[1]) < 0.006,
    ).length;
    if (n > bestN) {
      bestN = n;
      best = c;
    }
  }
  target = best;
  console.log('parked cluster of', bestN, 'at', JSON.stringify(best));
}
await page.evaluate((t) => window.__map.jumpTo({ center: t, zoom: 14 }), target);
await page.waitForTimeout(4_000);
const clusterIcons = await countIcons();
await page.screenshot({ path: OUT });

console.log(
  'RESULT',
  JSON.stringify({ centralIcons, dotsZ11: { total: dotsScan.total, parked: dotsScan.parked }, clusterIcons, screenshot: OUT }),
);
await browser.close();
