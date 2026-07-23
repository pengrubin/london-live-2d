// Dev-only: load the app in headless Chrome and report map/network failures.
import { chromium } from 'playwright-core';

const url = process.argv[2] ?? 'http://localhost:5173';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

page.on('console', (m) => console.log(`[console.${m.type()}]`, m.text()));
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('response', (r) => {
  if (r.status() >= 400) console.log('[http]', r.status(), r.url());
});
page.on('requestfailed', (r) =>
  console.log('[reqfail]', r.url(), r.failure()?.errorText),
);

await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForTimeout(5000);

const state = await page.evaluate(() => {
  const m = window.__map;
  if (!m) return { hasMap: false };
  return {
    hasMap: true,
    loaded: m.loaded(),
    styleLayers: m.getStyle().layers.length,
    renderedFeatures: m.queryRenderedFeatures().length,
    sourceLoaded: m.isSourceLoaded('protomaps'),
  };
});
console.log('[state]', JSON.stringify(state));
await browser.close();
