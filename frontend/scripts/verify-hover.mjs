// E2E acceptance for hover + detail interactions.
import { chromium } from 'playwright-core';

const base = process.argv[2] ?? 'http://localhost:5173';
const outPrefix = process.argv[3] ?? '/tmp/hover';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(`${base}/?z=13&lat=51.512&lon=-0.12`, { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForTimeout(9000);

const trainPx = await page.evaluate(() => {
  const m = window.__map;
  const feats = m.queryRenderedFeatures(undefined, { layers: ['trains-dots'] });
  const withId = feats.filter((f) => /:\d+$/.test(f.properties.key)); // vehicleId keys → detail available
  const centre = { x: innerWidth / 2, y: innerHeight / 2 };
  let best = null;
  for (const f of withId.length ? withId : feats) {
    const p = m.project(f.geometry.coordinates);
    const d = Math.hypot(p.x - centre.x, p.y - centre.y);
    if (!best || d < best.d) best = { x: p.x, y: p.y, d };
  }
  return best;
});

// 1) hover → quick tip
await page.mouse.move(trainPx.x, trainPx.y);
await page.waitForTimeout(800);
const hoverText = await page.evaluate(
  () => document.querySelector('.hover-tip .maplibregl-popup-content')?.textContent ?? 'NO TIP',
);
console.log('hover tip:', hoverText.trim().slice(0, 120));
await page.screenshot({ path: `${outPrefix}-tip.png` });

// 2) click → detail card with calling pattern
await page.mouse.click(trainPx.x, trainPx.y);
await page.waitForTimeout(2500);
const detailText = await page.evaluate(
  () => document.querySelector('.maplibregl-popup-content')?.textContent ?? 'NO POPUP',
);
console.log('detail card:', detailText.trim().replace(/\s+/g, ' ').slice(0, 260));
await page.screenshot({ path: `${outPrefix}-detail.png` });

// 3) click empty map → card closes
await page.mouse.click(200, 820);
await page.waitForTimeout(600);
const after = await page.evaluate(() => document.querySelector('.maplibregl-popup-content') !== null);
console.log('card still open after outside click:', after);

await browser.close();
