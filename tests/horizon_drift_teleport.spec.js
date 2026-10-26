// Законы перемещения на фестиваль «Horizon Drift» тем же путём, что большая карта (openMap -> worldTravel):
// с живым циклом кадров, во всех режимах камеры, сразу после загрузки, на ходу издалека, после другого перемещения
// и после гонки - кадр не однотонный, камера - число и не в предмете, шейдеры не собираются, кадры не встают;
// камера после перемещения та же, что после полного круга камер (C x4).
const { test, expect } = require('@playwright/test');
const { openDrift, startQuick } = require('./_drift-helpers');

const MAPS = ['coast', 'mountains', 'desert', 'metro'];

// одно перемещение и проверка: живой цикл кадров, замер кадров и программ шейдеров
const travelAndCheck = (page, label) => page.evaluate(async (label) => {
  const W = __drift.worldRender, ren = __drift.renderer, w = __drift.world, frames = [];
  const of = W.frame; W.frame = function (...a) { const s = performance.now(); const x = of.apply(this, a); frames.push(performance.now() - s); return x; };
  // кадров до перемещения - мерка для этой машины (в проверках рисует программный растеризатор, он медленнее)
  await new Promise((res) => setTimeout(res, 1300));
  const before = frames.length; frames.length = 0;
  const prog0 = ren.info.programs.length;
  w.setAutopilot(0); __drift.openMap(); __drift.worldTravel('fest');
  await new Promise((res) => setTimeout(res, 1300));
  W.frame = of;
  const c = __drift.render.camera.position, cam = [c.x, c.y, c.z];
  const gl = ren.getContext(), bw = gl.drawingBufferWidth, bh = gl.drawingBufferHeight, buf = new Uint8Array(bw * bh * 4);
  W.frame(0, 1, __drift.camMode); gl.readPixels(0, 0, bw, bh, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  const cnt = new Map(); let n = 0;
  for (let y = 0; y < bh; y += 4) for (let x = 0; x < bw; x += 4) { const k = (y * bw + x) * 4, q = (buf[k] >> 5) * 64 + (buf[k + 1] >> 5) * 8 + (buf[k + 2] >> 5); cnt.set(q, (cnt.get(q) || 0) + 1); n++; }
  const mono = Math.max(...cnt.values()) / n;
  const solid = __drift.world.M.solidAt(c.x, c.y, c.z, 0.2);
  // полный круг камер возвращает тот же режим: камера должна встать туда же
  const mode = __drift.camMode;
  for (let k = 0; k < 4; k++) __drift.cycleCamera();
  await new Promise((res) => setTimeout(res, 600));
  const c2 = __drift.render.camera.position, after = [c2.x, c2.y, c2.z];
  const sorted = frames.slice(2).sort((a, b) => a - b);
  return { label, mode, finite: cam.every(Number.isFinite), mono: +mono.toFixed(2), solid: solid ? solid.kind : null, newPrograms: ren.info.programs.length - prog0,
    p95: +(sorted[Math.floor(sorted.length * 0.95)] || 0).toFixed(1), frames: frames.length, before, cycleShift: +Math.hypot(after[0] - cam[0], after[1] - cam[1], after[2] - cam[2]).toFixed(2), sameMode: __drift.camMode === mode };
}, label);

// кадров после перемещения - не меньше половины от обычного (рывок сборки шейдеров или зацикленная подгрузка дали бы провал)
const bad = (list) => list.filter((r) => !r.finite || r.mono > 0.9 || r.solid || r.newPrograms > 0 || r.frames < r.before * 0.5 || r.cycleShift > 1.5 || !r.sameMode)
  .map((r) => `${r.label} [${r.mode}] число=${r.finite} однотонность=${r.mono} предмет=${r.solid} новых программ=${r.newPrograms} кадров=${r.frames} из ${r.before} сдвиг после круга камер=${r.cycleShift}`);

test.describe('horizon_drift_offline: перемещение на фестиваль', () => {
  test.describe.configure({ timeout: 300_000 });

  for (const map of MAPS) {
    test(`${map}: перемещение на фестиваль через большую карту - во всех режимах камеры, после загрузки, на ходу издалека, после другого перемещения`, async ({ page }) => {
      await page.setViewportSize({ width: 640, height: 360 });
      await openDrift(page, { low: false });
      const out = [];
      for (const mode of ['chase', 'far', 'hood', 'cockpit']) {
        for (const when of ['после загрузки', 'на ходу издалека', 'после другого перемещения']) {
          await page.evaluate(async ([map, mode]) => { await __drift.startWorld(map); __drift.setCamera(mode); __drift.manual = false; }, [map, mode]);
          await page.waitForTimeout(300);
          if (when !== 'после загрузки') {
            await page.evaluate(() => { const w = __drift.world, M = w.M; let far = 0, fi = 0; for (let i = 0; i < M.N; i += 50) { const d = Math.hypot(M.X[i], M.Z[i]); if (d > far) { far = d; fi = i; } } w.placeAt(M.X[fi], M.Z[fi]); w.setAutopilot(32); });
            await page.waitForTimeout(1800);
          }
          if (when === 'после другого перемещения') await page.evaluate(() => { const w = __drift.world, pt = w.M.points.find((q) => q.type === 'event'); w.save.disc[pt.id] = true; __drift.openMap(); __drift.worldTravel(pt.id); });
          out.push(await travelAndCheck(page, when));
          await page.evaluate(() => { __drift.manual = true; __drift.quitWorld(); });
        }
      }
      expect(out.length).toBe(12);
      expect(bad(out)).toEqual([]);
    });
  }

  test('перемещение на фестиваль сразу после гонки и из меню паузы «Заново»', async ({ page }) => {
    await page.setViewportSize({ width: 640, height: 360 });
    await openDrift(page, { low: false });
    await startQuick(page, { track: 'coast', mode: 'race', opp: 3, laps: 1 });
    await page.evaluate(() => { __drift.step(600, { thr: 1 }); __drift.toMenu(); });
    const out = [];
    for (const map of ['coast', 'metro']) {
      await page.evaluate(async (map) => { await __drift.startWorld(map); __drift.setCamera('chase'); __drift.manual = false; __drift.world.setAutopilot(30); }, map);
      await page.waitForTimeout(1500);
      out.push(await travelAndCheck(page, map + ': после гонки'));
      // меню паузы: «Заново» в мире ведёт на фестиваль тем же перемещением
      await page.evaluate(() => { __drift.world.setAutopilot(30); });
      await page.waitForTimeout(1200);
      await page.evaluate(() => { __drift.pause(); document.getElementById('pRestart').click(); });
      await page.waitForTimeout(1300);
      const r = await page.evaluate(() => { const c = __drift.render.camera.position, f = __drift.world.M.fest, p = __drift.world.player; return { finite: [c.x, c.y, c.z].every(Number.isFinite), paused: __drift.paused, nearFest: Math.hypot(p.x - f.x, p.z - f.z) < 140 }; });
      expect(r, map).toEqual({ finite: true, paused: false, nearFest: true });
      await page.evaluate(() => { __drift.manual = true; __drift.quitWorld(); });
    }
    expect(bad(out)).toEqual([]);
  });
  test('кадр сразу после перемещения, ещё до шага физики: камера - число в каждом режиме (скорость перед перемещением была большой)', async ({ page }) => {
    await page.setViewportSize({ width: 480, height: 270 });
    await openDrift(page);
    const r = await page.evaluate(async () => {
      await __drift.startWorld('coast'); __drift.manual = true;
      const out = [], W = __drift.worldRender, w = __drift.world;
      for (const mode of ['chase', 'far', 'hood', 'cockpit']) {
        __drift.setCamera(mode); w.setAutopilot(34); __drift.stepWorld(900); w.setAutopilot(0);
        for (let k = 0; k < 3; k++) W.frame(1 / 60, 1, mode);
        const speedBefore = w.player.speed;
        __drift.openMap(); __drift.worldTravel('fest');
        W.frame(1 / 60, 1, mode);                                       // без шага физики между перемещением и кадром
        const c = __drift.render.camera.position;
        out.push({ mode, speedBefore: Math.round(speedBefore), finite: [c.x, c.y, c.z].every(Number.isFinite), speedAfter: w.player.speed });
      }
      return out;
    });
    for (const x of r) { expect(x.speedBefore, x.mode).toBeGreaterThan(10); expect(x.finite, x.mode).toBe(true); expect(x.speedAfter, x.mode).toBe(0); }
  });
  test('смена карт не оставляет текстур и геометрий: входы и выходов из мира - счётчики видеокарты возвращаются', async ({ page }) => {
    await page.setViewportSize({ width: 480, height: 270 });
    await openDrift(page, { low: false });              // высокое качество: с тенями (утечка шла через проход теней)
    const r = await page.evaluate(async () => {
      const mem = () => { const m = __drift.renderer.info.memory; return { tex: m.textures, geo: m.geometries }; };
      const W = __drift.worldRender;
      // круг как у игрока: мир, езда сзади и из салона, выход
      const cycle = async (map) => { await __drift.startWorld(map, { fest: true }); __drift.manual = true; for (const m of ['chase', 'cockpit']) { __drift.setCamera(m); for (let k = 0; k < 30; k++) { __drift.stepWorld(2); W.frame(1 / 60, 1, m); } } __drift.quitWorld(); __drift.render.frame(1 / 60, 1, 'chase'); };
      await cycle('coast'); await cycle('mountains');
      const base = mem(), seen = [];
      for (const map of ['coast', 'mountains', 'metro', 'desert', 'mountains', 'coast']) { await cycle(map); seen.push(mem()); }
      return { base, seen };
    });
    for (const m of r.seen) { expect(m.tex, 'текстуры').toBeLessThanOrEqual(r.base.tex); expect(m.geo, 'геометрии').toBeLessThanOrEqual(r.base.geo); }
  });
});
