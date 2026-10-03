// Законы «Horizon Drift»: гоночная игра с карьерой (5 кубков), 8 трасс, 8 машин, гараж, ИИ, настройки.
// Всё детерминировано: ?seed= и крючок window.__drift; физика идёт шагами __drift.step без рисования.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { WEB } = require('./helpers');
const { openDrift, startQuick } = require('./_drift-helpers');

const DIR = WEB;
const TRACKS = ['city', 'coast', 'serpentine', 'desert', 'forest', 'pass', 'lake', 'port'];

test.describe('horizon_drift_offline', () => {
  test.describe.configure({ timeout: 90_000 });

  test('открывается без ошибок и без сети; three.js из vendor/; пометка о правообладателе', async ({ page }) => {
    const files = ['index.html', 'js/data.js', 'js/core.js', 'js/audio.js', 'js/render.js', 'js/game.js'];
    for (const f of files) {
      const src = fs.readFileSync(path.join(DIR, f), 'utf8');
      expect(src, f).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
    }
    expect(fs.readFileSync(path.join(DIR, 'index.html'), 'utf8').length).toBeLessThan(150 * 1024);
    const errors = await openDrift(page);
    expect(await page.evaluate(() => THREE.REVISION)).toBe('149');
    await expect(page).toHaveTitle(/фан-концепт, не связан с Microsoft\/Playground Games/);
    await expect(page.locator('#scrMain')).toBeVisible();
    await expect(page.locator('.disclaimer')).toContainText('не связан с Microsoft/Playground Games');
    await page.waitForTimeout(500);
    expect(errors).toEqual([]);
  });

  test('у каждой трассы замкнутый и полный путь чекпоинтов, участки не налезают друг на друга', async ({ page }) => {
    await openDrift(page);
    const rep = await page.evaluate(() => {
      const C = __drift.core;
      return __drift.data.TRACKS.map((d) => {
        const t = C.buildTrack(d.id);
        const s = t.cps.map((c) => c.s);
        const ordered = s.every((v, i) => i === 0 || v > s[i - 1]);
        let maxGap = 0;
        for (let i = 1; i < s.length; i++) maxGap = Math.max(maxGap, s[i] - s[i - 1]);
        if (t.closed) maxGap = Math.max(maxGap, t.L - s[s.length - 1] + s[0]);
        const closeGap = t.closed ? Math.hypot(t.x[0] - t.x[t.N - 1], t.z[0] - t.z[t.N - 1]) : 0;
        return { id: d.id, closed: t.closed, n: t.cps.length, ordered, maxGap, closeGap, step: t.step, clear: C.trackClearance(t).min, need: 2 * t.W + 2,
          p2pFinishAfterStart: t.closed || t.sFinish > t.sStart + 500 };
      });
    });
    expect(rep.map((r) => r.id)).toEqual(TRACKS);
    expect(rep.filter((r) => r.closed).length).toBeGreaterThanOrEqual(4);
    expect(rep.filter((r) => !r.closed).length).toBeGreaterThanOrEqual(2);
    for (const r of rep) {
      expect(r.n, r.id).toBeGreaterThanOrEqual(4);
      expect(r.ordered, r.id).toBe(true);
      expect(r.maxGap, r.id).toBeLessThan(400);
      expect(r.closeGap, r.id).toBeLessThan(r.step * 1.5);
      expect(r.clear, r.id).toBeGreaterThan(r.need);
      expect(r.p2pFinishAfterStart, r.id).toBe(true);
    }
  });

  test('бот по гоночной линии проезжает каждую трассу до финиша (путь проезжаем)', async ({ page }) => {
    await openDrift(page);
    const res = await page.evaluate((tracks) => tracks.map((id) => {
      const C = __drift.core;
      const r = new C.Race({ track: id, mode: 'time', laps: 1, skipCountdown: true, seed: 1, entries: [{ name: 'бот', car: 'iskra', ai: { pace: 0.95, mistakes: 0 } }] });
      r.run(300);
      const c = r.cars[0];
      return { id, finished: c.finished, time: c.finishT, cps: c.nextCp };
    }), TRACKS);
    for (const r of res) { expect(r.finished, r.id).toBe(true); expect(r.time, r.id).toBeGreaterThan(30); }
  });

  test('круги: засчитывается только полный круг; срезка мимо чекпоинта и проезд задом не считаются', async ({ page }) => {
    await openDrift(page);
    const r = await page.evaluate(() => {
      const C = __drift.core;
      const race = new C.Race({ track: 'city', mode: 'race', laps: 3, skipCountdown: true, seed: 1, entries: [{ name: 'Вы', car: 'iskra', isPlayer: true }] });
      const tr = race.track, p = race.player, K = tr.cps.length;
      const cross = (s) => { race.teleport(p, s - 1.5, 0, 20); for (let i = 0; i < 30; i++) race.step(C.DT, { thr: 0.3 }); };
      const events = () => race.events.splice(0).map((e) => e.type);
      // честный круг: старт, все чекпоинты, финиш
      cross(tr.cps[0].s); for (let k = 1; k < K; k++) cross(tr.cps[k].s); cross(tr.cps[0].s + tr.L);
      const lap1 = p.lap; events();
      // срезка: чекпоинт 2 пропущен
      cross(tr.cps[1].s); cross(tr.cps[3].s); cross(tr.cps[0].s + tr.L);
      const afterCut = p.lap, cutEvents = events();
      // задом через линию чекпоинта - не засчитывается
      const before = p.nextCp;
      race.teleport(p, tr.cps[p.nextCp].s + 1.5, 0, -15);
      for (let i = 0; i < 30; i++) race.step(C.DT, {});
      const backwards = p.nextCp;
      // проехать пропущенный и остальные - круг засчитан
      cross(tr.cps[2].s); cross(tr.cps[3].s); cross(tr.cps[0].s + tr.L);
      return { K, lap1, afterCut, cutEvents, before, backwards, lap2: p.lap };
    });
    expect(r.K).toBeGreaterThanOrEqual(4);
    expect(r.lap1).toBe(1);
    expect(r.afterCut).toBe(1);
    expect(r.cutEvents).toContain('missed');
    expect(r.backwards).toBe(r.before);
    expect(r.lap2).toBe(2);
  });

  test('дрифт: дольше и шире занос - больше очков, удар срывает комбо; в игре ручник даёт очки', async ({ page }) => {
    await openDrift(page);
    const r = await page.evaluate(() => {
      const C = __drift.core;
      const run = (secs, ang, speed, crash) => {
        const d = new C.DriftScorer();
        for (let t = 0; t < secs; t += C.DT) d.update(C.DT, ang, speed, true);
        if (crash) d.crash();
        for (let t = 0; t < 2; t += C.DT) d.update(C.DT, 0, speed, true);
        return d.total;
      };
      const short = run(2, 30, 20), long = run(5, 30, 20), narrow = run(3, 18, 20), wide = run(3, 40, 20), crashed = run(3, 30, 20, true), none = run(3, 5, 20);
      // живой занос: разгон, руль и ручник
      const race = new C.Race({ track: 'port', mode: 'drift', laps: 1, skipCountdown: true, seed: 1, entries: [{ name: 'Вы', car: 'vihr', isPlayer: true }] });
      const p = race.player; p.assist.tc = false; p.assist.steer = false;
      race.teleport(p, race.track.sStart + 5, 0, 26);
      for (let i = 0; i < 40; i++) race.step(C.DT, { thr: 1, steer: 1, hb: 1 });
      let maxBeta = 0;
      for (let i = 0; i < 200; i++) { race.step(C.DT, { thr: 1, steer: 0.4 }); maxBeta = Math.max(maxBeta, Math.abs(p.beta)); }
      for (let i = 0; i < 400; i++) race.step(C.DT, { brk: 1 });
      return { short, long, narrow, wide, crashed, none, live: race.drift.total, maxBeta: maxBeta * 180 / Math.PI };
    });
    expect(r.long).toBeGreaterThan(r.short);
    expect(r.wide).toBeGreaterThan(r.narrow);
    expect(r.crashed).toBe(0);
    expect(r.none).toBe(0);
    expect(r.maxBeta).toBeGreaterThan(15);
    expect(r.live).toBeGreaterThan(0);
  });

  test('медали и открытие кубков по правилам; победа после последнего кубка', async ({ page }) => {
    await openDrift(page);
    const r = await page.evaluate(() => {
      const C = __drift.core, D = __drift.data;
      const race = D.CUPS[0].events.find((e) => e.type === 'race'), drift = D.CUPS[0].events.find((e) => e.type === 'drift');
      const time = D.CUPS[0].events.find((e) => e.type === 'time'), duel = D.CUPS[1].events.find((e) => e.type === 'duel');
      const th = C.timeThresholds(time);
      const m = {
        race: [1, 2, 3, 4].map((place) => C.medalFor(race, { place })),
        duel: [1, 2].map((place) => C.medalFor(duel, { place })),
        drift: [drift.goal[0], drift.goal[1], drift.goal[2], drift.goal[2] - 1].map((pts) => C.medalFor(drift, { drift: pts })),
        time: [th[0] - 0.01, th[1], th[2], th[2] + 0.5].map((t) => C.medalFor(time, { time: t, thresholds: th })),
        th,
      };
      const car = new C.Career(null);
      const locked2 = car.cupUnlocked(1);
      const early = car.applyResult(D.CUPS[1].events[0].id, { place: 1 });       // закрытый кубок не принимает результат
      car.applyResult(race.id, { place: 4 });                                   // без медали
      const afterFail = car.cupUnlocked(1);
      car.applyResult(race.id, { place: 3 });
      car.applyResult(drift.id, { drift: drift.goal[1] });
      const partial = car.cupUnlocked(1);
      const last = car.applyResult(time.id, { time: th[0], thresholds: th });
      const open2 = car.cupUnlocked(1), open3 = car.cupUnlocked(2);
      car.applyResult(race.id, { place: 5 });                                   // хуже - медаль не отнимается
      const kept = car.eventMedal(race.id);
      // пройти все кубки
      let vict = null;
      D.CUPS.forEach((cup, ci) => cup.events.forEach((e) => {
        const res = e.type === 'drift' ? { drift: e.goal[0] } : e.type === 'time' ? { time: 1, thresholds: [2, 3, 4] } : { place: 1 };
        const a = car.applyResult(e.id, res); if (a && a.victory) vict = e.id;
      }));
      return { m, locked2, early, afterFail, partial, cupDone: last.cupDone, unlocked: last.unlocked && last.unlocked.id, open2, open3, kept, vict, lastEvt: D.CUPS[4].events[D.CUPS[4].events.length - 1].id, victory: car.d.victory };
    });
    expect(r.m.race).toEqual(['gold', 'silver', 'bronze', null]);
    expect(r.m.duel).toEqual(['gold', null]);
    expect(r.m.drift).toEqual(['gold', 'silver', 'bronze', null]);
    expect(r.m.time).toEqual(['gold', 'silver', 'bronze', null]);
    expect(r.m.th[0]).toBeLessThan(r.m.th[1]);
    expect(r.locked2).toBe(false);
    expect(r.early).toBeNull();
    expect(r.afterFail).toBe(false);
    expect(r.partial).toBe(false);
    expect(r.cupDone).toBe(true);
    expect(r.unlocked).toBe('c2');
    expect(r.open2).toBe(true);
    expect(r.open3).toBe(false);
    expect(r.kept).toBe('bronze');
    expect(r.vict).toBe(r.lastEvt);
    expect(r.victory).toBe(true);
  });

  test('деньги: приходят за места, уходят на покупки и тюнинг, в минус не уходят', async ({ page }) => {
    await openDrift(page);
    const r = await page.evaluate(() => {
      const C = __drift.core, D = __drift.data;
      const car = new C.Career(null), evt = D.CUPS[0].events[0];
      const m0 = car.money;
      const a1 = car.applyResult(evt.id, { place: 1 }), m1 = car.money;
      const a2 = car.applyResult(evt.id, { place: 2 }), m2 = car.money;
      const poor = car.buyCar('mirage'), mPoor = car.money;
      const price = car.upgradePrice('iskra', 'engine');
      const up = car.buyUpgrade('iskra', 'engine'), mUp = car.money;
      car.d.money = price - 1;
      const upPoor = car.buyUpgrade('iskra', 'tyres');
      car.d.money = 9000;
      const buy = car.buyCar('kobalt');
      const levels = [1, 2, 3].map(() => { car.d.money = 1e6; return car.buyUpgrade('iskra', 'tyres').ok; });
      const over = car.buyUpgrade('iskra', 'tyres');
      return { m0, a1: a1.reward, m1, a2: a2.reward, m2, poor: poor.ok, mPoor, price, up: up.ok, mUp, upPoor: upPoor.ok, moneyAfterPoor: price - 1,
        buy: buy.ok, afterBuy: car.d.owned.includes('kobalt'), levels, over: over.ok, base: D.BASE_REWARD, share: D.PLACE_SHARE.slice(0, 2) };
    });
    expect(r.m0).toBe(2000);                                   // стартовый капитал
    expect(r.a1).toBe(r.base * r.share[0]);
    expect(r.m1).toBe(r.m0 + r.a1);
    expect(r.a2).toBe(r.base * r.share[1]);
    expect(r.m2).toBe(r.m0 + r.a1 + r.a2);
    expect(r.poor).toBe(false);
    expect(r.mPoor).toBe(r.m2);
    expect(r.up).toBe(true);
    expect(r.mUp).toBe(r.m2 - r.price);
    expect(r.upPoor).toBe(false);
    expect(r.buy).toBe(true);
    expect(r.afterBuy).toBe(true);
    expect(r.levels).toEqual([true, true, true]);
    expect(r.over).toBe(false);
  });

  test('тюнинг меняет характеристики ровно по таблице', async ({ page }) => {
    await openDrift(page);
    const r = await page.evaluate(() => {
      const C = __drift.core, D = __drift.data;
      const out = {};
      for (const def of D.CARS) {
        const b = C.carStats(def.id, {});
        for (const u of D.UPGRADES) for (const lv of [1, 3]) {
          const s = C.carStats(def.id, { [u.id]: lv });
          for (const k in u.eff) out[`${def.id}.${u.id}.${lv}.${k}`] = [s[k] / b[k], 1 + u.eff[k] * lv];
        }
      }
      const b = C.carStats('iskra', {}), s = C.carStats('iskra', { engine: 3, tyres: 3, weight: 3 });
      return { out, faster: C.accelTime(s) < C.accelTime(b), grip: s.grip > b.grip, mass: s.mass < b.mass };
    });
    for (const k in r.out) expect(r.out[k][0], k).toBeCloseTo(r.out[k][1], 6);
    expect(r.faster).toBe(true);
    expect(r.grip && r.mass).toBe(true);
  });

  test('сцепление на снегу меньше, чем на асфальте: тормозной путь длиннее, поворот слабее', async ({ page }) => {
    await openDrift(page);
    const r = await page.evaluate(() => {
      const C = __drift.core;
      const brake = (surf) => { const c = C.makeCar(C.carStats('kobalt')); c.vz = 25; c.inp.brk = 1; let d = 0; for (let i = 0; i < 3000; i++) { const z0 = c.z; C.stepCar(c, C.DT, surf); d += c.z - z0; if (c.speed < 0.1) break; } return d; };
      // боковое ускорение по повороту вектора скорости (не по вращению кузова - на снегу машину может крутить)
      const turn = (surf) => { const c = C.makeCar(C.carStats('kobalt')); c.vz = 22; c.inp.steer = 1; c.inp.thr = 0.3; let a = 0, prev = 0;
        for (let i = 0; i < 360; i++) { C.stepCar(c, C.DT, surf); if (i % 12 === 0) { const ang = Math.atan2(c.vx, c.vz); let d = ang - prev; if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI; if (i > 0) a = Math.max(a, Math.abs(d) / (12 * C.DT) * c.speed); prev = ang; } } return a; };
      return { mu: [C.surfMu('asphalt', C.carStats('kobalt')), C.surfMu('gravel', C.carStats('kobalt')), C.surfMu('snow', C.carStats('kobalt'))],
        brakeA: brake('asphalt'), brakeS: brake('snow'), turnA: turn('asphalt'), turnS: turn('snow'), rally: C.surfMu('snow', C.carStats('buran')) };
    });
    expect(r.mu[2]).toBeLessThan(r.mu[1]);
    expect(r.mu[1]).toBeLessThan(r.mu[0]);
    expect(r.brakeS).toBeGreaterThan(r.brakeA * 1.4);
    expect(r.turnS).toBeLessThan(r.turnA * 0.8);
    expect(r.rally).toBeGreaterThan(r.mu[2]);
  });

  test('ИИ доезжает до финиша; на «сложно» быстрее, чем на «легко»; соперники не проходят сквозь машины', async ({ page }) => {
    await openDrift(page);
    const r = await page.evaluate(() => {
      const C = __drift.core, D = __drift.data;
      const lap = (diff, noMistakes) => { const d = D.DIFFICULTY[diff]; const race = new C.Race({ track: 'coast', mode: 'time', laps: 1, skipCountdown: true, seed: 5,
        entries: [{ name: 'ИИ', car: 'kobalt', ai: { pace: 0.88 + d.pace, mistakes: noMistakes ? 0 : d.mistakes } }] }); race.run(300); return race.cars[0].finished ? race.cars[0].finishT : 999; };
      // полная гонка из 6 ИИ: все финишируют, ни разу две машины не стоят друг в друге
      const cup = D.CUPS[1];
      const entries = C.eventEntries(cup.events[0], 1, { difficulty: 'normal', car: 'kobalt', seed: 3 }).filter((e) => !e.isPlayer);
      entries.push({ name: 'ещё', car: 'vihr', ai: { pace: 0.86, mistakes: 0.02 } });
      const race = new C.Race({ track: 'city', mode: 'race', laps: 2, skipCountdown: true, seed: 3, entries });
      let overlap = 0;
      for (let i = 0; i < 300 / C.DT && race.phase !== 'done'; i++) {
        race.step(C.DT);
        const cs = race.cars;
        for (let a = 0; a < cs.length; a++) for (let b = a + 1; b < cs.length; b++) if (cs[a].ghost <= 0 && cs[b].ghost <= 0 && Math.hypot(cs[a].x - cs[b].x, cs[a].z - cs[b].z) < 1.2) overlap++;
      }
      return { easy: lap('easy'), hard: lap('hard'), easyClean: lap('easy', true), hardClean: lap('hard', true), all: race.cars.every((c) => c.finished), n: race.cars.length, overlap };
    });
    expect(r.hard).toBeLessThan(r.easy);
    expect(r.hardClean).toBeLessThan(r.easyClean * 0.97);             // и без ошибок: темп на «сложно» выше
    expect(r.easy).toBeLessThan(999);
    expect(r.n).toBe(5);
    expect(r.all).toBe(true);
    expect(r.overlap).toBe(0);
  });

  test('машина: газ разгоняет, руль поворачивает, тормоз замедляет, нитро прибавляет, стена останавливает', async ({ page }) => {
    await openDrift(page);
    const r = await page.evaluate(() => {
      const C = __drift.core;
      const race = new C.Race({ track: 'coast', mode: 'race', laps: 1, skipCountdown: true, seed: 1, entries: [{ name: 'Вы', car: 'kobalt', isPlayer: true }] });
      const p = race.player;
      for (let i = 0; i < 480; i++) race.step(C.DT, { thr: 1 });
      const v1 = p.speed, h0 = p.h;
      for (let i = 0; i < 60; i++) race.step(C.DT, { thr: 1, steer: 1 });
      const turned = Math.abs(p.h - h0);
      for (let i = 0; i < 120; i++) race.step(C.DT, { brk: 1 });
      const v2 = p.speed;
      const a = C.makeCar(C.carStats('kobalt')), b = C.makeCar(C.carStats('kobalt'));
      a.vz = b.vz = 20; a.inp.thr = b.inp.thr = 1; b.inp.nitro = 1;
      for (let i = 0; i < 240; i++) { C.stepCar(a, C.DT, 'asphalt'); C.stepCar(b, C.DT, 'asphalt'); }
      race.teleport(p, 400, 0, 0); p.h += Math.PI / 2; p.vx = Math.sin(p.h) * 30; p.vz = Math.cos(p.h) * 30;
      let hit = 0; for (let i = 0; i < 120; i++) { race.step(C.DT, {}); hit = Math.max(hit, p.hit); }
      return { v1, turned, v2, nitro: b.speed - a.speed, hit, inside: Math.abs(p.pr.d) < race.track.W };
    });
    expect(r.v1).toBeGreaterThan(15);
    expect(r.turned).toBeGreaterThan(0.1);
    expect(r.v2).toBeLessThan(r.v1 * 0.6);
    expect(r.nitro).toBeGreaterThan(2);
    expect(r.hit).toBeGreaterThan(5);
    expect(r.inside).toBe(true);
  });

  test('заезд в игре: отсчёт, HUD, неверное направление, пауза Esc останавливает время', async ({ page }) => {
    await openDrift(page);
    await startQuick(page, { track: 'port', mode: 'race', opp: 3, laps: 2 });
    await expect(page.locator('#hud')).toBeVisible();
    const cd = await page.evaluate(() => { const r = __drift.race; const a = r.phase; __drift.step(4 * 120, { thr: 1 }); return [a, r.phase, r.player.speed > 1]; });
    expect(cd).toEqual(['countdown', 'race', true]);
    await page.evaluate(() => { __drift.manual = false; });
    await expect(page.locator('#hPos small')).toHaveText('/4');
    await expect(page.locator('#hBoard div')).toHaveCount(4);
    // едем задом наперёд - стрелка «Не туда»
    await page.evaluate(() => { const r = __drift.race, p = r.player; __drift.manual = true; r.teleport(p, 300, 0, 0); p.h += Math.PI; __drift.step(240, { thr: 1 }); __drift.manual = false; });
    await expect(page.locator('#hWrong')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#scrPause')).toBeVisible();
    await expect(page.locator('#scrPause button')).toHaveText(['Продолжить', 'Настройки', 'Заново', 'В меню']);
    const t = await page.evaluate(() => __drift.race.t);
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => { __drift.step(60, { thr: 1 }); return __drift.race.t; })).toBe(t);
    await page.keyboard.press('Escape');
    await expect(page.locator('#scrPause')).toBeHidden();
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => __drift.race.t)).toBeGreaterThan(t);
  });

  test('скрытая вкладка: пауза и тишина; вернулись - пауза остаётся', async ({ page }) => {
    await openDrift(page);
    await page.evaluate(() => __drift.audio.init());
    await startQuick(page, { track: 'city', mode: 'race', opp: 1, laps: 1 });
    await page.evaluate(() => { __drift.step(400, { thr: 1 }); __drift.manual = false; });
    const setHidden = (h) => page.evaluate((h) => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
      document.dispatchEvent(new Event('visibilitychange'));
    }, h);
    await setHidden(true);
    await expect(page.locator('#scrPause')).toBeVisible();
    expect(await page.evaluate(() => __drift.paused)).toBe(true);
    await expect.poll(() => page.evaluate(() => __drift.audio.ctx.state)).toBe('suspended');
    const t = await page.evaluate(() => __drift.race.t);
    await page.waitForTimeout(300);
    await setHidden(false);
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => [__drift.paused, __drift.race.t])).toEqual([true, t]);
    await expect(page.locator('#scrPause')).toBeVisible();
  });

  test('настройки: громкость, единицы и клавиши применяются сразу и сохраняются; конфликт клавиш виден', async ({ page }) => {
    await openDrift(page);
    await page.evaluate(() => __drift.audio.init());
    await page.locator('.mainnav button[data-go="settings"]').click();
    const music = page.locator('input[data-range="musicVol"]');
    await music.fill('0.25');
    expect(await page.evaluate(() => __drift.audio.musicBus.gain.value)).toBeCloseTo(0.25, 5);
    await page.locator('input[data-range="engineVol"]').fill('0');
    expect(await page.evaluate(() => __drift.audio.engineBus.gain.value)).toBe(0);
    await page.locator('#sTabs button[data-tab="game"]').click();
    await page.locator('[data-set="units"] button[data-v="mph"]').click();
    await page.locator('#sTabs button[data-tab="controls"]').click();
    await page.locator('.keyslot[data-act="accel"][data-slot="0"]').click();
    await page.keyboard.press('KeyI');
    await expect(page.locator('.keyslot[data-act="accel"][data-slot="0"]')).toHaveText('I');
    // конфликт: газ на клавишу правого руля - клавиши меняются местами, об этом видно сообщение
    await page.locator('.keyslot[data-act="accel"][data-slot="0"]').click();
    await page.keyboard.press('KeyD');
    await expect(page.locator('#toast')).toContainText('поменяли местами');
    await expect(page.locator('.keyslot.conflict')).toHaveCount(1);
    const b = await page.evaluate(() => __drift.settings.bindings);
    expect(b.accel[0]).toBe('KeyD');
    expect(b.right[0]).toBe('KeyI');
    await page.reload();
    await page.waitForFunction(() => window.__drift && __drift.ready);
    const s = await page.evaluate(() => { __drift.audio.init(); return { s: __drift.settings, g: __drift.audio.musicBus.gain.value }; });
    expect(s.s.musicVol).toBe(0.25);
    expect(s.g).toBeCloseTo(0.25, 5);
    expect(s.s.units).toBe('mph');
    expect(s.s.bindings.accel[0]).toBe('KeyD');
    // новая клавиша газа работает в заезде, скорость - в mph
    await startQuick(page, { track: 'port', mode: 'time' });
    await page.evaluate(() => { __drift.step(3.2 * 120); __drift.manual = false; });
    await page.keyboard.down('KeyD');
    // время заезда идёт от кадров; на медленной машине кадры реже - ждём по скорости, а не по часам
    await expect.poll(() => page.evaluate(() => __drift.player.speed), { timeout: 30_000 }).toBeGreaterThan(5);
    await page.keyboard.up('KeyD');
    const v = await page.evaluate(() => __drift.player.speed);
    const shot = await page.evaluate(() => { const g = document.getElementById('hSpeedC'); return g.toDataURL().length; });
    expect(shot).toBeGreaterThan(1000);
    expect(await page.evaluate((v) => Math.round(__drift.core.toUnits(v, 'mph')) < Math.round(v * 3.6), v)).toBe(true);
  });

  test('геймпад: стик рулит плавно, курок - газ; графика применяется сразу; настройки из паузы возвращают в паузу', async ({ page }) => {
    await page.addInitScript(() => {
      const pad = { id: 'Тестовый геймпад', connected: true, axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })) };
      window.__pad = pad;
      navigator.getGamepads = () => [pad];
    });
    await openDrift(page);
    await startQuick(page, { track: 'port', mode: 'time' });
    const r = await page.evaluate(() => {
      __drift.step(3.2 * 120);
      __pad.axes[0] = 0.6; __pad.buttons[7].value = 1; __pad.buttons[7].pressed = true;
      __drift.step(240);
      const p = __drift.player;
      return { steerIn: p.inp.steer, analog: p.inp.analog, thr: p.inp.thr, v: p.speed };
    });
    expect(r.analog).toBe(true);
    expect(r.steerIn).toBeGreaterThan(0.2);
    expect(r.steerIn).toBeLessThan(0.9);
    expect(r.thr).toBe(1);
    expect(r.v).toBeGreaterThan(5);
    await page.evaluate(() => { __pad.axes[0] = 0; __pad.buttons[7].value = 0; __pad.buttons[7].pressed = false; __drift.manual = false; });
    // графика
    await page.evaluate(() => __drift.setSetting('quality', 'high'));
    expect(await page.evaluate(() => __drift.renderer.shadowMap.enabled)).toBe(true);
    await page.evaluate(() => __drift.setSetting('shadows', false));
    expect(await page.evaluate(() => __drift.renderer.shadowMap.enabled)).toBe(false);
    await page.evaluate(() => __drift.setSetting('drawDist', 'near'));
    expect(await page.evaluate(() => __drift.render.race.scene.fog.far)).toBe(380);
    await page.evaluate(() => __drift.setSetting('showFps', true));
    await expect(page.locator('#hFps')).toBeVisible();
    // настройки из паузы и обратно
    await page.keyboard.press('Escape');
    await page.locator('#pSettings').click();
    await expect(page.locator('#scrSettings')).toBeVisible();
    await page.locator('#scrSettings [data-back]').click();
    await expect(page.locator('#scrPause')).toBeVisible();
    expect(await page.evaluate(() => [__drift.screen, __drift.paused])).toEqual(['race', true]);
  });

  test('карьера: гонка из меню, итог с медалью и деньгами, прогресс переживает перезагрузку', async ({ page }) => {
    await openDrift(page);
    // быстрая машина, чтобы автопилот уверенно выиграл: проверяется путь карьеры, а не баланс
    await page.evaluate(() => { const c = __drift.career; c.d.owned.push('mirage'); c.d.current = 'mirage'; c.d.upg.mirage = { engine: 3, tyres: 3, susp: 3, weight: 3, nitro: 3 }; c.save(c.d); });
    await page.locator('.mainnav button[data-go="career"]').click();
    await expect(page.locator('#cupsGrid .card')).toHaveCount(5);
    await expect(page.locator('#cupsGrid .card[data-cup="1"]')).toBeDisabled();
    await page.locator('#cupsGrid .card[data-cup="0"]').click();
    await expect(page.locator('#eventsGrid .card')).toHaveCount(3);
    await page.evaluate(() => { __drift.manual = true; });
    await page.locator('#eventsGrid .go').first().click();
    await page.waitForFunction(() => __drift.screen === 'race');
    // автопилот быстрее соперников первого кубка
    const res = await page.evaluate(() => {
      const r = __drift.race, m0 = __drift.career.money; r.setAutopilot(r.player, 1.0);
      for (let i = 0; i < 400 * 120 && r.phase !== 'done'; i++) __drift.step(1);
      __drift.showResults();
      return { place: r.result.place, apply: __drift.lastApply, money: __drift.career.money, start: m0 };
    });
    expect(res.place).toBe(1);
    expect(res.apply.medal).toBe('gold');
    expect(res.money).toBe(res.start + res.apply.reward);
    await expect(page.locator('#scrResults')).toBeVisible();
    await expect(page.locator('#resMedal')).toHaveText('Золото');
    await expect(page.locator('#resTable tr.me')).toContainText('Вы');
    await page.locator('#resNext').click();
    await expect(page.locator('#scrCup')).toBeVisible();
    await expect(page.locator('#eventsGrid .medal.gold')).toHaveCount(1);
    await page.reload();
    await page.waitForFunction(() => window.__drift && __drift.ready);
    const after = await page.evaluate(() => ({ money: __drift.career.money, medal: __drift.career.eventMedal('c1e1'), rec: __drift.records.tracks.city }));
    expect(after.money).toBe(res.money);
    expect(after.medal).toBe('gold');
    expect(after.rec.lap).toBeGreaterThan(20);
  });

  test('последнее событие последнего кубка открывает экран победы с титрами', async ({ page }) => {
    await openDrift(page);
    await page.evaluate(() => {
      const D = __drift.data, c = __drift.career;
      D.CUPS.forEach((cup) => cup.events.forEach((e) => { c.d.res[e.id] = { medal: 'gold', best: 1 }; }));
      delete c.d.res.c5e4;
      c.d.owned.push('mirage'); c.d.current = 'mirage'; c.d.upg.mirage = { engine: 3, tyres: 3, susp: 3, weight: 3, nitro: 3 }; c.save(c.d);
      __drift.setSetting('difficulty', 'easy');
      __drift.manual = true;
    });
    await page.evaluate(() => __drift.startCareer('c5e4'));
    const res = await page.evaluate(() => {
      const r = __drift.race; r.setAutopilot(r.player, 1.0);
      for (let i = 0; i < 600 * 120 && r.phase !== 'done'; i++) __drift.step(1);
      __drift.showResults();
      return { place: r.result.place, apply: __drift.lastApply };
    });
    expect(res.place).toBe(1);
    expect(res.apply.victory).toBe(true);
    await expect(page.locator('#resNext')).toHaveText('К награде');
    await page.locator('#resNext').click();
    await expect(page.locator('#scrVictory')).toBeVisible();
    await expect(page.locator('#scrVictory h2')).toHaveText('Чемпион Горизонта!');
    await expect(page.locator('#creditsRoll')).toContainText('не связан с Microsoft/Playground Games');
  });

  test('гараж: покупка за деньги, тюнинг кнопкой, 3D-витрина с вращением', async ({ page }) => {
    await openDrift(page);
    await page.evaluate(() => { const c = __drift.career; c.d.money = 11000; c.save(c.d); });
    await page.locator('.mainnav button[data-go="garage"]').click();
    await expect(page.locator('#gCars .card')).toHaveCount(8);
    await page.locator('#gCars .card[data-car="mirage"]').click();
    await expect(page.locator('#gBuy')).toBeDisabled();
    await page.locator('#gCars .card[data-car="kobalt"]').click();
    await page.locator('#gBuy').click();
    await page.locator('#mdYes').click();
    await expect(page.locator('#gSelect')).toHaveText('Выбрана для гонок');
    expect(await page.evaluate(() => [__drift.career.money, __drift.career.d.current])).toEqual([3000, 'kobalt']);
    await page.locator('#gTabs button[data-tab="tune"]').click();
    const before = await page.evaluate(() => __drift.core.carStats('kobalt', __drift.career.d.upg.kobalt).power);
    await page.locator('button[data-upg="engine"]').click();
    const after = await page.evaluate(() => ({ p: __drift.core.carStats('kobalt', __drift.career.d.upg.kobalt).power, m: __drift.career.money }));
    expect(after.p).toBeCloseTo(before * 1.1, 3);
    expect(after.m).toBeLessThan(3000);
    const a0 = await page.evaluate(() => __drift.render.showroom.angle);
    const box = await page.locator('#gStage').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2, { steps: 5 }); await page.mouse.up();
    expect(Math.abs(await page.evaluate(() => __drift.render.showroom.angle) - a0)).toBeGreaterThan(0.5);
    await page.locator('#gTabs button[data-tab="look"]').click();
    await page.locator('[data-look="livery"][data-v="flames"]').click();
    expect(await page.evaluate(() => __drift.career.look('kobalt').livery)).toBe('flames');
  });

  test('один рендерер на все заезды: после трёх заездов холст по-прежнему один', async ({ page }) => {
    await openDrift(page);
    const r = await page.evaluate(async () => {
      const seen = new Set();
      for (const t of ['port', 'city', 'lake']) { __drift.manual = true; await __drift.startQuick({ track: t, mode: 'time' }); seen.add(__drift.renderer); __drift.toMenu(); }
      return { renderers: seen.size, gl: document.querySelectorAll('canvas#gl').length, screen: __drift.screen };
    });
    expect(r).toEqual({ renderers: 1, gl: 1, screen: 'main' });
  });

  for (const size of [{ width: 1024, height: 700 }, { width: 1920, height: 1080 }]) {
    test(`всё влезает в окно ${size.width}x${size.height}`, async ({ page }) => {
      await page.setViewportSize(size);
      await openDrift(page);
      const fits = (sel) => page.evaluate((sel) => {
        const de = document.documentElement, out = [];
        if (de.scrollWidth > innerWidth || de.scrollHeight > innerHeight) out.push('прокрутка страницы');
        for (const el of document.querySelectorAll(sel)) {
          const r = el.getBoundingClientRect();
          if (r.width === 0) continue;
          if (r.left < -0.5 || r.top < -0.5 || r.right > innerWidth + 0.5 || r.bottom > innerHeight + 0.5) out.push(sel + ' ' + (el.id || el.textContent.slice(0, 20)));
        }
        return out;
      }, sel);
      expect(await fits('.mainnav button, .carbadge, .disclaimer, #mMoney')).toEqual([]);
      await page.locator('.mainnav button[data-go="garage"]').click();
      expect(await fits('#gPanel, #gCars, #gActions button, .head')).toEqual([]);
      await page.locator('#scrGarage [data-back]').click();
      await page.locator('.mainnav button[data-go="settings"]').click();
      expect(await fits('#scrSettings .box, #sTabs')).toEqual([]);
      await page.locator('#scrSettings [data-back]').click();
      await page.locator('.mainnav button[data-go="quick"]').click();
      expect(await fits('#qStart, #qMode, .head')).toEqual([]);
      await startQuick(page, { track: 'city', mode: 'race', opp: 5, laps: 2 });
      await page.evaluate(() => { __drift.step(3.5 * 120, { thr: 1 }); __drift.manual = false; });
      expect(await fits('#hInfo, #hBoard, #hMap, #hSpeedo, #hNitro, #hNitro span, #hKeys, #hPauseBtn')).toEqual([]);
      const overlap = await page.evaluate(() => {
        const els = ['hInfo', 'hBoard', 'hMap', 'hSpeedo', 'hNitro', 'hKeys'].map((i) => document.getElementById(i)).concat([document.querySelector('#hNitro span')]);
        const ids = els.map((e) => e.id || 'nitroLabel'), rs = els.map((e) => e.getBoundingClientRect()), bad = [];
        for (let a = 0; a < rs.length; a++) for (let b = a + 1; b < rs.length; b++) {
          const A = rs[a], B = rs[b];
          if (A.width && B.width && A.left < B.right && B.left < A.right && A.top < B.bottom && B.top < A.bottom) bad.push(ids[a] + '/' + ids[b]);
        }
        return bad;
      });
      expect(overlap).toEqual([]);
    });
  }

  test('скорость симуляции: 6 машин - шаг физики укладывается с большим запасом в кадр', async ({ page }) => {
    await openDrift(page);
    const ms = await page.evaluate(() => {
      const C = __drift.core, D = __drift.data;
      const entries = C.eventEntries(D.CUPS[4].events[3], 4, { difficulty: 'normal', car: 'mirage', seed: 1 });
      const r = new C.Race({ track: 'port', mode: 'race', laps: 3, skipCountdown: true, seed: 1, entries });
      r.setAutopilot(r.player, 0.9);
      const t0 = performance.now(); for (let i = 0; i < 1200; i++) r.step(C.DT); return (performance.now() - t0) / 600;
    });
    // на кадр 60 Гц приходится 2 шага физики; им отведено меньше 4 мс из 16.7
    expect(ms).toBeLessThan(4);
  });
});
