// Headless verification for the rain-radar overlay.
import { chromium } from 'playwright-core';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
page.on('console', (m) => {
  if (m.type() === 'error') console.error('[console.error]', m.text());
});
page.on('response', (r) => {
  if (r.status() >= 400 && r.url().includes('rainviewer'))
    console.error('[radar-tile]', r.status(), r.url());
});

await page.goto('http://localhost:5173/?z=9', { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForFunction(() => window.__map && window.__map.getLayer('rain-radar'), null, {
  timeout: 30000,
});
await page.waitForTimeout(3000);

const before = await page.evaluate(() => {
  const map = window.__map;
  const ids = map.getStyle().layers.map((l) => l.id);
  const row = [...document.querySelectorAll('.legend-row')].find(
    (r) => r.textContent.trim() === 'Rain radar',
  );
  return {
    layerCount: ids.length,
    radarIndex: ids.indexOf('rain-radar'),
    casingIndex: ids.indexOf('transit-lines-casing'),
    visibility: map.getLayoutProperty('rain-radar', 'visibility'),
    legendRowOff: row ? row.classList.contains('off') : null,
    tiles: map.getSource('rain-radar').tiles,
  };
});
console.log('before:', JSON.stringify(before, null, 2));

await page.evaluate(() => {
  window.__map.setLayoutProperty('rain-radar', 'visibility', 'visible');
});
await page.waitForTimeout(6000); // let radar tiles load + fade in

const after = await page.evaluate(() => {
  const map = window.__map;
  return {
    layerCount: map.getStyle().layers.length,
    visibility: map.getLayoutProperty('rain-radar', 'visibility'),
  };
});
console.log('after toggle-on:', JSON.stringify(after));

await page.screenshot({ path: '/tmp/rain.png' });
console.log('saved /tmp/rain.png');
await browser.close();
