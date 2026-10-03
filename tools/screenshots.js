// Кадры для README: безголовый Chromium, страница по файловому адресу, без сети.
//   node tools/screenshots.js   ->  docs/screens/*.png
// Захват мыши только поддельный (FAKE_POINTER_LOCK из проверок): настоящий в безголовом
// Chromium на Windows зажимает курсор пользователя.
const path = require('path');
const fs = require('fs');
const { chromium } = require('@playwright/test');
const { pageUrl } = require('../tests/helpers');
const { FAKE_POINTER_LOCK } = require('../tests/_drift-helpers');

const OUT = path.join(__dirname, '..', 'docs', 'screens');

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: true, args: ['--allow-file-access-from-files', '--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.addInitScript(FAKE_POINTER_LOCK);
  await page.route(/^https?:\/\//, (r) => r.abort());
  await page.goto(pageUrl('horizon_drift_offline') + '?seed=7');
  await page.waitForFunction(() => window.__drift && window.__drift.ready === true, null, { timeout: 60000 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(OUT, 'menu.png') });

  // быстрая гонка: газ и лёгкий поворот, кадры идут сами
  await page.evaluate(async () => { await __drift.startQuick({}); });
  await page.waitForFunction(() => !__drift.loading, null, { timeout: 60000 });
  await page.waitForTimeout(5000);
  await page.evaluate(() => __drift.setInput({ thr: 1, steer: 0.15 }));
  await page.waitForTimeout(4000);
  await page.screenshot({ path: path.join(OUT, 'race.png') });

  // свободная езда по большой карте
  await page.goto(pageUrl('horizon_drift_offline') + '?seed=7');
  await page.waitForFunction(() => window.__drift && window.__drift.ready === true, null, { timeout: 60000 });
  await page.evaluate(async () => { await __drift.startWorld('coast', { fest: true }); });
  await page.waitForTimeout(6000);
  await page.evaluate(() => __drift.setInput({ thr: 1 }));
  await page.waitForTimeout(3000);
  await page.screenshot({ path: path.join(OUT, 'world.png') });
  await browser.close();
  console.log('кадры в', OUT);
})().catch((e) => { console.error(e); process.exit(1); });
