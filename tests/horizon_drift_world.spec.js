// Законы свободной езды «Horizon Drift»: для каждой большой карты - связность дорог, машина не проваливается
// при потоковой загрузке даже на 300 км/ч, память не растёт за 10 минут езды; плюс точки мира, карьера из мира,
// быстрое перемещение, сохранение по картам, пауза, погода.
const { test, expect } = require('@playwright/test');
const { openDrift } = require('./_drift-helpers');

const MAPS = ['coast', 'mountains', 'desert', 'metro'];
const startWorld = (page, map, o) => page.evaluate(async ([map, o]) => { await __drift.startWorld(map, o || { fest: true }); __drift.manual = true; return __drift.world.M.id; }, [map, o]);

test.describe('horizon_drift_offline: открытый мир', () => {
  test.describe.configure({ timeout: 240_000 });

  test('карты из данных: не меньше трёх больших карт, дороги связны, выборки непрерывны, точки у дорог', async ({ page }) => {
    await openDrift(page);
    const rep = await page.evaluate(() => {
      const WD = __drift.worldData;
      return WD.MAPS.map((def) => {
        const M = WD.buildMap(def.id), con = WD.graphConnected(M);
        let maxGap = 0, endGap = 0;
        for (const e of M.edges) {
          for (let i = e.i0 + 1; i <= e.i1; i++) maxGap = Math.max(maxGap, Math.hypot(M.X[i] - M.X[i - 1], M.Z[i] - M.Z[i - 1]));
          endGap = Math.max(endGap, Math.hypot(M.X[e.i0] - M.nodes[e.a].x, M.Z[e.i0] - M.nodes[e.a].z), Math.hypot(M.X[e.i1] - M.nodes[e.b].x, M.Z[e.i1] - M.nodes[e.b].z));
        }
        // фестиваль стоит дальше (площадка 40 м и подъезд к ней), остальные точки - у дорог
        const far = M.points.filter((p) => { let d = 1e9; for (let i = 0; i < M.N; i += 3) d = Math.min(d, Math.hypot(M.X[i] - p.x, M.Z[i] - p.z)); return d > (p.type === 'fest' ? 110 : 70); }).map((p) => p.id);
        const types = {}; M.points.forEach((p) => { types[p.type] = (types[p.type] || 0) + 1; });
        // маршрут по рёбрам есть между любыми двумя рёбрами
        let routes = true; for (const a of M.edges) for (const b of M.edges) if (!WD.routeEdges(M, a.id, b.id)) routes = false;
        return { id: def.id, reached: con.reached, all: con.all, maxGap, endGap, far, types, sizeKm: M.half * 2 / 1000, roadKm: M.totalRoad / 1000, routes,
          bridges: Array.from(M.FL).filter((f) => f & 1).length, tunnels: Array.from(M.FL).filter((f) => f & 2).length };
      });
    });
    expect(rep.length).toBeGreaterThanOrEqual(3);
    for (const r of rep) {
      expect(r.reached, r.id).toBe(r.all);
      expect(r.routes, r.id).toBe(true);
      expect(r.maxGap, r.id).toBeLessThan(3);
      expect(r.endGap, r.id).toBeLessThan(0.5);
      expect(r.far, r.id).toEqual([]);
      expect(r.sizeKm, r.id).toBeGreaterThan(8);
      expect(r.roadKm, r.id).toBeGreaterThan(40);
      expect(r.types.radar, r.id).toBeGreaterThanOrEqual(4);
      expect(r.types.drift, r.id).toBeGreaterThanOrEqual(4);
      expect(r.types.jump, r.id).toBeGreaterThanOrEqual(3);
      expect(r.types.board, r.id).toBeGreaterThanOrEqual(25);
      expect(r.types.event, r.id).toBeGreaterThanOrEqual(1);
    }
    expect(rep.some((r) => r.bridges > 0) && rep.some((r) => r.tunnels > 0)).toBe(true);
  });

  for (const map of MAPS) {
    test(`${map}: на 300 км/ч при отстающей подгрузке машина не проваливается, рельеф не накрывает дорогу`, async ({ page }) => {
      await page.setViewportSize({ width: 640, height: 400 });
      await openDrift(page);
      await startWorld(page, map);
      const r = await page.evaluate(() => {
        const w = __drift.world, M = w.M, p = w.player, W = __drift.worldRender, g = {};
        let worst = 0, maxGapGround = 0, steps = 0, air = 0;
        // ведём машину по цепочке рёбер ровно по дороге со скоростью 83 м/с (300 км/ч);
        // физика считает высоту сама, а подгрузка кусков - лишь раз в 20 шагов и по одному куску
        let e = M.edges.find((x) => x.type === 'highway') || M.edges[0], dir = 1, s = 10, i = e.i0;
        for (let n = 0; n < 60 * 120; n++) {
          s += 83.3 / 120;
          if (s >= e.len - 2) { const node = dir > 0 ? e.b : e.a, opts = M.nodes[node].edges.filter((x) => x !== e.id); const ne = M.edges[opts.length ? opts[n % opts.length] : e.id]; dir = ne.a === node ? 1 : -1; if (ne.id === e.id) dir = -dir; e = ne; s = 2; }
          const k = dir > 0 ? Math.min(e.i1 - 1, e.i0 + Math.floor(s / e.step)) : Math.max(e.i0 + 1, e.i1 - Math.floor(s / e.step)); i = k;
          const h = Math.atan2(M.TX[k] * dir, M.TZ[k] * dir);
          p.x = M.X[k]; p.z = M.Z[k]; p.h = h; p.vx = Math.sin(h) * 83.3; p.vz = Math.cos(h) * 83.3; p.w = 0;
          w.step(1 / 120, { thr: 1 });
          w.events.length = 0;
          const gy = M.groundAt(p.x, p.z, g).y;
          worst = Math.min(worst, p.y - gy);
          if (p.air) air++; else maxGapGround = Math.max(maxGapGround, p.y - gy);
          if (n % 20 === 0) W.stream(false, 0);
          steps++;
        }
        // догрузить и проверить, что сетка рельефа не выше дороги около машины
        for (let k = 0; k < 40 && W.info().pending > 0; k++) W.stream(true);
        let buried = 0, checked = 0;
        const q = M.nearestRoad(p.x, p.z) || { i, edge: e };
        for (let d = -60; d <= 60; d += 3) {
          const j = Math.min(q.edge.i1, Math.max(q.edge.i0, q.i + d)), mh = W.meshHeight(M.X[j], M.Z[j]);
          if (mh === null) continue; checked++;
          if (mh > M.Y[j] + 0.05) buried++;
        }
        return { worst, maxGapGround, steps, airFrac: air / steps, buried, checked, dist: Math.hypot(p.x, p.z) };
      });
      expect(r.worst).toBeGreaterThanOrEqual(-1e-6);
      expect(r.maxGapGround).toBeLessThan(0.01);
      expect(r.airFrac).toBeLessThan(0.2);
      expect(r.checked).toBeGreaterThan(20);
      expect(r.buried).toBe(0);
    });

    test(`${map}: 10 минут езды с трафиком - геометрии кусков и остальные счётчики не растут`, async ({ page }) => {
      await page.setViewportSize({ width: 480, height: 300 });
      await openDrift(page);
      await startWorld(page, map);
      const r = await page.evaluate(async () => {
        const w = __drift.world, W = __drift.worldRender, info = __drift.renderer.info;
        const frame = () => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
        // одно и то же место, куски догружены полностью; геометрии машин считаются отдельно и вычитаются точно
        // какие геометрии попали в видеокарту и какие освобождены: утечка - загруженная, не освобождённая и нигде не используемая
        const up = new Set(), oAdd = THREE.BufferGeometry.prototype.addEventListener, oDisp = THREE.BufferGeometry.prototype.dispose;
        THREE.BufferGeometry.prototype.addEventListener = function (t, f) { if (t === 'dispose') up.add(this); return oAdd.call(this, t, f); };
        THREE.BufferGeometry.prototype.dispose = function () { up.delete(this); return oDisp.call(this); };
        const upT = new Set(), tAdd = THREE.Texture.prototype.addEventListener, tDisp = THREE.Texture.prototype.dispose;
        THREE.Texture.prototype.addEventListener = function (t, f) { if (t === 'dispose') upT.add(this); return tAdd.call(this, t, f); };
        THREE.Texture.prototype.dispose = function () { upT.delete(this); return tDisp.call(this); };
        const leaked = () => { const live = new Set(); W.scene.traverse((o) => { if (o.geometry) live.add(o.geometry); }); for (const g of Object.values(W.geo)) live.add(g); return [...up].filter((g) => !live.has(g)).length; };
        const leakedTex = () => {
          const live = new Set(W.owned);
          W.scene.traverse((o) => { for (const m of [].concat(o.material || [])) { for (const k in m) if (m[k] && m[k].isTexture) live.add(m[k]); if (m.uniforms) for (const u of Object.values(m.uniforms)) if (u.value && u.value.isTexture) live.add(u.value); } });
          if (W.sun.shadow.map) live.add(W.sun.shadow.map.texture);
          return [...upT].filter((t) => !live.has(t)).length;
        };
        // замер без машин ИИ (их меши уходят вместе с ними), с одной и той же позиции, после отрисовки
        const atFest = async () => {
          for (const a of w.traffic.slice()) w.removeAi(a); for (const a of w.rivals.slice()) w.removeAi(a);
          w.placeAtPoint('fest'); __drift.stepWorld(2); W.cam.init = false;
          for (let k = 0; k < 400 && (W.info().pending > 0 || k < 3); k++) { W.stream(true); await frame(); }
          for (let k = 0; k < 3; k++) await frame();
          return { leaked: leaked(), leakedTex: leakedTex(), chunkGeo: W.chunkGeometryCount(), tex: info.memory.textures - 2 * W.carMeshes.size, chunks: W.info().chunks, pending: W.info().pending };
        };
        w.save.autoTime = true;
        const before = await atFest();
        let maxChunks = 0, maxCars = 0, maxTraffic = 0;
        w.setAutopilot(36);
        for (let min = 0; min < 10; min++) {
          for (let k = 0; k < 60; k++) { __drift.stepWorld(120); W.stream(false, 3); if (k % 10 === 0) await frame(); maxChunks = Math.max(maxChunks, W.info().chunks); maxCars = Math.max(maxCars, W.carMeshes.size); maxTraffic = Math.max(maxTraffic, w.traffic.length); }
        }
        w.setAutopilot(0);
        const after = await atFest();
        THREE.BufferGeometry.prototype.addEventListener = oAdd; THREE.BufferGeometry.prototype.dispose = oDisp; THREE.Texture.prototype.addEventListener = tAdd; THREE.Texture.prototype.dispose = tDisp;
        return { before, after, maxChunks, maxCars, maxTraffic, t: w.t };
      });
      expect(r.t).toBeGreaterThan(600);
      expect(r.maxTraffic).toBeGreaterThan(0);                  // трафик включён
      expect(r.before.pending).toBe(0);
      expect(r.after.pending).toBe(0);
      expect(r.after.chunks).toBe(r.before.chunks);
      expect(r.after.chunkGeo).toBe(r.before.chunkGeo);          // те же куски - ровно те же геометрии
      expect(r.before.leaked).toBe(0);
      expect(r.after.leaked).toBe(0);                            // в видеокарте нет ни одной брошенной геометрии
      expect(r.after.leakedTex).toBe(0);                         // и ни одной брошенной текстуры
      expect(r.after.tex).toBeLessThanOrEqual(r.before.tex + 3);  // (точные счётчики видеокарты зависят от того, что попало в кадр)
      expect(r.maxChunks).toBeLessThanOrEqual(81);
      expect(r.maxCars).toBeLessThanOrEqual(10);
    });

    test(`${map}: настоящие маршруты - под мостом, поперёк горы над тоннелем, сквозь тоннель; сетка рельефа совпадает с физикой по всем дорогам`, async ({ page }) => {
      await page.setViewportSize({ width: 480, height: 300 });
      await openDrift(page);
      await startWorld(page, map);
      const r = await page.evaluate(() => {
        const w = __drift.world, M = w.M, p = w.player, W = __drift.worldRender;
        for (const a of w.rivals.slice()) w.removeAi(a); w.trafficOn = false; for (const a of w.traffic.slice()) w.removeAi(a);
        const drive = (x, z, h, v, n, inp) => {
          p.x = x; p.z = z; p.h = h; p.y = M.groundAt(x, z, {}, 1e4).y; p.vx = Math.sin(h) * v; p.vz = Math.cos(h) * v; p.w = 0; p.air = false; p.vy = 0;
          const tr = [];
          for (let k = 0; k < n; k++) { const y0 = p.y; w.step(1 / 120, inp || { thr: 0.5 }); w.events.length = 0; tr.push({ y: p.y, dy: p.y - y0, x: p.x, z: p.z }); }
          return tr;
        };
        const out = {};
        // под мостом поперёк: полотно моста не подбрасывает машину
        let bi = -1; for (let i = 0; i < M.N; i++) if ((M.FL[i] & 1) && M.RAW[i] > 2 && M.Y[i] - M.RAW[i] > 6) { bi = i; break; }
        if (bi >= 0) {
          const nx = -M.TZ[bi], nz = M.TX[bi];
          const tr = drive(M.X[bi] + nx * 40, M.Z[bi] + nz * 40, Math.atan2(-nx, -nz), 15, 600);
          out.bridge = { deck: M.Y[bi], maxY: Math.max(...tr.map((t) => t.y)), maxDy: Math.max(...tr.map((t) => Math.abs(t.dy))) };
        }
        // тоннель: поперёк по горе - не проваливается внутрь; вдоль по дороге - едет по полотну внутри
        const e = M.edges.find((x) => x.tunnelRange);
        if (e) {
          const ti = (e.tunnelRange[0] + e.tunnelRange[1]) >> 1, nx = -M.TZ[ti], nz = M.TX[ti];
          const tr = drive(M.X[ti] + nx * 45, M.Z[ti] + nz * 45, Math.atan2(-nx, -nz), 12, 900, { thr: 0.4 });
          // машина всё время на склоне горы: не падает в прорезь над тоннелем и не взлетает над ней
          out.over = { road: M.Y[ti], minY: Math.min(...tr.map((t) => t.y)), maxSink: Math.max(...tr.map((t) => M.terrainHeight(t.x, t.z) - t.y)) };
          let it = e.i0; while (it < e.i1 && !(M.FL[it] & 2)) it++;            // первая точка под горой
          const i0 = Math.max(e.i0, it - 60);
          w.placeAt(M.X[i0], M.Z[i0], Math.atan2(M.TX[i0], M.TZ[i0])); w.setAutopilot(20);
          const tr2 = drive(p.x, p.z, p.h, 15, 2400, {});
          w.setAutopilot(0);
          let worst = 0; for (const t of tr2) { const q = M.nearestRoad(t.x, t.z); if (q && q.tunnel && q.d < q.hw) worst = Math.max(worst, Math.abs(t.y - q.y)); }
          out.through = { worst, reached: tr2.some((t) => { const q = M.nearestRoad(t.x, t.z); return q && q.tunnel; }) };
        }
        // сетка рельефа против физики: по всем дорогам через каждые 20 м куски строятся с полной детальностью
        const byChunk = new Map();
        for (const ed of M.edges) for (let i = ed.i0 + 5; i < ed.i1 - 5; i += 10) {
          const [cx, cz] = M.chunkOf(M.X[i], M.Z[i]), k = cx + ',' + cz;
          if (!byChunk.has(k)) byChunk.set(k, { cx, cz, list: [] });
          byChunk.get(k).list.push(i);
        }
        let buried = 0, onRoad = 0, worstOff = 0, where = null;
        const diffs = [];
        for (const { cx, cz, list } of byChunk.values()) {
          const ch = W._build(cx, cz, 0);
          for (const i of list) {
            if (M.FL[i] & 3) continue;
            const mh = W.meshHeight(M.X[i], M.Z[i], [ch]);
            if (mh !== null) { onRoad++; if (mh > M.Y[i] + 0.05) buried++; }
            const hw = M.edges[M.E[i]].hw, ox = M.X[i] + (-M.TZ[i]) * (hw + 14), oz = M.Z[i] + M.TX[i] * (hw + 14);
            if (Math.floor(ox / 256) !== cx || Math.floor(oz / 256) !== cz) continue;
            const q = M.nearestRoad(ox, oz); if (q && q.d < q.hw + 12) continue;
            const m2 = W.meshHeight(ox, oz, [ch]); if (m2 === null) continue;
            const dd = Math.abs(m2 - M.groundAt(ox, oz).y); diffs.push(dd); if (dd > worstOff) { worstOff = dd; where = [Math.round(ox), Math.round(oz)]; }
          }
          W._dispose(ch);
        }
        diffs.sort((a, b) => a - b);
        out.mesh = { chunks: byChunk.size, onRoad, buried, p95: diffs[Math.floor(diffs.length * 0.95)], worstOff, where, n: diffs.length };
        return out;
      });
      if (r.bridge) { expect(r.bridge.maxY).toBeLessThan(r.bridge.deck - 2); expect(r.bridge.maxDy).toBeLessThan(0.5); }
      if (r.over) { expect(r.over.minY).toBeGreaterThan(r.over.road + 5); expect(r.over.maxSink).toBeLessThan(0.3); expect(r.through.reached).toBe(true); expect(r.through.worst).toBeLessThan(0.05); }
      expect(r.mesh.onRoad).toBeGreaterThan(1000);
      expect(r.mesh.buried).toBe(0);
      expect(r.mesh.p95).toBeLessThan(0.6);
      expect(r.mesh.worstOff).toBeLessThan(4);
    });
  }

  test('после прогрева езда по карте в разную погоду и время не собирает новых шейдеров; вход в мир быстрый', async ({ page }) => {
    test.setTimeout(600_000);                 // под полной загрузкой машины прогон дольше; само условие то же
    await page.setViewportSize({ width: 640, height: 400 });
    await openDrift(page);
    for (const map of ['metro', 'coast']) {
      const r = await page.evaluate(async (map) => {
        const t0 = performance.now(); await __drift.startWorld(map, { fest: true }); const load = performance.now() - t0;
        __drift.manual = true;
        const w = __drift.world, W = __drift.worldRender, ren = __drift.renderer;
        const start = ren.info.programs.length;
        w.setAutopilot(38); w.save.autoTime = true;
        for (let f = 0; f < 1500; f++) { __drift.stepWorld(2); W.frame(1 / 60, 1, 'chase'); if (f === 500) w.save.weather = 'rain'; if (f === 1000) { w.save.weather = 'snow'; w.save.tod = 23; } }
        const added = ren.info.programs.length - start;
        w.setAutopilot(0); __drift.quitWorld();
        return { load, added, start };
      }, map);
      expect(r.added, map).toBe(0);
      expect(r.load, map).toBeLessThan(6000);
    }
  });

  test('событие карьеры из мира засчитывается и возвращает в мир', async ({ page }) => {
    await openDrift(page);
    await page.evaluate(() => { const c = __drift.career; c.d.owned.push('mirage'); c.d.current = 'mirage'; c.d.upg.mirage = { engine: 3, tyres: 3, susp: 3, weight: 3, nitro: 3 }; c.save(c.d); });
    await startWorld(page, 'coast');
    await page.evaluate(() => { const w = __drift.world, pt = w.M.pointById('ev-city'); w.placeAt(pt.x, pt.z); const p = w.player; p.x = pt.x; p.z = pt.z; p.y = w.M.groundAt(p.x, p.z).y; __drift.stepWorld(5); __drift.manual = false; });
    await expect(page.locator('#wPrompt')).toContainText('События');
    await page.keyboard.press('KeyE');
    await expect(page.locator('#scrHub')).toBeVisible();
    await page.evaluate(() => { __drift.manual = true; });
    await page.locator('#hubList button[data-evt="c1e1"]').click();
    await page.waitForFunction(() => __drift.screen === 'race' && __drift.race);
    await page.evaluate(() => { const r = __drift.race; r.setAutopilot(r.player, 1); for (let i = 0; i < 400 * 120 && r.phase !== 'done'; i++) __drift.step(1); __drift.showResults(); });
    expect(await page.evaluate(() => __drift.career.eventMedal('c1e1'))).toBe('gold');
    await expect(page.locator('#resNext')).toHaveText('Вернуться в мир');
    await page.locator('#resNext').click();
    await page.waitForFunction(() => __drift.screen === 'world');
    expect(await page.evaluate(() => [!!__drift.world, __drift.world.M.id, !!__drift.worldRender.world])).toEqual([true, 'coast', true]);
    // вернулись туда же, откуда уехали на событие
    const back = await page.evaluate(() => { const w = __drift.world, pt = w.M.pointById('ev-city'); return Math.hypot(w.player.x - pt.x, w.player.z - pt.z); });
    expect(back).toBeLessThan(30);
  });

  test('щит засчитывается один раз: деньги один раз, после перезагрузки тоже', async ({ page }) => {
    await openDrift(page);
    await startWorld(page, 'desert');
    const hit = () => page.evaluate(() => {
      const w = __drift.world, pt = w.M.points.find((q) => q.type === 'board'), p = w.player;
      const h = Math.atan2(pt.x - (pt.x - 20), 0); void h;
      p.x = pt.x - 20; p.z = pt.z; p.y = w.M.groundAt(p.x, p.z).y; p.h = Math.PI / 2 * -1 * -1; p.h = Math.atan2(1, 0); p.vx = 20; p.vz = 0; p.air = false;
      const m0 = __drift.career.money;
      for (let i = 0; i < 240; i++) { __drift.stepWorld(1, { thr: 0.5 }); p.z = pt.z; }
      return { id: pt.id, got: !!w.save.boards[pt.id], money: __drift.career.money - m0, count: w.counts().boards };
    });
    const a = await hit();
    expect(a.got).toBe(true);
    expect(a.money).toBe(500);
    expect(a.count).toBe(1);
    const b = await hit();
    expect(b.money).toBe(0);
    expect(b.count).toBe(1);
    await page.evaluate(() => __drift.saveWorld());
    await page.reload();
    await page.waitForFunction(() => window.__drift && __drift.ready);
    await startWorld(page, 'desert', { fest: false });
    const c = await hit();
    expect(c.money).toBe(0);
    expect(c.count).toBe(1);
  });

  test('быстрое перемещение - только к открытым точкам; открытие - когда подъедешь', async ({ page }) => {
    await openDrift(page);
    await startWorld(page, 'mountains');
    const r = await page.evaluate(() => {
      const w = __drift.world, p = w.player, M = w.M;
      const far = M.points.filter((q) => q.type === 'radar' && !w.save.disc[q.id]).sort((a, b) => Math.hypot(b.x - p.x, b.z - p.z) - Math.hypot(a.x - p.x, a.z - p.z))[0];
      const before = [p.x, p.z], closed = __drift.worldTravel(far.id), after = [p.x, p.z];
      w.placeAt(far.x, far.z); __drift.stepWorld(61);
      const opened = !!w.save.disc[far.id];
      w.placeAtPoint('fest'); __drift.stepWorld(2);
      const ok = __drift.worldTravel(far.id), d = Math.hypot(p.x - far.x, p.z - far.z);
      return { closed, same: before[0] === after[0] && before[1] === after[1], opened, ok, d };
    });
    expect(r.closed).toBe(false);
    expect(r.same).toBe(true);
    expect(r.opened).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.d).toBeLessThan(40);
  });

  test('рекорды мира: радар, прыжок с рампы, зона дрифта; сохранение по карте переживает перезагрузку', async ({ page }) => {
    await openDrift(page);
    // заднеприводный «Вихрь»: передний привод «Искры» ручником почти не срывается в занос
    await page.evaluate(() => { const c = __drift.career; c.d.owned.push('vihr'); c.d.current = 'vihr'; c.save(c.d); });
    await startWorld(page, 'coast');
    const r = await page.evaluate(() => {
      const w = __drift.world, M = w.M, p = w.player;
      const along = (i, back, v) => { const h = Math.atan2(M.TX[i], M.TZ[i]); p.x = M.X[i] - M.TX[i] * back; p.z = M.Z[i] - M.TZ[i] * back; p.h = h; p.y = M.groundAt(p.x, p.z).y; p.vx = Math.sin(h) * v; p.vz = Math.cos(h) * v; p.air = false; p.w = 0; };
      const radar = M.points.find((q) => q.type === 'radar'); along(radar.i, 60, 40);
      for (let i = 0; i < 360; i++) __drift.stepWorld(1, { thr: 1 });
      const jump = M.points.find((q) => q.type === 'jump'), rp = jump.ramp, h = Math.atan2(rp.tx, rp.tz);
      p.x = rp.x - rp.tx * 30; p.z = rp.z - rp.tz * 30; p.h = h; p.y = M.groundAt(p.x, p.z).y; p.vx = Math.sin(h) * 32; p.vz = Math.cos(h) * 32; p.air = false; p.w = 0;
      let airborne = false;
      for (let i = 0; i < 600; i++) { __drift.stepWorld(1, { thr: 1 }); if (p.air) airborne = true; if (airborne && !p.air && i > 200) break; }
      const zone = M.points.find((q) => q.type === 'drift'); along(zone.i0 + 5, 0, 22);
      p.assist.tc = false; p.assist.steer = false;
      for (let i = 0; i < 40; i++) __drift.stepWorld(1, { thr: 1, steer: 1, hb: 1 });
      for (let i = 0; i < 150; i++) __drift.stepWorld(1, { thr: 1, steer: 0.4 });
      w.placeAtPoint('fest'); __drift.stepWorld(3);
      w.save.weather = 'rain'; w.save.autoTime = false; w.save.tod = 21.5;
      __drift.saveWorld();
      return { radar: w.save.rec.radar[radar.id], jump: w.save.rec.jump[jump.id], airborne, drift: w.save.rec.drift[zone.id], pos: [p.x, p.z] };
    });
    expect(r.radar).toBeGreaterThan(120);
    expect(r.airborne).toBe(true);
    expect(r.jump).toBeGreaterThan(8);
    expect(r.drift).toBeGreaterThan(0);
    await page.reload();
    await page.waitForFunction(() => window.__drift && __drift.ready);
    await startWorld(page, 'coast', { fest: false });
    const s = await page.evaluate(() => { const w = __drift.world; return { rec: w.save.rec, weather: w.save.weather, tod: w.save.tod, pos: [w.player.x, w.player.z] }; });
    expect(s.rec.radar).toEqual(expect.objectContaining({ [Object.keys(s.rec.radar)[0]]: r.radar }));
    expect(Object.values(s.rec.jump)[0]).toBe(r.jump);
    expect(s.weather).toBe('rain');
    expect(s.tod).toBe(21.5);
    expect(Math.hypot(s.pos[0] - r.pos[0], s.pos[1] - r.pos[1])).toBeLessThan(30);
    // прогресс у каждой карты свой
    await page.evaluate(() => __drift.quitWorld());
    await startWorld(page, 'desert');
    expect(await page.evaluate(() => Object.keys(__drift.world.save.rec.radar).length)).toBe(0);
  });

  test('погода меняет сцепление: в дождь и снег асфальт держит хуже; пауза при скрытой вкладке и потере фокуса', async ({ page }) => {
    await openDrift(page);
    await startWorld(page, 'metro');
    const r = await page.evaluate(() => {
      const w = __drift.world, M = w.M, p = w.player;
      const brake = (weather) => {
        w.save.weather = weather; const e = M.edges.find((x) => x.type === 'highway'), i = e.i0 + 400, h = Math.atan2(M.TX[i], M.TZ[i]);
        p.x = M.X[i]; p.z = M.Z[i]; p.h = h; p.y = M.Y[i]; p.vx = Math.sin(h) * 30; p.vz = Math.cos(h) * 30; p.air = false; p.w = 0; p.steer = 0;
        let d = 0; for (let k = 0; k < 1200 && (k === 0 || p.speed > 0.2); k++) { const x0 = p.x, z0 = p.z; __drift.stepWorld(1, { brk: 1 }); d += Math.hypot(p.x - x0, p.z - z0); }
        return { d, mul: p.gripMul };
      };
      return { clear: brake('clear'), rain: brake('rain'), snow: brake('snow') };
    });
    expect(r.rain.mul).toBeLessThan(1);
    expect(r.rain.d).toBeGreaterThan(r.clear.d * 1.1);
    expect(r.snow.d).toBeGreaterThan(r.clear.d * 1.1);
    await page.evaluate(() => { __drift.manual = false; });
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(page.locator('#scrPause')).toBeVisible();
    await expect(page.locator('#pRestart')).toHaveText('На фестиваль');
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); });
    expect(await page.evaluate(() => __drift.paused)).toBe(true);
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => __drift.paused)).toBe(false);
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await expect(page.locator('#scrPause')).toBeVisible();
  });

  test('выбор карты: превью, размер, точки и собранное; большая карта и мир влезают в окно', async ({ page }) => {
    for (const size of [{ width: 1024, height: 700 }, { width: 1280, height: 720 }, { width: 1920, height: 1080 }]) {
      await page.setViewportSize(size);
      await openDrift(page);
      await page.locator('.mainnav button[data-go="roam"]').click();
      await expect(page.locator('#mapsGrid .mapcard')).toHaveCount(4);
      await expect(page.locator('#mapsGrid .mapcard').first()).toContainText('км');
      await expect(page.locator('#mapsGrid .mapcard').first()).toContainText('Щиты');
      const fits = (sel) => page.evaluate((sel) => {
        const de = document.documentElement, out = [];
        if (de.scrollWidth > innerWidth || de.scrollHeight > innerHeight) out.push('прокрутка');
        for (const el of document.querySelectorAll(sel)) { const r = el.getBoundingClientRect(); if (!r.width) continue; if (r.left < -0.5 || r.top < -0.5 || r.right > innerWidth + 0.5 || r.bottom > innerHeight + 0.5) out.push(sel + ' ' + (el.id || '')); }
        return out;
      }, sel);
      expect(await fits('#rGo, #rCar, .head')).toEqual([]);
      // значения в карточках карт - в одну строку, без переносов
      const wrapped = await page.evaluate(() => [...document.querySelectorAll('#mapsGrid .mapcard .kv b')].filter((b) => b.getBoundingClientRect().height > parseFloat(getComputedStyle(b).fontSize) * 1.8).map((b) => b.textContent));
      expect(wrapped, size.width + 'x' + size.height).toEqual([]);
      await page.locator('#rGo').click();
      await page.waitForFunction(() => __drift.screen === 'world');
      expect(await fits('#wInfo, #hMap, #hSpeedo, #hNitro, #hKeys, #hPauseBtn')).toEqual([]);
      await page.keyboard.press('KeyM');
      await expect(page.locator('#scrMap')).toBeVisible();
      expect(await fits('#bigMap, #mapSide, #mapClose')).toEqual([]);
      await page.keyboard.press('KeyM');
      await expect(page.locator('#scrMap')).toBeHidden();
      await page.evaluate(() => __drift.quitWorld());
    }
  });

  test('дома - твёрдые коробки: машина не заезжает внутрь ни с какой стороны; в центрах городов плотная застройка', async ({ page }) => {
    await openDrift(page);
    const r = await page.evaluate(() => {
      const WD = __drift.worldData, C = __drift.core;
      const inside = (d, x, z) => { const c = Math.cos(d.rot), s = Math.sin(d.rot), dx = x - d.x, dz = z - d.z; const lx = dx * c - dz * s, lz = dx * s + dz * c; return Math.min(d.w / 2 - Math.abs(lx), d.d / 2 - Math.abs(lz)); };
      const out = {};
      for (const id of ['metro', 'coast']) {
        const M = WD.buildMap(id);
        const reg = M.R.find((rg) => rg.id === (id === 'metro' ? 'down' : 'city'));
        let houses = [];
        for (let cx = Math.floor((reg.x - 900) / 256); cx <= Math.floor((reg.x + 900) / 256); cx++) for (let cz = Math.floor((reg.z - 900) / 256); cz <= Math.floor((reg.z + 900) / 256); cz++) houses = houses.concat(M.chunkDecor(cx, cz).filter((d) => d.type === 'building' && Math.hypot(d.x - reg.x, d.z - reg.z) < 900));
        const tall = houses.filter((d) => d.h > 50).length;
        let deepest = -1e9;
        for (const d of houses.slice(0, 6)) {
          for (let a = 0; a < 16; a++) {
            const w = new WD.World({ map: id, car: 'sapsan', seed: 1, traffic: false }); for (const rv of w.rivals.slice()) w.removeAi(rv);
            const p = w.player, ang = a / 16 * 2 * Math.PI;
            p.x = d.x + Math.sin(ang) * (Math.hypot(d.w, d.d) / 2 + 20); p.z = d.z + Math.cos(ang) * (Math.hypot(d.w, d.d) / 2 + 20); p.y = M.groundAt(p.x, p.z).y;
            p.h = Math.atan2(d.x - p.x, d.z - p.z); p.vx = Math.sin(p.h) * 25; p.vz = Math.cos(p.h) * 25; p.air = false;
            for (let k = 0; k < 200; k++) { w.step(C.DT, { thr: 1 }); w.events.length = 0; deepest = Math.max(deepest, inside(d, p.x, p.z)); }
          }
        }
        out[id] = { houses: houses.length, tall, deepest };
      }
      return out;
    });
    expect(r.metro.houses).toBeGreaterThan(150);
    expect(r.metro.tall).toBeGreaterThan(10);
    expect(r.coast.houses).toBeGreaterThan(80);
    expect(r.metro.deepest).toBeLessThan(-0.5);              // центр машины не ближе 0.5 м к стене изнутри
    expect(r.coast.deepest).toBeLessThan(-0.5);
  });

  test('сохранение мира: чужие ключи погоды отбрасываются, мир с ними работает', async ({ page }) => {
    await openDrift(page);
    const r = await page.evaluate(() => {
      const WD = __drift.worldData, C = __drift.core, out = {};
      for (const bad of ['toString', '__proto__', 'constructor', 'hasOwnProperty', 7, null]) {
        const s = WD.sanitizeSave('coast', { weather: bad, tod: 12, day: -3, duels: { x: 'y' } });
        const w = new WD.World({ map: 'coast', car: 'iskra', save: s, seed: 1 });
        let err = null; try { for (let k = 0; k < 240; k++) w.step(C.DT, { thr: 1 }); } catch (e) { err = String(e); }
        out[String(bad)] = { weather: s.weather, err, day: s.day, duels: s.duels };
      }
      return out;
    });
    for (const k in r) { expect(r[k].weather, k).toBe('clear'); expect(r[k].err, k).toBeNull(); expect(r[k].day, k).toBe(0); expect(r[k].duels, k).toEqual({}); }
  });

  test('трафик и соперники держатся дороги, не застревают, сбрасываются вне взгляда игрока', async ({ page }) => {
    await openDrift(page);
    const r = await page.evaluate(() => {
      const WD = __drift.worldData, C = __drift.core, out = {};
      for (const def of WD.MAPS) {
        const M = WD.buildMap(def.id), w = new WD.World({ map: def.id, car: 'iskra', seed: 5 });
        const st = { aiOff: 0, aiT: 0, rOff: 0, rT: 0, stuck: 0 }, slow = new Map();
        for (let k = 0; k < 120 * 60 * 3; k++) {
          if (k % 7200 === 0) { const ks = Object.keys(M.nodes), n2 = M.nodes[ks[(k / 7200 | 0) % ks.length]]; w.placeAt(n2.x + 30, n2.z + 30); }
          w.step(C.DT, {}); w.events.length = 0;
          for (const c of w.cars) {
            if (c === w.player) continue;
            const q = M.nearestRoad(c.x, c.z), off = !q || q.d > q.hw + 0.3;
            if (c.rival) { st.rT++; if (off) st.rOff++; } else { st.aiT++; if (off) st.aiOff++; }
            let s = slow.get(c) || 0; s = c.speed < 1 ? s + C.DT : 0; slow.set(c, s); if (s > 10 && s - C.DT <= 10) st.stuck++;
          }
        }
        // застрявший у стены соперник вне взгляда игрока возвращается на полосу
        const a = w.rivals[0], c = a.car; w.player.x = c.x + 400; w.player.z = c.z + 400;
        const e = M.edges[a.edge]; c.x += -M.TZ[a.i] * (e.hw + 30); c.z += M.TX[a.i] * (e.hw + 30); c.vx = c.vz = 0;
        a.stuckTotal = 6; a.reverseT = 0.5;
        w.step(C.DT, {}); const q = M.nearestRoad(c.x, c.z);
        out[def.id] = { traffic: st.aiOff / Math.max(1, st.aiT), rivals: st.rOff / Math.max(1, st.rT), stuck: st.stuck, reset: !!q && q.d < q.hw };
      }
      return out;
    });
    for (const k in r) {
      expect(r[k].traffic, k).toBeLessThan(0.07);
      expect(r[k].rivals, k).toBeLessThan(0.07);
      expect(r[k].stuck, k).toBe(0);
      expect(r[k].reset, k).toBe(true);
    }
  });

  test('ночью фары заметно освещают свою полосу перед машиной, разметка не выгорает в белое', async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 500 });
    await openDrift(page);
    await startWorld(page, 'mountains');
    const r = await page.evaluate(() => {
      const w = __drift.world, M = w.M, W = __drift.worldRender, ren = __drift.renderer, gl = ren.getContext();
      for (const a of w.rivals.slice()) w.removeAi(a); w.trafficOn = false; for (const a of w.traffic.slice()) w.removeAi(a);
      // прямой участок шоссе
      const e = M.edges.find((x) => x.type === 'highway'); let i = e.i0 + 200; for (let k = e.i0 + 100; k < e.i1 - 100; k += 10) if (M.K[k] < 0.002 && !M.FL[k]) { i = k; break; }
      w.placeAt(M.X[i], M.Z[i], Math.atan2(M.TX[i], M.TZ[i])); w.save.autoTime = false; w.save.weather = 'clear';
      for (let k = 0; k < 40; k++) W.stream(true);
      // точки на своей полосе (мимо осевой разметки) на 20-30 м впереди, дальний участок за пределом фар (70 м) и обочина - все в кадре
      const cam = __drift.render.camera, cw = gl.drawingBufferWidth, ch = gl.drawingBufferHeight;
      const lum = (x, z) => { const v = new THREE.Vector3(x, M.groundAt(x, z).y + 0.05, z).project(cam); const X = Math.round((v.x + 1) / 2 * cw), Y = Math.round((v.y + 1) / 2 * ch); if (X < 0 || X >= cw || Y < 0 || Y >= ch || v.z > 1) return null; const b = new Uint8Array(4); gl.readPixels(X, Y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, b); return (b[0] * 0.2126 + b[1] * 0.7152 + b[2] * 0.0722) / 255; };
      const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length;
      const measure = (tod) => {
        w.save.tod = tod; __drift.stepWorld(2); W.cam.init = false; for (let k = 0; k < 8; k++) W.frame(1 / 60, 1, 'chase');
        const p = w.player, fx = Math.sin(p.h), fz = Math.cos(p.h), hw = M.edges[M.E[i]].hw;
        const at = (d, lat) => lum(p.x + fx * d + (-fz) * lat, p.z + fz * d + fx * lat);
        W.frame(1 / 60, 1, 'chase');
        const lit = [], far = [], side = [], edge = [], edgeFar = [];
        for (const d of [20, 24, 28]) for (const lat of [-2.5, 2.5]) lit.push(at(d, lat));
        for (const lat of [-2.5, 2.5]) far.push(at(70, lat));
        for (const d of [20, 24, 28]) side.push(at(d, hw + 5), at(d, -hw - 5));
        // настоящий свет прожектора ложится и на обочину у кромки, не только на полосу под конусом
        for (const d of [20, 24, 28]) edge.push(at(d, hw + 3), at(d, -hw - 3));
        edgeFar.push(at(70, hw + 3), at(70, -hw - 3));
        // осевая разметка под конусом: светлее асфальта, но не выгорает в белое пятно
        const dash = []; for (let d = 12; d <= 34; d += 0.5) dash.push(at(d, 0));
        const all = lit.concat(far, side, edge, edgeFar, dash);
        return { visible: all.every((v) => v !== null), road: avg(lit), far: avg(far), side: avg(side), edge: avg(edge), edgeFar: avg(edgeFar), dashMax: Math.max(...dash), dashWhite: dash.filter((v) => v > 0.97).length };
      };
      const night = measure(23.5), day = measure(13);
      return { night, day };
    });
    expect(r.night.visible && r.day.visible).toBe(true);           // все точки замера в кадре
    expect(r.night.road).toBeGreaterThan(0.12);                    // полоса в свете фар хорошо видна
    expect(r.night.road).toBeGreaterThan(r.night.far * 2.5);       // и заметно ярче той же дороги дальше, куда фары не достают
    expect(r.night.road).toBeGreaterThan(r.night.side * 1.5);      // и ярче обочины рядом
    expect(r.day.road).toBeGreaterThan(r.night.far);               // днём дорога светлее ночной
    expect(r.night.edge).toBeGreaterThan(r.night.edgeFar * 1.3);   // кромка в свете фар светлее кромки вдали
    expect(r.night.dashMax).toBeGreaterThan(r.night.road * 1.5);   // разметка в свете фар видна на асфальте
    expect(r.night.dashWhite).toBe(0);                             // и не выгорает в белое
  });

  test('зона дрифта считается только по ходу зоны; призовые за дуэль с бродячим соперником раз в игровые сутки', async ({ page }) => {
    await openDrift(page);
    await page.evaluate(() => { const c = __drift.career; c.d.owned.push('vihr'); c.d.current = 'vihr'; c.save(c.d); });
    await startWorld(page, 'coast');
    const r = await page.evaluate(() => {
      const w = __drift.world, M = w.M, p = w.player, zone = M.points.find((q) => q.type === 'drift');
      const run = (dir) => {
        const i = dir > 0 ? zone.i0 + 5 : zone.i1 - 5, h = Math.atan2(M.TX[i] * dir, M.TZ[i] * dir);
        p.x = M.X[i]; p.z = M.Z[i]; p.h = h; p.y = M.Y[i]; p.vx = Math.sin(h) * 22; p.vz = Math.cos(h) * 22; p.air = false; p.w = 0;
        p.assist.tc = false; p.assist.steer = false; w.zone = null; const ev = [];
        for (let k = 0; k < 190; k++) { __drift.stepWorld(1, k < 40 ? { thr: 1, steer: 1, hb: 1 } : { thr: 1, steer: 0.4 }); }
        w.placeAtPoint('fest'); __drift.stepWorld(2);
        return w.save.rec.drift[zone.id] || 0;
      };
      const back = run(-1), fwd = run(1);
      return { back, fwd };
    });
    expect(r.back).toBe(0);
    expect(r.fwd).toBeGreaterThan(0);
    // дуэль: победа в тот же игровой день второй раз денег не даёт
    const money = [];
    for (let k = 0; k < 2; k++) {
      await page.evaluate(() => { const w = __drift.world, a = w.rivals[0]; a.cool = 0; w.player.x = a.car.x + 10; w.player.z = a.car.z + 10; __drift.stepWorld(2); __drift.manual = false; });
      await page.waitForFunction(() => __drift.world.nearRival);
      const m0 = await page.evaluate(() => __drift.career.money);
      await page.keyboard.press('KeyE');
      await page.waitForFunction(() => __drift.screen === 'race' && __drift.race);
      await page.evaluate(() => { __drift.manual = true; const r = __drift.race; r.cars.find((c) => !c.isPlayer).ai.pace = 0.3; r.setAutopilot(r.player, 1); for (let i = 0; i < 400 * 120 && r.phase !== 'done'; i++) __drift.step(1); __drift.showResults(); });
      money.push((await page.evaluate(() => __drift.career.money)) - m0);
      await page.locator('#resNext').click();
      await page.waitForFunction(() => __drift.screen === 'world');
      await page.evaluate(() => { __drift.manual = true; });
    }
    expect(money[0]).toBe(1500);
    expect(money[1]).toBe(0);
    // на следующие игровые сутки - снова можно
    expect(await page.evaluate(() => { const w = __drift.world; w.save.autoTime = true; w.save.tod = 23.9995; __drift.stepWorld(10); return w.save.day; })).toBe(1);
  });

  test('фестиваль: экран развёрнут к дороге, надписи влезают, деревья и дома не стоят на площадке; покрытие по точкам, вода у набережной', async ({ page }) => {
    await openDrift(page);
    const r = await page.evaluate(async () => {
      const WD = __drift.worldData, out = {};
      await __drift.startWorld('coast', { fest: true });
      const W = __drift.worldRender, M = __drift.world.M, f = M.pointById('fest');
      const n = new THREE.Vector3(0, 0, 1).applyQuaternion(W.festScreen.getWorldQuaternion(new THREE.Quaternion()));
      const toRoad = new THREE.Vector3(M.X[f.i] - f.x, 0, M.Z[f.i] - f.z).normalize();
      out.face = n.x * toRoad.x + n.z * toRoad.z;
      out.labels = M.points.filter((p) => p.type === 'event').map((p) => W.labelFits('СОБЫТИЯ · ' + p.name.toUpperCase())).every(Boolean) && W.labelFits('HORIZON DRIFT · ФЕСТИВАЛЬ', true);
      for (const def of WD.MAPS) {
        const Mm = WD.buildMap(def.id), fp = Mm.pointById('fest');
        let near = 0; const [cx, cz] = Mm.chunkOf(fp.x, fp.z);
        for (let ox = -1; ox <= 1; ox++) for (let oz = -1; oz <= 1; oz++) for (const d of Mm.chunkDecor(cx + ox, cz + oz)) if (Math.hypot(d.x - fp.x, d.z - fp.z) < 55) near++;
        let snowWrong = 0, total = 0;
        for (let i = 0; i < Mm.N; i += 5) { total++; if (Mm.SF[i] === 'snow' && Mm.regionAt(Mm.X[i], Mm.Z[i]).biome !== 'snow') snowWrong++; }
        out[def.id] = { near, snowWrong: snowWrong / total };
      }
      const Mt = WD.buildMap('metro'), docks = Mt.R.find((rg) => rg.id === 'docks');
      let water = false; for (let a = 0; a < 36; a++) for (let d = 100; d <= 700; d += 100) if (Mt.rawHeight(docks.x + Math.cos(a / 36 * 6.283) * d, docks.z + Math.sin(a / 36 * 6.283) * d) < WD.WATER - 1) water = true;
      out.docksWater = water;
      const Mo = WD.buildMap('mountains'), lake = Mo.R.find((rg) => rg.id === 'lake'), lk = Mo.lakes[0];
      out.lakeDist = Math.hypot(lake.x - lk.x, lake.z - lk.z) - lk.r;
      return out;
    });
    expect(r.face).toBeGreaterThan(0.7);
    expect(r.labels).toBe(true);
    for (const id of ['coast', 'mountains', 'desert', 'metro']) { expect(r[id].near, id).toBe(0); expect(r[id].snowWrong, id).toBeLessThan(0.03); }
    expect(r.docksWater).toBe(true);
    expect(r.lakeDist).toBeLessThan(300);
  });
});
