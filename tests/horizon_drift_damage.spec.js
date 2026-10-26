// Законы повреждений «Horizon Drift» (js/damage.js): вмятины от ударов сильнее порога, отлетающие детали,
// обломки, износ шин и его влияние на сцепление, «полные» повреждения в управлении, ремонт, настройка в меню.
// Главный закон - «выкл» и «только вид» не меняют физику ни на бит: хэш трёх заездов совпадает с записью,
// сделанной до кода повреждений (tests/web/fixtures/horizon_drift_law.json, см. _drift-law.js).
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { openDrift, startQuick } = require('./_drift-helpers');
const { lawRun } = require('./_drift-law');

const FIXTURE = path.join(__dirname, 'horizon_drift_law.json');

test.describe('horizon_drift_offline: повреждения', () => {
  test.describe.configure({ timeout: 180_000 });

  test('закон: повреждения «выкл» и «только вид» - физика бит в бит как до повреждений; «полные» - меняют', async ({ page }) => {
    await openDrift(page);
    const before = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
    const want = [before.race.hash, before.drift.hash, before.world.hash];
    const got = {};
    for (const mode of [null, 'off', 'visual', 'full']) {
      const r = await page.evaluate(lawRun, mode);
      got[mode] = [r.race.hash, r.drift.hash, r.world.hash];
      if (mode === 'visual') got.visualHits = r.race.hits;
    }
    expect(got.null).toEqual(want);
    expect(got.off).toEqual(want);
    expect(got.visual).toEqual(want);
    // в гонке и в мире были удары: «только вид» их видел, но на движение не повлиял
    expect(got.visualHits.some((n) => n > 0)).toBe(true);
    expect(got.full[0]).not.toBe(want[0]);
    expect(got.full[2]).not.toBe(want[2]);
  });

  test('удар: слабее порога - ни вмятины, ни повреждения; сильнее - зона по направлению удара, вмятина в точке удара', async ({ page }) => {
    await openDrift(page);
    const r = await page.evaluate(() => {
      const C = __drift.core, DM = window.DriftDamage;
      const car = C.makeCar(C.carStats('kobalt')); car.h = 0; car.x = 0; car.z = 0;
      const d = DM.attach(car, 'visual'), m = car.st.mass, hl = car.st.len / 2, hw = car.st.wid / 2;
      // нос в стену (нормаль от стены в машину смотрит назад), импульс на 2 м/с - касание
      d.hit(car, 0, hl, 0, -1, 2 * m);
      const tap = { zone: Object.assign({}, d.zone), dents: d.dentN, hits: d.hits };
      d.hit(car, 0, hl, 0, -1, 8 * m);
      const front = { zone: Object.assign({}, d.zone), dents: d.dentN, dent: Object.assign({}, d.dents[0]) };
      // удар в правый бок: машина справа толкает влево (r = (-cos h, sin h) = (-1, 0) при h = 0)
      d.hit(car, -hw, 0, 1, 0, 7 * m);
      const right = Object.assign({}, d.zone);
      d.hit(car, 0, -hl, 0, 1, 6 * m);
      return { tap, front, right, rear: d.zone.rear, T: DM.T };
    });
    expect(r.tap.hits).toBe(0);
    expect(r.tap.dents).toBe(0);
    expect(r.tap.zone).toEqual({ front: 0, rear: 0, left: 0, right: 0 });
    expect(r.front.dents).toBe(1);
    expect(r.front.zone.front).toBeCloseTo((8 - r.T.DEFORM_DV) * r.T.ZONE_K, 6);
    expect(r.front.zone.rear + r.front.zone.left + r.front.zone.right).toBe(0);
    // вмятина: точка - нос (z = +полдлины), давит назад (dz < 0), глубже нуля, не глубже предела
    expect(r.front.dent.z).toBeGreaterThan(2);
    expect(r.front.dent.dz).toBe(-1);
    expect(r.front.dent.depth).toBeGreaterThan(0.1);
    expect(r.front.dent.depth).toBeLessThanOrEqual(r.T.DENT_MAX);
    expect(r.right.right).toBeGreaterThan(0);
    expect(r.right.left).toBe(0);
    expect(r.rear).toBeGreaterThan(0);
  });

  test('вмятина в меше: вершины у точки удара сдвинуты внутрь, дальние - на месте, сдвиг ограничен; повтор - не глубже предела', async ({ page }) => {
    await openDrift(page);
    const r = await page.evaluate(() => {
      const DM = window.DriftDamage;
      // сетка вершин на «носу»: плоскость z = 2 от x -1..1, y 0..1, плюс дальний борт z = -2
      const pts = [];
      for (let x = -1; x <= 1.001; x += 0.1) for (let y = 0; y <= 1.001; y += 0.1) pts.push(x, y, 2);
      for (let x = -1; x <= 1.001; x += 0.5) pts.push(x, 0.5, -2);
      const rest = new Float32Array(pts), pos = new Float32Array(pts);
      const dent = { x: 0, y: 0.55, z: 2, dx: 0, dz: -1, depth: 0.2, r: 0.7 };
      const moved = DM.applyDent(pos, rest, dent);
      let near = 0, far = 0, maxOff = 0, outward = 0;
      for (let i = 0; i < pos.length; i += 3) {
        const off = Math.hypot(pos[i] - rest[i], pos[i + 1] - rest[i + 1], pos[i + 2] - rest[i + 2]);
        const d = Math.hypot(rest[i] - dent.x, (rest[i + 1] - dent.y) * 0.5, rest[i + 2] - dent.z);
        if (d < 0.2) near = Math.max(near, off);
        if (d >= dent.r) far = Math.max(far, off);
        if (pos[i + 2] > rest[i + 2] + 1e-6) outward++;
        maxOff = Math.max(maxOff, off);
      }
      // удар в борт (x = 1, давит в -x): вершины борта уходят внутрь, а не наружу
      const side = [];
      for (let z = -1; z <= 1.001; z += 0.1) for (let y = 0; y <= 1.001; y += 0.1) side.push(1, y, z);
      const sr = new Float32Array(side), sp = new Float32Array(side);
      DM.applyDent(sp, sr, { x: 1, y: 0.55, z: 0, dx: -1, dz: 0, depth: 0.2, r: 0.7 });
      let inward = 0, outSide = 0; for (let i = 0; i < sp.length; i += 3) { if (sp[i] < sr[i] - 0.05) inward++; if (sp[i] > sr[i] + 1e-6) outSide++; }
      // десять одинаковых ударов подряд: вершина не уходит дальше общего предела
      for (let k = 0; k < 10; k++) DM.applyDent(pos, rest, dent);
      let total = 0; for (let i = 0; i < pos.length; i += 3) total = Math.max(total, Math.hypot(pos[i] - rest[i], pos[i + 1] - rest[i + 1], pos[i + 2] - rest[i + 2]));
      return { moved, n: pos.length / 3, near, far, maxOff, outward, total, lim: DM.T.DENT_TOTAL, inward, outSide };
    });
    expect(r.moved).toBeGreaterThan(5);
    expect(r.moved).toBeLessThan(r.n);
    expect(r.near).toBeGreaterThan(0.12);
    expect(r.far).toBe(0);
    expect(r.outward).toBe(0);
    expect(r.maxOff).toBeLessThan(0.3);
    expect(r.total).toBeLessThanOrEqual(r.lim + 1e-6);
    expect(r.inward).toBeGreaterThan(5);
    expect(r.outSide).toBe(0);
  });

  test('детали: бампер отлетает выше порога удара и от смятого переда, зеркало - от удара в свой бок, капот - от сильного; каждая один раз', async ({ page }) => {
    await openDrift(page);
    const r = await page.evaluate(() => {
      const C = __drift.core, DM = window.DriftDamage, T = DM.T;
      const mk = () => { const c = C.makeCar(C.carStats('sapsan')); c.vz = 20; return c; };
      const hl = (c) => c.st.len / 2, hw = (c) => c.st.wid / 2;
      const a = mk(), da = DM.attach(a, 'visual'), m = a.st.mass;
      da.hit(a, 0, hl(a), 0, -1, (T.BUMPER_DV - 0.5) * m);
      const under = Object.assign({}, da.off);
      const b = mk(), db = DM.attach(b, 'visual');
      db.hit(b, 0, hl(b), 0, -1, (T.BUMPER_DV + 0.5) * m);
      const over = Object.assign({}, db.off), ev = Object.assign({}, db.detach[0]), n1 = db.detachN;
      db.hit(b, 0, hl(b), 0, -1, (T.BUMPER_DV + 0.5) * m);        // второй раз бампер уже не отлетает
      const n2 = db.detachN;
      // много средних ударов в перед: зона копится, бампер и капот отрываются от смятости
      const c = mk(), dc = DM.attach(c, 'visual');
      for (let k = 0; k < 8; k++) dc.hit(c, 0, hl(c), 0, -1, 7 * m);
      const worn = Object.assign({}, dc.off), zf = dc.zone.front;
      // зеркало: удар в левый бок у передней двери
      const e = mk(), de = DM.attach(e, 'visual');
      de.hit(e, hw(e), 0.5, -1, 0, (T.MIRROR_DV + 1) * m);
      const mirror = Object.assign({}, de.off);
      // капот - от одного сильного удара
      const f = mk(), df = DM.attach(f, 'visual');
      df.hit(f, 0, hl(f), 0, -1, (T.HOOD_DV + 1) * m);
      return { under, over, ev, n1, n2, worn, zf, mirror, hood: Object.assign({}, df.off) };
    });
    expect(r.under.bumperF).toBe(false);
    expect(r.over.bumperF).toBe(true);
    expect(r.over.hood).toBe(false);
    expect(r.ev.part).toBe('bumperF');
    expect(r.ev.vy).toBeGreaterThan(1);
    expect(r.n2).toBe(r.n1);
    expect(r.zf).toBeGreaterThan(0.85);
    expect(r.worn.bumperF && r.worn.hood).toBe(true);
    expect(r.worn.bumperR).toBe(false);
    expect(r.mirror.mirrorL).toBe(true);
    expect(r.mirror.mirrorR).toBe(false);
    expect(r.hood.hood && r.hood.bumperF).toBe(true);
  });

  test('обломки: падают на землю и лежат, через life секунд исчезают, больше max их не бывает (новый вытесняет старый)', async ({ page }) => {
    await openDrift(page);
    const r = await page.evaluate(() => {
      const DM = window.DriftDamage, B = new DM.Debris(4, 5), ground = () => 0;
      B.spawn(0, 1.5, 0, 3, 2, 0, 'bumperF', 0);
      for (let i = 0; i < 180; i++) B.update(1 / 60, ground, []);
      const lie = Object.assign({}, B.list[0]);
      for (let k = 0; k < 6; k++) B.spawn(k, 1, 0, 0, 0, 0, 'mirrorL', 0);
      const count = B.n, oldestGone = B.list.every((d) => d.seq !== 1);
      // машина наезжает - обломок отлетает
      const s = B.list.findIndex((d) => d.on);
      for (let i = 0; i < 60; i++) B.update(1 / 60, ground, []);
      const car = { x: B.list[s].x - 1, z: B.list[s].z, vx: 20, vz: 0, speed: 20 };
      B.update(1 / 60, ground, [car]);
      const kicked = B.list[s].vx;
      for (let i = 0; i < 6 * 60; i++) B.update(1 / 60, ground, []);
      return { lie, count, oldestGone, kicked, after: B.n, anyOn: B.list.some((d) => d.on) };
    });
    expect(r.lie.rest).toBe(true);
    expect(r.lie.y).toBeCloseTo(0.05, 3);
    expect(r.lie.x).toBeGreaterThan(0.3);
    expect(r.count).toBe(4);
    expect(r.oldestGone).toBe(true);
    expect(r.kicked).toBeGreaterThan(10);
    expect(r.after).toBe(0);
    expect(r.anyOn).toBe(false);
  });

  test('шины: стираются от юза, заноса и пробуксовки, обычная езда почти не стирает; стёртые держат хуже (не меньше 70%)', async ({ page }) => {
    await openDrift(page);
    const r = await page.evaluate(() => {
      const C = __drift.core, DM = window.DriftDamage, DT = C.DT;
      const race = (car, o) => { const r = new C.Race({ track: 'coast', mode: 'race', laps: 3, skipCountdown: true, seed: 1, entries: [{ name: 'Вы', car, isPlayer: true }] }); r.cars.forEach((c) => DM.attach(c, o || 'full')); return r; };
      // ровный разгон прямо 4 с
      const a = race('kobalt'); for (let i = 0; i < 4 / DT; i++) a.step(DT, { thr: 0.6 });
      const cruise = a.player.dmg.wear.slice();
      // юз без АБС: заблокированные передние
      const b = race('kobalt'); b.player.assist.abs = false; b.teleport(b.player, 300, 0, 30);
      for (let i = 0; i < 1.5 / DT; i++) b.step(DT, { brk: 1 });
      const lock = b.player.dmg.wear.slice();
      // с АБС тот же тормоз стирает меньше
      const b2 = race('kobalt'); b2.teleport(b2.player, 300, 0, 30);
      for (let i = 0; i < 1.5 / DT; i++) b2.step(DT, { brk: 1 });
      const abs = b2.player.dmg.wear.slice();
      // занос ручником с газом у заднеприводной без антипробуксовки
      const c = race('vihr'); c.player.assist.tc = false; c.teleport(c.player, 200, 0, 22);
      for (let i = 0; i < 2 / DT; i++) c.step(DT, { thr: 1, steer: i < 60 ? 1 : 0.4, hb: i < 30 ? 1 : 0 });
      const drift = c.player.dmg.wear.slice();
      // чистое скольжение боком без газа (без пробуксовки): стираются задние
      const sl = race('vihr'); sl.teleport(sl.player, 200, 0, 0);
      { const p = sl.player, a = p.h + 0.5; p.vx = Math.sin(a) * 20; p.vz = Math.cos(a) * 20; }
      let spin = 0; for (let i = 0; i < 0.8 / DT; i++) { sl.step(DT, { hb: 1 }); spin = Math.max(spin, sl.player.spin); }
      const slide = sl.player.dmg.wear.slice();
      // «только вид» - шины не стираются
      const v = race('vihr', 'visual'); v.player.assist.tc = false; v.teleport(v.player, 200, 0, 22);
      for (let i = 0; i < 2 / DT; i++) v.step(DT, { thr: 1, steer: i < 60 ? 1 : 0.4, hb: i < 30 ? 1 : 0 });
      const vis = v.player.dmg.wear.slice();
      const gr = [0, 0.5, 1].map((w) => DM.gripOf(w));
      return { cruise, lock, abs, drift, vis, gr, fx: c.player.dmgFx.gripR, slide, spin };
    });
    const sum = (a) => a.reduce((s, x) => s + x, 0);
    expect(sum(r.cruise)).toBeLessThan(0.002);
    // юз стирает передние сильнее, чем просто скольжение (WEAR_LOCK поверх WEAR_SLIP)
    expect(r.lock[0] + r.lock[1]).toBeGreaterThan(0.08);
    expect(r.lock[0] + r.lock[1]).toBeGreaterThan(5 * (r.abs[0] + r.abs[1]));
    expect(r.drift[2] + r.drift[3]).toBeGreaterThan(0.02);
    expect(r.drift[2] + r.drift[3]).toBeGreaterThan(r.drift[0] + r.drift[1]);
    expect(sum(r.vis)).toBe(0);
    expect(r.spin).toBe(0);
    expect(r.slide[2] + r.slide[3]).toBeGreaterThan(0.005);
    expect(r.gr[0]).toBe(1);
    expect(r.gr[1]).toBeLessThan(1);
    expect(r.gr[1]).toBeGreaterThan(r.gr[2]);
    expect(r.gr[2]).toBeCloseTo(0.7, 6);
    expect(r.fx).toBeLessThan(1);
  });

  test('стёртые шины в физике: тормозной путь длиннее, в повороте машину сносит сильнее', async ({ page }) => {
    await openDrift(page);
    const r = await page.evaluate(() => {
      const C = __drift.core, DM = window.DriftDamage, DT = C.DT;
      const run = (wear) => {
        const car = C.makeCar(C.carStats('kobalt')); const d = DM.attach(car, 'full');
        for (let i = 0; i < 4; i++) d.wear[i] = wear; d.update();
        car.vz = 30; let s = 0;
        for (let i = 0; i < 6 / DT; i++) { car.inp.brk = 1; C.stepCar(car, DT, 'asphalt'); s += car.speed * DT; if (car.speed < 0.3) break; }
        const t = C.makeCar(C.carStats('kobalt')); const dt2 = DM.attach(t, 'full'); for (let i = 0; i < 4; i++) dt2.wear[i] = wear; dt2.update();
        t.vz = 24; t.inp.thr = 0.5; t.inp.steer = 1;
        let beta = 0; for (let i = 0; i < 2 / DT; i++) { C.stepCar(t, DT, 'asphalt'); beta = Math.max(beta, Math.abs(t.beta)); }
        return { stop: s, beta };
      };
      // стёрты только передние: в повороте машина недоворачивает (курс меняется медленнее)
      const turn = (wf) => {
        const t = C.makeCar(C.carStats('kobalt')); const d = DM.attach(t, 'full'); d.wear[0] = d.wear[1] = wf; d.update();
        t.vz = 22; t.inp.thr = 0.4; t.inp.steer = 1; for (let i = 0; i < 1.5 / DT; i++) C.stepCar(t, DT, 'asphalt'); return Math.abs(t.h);
      };
      return { fresh: run(0), worn: run(1), turnFresh: turn(0), turnWornFront: turn(1) };
    });
    expect(r.worn.stop).toBeGreaterThan(r.fresh.stop * 1.2);
    expect(r.worn.beta).toBeGreaterThan(r.fresh.beta);
    expect(r.turnWornFront).toBeLessThan(r.turnFresh * 0.97);
  });

  test('«полные»: смятый перед отнимает мощность, удар в переднее колесо уводит руль в сторону удара; «только вид» - нет', async ({ page }) => {
    await openDrift(page);
    const r = await page.evaluate(() => {
      const C = __drift.core, DM = window.DriftDamage, DT = C.DT;
      const accel = (mode, front) => {
        const c = C.makeCar(C.carStats('sapsan')); const d = DM.attach(c, mode);
        if (d) { d.zone.front = front; d.update(); }
        c.inp.thr = 1; for (let i = 0; i < 5 / DT; i++) C.stepCar(c, DT, 'asphalt'); return c.speed;
      };
      const drift = (mode, side) => {
        const c = C.makeCar(C.carStats('kobalt')); const d = DM.attach(c, mode); c.vz = 25; c.h = 0;
        // удар в правый передний угол: точка справа впереди, нормаль - назад
        d.hit(c, -c.st.wid / 2 * side, c.st.len / 2, 0, -1, 12 * c.st.mass);
        c.vz = 25; c.vx = 0; c.w = 0;
        for (let i = 0; i < 3 / DT; i++) { c.inp.thr = 0.4; c.inp.steer = 0; C.stepCar(c, DT, 'asphalt'); }
        // сдвиг вправо: r = (-cos h, sin h)
        return { lat: -c.x, pull: d.fx.pull, align: d.align };
      };
      return { v0: accel('full', 0), vWreck: accel('full', 1), vVis: accel('visual', 1), right: drift('full', 1), left: drift('full', -1), vis: drift('visual', 1) };
    });
    expect(r.vWreck).toBeLessThan(r.v0 * 0.9);
    expect(r.vVis).toBe(r.v0);
    expect(r.right.pull).toBeGreaterThan(0);
    expect(r.right.lat).toBeGreaterThan(1);
    expect(r.left.pull).toBeLessThan(0);
    expect(r.left.lat).toBeLessThan(-1);
    expect(r.vis.pull).toBe(0);
    expect(Math.abs(r.vis.lat)).toBeLessThan(0.01);
  });

  test('честные правила: в карьере и на время «полные» становятся «только вид»; ремонт возвращает всё как было', async ({ page }) => {
    await openDrift(page);
    const r = await page.evaluate(() => {
      const C = __drift.core, DM = window.DriftDamage;
      const modes = [['full', 'career', 'race'], ['full', 'quick', 'time'], ['full', 'quick', 'race'], ['full', 'world', 'free'], ['visual', 'career', 'race'], ['off', 'quick', 'race'], ['junk', 'quick', 'race']].map((a) => DM.modeFor(...a));
      const c = C.makeCar(C.carStats('kobalt')), d = DM.attach(c, 'full');
      d.hit(c, 0, 2.2, 0, -1, 20 * c.st.mass); d.wear[3] = 0.6; d.update();
      const broken = { off: Object.values(d.off).some(Boolean), fx: Object.assign({}, d.fx), zone: d.total() };
      d.repair();
      const off = DM.attach(c, 'off');
      return { modes, broken, fixed: { off: Object.values(d.off).some(Boolean), fx: Object.assign({}, d.fx), zone: d.total(), wear: d.wear.slice(), repairs: d.repairs }, detached: off === null && !c.dmg && !c.dmgFx };
    });
    expect(r.modes).toEqual(['visual', 'visual', 'full', 'full', 'visual', 'off', 'visual']);
    expect(r.broken.off).toBe(true);
    expect(r.broken.fx.power).toBeLessThan(1);
    expect(r.fixed).toEqual({ off: false, fx: { gripF: 1, gripR: 1, power: 1, pull: 0 }, zone: 0, wear: [0, 0, 0, 0], repairs: 1 });
    expect(r.detached).toBe(true);
  });

  test('в игре: удар о стену мнёт меш машины, бампер улетает обломком на дорогу; HUD шин - только при «полных»', async ({ page }) => {
    await openDrift(page);
    await page.evaluate(() => __drift.setSetting('damage', 'visual'));
    await startQuick(page, { track: 'coast', mode: 'race', opp: 0, laps: 1 });
    const r = await page.evaluate(() => {
      const race = __drift.race, p = race.player, R = __drift.render, X = R.race, cm = X.cars[race.cars.indexOf(p)];
      __drift.step(4 * 120, {});                         // отсчёт
      const rest = cm.dentable[0].attributes.position.array.slice();
      // поперёк дороги в стену на 90 км/ч
      race.teleport(p, 400, 0, 0); p.h += Math.PI / 2; p.vx = Math.sin(p.h) * 25; p.vz = Math.cos(p.h) * 25;
      for (let k = 0; k < 60; k++) { __drift.step(1, {}); R.frame(1 / 60, 1, 'chase'); }
      const pos = cm.dentable[0].attributes.position.array;
      let moved = 0, maxOff = 0;
      for (let i = 0; i < pos.length; i += 3) { const o = Math.hypot(pos[i] - rest[i], pos[i + 1] - rest[i + 1], pos[i + 2] - rest[i + 2]); if (o > 1e-4) moved++; maxOff = Math.max(maxOff, o); }
      const deb = X.debris.meshes.filter((m) => m && m.visible).map((m) => ({ part: m.userData.debris, y: m.position.y }));
      for (let k = 0; k < 300; k++) { __drift.step(1, { brk: 1 }); R.frame(1 / 60, 1, 'chase'); }
      const lying = X.debris.sim.list.filter((d) => d.on).map((d) => ({ y: d.y, rest: d.rest, ground: race.track.y[C_idx(race, d)] }));
      function C_idx(race, d) { return __drift.core.project(race.track, d.x, d.z, d.hint, {}, true).i; }
      return { dmg: p.dmg.zone.front, moved, maxOff, deb, lying, hud: getComputedStyle(document.getElementById('hDmg')).display, bumperVisible: cm.parts.bumperF.visible };
    });
    expect(r.dmg).toBeGreaterThan(0.3);
    expect(r.moved).toBeGreaterThan(10);
    expect(r.maxOff).toBeGreaterThan(0.1);
    expect(r.bumperVisible).toBe(false);
    expect(r.deb.some((d) => d.part === 'bumperF')).toBe(true);
    expect(r.lying.length).toBeGreaterThan(0);
    for (const d of r.lying) { expect(d.rest).toBe(true); expect(Math.abs(d.y - d.ground)).toBeLessThan(0.2); }
    expect(r.hud).toBe('none');
    // «полные»: HUD шин виден
    await page.evaluate(() => { __drift.setSetting('damage', 'full'); __drift.manual = true; });
    await startQuick(page, { track: 'coast', mode: 'race', opp: 0, laps: 1 });
    await page.evaluate(() => { __drift.manual = false; });
    await expect(page.locator('#hDmg')).toBeVisible();
    await expect(page.locator('#hDmgTxt')).toHaveText('ШИНЫ 100%');
  });

  test('настройка «Повреждения» в меню: три положения, сохраняется после перезагрузки; в карьере - только вид', async ({ page }) => {
    await openDrift(page);
    await page.evaluate(() => { __drift.show('settings'); });
    await page.locator('#sTabs button[data-tab="game"]').click();
    const seg = page.locator('[data-set="damage"] button');
    await expect(seg).toHaveText(['Выкл', 'Только вид', 'Полные']);
    await expect(page.locator('[data-set="damage"] button.on')).toHaveText('Только вид');
    await seg.nth(2).click();
    await expect(page.locator('[data-set="damage"] button.on')).toHaveText('Полные');
    await page.reload();
    await page.waitForFunction(() => window.__drift && window.__drift.ready === true);
    expect(await page.evaluate(() => __drift.settings.damage)).toBe('full');
    const mode = await page.evaluate(async () => { __drift.manual = true; await __drift.startCareer(__drift.data.CUPS[0].events[0].id); return [__drift.race.damageMode, !!__drift.race.player.dmg, !!__drift.race.player.dmgFx]; });
    expect(mode).toEqual(['visual', true, false]);
  });

  test('свободная езда: «полные» - клавиша ремонта чинит машину, фестиваль тоже; «выкл» - машины без повреждений', async ({ page }) => {
    await openDrift(page);
    await page.evaluate(() => __drift.setSetting('damage', 'full'));
    await page.evaluate(async () => { await __drift.startWorld('coast', { fest: true }); __drift.manual = true; });
    const r = await page.evaluate(() => {
      const w = __drift.world, p = w.player, d = p.dmg;
      d.hit(p, p.x + Math.sin(p.h) * 2.2, p.z + Math.cos(p.h) * 2.2, -Math.sin(p.h), -Math.cos(p.h), 18 * p.st.mass); d.wear[0] = 0.5; d.update();
      __drift.worldRender.frame(1 / 60, 1, 'chase');
      const cm = __drift.worldRender.carMeshes.get(p);
      return { before: d.total(), hood: cm.parts.hood.visible, all: w.cars.every((c) => !!c.dmg) };
    });
    expect(r.before).toBeGreaterThan(0.3);
    expect(r.hood).toBe(false);
    expect(r.all).toBe(true);
    await page.evaluate(() => { __drift.manual = false; });
    await page.keyboard.press('KeyG');
    const after = await page.evaluate(() => {
      const p = __drift.world.player; __drift.worldRender.frame(1 / 60, 1, 'chase');
      const cm = __drift.worldRender.carMeshes.get(p), g = cm.dentable[0], rest = g.userData.rest, pos = g.attributes.position.array;
      let off = 0; for (let i = 0; i < pos.length; i++) off = Math.max(off, Math.abs(pos[i] - rest[i]));
      return { total: p.dmg.total(), wear: p.dmg.wear[0], hood: cm.parts.hood.visible, off };
    });
    expect(after).toEqual({ total: 0, wear: 0, hood: true, off: 0 });
    const off = await page.evaluate(() => { __drift.setSetting('damage', 'off'); return __drift.world.cars.every((c) => !c.dmg && !c.dmgFx); });
    expect(off).toBe(true);
  });

  test('скорость: 6 машин с «полными» повреждениями - шаг физики с запасом укладывается в кадр', async ({ page }) => {
    await openDrift(page);
    const r = await page.evaluate(() => {
      const C = __drift.core, D = __drift.data, DM = window.DriftDamage;
      const entries = C.eventEntries(D.CUPS[4].events[3], 4, { difficulty: 'normal', car: 'mirage', seed: 1 });
      const race = new C.Race({ track: 'port', mode: 'race', laps: 3, skipCountdown: true, seed: 1, entries });
      race.cars.forEach((c) => DM.attach(c, 'full'));
      race.setAutopilot(race.player, 0.9);
      const t0 = performance.now(); for (let i = 0; i < 1200; i++) race.step(C.DT);
      return { ms: (performance.now() - t0) / 600, dents: race.cars.reduce((s, c) => s + c.dmg.dentN, 0), hits: race.cars.reduce((s, c) => s + c.hits, 0) };
    });
    expect(r.ms).toBeLessThan(4);
  });
});
