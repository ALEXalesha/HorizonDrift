/* Horizon Drift - вид из салона: панель с работающими приборами, руль с руками, стойки, рамка стекла,
   зеркала (заднего вида и боковые - маленькая картинка мира раз в несколько кадров), капли на стекле в дождь.
   Салон рисуется отдельной сценой поверх мира (своя камера с близкой плоскостью отсечения), поэтому
   кузов не режет камеру, а предметы мира не входят в салон. Пропорции и цвета - свои у каждого класса. */
(function (root) {
  'use strict';
  const THREE = root.THREE;

  function create(R, D) {
    const CK = {
      scene: new THREE.Scene(), cam: new THREE.PerspectiveCamera(74, 1, 0.02, 8),
      shape: null, group: null, owned: [], state: { active: false, wheelAngle: 0, shown: null, shape: null, yaw: 0, pitch: 0 },
      sway: { x: 0, z: 0, roll: 0, vf: 0, vl: 0, init: false }, frameN: 0,
    };
    const amb = new THREE.AmbientLight(0xffffff, 0.55), sun = new THREE.DirectionalLight(0xffffff, 0.8);
    sun.position.set(0.4, 1, 0.3); CK.scene.add(amb); CK.scene.add(sun);
    const tq = new THREE.Quaternion(), te = new THREE.Euler(0, 0, 0, 'YXZ'), tv = new THREE.Vector3(), tv2 = new THREE.Vector3(), tv3 = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);

    // ---- зеркала: одна маленькая картинка вида назад, у каждого зеркала - своя часть ----
    const mirrorRT = new THREE.WebGLRenderTarget(320, 112);
    const mirrorCam = new THREE.PerspectiveCamera(58, 320 / 112, 0.3, 320);         // в зеркале - ближние 320 м: меньше вызовов рисования
    CK.mirrorRT = mirrorRT;

    // ---- приборы: холст с двумя шкалами, передачей, цифрами скорости и полосой нитро ----
    const gc = document.createElement('canvas'); gc.width = 512; gc.height = 220;
    const gx = gc.getContext('2d'), gtex = new THREE.CanvasTexture(gc);
    if ('colorSpace' in gtex) gtex.colorSpace = THREE.SRGBColorSpace; else gtex.encoding = THREE.sRGBEncoding;
    let lastKey = '';
    function drawGauges(s, accent, night) {
      const kmh = Math.round(s.kmh), rpm = Math.round(s.rpm / 50) * 50, gear = s.gear, nit = Math.round(s.nitro * 40) / 40;
      const key = kmh + '|' + rpm + '|' + gear + '|' + nit + '|' + (night ? 1 : 0) + '|' + s.units;
      if (key === lastKey) return false;
      lastKey = key;
      const W = gc.width, H = gc.height;
      gx.fillStyle = night ? '#05060a' : '#15171c'; gx.fillRect(0, 0, W, H);
      const dial = (cx, cy, r, v, vmax, label, step, fmt) => {
        gx.lineWidth = 3; gx.strokeStyle = night ? accent : '#5a5f69'; gx.beginPath(); gx.arc(cx, cy, r, Math.PI * 0.75, Math.PI * 2.25); gx.stroke();
        gx.fillStyle = night ? '#ffffff' : '#e8eaee'; gx.font = 'bold 15px Bahnschrift, Arial, sans-serif'; gx.textAlign = 'center'; gx.textBaseline = 'middle';
        for (let k = 0; k <= vmax; k += step) {
          const a = Math.PI * 0.75 + (k / vmax) * Math.PI * 1.5, c = Math.cos(a), sn = Math.sin(a);
          gx.strokeStyle = night ? '#ffffff' : '#c9ccd2'; gx.lineWidth = 2; gx.beginPath(); gx.moveTo(cx + c * (r - 4), cy + sn * (r - 4)); gx.lineTo(cx + c * (r - 14), cy + sn * (r - 14)); gx.stroke();
          gx.fillText(fmt(k), cx + c * (r - 28), cy + sn * (r - 28));
        }
        const a = Math.PI * 0.75 + Math.min(1.04, v / vmax) * Math.PI * 1.5;
        gx.strokeStyle = accent; gx.lineWidth = 4; gx.beginPath(); gx.moveTo(cx, cy); gx.lineTo(cx + Math.cos(a) * (r - 10), cy + Math.sin(a) * (r - 10)); gx.stroke();
        gx.fillStyle = accent; gx.beginPath(); gx.arc(cx, cy, 7, 0, Math.PI * 2); gx.fill();
        gx.fillStyle = night ? '#9aa3b2' : '#9aa0aa'; gx.font = '12px Bahnschrift, Arial, sans-serif'; gx.fillText(label, cx, cy + r * 0.55);
      };
      const vmax = Math.max(160, Math.ceil(s.vmax / 40) * 40);
      dial(110, 112, 96, s.kmh, vmax, s.units === 'mph' ? 'миль/ч' : 'км/ч', vmax > 240 ? 40 : 20, (k) => String(k));
      dial(W - 110, 112, 96, s.rpm / 1000, 8, '×1000 об/мин', 1, (k) => String(k));
      // середина: передача и цифры скорости
      gx.fillStyle = night ? '#000' : '#0b0c0f'; gx.fillRect(W / 2 - 52, 34, 104, 128);
      gx.strokeStyle = accent; gx.lineWidth = 2; gx.strokeRect(W / 2 - 52, 34, 104, 128);
      gx.fillStyle = '#ffffff'; gx.font = 'bold 64px Bahnschrift, Arial, sans-serif'; gx.textAlign = 'center'; gx.textBaseline = 'middle';
      gx.fillText(gear < 0 ? 'R' : gear === 0 ? 'N' : String(gear), W / 2, 84);
      gx.fillStyle = accent; gx.font = 'bold 26px Bahnschrift, Arial, sans-serif'; gx.fillText(String(kmh), W / 2, 136);
      // нитро
      gx.fillStyle = '#222'; gx.fillRect(W / 2 - 52, 176, 104, 14);
      gx.fillStyle = '#19d3ff'; gx.fillRect(W / 2 - 50, 178, 100 * Math.max(0, Math.min(1, s.nitro)), 10);
      gx.fillStyle = '#9aa3b2'; gx.font = '11px Bahnschrift, Arial, sans-serif'; gx.fillText('НИТРО', W / 2, 202);
      gtex.needsUpdate = true;
      CK.state.shown = { kmh, gear, rpm, nitro: nit };
      return true;
    }

    // ---- капли на стекле ----
    const dc = document.createElement('canvas'); dc.width = 256; dc.height = 256;
    { const x = dc.getContext('2d'); let sd = 7; const rnd = () => { sd = (sd * 16807) % 2147483647; return sd / 2147483647; };
      for (let k = 0; k < 140; k++) { const px = rnd() * 256, py = rnd() * 256, r = 1.5 + rnd() * 4.5; const g = x.createRadialGradient(px - r * 0.3, py - r * 0.3, 0, px, py, r); g.addColorStop(0, 'rgba(255,255,255,0.75)'); g.addColorStop(0.6, 'rgba(200,215,230,0.35)'); g.addColorStop(1, 'rgba(150,170,190,0)'); x.fillStyle = g; x.beginPath(); x.arc(px, py, r, 0, Math.PI * 2); x.fill(); } }
    const dropTex = new THREE.CanvasTexture(dc); dropTex.wrapS = dropTex.wrapT = THREE.RepeatWrapping; dropTex.repeat.set(3, 2);

    function clear() {
      if (CK.group) { CK.scene.remove(CK.group); CK.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); }); }
      for (const m of CK.owned) m.dispose();
      CK.owned = []; CK.group = null; CK.shape = null;
    }

    // Салон для формы кузова: местные координаты машины (нос +z, левый борт +x, вверх +y, начало - земля под центром).
    CK.ensure = function (carId) {
      const def = (R._ && R._.carDef ? R._.carDef(carId) : null) || D.CARS.find((c) => c.id === carId) || D.CARS[0];
      const shape = def.shape;
      if (CK.shape === shape && CK.group) return;
      clear();
      const S = R.SHAPES[shape], B = D.BODY[shape], L = S.L, W = S.W, cab = S.cabin;
      const g = new THREE.Group(); CK.group = g; CK.shape = shape; CK.scene.add(g);
      const lin = (c) => new THREE.Color(c).convertSRGBToLinear();
      const mat = (o) => { if (o.color !== undefined) o.color = lin(o.color); const m = new THREE.MeshLambertMaterial(o); CK.owned.push(m); return m; };
      const dash = mat({ color: B.dash }), trim = mat({ color: B.trim }), black = mat({ color: 0x111214 }), pillar = mat({ color: B.trim, side: THREE.DoubleSide });
      const glove = mat({ color: 0x1c1d20 }), sleeve = mat({ color: 0x2b3446 }), metal = mat({ color: 0x8a9098 });
      const gaugeMat = new THREE.MeshBasicMaterial({ map: gtex }); CK.owned.push(gaugeMat);
      const mirMat = new THREE.MeshBasicMaterial({ map: mirrorRT.texture }); CK.owned.push(mirMat);
      const dropMat = new THREE.MeshBasicMaterial({ map: dropTex, transparent: true, opacity: 0, depthWrite: false }); CK.owned.push(dropMat);
      CK.mats = { gaugeMat, dropMat, dash };
      const box = (w, h, d, m, x, y, z) => { const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); o.position.set(x, y, z); g.add(o); return o; };
      // стойка между двумя точками
      const beam = (a, b, t, m) => { const len = tv.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]).length(); const o = new THREE.Mesh(new THREE.BoxGeometry(t, len, t), m); o.position.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2); o.quaternion.setFromUnitVectors(up, tv.normalize()); g.add(o); return o; };
      const zFB = cab[3][0] - L / 2, yFB = cab[3][1], zFT = cab[2][0] - L / 2, yFT = cab[2][1], zRT = cab[1][0] - L / 2, yRT = cab[1][1], zRB = cab[0][0] - L / 2, yRB = cab[0][1];
      const wsAt = (y) => zFB + (y - yFB) / (yFT - yFB) * (zFT - zFB);            // стекло на высоте y
      const ey = B.eye, ez = Math.min(wsAt(ey) - 0.95, zFB - 1.25), ex = 0.36 * W / 1.8;
      CK.eye = { x: ex, y: ey, z: ez };
      CK.cab = { zFB, yFB, zFT, yFT, zRT, yRT, zRB, yRB, W, L };
      // панель: от стекла к водителю, верх - по кромке стекла
      box(W - 0.08, 0.3, 0.62, dash, 0, yFB - 0.15, zFB - 0.31);
      // низ панели до пола, моторный щит, пол и пороги: сквозь салон дорогу не видно
      const floorY = 0.3, lowTop = yFB - 0.3;
      box(W - 0.08, Math.max(0.05, lowTop - floorY), 0.08, dash, 0, (lowTop + floorY) / 2, zFB - 0.06);                   // моторный щит
      box(W - 0.08, Math.max(0.05, lowTop - floorY - 0.18), 0.3, dash, 0, (lowTop + floorY + 0.18) / 2, zFB - 0.5);    // нижняя панель над ногами
      box(W - 0.08, 0.04, Math.max(0.6, zFB - zRB + 0.2), black, 0, floorY, (zFB + zRB) / 2);                             // пол
      box(W - 0.08, 0.26, 0.5, black, 0, floorY + 0.13, zFB - 0.3);                                                        // ниша для ног
      for (const sd of [1, -1]) box(0.1, 0.2, Math.max(0.6, zFB - zRB), trim, sd * (W / 2 - 0.08), floorY + 0.1, (zFB + zRB) / 2);   // пороги
      box(W - 0.2, 0.05, 0.12, black, 0, yFB + 0.005, zFB - 0.02);                // кромка у стекла
      // щиток приборов с козырьком
      const gz = zFB - 0.6, gy = yFB + 0.0;
      const gp = new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.172), gaugeMat); gp.position.set(ex, gy + 0.02, gz + 0.02); gp.rotation.y = Math.PI; gp.rotation.x = 0.25; g.add(gp); CK.gaugePlane = gp;
      box(0.42, 0.03, 0.16, dash, ex, gy + 0.115, gz + 0.06).rotation.x = -0.12;
      box(0.04, 0.13, 0.16, dash, ex - 0.21, gy + 0.04, gz + 0.06); box(0.04, 0.13, 0.16, dash, ex + 0.21, gy + 0.04, gz + 0.06);
      // центральная консоль
      box(0.22, 0.4, 0.7, trim, 0, yFB - 0.45, zFB - 0.75);
      // руль на колонке: обод, спицы, ступица; руки на ободе
      // руль: под приборами, полметра перед глазами - верх обода чуть ниже щитка
      const wc = { x: ex, y: ey - 0.33, z: ez + 0.5 };
      const column = new THREE.Group(); column.position.set(wc.x, wc.y, wc.z); column.rotation.x = -0.42; g.add(column);
      const wheel = new THREE.Group(); column.add(wheel); CK.wheel = wheel;
      const rimG = new THREE.TorusGeometry(0.185, 0.022, 8, 28); const rim = new THREE.Mesh(rimG, black); wheel.add(rim);
      for (const a of [0, 2.4, -2.4]) { const sp = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.03, 0.02), black); sp.position.set(Math.cos(a - Math.PI / 2) * 0.085, Math.sin(a - Math.PI / 2) * 0.085, 0); sp.rotation.z = a - Math.PI / 2; wheel.add(sp); }
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.04, 14), trim); hub.rotation.x = Math.PI / 2; wheel.add(hub);
      const mark = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.03, 0.03), mat({ color: B.accent })); mark.position.set(0, 0.185, 0); wheel.add(mark);
      box(0.06, 0.06, 0.36, black, wc.x, wc.y - 0.07, wc.z + 0.16).rotation.x = -0.42;
      CK.gloves = [];
      for (const sd of [1, -1]) {
        const gl = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.09, 0.05), glove); gl.position.set(sd * 0.16, 0.093, -0.012); gl.rotation.z = -sd * 0.5; wheel.add(gl);   // кисти на 10 и 2 часах
        const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.037, 1, 8), sleeve); g.add(arm);            // предплечье
        CK.armRadius = Math.max(arm.geometry.parameters.radiusTop, arm.geometry.parameters.radiusBottom);
        const upper = new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.045, 1, 8), sleeve); g.add(upper);       // плечо
        CK.gloves.push({ gl, arm, upper, elbow: new THREE.Vector3(ex + sd * 0.29, ey - 0.43, ez + 0.2), shoulder: new THREE.Vector3(ex + sd * 0.21, ey - 0.22, ez - 0.16) });
      }
      // стойки стекла, верхняя кромка, потолок
      for (const sd of [1, -1]) beam([sd * (W / 2 - 0.12), yFB, zFB], [sd * (W / 2 - 0.2), yFT, zFT], 0.08, pillar);
      box(W - 0.3, 0.1, 0.14, pillar, 0, yFT + 0.02, zFT - 0.04);
      const roof = new THREE.Mesh(new THREE.PlaneGeometry(W - 0.3, Math.max(0.3, zFT - zRT)), trim); roof.rotation.x = Math.PI / 2; roof.position.set(0, yFT + 0.05, (zFT + zRT) / 2); g.add(roof);
      // двери: нижняя часть борта до линии окна, средняя и задние стойки, заднее стекло в рамке
      const belt = yFB + 0.02;
      for (const sd of [1, -1]) {
        const door = new THREE.Mesh(new THREE.PlaneGeometry(Math.max(0.5, zFB - zRB), belt - 0.3), trim); door.material.side = THREE.DoubleSide; door.rotation.y = sd * Math.PI / 2; door.position.set(sd * (W / 2 - 0.05), (belt + 0.3) / 2, (zFB + zRB) / 2); g.add(door);
        box(0.06, 0.05, Math.max(0.5, zFB - zRB), black, sd * (W / 2 - 0.06), belt, (zFB + zRB) / 2);
        beam([sd * (W / 2 - 0.08), belt, ez - 0.45], [sd * (W / 2 - 0.16), yFT, ez - 0.45], 0.09, pillar);
        beam([sd * (W / 2 - 0.12), yRB, zRB], [sd * (W / 2 - 0.2), yRT, zRT], 0.1, pillar);
      }
      box(W - 0.3, 0.08, 0.1, pillar, 0, yRT, zRT + 0.03); box(W - 0.2, 0.06, 0.3, black, 0, yRB, zRB + 0.15);
      // сиденья (видны, если обернуться)
      for (const sx of [ex, -ex]) { box(0.5, 0.62, 0.12, black, sx, ey - 0.34, ez - 0.32); box(0.32, 0.2, 0.1, black, sx, ey + 0.06, ez - 0.34); }
      // зеркало заднего вида и боковые зеркала
      box(0.21, 0.065, 0.04, black, 0, yFT - 0.09, zFT - 0.09);
      const mirror = (w, h, u0, u1, x, y, z, ry) => {
        const pg = new THREE.PlaneGeometry(w, h), uv = pg.attributes.uv;
        for (let k = 0; k < uv.count; k++) uv.setX(k, uv.getX(k) < 0.5 ? u0 : u1);      // зеркально: левый край - правая часть картинки
        const m = new THREE.Mesh(pg, mirMat); m.position.set(x, y, z); m.rotation.y = ry; g.add(m); return m;
      };
      mirror(0.19, 0.055, 0.86, 0.14, 0, yFT - 0.09, zFT - 0.112, Math.PI);
      for (const sd of [1, -1]) {
        const mx = sd * (W / 2 + 0.1), my = yFB + 0.13, mz = zFB - 0.12;
        box(0.2, 0.13, 0.06, black, mx, my, mz + 0.02);
        mirror(0.17, 0.105, sd > 0 ? 1.0 : 0.42, sd > 0 ? 0.58 : 0.0, mx, my, mz - 0.012, Math.PI - sd * 0.32);
      }
      // каркас безопасности у раллийной
      if (B.cage) {
        for (const sd of [1, -1]) { beam([sd * (W / 2 - 0.26), 0.3, zFB - 0.3], [sd * (W / 2 - 0.3), yFT - 0.06, zFT - 0.15], 0.05, metal); beam([sd * (W / 2 - 0.26), yFT - 0.06, zFT - 0.15], [sd * (W / 2 - 0.26), yFT - 0.06, zRT + 0.1], 0.05, metal); }
        beam([W / 2 - 0.3, yFT - 0.06, zFT - 0.15], [-(W / 2 - 0.3), yFT - 0.06, zFT - 0.15], 0.05, metal);
        beam([W / 2 - 0.26, 0.3, ez - 0.55], [-(W / 2 - 0.26), yFT - 0.06, ez - 0.55], 0.05, metal);
      }
      // капли - на плоскости стекла между стойками
      // четырёхугольник ровно по стеклу: низ - у кромки панели, верх - у верхней кромки
      const dg = new THREE.BufferGeometry(), bw = W / 2 - 0.14, tw = W / 2 - 0.22;
      dg.setAttribute('position', new THREE.Float32BufferAttribute([bw, yFB + 0.02, zFB - 0.01, -bw, yFB + 0.02, zFB - 0.01, tw, yFT - 0.02, zFT - 0.01, -tw, yFT - 0.02, zFT - 0.01], 3));
      dg.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 1, 1], 2)); dg.setIndex([0, 2, 1, 1, 2, 3]);
      const dp = new THREE.Mesh(dg, dropMat); dropMat.side = THREE.DoubleSide; g.add(dp); CK.drops = dp;
      CK.state.shape = shape;
      lastKey = '';
    };

    // Каждый кадр: руль за рулём машины, руки за ободом, приборы, капли, свет; покачивание головы от ускорений.
    CK.update = function (dt, s) {
      if (!CK.group) return;
      const a = -(s.steerN || 0) * 2.4;                             // полный руль - около 140 градусов
      CK.wheel.rotation.z = a; CK.state.wheelAngle = -a;
      CK.group.updateMatrixWorld(true);
      const seg = (m, a, b) => { const len = a.distanceTo(b); m.scale.set(1, len, 1); m.position.copy(a).add(b).multiplyScalar(0.5); m.quaternion.setFromUnitVectors(up, tv3.copy(b).sub(a).normalize()); };
      for (const h of CK.gloves) { h.gl.getWorldPosition(tv); seg(h.arm, tv, h.elbow); seg(h.upper, h.elbow, h.shoulder); }
      const night = s.dark > 0.35, accent = D.BODY[CK.shape].accent;
      CK.frameN++;
      if (CK.frameN % 2 === 0 || !CK.state.shown) drawGauges(s, accent, night);
      CK.mats.gaugeMat.color.setScalar(night ? 1.25 : 0.95);
      amb.intensity = 0.18 + 0.5 * (s.light === undefined ? 1 : s.light) + (night ? 0.05 : 0); sun.intensity = 0.15 + 0.75 * (s.light === undefined ? 1 : s.light);
      CK.mats.dropMat.opacity += ((s.rain ? 0.8 : 0) - CK.mats.dropMat.opacity) * Math.min(1, dt * 2);
      if (s.rain) dropTex.offset.y = (dropTex.offset.y + dt * (0.05 + s.kmh * 0.0015)) % 1;
      // перегрузки: голова чуть отстаёт при разгоне и в повороте
      const sw = CK.sway, c = s.car;
      if (c) {
        const fx = Math.sin(c.h), fz = Math.cos(c.h), vf = c.vx * fx + c.vz * fz, vl = c.vx * -fz + c.vz * fx;
        if (!sw.init || dt <= 0) { sw.vf = vf; sw.vl = vl; sw.init = true; }
        const af = dt > 0 ? (vf - sw.vf) / dt : 0, al = (c.w || 0) * (c.speed || 0); sw.vf = vf; sw.vl = vl;
        const k = Math.min(1, dt * 5);
        sw.z += (Math.max(-0.06, Math.min(0.06, -af * 0.004)) - sw.z) * k;
        sw.x += (Math.max(-0.05, Math.min(0.05, al * 0.0035)) - sw.x) * k;
        sw.roll += (Math.max(-0.035, Math.min(0.035, al * 0.0025)) - sw.roll) * k;
      }
      CK.state.active = true;
    };

    // Поставить камеру мира и камеру салона в глаза водителя. look: { yaw, pitch } в радианах (уже ограничены).
    CK.place = function (cam, carRoot, look, fov) {
      const e = CK.eye, yaw = look ? look.yaw : 0, pitch = look ? look.pitch : 0, sw = CK.sway;
      // голова поворачивается и чуть смещается к центру салона, когда смотришь назад, - остаётся внутри
      const lean = Math.min(1, Math.abs(yaw) / 2.6);
      const lx = e.x + sw.x - lean * 0.18 * Math.sign(e.x), ly = e.y + lean * 0.03, lz = e.z + sw.z + lean * 0.05;
      te.set(pitch, Math.PI + yaw, sw.roll, 'YXZ'); tq.setFromEuler(te);            // по умолчанию - прямо вперёд поверх панели
      CK.cam.position.set(lx, ly, lz); CK.cam.quaternion.copy(tq);
      CK.cam.fov = fov; CK.cam.aspect = cam.aspect; CK.cam.updateProjectionMatrix();
      carRoot.updateMatrixWorld(true);
      tv.set(lx, ly, lz).applyMatrix4(carRoot.matrixWorld); cam.position.copy(tv);
      carRoot.getWorldQuaternion(cam.quaternion); cam.quaternion.multiply(tq);
      cam.fov = fov; cam.updateProjectionMatrix();
      CK.state.yaw = yaw; CK.state.pitch = pitch;
    };

    // Картинка для зеркал: вид назад с крыши, раз в три кадра, маленькая.
    CK.mirrors = function (renderer, scene, carRoot, force) {
      if (!CK.group || (!force && (CK.frameN % 4) !== 0)) return;
      const c = CK.cab; carRoot.updateMatrixWorld(true);
      tv.set(0, c.yFT + 0.15, c.zFT - 0.2).applyMatrix4(carRoot.matrixWorld); mirrorCam.position.copy(tv);
      carRoot.getWorldQuaternion(mirrorCam.quaternion);                      // камера смотрит по -z, нос машины +z: назад
      mirrorCam.updateMatrixWorld();
      // тени для зеркала не пересчитываются: карта теней уже готова для основного кадра
      const sa = renderer.shadowMap.autoUpdate; renderer.shadowMap.autoUpdate = false;
      renderer.setRenderTarget(mirrorRT); renderer.render(scene, mirrorCam); renderer.setRenderTarget(null);
      renderer.shadowMap.autoUpdate = sa;
    };

    // Салон поверх мира: глубина очищается, салон всегда ближе.
    CK.render = function (renderer) {
      if (!CK.group) return;
      const ac = renderer.autoClear; renderer.autoClear = false; renderer.clearDepth();
      renderer.render(CK.scene, CK.cam); renderer.autoClear = ac;
    };
    // Проверка «салон без дыр»: салон рисуется один, без мира, на пурпурном фоне; ниже линии панели пурпура быть не должно
    // (иначе там видна дорога сквозь пол, панель или нишу для ног). Линия панели - верхняя кромка панели перед водителем.
    const covRT = new THREE.WebGLRenderTarget(320, 180), covClear = new THREE.Color(1, 0, 1);
    CK.coverage = function (renderer) {
      if (!CK.group) return null;
      const c = CK.cab, line = new THREE.Vector3(CK.eye.x, c.yFB, c.zFB - 0.62).project(CK.cam), lineY = (1 - (line.y + 1) / 2);   // доля высоты сверху
      const oc = renderer.getClearColor(new THREE.Color()), oa = renderer.getClearAlpha();
      renderer.setRenderTarget(covRT); renderer.setClearColor(covClear, 1); renderer.clear(); renderer.render(CK.scene, CK.cam);
      const buf = new Uint8Array(320 * 180 * 4); renderer.readRenderTargetPixels(covRT, 0, 0, 320, 180, buf);
      renderer.setRenderTarget(null); renderer.setClearColor(oc, oa);
      let holes = 0, n = 0; const y0 = Math.min(179, Math.max(0, Math.ceil(lineY * 180) + 2));
      // по ширине - середина кадра (22-78%): по краям ниже панели честно видна дорога сквозь боковые стёкла
      for (let row = y0; row < 180; row++) { const gy = 179 - row; for (let x = 70; x < 250; x++) { const k = (gy * 320 + x) * 4; n++; if (buf[k] > 200 && buf[k + 1] < 40 && buf[k + 2] > 200) holes++; } }
      return { lineY, holes: n ? holes / n : 0, rows: 180 - y0 };
    };
    CK.off = function () { CK.state.active = false; };
    CK.dispose = function () { clear(); mirrorRT.dispose(); gtex.dispose(); dropTex.dispose(); };
    return CK;
  }
  root.DriftCockpit = { create };
})(typeof self !== 'undefined' ? self : this);
