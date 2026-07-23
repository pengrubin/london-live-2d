// E2E acceptance for interactivity: click a vehicle and a station, screenshot both.
import { chromium } from 'playwright-core';

const base = process.argv[2] ?? 'http://localhost:5173';
const outPrefix = process.argv[3] ?? '/tmp/popup';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(`${base}/?z=13&lat=51.512&lon=-0.12`, { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForTimeout(9000); // map + first poll + icons

// ── click a vehicle: find a rendered train symbol, project to pixels ──
const trainPx = await page.evaluate(() => {
  const m = window.__map;
  const feats = m.queryRenderedFeatures(undefined, { layers: ['trains-dots'] });
  if (!feats.length) return null;
  // pick the train closest to screen centre for a clean shot
  const centre = { x: innerWidth / 2, y: innerHeight / 2 };
  let best = null;
  for (const f of feats) {
    const p = m.project(f.geometry.coordinates);
    const d = Math.hypot(p.x - centre.x, p.y - centre.y);
    if (!best || d < best.d) best = { x: p.x, y: p.y, d };
  }
  return best;
});
if (trainPx) {
  await page.mouse.click(trainPx.x, trainPx.y);
  await page.waitForTimeout(1500);
  const html = await page.evaluate(
    () => document.querySelector('.maplibregl-popup-content')?.textContent ?? 'NO POPUP',
  );
  console.log('vehicle popup text:', html.trim().slice(0, 160));
  await page.screenshot({ path: `${outPrefix}-vehicle.png` });
} else {
  console.log('no rendered trains found');
}

// ── click a station: press Escape-equivalent (close old popup) then click ──
const stationPx = await page.evaluate(() => {
  const m = window.__map;
  const feats = m.queryRenderedFeatures(undefined, { layers: ['stations-circle'] });
  const trains = m
    .queryRenderedFeatures(undefined, { layers: ['trains-dots'] })
    .map((f) => m.project(f.geometry.coordinates));
  // pick a station with no vehicle within 20px so the station handler owns the click
  for (const f of feats) {
    const p = m.project(f.geometry.coordinates);
    const blocked = trains.some((t) => Math.hypot(t.x - p.x, t.y - p.y) < 20);
    if (!blocked && p.x > 100 && p.y > 100 && p.x < innerWidth - 100 && p.y < innerHeight - 100) {
      return { x: p.x, y: p.y, name: f.properties.name };
    }
  }
  return null;
});
if (stationPx) {
  await page.mouse.click(stationPx.x, stationPx.y);
  await page.waitForTimeout(2500); // departures fetch
  const html = await page.evaluate(
    () => document.querySelector('.maplibregl-popup-content')?.textContent ?? 'NO POPUP',
  );
  console.log(`station popup (${stationPx.name}):`, html.trim().slice(0, 200));
  await page.screenshot({ path: `${outPrefix}-station.png` });
} else {
  console.log('no rendered stations found');
}

await browser.close();
