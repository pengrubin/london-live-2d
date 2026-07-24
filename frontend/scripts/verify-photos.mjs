// E2E acceptance for detail-card photos: click an aircraft (Planespotters
// photo + attribution) and a tube train (bundled rolling-stock photo),
// screenshot both.
import { chromium } from 'playwright-core';

const base = process.argv[2] ?? 'http://localhost:5173';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(`${base}/?z=11&lat=51.505&lon=-0.09`, { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForTimeout(10000); // map + first polls + icons

const pickNearCentre = (layerId, filter) =>
  page.evaluate(
    ({ layerId, filter }) => {
      const m = window.__map;
      let feats;
      try {
        feats = m.queryRenderedFeatures(undefined, { layers: [layerId] });
      } catch {
        return null;
      }
      const centre = { x: innerWidth / 2, y: innerHeight / 2 };
      let nrPx = [];
      if (filter === 'train') {
        try {
          nrPx = m
            .queryRenderedFeatures(undefined, { layers: ['nr-trains-dots'] })
            .map((f) => m.project(f.geometry.coordinates));
        } catch {
          nrPx = [];
        }
      }
      let best = null;
      for (const f of feats) {
        if (filter === 'train') {
          const lineId = f.properties.lineId ?? '';
          if (lineId.startsWith('rb') || lineId === 'woolwich-ferry') continue;
        }
        const p = m.project(f.geometry.coordinates);
        if (p.x < 60 || p.y < 60 || p.x > innerWidth - 60 || p.y > innerHeight - 60) continue;
        // skip trains overlapped by a National Rail marker (it would own the click)
        if (nrPx.some((n) => Math.hypot(n.x - p.x, n.y - p.y) < 25)) continue;
        const d = Math.hypot(p.x - centre.x, p.y - centre.y);
        if (!best || d < best.d) best = { x: p.x, y: p.y, d, props: f.properties };
      }
      return best;
    },
    { layerId, filter },
  );

// ── aircraft: click, wait for the lazy Planespotters fetch, screenshot ──
const ac = await pickNearCentre('aircraft-icons', null);
if (ac) {
  console.log('clicking aircraft:', ac.props.reg || ac.props.hex, ac.props.typeCode);
  await page.mouse.click(ac.x, ac.y);
  await page.waitForTimeout(4000); // photo lookup + image load
  const info = await page.evaluate(() => {
    const root = document.querySelector('.maplibregl-popup-content');
    return {
      text: root?.textContent?.trim().slice(0, 200) ?? 'NO POPUP',
      hasPhoto: Boolean(root?.querySelector('img.vp-photo')),
      credit: root?.querySelector('a.vp-credit')?.textContent ?? null,
      creditHref: root?.querySelector('a.vp-credit')?.href ?? null,
    };
  });
  console.log('aircraft popup:', JSON.stringify(info, null, 1));
  await page.screenshot({ path: '/tmp/ac-photo.png' });
} else {
  console.log('no rendered aircraft found');
}

// ── tube train: close old popup, click, screenshot (photo is bundled) ──
await page.keyboard.press('Escape');
await page.evaluate(() => {
  document.querySelectorAll('.maplibregl-popup-close-button').forEach((b) => b.click());
});
await page.waitForTimeout(500);
const train = await pickNearCentre('trains-dots', 'train');
if (train) {
  console.log('clicking train:', train.props.lineId, train.props.vehicleId ?? '');
  await page.mouse.click(train.x, train.y);
  await page.waitForTimeout(2500);
  const info = await page.evaluate(() => {
    const root = document.querySelector('.maplibregl-popup-content');
    const img = root?.querySelector('img.vp-photo');
    return {
      text: root?.textContent?.trim().slice(0, 160) ?? 'NO POPUP',
      photoSrc: img?.getAttribute('src') ?? null,
      photoLoaded: img ? img.complete && img.naturalWidth > 0 : false,
    };
  });
  console.log('train popup:', JSON.stringify(info, null, 1));
  await page.screenshot({ path: '/tmp/train-photo.png' });
} else {
  console.log('no rendered trains found');
}

await browser.close();
