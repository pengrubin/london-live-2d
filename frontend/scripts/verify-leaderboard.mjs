// Headless verification: leaderboard mode split, dblclick locate + pulse
// position, not-running feedback, and popup rank lines.
// Usage: node scripts/verify-leaderboard.mjs   (Vite on :5173, backend on :3000)
import { chromium } from 'playwright-core';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));

await page.goto('http://localhost:5173', { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForSelector('.leaderboard .lb-row', { timeout: 30000 });
await page.waitForTimeout(3000);

const rowsInfo = () =>
  page.$$eval('.leaderboard .lb-row', (rows) =>
    rows.map((r) => ({
      id: r.querySelector('.lb-label')?.title ?? '',
      label: r.querySelector('.lb-label')?.textContent ?? '',
      km: r.querySelector('.lb-km')?.textContent ?? '',
    })),
  );

/** Screen distance (px) between the pulse anchor and the projected lngLat. */
const pulseOffsetPx = (pos) =>
  page.evaluate((lngLat) => {
    const el = document.querySelector('.lb-pulse-anchor');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const p = window.__map.project(lngLat);
    return Math.hypot(r.left - p.x, r.top - p.y);
  }, pos);

// ── 1. Buses tab populated + screenshot ──
await page.locator('.lb-modes .lb-tab', { hasText: 'Buses' }).click();
await page.waitForFunction(
  () => document.querySelector('.leaderboard .lb-label')?.title.startsWith('bus:'),
  { timeout: 15000 },
);
const busRows = await rowsInfo();
console.log('BUS ROWS:', busRows.length, JSON.stringify(busRows.slice(0, 3)));
await page.waitForTimeout(1000);
await page.screenshot({ path: '/tmp/lb-split.png' });
console.log('saved /tmp/lb-split.png');

// ── 2. Trains tab: dblclick top live row → flyTo + pulse glued to vehicle ──
await page.locator('.lb-modes .lb-tab', { hasText: 'Trains' }).click();
await page.waitForFunction(
  () => document.querySelector('.leaderboard .lb-label')?.title.startsWith('tube:'),
  { timeout: 15000 },
);
const trainRows = await rowsInfo();
console.log('TRAIN ROWS:', trainRows.length, JSON.stringify(trainRows.slice(0, 3)));

let liveIndex = -1;
let expected = null;
for (let i = 0; i < trainRows.length; i += 1) {
  const key = trainRows[i].id.slice('tube:'.length);
  expected = await page.evaluate((k) => window.__trains?.findVehicle(k) ?? null, key);
  if (expected) {
    liveIndex = i;
    break;
  }
}
if (liveIndex < 0) throw new Error('no live train row found');
console.log('dblclicking row', liveIndex, trainRows[liveIndex].label, 'expected pos', expected);
const rowHandles = await page.$$('.leaderboard .lb-row');
await rowHandles[liveIndex].dblclick();

// mid-flight: pulse must already sit on the vehicle coordinate
await page.waitForTimeout(700);
const midOffset = await pulseOffsetPx(expected);
await page.screenshot({ path: '/tmp/lb-pulse-fix-midflight.png' });
console.log('mid-flight pulse offset px:', midOffset?.toFixed(1) ?? 'NO PULSE');

// after the flight settles
await page.waitForTimeout(1600);
const endOffset = await pulseOffsetPx(expected);
const center = await page.evaluate(() => {
  const c = window.__map.getCenter();
  return [c.lng, c.lat];
});
const dLonM = (center[0] - expected[0]) * 111320 * Math.cos((51.5 * Math.PI) / 180);
const dLatM = (center[1] - expected[1]) * 110540;
const distM = Math.hypot(dLonM, dLatM);
const zoom = await page.evaluate(() => window.__map.getZoom());
console.log(
  'map center', center, 'zoom', zoom.toFixed(2),
  'distance to vehicle m', distM.toFixed(0),
  'settled pulse offset px:', endOffset?.toFixed(1) ?? 'NO PULSE (expired)',
);
if (distM > 800) throw new Error(`map did not fly to vehicle (off by ${distM.toFixed(0)} m)`);
if (midOffset === null || midOffset > 5) throw new Error(`pulse not on vehicle mid-flight (${midOffset} px)`);
if (endOffset !== null && endOffset > 5) throw new Error(`pulse not on vehicle after moveend (${endOffset} px)`);
await page.screenshot({ path: '/tmp/lb-pulse-fix.png' });
console.log('saved /tmp/lb-pulse-fix-midflight.png + /tmp/lb-pulse-fix.png');
await page.screenshot({ path: '/tmp/lb-locate.png' });

// ── 3. Not-running path ──
let notRunningShown = false;
async function tryNotRunningAt(rowIndex, label) {
  const handles = await page.$$('.leaderboard .lb-row');
  await handles[rowIndex].dblclick();
  await page.waitForTimeout(300);
  const kmText = await handles[rowIndex].$eval('.lb-km', (el) => el.textContent);
  console.log(`not-running dblclick on "${label}" → km cell: "${kmText}"`);
  if (kmText !== 'not running') return false;
  await page.screenshot({ path: '/tmp/lb-notrunning.png' });
  console.log('saved /tmp/lb-notrunning.png');
  await page.waitForTimeout(2200);
  const restored = await handles[rowIndex].$eval('.lb-km', (el) => el.textContent);
  console.log('restored km cell:', JSON.stringify(restored));
  return true;
}

// natural: a week/month train entry that is no longer live
outer: for (const periodLabel of ['Week', 'Month']) {
  await page.locator('.lb-tabs:not(.lb-modes) .lb-tab', { hasText: periodLabel }).click();
  await page.waitForTimeout(1500);
  const rows = await rowsInfo();
  for (let i = 0; i < rows.length; i += 1) {
    if (!rows[i].id.startsWith('tube:')) continue;
    const key = rows[i].id.slice('tube:'.length);
    const pos = await page.evaluate((k) => window.__trains?.findVehicle(k) ?? null, key);
    if (pos === null) {
      notRunningShown = await tryNotRunningAt(i, rows[i].label);
      break outer;
    }
  }
}
// fallback: rig a ghost row that cannot be live
if (!notRunningShown) {
  console.log('all listed trains are live — rigging a ghost row via route interception');
  await page.route('**/api/leaderboard?*', async (route) => {
    const res = await route.fetch();
    const json = await res.json();
    json.top = [
      { rank: 0, mode: 'tube', id: 'tube:northern:ZZZ999', label: 'Ghost 999', km: 99.9 },
      ...json.top,
    ];
    await route.fulfill({ response: res, json });
  });
  await page.locator('.lb-tabs:not(.lb-modes) .lb-tab', { hasText: 'Day' }).click();
  await page.waitForFunction(
    () => document.querySelector('.leaderboard .lb-label')?.title === 'tube:northern:ZZZ999',
    { timeout: 15000 },
  );
  notRunningShown = await tryNotRunningAt(0, 'Ghost 999 (rigged)');
  await page.unroute('**/api/leaderboard?*');
}
if (!notRunningShown) console.error('WARNING: not-running path unverified');

// ── 4. Popup rank lines (map is at z14.5 from the locate step) ──
await page.locator('.lb-tabs:not(.lb-modes) .lb-tab', { hasText: 'Day' }).click();
await page.waitForTimeout(1000);

async function openPopupOn(layerId, signature) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    // drop any previous popup so the click can't land on its card
    await page.evaluate(() => {
      for (const el of document.querySelectorAll('.maplibregl-popup')) el.remove();
    });
    const pt = await page.evaluate((lid) => {
      if (!window.__map.getLayer(lid)) return null;
      const feats = window.__map.queryRenderedFeatures(undefined, { layers: [lid] });
      const w = window.innerWidth;
      const h = window.innerHeight;
      for (const f of feats) {
        const p = window.__map.project(f.geometry.coordinates);
        // avoid the leaderboard/legend panels and screen edges
        if (p.x > 320 && p.x < w - 140 && p.y > 140 && p.y < h - 140) return { x: p.x, y: p.y };
      }
      return null;
    }, layerId);
    if (!pt) {
      await page.waitForTimeout(1000);
      continue;
    }
    await page.mouse.click(pt.x, pt.y);
    await page.waitForTimeout(900);
    const opened = await page.evaluate(
      (sig) => document.querySelector('.maplibregl-popup .vp')?.textContent.includes(sig) ?? false,
      signature,
    );
    if (opened) return true;
  }
  return false;
}

async function verifyPopupRank(kind, layerId, signature, shot) {
  if (!(await openPopupOn(layerId, signature))) {
    console.error(`WARNING: could not open a ${kind} popup`);
    return;
  }
  try {
    await page.waitForFunction(
      () => document.querySelector('.maplibregl-popup .vp')?.textContent.includes('Top '),
      { timeout: 8000 },
    );
    const text = await page.$eval('.maplibregl-popup .vp', (el) => el.textContent);
    console.log(`${kind.toUpperCase()} POPUP:`, JSON.stringify(text));
    await page.screenshot({ path: shot });
    console.log(`saved ${shot} (${kind} popup)`);
  } catch {
    console.error(`WARNING: ${kind} popup rank line did not render`);
  }
}

await verifyPopupRank('bus', 'buses-icons', 'Route ', '/tmp/lb-rank-popup.png');
await verifyPopupRank('train', 'trains-dots', 'Next:', '/tmp/lb-rank-popup-train.png');

await browser.close();
console.log('DONE');
