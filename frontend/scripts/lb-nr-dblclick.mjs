// Dev-only acceptance helper: open the app, wait for the leaderboard to show
// National Rail rows (id "train:nr:*") on the Trains tab, dblclick rows until
// one is currently live (fly-to + pulse), and screenshot the result. Usage:
//   node scripts/lb-nr-dblclick.mjs [url] [outfile]
import { chromium } from 'playwright-core';

const url = process.argv[2] ?? 'http://localhost:5173';
const out = process.argv[3] ?? '/tmp/lb-nr.png';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));

await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForSelector('.leaderboard .lb-row', { timeout: 60000 });
// let the NR board polling cover a full hub cycle (17 boards x 4 s) so the
// session's live-train map overlaps the leaderboard's recent entries
await page.waitForTimeout(75000);

// NR rows carry their entry id in the label's title attribute.
const nrRows = page.locator('.leaderboard .lb-row', {
  has: page.locator('.lb-label[title^="train:nr:"]'),
});
await nrRows.first().waitFor({ timeout: 120000 });
const count = await nrRows.count();
console.log('NR rows visible:', count);

let located = false;
for (let i = 0; i < count && !located; i++) {
  const row = nrRows.nth(i);
  const id = await row.locator('.lb-label').getAttribute('title');
  const label = await row.locator('.lb-label').textContent();
  const km = await row.locator('.lb-km').textContent();
  await row.dblclick();
  await page.waitForTimeout(400); // pulse marker appears immediately on success
  const pulse = await page.evaluate(() => document.querySelector('.lb-pulse') !== null);
  console.log(`row ${i + 1}: ${id} | ${label} | ${km} → ${pulse ? 'LOCATED' : 'not running'}`);
  if (pulse) {
    located = true;
    await page.waitForTimeout(1800); // let the 1.5 s fly finish
    const state = await page.evaluate(() => ({
      center: window.__map.getCenter(),
      zoom: window.__map.getZoom(),
    }));
    console.log('map after locate:', JSON.stringify(state));
  }
}
await page.screenshot({ path: out });
await browser.close();
console.log(located ? 'saved:' : 'NO LIVE NR ROW LOCATED; saved:', out);
process.exit(located ? 0 : 1);
