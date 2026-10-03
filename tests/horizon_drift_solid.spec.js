// Законы твёрдости мира «Horizon Drift»: один список твёрдых предметов на всё (физика, камера, появление, рисунок),
// кузов - прямоугольник по размерам машины, быстрая машина не проскакивает тонкое, камера не входит в предметы,
// нарисованная земля совпадает с физической, машина появляется только на свободном месте.
const { test, expect } = require('@playwright/test');
const { openDrift, installProbe } = require('./_drift-helpers');

const MAPS = ['coast', 'mountains', 'desert', 'metro'];
const startWorld = (page, map, o) => page.evaluate(async ([map, o]) => { await __drift.startWorld(map, o || { fest: true }); __drift.manual = true; return __drift.world.M.id; }, [map, o]);
const bad = (list) => list.filter((r) => r.body.length || r.inside || r.mono > 0.9).map((r) => r.label + ' @' + r.x + ',' + r.z + (r.body.length ? ' кузов: ' + [...new Set(r.body.map((b) => b.obj))].join('/') + ' dy=' + (r.body[0].y) : '') + (r.inside ? ' камера внутри: ' + r.inside[0] : '') + (r.mono > 0.9 ? ' кадр однотонный ' + r.mono : ''));

test.describe('horizon_drift_offline: твёрдый мир', () => {
  test.describe.configure({ timeout: 300_000 });

  test('кузов из данных: размеры рисунка и столкновений совпадают; угол кузова не входит в дом и в другую машину', async ({ page }) => {
    await openDrift(page);
    await startWorld(page, 'metro');
    const r = await page.evaluate(() => {
      const D = __drift.data, R = __drift.render, C = __drift.core, w = __drift.world, M = w.M;
      const dims = D.CARS.map((c) => { const S = R.SHAPES[c.shape], B = D.BODY && D.BODY[c.shape], st = C.carStats(c.id); return { id: c.id, ok: !!B && Math.abs(S.L - B.L) < 1e-9 && Math.abs(S.W - B.W) < 1e-9 && st.len === S.L && st.wid === S.W }; });
      // дом в городе: машина едет по диагонали в его угол
      w.trafficOn = false; for (const a of w.traffic.slice()) w.removeAi(a); for (const a of w.rivals.slice()) w.removeAi(a);
      let house = null;
      for (let cx = -8; cx < 8 && !house; cx++) for (let cz = -8; cz < 8 && !house; cz++) for (const d of M.chunkDecor(cx, cz)) if (d.type === 'building' && d.h > 8) { house = d; break; }
      const p = w.player, corners = (c) => C.carCorners ? C.carCorners(c) : [];
      const inside = (x, z, d) => { const dx = x - d.x, dz = z - d.z, cs = Math.cos(d.rot), sn = Math.sin(d.rot), lx = dx * cs - dz * sn, lz = dx * sn + dz * cs; return Math.min(d.w / 2 - Math.abs(lx), d.d / 2 - Math.abs(lz)); };
      const cornersOf = (c) => { const hl = (c.st.len || 4.3) / 2, hw = (c.st.wid || 1.8) / 2, fx = Math.sin(c.h), fz = Math.cos(c.h), rx = -fz, rz = fx, out = []; for (const [a, b] of [[1, 1], [1, -1], [-1, -1], [-1, 1]]) out.push([c.x + fx * hl * a + rx * hw * b, c.z + fz * hl * a + rz * hw * b]); return out; };
      let worstHouse = 0;
      const ux = Math.cos(house.rot), uz = -Math.sin(house.rot), vx = Math.sin(house.rot), vz = Math.cos(house.rot);
      const cornerX = house.x + ux * house.w / 2 + vx * house.d / 2, cornerZ = house.z + uz * house.w / 2 + vz * house.d / 2;
      for (const ang of [0.35, 0.8, 1.2]) {
        const dirx = Math.cos(ang) * ux + Math.sin(ang) * vx, dirz = Math.cos(ang) * uz + Math.sin(ang) * vz;
        p.x = cornerX + dirx * 14 + (ux * 0.9 + vx * 0.2); p.z = cornerZ + dirz * 14 + (uz * 0.9 + vz * 0.2); p.h = Math.atan2(-dirx, -dirz);
        p.y = M.groundAt(p.x, p.z).y; p.vx = -dirx * 22; p.vz = -dirz * 22; p.w = 0; p.air = false;
        for (let k = 0; k < 150; k++) { __drift.stepWorld(1, { thr: 1 }); for (const [x, z] of cornersOf(p)) worstHouse = Math.max(worstHouse, inside(x, z, house)); }
      }
      // две машины: лоб в бок на скорости - углы одной не входят в прямоугольник другой
      const b = C.makeCar(C.carStats('taifun'), { name: 'Б' }); b.carId = 'taifun'; w.cars.push(b);
      let worstCar = 0;
      const boxOf = (c) => ({ x: c.x, z: c.z, w: c.st.wid, d: c.st.len, rot: c.h });
      for (const off of [-1.8, -0.9, 0, 0.9, 1.8]) {
        const q = M.nearestRoad(M.fest.drive.ax, M.fest.drive.az);
        const i = q.i, h = Math.atan2(M.TX[i], M.TZ[i]);
        b.x = M.X[i]; b.z = M.Z[i]; b.h = h + Math.PI / 2; b.vx = b.vz = b.w = 0; b.y = M.Y[i]; b.air = false;
        p.x = b.x - Math.sin(h) * 12 + Math.cos(h) * off; p.z = b.z - Math.cos(h) * 12 - Math.sin(h) * off; p.h = h; p.y = b.y; p.vx = Math.sin(h) * 20; p.vz = Math.cos(h) * 20; p.w = 0; p.air = false;
        for (let k = 0; k < 90; k++) { __drift.stepWorld(1, { thr: 1 }); for (const [x, z] of cornersOf(p)) worstCar = Math.max(worstCar, inside(x, z, boxOf(b))); for (const [x, z] of cornersOf(b)) worstCar = Math.max(worstCar, inside(x, z, boxOf(p))); }
      }
      // машину у стены дома таранит другая на 180 и 290 км/ч сбоку - прижатая не входит в стену
      let worstPinned = 0;
      for (const v of [50, 80]) {
        p.x = house.x + ux * (house.w / 2 + p.st.wid / 2 + 0.3); p.z = house.z + uz * (house.w / 2 + p.st.wid / 2 + 0.3); p.h = Math.atan2(vx, vz); p.y = M.groundAt(p.x, p.z).y; p.vx = p.vz = p.w = 0; p.air = false; p.solidCache = null;
        b.x = p.x + ux * 9; b.z = p.z + uz * 9; b.h = Math.atan2(-ux, -uz); b.y = p.y; b.vx = -ux * v; b.vz = -uz * v; b.w = 0; b.air = false; b.solidCache = null;
        for (let k = 0; k < 60; k++) { b.inp.thr = 1; __drift.stepWorld(1, {}); for (const [x, z] of cornersOf(p)) worstPinned = Math.max(worstPinned, inside(x, z, house)); }
      }
      w.cars.splice(w.cars.indexOf(b), 1);
      return { dims, worstHouse, worstCar, worstPinned, house: !!house };
    });
    expect(r.dims.filter((d) => !d.ok)).toEqual([]);
    expect(r.house).toBe(true);
    expect(r.worstHouse).toBeLessThan(0.06);                  // угол кузова не уходит в стену дома
    expect(r.worstCar).toBeLessThan(0.08);                    // и в другую машину
    expect(r.worstPinned).toBeLessThan(0.06);                 // прижатая другой машиной - не входит в стену
  });

  for (const map of MAPS) {
    test(`${map}: машина появляется только на свободном месте - фестиваль, все точки, R, узлы, мосты, тоннели, занятое место, сохранённое место`, async ({ page }) => {
      test.setTimeout(600_000);
      await openDrift(page);
      await startWorld(page, map);
      await installProbe(page);
      const res = await page.evaluate(() => {
        const w = __drift.world, M = w.M, P = __probe, out = [];
        const rec = (label) => out.push(P.check(label));
        rec('старт на фестивале');
        for (const pt of M.points) { w.placeAtPoint(pt.id); rec('точка ' + pt.id); }
        const rng = __drift.core.mulberry32(7);
        for (let k = 0; k < 24; k++) { const i = Math.floor(rng() * M.N); w.placeAt(M.X[i] + (rng() - 0.5) * 40, M.Z[i] + (rng() - 0.5) * 40); w.resetPlayer(); rec('R у дороги'); }
        for (const nk in M.nodes) { w.placeAt(M.nodes[nk].x + 2, M.nodes[nk].z + 2); w.resetPlayer(); rec('R на узле ' + nk); }
        // бездорожье: машину привезли на склон или к деревьям - физика её отодвигает, кузов лежит по земле
        for (let k = 0; k < 16; k++) { const i = Math.floor(rng() * M.N), a = rng() * 6.283, d = 14 + rng() * 50, pl = w.player; pl.x = M.X[i] + Math.cos(a) * d; pl.z = M.Z[i] + Math.sin(a) * d; pl.h = rng() * 6.283; pl.vx = pl.vz = pl.w = 0; pl.y = M.groundAt(pl.x, pl.z).y; pl.air = false; pl.solidCache = null; __drift.stepWorld(40); rec('бездорожье'); }
        let mouths = 0; for (let i = 1; i < M.N - 1 && mouths < 6; i++) if ((M.FL[i] & 2) && !(M.FL[i - 1] & 2) && M.E[i] === M.E[i - 1]) { for (const k of [0, 1, 2, 3, 4]) { const j = i + k; w.placeAt(M.X[j], M.Z[j], Math.atan2(M.TX[j], M.TZ[j])); w.resetPlayer(); rec('R у входа в тоннель'); } mouths++; }
        let nb = 0, nt = 0; for (let i = 0; i < M.N; i += 9) { if ((M.FL[i] & 1) && nb < 4) { w.placeAt(M.X[i], M.Z[i]); w.resetPlayer(); rec('R на мосту'); nb++; i += 500; } else if ((M.FL[i] & 2) && nt < 4) { w.placeAt(M.X[i], M.Z[i]); w.resetPlayer(); rec('R в тоннеле'); nt++; i += 500; } }
        // занятое место: на точке фестиваля стоит машина трафика - игрок встаёт рядом, а не в неё
        const pt = M.pointById('fest'), i = pt.i, a = w.traffic[0] || w.rivals[0];
        if (a) { a.car.x = M.X[i]; a.car.z = M.Z[i]; a.car.h = Math.atan2(M.TX[i], M.TZ[i]); a.car.y = M.Y[i]; a.car.vx = a.car.vz = 0; a.cruise = 0; }
        w.placeAtPoint('fest');
        const occupied = a ? __drift.core.carCarContact ? !!__drift.core.carCarContact(w.player, a.car, {}) : Math.hypot(w.player.x - a.car.x, w.player.z - a.car.z) < 4.5 : false;
        rec('занятое место');
        return { out, occupied };
      });
      expect(res.occupied).toBe(false);
      expect(bad(res.out)).toEqual([]);
      // сохранённое место внутри дома или шатра: при загрузке мира машина встаёт на свободную дорогу
      const r2 = await page.evaluate(async (map) => {
        const M = __drift.world.M, sv = __drift.world.save;
        let house = null; for (let cx = -8; cx < 8 && !house; cx++) for (let cz = -8; cz < 8 && !house; cz++) for (const d of M.chunkDecor(cx, cz)) if (d.box) { house = d; break; }
        const f = M.fest, spot = house || { x: f.x, z: f.z };
        sv.pos = { x: spot.x, z: spot.z, h: 0 }; __drift.saveWorld(); __drift.quitWorld();
        await __drift.startWorld(map); __drift.manual = true;
        return __probe.check('загрузка с сохранённого места в доме');
      }, map);
      expect(bad([r2])).toEqual([]);
    });
  }

  for (const map of MAPS) {
    test(`${map}: камера ни в одном режиме не входит в предметы и землю - город, резкий разворот у стены, тоннель, мост, фестиваль`, async ({ page }) => {
      await page.setViewportSize({ width: 640, height: 360 });
      await openDrift(page);
      await startWorld(page, map);
      await installProbe(page);
      const res = await page.evaluate(() => {
        const w = __drift.world, M = w.M, P = __probe, W = __drift.worldRender, out = [];
        w.save.autoTime = false; w.save.tod = 12; w.save.weather = 'clear';
        const modes = ['chase', 'far', 'hood', 'cockpit'];
        const look = (label) => {
          P.settle();
          for (const mode of modes) {
            __drift.setCamera(mode); for (let k = 0; k < 3; k++) W.frame(1 / 60, 1, mode);
            const objs = P.targets();
            const c = __drift.render.camera.position, solidHit = M.solidAt(c.x, c.y, c.z, 0.2), under = c.y < M.groundAt(c.x, c.z, {}, w.player.y).y + 0.25;
            P.double(() => { const inside = P.camInside(objs) || (solidHit ? ['в предмете ' + solidHit.kind] : null) || (under ? ['под землёй'] : null); W.frame(0, 1, mode); const mono = P.mono(); out.push({ label: label + ' [' + mode + ']', x: Math.round(w.player.x), z: Math.round(w.player.z), body: [], inside, mono: +mono.toFixed(2) }); });
          }
        };
        // у стены дома: машина вплотную вдоль фасада, резкий разворот с ручником - камера метётся к стене
        let house = null; for (let cx = -10; cx < 10 && !house; cx++) for (let cz = -10; cz < 10 && !house; cz++) for (const d of M.chunkDecor(cx, cz)) if (d.box && d.h > 6) { house = d; break; }
        if (house) {
          const p = w.player, ux = Math.cos(house.rot), uz = -Math.sin(house.rot), vx = Math.sin(house.rot), vz = Math.cos(house.rot);
          for (const sd of [1, -1]) {
            p.x = house.x + ux * sd * (house.w / 2 + 1.6); p.z = house.z + uz * sd * (house.w / 2 + 1.6); p.h = Math.atan2(vx, vz); p.y = M.groundAt(p.x, p.z).y; p.vx = vx * 14; p.vz = vz * 14; p.w = 0; p.air = false; p.solidCache = null;
            W.cam.init = false;
            for (let k = 0; k < 10; k++) { __drift.stepWorld(12, { thr: 0.6, steer: sd * (k % 2 ? 1 : -1), hb: k > 2 ? 1 : 0 }); W.frame(0.1, 1, 'chase'); look('разворот у дома ' + k); }
          }
          // задом к стене: машина стоит кормой в метре от фасада - камера сзади оказалась бы в доме
          for (const sd of [1, -1]) {
            const hl = p.st.len / 2; p.x = house.x + ux * sd * (house.w / 2 + hl + 1.0); p.z = house.z + uz * sd * (house.w / 2 + hl + 1.0); p.h = Math.atan2(ux * sd, uz * sd); p.y = M.groundAt(p.x, p.z).y; p.vx = p.vz = p.w = 0; p.air = false; p.solidCache = null;
            __drift.stepWorld(4); W.cam.init = false; look('задом к стене ' + sd);
          }
        }
        // езда по дорогам: город, мосты, тоннели - автопилот, камера каждые полсекунды
        const starts = [];
        for (let i = 0; i < M.N; i += 13) { if ((M.FL[i] & 1) && starts.filter((s) => s[0] === 'мост').length < 1) starts.push(['мост', i]); if ((M.FL[i] & 2) && starts.filter((s) => s[0] === 'тоннель').length < 1) starts.push(['тоннель', i - 60]); }
        starts.push(['фестиваль', M.pointById('fest').i]);
        for (const [lab, i0] of starts) {
          const i = Math.max(0, i0); w.placeAt(M.X[i], M.Z[i]); w.setAutopilot(24); W.cam.init = false;
          for (let k = 0; k < 8; k++) { __drift.stepWorld(60); for (let f = 0; f < 4; f++) W.frame(1 / 60, 1, 'chase'); look(lab + ' ' + k); }
          w.setAutopilot(0);
        }
        // площадка фестиваля: заехать между шатрами и к сцене
        const fp = M.pointById('fest'), f = M.fest || { x: fp.x, z: fp.z, rot: Math.atan2(M.X[fp.i] - fp.x, M.Z[fp.i] - fp.z) }, p = w.player;
        for (const [ox, oz] of [[0, 0], [0, -26], [22, -20], [-26, 10]]) { const cs = Math.cos(f.rot), sn = Math.sin(f.rot); p.x = f.x + ox * cs + oz * sn; p.z = f.z - ox * sn + oz * cs; p.h = f.rot + Math.PI; p.y = M.groundAt(p.x, p.z).y; p.vx = p.vz = 0; p.solidCache = null; __drift.stepWorld(20); look('площадка ' + ox + ',' + oz); }
        return out;
      });
      expect(bad(res)).toEqual([]);
    });
  }

  test('призраков нет: всё нарисованное на высоте машины на всех 4 картах имеет твёрдую коробку в списке мира или помечено как не твёрдое', async ({ page }) => {
    test.setTimeout(900_000);
    await page.setViewportSize({ width: 320, height: 200 });
    await openDrift(page);
    const res = await page.evaluate(async () => {
      const out = [], THREE = window.THREE, v = new THREE.Vector3(), m4 = new THREE.Matrix4(), mw = new THREE.Matrix4();
      const NOT_SOLID = new Set(['ground', 'overhead', 'light', 'flat', 'breakable', 'water', 'sky', 'wall']);
      for (const map of ['coast', 'mountains', 'desert', 'metro']) {
        await __drift.startWorld(map); __drift.manual = true;
        const W = __drift.worldRender, M = __drift.world.M, g = {};
        if (typeof M.solidAt !== 'function') { out.push(map + ': нет списка твёрдых предметов'); continue; }
        const probs = new Map(); let checked = 0;
        const report = (what, x, z) => { const e = probs.get(what) || { n: 0, at: [] }; e.n++; if (e.at.length < 2) e.at.push(Math.round(x) + ',' + Math.round(z)); probs.set(what, e); };
        const audit = (mesh, name) => {
          if (mesh.userData.car) return;
          const why = mesh.userData.ghost;
          if (why && !NOT_SOLID.has(why)) { report('неизвестная пометка ' + why + ' ' + name, 0, 0); return; }
          if (why && why !== 'wall') return;
          // не вершины, а сами треугольники на высоте кузова: каждый треугольник режется плоскостями на 0.5 и 1.2 м над землёй,
          // точки разреза обязаны лежать в коробке из списка (иначе высокая коробка без коробки в списке была бы не видна)
          const pos = mesh.geometry.attributes.position; if (!pos) return;
          const idx = mesh.geometry.index, tris = idx ? idx.count / 3 : pos.count / 3, stepT = why === 'wall' ? 1 : Math.max(1, Math.floor(tris / 80));     // стенки дорог - каждый треугольник
          const n = mesh.isInstancedMesh ? mesh.count : 1;
          const P = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()], cut = new THREE.Vector3();
          const checkPoint = (pt) => {
            const gy = M.groundAt(pt.x, pt.z, g, pt.y).y;
            if (pt.y < gy + 0.25 || pt.y > gy + 1.45) return true;
            checked++;
            if (why === 'wall') {                                             // ограждение моста, стена тоннеля: стенка дороги в физике
              const q = M.nearestRoad(pt.x, pt.z, {}, pt.y - 0.5);
              let wallRoad = false; if (q) for (let j = q.i - 3; j <= q.i + 4; j++) if (M.FL[j] & 3) wallRoad = true;
              if (q && wallRoad && Math.abs(q.lat) > q.hw - 0.1) return true;
              report('стенка не у края моста или тоннеля ' + name, pt.x, pt.z); return false;
            }
            if (!M.solidAt(pt.x, pt.y, pt.z, 0.3)) { report((mesh.userData.solid ? 'нет коробки у ' : 'не помечено ') + name, pt.x, pt.z); return false; }
            return true;
          };
          for (let k = 0; k < n; k++) {
            if (mesh.isInstancedMesh) { mesh.getMatrixAt(k, m4); mw.multiplyMatrices(mesh.matrixWorld, m4); } else mw.copy(mesh.matrixWorld);
            let ok = true;
            for (let t = 0; t < tris && ok; t += stepT) {
              for (let e = 0; e < 3; e++) P[e].fromBufferAttribute(pos, idx ? idx.getX(t * 3 + e) : t * 3 + e).applyMatrix4(mw);
              for (let e = 0; e < 3 && ok; e++) if (!checkPoint(P[e])) ok = false;               // и сами вершины (у земли на концах мостов)
              const cxz = (P[0].x + P[1].x + P[2].x) / 3, czz = (P[0].z + P[1].z + P[2].z) / 3, gy0 = M.groundAt(cxz, czz, g, (P[0].y + P[1].y + P[2].y) / 3).y;
              for (const lev of [0.5, 1.2]) {
                const h = gy0 + lev, pts = [];
                for (let e = 0; e < 3 && ok; e++) { const A = P[e], B = P[(e + 1) % 3]; if ((A.y - h) * (B.y - h) < 0) { const f = (h - A.y) / (B.y - A.y); pts.push(cut.clone().copy(A).lerp(B, f)); } }
                if (pts.length === 2) pts.push(pts[0].clone().lerp(pts[1], 0.5));
                for (const pt of pts) if (ok && !checkPoint(pt)) ok = false;
              }
            }
          }
        };
        const nameOf = (mesh) => { for (const k in W.geo) if (W.geo[k] === mesh.geometry) return k; return (mesh.userData.solid || mesh.userData.ghost || mesh.geometry.type) + (mesh.material && mesh.material.color ? '#' + mesh.material.color.getHexString() : ''); };
        // точки мира и фестиваль
        W.markers.group.updateMatrixWorld(true);
        W.markers.group.traverse((o) => { if (o.isMesh || o.isInstancedMesh) audit(o, 'точка:' + nameOf(o)); });
        // все куски карты - в ближней детальности, по одному
        const half = M.half, CH = __drift.worldData.CHUNK, c0 = Math.floor(-half / CH), c1 = Math.floor(half / CH);
        let chunks = 0;
        for (let cx = c0; cx <= c1; cx++) for (let cz = c0; cz <= c1; cz++) {
          const ch = W._build(cx, cz, 0); chunks++;
          ch.group.traverse((o) => { if (o.isMesh || o.isInstancedMesh) audit(o, nameOf(o)); });
          W._dispose(ch);
          if (chunks % 60 === 0) await new Promise((r) => setTimeout(r, 0));
        }
        for (const [what, e] of probs) out.push(map + ': ' + what + ' x' + e.n + ' @' + e.at.join(' ; '));
        out.push('#' + map + ' кусков ' + chunks + ', точек проверено ' + checked);
        __drift.quitWorld();
      }
      return out;
    });
    const info = res.filter((s) => s.startsWith('#')), errs = res.filter((s) => !s.startsWith('#'));
    console.log(info.join('\n'));
    expect(errs).toEqual([]);
    expect(info.length).toBe(4);
  });

  test('на полной скорости с нитро машина не проскакивает фонарный столб, опору экрана и ограждение моста', async ({ page }) => {
    await openDrift(page);
    await page.evaluate(() => { const c = __drift.career; c.d.owned.push('mirage'); c.d.current = 'mirage'; c.save(c.d); });
    const res = [];
    for (const map of ['coast', 'metro', 'mountains']) {
      await startWorld(page, map);
      const r = await page.evaluate(() => {
        const w = __drift.world, M = w.M, p = w.player, out = [];
        w.trafficOn = false; for (const a of w.traffic.slice()) w.removeAi(a); for (const a of w.rivals.slice()) w.removeAi(a);
        const ram = (label, tx, tz, dirx, dirz) => {
          // разгон издалека прямо в предмет; после удара центр машины не должен оказаться за предметом
          const run = 140; p.x = tx - dirx * run; p.z = tz - dirz * run; p.h = Math.atan2(dirx, dirz); p.y = M.groundAt(p.x, p.z).y; p.air = false; p.w = 0;
          const v = p.st.top * 1.02; p.vx = dirx * v; p.vz = dirz * v; p.nitro = 1; p.solidCache = null;
          let passed = false, maxV = 0;
          for (let k = 0; k < 240; k++) {
            if (label.includes('рывок')) { p.inp.thr = 1; p.inp.nitro = 1; w.step(1 / 30); w.events.length = 0; } else __drift.stepWorld(1, { thr: 1, nitro: 1 });
            maxV = Math.max(maxV, p.speed);
            if ((p.x - tx) * dirx + (p.z - tz) * dirz > 0.3 && Math.abs((p.x - tx) * -dirz + (p.z - tz) * dirx) < 1.2) passed = true;
          }
          out.push({ label, passed, kmh: Math.round(maxV * 3.6) });
        };
        // фонарь у шоссе: едем вдоль края дороги прямо в столб
        const hwE = M.edges.find((e) => e.T.lamps);
        if (hwE && M.chunkLamps) {
          let lamp = null; for (let i = hwE.i0 + 200; i < hwE.i1 - 200 && !lamp; i += 10) { const [cx, cz] = M.chunkOf(M.X[i], M.Z[i]); for (const L of M.chunkLamps(cx, cz)) if (L.i > hwE.i0 + 150 && M.K[L.i] < 0.001) { lamp = L; break; } }
          if (lamp) { ram('фонарь', lamp.x, lamp.z, M.TX[lamp.i], M.TZ[lamp.i]); ram('фонарь, рывок кадра 1/30 с', lamp.x, lamp.z, M.TX[lamp.i], M.TZ[lamp.i]); }
          else out.push({ label: 'фонарь не найден', passed: true, kmh: 0 });
        } else out.push({ label: 'нет фонарей в списке мира', passed: true, kmh: -1 });
        // опора экрана фестиваля - тонкая коробка 0.5 м
        const f = M.fest; if (f && M.FEST_PARTS) { const post = M.FEST_PARTS.find((q) => q.part === 'post'), cs = Math.cos(f.rot), sn = Math.sin(f.rot); const x = f.x + post.x * cs + post.z * sn, z = f.z - post.x * sn + post.z * cs; ram('опора экрана', x, z, -Math.sin(f.rot + 0.3), -Math.cos(f.rot + 0.3)); }
        else out.push({ label: 'нет фестиваля в списке мира', passed: true, kmh: -1 });
        // ограждение моста под углом 25 градусов
        let bi = -1; for (let i = 0; i < M.N; i++) if ((M.FL[i] & 1) && (M.FL[i + 60] & 1) && (M.FL[i - 60] & 1) && M.K[i] < 0.002) { bi = i; break; }
        if (bi >= 0) {
          const e = M.edges[M.E[bi]], nx = -M.TZ[bi], nz = M.TX[bi], a = 0.44, dx = M.TX[bi] * Math.cos(a) + nx * Math.sin(a), dz = M.TZ[bi] * Math.cos(a) + nz * Math.sin(a);
          // старт на самом мосту у дальнего края полосы, под углом к ближнему ограждению
          p.x = M.X[bi] - M.TX[bi] * 22 - nx * (e.hw - 1.6); p.z = M.Z[bi] - M.TZ[bi] * 22 - nz * (e.hw - 1.6); p.h = Math.atan2(dx, dz); p.y = M.nearestRoad(p.x, p.z).y; p.air = false; p.w = 0; p.vx = dx * p.st.top; p.vz = dz * p.st.top; p.solidCache = null;
          let worst = -1e9, corner = -1e9;
          for (let k = 0; k < 200; k++) {
            __drift.stepWorld(1, { thr: 1, nitro: 1 }); const q = M.nearestRoad(p.x, p.z, {}, p.y); if (!q || !q.bridge || Math.abs(p.y - q.y) > 3) continue;
            worst = Math.max(worst, Math.abs(q.lat) - e.hw);
            for (const [cx, cz] of __drift.core.carCorners(p)) { const qc = M.nearestRoad(cx, cz, {}, p.y); if (qc && qc.bridge) corner = Math.max(corner, Math.abs(qc.lat) - (qc.hw + 0.2)); }
          }
          out.push({ label: 'ограждение моста', worst: +worst.toFixed(2), corner: +corner.toFixed(3), onBridge: Math.abs(p.y - M.nearestRoad(p.x, p.z, {}, p.y).y) < 3 });
        }
        return out;
      });
      res.push(...r.map((x) => Object.assign({ map }, x)));
    }
    console.log(JSON.stringify(res));
    expect(res.filter((r) => r.kmh < 0)).toEqual([]);                        // столбы и опоры есть в списке мира
    expect(res.filter((r) => r.label !== 'ограждение моста' && r.passed)).toEqual([]);
    // центр машины у ограждения остаётся над полотном: кузов упирается бортом, а не пролетает сквозь
    for (const r of res.filter((r) => r.label === 'ограждение моста')) { expect(r.onBridge, r.map).toBe(true); expect(r.worst, r.map).toBeLessThan(0); expect(r.corner, r.map).toBeLessThan(0.06); }
  });

  test('рампа - въезд только с низкого края: сбоку и сзади это стенка, машина не взлетает на неё', async ({ page }) => {
    await openDrift(page);
    await startWorld(page, 'coast');
    const r = await page.evaluate(() => {
      const w = __drift.world, M = w.M, p = w.player, out = {};
      w.trafficOn = false; for (const a of w.traffic.slice()) w.removeAi(a); for (const a of w.rivals.slice()) w.removeAi(a);
      const rp = M.points.find((q) => q.type === 'jump').ramp, h = Math.atan2(rp.tx, rp.tz);
      for (const [lab, ang, sp] of [['спереди', 0, 32], ['сбоку', Math.PI / 2, 20], ['сзади', Math.PI, 20]]) {
        const dx = Math.sin(h + ang), dz = Math.cos(h + ang), cx = rp.x + rp.tx * rp.len / 2, cz = rp.z + rp.tz * rp.len / 2;
        p.x = cx - dx * 30; p.z = cz - dz * 30; p.h = h + ang; p.y = M.groundAt(p.x, p.z).y; p.vx = dx * sp; p.vz = dz * sp; p.air = false; p.w = 0; p.solidCache = null;
        let rise = -1e9; for (let i = 0; i < 300; i++) { __drift.stepWorld(1, { thr: 1 }); rise = Math.max(rise, p.y - rp.y0); }
        out[lab] = +rise.toFixed(2);
      }
      return out;
    });
    expect(r['спереди']).toBeGreaterThan(2.5);
    expect(r['сбоку']).toBeLessThan(0.6);
    expect(r['сзади']).toBeLessThan(0.6);
  });

  test('вне дорог склон круче 35 градусов - стенка: на 300 км/ч машина не взлетает по склону у входа в тоннель', async ({ page }) => {
    await openDrift(page);
    const res = [];
    for (const map of ['desert', 'coast', 'mountains']) {
      await startWorld(page, map);
      const r = await page.evaluate(() => {
        const w = __drift.world, M = w.M, p = w.player;
        w.trafficOn = false; for (const a of w.traffic.slice()) w.removeAi(a); for (const a of w.rivals.slice()) w.removeAi(a);
        // самый крутой склон вне дорог у входов в тоннели (по земле физики)
        let best = null;
        for (let i = 1; i < M.N - 1; i++) {
          if (!((M.FL[i] & 2) && !(M.FL[i - 1] & 2))) continue;
          for (let dx = -60; dx <= 60; dx += 4) for (let dz = -60; dz <= 60; dz += 4) {
            const x = M.X[i] + dx, z = M.Z[i] + dz, q = M.nearestRoad(x, z); if (q && q.d < q.hw + 6) continue;
            const h0 = M.groundAt(x, z).y, gx = M.groundAt(x + 1, z).y - h0, gz = M.groundAt(x, z + 1).y - h0, g = Math.hypot(gx, gz);
            if (g > 0.9 && (!best || g > best.g) && !M.solidAt(x, h0 + 0.5, z, 1)) best = { x, z, gx: gx / g, gz: gz / g, g };
          }
        }
        if (!best) return { found: false };
        // разгон снизу вверх по склону
        p.x = best.x - best.gx * 30; p.z = best.z - best.gz * 30; p.h = Math.atan2(best.gx, best.gz); p.y = M.groundAt(p.x, p.z).y; p.air = false; p.w = 0; p.vx = best.gx * 80; p.vz = best.gz * 80; p.solidCache = null;
        let worst = 0, px = p.x, pz = p.z, py = p.y;
        for (let k = 0; k < 120; k++) {
          __drift.stepWorld(1, { thr: 1 });
          const dxz = Math.hypot(p.x - px, p.z - pz), g = M.groundAt(p.x, p.z);
          if (!p.air && !g.onRoad && dxz > 0.05 && p.y - py > 0.06) worst = Math.max(worst, (p.y - py) / dxz);
          px = p.x; pz = p.z; py = p.y;
        }
        return { found: true, slope: +best.g.toFixed(2), worst: +worst.toFixed(2) };
      });
      res.push({ map, ...r });
    }
    console.log(JSON.stringify(res));
    expect(res.filter((r) => r.found).length).toBeGreaterThan(0);
    for (const r of res.filter((r) => r.found)) expect(r.worst, r.map + ' (склон ' + r.slope + ')').toBeLessThan(0.75);
  });

  test('нарисованная земля совпадает с физической: дороги, тротуары, перекрёстки, площадка и подъезд фестиваля, мосты, тоннели', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 200 });
    await openDrift(page);
    const res = [];
    for (const map of MAPS) {
      await startWorld(page, map);
      const r = await page.evaluate(() => {
        const w = __drift.world, M = w.M, W = __drift.worldRender, THREE = window.THREE, rc = new THREE.Raycaster(), o = new THREE.Vector3(), dn = new THREE.Vector3(0, -1, 0), g = {};
        const worst = {}, at = {};
        const sample = (kind, x, z, yRef, deep) => {
          const gy = M.groundAt(x, z, g, yRef).y;
          // свод горы рисует кусок, которому принадлежит дорога; он может быть и соседним (дальним) - для склонов берём все куски
          const objs = []; for (const ch of W.chunks.values()) if (ch.lod === 0 || (deep && ch.lod === 1)) objs.push(ch.group); objs.push(W.markers.group);
          // deep: луч сверху с высоты 25 м - нарисованная земля может быть и намного ниже физической (пустота под машиной)
          o.set(x, gy + (deep ? 25 : 1.2), z); rc.set(o, dn); rc.far = deep ? 60 : 3;
          const hit = rc.intersectObjects(objs, true).find((h) => !h.object.userData.car && h.object.userData.ghost === 'ground');
          if (!hit && !deep) return;
          const d = hit ? Math.abs(hit.point.y - gy) : 99;
          if (!(worst[kind] >= d)) { worst[kind] = +d.toFixed(3); at[kind] = Math.round(x) + ',' + Math.round(z); }
        };
        const visit = (x, z, fn) => { w.placeAt(x, z); for (let k = 0; k < 60 && (W.info().pending > 0 || k < 2); k++) W.stream(true); W.scene.updateMatrixWorld(true); fn(); };
        const rng = __drift.core.mulberry32(11);
        for (let n = 0; n < 14; n++) {
          const i0 = Math.floor(rng() * M.N);
          visit(M.X[i0], M.Z[i0], () => {
            const [pcx, pcz] = M.chunkOf(w.player.x, w.player.z);
            for (const i of M.roadSamplesIn(pcx, pcz, 0)) {
              if (i % 3) continue;
              const e = M.edges[M.E[i]], nx = -M.TZ[i], nz = M.TX[i];
              const kind = (M.FL[i] & 1) ? 'мост' : (M.FL[i] & 2) ? 'тоннель' : M.inJunction && M.inJunction(i) ? 'перекрёсток' : 'дорога';
              for (const s of [0, 0.5, 0.9]) sample(kind, M.X[i] + nx * e.hw * s, M.Z[i] + nz * e.hw * s, M.Y[i] + 0.5);
              if (M.sidewalkAt && M.sidewalkAt(i)) for (const sd of [-1, 1]) sample('тротуар', M.X[i] + nx * sd * (e.hw + 1.5), M.Z[i] + nz * sd * (e.hw + 1.5), M.Y[i] + 0.5);
            }
          });
        }
        // перекрёстки
        for (const nk in M.nodes) { const nd = M.nodes[nk]; if (nd.edges.length < 2) continue; visit(nd.x, nd.z, () => { for (let a = 0; a < 6.28; a += 0.8) for (const r of [0, 4, 8]) sample('перекрёсток', nd.x + Math.cos(a) * r, nd.z + Math.sin(a) * r, nd.y + 0.5); }); }
        // бездорожье у входов в тоннели (склон горы над порталом): нарисованный склон = земля физики
        let mouths = 0;
        for (let i = 1; i < M.N - 1 && mouths < 4; i++) {
          if (!((M.FL[i] & 2) && !(M.FL[i - 1] & 2) && M.E[i] === M.E[i - 1])) continue;
          mouths++;
          visit(M.X[i], M.Z[i], () => {
            const nx = -M.TZ[i], nz = M.TX[i], hw = M.edges[M.E[i]].hw;
            // шаг вдоль - со сдвигом 0.7 м: точка ровно на кромке свода (первая точка тоннеля) - вопрос точности луча, а не земли
            for (let along = -39.3; along <= 40; along += 5) for (const lat of [hw + 4, hw + 9, hw + 16, hw + 25, -hw - 4, -hw - 9, -hw - 16, -hw - 25]) {
              const x = M.X[i] + M.TX[i] * along + nx * lat, z = M.Z[i] + M.TZ[i] * along + nz * lat, q = M.nearestRoad(x, z);
              if (q && q.d < q.hw + 2) continue;
              if (M.solidAt(x, M.groundAt(x, z).y + 0.5, z, 0)) continue;           // внутри опоры портала машине не стоять
              sample('склон у тоннеля', x, z, undefined, true);
            }
          });
        }
        // фестиваль
        const f = M.fest || M.pointById('fest');
        let gap = 1e9; for (let i = 0; i < M.N; i++) gap = Math.min(gap, Math.hypot(M.X[i] - f.x, M.Z[i] - f.z) - M.edges[M.E[i]].hw);
        worst['зазор площадка-дорога'] = 0; at['зазор площадка-дорога'] = Math.round(gap); var festGap = gap - (f.r || 40);
        visit(f.x, f.z, () => { for (let a = 0; a < 6.28; a += 0.5) for (const r of [0, 10, 20, 30, 38]) sample('площадка фестиваля', f.x + Math.cos(a) * r, f.z + Math.sin(a) * r); if (f.drive) for (let t = 0.05; t < 1; t += 0.1) sample('подъезд', f.drive.ax + (f.drive.bx - f.drive.ax) * t, f.drive.az + (f.drive.bz - f.drive.az) * t); });
        return { worst, at, festGap };
      });
      res.push({ map, ...r });
    }
    console.log(JSON.stringify(res));
    for (const r of res) for (const k in r.worst) expect(r.worst[k], r.map + ' ' + k + ' @' + r.at[k]).toBeLessThan(0.12);
    for (const r of res) expect(Object.keys(r.worst), r.map).toEqual(expect.arrayContaining(['дорога', 'площадка фестиваля']));
    for (const r of res) expect(r.festGap, r.map + ': от края площадки до края дороги').toBeGreaterThan(15);
  });
});
