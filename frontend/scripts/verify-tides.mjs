// Dev-only acceptance helper: screenshot the tide-gauge layer along the Thames
// and count rendered gauge features. Usage: node scripts/verify-tides.mjs [out]
import { chromium } from 'playwright-core';

const out = process.argv[2] ?? '/tmp/tides.png';
const url = 'http://localhost:5173/?z=12&lat=51.50&lon=-0.04';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('console', (m) => {
  if (m.type() === 'error') console.error('[console.error]', m.text());
});
page.on('pageerror', (e) => console.error('[pageerror]', e.message));

await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForTimeout(6000);

const counts = await page.evaluate(() => {
  const map = window.__map;
  const dots = map.queryRenderedFeatures({ layers: ['tide-gauges-dots'] });
  const arrows = map.queryRenderedFeatures({ layers: ['tide-gauges-arrows'] });
  const refs = [...new Set(dots.map((f) => f.properties.ref))];
  return {
    dots: refs.length,
    arrows: arrows.length,
    sample: dots.slice(0, 6).map((f) => `${f.properties.label}: ${f.properties.levelM} m ${f.properties.trend}`),
  };
});
console.log(JSON.stringify(counts, null, 2));

await page.screenshot({ path: out });
await browser.close();
console.log('saved:', out);
