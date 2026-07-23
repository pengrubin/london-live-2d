import { chromium } from 'playwright-core';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const notFound = [];
page.on('response', (r) => { if (r.status() === 404) notFound.push(r.url()); });

async function evalAt(url) {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(6000);
  return page.evaluate(async () => {
    const map = window.__map;
    const count = (id) => (map.getLayer(id) ? map.queryRenderedFeatures({ layers: [id] }).length : -1);
    const dots = count('buses-dots');
    const icons = count('buses-icons');
    // sample 100 rAF deltas
    const deltas = [];
    await new Promise((resolve) => {
      let last = performance.now();
      let n = 0;
      const tick = (t) => {
        deltas.push(t - last); last = t;
        if (++n < 100) requestAnimationFrame(tick); else resolve();
      };
      requestAnimationFrame(tick);
    });
    deltas.sort((a, b) => a - b);
    const p = (q) => deltas[Math.min(deltas.length - 1, Math.floor(q * deltas.length))].toFixed(1);
    return { zoom: map.getZoom(), dots, icons, p50: p(0.5), p95: p(0.95), max: deltas[deltas.length-1].toFixed(1) };
  });
}

console.log('z11:', JSON.stringify(await evalAt('http://localhost:5173/?z=11&lat=51.5&lon=-0.12')));
console.log('z14:', JSON.stringify(await evalAt('http://localhost:5173/?z=14&lat=51.51&lon=-0.12')));
console.log('404s:', JSON.stringify([...new Set(notFound)]));
await browser.close();
