// Законы нитро «Horizon Drift»: запас тратится, пока кнопка зажата, не уходит ниже нуля, копится с расчётной
// скоростью (в заносе быстрее), а на пустом баллоне кнопка не толкает машину.
// Недочёт 10.10 («Бесконечное нитро!!»): запас каждый шаг подкапывал на 0.012/с (в мире - 0.02/с), и этой капли
// хватало, чтобы на следующем шаге включить толчок целиком: полоса пустая, а машина разгоняется без конца.
const { test, expect } = require('@playwright/test');
const { openDrift } = require('./_drift-helpers');

test.describe('horizon_drift_offline: нитро', () => {
  test.describe.configure({ timeout: 120_000 });

  test('заезд: зажатое нитро тратит запас за nitroCap секунд, ниже нуля не уходит, пустой баллон не толкает', async ({ page }) => {
    await openDrift(page);
    const r = await page.evaluate(() => {
      const C = __drift.core;
      const mk = () => new C.Race({ track: 'coast', mode: 'race', laps: 3, skipCountdown: true, seed: 1, entries: [{ name: 'Вы', car: 'kobalt', isPlayer: true }] });
      const a = mk(), b = mk(), pa = a.player, pb = b.player, cap = pa.st.nitroCap, steps = Math.round(1 / (1 / cap - 0.012) / C.DT);
      let minN = 1, onAfterEmpty = 0, emptyAt = -1, after = 0;
      // a держит нитро всё время, b - только пока баллон не опустел; руль прямо, стены не мешают на первых секундах
      for (let i = 0; i < 6 / C.DT; i++) {
        a.step(C.DT, { thr: 1, nitro: 1 });
        b.step(C.DT, { thr: 1, nitro: i < steps + 4 ? 1 : 0 });
        minN = Math.min(minN, pa.nitro);
        // после шага в запасе уже капля пополнения этого шага (0.012/с * DT), поэтому «пусто» - почти ноль и нитро не горит
        if (emptyAt < 0 && pa.nitro < 0.001 && !pa.nitroOn) emptyAt = i;
        if (emptyAt >= 0 && i > emptyAt) { after++; if (pa.nitroOn) onAfterEmpty++; }
      }
      return { cap, emptyT: (emptyAt + 1) * C.DT, minN, onAfterEmpty, after, dv: pa.speed - pb.speed, nitroA: pa.nitro };
    });
    // расход 1/nitroCap в секунду, пополнение 0.012/с идёт и под нитро
    const full = 1 / (1 / r.cap - 0.012);
    expect(r.emptyT).toBeGreaterThan(full - 0.03);
    expect(r.emptyT).toBeLessThan(full + 0.03);
    expect(r.minN).toBeGreaterThanOrEqual(0);
    expect(r.minN).toBeLessThan(0.0002);
    expect(r.after).toBeGreaterThan(200);
    // капля пополнения не включает толчок: после опустения нитро не горит
    expect(r.onAfterEmpty).toBe(0);
    // держать кнопку на пустом баллоне - не быстрее, чем отпустить
    expect(Math.abs(r.dv)).toBeLessThan(0.05);
    expect(r.nitroA).toBeGreaterThan(0);
  });

  test('заезд: запас копится 0.012 в секунду, в заносе - быстрее; после опустения нитро снова работает с 10%', async ({ page }) => {
    await openDrift(page);
    const r = await page.evaluate(() => {
      const C = __drift.core;
      const race = new C.Race({ track: 'coast', mode: 'race', laps: 3, skipCountdown: true, seed: 1, entries: [{ name: 'Вы', car: 'kobalt', isPlayer: true }] });
      const p = race.player;
      p.nitro = 0.5;
      for (let i = 0; i < 120; i++) race.step(C.DT, { thr: 0.5 });
      const rate = (p.nitro - 0.5) / (120 * C.DT);
      // пустой баллон: кнопка зажата, но толчка нет, пока запас не вернётся к 10%
      p.nitro = 0; p.nitroLock = true;
      let firstOn = -1;
      for (let i = 0; i < 12 / C.DT && firstOn < 0; i++) { race.step(C.DT, { thr: 0.6, nitro: 1 }); if (p.nitroOn) firstOn = i; }
      const rearmN = (firstOn + 1) * C.DT * 0.012;
      // занос: шаги, где очки дрифта идут, дают запаса больше, чем шаги без заноса
      const d = new C.Race({ track: 'coast', mode: 'drift', laps: 1, skipCountdown: true, seed: 2, entries: [{ name: 'Вы', car: 'kometa', isPlayer: true }] });
      d.setAutopilot(d.player, 0.8, true);
      let inc = 0, n = 0, incNo = 0, nNo = 0;
      for (let i = 0; i < 60 / C.DT; i++) {
        d.player.nitro = 0.3; d.step(C.DT);
        const di = d.player.nitro - 0.3 + (d.player.nitroOn ? C.DT / d.player.st.nitroCap : 0);
        if (d.drift.drifting) { inc += di; n++; } else { incNo += di; nNo++; }
      }
      return { rate, firstOn, rearmN, drift: n ? inc / n / C.DT : 0, noDrift: nNo ? incNo / nNo / C.DT : 0, n };
    });
    expect(r.rate).toBeGreaterThan(0.0115);
    expect(r.rate).toBeLessThan(0.0125);
    expect(r.firstOn).toBeGreaterThan(0);
    expect(r.rearmN).toBeGreaterThan(0.095);
    expect(r.rearmN).toBeLessThan(0.11);
    expect(r.n).toBeGreaterThan(100);
    expect(r.noDrift).toBeGreaterThan(0.0115);
    expect(r.noDrift).toBeLessThan(0.0125);
    expect(r.drift).toBeGreaterThan(0.06);
  });

  test('свободная езда: зажатое нитро кончается, пустой баллон не толкает, запас копится 0.02 в секунду', async ({ page }) => {
    await openDrift(page);
    const r = await page.evaluate(() => {
      const WD = __drift.worldData;
      const mk = () => new WD.World({ map: 'coast', car: 'kobalt', seed: 1, traffic: false });
      const a = mk(), b = mk(), pa = a.player, pb = b.player, cap = pa.st.nitroCap, DT = __drift.core.DT;
      a.rivals.length = 0; b.rivals.length = 0; a.cars.length = 1; b.cars.length = 1;
      let emptyAt = -1, onAfter = 0;
      for (let i = 0; i < 5 / DT; i++) {
        a.step(DT, { thr: 1, nitro: 1 });
        b.step(DT, { thr: 1, nitro: i * DT < 1 / (1 / cap - 0.02) + 0.02 ? 1 : 0 });
        if (emptyAt < 0 && pa.nitro < 0.001 && !pa.nitroOn) emptyAt = i;
        if (emptyAt >= 0 && i > emptyAt && pa.nitroOn) onAfter++;
      }
      const n0 = pa.nitro, dv = pa.speed - pb.speed;
      for (let i = 0; i < 2 / DT; i++) a.step(DT, { thr: 0.3 });
      return { cap, emptyT: (emptyAt + 1) * DT, onAfter, dv, rate: (pa.nitro - n0) / 2 };
    });
    const full = 1 / (1 / r.cap - 0.02);
    expect(r.emptyT).toBeGreaterThan(full - 0.03);
    expect(r.emptyT).toBeLessThan(full + 0.03);
    expect(r.onAfter).toBe(0);
    expect(Math.abs(r.dv)).toBeLessThan(0.3);
    expect(r.rate).toBeGreaterThan(0.019);
    expect(r.rate).toBeLessThan(0.021);
  });
});
