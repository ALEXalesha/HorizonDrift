// Законы «Horizon Drift» по находкам ревьюера: ресурсы не копятся, испорченное хранилище не ломает игру,
// двойной «Заново» не строит два заезда, дрифт против хода не считается, камера и экраны не мешают игроку.
const { test, expect } = require('@playwright/test');
const { openDrift, startQuick } = require('./_drift-helpers');

const frame = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const mem = (page) => page.evaluate(() => Object.assign({}, __drift.renderer.info.memory));

test.describe('horizon_drift_offline: устойчивость', () => {
  test.describe.configure({ timeout: 120_000 });

  test('6 заездов подряд с тенями: в меню не растёт число текстур и геометрий', async ({ page }) => {
    await openDrift(page);
    await page.evaluate(() => __drift.setSetting('quality', 'high'));
    const counts = [];
    for (const t of ['port', 'city', 'lake', 'port', 'desert', 'coast']) {
      await startQuick(page, { track: t, mode: 'race', opp: 3, laps: 1 });
      await page.evaluate(() => { __drift.step(400, { thr: 1 }); });
      await frame(page);
      await page.evaluate(() => __drift.toMenu());
      await frame(page);
      counts.push(await mem(page));
    }
    expect(counts[5].textures).toBeLessThanOrEqual(counts[0].textures);
    expect(counts[5].geometries).toBeLessThanOrEqual(counts[0].geometries);
  });

  test('21 смена краски в гараже не копит текстуры', async ({ page }) => {
    await openDrift(page);
    await page.locator('.mainnav button[data-go="garage"]').click();
    await page.locator('#gTabs button[data-tab="look"]').click();
    await frame(page);
    const before = await mem(page);
    for (let k = 0; k < 21; k++) { await page.locator(`[data-look="color"]`).nth(k % 14).click(); await frame(page); }
    const after = await mem(page);
    expect(after.textures).toBeLessThanOrEqual(before.textures + 1);
  });

  test('двойной «Заново»: строится один заезд, после выхода ресурсов как после одного', async ({ page }) => {
    await openDrift(page);
    const run = async (clicks) => {
      await startQuick(page, { track: 'port', mode: 'race', opp: 2, laps: 1 });
      await page.evaluate(() => { __drift.manual = false; });
      await page.keyboard.press('Escape');
      await expect(page.locator('#scrPause')).toBeVisible();
      // быстрые щелчки подряд, пока загрузка ещё не спрятала паузу
      await page.evaluate((n) => { for (let k = 0; k < n; k++) document.getElementById('pRestart').click(); }, clicks);
      await page.waitForFunction(() => __drift.screen === 'race' && !__drift.loading);
      await page.waitForTimeout(300);
      const built = await page.evaluate(() => __drift.buildCount);
      await page.evaluate(() => __drift.toMenu());
      await frame(page);
      return { built, m: await mem(page) };
    };
    const one = await run(1);
    const two = await run(2);
    expect(two.built - one.built).toBe(2);                   // старт + одно «Заново», второй щелчок проигнорирован
    expect(two.m.geometries).toBe(one.m.geometries);
    expect(two.m.textures).toBeLessThanOrEqual(one.m.textures);
  });

  test('испорченное хранилище приводится к типам и пределам, игра не падает', async ({ page }) => {
    await page.addInitScript(() => {
      if (sessionStorage.getItem('bad-set')) return;
      sessionStorage.setItem('bad-set', '1'); sessionStorage.setItem('drift-test-cleared', '1');
      localStorage.clear();
      localStorage.setItem('mix.drift.settings', JSON.stringify({ musicVol: 7, sfxVol: -3, engineVol: 'x', deadzone: 5, steerSens: 40, difficulty: 'zzz', units: 'x', quality: 'bogus',
        drawDist: 'q', particles: 1, camera: 'drone', gearbox: 'cvt', bindings: { accel: [5, null], brake: 'KeyS' } }));
      localStorage.setItem('mix.drift.career', JSON.stringify({ money: '1000', owned: ['iskra', 'ghost', 5, 'kobalt', 'kobalt'], current: 'ghost', res: 'x', upg: { iskra: { engine: '9' }, ghost: {} }, looks: { iskra: { color: 'url(x)', livery: 'bad', rims: 3 } }, stats: 'bad' }));
      localStorage.setItem('mix.drift.records', JSON.stringify({ tracks: { port: 5, city: { lap: 'x', drift: 100 } } }));
    });
    const errors = await openDrift(page, { clear: false, low: false });
    const r = await page.evaluate(() => {
      const s = __drift.settings, c = __drift.career;
      const money0 = c.money, ap = c.applyResult('c1e1', { place: 1 });
      return { s: { m: s.musicVol, sfx: s.sfxVol, e: s.engineVol, dz: s.deadzone, ss: s.steerSens, diff: s.difficulty, u: s.units, q: s.quality, dd: s.drawDist, p: s.particles, cam: s.camera, gb: s.gearbox, accel: s.bindings.accel, brake: s.bindings.brake },
        money: money0, owned: c.d.owned, current: c.d.current, lv: c.levels('iskra').engine, look: c.look('iskra'), ap: !!ap, money2: c.money, stats: typeof c.d.stats.races,
        rec: __drift.records.tracks };
    });
    expect(r.s).toEqual({ m: 1, sfx: 0, e: 0.7, dz: 0.4, ss: 1.6, diff: 'normal', u: 'kmh', q: 'high', dd: 'far', p: 'high', cam: 'chase', gb: 'auto', accel: ['KeyW', 'ArrowUp'], brake: ['KeyS', 'ArrowDown'] });
    expect(r.money).toBe(1000);
    expect(r.owned).toEqual(['iskra', 'kobalt']);
    expect(r.current).toBe('iskra');
    expect(r.lv).toBe(3);
    expect(r.look.color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(r.look.livery).toBe('none');
    expect(r.ap).toBe(true);
    expect(r.money2).toBeGreaterThan(1000);
    expect(r.stats).toBe('number');
    expect(r.rec.port).toBeUndefined();
    expect(r.rec.city).toEqual({ drift: 100 });
    // заезд до конца: итоги показываются, награда приходит
    await page.evaluate(async () => { __drift.manual = true; await __drift.startCareer('c1e3'); const r = __drift.race; r.setAutopilot(r.player, 1); for (let i = 0; i < 200 * 120 && r.phase !== 'done'; i++) __drift.step(1); __drift.manual = false; });
    await expect(page.locator('#scrResults')).toBeVisible({ timeout: 15_000 });
    expect(await page.evaluate(() => __drift.lastApply && __drift.lastApply.reward > 0)).toBe(true);
    expect(errors).toEqual([]);
  });

  test('дрифт против хода не считается; у дрифт-заезда есть лимит времени', async ({ page }) => {
    await openDrift(page);
    const r = await page.evaluate(() => {
      const C = __drift.core;
      const mk = () => { const race = new C.Race({ track: 'port', mode: 'drift', laps: 2, skipCountdown: true, seed: 1, entries: [{ name: 'Вы', car: 'vihr', isPlayer: true }] }); const p = race.player; p.assist.tc = false; p.assist.steer = false; return race; };
      const drive = (race, back) => {
        const p = race.player; race.teleport(p, race.track.sStart + 5, 0, 0);
        if (back) p.h += Math.PI;
        p.vx = Math.sin(p.h) * 26; p.vz = Math.cos(p.h) * 26;
        let most = 0;                                   // наибольшие очки за время заноса (удар о стену потом их сорвёт - это другой закон)
        for (let i = 0; i < 200; i++) { race.step(C.DT, i < 40 ? { thr: 1, steer: 1, hb: 1 } : { thr: 1, steer: 0.4 }); most = Math.max(most, race.drift.total + race.drift.pending); }
        return most;
      };
      const wrong = drive(mk(), true), right = drive(mk(), false);
      const idle = mk(); idle.run(2000);
      return { wrong, right, phase: idle.phase, t: idle.t, limit: idle.timeLimit, time: idle.result && idle.result.time };
    });
    expect(r.wrong).toBe(0);
    expect(r.right).toBeGreaterThan(0);
    expect(r.phase).toBe('done');
    expect(r.limit).toBeGreaterThan(60);
    expect(r.t).toBeCloseTo(r.limit, 0);
    expect(r.time).toBeNull();
  });

  test('дальняя камера: соперник между камерой и игроком прозрачный', async ({ page }) => {
    await openDrift(page);
    await startQuick(page, { track: 'coast', mode: 'race', opp: 1, laps: 1 });
    const r = await page.evaluate(async () => {
      const race = __drift.race, p = race.player, ai = race.cars.find((c) => !c.isPlayer);
      __drift.step(3.2 * 120);
      race.teleport(p, 500, 0, 0); race.teleport(ai, 495.5, 0, 0);
      __drift.setCamera('far');
      await new Promise((res) => { let n = 0; const f = () => (++n > 6 ? res() : requestAnimationFrame(f)); requestAnimationFrame(f); });
      const idx = race.cars.indexOf(ai), cm = __drift.render.race.cars[idx];
      return { faded: cm.faded, fn: [__drift.render.fadeBetween(0, 0, 10, 0, 5, 0.5), __drift.render.fadeBetween(0, 0, 10, 0, 5, 4), __drift.render.fadeBetween(0, 0, 10, 0, 14, 0)] };
    });
    expect(r.faded).toBe(true);
    expect(r.fn).toEqual([true, false, false]);
  });

  test('заснеженная дорога темнее обочины, по краям вешки', async ({ page }) => {
    await openDrift(page);
    await startQuick(page, { track: 'pass', mode: 'time' });
    const r = await page.evaluate(() => ({ road: __drift.render.surfaceLuma('snow'), bank: __drift.render.surfaceLuma('snowbank'), poles: __drift.render.race.poles }));
    expect(r.road).toBeLessThan(r.bank * 0.85);
    expect(r.poles).toBeGreaterThan(30);
  });

  test('мелочи: склонение кругов, «Где», подсказки из назначений, мотор молчит под итогами, пауза по потере фокуса', async ({ page }) => {
    await openDrift(page);
    await page.evaluate(() => { const c = __drift.career; __drift.data.CUPS.slice(0, 2).forEach((cup) => cup.events.forEach((e) => { c.d.res[e.id] = { medal: 'gold' }; })); c.save(c.d); });
    await page.evaluate(() => { __drift.show('career'); });
    await page.locator('#cupsGrid .card[data-cup="2"]').click();
    await expect(page.locator('#eventsGrid')).toContainText('3 круга');
    await expect(page.locator('#eventsGrid')).not.toContainText('кругов·');
    await page.evaluate(() => __drift.show('records'));
    await expect(page.locator('#recBody th').nth(1)).toHaveText('Где');
    // подсказки берутся из назначений
    await page.evaluate(() => { const s = __drift.settings; s.bindings.shiftUp = ['KeyT', '']; s.bindings.camera = ['KeyV', '']; __drift.setSetting('bindings', s.bindings); __drift.show('settings'); });
    await page.locator('#sTabs button[data-tab="game"]').click();
    await expect(page.locator('#sBody')).toContainText('T - вверх');
    await expect(page.locator('#sBody')).toContainText('клавиша V');
    // мотор под итогами
    await page.evaluate(() => __drift.audio.init());
    await startQuick(page, { track: 'port', mode: 'time' });
    await page.evaluate(() => { const r = __drift.race; __drift.step(400, { thr: 1 }); r.setAutopilot(r.player, 1); for (let i = 0; i < 200 * 120 && r.phase !== 'done'; i++) __drift.step(1); __drift.showResults(); __drift.manual = false; });
    await page.waitForTimeout(600);
    expect(await page.evaluate(() => __drift.audio.raceBus.gain.value)).toBeLessThan(0.05);
    // пауза по потере фокуса
    await page.evaluate(() => __drift.toMenu());
    await startQuick(page, { track: 'port', mode: 'time' });
    await page.evaluate(() => { __drift.step(400); __drift.manual = false; window.dispatchEvent(new Event('blur')); });
    await expect(page.locator('#scrPause')).toBeVisible();
  });

  test('ИИ, доехавший до финиша трассы «из точки в точку», не мигает сбросами', async ({ page }) => {
    await openDrift(page);
    const r = await page.evaluate(() => {
      const C = __drift.core;
      const race = new C.Race({ track: 'pass', mode: 'race', laps: 1, skipCountdown: true, seed: 2, entries: [{ name: 'ИИ', car: 'buran', ai: { pace: 1 } }, { name: 'Вы', car: 'iskra', isPlayer: true }] });
      const ai = race.cars[0];
      let resetsAfter = 0;
      for (let i = 0; i < 200 * 120; i++) { race.step(C.DT, {}); if (ai.finished && ai.ghost > 1.4) resetsAfter++; }
      return { fin: ai.finished, resetsAfter };
    });
    expect(r.fin).toBe(true);
    expect(r.resetsAfter).toBe(0);
  });

  test('экран победы показывает текущую машину; «Быстрая гонка» не растягивает карточки', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await openDrift(page);
    await page.evaluate(() => { const c = __drift.career; c.d.owned.push('mirage'); c.d.current = 'iskra'; c.save(c.d); __drift.show('main'); c.d.current = 'mirage'; c.save(c.d); __drift.show('victory'); });
    expect(await page.evaluate(() => __drift.render.showroom.car.carId)).toBe('mirage');
    await page.evaluate(() => __drift.show('quick'));
    const h = await page.locator('#qTracks .card').first().evaluate((e) => e.getBoundingClientRect().height);
    expect(h).toBeLessThan(260);
  });

  test('оболочка ОС: postMessage pause останавливает время заезда и мира, resume паузу не снимает; meta application-name', async ({ page }) => {
    await openDrift(page);
    expect(await page.locator('meta[name="application-name"]').getAttribute('content')).toBe('Horizon Drift');
    await startQuick(page, { track: 'port', mode: 'time' });
    await page.evaluate(() => { __drift.step(400, { thr: 1 }); __drift.manual = false; });
    await page.evaluate(() => window.postMessage({ mix: 'pause' }, '*'));
    await expect(page.locator('#scrPause')).toBeVisible();
    const t = await page.evaluate(() => __drift.race.t);
    await page.waitForTimeout(400);
    await page.evaluate(() => window.postMessage({ mix: 'resume' }, '*'));
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => [__drift.race.t, __drift.paused])).toEqual([t, true]);
    await page.evaluate(() => __drift.toMenu());
    await page.evaluate(async () => { await __drift.startWorld('coast', { fest: true }); });
    await page.waitForTimeout(300);
    await page.evaluate(() => window.postMessage({ mix: 'pause' }, '*'));
    await expect(page.locator('#scrPause')).toBeVisible();
    const wt = await page.evaluate(() => __drift.world.t);
    await page.waitForTimeout(400);
    expect(await page.evaluate(() => __drift.world.t)).toBe(wt);
  });

  test('команды паузы от чужого окна (не оболочки) не принимаются', async ({ page }) => {
    await openDrift(page);
    await startQuick(page, { track: 'port', mode: 'time' });
    await page.evaluate(() => { __drift.step(400, { thr: 1 }); __drift.manual = false; });
    await page.evaluate(() => new Promise((res) => {
      const f = document.createElement('iframe');
      f.srcdoc = '<script>parent.postMessage({ mix: "pause" }, "*");<\/script>';
      document.body.appendChild(f); setTimeout(res, 500);
    }));
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => __drift.paused)).toBe(false);
  });
});
