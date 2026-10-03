// Помощники проверок «Horizon Drift»: открыть игру без сети с ?seed=, дождаться window.__drift,
// поставить низкую графику (чтобы трассы грузились быстро), запустить заезд без рисования шагов.
const { pageUrl } = require('./helpers');

// Захват мыши в проверках - только поддельный: настоящий requestPointerLock у безголового Chromium на Windows
// зажимает курсор пользователя в скрытом окне 0,0. Заглушка ставится до любых скриптов страницы:
// запоминает вызов, подделывает document.pointerLockElement и событие pointerlockchange; настоящий - не достать.
const FAKE_POINTER_LOCK = () => {
  let lockEl = null;
  const fire = () => document.dispatchEvent(new Event('pointerlockchange'));
  const fake = function () { window.__fakeLock = (window.__fakeLock || 0) + 1; lockEl = this; fire(); return Promise.resolve(); };
  for (const P of [Element.prototype, HTMLElement.prototype, HTMLCanvasElement.prototype]) Object.defineProperty(P, 'requestPointerLock', { configurable: false, writable: false, value: fake });
  Object.defineProperty(Document.prototype, 'exitPointerLock', { configurable: false, writable: false, value: function () { lockEl = null; fire(); } });
  Object.defineProperty(Document.prototype, 'pointerLockElement', { configurable: false, get() { return lockEl; } });
  window.__nativePointerLock = () => { throw new Error('настоящий requestPointerLock в проверке запрещён'); };
};
async function stubPointerLock(page) { await page.addInitScript(FAKE_POINTER_LOCK); }

async function openDrift(page, opts = {}) {
  const errors = [];
  await stubPointerLock(page);
  page.on('pageerror', (e) => errors.push(String((e && e.stack) || e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.route(/^https?:\/\//, (route) => route.abort());
  if (opts.clear !== false) {
    await page.addInitScript(() => {
      if (!sessionStorage.getItem('drift-test-cleared')) { localStorage.clear(); sessionStorage.setItem('drift-test-cleared', '1'); }
    });
  }
  await page.goto(pageUrl('horizon_drift_offline') + '?seed=' + (opts.seed || 1));
  await page.waitForFunction(() => window.__drift && window.__drift.ready === true);
  if (opts.low !== false) await page.evaluate(() => { __drift.setSetting('quality', 'low'); });
  return errors;
}

// Быстрая гонка без хода времени от кадров: шаги физики делает сама проверка через __drift.step.
async function startQuick(page, o) {
  return page.evaluate(async (o) => {
    __drift.manual = true;
    const r = await __drift.startQuick(o);
    return { track: r.track.id, cars: r.cars.length, phase: r.phase };
  }, o);
}

// Щуп для законов о твёрдости: лучи по нарисованной сцене (не по списку предметов мира - чтобы ловить и то, чего в списке нет).
// __probe.body(car) - что из нарисованного попало внутрь кузова (лучи сверху вниз и вдоль/поперёк на высоте кузова);
// __probe.camInside() - камера внутри замкнутого меша (из 6 лучей не меньше 4 упираются в изнанку);
// __probe.mono() - доля самого частого цвета кадра.
async function installProbe(page) {
  await page.evaluate(() => {
    const P = window.__probe = {}, THREE = window.THREE, rc = new THREE.Raycaster(), o = new THREE.Vector3(), d = new THREE.Vector3(), nm = new THREE.Matrix3();
    P.name = (m) => {
      const W = __drift.worldRender; let n = m.userData.solid ? 'твёрдое:' + m.userData.solid : m.userData.ghost ? 'призрак:' + m.userData.ghost : '';
      for (const k in W.geo) if (W.geo[k] === m.geometry) n += ' geo.' + k;
      if (!n) n = m.geometry.type + (m.material.color ? '#' + m.material.color.getHexString() : '');
      return n.trim();
    };
    // всё нарисованное, кроме машин, неба, воды, дальнего рельефа, света и частиц
    P.targets = () => {
      const W = __drift.worldRender, out = [], skip = new Set([W.sky, W.water, W.far, W.beam, W.rain]);
      W.scene.traverse((m) => {
        if (!(m.isMesh || m.isInstancedMesh) || !m.visible || skip.has(m) || m.userData.car || (W.poolMeshes && W.poolMeshes.has(m))) return;
        let a = m, vis = true; while (a) { if (!a.visible) vis = false; a = a.parent; } if (!vis) return;
        const mt = m.material; if (!mt || Array.isArray(mt)) return;
        if (mt.blending === THREE.AdditiveBlending || mt.blending === THREE.CustomBlending || (mt.transparent && mt.opacity < 0.5)) return;
        let car = false; for (const [, cm] of W.carMeshes) { let b = m; while (b) { if (b === cm.root) car = true; b = b.parent; } } if (car) return;
        out.push(m);
      });
      return out;
    };
    P.double = (fn) => { const W = __drift.worldRender, mats = new Map(); W.scene.traverse((m) => { if (m.material && !Array.isArray(m.material) && !mats.has(m.material)) { mats.set(m.material, m.material.side); m.material.side = THREE.DoubleSide; } }); try { return fn(); } finally { for (const [m, s] of mats) m.side = s; } };
    const cast = (ax, ay, az, bx, by, bz, objs) => { o.set(ax, ay, az); d.set(bx - ax, by - ay, bz - az); const len = d.length(); d.normalize(); rc.set(o, d); rc.near = 0; rc.far = len; return rc.intersectObjects(objs, false); };
    P.settle = () => { const W = __drift.worldRender; for (let k = 0; k < 90 && (W.info().pending > 0 || k < 3); k++) W.stream(true); W.scene.updateMatrixWorld(true); };
    P.body = (car, objs) => {
      const W = __drift.worldRender, cm = W.carMeshes.get(car); cm.root.updateMatrixWorld(true);
      const mw = cm.root.matrixWorld, L = car.st.len, Wd = car.st.wid, A = new THREE.Vector3(), B = new THREE.Vector3(), hits = [];
      const seg = (a, b, kind) => { A.set(...a).applyMatrix4(mw); B.set(...b).applyMatrix4(mw); for (const h of cast(A.x, A.y, A.z, B.x, B.y, B.z, objs)) hits.push({ kind, obj: P.name(h.object), x: +h.point.x.toFixed(1), y: +h.point.y.toFixed(2), z: +h.point.z.toFixed(1) }); };
      for (const a of [-0.42, 0, 0.42]) for (const sx of [-0.4, 0, 0.4]) seg([sx * Wd, 1.3, a * L], [sx * Wd, 0.16, a * L], 'сверху');
      for (const hy of [0.45, 1.0]) {
        for (const sx of [-0.45, 0, 0.45]) seg([sx * Wd, hy, -L / 2], [sx * Wd, hy, L / 2], 'вдоль');
        for (const a of [-0.45, 0, 0.45]) seg([-Wd / 2, hy, a * L], [Wd / 2, hy, a * L], 'поперёк');
      }
      return hits;
    };
    P.camInside = (objs) => {
      const c = __drift.render.camera.position; let back = 0; const who = [];
      for (const v of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        const h = cast(c.x, c.y, c.z, c.x + v[0] * 60, c.y + v[1] * 60, c.z + v[2] * 60, objs)[0];
        if (!h || !h.face) continue;
        const mw = h.object.matrixWorld.clone(); if (h.instanceId !== undefined) { const im = new THREE.Matrix4(); h.object.getMatrixAt(h.instanceId, im); mw.multiply(im); }
        nm.getNormalMatrix(mw); const n = h.face.normal.clone().applyMatrix3(nm).normalize();
        if (n.x * v[0] + n.y * v[1] + n.z * v[2] > 0.05) { back++; who.push(P.name(h.object)); }
      }
      return back >= 4 ? who : null;
    };
    P.mono = () => {
      const gl = __drift.renderer.getContext(), w = gl.drawingBufferWidth, h = gl.drawingBufferHeight, buf = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      const cnt = new Map(); let n = 0;
      for (let y = 0; y < h; y += 4) for (let x = 0; x < w; x += 4) { const k = (y * w + x) * 4, q = (buf[k] >> 5) * 64 + (buf[k + 1] >> 5) * 8 + (buf[k + 2] >> 5); cnt.set(q, (cnt.get(q) || 0) + 1); n++; }
      return Math.max(...cnt.values()) / n;
    };
    // проверка на месте: кузов, камера, однотонность кадра
    P.check = (label, mode) => {
      const W = __drift.worldRender, w = __drift.world; P.settle();
      W.cam.init = false; for (let k = 0; k < 6; k++) W.frame(1 / 60, 1, mode || 'chase');
      const objs = P.targets();
      return P.double(() => {
        const body = P.body(w.player, objs), inside = P.camInside(objs);
        W.frame(0, 1, mode || 'chase'); const mono = P.mono();
        return { label, x: Math.round(w.player.x), z: Math.round(w.player.z), body, inside, mono: +mono.toFixed(2) };
      });
    };
  });
}

module.exports = { openDrift, startQuick, installProbe, stubPointerLock, FAKE_POINTER_LOCK };
