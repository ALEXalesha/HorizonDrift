// Законы вида из салона и свободной камеры «Horizon Drift»: салон с приборами и рулём в цикле камер,
// взгляд мышью/стиком с пределами, возврат вперёд без движения, облёт за машиной не уводит камеру в предметы,
// «взгляд назад», настройки чувствительности и инверсии сохраняются.
const { test, expect } = require('@playwright/test');
const { openDrift, startQuick, installProbe } = require('./_drift-helpers');

const startWorld = (page, map) => page.evaluate(async (map) => { await __drift.startWorld(map, { fest: true }); __drift.manual = true; return __drift.world.M.id; }, map);

test.describe('horizon_drift_offline: вид из салона и свободный взгляд', () => {
  test.describe.configure({ timeout: 240_000 });

  test('вид из салона: в цикле камер, руль поворачивается за рулём машины, приборы показывают скорость и передачу, большой спидометр спрятан; выбор переживает перезапуск', async ({ page }) => {
    await page.setViewportSize({ width: 960, height: 540 });
    await openDrift(page);
    await startWorld(page, 'coast');
    const r = await page.evaluate(async () => {
      const W = __drift.worldRender, w = __drift.world, p = w.player;
      w.trafficOn = false; for (const a of w.traffic.slice()) w.removeAi(a); for (const a of w.rivals.slice()) w.removeAi(a);
      const modes = [];
      for (let k = 0; k < 4 && __drift.camMode !== 'cockpit'; k++) { __drift.cycleCamera(); modes.push(__drift.camMode); }
      const frames = (n, inp) => { for (let k = 0; k < n; k++) { __drift.stepWorld(2, inp); W.frame(1 / 60, 1, __drift.camMode); } };
      frames(150, { thr: 1 });
      const ck = __drift.cockpit, kmh = p.speed * 3.6, gear = p.gear, shown = Object.assign({}, ck.shown);
      frames(40, { thr: 0.3, steer: 1 }); const right = ck.wheelAngle;
      frames(60, { thr: 0.3, steer: -1 }); const left = ck.wheelAngle;
      const cm = W.carMeshes.get(p), cam = __drift.render.camera.position;
      const camLocal = cm.root.worldToLocal(cam.clone());
      await new Promise((res) => setTimeout(res, 300));
      const speedo = getComputedStyle(document.getElementById('hSpeedo')).display;
      return { modes, active: ck.active, kmh, gear, shown, right, left, carHidden: !cm.root.visible, camLocal: [camLocal.x, camLocal.y, camLocal.z], speedo, halfL: p.st.len / 2, halfW: p.st.wid / 2 };
    });
    expect(r.modes[r.modes.length - 1]).toBe('cockpit');
    expect(r.active).toBe(true);
    expect(Math.abs(r.shown.kmh - r.kmh)).toBeLessThan(4);                  // стрелка и цифры - скорость машины
    expect(r.shown.gear).toBe(r.gear);
    expect(r.right).toBeGreaterThan(1.0);                                     // руль вправо - обод вправо
    expect(r.left).toBeLessThan(-1.0);
    expect(r.carHidden).toBe(true);                                           // наружный кузов не режет камеру
    expect(Math.abs(r.camLocal[0])).toBeLessThan(r.halfW);                    // глаза - внутри кузова
    expect(Math.abs(r.camLocal[2])).toBeLessThan(r.halfL);
    expect(r.camLocal[1]).toBeGreaterThan(0.7);
    expect(r.camLocal[1]).toBeLessThan(1.5);
    expect(r.speedo).toBe('none');
    // выбор камеры переживает перезапуск мира, возврат на дорогу и гонку
    const r2 = await page.evaluate(async () => {
      __drift.world.resetPlayer(); const afterR = __drift.camMode;
      __drift.quitWorld(); await __drift.startWorld('coast'); __drift.manual = true; const afterWorld = __drift.camMode;
      __drift.quitWorld();
      return { afterR, afterWorld };
    });
    expect(r2).toEqual({ afterR: 'cockpit', afterWorld: 'cockpit' });
    await startQuick(page, { track: 'coast', mode: 'race', laps: 1, opp: 3 });
    const r3 = await page.evaluate(() => {
      __drift.step(240, { thr: 1 }); for (let k = 0; k < 6; k++) __drift.render.frame(1 / 60, 1, __drift.camMode);
      const pl = __drift.race.player; return { mode: __drift.camMode, active: __drift.cockpit.active, gear: __drift.cockpit.shown && __drift.cockpit.shown.gear, pgear: pl.gear };
    });
    expect(r3.mode).toBe('cockpit');
    expect(r3.active).toBe(true);
    expect(r3.gear).toBe(r3.pgear);
  });

  test('салон каждого класса без дыр: ниже линии панели не видно дороги; приборы видны; взгляд по умолчанию - вперёд поверх панели; руки не толще настоящих', async ({ page }) => {
    await page.setViewportSize({ width: 960, height: 540 });
    await openDrift(page);
    const ids = await page.evaluate(() => __drift.data.CARS.map((c) => c.id));
    const out = [];
    for (const id of ids) {
      const r = await page.evaluate(async (id) => {
        const c = __drift.career; if (!c.d.owned.includes(id)) c.d.owned.push(id); c.d.current = id; c.save(c.d);
        await __drift.startWorld('coast'); __drift.manual = true; __drift.setCamera('cockpit');
        const W = __drift.worldRender; for (let k = 0; k < 8; k++) { __drift.stepWorld(2, { thr: 0.5 }); W.frame(1 / 60, 1, 'cockpit'); }
        const cov = __drift.render.cockpit.coverage(__drift.renderer), arms = __drift.render.cockpit.armRadius || 1;
        const vis = __drift.render.cockpit.gaugeVisibility(__drift.renderer);
        // взгляд вниз на руль и под ноги - и там пол, ниша для ног и панель, а не дорога
        __drift.view.pitch = -0.9; __drift.setLook({ idle: 0 }); for (let k = 0; k < 3; k++) W.frame(1 / 60, 1, 'cockpit');
        const down = __drift.render.cockpit.coverage(__drift.renderer); __drift.view.pitch = 0;
        // вбок-вниз и назад: нижняя треть кадра по всей ширине - салон (двери, пол, сиденья, задняя стенка)
        const side = [];
        for (const [yaw, pitch] of [[-1.57, -0.6], [1.57, -0.6], [2.6, -0.25], [-2.6, -0.25]]) { __drift.view.yaw = yaw; __drift.view.pitch = pitch; for (let k = 0; k < 3; k++) W.frame(1 / 60, 1, 'cockpit'); side.push(+__drift.render.cockpit.coverage(__drift.renderer, 0.3).holes.toFixed(4)); }
        __drift.view.yaw = 0; __drift.view.pitch = 0;
        __drift.quitWorld();
        return { id, shape: __drift.data.CARS.find((x) => x.id === id).shape, lineY: +cov.lineY.toFixed(2), holes: +cov.holes.toFixed(4), rows: cov.rows, arms, downHoles: +down.holes.toFixed(4), downRows: down.rows, side, digits: +vis.digits.frac.toFixed(2), digitsPx: vis.digits.px, gear: +vis.gear.frac.toFixed(2), cluster: +vis.cluster.frac.toFixed(2) };
      }, id);
      out.push(r);
    }
    console.log(JSON.stringify(out));
    for (const r of out) {
      expect(r.holes, r.id + ' (' + r.shape + '): дыры ниже панели').toBeLessThan(0.002);
      expect(r.rows, r.id).toBeGreaterThan(20);
      expect(r.downHoles, r.id + ': взгляд вниз - дыры').toBeLessThan(0.002);
      expect(r.downRows, r.id).toBeGreaterThan(100);
      // приборы видны на экране: цифры скорости и передача не закрыты ни панелью, ни козырьком, ни рулём
      expect(r.digitsPx, r.id).toBeGreaterThan(40);
      expect(r.digits, r.id + ': видимая доля цифр скорости').toBeGreaterThan(0.85);
      expect(r.gear, r.id + ': видимая доля передачи').toBeGreaterThan(0.85);
      expect(r.cluster, r.id + ': видимая доля щитка').toBeGreaterThan(0.6);
      expect(Math.max(...r.side), r.id + ': вбок и назад - дыры ' + r.side.join(',')).toBeLessThan(0.002);
      expect(r.lineY, r.id + ': панель не задирается к середине кадра').toBeGreaterThan(0.55);
      expect(r.lineY, r.id + ': панель видна').toBeLessThan(0.85);
      expect(r.arms, r.id + ': предплечья не толще 5 см').toBeLessThan(0.05);
    }
  });

  test('свободный взгляд в салоне: поворот головы ограничен ±150° и ±60°, без мыши взгляд сам возвращается вперёд; «взгляд назад» - на клавише', async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 450 });
    await openDrift(page);
    await startWorld(page, 'coast');
    const r = await page.evaluate(() => { __drift.setCamera('cockpit'); __drift.lookBy(-8000, -8000); return { yaw: __drift.view.yaw, pitch: __drift.view.pitch }; });
    expect(r.yaw).toBeCloseTo(2.618, 2);
    expect(r.pitch).toBeCloseTo(1.047, 2);
    await page.waitForTimeout(2600);                                          // 1.5 с без мыши + плавный возврат
    const back = await page.evaluate(() => ({ yaw: __drift.view.yaw, pitch: __drift.view.pitch }));
    expect(Math.abs(back.yaw)).toBeLessThan(0.08);
    expect(Math.abs(back.pitch)).toBeLessThan(0.08);
    // клавиша «взгляд назад»: голова поворачивается назад, пока клавиша нажата
    await page.keyboard.down('KeyV');
    const lb = await page.evaluate(async () => { await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res))); __drift.worldRender.frame(1 / 60, 1, 'cockpit'); return { back: __drift.view.back, yaw: __drift.cockpit.yaw }; });
    await page.keyboard.up('KeyV');
    expect(lb.back).toBe(true);
    expect(lb.yaw).toBeCloseTo(2.618, 2);
    const after = await page.evaluate(async () => { await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res))); return __drift.view.back; });
    expect(after).toBe(false);
  });

  test('облёт за машиной: по кругу 360° и сверху-снизу камера у стены дома не входит в предметы и землю, кадр не однотонный; без мыши на ходу возвращается за машину', async ({ page }) => {
    await page.setViewportSize({ width: 640, height: 360 });
    await openDrift(page);
    await startWorld(page, 'metro');
    await installProbe(page);
    const r = await page.evaluate(() => {
      const w = __drift.world, M = w.M, W = __drift.worldRender, P = __probe, p = w.player, cam = __drift.render.camera.position, out = [];
      w.trafficOn = false; for (const a of w.traffic.slice()) w.removeAi(a); for (const a of w.rivals.slice()) w.removeAi(a);
      w.save.autoTime = false; w.save.tod = 12;
      __drift.setCamera('chase');
      let house = null; for (let cx = -10; cx < 10 && !house; cx++) for (let cz = -10; cz < 10 && !house; cz++) for (const d of M.chunkDecor(cx, cz)) if (d.box && d.h > 8) { house = d; break; }
      const ux = Math.cos(house.rot), uz = -Math.sin(house.rot), vx = Math.sin(house.rot), vz = Math.cos(house.rot);
      p.x = house.x + ux * (house.w / 2 + 1.5); p.z = house.z + uz * (house.w / 2 + 1.5); p.h = Math.atan2(vx, vz); p.y = M.groundAt(p.x, p.z).y; p.vx = p.vz = p.w = 0; p.solidCache = null;
      __drift.stepWorld(10); P.settle();
      let maxYaw = 0;
      for (let a = -Math.PI; a <= Math.PI + 1e-6; a += Math.PI / 6) for (const pt of [-0.5, 0, 0.6]) {
        __drift.view.yaw = a; __drift.view.pitch = pt; maxYaw = Math.max(maxYaw, Math.abs(a));
        __drift.setLook({ idle: 0 });
        for (let k = 0; k < 40; k++) W.frame(1 / 60, 1, 'chase');
        const inSolid = M.solidAt(cam.x, cam.y, cam.z, 0.25), gy = M.groundAt(cam.x, cam.z, {}, p.y).y;
        const objs = P.targets();
        const dist = Math.hypot(cam.x - p.x, cam.y - p.y - 1, cam.z - p.z);
        P.double(() => { const inside = P.camInside(objs); W.frame(0, 1, 'chase'); out.push({ a: +a.toFixed(2), pt, inSolid: inSolid ? inSolid.kind : null, under: cam.y < gy + 0.3, inside, mono: +P.mono().toFixed(2), dist: +dist.toFixed(2) }); });
      }
      return { out, maxYaw };
    });
    expect(r.maxYaw).toBeGreaterThan(3.1);
    expect(r.out.filter((o) => o.inSolid || o.under || o.inside || o.mono > 0.9)).toEqual([]);
    // у стены камера не прижимается к крыше: поднимается выше и видит машину целиком
    expect(r.out.filter((o) => o.dist < 2.8)).toEqual([]);
    // без мыши: на ходу через несколько секунд камера сама возвращается за машину
    await page.evaluate(() => { __drift.view.yaw = 2.0; __drift.view.pitch = 0.4; __drift.setLook({ idle: 0 }); const p = __drift.world.player; p.vx = Math.sin(p.h) * 12; p.vz = Math.cos(p.h) * 12; p.speed = 12; __drift.manual = false; });
    await page.waitForTimeout(5500);
    const v = await page.evaluate(() => { __drift.manual = true; return { yaw: __drift.view.yaw, pitch: __drift.view.pitch }; });
    expect(Math.abs(v.yaw)).toBeLessThan(0.1);
    expect(Math.abs(v.pitch)).toBeLessThan(0.1);
  });

  test('взгляд мышью при захвате указателя: поддельный захват (настоящий в проверках запрещён), движения movementX/Y поворачивают голову; правая кнопка - тоже', async ({ page }) => {
    await openDrift(page);
    await startWorld(page, 'coast');
    const r = await page.evaluate(() => {
      __drift.setCamera('cockpit'); const gl = document.getElementById('gl');
      const nativeBlocked = (() => { try { window.__nativePointerLock(); return false; } catch (e) { return true; } })();
      gl.requestPointerLock();
      const locked = document.pointerLockElement === gl, calls = window.__fakeLock;
      window.dispatchEvent(new PointerEvent('pointermove', { movementX: 120, movementY: -40 }));
      const lockYaw = __drift.view.yaw, lockPitch = __drift.view.pitch;
      document.exitPointerLock(); const unlocked = document.pointerLockElement === null;
      __drift.setCamera('cockpit');
      gl.dispatchEvent(new PointerEvent('pointerdown', { button: 2, clientX: 300, clientY: 200, bubbles: true }));
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: 200, clientY: 200 }));
      window.dispatchEvent(new PointerEvent('pointerup', { button: 2 }));
      const dragYaw = __drift.view.yaw;
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: 100, clientY: 200 }));
      return { nativeBlocked, locked, calls, lockYaw, lockPitch, unlocked, dragYaw, afterRelease: __drift.view.yaw };
    });
    expect(r.nativeBlocked).toBe(true);
    expect(r.locked).toBe(true);
    expect(r.calls).toBe(1);
    expect(r.lockYaw).toBeLessThan(-0.2);                 // мышь вправо - голова вправо
    expect(r.lockPitch).toBeGreaterThan(0.05);
    expect(r.unlocked).toBe(true);
    expect(r.dragYaw).toBeGreaterThan(0.2);               // с правой кнопкой влево - влево
    expect(r.afterRelease).toBeCloseTo(r.dragYaw, 6);     // кнопка отпущена - мышь больше не крутит
  });

  test('облёт под кронами деревьев: камера не входит в крону ни при каком повороте (сосны и лиственные, большие и обычные)', async ({ page }) => {
    test.setTimeout(600_000);
    await page.setViewportSize({ width: 480, height: 270 });
    await openDrift(page);
    const res = [];
    for (const map of ['coast', 'mountains']) {
      await startWorld(page, map);
      const r = await page.evaluate(() => {
        const w = __drift.world, M = w.M, W = __drift.worldRender, p = w.player, cam = __drift.render.camera.position, out = [];
        w.trafficOn = false; for (const a of w.traffic.slice()) w.removeAi(a); for (const a of w.rivals.slice()) w.removeAi(a);
        __drift.setCamera('chase');
        // места: у ствола большого дерева каждого вида и точка из ревью на побережье
        const spots = [];
        if (M.id === 'coast') spots.push({ x: -3447, z: -3219, kind: 'ревью' });
        const want = { tree: 2, pine: 2 };
        for (let cx = -20; cx < 20 && (want.tree + want.pine) > 0; cx++) for (let cz = -20; cz < 20; cz++) for (const d of M.chunkDecor(cx, cz)) {
          if (!want[d.type] || d.s < 1.15) continue;
          spots.push({ x: d.x + 2.3 * d.s, z: d.z, kind: d.type + ' x' + d.s.toFixed(2) }); want[d.type]--; if ((want.tree + want.pine) <= 0) break;
        }
        for (const sp of spots) {
          p.x = sp.x; p.z = sp.z; p.h = 0; p.y = M.groundAt(p.x, p.z).y; p.vx = p.vz = p.w = 0; p.air = false; p.solidCache = null;
          __drift.stepWorld(20); for (let k = 0; k < 40; k++) W.stream(true);
          for (let a = 0; a < 6.28; a += Math.PI / 6) for (const pt of [-0.3, 0, 0.5]) {
            __drift.view.yaw = a; __drift.view.pitch = pt; __drift.setLook({ idle: 0 }); W.cam.init = false;
            for (let k = 0; k < 22; k++) W.frame(1 / 60, 1, 'chase');
            const hit = M.solidAt(cam.x, cam.y, cam.z, 0.2);
            if (hit) out.push(sp.kind + ' поворот ' + a.toFixed(2) + ' наклон ' + pt + ' -> в ' + hit.kind);
          }
        }
        return { spots: spots.length, bad: out };
      });
      res.push({ map, ...r });
    }
    for (const r of res) { expect(r.spots, r.map).toBeGreaterThan(2); expect(r.bad.slice(0, 8), r.map).toEqual([]); }
  });

  test('настройки взгляда: чувствительность и инверсия сохраняются, инверсия меняет направление по вертикали', async ({ page }) => {
    await openDrift(page);
    await page.evaluate(() => { __drift.setSetting('lookSens', 2); __drift.setSetting('invertY', true); });
    await page.reload();
    await page.waitForFunction(() => window.__drift && window.__drift.ready === true);
    const r = await page.evaluate(async () => {
      const s = { sens: __drift.settings.lookSens, inv: __drift.settings.invertY };
      await __drift.startWorld('coast'); __drift.manual = true; __drift.setCamera('cockpit');
      __drift.lookBy(0, 20); const inv = __drift.view.pitch;
      __drift.setSetting('invertY', false); __drift.setCamera('cockpit'); __drift.lookBy(0, 20); const norm = __drift.view.pitch;
      __drift.setSetting('lookSens', 1); __drift.setCamera('cockpit'); __drift.lookBy(0, 20); const one = __drift.view.pitch;
      return { s, inv, norm, one };
    });
    expect(r.s).toEqual({ sens: 2, inv: true });
    expect(Math.sign(r.inv)).toBe(-Math.sign(r.norm));
    expect(Math.abs(r.norm)).toBeCloseTo(Math.abs(r.one) * 2, 5);
  });
});
