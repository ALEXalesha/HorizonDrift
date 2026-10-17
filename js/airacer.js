/* Horizon Drift - ИИ-гонщики AiRacer: нейросеть рулит машиной соперника через те же органы управления, что у игрока.
   Что видит гонщик - только то, что видит водитель: лучи до стен и машин, своя скорость и занос, дорога на 5 точек вперёд.
   Ни гоночной линии, ни профиля скорости, ни знания о будущих манёврах соперников.
   Код датчиков, сети и «рук» - из проекта AiRacer (src/sensors.js, src/mlp.js, src/driver.js, src/trackgeo.js) без изменений
   смысла: сеть училась ровно на этих числах. Решение - раз в 4 шага физики (30 раз в секунду), как при обучении.
   Работает в странице (window.DriftAI) и в node (require) - для проверок. */
(function (root, factory) {
  const C = root.DriftCore || (typeof require === 'function' ? require('./core.js') : null);
  const M = root.DriftAiModels || (typeof require === 'function' ? require('./airacer-models.js') : null);
  const api = factory(C, M);
  if (typeof module === 'object' && module.exports) module.exports = api; else root.DriftAI = api;
})(typeof self !== 'undefined' ? self : this, function (C, MODELS) {
  'use strict';

  // ---------- геометрия трассы (AiRacer src/trackgeo.js) ----------
  const geoCache = new WeakMap();
  // Кривизна осевой линии (1/м, + - поворот направо), слегка сглаженная, и линии стен там, где игра
  // останавливает концы машины (W - 0.95).
  function trackGeo(tr) {
    let g = geoCache.get(tr);
    if (g) return g;
    const N = tr.N, k = new Float64Array(N), ks = new Float64Array(N);
    const at = (i) => (tr.closed ? ((i % N) + N) % N : Math.max(0, Math.min(N - 1, i)));
    for (let i = 0; i < N; i++) {
      const a = at(i - 2), b = at(i + 2);
      const cross = tr.tx[a] * tr.tz[b] - tr.tz[a] * tr.tx[b];
      const dot = tr.tx[a] * tr.tx[b] + tr.tz[a] * tr.tz[b];
      const span = tr.closed ? 4 : (b - a);
      k[i] = span > 0 ? Math.atan2(cross, dot) / (span * tr.step) : 0;
    }
    for (let i = 0; i < N; i++) {
      let s = 0, c = 0;
      for (let j = -2; j <= 2; j++) { const q = i + j; if (!tr.closed && (q < 0 || q >= N)) continue; s += k[at(q)]; c++; }
      ks[i] = s / c;
    }
    const lim = tr.W - 0.95;
    const lx = new Float64Array(N), lz = new Float64Array(N), rx = new Float64Array(N), rz = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      lx[i] = tr.x[i] + tr.nx[i] * lim; lz[i] = tr.z[i] + tr.nz[i] * lim;
      rx[i] = tr.x[i] - tr.nx[i] * lim; rz[i] = tr.z[i] - tr.nz[i] * lim;
    }
    g = { kappa: ks, lim, lx, lz, rx, rz };
    geoCache.set(tr, g);
    return g;
  }
  // Самая длинная почти прямая (м).
  function longestStraight(tr, kMax) {
    const g = trackGeo(tr), N = tr.N;
    let best = 0, run = 0;
    const loops = tr.closed ? 2 : 1;
    for (let p = 0; p < loops * N; p++) {
      const i = p % N;
      if (Math.abs(g.kappa[i]) < kMax) { run += tr.step; if (run > best) best = run; } else run = 0;
    }
    return Math.min(best, tr.L);
  }
  // Самый крутой уклон дороги (подъём на метр пути).
  function maxGrade(tr) {
    let m = 0;
    for (let i = 0; i < tr.N; i++) {
      const j = tr.closed ? (i + 1) % tr.N : Math.min(tr.N - 1, i + 1);
      if (j === i) continue;
      m = Math.max(m, Math.abs(tr.y[j] - tr.y[i]) / tr.step);
    }
    return m;
  }

  // ---------- датчики (AiRacer src/sensors.js) ----------
  const RAY_ANGLES = [-90, -55, -30, -15, -5, 0, 5, 15, 30, 55, 90].map((a) => a * Math.PI / 180);
  const RAY_MAX = 90;
  const LOOK = [10, 22, 38, 60, 90];            // метров вперёд по дороге
  const OBS_SIZE = 9 + RAY_ANGLES.length + LOOK.length * 3;

  // Луч (ox,oz)+t(dx,dz) и отрезок a-b: расстояние вдоль луча или Infinity.
  function raySeg(ox, oz, dx, dz, ax, az, bx, bz) {
    const ex = bx - ax, ez = bz - az, den = dx * ez - dz * ex;
    if (Math.abs(den) < 1e-12) return Infinity;
    const wx = ax - ox, wz = az - oz;
    const t = (wx * ez - wz * ex) / den, u = (wx * dz - wz * dx) / den;
    return t >= 0 && u >= 0 && u <= 1 ? t : Infinity;
  }

  // Расстояния (м) по каждому лучу до стены и до кузовов других машин.
  function rays(race, car, out) {
    const tr = race.track, g = trackGeo(tr), N = tr.N, i0 = car.pr.i;
    const from = i0 - 12, to = i0 + Math.ceil(RAY_MAX / tr.step) + 14;
    for (let r = 0; r < RAY_ANGLES.length; r++) {
      const a = car.h + RAY_ANGLES[r], dx = Math.sin(a), dz = Math.cos(a);
      let best = RAY_MAX;
      for (let j = from; j < to; j++) {
        let i = j, k = j + 1;
        if (tr.closed) { i = ((i % N) + N) % N; k = ((k % N) + N) % N; } else if (i < 0 || k >= N) continue;
        const tl = raySeg(car.x, car.z, dx, dz, g.lx[i], g.lz[i], g.lx[k], g.lz[k]);
        if (tl < best) best = tl;
        const tr2 = raySeg(car.x, car.z, dx, dz, g.rx[i], g.rz[i], g.rx[k], g.rz[k]);
        if (tr2 < best) best = tr2;
      }
      for (const o of race.cars) {
        if (o === car || o.out || Math.abs(o.x - car.x) > RAY_MAX || Math.abs(o.z - car.z) > RAY_MAX) continue;
        const cs = C.carCorners(o);
        for (let q = 0; q < 4; q++) {
          const p1 = cs[q], p2 = cs[(q + 1) & 3];
          const t = raySeg(car.x, car.z, dx, dz, p1[0], p1[1], p2[0], p2[1]);
          if (t < best) best = t;
        }
      }
      out[r] = best;
    }
    return out;
  }

  const wrap = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
  const rayBuf = new Float64Array(RAY_ANGLES.length);

  // Вектор наблюдения, все числа примерно в -1..1.
  function observe(race, car, out) {
    out = out || new Float64Array(OBS_SIZE);
    const tr = race.track, g = trackGeo(tr), st = car.st, pr = car.pr;
    const fx = Math.sin(car.h), fz = Math.cos(car.h);
    const vLong = car.vx * fx + car.vz * fz, vLat = car.vx * -fz + car.vz * fx;
    const roadH = Math.atan2(pr.tx, pr.tz);
    let o = 0;
    out[o++] = car.speed / 50;
    out[o++] = vLat / 15;
    out[o++] = Math.max(-1, Math.min(1, car.beta));
    out[o++] = car.w / 1.5;
    out[o++] = car.steer / st.steer;
    out[o++] = pr.d / tr.W;
    out[o++] = Math.sin(wrap(car.h - roadH));
    out[o++] = C.surfMu(car.onRunoff ? tr.runoffSurf : car.surf, st) * st.grip / 1.3;         // сцепление под машиной
    out[o++] = vLong < -1 ? -1 : car.wrong ? -0.5 : 1;
    const rr = rays(race, car, rayBuf);
    for (let r = 0; r < rr.length; r++) out[o++] = rr[r] / RAY_MAX;
    for (const ahead of LOOK) {
      const p = C.pointAt(tr, pr.s + ahead, 0);
      const dx = p.x - car.x, dz = p.z - car.z;
      out[o++] = Math.atan2(dx * -fz + dz * fx, dx * fx + dz * fz) / Math.PI;      // где эта точка
      out[o++] = Math.sin(wrap(p.h - car.h));                                        // куда там идёт дорога
      out[o++] = Math.max(-1, Math.min(1, g.kappa[p.i] * 20));                      // насколько круто там поворот
    }
    return out;
  }

  // ---------- сеть (AiRacer src/mlp.js): tanh в скрытых слоях, линейный выход ----------
  class MLP {
    constructor(sizes, params) {
      this.sizes = sizes.slice();
      let n = 0; for (let l = 0; l + 1 < sizes.length; l++) n += sizes[l] * sizes[l + 1] + sizes[l + 1];
      this.n = n;
      this.p = Float64Array.from(params);
      if (this.p.length !== n) throw new Error(`MLP ${sizes.join('-')} needs ${n} params, got ${this.p.length}`);
      this.bufs = sizes.map((s) => new Float64Array(s));
    }
    forward(x) {
      const S = this.sizes, P = this.p;
      let a = x, off = 0;
      for (let l = 0; l + 1 < S.length; l++) {
        const nin = S[l], nout = S[l + 1], out = this.bufs[l + 1], last = l + 2 === S.length;
        for (let j = 0; j < nout; j++) {
          let s = P[off + nin * nout + j];
          const w = off + j * nin;
          for (let i = 0; i < nin; i++) s += P[w + i] * a[i];
          out[j] = last ? s : Math.tanh(s);
        }
        off += nin * nout + nout;
        a = out;
      }
      return a;
    }
  }
  const netCache = {};
  function netOf(kind) {
    if (!netCache[kind]) { const m = MODELS[kind]; if (!m) throw new Error('нет модели ИИ ' + kind); netCache[kind] = m.net; }
    return new MLP(netCache[kind].sizes, netCache[kind].params);   // у каждой машины своя сеть: буферы не общие
  }

  // ---------- «руки» (AiRacer src/driver.js): уровень = задержка реакции, шум руля, мягче газ ----------
  const HANDS = {
    ace: { delay: 0, steerNoise: 0, pedalMax: 1, label: 'ас' },
    pro: { delay: 1, steerNoise: 0.04, pedalMax: 1, label: 'профи' },
    amateur: { delay: 2, steerNoise: 0.09, pedalMax: 0.9, label: 'любитель' },
    rookie: { delay: 3, steerNoise: 0.15, pedalMax: 0.8, label: 'новичок' },
    // дрифт: большой шум руля только бьёт машину, поэтому слабее сам занос - ручник иногда пропущен, газ мягче
    'drift-ace': { delay: 0, steerNoise: 0, pedalMax: 1, label: 'дрифт: ас' },
    'drift-pro': { delay: 1, steerNoise: 0.02, hbMiss: 0.3, pedalMax: 0.95, label: 'дрифт: профи' },
    'drift-amateur': { delay: 1, steerNoise: 0.03, hbMiss: 0.6, pedalMax: 0.85, label: 'дрифт: любитель' },
    'drift-rookie': { delay: 2, steerNoise: 0.04, hbMiss: 0.85, pedalMax: 0.75, label: 'дрифт: новичок' },
  };

  // Осторожность слабого уровня (в AiRacer её нет): водитель видит, как круто поворачивает дорога впереди и как держит
  // покрытие под машиной (это те же числа наблюдения), и не едет в поворот быстрее доли pace от предела сцепления,
  // тормозя заранее. Как темп у бота игры, но только по тому, что видно с места водителя.
  const OBS_K = 9 + RAY_ANGLES.length;            // начало точек «дорога впереди» в наблюдении
  function caution(obs, a, pace) {
    const v = obs[0] * 50, mu = Math.max(0.3, obs[7] * 1.3) * 9.81;
    let vlim = 1e9;
    for (let j = 0; j < LOOK.length; j++) {
      const k = Math.abs(obs[OBS_K + j * 3 + 2]) / 20;
      if (k < 1 / 400) continue;
      const vc = pace * Math.sqrt(mu / k);
      vlim = Math.min(vlim, Math.sqrt(vc * vc + 2 * mu * 0.6 * Math.max(0, LOOK[j] - 6)));
    }
    if (v > vlim + 0.5) { a.thr = 0; a.nitro = 0; a.brk = Math.max(a.brk, Math.min(1, Math.max(0.2, (v - vlim) / 4))); }
    else if (v > vlim - 1) { a.thr = Math.min(a.thr, 0.3); a.nitro = 0; }
  }

  class NeuralDriver {
    constructor(net, opts) {
      opts = opts || {};
      this.net = net;
      this.hands = Object.assign({}, HANDS.ace, typeof opts.hands === 'string' ? HANDS[opts.hands] : opts.hands || {});
      this.rng = C.mulberry32((opts.seed >>> 0) || 7);
      this.queue = [];
      this.last = { thr: 0, brk: 0, steer: 0, hb: 0, nitro: 0, analog: true };
    }
    reset() { this.queue.length = 0; }
    act(obs) {
      const o = this.net.forward(obs), h = this.hands;
      const pedal = Math.tanh(o[1]);
      let steer = Math.tanh(o[0]);
      if (h.steerNoise) steer += h.steerNoise * (this.rng() + this.rng() + this.rng() - 1.5) * 2;
      const a = {
        steer: Math.max(-1, Math.min(1, steer)),
        thr: pedal > 0 ? Math.min(h.pedalMax, pedal) : 0,
        brk: pedal < 0 ? -pedal : 0,
        hb: o[2] > 0.5 && !(h.hbMiss && this.rng() < h.hbMiss) ? 1 : 0,
        nitro: o[3] > 0 ? 1 : 0,
        analog: true,
      };
      if (h.pace && h.pace < 1) caution(obs, a, h.pace);
      if (!h.delay) return (this.last = a);
      this.queue.push(a);
      if (this.queue.length > h.delay) this.last = this.queue.shift();
      return this.last;
    }
  }

  // ---------- соперники в заезде ----------
  // Помощники - как у игрока по умолчанию (антипробуксовка, АБС, помощь рулём, автомат): сеть училась с ними,
  // и это те же правила, что у игрока, а не «помощники бота».
  const PLAYER_ASSIST = Object.freeze({ tc: true, abs: true, steer: true, auto: true, sens: 1 });
  const EVERY = 4;                               // решение раз в 4 шага физики (30 Гц) - как при обучении

  // Уровень соперника по темпу, который игра дала бы боту (кубок, сложность, разброс между соперниками): так баланс
  // карьеры остаётся прежним. Задержка реакции у слабой переднеприводной «Искры» превращает круг в аварии - поэтому
  // уровни различаются осторожностью и шумом руля, без задержки. Осторожность подобрана по боту ТОГО ЖЕ темпа (ревью
  // 17.10, 8 трасс, «Кобальт» и «Сапсан»): круг как у бота при осторожности 0.63 на темпе 0.73, 0.72 на 0.8, 0.81 на 0.87,
  // 0.88 на 0.92 - прямая 0.63 + 1.34 * (темп - 0.73). Прежняя «темп - 0.06» на лёгком была на 3-4% быстрее бота.
  function handsForPace(pace) {
    const p = Math.max(0.5, Math.min(1.05, +pace || 0.9));
    const label = p >= 0.95 ? 'ас' : p >= 0.88 ? 'профи' : p >= 0.8 ? 'любитель' : 'новичок';
    const care = Math.max(0.4, Math.min(0.97, 0.63 + 1.34 * (p - 0.73)));
    return { delay: 0, steerNoise: p >= 0.95 ? 0 : 0.02, pedalMax: 1, pace: p >= 0.98 ? 1 : care, label };
  }
  // Дрифт: уровни AiRacer по сложности игры (ручник иногда пропущен, газ мягче).
  const DRIFT_LEVELS = { easy: ['drift-amateur', 'drift-rookie', 'drift-amateur'], normal: ['drift-pro', 'drift-amateur', 'drift-pro'], hard: ['drift-ace', 'drift-pro', 'drift-ace'] };
  function driftHands(difficulty, k) { const L = DRIFT_LEVELS[difficulty] || DRIFT_LEVELS.normal; return L[k % L.length]; }

  // Отдать соперников нейросети: записи с ai получают ai.neural = { model, hands }. Дрифт - модель «дрифтер».
  function neuralize(entries, mode, difficulty) {
    let k = 0;
    for (const e of entries) {
      if (!e.ai || e.isPlayer) continue;
      e.ai.neural = mode === 'drift' ? { model: 'drifter', hands: driftHands(difficulty, k) } : { model: 'racer', hands: handsForPace(e.ai.pace) };
      k++;
    }
    return entries;
  }

  // Мозг одной машины: вызывается из Race.step вместо бота (core.js: c.ai.brain). Сначала смотрит, потом решает.
  // phase - сдвиг шага решения: соперники думают на разных шагах физики, а не все сразу (кадр без всплесков)
  function makeBrain(model, hands, seed, phase) {
    if (hands && typeof hands === 'object') hands = Object.assign({}, hands);
    const driver = new NeuralDriver(netOf(model), { hands, seed });
    const obs = new Float64Array(OBS_SIZE);
    let n = phase | 0;
    const brain = (race, c) => {
      const q = c.inp;
      if (n++ % EVERY === 0) {
        observe(race, c, obs);
        const a = driver.act(obs);
        q.thr = a.thr; q.brk = a.brk; q.steer = a.steer; q.hb = a.hb; q.nitro = a.nitro; q.analog = true;
        brain.decisions++;
      }
    };
    brain.decisions = 0; brain.driver = driver; brain.model = model; brain.hands = hands;
    brain.reset = () => { driver.reset(); n = phase | 0; };
    return brain;
  }

  // Очки дрифта соперника - по правилам игрока (core.js: Race.step для игрока), и нитро копится в заносе так же.
  function driftAfter(race, c, dt) {
    if (c.finished || c.out || race.phase !== 'race') return;
    const tr = race.track, p = c.pr, sc = c.ai.scorer;
    const onRoad = Math.abs(p.d) < tr.hw + 0.6 && !c.wrong && (c.vx * p.tx + c.vz * p.tz) > 2;
    sc.update(dt, Math.abs(c.beta) * 180 / Math.PI, c.speed, onRoad);
    if (sc.drifting) c.nitro = Math.min(1, c.nitro + dt * 0.05);
    if (c.hit > 2.5) sc.crash();
  }

  // Подключить нейросеть к машинам заезда, у которых в записи ai.neural = { model, hands }.
  // Вызывать сразу после new Race(cfg): записи и машины идут в одном порядке.
  // Бот игры в дрифт-заезде - дрифтер (ручник на входе в поворот), и его очки тоже считаются.
  function attachRace(race) {
    let n = 0;
    race.cfg.entries.forEach((e, k) => {
      const c = race.cars[k];
      if (!c || !c.ai || c.isPlayer) return;
      if (!e.ai || !e.ai.neural) {
        if (race.mode === 'drift') { c.ai.drifter = true; c.ai.scorer = new C.DriftScorer(); c.ai.after = driftAfter; }
        return;
      }
      const nn = e.ai.neural;
      c.ai.brain = makeBrain(nn.model || 'racer', nn.hands || 'pro', (race.cfg.seed ^ Math.imul(k + 1, 0x9E3779B1)) >>> 0, n);
      c.ai.neural = true;
      c.ai.scorer = new C.DriftScorer();
      c.ai.after = driftAfter;
      c.assist = Object.assign({}, PLAYER_ASSIST);
      n++;
    });
    return n;
  }
  // Очки дрифта соперников на конец заезда (незакрытая серия засчитывается, как у игрока в finish()).
  function driftPoints(c) { return c.ai && c.ai.scorer ? c.ai.scorer.total + c.ai.scorer.pending : 0; }

  return { trackGeo, longestStraight, maxGrade, RAY_ANGLES, RAY_MAX, LOOK, OBS_SIZE, raySeg, rays, observe, MLP, netOf, HANDS, NeuralDriver,
    PLAYER_ASSIST, EVERY, handsForPace, DRIFT_LEVELS, driftHands, neuralize, makeBrain, attachRace, driftPoints, MODELS };
});
