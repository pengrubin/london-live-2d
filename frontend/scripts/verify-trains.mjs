// E2E acceptance for P2: load the app, wait for two polls, report train stats.
import { chromium } from 'playwright-core';

const url = process.argv[2] ?? 'http://localhost:5173';
const shot = process.argv[3];

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('console', (m) => {
  if (m.type() === 'error') console.log('[console.error]', m.text());
});

await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForTimeout(13000); // startup poll + one interval poll

const report = await page.evaluate(() => {
  const m = window.__map;
  const t = window.__trains;
  const features = m?.queryRenderedFeatures(undefined, { layers: ['trains-dots'] }) ?? [];
  const byLine = {};
  for (const f of features) {
    byLine[f.properties.lineId] = (byLine[f.properties.lineId] ?? 0) + 1;
  }
  return {
    stats: t?.stats ?? null,
    renderedTrainDots: features.length,
    byLine,
    sample: features.slice(0, 3).map((f) => ({
      line: f.properties.lineId,
      next: f.properties.nextStop,
      dest: f.properties.destination,
    })),
  };
});
console.log(JSON.stringify(report, null, 2));

if (shot) {
  await page.screenshot({ path: shot });
  console.log('saved:', shot);
}
await browser.close();
