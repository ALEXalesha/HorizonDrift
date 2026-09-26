/* Horizon Drift - ядро: трассы, физика машины, ИИ, заезд, дрифт, карьера, настройки.
   Без DOM и без three.js: работает в странице (window.DriftCore) и в node (для проверок).
   Физика идёт фиксированным шагом DT, случайность - только из сида заезда. */
(function (root, factory) {
  const D = root.DriftData || (typeof require === 'function' ? require('./data.js') : null);
  const api = factory(D);
  if (typeof module === 'object' && module.exports) module.exports = api; else root.DriftCore = api;
})(typeof self !== 'undefined' ? self : this, function (D) {
  'use strict';
  const G = 9.81;
  const DT = 1 / 120;
  const STEP = 2;                 // шаг выборки осевой линии трассы, м

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

  // ======================= ТРАССА =======================
  // Направление по курсу psi: psi растёт при повороте направо. psi=0 смотрит в +z.
  const dirOf = (p) => [-Math.sin(p), Math.cos(p)];

  function runTurtle(cmds, autoLens) {
    const pts = [[0, 0]]; let x = 0, z = 0, psi = 0, ai = 0; const autos = [];
    for (const c of cmds) {
      if (c[0] === 'S') {
        let len = c[1];
        if (len === 'auto') { autos.push(psi); len = autoLens ? autoLens[ai++] : 0; }
        if (len <= 0) continue;
        const d = dirOf(psi), n = Math.max(1, Math.round(len / STEP));
        for (let k = 1; k <= n; k++) pts.push([x + d[0] * len * k / n, z + d[1] * len * k / n]);
        x += d[0] * len; z += d[1] * len;
      } else {
        const sgn = c[0] === 'R' ? 1 : -1, ang = c[1] * Math.PI / 180, r = c[2];
        const side = dirOf(psi + sgn * Math.PI / 2);
        const cx = x + side[0] * r, cz = z + side[1] * r;
        const n = Math.max(2, Math.round(r * ang / STEP));
        for (let k = 1; k <= n; k++) {
          const p = psi + sgn * ang * k / n;
          const back = dirOf(p - sgn * Math.PI / 2);
          pts.push([cx + back[0] * r, cz + back[1] * r]);
        }
        psi += sgn * ang;
        const e = pts[pts.length - 1]; x = e[0]; z = e[1];
      }
    }
    return { pts, psi, autos, end: [x, z] };
  }

  // Длины двух прямых 'auto', при которых кольцо замыкается.
  function solveAutos(cmds) {
    const r0 = runTurtle(cmds, [0, 0]);
    if (r0.autos.length !== 2) return null;
    const d1 = dirOf(r0.autos[0]), d2 = dirOf(r0.autos[1]);
    const gx = -r0.end[0], gz = -r0.end[1];
    const det = d1[0] * d2[1] - d1[1] * d2[0];
    const a = (gx * d2[1] - gz * d2[0]) / det, b = (d1[0] * gz - d1[1] * gx) / det;
    return [a, b];
  }

  function resample(pts, closed) {
    const P = pts.slice();
    if (closed) P.push(P[0]);
    const cum = [0];
    for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]));
    const total = cum[cum.length - 1];
    const n = Math.round(total / STEP), step = total / n, out = [];
    let j = 0;
    const count = closed ? n : n + 1;
    for (let k = 0; k < count; k++) {
      const s = k * step;
      while (j < cum.length - 2 && cum[j + 1] < s) j++;
      const t = (s - cum[j]) / Math.max(1e-9, cum[j + 1] - cum[j]);
      out.push([lerp(P[j][0], P[j + 1][0], t), lerp(P[j][1], P[j + 1][1], t)]);
    }
    return { pts: out, step, total };
  }

  function smoothPts(pts, closed, iters, w) {
    const n = pts.length;
    for (let it = 0; it < iters; it++) {
      const cp = pts.map((p) => p.slice());
      for (let i = 0; i < n; i++) {
        if (!closed && (i < 2 || i > n - 3)) continue;
        const a = cp[(i - 1 + n) % n], b = cp[(i + 1) % n];
        pts[i][0] = lerp(cp[i][0], (a[0] + b[0]) / 2, w);
        pts[i][1] = lerp(cp[i][1], (a[1] + b[1]) / 2, w);
      }
    }
  }

  function catmull(p0, p1, p2, p3, t) {
    const t2 = t * t, t3 = t2 * t;
    return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
  }
  function elevAt(elev, f, closed) {
    const n = elev.length;
    if (closed) {
      const x = f * n, i = Math.floor(x), t = x - i, g = (k) => elev[((k % n) + n) % n];
      return catmull(g(i - 1), g(i), g(i + 1), g(i + 2), t);
    }
    const x = clamp(f, 0, 1) * (n - 1), i = Math.min(n - 2, Math.floor(x)), t = x - i, g = (k) => elev[clamp(k, 0, n - 1)];
    return catmull(g(i - 1), g(i), g(i + 1), g(i + 2), t);
  }

  const PRE = 70, POST = 140;      // разгон до старта и выбег после финиша у трасс «из точки в точку»
  const trackCache = {};

  function buildTrack(def) {
    if (typeof def === 'string') def = D.TRACKS.find((t) => t.id === def);
    if (trackCache[def.id]) return trackCache[def.id];
    let cmds = def.cmds;
    let autos = null;
    if (def.closed) autos = solveAutos(cmds);
    else cmds = [['S', PRE]].concat(cmds, [['S', POST]]);
    const tur = runTurtle(cmds, autos);
    let raw = tur.pts;
    if (def.closed) raw = raw.slice(0, raw.length - 1);
    const rs = resample(raw, def.closed);
    const pts = rs.pts;
    smoothPts(pts, def.closed, 12, 0.35);
    const N = pts.length;
    const tr = {
      id: def.id, def, name: def.name, closed: !!def.closed, N, step: rs.step,
      x: new Float64Array(N), z: new Float64Array(N), y: new Float64Array(N), s: new Float64Array(N),
      tx: new Float64Array(N), tz: new Float64Array(N), nx: new Float64Array(N), nz: new Float64Array(N),
      surf: new Array(N), hw: def.width / 2, W: def.width / 2 + def.runoff, runoffSurf: def.runoffSurf, autos,
    };
    for (let i = 0; i < N; i++) { tr.x[i] = pts[i][0]; tr.z[i] = pts[i][1]; }
    let acc = 0;
    for (let i = 0; i < N; i++) {
      tr.s[i] = acc;
      const j = tr.closed ? (i + 1) % N : Math.min(N - 1, i + 1), k = tr.closed ? (i - 1 + N) % N : Math.max(0, i - 1);
      let dx = tr.x[j] - tr.x[k], dz = tr.z[j] - tr.z[k]; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
      tr.tx[i] = dx; tr.tz[i] = dz; tr.nx[i] = -dz; tr.nz[i] = dx;
      if (i < N - 1 || tr.closed) acc += Math.hypot(tr.x[j] - tr.x[i], tr.z[j] - tr.z[i]);
    }
    tr.L = acc;
    // высоты и покрытия
    for (let i = 0; i < N; i++) {
      const f = tr.s[i] / tr.L;
      tr.y[i] = elevAt(def.elev || [0], f, tr.closed);
      let sf = def.surface;
      if (def.surfaces) for (const r of def.surfaces) if (f >= r[0] && f < r[1]) sf = r[2];
      tr.surf[i] = sf;
    }
    // старт, финиш, чекпоинты
    if (tr.closed) {
      tr.sStart = 60; tr.sFinish = tr.sStart; tr.lapLen = tr.L;
      const K = Math.max(4, Math.round(tr.L / 280));
      tr.cps = [];
      for (let k = 0; k < K; k++) tr.cps.push(gate(tr, tr.sStart + k * tr.L / K));
    } else {
      tr.sStart = PRE; tr.sFinish = tr.L - POST + 20; tr.lapLen = tr.sFinish - tr.sStart;
      const K = Math.max(4, Math.round(tr.lapLen / 280));
      tr.cps = [];
      for (let k = 0; k <= K; k++) tr.cps.push(gate(tr, tr.sStart + k * tr.lapLen / K));
    }
    racingLine(tr);
    trackCache[def.id] = tr;
    return tr;
  }

  function idxAt(tr, s) {
    if (tr.closed) { s = ((s % tr.L) + tr.L) % tr.L; } else s = clamp(s, 0, tr.L);
    const i = Math.min(tr.N - 1, Math.floor(s / tr.step));
    return i;
  }
  function gate(tr, s) {
    const i = idxAt(tr, s);
    return { i, s: tr.s[i], x: tr.x[i], z: tr.z[i], tx: tr.tx[i], tz: tr.tz[i], nx: tr.nx[i], nz: tr.nz[i], y: tr.y[i] };
  }

  // Гоночная линия: смещения поперёк дороги, сглаживаем - кривизна уменьшается, линия режет углы.
  function racingLine(tr) {
    const N = tr.N, off = new Float64Array(N), lim = tr.hw - 1.6;
    const K = 5;
    for (let it = 0; it < 220; it++) {
      for (let i = 0; i < N; i++) {
        let a = i - K, b = i + K;
        if (!tr.closed) { if (a < 0 || b >= N) continue; }
        a = (a + N) % N; b = b % N;
        const qax = tr.x[a] + tr.nx[a] * off[a], qaz = tr.z[a] + tr.nz[a] * off[a];
        const qbx = tr.x[b] + tr.nx[b] * off[b], qbz = tr.z[b] + tr.nz[b] * off[b];
        const mx = (qax + qbx) / 2, mz = (qaz + qbz) / 2;
        const qx = tr.x[i] + tr.nx[i] * off[i], qz = tr.z[i] + tr.nz[i] * off[i];
        const dd = (mx - qx) * tr.nx[i] + (mz - qz) * tr.nz[i];
        off[i] = clamp(off[i] + dd * 0.6, -lim, lim);
      }
    }
    tr.line = off;
    tr.lx = new Float64Array(N); tr.lz = new Float64Array(N); tr.kappa = new Float64Array(N);
    for (let i = 0; i < N; i++) { tr.lx[i] = tr.x[i] + tr.nx[i] * off[i]; tr.lz[i] = tr.z[i] + tr.nz[i] * off[i]; }
    const M = 4;
    for (let i = 0; i < N; i++) {
      let a = i - M, b = i + M;
      if (tr.closed) { a = (a + N) % N; b %= N; } else { a = Math.max(0, a); b = Math.min(N - 1, b); }
      if (a === b || a === i || b === i) { tr.kappa[i] = 0; continue; }
      const ax = tr.lx[a], az = tr.lz[a], bx = tr.lx[i], bz = tr.lz[i], cx = tr.lx[b], cz = tr.lz[b];
      const ab = Math.hypot(bx - ax, bz - az), bc = Math.hypot(cx - bx, cz - bz), ca = Math.hypot(ax - cx, az - cz);
      const cross = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
      tr.kappa[i] = Math.abs(2 * cross / Math.max(1e-6, ab * bc * ca));
    }
    // немного сгладить кривизну, чтобы скорость не прыгала
    const k2 = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      let s = 0, c = 0;
      for (let j = -3; j <= 3; j++) { let q = i + j; if (tr.closed) q = (q + N) % N; else if (q < 0 || q >= N) continue; s += tr.kappa[q]; c++; }
      k2[i] = Math.max(tr.kappa[i], s / c);
    }
    tr.kappa = k2;
  }

  // Ближайшая точка осевой линии. hint - индекс с прошлого шага: ищем рядом, чтобы соседние
  // участки серпантина не путались. out переиспользуется, чтобы не мусорить память.
  function project(tr, x, z, hint, out, global) {
    const N = tr.N; let best = 1e18, bi = 0, bt = 0;
    const from = global ? 0 : hint - 8, to = global ? N - 1 : hint + 24;
    for (let j = from; j <= to; j++) {
      let i = j;
      if (tr.closed) i = ((i % N) + N) % N; else if (i < 0 || i >= N - 1) continue;
      const i2 = tr.closed ? (i + 1) % N : i + 1;
      const ax = tr.x[i], az = tr.z[i], bx = tr.x[i2] - ax, bz = tr.z[i2] - az;
      let t = ((x - ax) * bx + (z - az) * bz) / (bx * bx + bz * bz);
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = ax + bx * t - x, pz = az + bz * t - z, dd = px * px + pz * pz;
      if (dd < best) { best = dd; bi = i; bt = t; }
    }
    const i2 = tr.closed ? (bi + 1) % N : Math.min(N - 1, bi + 1);
    out = out || {};
    out.i = bi; out.t = bt;
    out.s = tr.s[bi] + bt * tr.step;
    let tx = lerp(tr.tx[bi], tr.tx[i2], bt), tz = lerp(tr.tz[bi], tr.tz[i2], bt); const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
    out.tx = tx; out.tz = tz; out.nx = -tz; out.nz = tx;
    const cx = lerp(tr.x[bi], tr.x[i2], bt), cz = lerp(tr.z[bi], tr.z[i2], bt);
    out.d = (x - cx) * out.nx + (z - cz) * out.nz;
    out.along = (x - cx) * tx + (z - cz) * tz;
    out.y = lerp(tr.y[bi], tr.y[i2], bt);
    out.surf = tr.surf[bt < 0.5 ? bi : i2];
    return out;
  }

  // Точка трассы по расстоянию s и смещению d (для расстановки машин и проверок).
  function pointAt(tr, s, d) {
    if (tr.closed) s = ((s % tr.L) + tr.L) % tr.L; else s = clamp(s, 0, tr.L - 0.01);
    const i = Math.min(tr.N - 1, Math.floor(s / tr.step)), t = (s - tr.s[i]) / tr.step;
    const i2 = tr.closed ? (i + 1) % tr.N : Math.min(tr.N - 1, i + 1);
    let tx = lerp(tr.tx[i], tr.tx[i2], t), tz = lerp(tr.tz[i], tr.tz[i2], t); const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
    const nx = -tz, nz = tx;
    return { x: lerp(tr.x[i], tr.x[i2], t) + nx * (d || 0), z: lerp(tr.z[i], tr.z[i2], t) + nz * (d || 0), y: lerp(tr.y[i], tr.y[i2], t),
      h: Math.atan2(tx, tz), tx, tz, nx, nz, i };
  }

  // Проверка геометрии: минимальное расстояние между участками, которые не соседи по трассе.
  function trackClearance(tr) {
    let min = 1e9, at = null;
    const skip = 90;
    for (let i = 0; i < tr.N; i += 2) {
      for (let j = i + 2; j < tr.N; j += 2) {
        let ds = Math.abs(tr.s[j] - tr.s[i]); if (tr.closed) ds = Math.min(ds, tr.L - ds);
        if (ds < skip) continue;
        const d = Math.hypot(tr.x[i] - tr.x[j], tr.z[i] - tr.z[j]);
        if (d < min) { min = d; at = [i, j]; }
      }
    }
    return { min, at };
  }

  // ======================= МАШИНА =======================
  const GEARS = [0.3, 0.46, 0.61, 0.75, 0.88, 1.04];      // доля максимальной скорости на каждой передаче
  const CAR_A = 1.2, CAR_B = 1.4, WB = CAR_A + CAR_B;      // от центра масс до осей, м

  function carDef(id) { return D.CARS.find((c) => c.id === id) || D.CARS[0]; }
  function upgradeLevels(u) { const o = {}; for (const up of D.UPGRADES) o[up.id] = clamp((u && u[up.id]) | 0, 0, D.UPG_MAX); return o; }

  // Итоговые характеристики машины с тюнингом: база * (1 + доля из таблицы D.UPGRADES * уровень).
  function carStats(defOrId, upg) {
    const def = typeof defOrId === 'string' ? carDef(defOrId) : defOrId;
    const lv = upgradeLevels(upg);
    const base = { power: def.kw * 1000, top: def.top / 3.6, grip: def.grip, steer: def.steer, mass: def.mass, nitroCap: 2.6, nitroBoost: 0.32 };
    const st = {};
    for (const k in base) {
      let f = 1;
      for (const up of D.UPGRADES) if (up.eff[k]) f += up.eff[k] * lv[up.id];
      st[k] = base[k] * f;
    }
    st.id = def.id; st.drift = def.drift; st.offroad = def.offroad; st.drive = def.drive; st.launch = def.launch; st.aero = def.aero;
    st.rearMul = 1.06 - 0.06 * def.drift;            // у «дрифтовых» задняя ось держит слабее
    st.hbMul = 0.52 - 0.22 * def.drift;              // ручник отнимает сцепление задней оси
    st.crr = 0.013;
    st.cd = Math.max(0.05, (st.power / st.top - st.mass * G * st.crr) / (st.top * st.top));
    st.I = st.mass * 1.45;
    st.levels = lv;
    return st;
  }

  function surfMu(name, st) {
    const S = D.SURF[name] || D.SURF.asphalt;
    return S.adapt ? Math.min(1, S.mu * st.offroad) : S.mu;
  }

  function makeCar(st, o) {
    o = o || {};
    return {
      st, name: o.name || '', carId: st.id, look: o.look || null, isPlayer: !!o.isPlayer, ai: null, rival: !!o.rival,
      x: 0, z: 0, y: 0, h: 0, vx: 0, vz: 0, w: 0, steer: 0, gear: 1, rpm: 900, rpmN: 0.11, shiftT: 0, nitro: 1, nitroOn: false,
      inp: { thr: 0, brk: 0, steer: 0, hb: 0, nitro: 0, analog: false, shiftUp: false, shiftDown: false },
      assist: { tc: true, abs: true, steer: false, auto: true, sens: 1 },
      speed: 0, vLong: 0, beta: 0, skidR: 0, skidF: 0, spin: 0, surf: 'asphalt', onRunoff: false, hit: 0, events: [],
      braking: false,
    };
  }

  // Шина: боковая сила растёт с углом увода до пика, дальше немного падает (скольжение).
  function tyre(alpha, peak, cap) {
    const x = alpha / peak, ax = x < 0 ? -x : x;
    const f = ax < 1 ? ax * (1.5 - 0.5 * ax * ax) : Math.max(0.82, 1 - 0.09 * (ax - 1));
    return (x < 0 ? f : -f) * cap;
  }

  // Один шаг физики машины: велосипедная модель с уводом шин, кругом трения на ведущей оси,
  // ручником, нитро, АБС и антипробуксовкой. Поверхность задаёт сцепление.
  function stepCar(car, dt, surfName) {
    const st = car.st, inp = car.inp, as = car.assist, m = st.mass;
    const sh = Math.sin(car.h), ch = Math.cos(car.h);
    const fx = sh, fz = ch, rx = -ch, rz = sh;
    const vLong = car.vx * fx + car.vz * fz, vLat = car.vx * rx + car.vz * rz;
    const speed = Math.hypot(car.vx, car.vz);
    const S = D.SURF[surfName] || D.SURF.asphalt;
    const down = 1 + st.aero * Math.min(1.3, (speed / st.top) * (speed / st.top));
    const mu = st.grip * surfMu(surfName, st);
    const Nf = m * G * CAR_B / WB * down, Nr = m * G * CAR_A / WB * down;
    car.events.length = 0;

    // --- руль: предел угла падает со скоростью, помощник руля ловит занос ---
    const smax = st.steer / (1 + speed / (as.steer ? 19 : 30));
    const beta = speed > 3 && vLong > 0 ? Math.atan2(vLat, vLong) : 0;
    let target = inp.steer * smax;
    if (as.steer && !inp.hb && vLong > 4) target = clamp(target + beta * 0.5, -st.steer, st.steer);
    if (inp.analog) car.steer += clamp(target - car.steer, -8 * dt, 8 * dt);
    else {
      const back = Math.abs(target) < Math.abs(car.steer) || target * car.steer < 0;
      const rate = (smax + Math.abs(beta) * 0.5) * (back ? 7 : 4) * (as.sens || 1);
      car.steer += clamp(target - car.steer, -rate * dt, rate * dt);
    }

    // --- коробка: назад по тормозу с места, автомат или ручная ---
    const thr = inp.thr, brk = inp.brk;
    if (car.gear === -1) { if (thr > 0.1 && vLong > -1) car.gear = 1; } else if (brk > 0.1 && thr < 0.1 && vLong < 0.8 && speed < 1.2) car.gear = -1;
    const driveThr = car.gear === -1 ? brk : thr, brakeIn = car.gear === -1 ? thr : brk;
    if (car.shiftT > 0) car.shiftT -= dt;
    if (car.gear > 0) {
      if (as.auto) {
        if (car.shiftT <= 0) {
          const rN = Math.abs(vLong) / (st.top * GEARS[car.gear - 1]);
          if (rN > 0.95 && car.gear < 6 && driveThr > 0.1) { car.gear++; car.shiftT = 0.14; car.events.push('up'); }
          else if (car.gear > 1 && Math.abs(vLong) / (st.top * GEARS[car.gear - 2]) < 0.62) { car.gear--; car.shiftT = 0.06; car.events.push('down'); }
        }
      } else {
        if (inp.shiftUp && car.gear < 6) { car.gear++; car.shiftT = 0.12; car.events.push('up'); }
        if (inp.shiftDown && car.gear > 1) { car.gear--; car.shiftT = 0.08; car.events.push('down'); }
      }
    }
    inp.shiftUp = false; inp.shiftDown = false;

    // --- тяга ---
    let Fdrive = 0, rN = 0;
    if (car.gear > 0) {
      rN = Math.abs(vLong) / (st.top * GEARS[car.gear - 1]);
      if (car.shiftT <= 0 && driveThr > 0) {
        let tq = rN < 1 ? 0.62 + 0.38 * Math.sin(Math.min(1, rN / 0.8) * Math.PI / 2) : (car.gear === 6 ? 1 : 0);
        if (rN > 1.02 && car.gear < 6) tq = 0;                               // отсечка
        Fdrive = driveThr * Math.min(st.power / Math.max(Math.abs(vLong), 1), st.launch * m * G) * tq;
      }
    } else if (driveThr > 0 && vLong > -9) Fdrive = -driveThr * 0.45 * m * G;
    car.nitroOn = false;
    if (inp.nitro && car.nitro > 0 && car.gear > 0 && driveThr > 0.2) {
      Fdrive += st.nitroBoost * m * G; car.nitro = Math.max(0, car.nitro - dt / st.nitroCap); car.nitroOn = true;
    }
    const frontShare = st.drive === 'fwd' ? 1 : st.drive === 'awd' ? 0.4 : 0;
    let FxF = Fdrive * frontShare, FxR = Fdrive * (1 - frontShare);

    // --- тормоза и ручник ---
    const sgnL = vLong > 0.05 ? 1 : vLong < -0.05 ? -1 : 0;
    let Fb = brakeIn * 1.15 * m * G, lockF = false;
    if (as.abs) Fb = Math.min(Fb, mu * m * G * 0.98 * down);
    else if (brakeIn > 0.85 && speed > 6) { lockF = true; Fb = 0.8 * mu * m * G; }
    FxF -= Fb * 0.62 * sgnL; FxR -= Fb * 0.38 * sgnL;
    car.braking = brakeIn > 0.05 && sgnL > 0;
    const rearCap = mu * Nr * st.rearMul * (inp.hb ? st.hbMul : 1);
    if (inp.hb) FxR -= 0.4 * mu * Nr * sgnL;

    // --- боковые силы шин (до круга трения) ---
    const den = Math.max(Math.abs(vLong), 3), sgnV = vLong >= -0.5 ? 1 : -1;
    const aF = Math.atan2(vLat + car.w * CAR_A, den) - car.steer * sgnV;
    const aR = Math.atan2(vLat - car.w * CAR_B, den);
    const capF = mu * Nf, capR = mu * Nr * st.rearMul;
    let Fyf = tyre(aF, 0.15, capF);
    let Fyr = tyre(aR, 0.12, rearCap);
    // на малой скорости модель увода неустойчива - плавно переходим к простому гашению бокового скольжения
    const kLow = clamp((speed - 0.5) / 3, 0, 1);
    if (kLow < 1) { const damp = -vLat * m * 8 * (1 - kLow); Fyf = Fyf * kLow + damp * 0.5; Fyr = Fyr * kLow + damp * 0.5; }

    // --- круг трения: тяга и торможение отнимают боковое сцепление. Антипробуксовка оставляет
    //     тяге только то, что не нужно шине в повороте ---
    if (as.tc) {
      if (FxF > 0) FxF = Math.min(FxF, Math.sqrt(Math.max(0, capF * capF * 0.94 - Fyf * Fyf)));
      if (FxR > 0) FxR = Math.min(FxR, Math.sqrt(Math.max(0, capR * capR * 0.94 - Fyr * Fyr)));
    }
    const uF = Math.abs(FxF) / capF, uR = Math.abs(FxR) / capR;
    let latF = uF < 1 ? Math.sqrt(1 - 0.9 * uF * uF) : 0.32;
    const latR = uR < 1 ? Math.sqrt(1 - 0.9 * uR * uR) : 0.28;
    if (uF > 1) FxF = Math.sign(FxF) * capF * 0.9;
    if (uR > 1) FxR = Math.sign(FxR) * capR * 0.9;
    if (lockF) latF = 0.25;
    Fyf *= latF; Fyr *= latR;

    const cs = Math.cos(car.steer), sn = Math.sin(car.steer);
    const drag = st.cd * vLong * Math.abs(vLong);
    const roll = (Math.abs(vLong) > 0.3 ? sgnL : 0) * m * G * (st.crr + S.drag);
    const Fx = FxF * cs - Fyf * sn + FxR - drag - roll;
    const Fy = FxF * sn + Fyf * cs + Fyr - st.cd * 2 * vLat * Math.abs(vLat);
    const ax = Fx / m, ay = Fy / m;
    car.vx += (ax * fx + ay * rx) * dt; car.vz += (ax * fz + ay * rz) * dt;
    car.w += (CAR_A * (FxF * sn + Fyf * cs) - CAR_B * Fyr) / st.I * dt;
    if (kLow < 1) car.w = lerp(car.w, vLong * Math.tan(car.steer) / WB, 1 - kLow);
    car.h -= car.w * dt;
    // тормоз останавливает, но не толкает назад
    const vL2 = car.vx * fx + car.vz * fz;
    if (brakeIn > 0 && sgnL !== 0 && vL2 * sgnL < 0) { car.vx -= vL2 * fx; car.vz -= vL2 * fz; }
    if (speed < 0.4 && driveThr === 0) { car.vx *= 0.85; car.vz *= 0.85; car.w *= 0.85; }
    car.x += car.vx * dt; car.z += car.vz * dt;

    car.speed = Math.hypot(car.vx, car.vz); car.vLong = vL2; car.beta = beta;
    car.skidR = speed > 4 ? clamp((Math.abs(aR) - 0.13) * 5, 0, 1) + clamp(uR - 1, 0, 1) + (inp.hb ? 0.5 : 0) : 0;
    car.skidF = speed > 4 ? (lockF ? 1 : clamp((Math.abs(aF) - 0.22) * 4, 0, 1)) : 0;
    car.spin = clamp(uR - 1, 0, 1);
    let rpmT;
    if (car.gear > 0) rpmT = 900 + 7100 * clamp(rN, 0, 1.03);
    else rpmT = 900 + 3000 * clamp(Math.abs(vLong) / 9, 0, 1);
    if (car.shiftT > 0) rpmT *= 0.8;
    car.rpm += (rpmT - car.rpm) * Math.min(1, dt * 14);
    car.rpmN = car.rpm / 8000;
  }

  // Разгон 0-100 км/ч по прямой (для гаража): та же физика, асфальт.
  function accelTime(st) {
    const c = makeCar(st); c.inp.thr = 1;
    for (let i = 0; i < 30 / DT; i++) { stepCar(c, DT, 'asphalt'); if (c.speed >= 100 / 3.6) return i * DT; }
    return 30;
  }

  // ======================= ДРИФТ =======================
  // Очки идут, пока машину несёт боком (угол 10°+) на скорости. Чем шире угол и выше скорость,
  // тем быстрее растут очки; каждые 2 секунды заноса множитель +1 (до x5). Пауза больше 1.2 с
  // закрывает серию и зачисляет её. Удар срывает серию: её очки пропадают.
  class DriftScorer {
    constructor() { this.total = 0; this.best = 0; this.lastBank = 0; this.lost = 0; this.reset(); }
    reset() { this.chain = 0; this.chainT = 0; this.mult = 1; this.grace = 0; this.active = false; this.drifting = false; }
    update(dt, angleDeg, speed, onRoad) {
      const drifting = onRoad && speed > 9 && angleDeg > 10 && angleDeg < 110;
      this.drifting = drifting;
      if (drifting) {
        const ang = Math.min(angleDeg, 60);
        this.chain += (ang - 8) * speed * 0.9 * dt;
        this.chainT += dt; this.grace = 0; this.active = true;
        this.mult = Math.min(5, 1 + Math.floor(this.chainT / 2));
      } else if (this.active) {
        this.grace += dt;
        if (this.grace > 1.2) return this.bank();
      }
      return 0;
    }
    get pending() { return Math.round(this.chain * this.mult); }
    bank() {
      const pts = this.pending;
      this.total += pts; if (pts) this.lastBank = pts; this.best = Math.max(this.best, pts);
      this.reset();
      return pts;
    }
    crash() {
      if (!this.active) return 0;
      const lost = this.pending; this.lost = lost; this.reset();
      return lost || -1;
    }
  }

  // ======================= ИИ =======================
  const profileCache = {};
  // Наибольшая скорость в каждой точке гоночной линии: сцепление / кривизна, затем проход
  // назад - чтобы успеть оттормозиться. У трассы «из точки в точку» после финиша - остановка.
  function speedProfile(tr, st) {
    const key = tr.id + '|' + st.id + '|' + Object.values(st.levels || {}).join('');
    if (profileCache[key]) return profileCache[key];
    const N = tr.N, v = new Float64Array(N), aB = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const mu = st.grip * surfMu(tr.surf[i], st) * 0.86;
      const k = tr.kappa[i], den = k - mu * G * st.aero / (st.top * st.top);
      v[i] = den <= 1e-6 ? st.top : Math.min(st.top, Math.sqrt(mu * G / den));
      aB[i] = mu * G * 0.78;
      if (!tr.closed && tr.s[i] > tr.sFinish + 50) v[i] = 0;
    }
    const passes = tr.closed ? 2 : 1;
    for (let p = 0; p < passes; p++) {
      for (let i = N - 1; i >= 0; i--) {
        let j = i + 1; if (j >= N) { if (!tr.closed) continue; j = 0; }
        const lim = Math.sqrt(v[j] * v[j] + 2 * aB[i] * tr.step);
        if (v[i] > lim) v[i] = lim;
      }
    }
    profileCache[key] = v;
    return v;
  }

  function newAi(o) {
    o = o || {};
    return { pace: o.pace || 0.9, mistakes: o.mistakes || 0, laneBase: o.laneBase || 0, nitro: o.nitro !== false, tick: 1, mistake: null, mT: 0,
      lane: o.laneBase || 0, wideDir: 1 };
  }

  function aiControl(race, c, dt) {
    const tr = race.track, ai = c.ai, inp = c.inp, v = c.speed, s = c.pr ? c.pr.s : 0;
    inp.analog = true; inp.hb = 0;
    // ошибки: чем ниже сложность, тем чаще
    if (race.phase === 'race' && !c.finished) {
      ai.tick -= dt;
      if (ai.tick <= 0) {
        ai.tick = 1;
        if (race.rng() < ai.mistakes) { const r = race.rng(); ai.mistake = r < 0.4 ? 'late' : r < 0.75 ? 'wide' : 'lift'; ai.mT = 1.2 + race.rng() * 1.5; ai.wideDir = race.rng() < 0.5 ? -1 : 1; }
      }
      if (ai.mistake && (ai.mT -= dt) <= 0) ai.mistake = null;
    }
    let pace = ai.pace;
    const p = race.player;
    if (race.catchup && p && p !== c && !p.out && !c.finished) pace *= 1 - clamp((c.dist - p.dist) / 160, -1, 1) * 0.03;
    if (ai.mistake === 'late') pace *= 1.1;
    let laneT = ai.laneBase + (ai.mistake === 'wide' ? ai.wideDir * 3 : 0);
    let follow = 1e9;
    const la = 5 + v * 0.42;
    const idx = idxAt(tr, s + la);
    const myT = c.prof[idxAt(tr, s + v * 0.35 + 2)] * pace;
    for (const o of race.cars) {
      if (o === c || o.out) continue;
      const gap = o.dist - c.dist;
      if (gap <= 0 || gap > 24) continue;
      const lat = o.pr.d - c.pr.d;
      if (Math.abs(lat) > 2.8) continue;
      if (myT > o.speed + 0.8 && gap < 18) {
        const room = tr.hw - 1.4, side = o.pr.d > 0 ? -1 : 1;
        const want = clamp(o.pr.d + side * 3.4, -room, room);
        laneT = want - tr.line[idx];
      } else follow = Math.min(follow, o.speed + (gap - 8) * 0.6);
    }
    ai.lane += clamp(laneT - ai.lane, -3 * dt, 3 * dt);
    const off = clamp(tr.line[idx] + ai.lane, -(tr.hw - 1.2), tr.hw - 1.2);
    const tx = tr.x[idx] + tr.nx[idx] * off, tz = tr.z[idx] + tr.nz[idx] * off;
    const dx = tx - c.x, dz = tz - c.z;
    const fx = Math.sin(c.h), fz = Math.cos(c.h);
    const lat = dx * -fz + dz * fx, lon = dx * fx + dz * fz;
    const dist = Math.hypot(dx, dz) || 1;
    const ang = Math.atan2(lat, Math.max(0.5, lon));
    const delta = Math.atan2(2 * WB * Math.sin(ang), dist) * 1.25 + c.beta * 0.7;
    const smax = c.st.steer / (1 + v / 30);
    inp.steer = clamp(delta / smax, -1, 1);
    let vt = Math.min(myT, follow);
    if (ai.mistake === 'lift') vt *= 0.8;
    if (c.finished && !tr.closed && s > tr.sFinish + 30) vt = 0;
    if (v < vt - 0.3) { inp.thr = 1; inp.brk = 0; } else if (v > vt + 1.2) { inp.thr = 0; inp.brk = clamp((v - vt) / 2.5, 0.25, 1); } else { inp.thr = 0.35; inp.brk = 0; }
    if (race.phase === 'countdown') { inp.thr = 0.3 + 0.3 * Math.sin(race.countdown * 9 + ai.laneBase * 3); inp.brk = 0; }
    // нитро на прямой, если впереди нет поворота
    inp.nitro = 0;
    if (ai.nitro && c.nitro > 0.2 && race.phase === 'race' && v > 15 && c.prof[idxAt(tr, s + 60)] > v + 8 && c.prof[idxAt(tr, s + 120)] > v + 5) inp.nitro = 1;
  }

  // ======================= ЗАЕЗД =======================
  // cfg: { track, mode: race|drift|time|duel|elim|free, laps, entries: [{name, car, upg, look, isPlayer, ai}],
  //        seed, catchup, skipCountdown, assist }
  class Race {
    constructor(cfg) {
      this.cfg = cfg; this.track = buildTrack(cfg.track); this.mode = cfg.mode || 'race';
      const tr = this.track;
      this.laps = tr.closed ? Math.max(1, cfg.laps || 1) : 1;
      if (this.mode === 'elim') this.laps = tr.closed ? Math.max(2, cfg.entries.length - 1) : 1;
      this.rng = mulberry32((cfg.seed >>> 0) || 1);
      this.t = 0; this.phase = cfg.skipCountdown ? 'race' : 'countdown'; this.countdown = cfg.skipCountdown ? 0 : 3;
      this.catchup = cfg.catchup !== false && (this.mode === 'race' || this.mode === 'elim');
      this.events = []; this.finishOrder = []; this.elimOrder = []; this.elimRound = 0; this.result = null;
      this.drift = new DriftScorer();
      this.cars = cfg.entries.map((e) => {
        const c = makeCar(carStats(e.car, e.upg), e);
        if (e.ai) {
          c.ai = newAi(e.ai);
          c.prof = speedProfile(tr, c.st);
          c.assist = { tc: true, abs: true, steer: false, auto: true, sens: 1 };
        } else if (cfg.assist) Object.assign(c.assist, cfg.assist);
        return c;
      });
      this.player = this.cars.find((c) => c.isPlayer) || null;
      if (this.player && !this.player.prof) this.player.prof = speedProfile(tr, this.player.st);
      this.grid();
      this.order = this.cars.slice();
      this.updatePlaces();
    }

    grid() {
      const tr = this.track, n = this.cars.length;
      this.cars.forEach((c, k) => {
        const row = Math.floor(k / 2), col = k % 2;
        let s = tr.sStart - 7 - row * 9 - (col ? 3 : 0);
        const d = n === 1 ? 0 : (col ? 1 : -1) * Math.min(3.3, tr.hw - 2);
        if (this.mode === 'duel') s = tr.sStart - 7;
        this.place(c, s, d);
        c.lap = 0; c.nextCp = 0; c.finished = false; c.out = false; c.lapStart = 0; c.lapTimes = []; c.bestLap = 0;
        c.dist = s - tr.sStart; c.lastS = c.pr.s; c.wrongT = 0; c.wrong = false; c.stuckT = 0; c.ghost = 0; c.place = k + 1; c.hits = 0;
      });
    }

    place(c, s, d) {
      const tr = this.track, p = pointAt(tr, s, d);
      c.x = p.x; c.z = p.z; c.h = p.h; c.vx = 0; c.vz = 0; c.w = 0; c.steer = 0; c.prevX = p.x; c.prevZ = p.z;
      c.ti = p.i; c.pr = project(tr, c.x, c.z, p.i, c.pr);
      c.y = c.pr.y; c.surf = c.pr.surf;
    }

    // Вернуть машину на трассу: на полотно рядом, носом по ходу, без столкновений 1.5 с.
    resetCar(c) {
      const tr = this.track, pr = c.pr;
      let d = clamp(pr.d, -(tr.hw - 2), tr.hw - 2);
      for (const o of this.cars) if (o !== c && !o.out && Math.hypot(o.x - c.x, o.z - c.z) < 6) d = d > 0 ? d - 3.5 : d + 3.5;
      this.place(c, pr.s, clamp(d, -(tr.hw - 2), tr.hw - 2));
      c.lastS = c.pr.s; c.ghost = 1.5; c.stuckT = 0; c.wrongT = 0; c.gear = 1;
      if (c.isPlayer) this.events.push({ type: 'reset' });
    }

    // Телепорт для проверок: машина в точке (s, d), скорость вдоль трассы.
    teleport(c, s, d, speed) {
      this.place(c, s, d || 0);
      const v = speed || 0; c.vx = Math.sin(c.h) * v; c.vz = Math.cos(c.h) * v;
      c.lastS = c.pr.s;
    }

    step(dt, pin) {
      dt = dt || DT;
      if (this.phase === 'countdown') {
        const before = Math.ceil(this.countdown);
        this.countdown -= dt;
        if (Math.ceil(this.countdown) !== before && this.countdown > 0) this.events.push({ type: 'count', n: Math.ceil(this.countdown) });
        if (this.countdown <= 0) { this.phase = 'race'; this.events.push({ type: 'go' }); }
      }
      const tr = this.track, racing = this.phase !== 'countdown';
      if (this.phase === 'race') this.t += dt;
      for (const c of this.cars) {
        if (c.out) continue;
        c.hit = 0;
        if (c.isPlayer && !c.finished && pin) {
          const q = c.inp;
          q.thr = pin.thr || 0; q.brk = pin.brk || 0; q.steer = pin.steer || 0; q.hb = pin.hb ? 1 : 0; q.nitro = pin.nitro ? 1 : 0; q.analog = !!pin.analog;
          if (pin.shiftUp) { q.shiftUp = true; pin.shiftUp = false; }
          if (pin.shiftDown) { q.shiftDown = true; pin.shiftDown = false; }
        } else if (c.ai || c.finished) {
          if (!c.ai) { c.ai = newAi({ pace: 0.7, nitro: false }); c.assist = { tc: true, abs: true, steer: false, auto: true, sens: 1 }; }
          aiControl(this, c, dt);
        }
        if (!racing) {
          // до старта машины стоят, мотор можно погазовать
          const rpmT = 900 + 6200 * clamp(c.inp.thr, 0, 1);
          c.rpm += (rpmT - c.rpm) * Math.min(1, dt * 8); c.rpmN = c.rpm / 8000;
          continue;
        }
        c.prevX = c.x; c.prevZ = c.z;
        stepCar(c, dt, c.onRunoff ? tr.runoffSurf : c.surf);
        this.trackCar(c);
      }
      if (!racing) return;
      this.collideCars();
      for (const c of this.cars) {
        if (c.out) continue;
        if (c.ghost > 0) c.ghost -= dt;
        this.gates(c);
        const pr = c.pr;
        const along = c.vx * pr.tx + c.vz * pr.tz, face = Math.sin(c.h) * pr.tx + Math.cos(c.h) * pr.tz;
        if (along < -3 || (face < -0.5 && c.speed > 2)) c.wrongT += dt; else c.wrongT = Math.max(0, c.wrongT - dt * 2);
        c.wrong = c.wrongT > 1;
        if (c.ai && !c.isPlayer) {
          if (c.speed < 1.5 || c.wrong) c.stuckT += dt; else c.stuckT = 0;
          if (c.stuckT > 3) this.resetCar(c);
        }
        if (c.hit > 2.5) c.hits++;
        c.nitro = Math.min(1, c.nitro + dt * 0.012);
      }
      const p = this.player;
      if (p && !p.finished && !p.out && this.phase === 'race') {
        const onRoad = Math.abs(p.pr.d) < tr.hw + 0.6;
        const banked = this.drift.update(dt, Math.abs(p.beta) * 180 / Math.PI, p.speed, onRoad);
        if (banked) this.events.push({ type: 'driftBank', pts: banked });
        if (this.drift.drifting) p.nitro = Math.min(1, p.nitro + dt * 0.05);
        if (p.hit > 2.5) { const lost = this.drift.crash(); if (lost) this.events.push({ type: 'comboLost' }); }
      }
      for (const c of this.cars) if (c.hit > 1.5) this.events.push({ type: 'hit', car: c, v: c.hit });
      this.updatePlaces();
      if (this.mode === 'elim') this.checkElim();
      if (this.phase === 'race' && p && (p.finished || p.out)) this.finish();
      if (this.phase === 'race' && !p && this.cars.every((c) => c.finished || c.out)) this.finish();
    }

    trackCar(c) {
      const tr = this.track;
      const pr = project(tr, c.x, c.z, c.ti, c.pr);
      c.ti = pr.i; c.pr = pr;
      // концы трассы «из точки в точку»
      if (!tr.closed && ((pr.i === 0 && pr.along < 0) || (pr.i >= tr.N - 2 && pr.t >= 1 && pr.along > 0))) {
        c.x -= pr.along * pr.tx; c.z -= pr.along * pr.tz;
        const va = c.vx * pr.tx + c.vz * pr.tz;
        if (va * pr.along > 0) { c.vx -= va * pr.tx * 1.3; c.vz -= va * pr.tz * 1.3; c.hit = Math.max(c.hit, Math.abs(va)); }
      }
      // стены: концы машины (±1.7 м) не дальше W от оси; удар - импульс с плечом
      const lim = tr.W - 0.95, m = c.st.mass, I = c.st.I;
      for (let e = 0; e < 2; e++) {
        const sk = e ? -1.7 : 1.7;
        const fdn = Math.sin(c.h) * pr.nx + Math.cos(c.h) * pr.nz;
        const dk = pr.d + fdn * sk;
        if (Math.abs(dk) <= lim) continue;
        const sg = dk > 0 ? 1 : -1, onx = sg * pr.nx, onz = sg * pr.nz, pen = Math.abs(dk) - lim;
        c.x -= onx * pen; c.z -= onz * pen; pr.d -= sg * pen;
        const rxv = -Math.cos(c.h), rzv = Math.sin(c.h);
        const vpx = c.vx + c.w * sk * rxv, vpz = c.vz + c.w * sk * rzv;
        const vn = vpx * onx + vpz * onz;
        if (vn > 0) {
          const lever = sk * (rxv * onx + rzv * onz);
          const J = 1.3 * vn / (1 / m + lever * lever / I);
          c.vx -= J / m * onx; c.vz -= J / m * onz; c.w -= J * lever / I;
          const vnn = c.vx * onx + c.vz * onz, tvx = c.vx - vnn * onx, tvz = c.vz - vnn * onz, tv = Math.hypot(tvx, tvz);
          if (tv > 0.01) { const dv = Math.min(tv, 0.3 * J / m); c.vx -= tvx / tv * dv; c.vz -= tvz / tv * dv; }
          c.hit = Math.max(c.hit, vn);
        }
      }
      c.y = pr.y; c.surf = pr.surf; c.onRunoff = Math.abs(pr.d) > tr.hw + 0.4;
      let ds = pr.s - c.lastS;
      if (tr.closed) { if (ds > tr.L / 2) ds -= tr.L; else if (ds < -tr.L / 2) ds += tr.L; }
      c.lastS = pr.s; c.dist += clamp(ds, -6, 6);
    }

    collideCars() {
      const cs = this.cars;
      for (let i = 0; i < cs.length; i++) {
        const a = cs[i]; if (a.out || a.ghost > 0) continue;
        for (let j = i + 1; j < cs.length; j++) {
          const b = cs[j]; if (b.out || b.ghost > 0) continue;
          if (Math.abs(a.x - b.x) > 6 || Math.abs(a.z - b.z) > 6) continue;
          for (let ka = -1.15; ka <= 1.15; ka += 2.3) {
            for (let kb = -1.15; kb <= 1.15; kb += 2.3) {
              const ax = a.x + Math.sin(a.h) * ka, az = a.z + Math.cos(a.h) * ka;
              const bx = b.x + Math.sin(b.h) * kb, bz = b.z + Math.cos(b.h) * kb;
              let dx = bx - ax, dz = bz - az; const d = Math.hypot(dx, dz);
              if (d >= 2 || d < 1e-6) continue;
              dx /= d; dz /= d;
              const ima = 1 / a.st.mass, imb = 1 / b.st.mass, pen = 2 - d;
              a.x -= dx * pen * ima / (ima + imb); a.z -= dz * pen * ima / (ima + imb);
              b.x += dx * pen * imb / (ima + imb); b.z += dz * pen * imb / (ima + imb);
              const rax = -Math.cos(a.h), raz = Math.sin(a.h), rbx = -Math.cos(b.h), rbz = Math.sin(b.h);
              const vax = a.vx + a.w * ka * rax, vaz = a.vz + a.w * ka * raz, vbx = b.vx + b.w * kb * rbx, vbz = b.vz + b.w * kb * rbz;
              const vrel = (vbx - vax) * dx + (vbz - vaz) * dz;
              if (vrel >= 0) continue;
              const la = ka * (rax * dx + raz * dz), lb = kb * (rbx * dx + rbz * dz);
              const J = -1.3 * vrel / (ima + imb + la * la / a.st.I + lb * lb / b.st.I);
              b.vx += J * imb * dx; b.vz += J * imb * dz; b.w += J * lb / b.st.I;
              a.vx -= J * ima * dx; a.vz -= J * ima * dz; a.w -= J * la / a.st.I;
              a.hit = Math.max(a.hit, -vrel); b.hit = Math.max(b.hit, -vrel);
            }
          }
        }
      }
    }

    crossed(c, g) {
      const a = (c.prevX - g.x) * g.tx + (c.prevZ - g.z) * g.tz, b = (c.x - g.x) * g.tx + (c.z - g.z) * g.tz;
      if (!(a < 0 && b >= 0)) return false;
      return Math.abs((c.x - g.x) * g.nx + (c.z - g.z) * g.nz) < this.track.W + 1.5;
    }

    // Чекпоинты строго по порядку; круг засчитывается, только если взяты все.
    gates(c) {
      const tr = this.track, cps = tr.cps;
      if (c.finished) return;
      if (tr.closed) {
        const K = cps.length;
        if (c.nextCp < K && this.crossed(c, cps[c.nextCp])) {
          c.nextCp++;
          if (c.isPlayer && c.nextCp > 1) this.events.push({ type: 'cp', n: c.nextCp - 1 });
        } else if (c.nextCp === K && this.crossed(c, cps[0])) {
          c.lap++; const lt = this.t - c.lapStart; c.lapTimes.push(lt); if (!c.bestLap || lt < c.bestLap) c.bestLap = lt;
          c.lapStart = this.t; c.nextCp = 1;
          if (c.lap >= this.laps) this.finishCar(c); else if (c.isPlayer) this.events.push({ type: 'lap', lap: c.lap + 1, time: lt });
        } else if (c.nextCp > 1 && c.nextCp < K && this.crossed(c, cps[0])) {
          if (c.isPlayer) this.events.push({ type: 'missed' });
        }
      } else {
        const K = cps.length - 1;
        if (c.nextCp <= K && this.crossed(c, cps[c.nextCp])) {
          c.nextCp++;
          if (c.nextCp === K + 1) { c.lap = 1; const lt = this.t; c.lapTimes.push(lt); c.bestLap = lt; this.finishCar(c); } else if (c.isPlayer && c.nextCp > 1) this.events.push({ type: 'cp', n: c.nextCp - 1 });
        } else if (c.nextCp < K && c.nextCp > 0 && this.crossed(c, cps[K])) {
          if (c.isPlayer) this.events.push({ type: 'missed' });
        }
      }
    }

    finishCar(c) {
      c.finished = true; c.finishT = this.t; this.finishOrder.push(c);
      if (c.isPlayer) this.events.push({ type: 'finish' });
    }

    rankKey(c) {
      if (c.finished) return 1e9 - c.finishT;
      if (c.out) return -1e9 + c.outT;
      return c.dist;
    }
    updatePlaces() {
      const arr = this.cars.slice().sort((a, b) => this.rankKey(b) - this.rankKey(a));
      arr.forEach((c, i) => { c.place = i + 1; });
      this.order = arr;
    }

    // На вылет: когда лидер закрывает круг, последний из оставшихся выбывает.
    checkElim() {
      if (this.phase !== 'race') return;
      let lead = 0;
      for (const c of this.cars) if (!c.out) lead = Math.max(lead, c.lap);
      while (lead > this.elimRound && this.elimRound < this.laps - 1) {
        this.elimRound++;
        const alive = this.order.filter((c) => !c.out && !c.finished);
        const last = alive[alive.length - 1];
        if (!last || alive.length < 2) break;
        last.out = true; last.outT = this.t; this.elimOrder.push(last);
        this.events.push({ type: 'elim', car: last });
        this.updatePlaces();
      }
    }

    totalDist() { return this.laps * this.track.lapLen; }

    finish() {
      this.phase = 'done';
      const p = this.player, total = this.totalDist();
      if (p && !p.out) { const b = this.drift.bank(); if (b) this.events.push({ type: 'driftBank', pts: b }); }
      const rows = this.cars.map((c) => {
        let time = null, est = false;
        if (c.finished) time = c.finishT;
        else if (!c.out) {
          const avg = Math.max(8, (c.dist + 20) / Math.max(1, this.t));
          time = this.t + Math.max(0, total - c.dist) / avg; est = true;
        }
        return { name: c.name, carId: c.carId, isPlayer: c.isPlayer, time, est, out: c.out, outT: c.outT || 0, bestLap: c.bestLap || 0 };
      });
      rows.sort((a, b) => {
        if (a.out !== b.out) return a.out ? 1 : -1;
        if (a.out) return b.outT - a.outT;
        return a.time - b.time;
      });
      rows.forEach((r, i) => { r.place = i + 1; });
      const pr = rows.find((r) => r.isPlayer);
      this.result = {
        mode: this.mode, track: this.track.id, laps: this.laps, table: rows,
        place: pr ? pr.place : 0, time: p && p.finished ? p.finishT : null, bestLap: p ? p.bestLap : 0, lapTimes: p ? p.lapTimes.slice() : [],
        drift: this.drift.total, driftBest: this.drift.best, out: p ? p.out : false, hits: p ? p.hits : 0,
      };
      this.events.push({ type: 'done' });
      return this.result;
    }

    run(maxSeconds, pin) {
      const n = Math.round(maxSeconds / DT);
      for (let i = 0; i < n && this.phase !== 'done'; i++) this.step(DT, pin);
      return this.result;
    }
  }

  // Бот на идеальной линии (темп pace, без ошибок): время заезда. По нему считаются медали «на время».
  const refCache = {};
  function botTime(trackId, carId, upg, pace, mistakes, seed) {
    const key = [trackId, carId, JSON.stringify(upg || {}), pace, mistakes, seed].join('|');
    if (refCache[key] !== undefined) return refCache[key];
    const r = new Race({ track: trackId, mode: 'time', laps: 1, skipCountdown: true, seed: seed || 1,
      entries: [{ name: 'Эталон', car: carId, upg, ai: { pace: pace || 1, mistakes: mistakes || 0, nitro: true } }] });
    r.run(400);
    const c = r.cars[0];
    const t = c.finished ? c.finishT : null;
    refCache[key] = t;
    return t;
  }
  const TIME_MEDALS = [1.05, 1.12, 1.22];
  function timeThresholds(evt) {
    const ref = botTime(evt.track, evt.ref, {}, 1, 0, 1);
    return TIME_MEDALS.map((k) => Math.round(ref * k * 100) / 100);
  }

  // ======================= КАРЬЕРА =======================
  const MEDAL_RANK = { gold: 3, silver: 2, bronze: 1 };
  function medalFor(evt, res) {
    if (!res) return null;
    if (evt.type === 'race' || evt.type === 'elim') return res.place === 1 ? 'gold' : res.place === 2 ? 'silver' : res.place === 3 ? 'bronze' : null;
    if (evt.type === 'duel') return res.place === 1 ? 'gold' : null;
    if (evt.type === 'drift') { const g = evt.goal; return res.drift >= g[0] ? 'gold' : res.drift >= g[1] ? 'silver' : res.drift >= g[2] ? 'bronze' : null; }
    if (evt.type === 'time') {
      if (res.time == null) return null;
      const th = res.thresholds || timeThresholds(evt);
      return res.time <= th[0] ? 'gold' : res.time <= th[1] ? 'silver' : res.time <= th[2] ? 'bronze' : null;
    }
    return null;
  }
  function rewardFor(evt, cup, res, medal) {
    const base = D.BASE_REWARD * cup.mult;
    let share;
    if (evt.type === 'race' || evt.type === 'elim') share = D.PLACE_SHARE[res.place - 1] || 0.05;
    else if (evt.type === 'duel') share = res.place === 1 ? 1 : 0.15;
    else share = D.MEDAL_SHARE[medal || 'none'];
    return Math.round(base * share / 10) * 10;
  }
  function findEvent(id) {
    for (let ci = 0; ci < D.CUPS.length; ci++) { const e = D.CUPS[ci].events.find((x) => x.id === id); if (e) return { evt: e, cup: D.CUPS[ci], ci }; }
    return null;
  }
  function newCareer() {
    return { v: 1, money: 0, owned: ['iskra'], current: 'iskra', upg: {}, looks: {}, res: {}, victory: false,
      stats: { races: 0, wins: 0, earned: 0, spent: 0, driftBest: 0 } };
  }
  function defaultLook(carId) { const d = carDef(carId); return { color: d.color, color2: '#f4f4f4', rims: 'spoke5', rimColor: '#c9ced6', livery: 'none' }; }

  class Career {
    constructor(data, save) {
      this.d = Object.assign(newCareer(), data || {});
      this.d.stats = Object.assign(newCareer().stats, this.d.stats || {});
      this.d.res = this.d.res || {}; this.d.upg = this.d.upg || {}; this.d.looks = this.d.looks || {};
      if (!Array.isArray(this.d.owned) || !this.d.owned.length) this.d.owned = ['iskra'];
      if (!this.d.owned.includes(this.d.current)) this.d.current = this.d.owned[0];
      if (!(this.d.money >= 0)) this.d.money = 0;
      this.save = save || (() => {});
    }
    get money() { return this.d.money; }
    cupComplete(i) { return D.CUPS[i].events.every((e) => this.d.res[e.id] && this.d.res[e.id].medal); }
    cupUnlocked(i) { return i === 0 || this.cupComplete(i - 1); }
    cupMedals(i) {
      const o = { gold: 0, silver: 0, bronze: 0 };
      for (const e of D.CUPS[i].events) { const r = this.d.res[e.id]; if (r && r.medal) o[r.medal]++; }
      return o;
    }
    eventMedal(id) { const r = this.d.res[id]; return r ? r.medal || null : null; }
    allComplete() { return D.CUPS.every((c, i) => this.cupComplete(i)); }
    // Итог заезда карьеры: медаль (лучшая остаётся), деньги, открытие кубка, победа в карьере.
    applyResult(evtId, res) {
      const f = findEvent(evtId); if (!f) return null;
      const { evt, cup, ci } = f;
      if (!this.cupUnlocked(ci)) return null;
      const wasComplete = this.cupComplete(ci), wasAll = this.allComplete();
      const medal = medalFor(evt, res);
      const reward = rewardFor(evt, cup, res, medal);
      const prev = this.d.res[evtId] || {};
      const better = medal && (!prev.medal || MEDAL_RANK[medal] > MEDAL_RANK[prev.medal]);
      const rec = Object.assign({}, prev);
      if (better) rec.medal = medal;
      if (evt.type === 'drift') rec.best = Math.max(prev.best || 0, res.drift || 0);
      else if (evt.type === 'time') { if (res.time != null && (!prev.best || res.time < prev.best)) rec.best = res.time; } else if (!prev.best || res.place < prev.best) rec.best = res.place;
      this.d.res[evtId] = rec;
      this.d.money += reward;
      this.d.stats.races++; this.d.stats.earned += reward;
      if (res.place === 1 && evt.type !== 'drift' && evt.type !== 'time') this.d.stats.wins++;
      if (res.driftBest) this.d.stats.driftBest = Math.max(this.d.stats.driftBest, res.driftBest);
      const cupDone = !wasComplete && this.cupComplete(ci);
      const victory = !wasAll && this.allComplete();
      if (victory) this.d.victory = true;
      this.save(this.d);
      return { medal, reward, better: !!better, cupDone, unlocked: cupDone && ci + 1 < D.CUPS.length ? D.CUPS[ci + 1] : null, victory };
    }
    owns(id) { return this.d.owned.includes(id); }
    buyCar(id) {
      const def = D.CARS.find((c) => c.id === id);
      if (!def) return { ok: false, reason: 'Нет такой машины' };
      if (this.owns(id)) return { ok: false, reason: 'Уже в гараже' };
      if (this.d.money < def.price) return { ok: false, reason: 'Не хватает денег' };
      this.d.money -= def.price; this.d.stats.spent += def.price; this.d.owned.push(id); this.d.current = id;
      this.save(this.d);
      return { ok: true };
    }
    select(id) { if (!this.owns(id)) return false; this.d.current = id; this.save(this.d); return true; }
    levels(carId) { return upgradeLevels(this.d.upg[carId]); }
    upgradePrice(carId, kind) {
      const lv = this.levels(carId)[kind];
      if (lv >= D.UPG_MAX) return null;
      return Math.round(D.UPG_PRICE[lv] * D.TIER_MUL[carDef(carId).tier] / 50) * 50;
    }
    buyUpgrade(carId, kind) {
      if (!this.owns(carId)) return { ok: false, reason: 'Машины нет в гараже' };
      const price = this.upgradePrice(carId, kind);
      if (price == null) return { ok: false, reason: 'Уже максимум' };
      if (this.d.money < price) return { ok: false, reason: 'Не хватает денег' };
      this.d.money -= price; this.d.stats.spent += price;
      const u = Object.assign({}, this.d.upg[carId] || {}); u[kind] = (u[kind] || 0) + 1; this.d.upg[carId] = u;
      this.save(this.d);
      return { ok: true, price };
    }
    look(carId) { return Object.assign(defaultLook(carId), this.d.looks[carId] || {}); }
    setLook(carId, patch) { this.d.looks[carId] = Object.assign(this.look(carId), patch); this.save(this.d); }
    stats(carId) { return carStats(carId, this.d.upg[carId]); }
  }

  // Соперники для события карьеры: машины из «пула» кубка, темп по кубку и сложности.
  function eventEntries(evt, ci, opts) {
    const cup = D.CUPS[ci], diff = D.DIFFICULTY[opts.difficulty] || D.DIFFICULTY.normal;
    const rng = mulberry32(hashStr(evt.id) ^ (opts.seed || 0));
    const player = { name: 'Вы', car: opts.car, upg: opts.upg, look: opts.look, isPlayer: true };
    const upgFor = (lvl) => ({ engine: lvl, tyres: lvl, susp: lvl, weight: lvl, nitro: lvl });
    const aiLvl = [0, 1, 1, 2, 3][ci] || 0;
    if (evt.type === 'time' || evt.type === 'drift') return [player];
    const entries = [];
    if (evt.type === 'duel') {
      const car = cup.pool[cup.pool.length - 1];
      entries.push({ name: D.RIVALS[cup.id] || 'Соперник', car, upg: upgFor(Math.min(3, aiLvl + 1)), rival: true,
        ai: { pace: clamp(cup.pace + diff.pace + 0.03, 0.6, 1.02), mistakes: diff.mistakes * 0.6, laneBase: 0 } });
      entries.push(player);
      return entries;
    }
    const n = evt.opp || 3, names = D.DRIVERS.slice();
    for (let k = 0; k < n; k++) {
      const car = cup.pool[Math.floor(rng() * cup.pool.length)];
      const name = names.splice(Math.floor(rng() * names.length), 1)[0];
      const spread = (k / Math.max(1, n - 1) - 0.5) * 0.04;          // соперники немного разные по силе
      entries.push({ name, car, upg: upgFor(aiLvl), ai: { pace: clamp(cup.pace + diff.pace + spread, 0.6, 1.02), mistakes: diff.mistakes, laneBase: (rng() - 0.5) * 1.6 } });
    }
    entries.push(player);
    return entries;
  }

  // ======================= НАСТРОЙКИ =======================
  function mergeSettings(saved) {
    const s = JSON.parse(JSON.stringify(D.DEFAULT_SETTINGS));
    if (saved && typeof saved === 'object') {
      for (const k in s) if (k !== 'bindings' && saved[k] !== undefined && typeof saved[k] === typeof s[k]) s[k] = saved[k];
      if (saved.bindings) for (const a in s.bindings) if (Array.isArray(saved.bindings[a])) s.bindings[a] = [String(saved.bindings[a][0] || ''), String(saved.bindings[a][1] || '')];
    }
    return s;
  }
  // Назначить клавишу действию. Если клавиша занята другим действием - конфликт: клавиши меняются местами.
  function rebind(bindings, action, slot, code) {
    const b = JSON.parse(JSON.stringify(bindings));
    let conflict = null;
    const old = b[action][slot];
    for (const a in b) {
      for (let k = 0; k < 2; k++) {
        if ((a !== action || k !== slot) && code && b[a][k] === code) {
          if (a !== action) conflict = { action: a, slot: k };
          b[a][k] = old || '';
        }
      }
    }
    b[action][slot] = code;
    return { bindings: b, conflict };
  }
  function toUnits(ms, units) { return units === 'mph' ? ms * 2.23694 : ms * 3.6; }
  function fmtTime(t) {
    if (t == null || !isFinite(t)) return '--:--.--';
    const m = Math.floor(t / 60), s = t - m * 60;
    return m + ':' + (s < 10 ? '0' : '') + s.toFixed(2);
  }

  return { G, DT, STEP, GEARS, clamp, lerp, mulberry32, hashStr, buildTrack, project, pointAt, idxAt, trackClearance, solveAutos, runTurtle,
    carDef, carStats, upgradeLevels, makeCar, stepCar, accelTime, surfMu, DriftScorer, speedProfile, Race, botTime, timeThresholds, TIME_MEDALS,
    medalFor, rewardFor, findEvent, newCareer, defaultLook, Career, eventEntries, mergeSettings, rebind, toUnits, fmtTime, MEDAL_RANK };
});
