// Dev-only acceptance helper: screenshot the running dev server with local Chrome.
// Usage: node scripts/screenshot.mjs [url] [outfile]
import { chromium } from 'playwright-core';

const url = process.argv[2] ?? 'http://localhost:5173';
const out = process.argv[3] ?? 'screenshot.png';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('console', (m) => {
  if (m.type() === 'error') console.error('[console.error]', m.text());
});
page.on('pageerror', (e) => console.error('[pageerror]', e.message));

await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
// networkidle can fire before tile decode/render finishes; give the GPU a beat
await page.waitForTimeout(4000);
await page.screenshot({ path: out });
await browser.close();
console.log('saved:', out);
