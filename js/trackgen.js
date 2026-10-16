/* Horizon Drift - генератор трасс (из проекта AiRacer, src/trackgen.js). Трасса - в формате самой игры: «черепашьи»
   команды (S - прямая, R/L - дуга), две прямые 'auto' замыкают кольцо, ширина, покрытия, тема и высоты.
   Один код - одна трасса: <тип><сложность><длина>-<зерно в base36>, например R2M-3F9K1Z.
   Проверки: нет самопересечений, радиусы, уклоны, прямой старт; бот игры И нейросеть-гонщик проезжают круг;
   из прошедших выбирается самая «интересная». Генерация идёт по шагам (generateIter) - страница не замирает.
   Работает в странице (window.DriftTrackGen) и в node (require) - для проверок. */
(function (root, factory) {
  const req = typeof require === 'function' ? require : null;
  const D = root.DriftData || (req ? req('./data.js') : null);
  const C = root.DriftCore || (req ? req('./core.js') : null);
  const AI = root.DriftAI || (req ? req('./airacer.js') : null);
  const api = factory(D, C, AI);
  if (typeof module === 'object' && module.exports) module.exports = api; else root.DriftTrackGen = api;
})(typeof self !== 'undefined' ? self : this, function (D, C, AI) {
  'use strict';
  const { trackGeo, longestStraight, maxGrade } = AI;

  const GEN_VERSION = 1;
  const TYPES = { R: 'race', D: 'drift', M: 'mountain', C: 'city' };
  const TYPE_NAMES = { race: 'Гонка', drift: 'Дрифт', mountain: 'Горы', city: 'Город' };
  const LENGTHS = { S: [1100, 1800], M: [1700, 2600], L: [2500, 3600] };
  const LENGTH_NAMES = { S: 'Короткая', M: 'Средняя', L: 'Длинная' };

  // Из чего сделана трасса каждого типа. Углы в градусах, длины и радиусы в метрах.
  const PROFILES = {
    race: { width: 13, runoff: 4, minR: 30, r: [34, 130], ang: [25, 120], str: [30, 230], zeroStr: 0.15, elev: 6,
      themes: [['coast', 'asphalt', 'sand'], ['desert', 'asphalt', 'sand'], ['lake', 'asphalt', 'snowbank']] },
    drift: { width: 14, runoff: 4, minR: 22, r: [22, 50], ang: [60, 180], str: [25, 110], zeroStr: 0.3, elev: 1,
      themes: [['port', 'asphalt', 'concrete'], ['city', 'asphalt', 'concrete']] },
    mountain: { width: 11, runoff: 3, minR: 20, r: [21, 80], ang: [40, 180], str: [30, 160], zeroStr: 0.25, elev: 26,
      themes: [['desert', 'gravel', 'sand'], ['lake', 'snow', 'snowbank'], ['coast', 'asphalt', 'sand']] },
    city: { width: 12, runoff: 3, minR: 20, r: [20, 36], ang: [90, 90], str: [40, 190], zeroStr: 0.1, elev: 3, angAlt: 45,
      themes: [['city', 'asphalt', 'concrete']] },
  };
  const NAMES = {
    race: ['Береговая петля', 'Солнечное кольцо', 'Быстрый круг', 'Ветреный мыс'],
    drift: ['Боковой ход', 'Дымная петля', 'Портовые виражи', 'Скользкий узел'],
    mountain: ['Горный круг', 'Перевальное кольцо', 'Каменная петля', 'Высокий виток'],
    city: ['Ночные кварталы', 'Переулки', 'Неоновый круг', 'Кольцо улиц'],
  };

  function encode(p) {
    const t = Object.keys(TYPES).find((k) => TYPES[k] === p.type);
    return `${t}${p.difficulty}${p.length}-${(p.seed >>> 0).toString(36).toUpperCase()}`;
  }
  function decode(code) {
    const m = /^([RDMC])([123])([SML])-([0-9A-Z]{1,7})$/.exec(String(code || '').trim().toUpperCase());
    if (!m) return null;
    const seed = parseInt(m[4], 36);
    if (!Number.isFinite(seed) || seed > 0xffffffff) return null;
    return { type: TYPES[m[1]], difficulty: +m[2], length: m[3], seed: seed >>> 0 };
  }
  function normParams(p) {
    p = Object.assign({ type: 'race', difficulty: 2, length: 'M', seed: 1 }, p || {});
    if (!PROFILES[p.type]) throw new Error('unknown type ' + p.type);
    p.difficulty = Math.max(1, Math.min(3, p.difficulty | 0));
    if (!LENGTHS[p.length]) throw new Error('unknown length ' + p.length);
    p.seed = p.seed >>> 0;
    return p;
  }

  const rnd = (rng, a, b) => a + (b - a) * rng();
  const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];

  // Один случайный набор команд для профиля или null, если повороты не замыкают кольцо.
  function drawCommands(rng, prof, p) {
    const [lo, hi] = LENGTHS[p.length];
    const target = rnd(rng, lo, hi);
    const tight = 1 - 0.12 * (p.difficulty - 1);               // сложнее = круче повороты
    const corners = [];
    // курс должен примерно следовать доле уже построенного круга (360 градусов в конце):
    // поворот сильно впереди или позади неё и делает длинные трассы самопересекающимися
    let used = 200, psi = 0;
    while (used < target && corners.length < 22) {
      const ang = prof.angAlt && rng() < 0.2 ? prof.angAlt : Math.round(rnd(rng, prof.ang[0], prof.ang[1]) / 5) * 5;
      const r = Math.max(prof.minR, Math.round(rnd(rng, prof.r[0], prof.r[1]) * tight));
      used += r * ang * Math.PI / 180 + 60;
      const lag = 360 * Math.min(1, used / target) - psi;
      const right = rng() < Math.max(0.12, Math.min(0.92, 0.5 + lag / 200));
      psi += right ? ang : -ang;
      corners.push({ right, ang, r });
    }
    if (corners.length < 4) return null;
    // кольцо поворачивает ровно на 360 градусов: остаток делится между поворотами в пределах их типа
    const maxAng = Math.max(prof.ang[1], 120) + 5;
    let rest = 360 - corners.reduce((a, c) => a + (c.right ? c.ang : -c.ang), 0);
    for (let pass = 0; pass < 3 && Math.abs(rest) > 0.05; pass++) {
      const share = rest / corners.length;
      for (const c of corners) {
        const want = c.right ? share : -share;
        const next = Math.max(15, Math.min(maxAng, c.ang + want * (1.5 + pass)));
        const took = (next - c.ang) * (c.right ? 1 : -1);
        if (Math.abs(took) > Math.abs(rest)) continue;
        c.ang = next; rest -= took;
      }
    }
    for (const c of corners) c.ang = Math.round(c.ang * 10) / 10;
    // округление не должно сломать полный оборот: остаток берёт последний правый поворот
    const net = corners.reduce((a, c) => a + (c.right ? c.ang : -c.ang), 0);
    const last = corners.filter((c) => c.right).pop();
    if (!last) return null;
    last.ang = Math.round((last.ang + 360 - net) * 10) / 10;
    if (corners.some((c) => c.ang > maxAng || c.ang < 15)) return null;
    const strs = corners.map(() => (rng() < prof.zeroStr ? 0 : Math.round(rnd(rng, prof.str[0], prof.str[1]))));
    // курсы перед каждой прямой - чтобы две прямые 'auto' не были параллельны
    const head = []; let hd = 0;
    for (let i = 0; i < corners.length; i++) { hd += (corners[i].right ? 1 : -1) * corners[i].ang; head.push(hd); }
    const pairs = [];
    for (let i = 0; i < corners.length - 1; i++) for (let j = i + 2; j < corners.length; j++) {
      let d = Math.abs(head[i] - head[j]) % 180; if (d > 90) d = 180 - d;
      if (d >= 50) pairs.push([i, j]);
    }
    if (!pairs.length) return null;
    const start = Math.round(rnd(rng, 150, 240));
    const order = pairs.map((x) => [rng(), x]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
    for (const [ai, bi] of order.slice(0, 12)) {
      const cmds = [['S', start]];
      corners.forEach((c, i) => {
        cmds.push([c.right ? 'R' : 'L', c.ang, c.r]);
        if (i === ai || i === bi) cmds.push(['S', 'auto']);
        else if (strs[i] > 0 && i < corners.length - 1) cmds.push(['S', strs[i]]);
      });
      const autos = C.solveAutos(cmds);
      if (!autos || autos[0] < 25 || autos[1] < 25 || autos[0] > 600 || autos[1] > 600) continue;
      return cmds;
    }
    return null;
  }

  // То же, что core.trackClearance, по сырым точкам «черепашки»: дешёвая проверка до постройки трассы.
  function rawClearance(pts, skip, cell) {
    const n = pts.length, cum = new Float64Array(n);
    for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    const L = cum[n - 1] + Math.hypot(pts[0][0] - pts[n - 1][0], pts[0][1] - pts[n - 1][1]);
    cell = cell || 40;
    const grid = new Map(), key = (cx, cz) => cx * 73856093 ^ cz * 19349663;
    for (let i = 0; i < n; i++) {
      const k = key(Math.floor(pts[i][0] / cell), Math.floor(pts[i][1] / cell));
      let b = grid.get(k); if (!b) grid.set(k, (b = [])); b.push(i);
    }
    let min = cell;
    for (let i = 0; i < n; i++) {
      const cx = Math.floor(pts[i][0] / cell), cz = Math.floor(pts[i][1] / cell);
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
        const b = grid.get(key(cx + dx, cz + dz)); if (!b) continue;
        for (const j of b) {
          if (j <= i) continue;
          let ds = cum[j] - cum[i]; ds = Math.min(ds, L - ds);
          if (ds < skip) continue;
          const d = Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]);
          if (d < min) min = d;
        }
      }
    }
    return { min, L };
  }

  function drawElevation(rng, prof, p) {
    const n = 8, amp = prof.elev * (0.6 + 0.2 * p.difficulty);
    const e = [0];
    for (let i = 1; i < n; i++) e.push(Math.round(Math.max(-amp * 0.3, Math.min(amp, e[i - 1] + rnd(rng, -0.45, 0.6) * amp)) * 10) / 10);
    e[n - 1] = Math.round(e[n - 1] * 0.3 * 10) / 10;                 // назад вниз к старту
    return e;
  }

  // Проверки трассы для игры. Список проблем (пусто - трасса годится).
  function checkTrack(tr, prof) {
    const bad = [];
    const clear = C.trackClearance(tr).min;
    if (clear < 2 * tr.W + 6) bad.push(`clearance ${clear.toFixed(1)} m < ${(2 * tr.W + 6).toFixed(1)}`);
    const g = trackGeo(tr);
    let kMax = 0; for (let i = 0; i < tr.N; i++) kMax = Math.max(kMax, Math.abs(g.kappa[i]));
    if (kMax > 1 / (prof.minR * 0.85)) bad.push(`radius ${(1 / kMax).toFixed(1)} m < ${prof.minR}`);
    const grade = maxGrade(tr);
    if (grade > 0.14) bad.push(`grade ${(grade * 100).toFixed(0)}%`);
    // стартовая прямая: сетка стоит на s = 20..53, линия старта на 60 - поворота там нет
    for (let s = 30; s <= 90; s += 2) {
      const i = C.idxAt(tr, s);
      if (Math.abs(g.kappa[i]) > 1 / 300) { bad.push('start not straight'); break; }
    }
    return bad;
  }

  // Интересность: разнообразие поворотов, места для дрифта, нет длинных скучных прямых, ритм.
  function interest(tr, def) {
    const g = trackGeo(tr), corners = def.cmds.filter((c) => c[0] === 'R' || c[0] === 'L');
    const bins = new Map();
    for (const c of corners) {
      const key = (c[2] < 30 ? 'h' : c[2] < 60 ? 'm' : 'f') + (c[1] < 60 ? 's' : c[1] < 120 ? 'n' : 'w') + c[0];
      bins.set(key, (bins.get(key) || 0) + 1);
    }
    let ent = 0; for (const v of bins.values()) { const q = v / corners.length; ent -= q * Math.log(q); }
    const variety = Math.min(1, ent / Math.log(8));
    const driftSpots = corners.filter((c) => c[1] >= 60 && c[2] <= 50).length;
    const drift = Math.min(1, driftSpots / 4);
    const straight = longestStraight(tr, 1 / 400);
    const boredom = Math.max(0, Math.min(1, (straight - 300) / 400));
    let inCorner = 0; for (let i = 0; i < tr.N; i++) if (Math.abs(g.kappa[i]) > 1 / 150) inCorner++;
    const share = inCorner / tr.N, rhythm = 1 - Math.min(1, Math.abs(share - 0.45) / 0.45);
    const w = def.gen.type === 'drift' ? [0.3, 0.4, 0.15, 0.15] : [0.35, 0.2, 0.25, 0.2];
    const score = w[0] * variety + w[1] * drift + w[2] * (1 - boredom) + w[3] * rhythm;
    return { score: +score.toFixed(4), variety: +variety.toFixed(3), driftSpots, longestStraight: Math.round(straight), cornerShare: +share.toFixed(3) };
  }

  // Шаги заезда кусками по 6 с игрового времени: между кусками генератор отдаёт управление странице.
  function* runSteps(r, steps, keep) {
    for (let i = 0; i < steps && r.phase !== 'done' && keep(); i++) { r.step(C.DT); if (i % 720 === 719) yield null; }
  }
  const drain = (it) => { for (;;) { const st = it.next(); if (st.done) return st.value; } };

  // Бот игры проезжает круг на полном темпе. Трасса проходит, если бот финишировал, время круга разумное
  // и опасных мест мало (удары о стену, очень резкие торможения).
  // stopHits - остановиться, как только ударов больше (трасса уже не прошла): проверка не тратит время на застрявшего бота.
  function* botCheckIter(def, opts) {
    opts = opts || {};
    const tr = C.buildTrack(def);
    const r = new C.Race({ track: def, mode: 'time', laps: 1, skipCountdown: true, seed: 1,
      entries: [{ name: 'Bot', car: opts.car || 'kobalt', ai: { pace: 1, mistakes: 0, nitro: true } }] });
    const c = r.cars[0], steps = Math.round((opts.maxTime || Math.max(120, tr.lapLen / 6)) / C.DT), stopHits = opts.stopHits == null ? 1e9 : opts.stopHits;
    yield* runSteps(r, steps, () => c.hits <= stopHits);
    const prof = C.speedProfile(tr, c.st);
    let hardBrakes = 0;
    for (let i = 0; i < tr.N; i += 5) {
      const j = C.idxAt(tr, tr.s[i] + 80);
      if (prof[i] > 33 && prof[j] < 15) { hardBrakes++; i += 40; }
    }
    const time = c.finished ? c.finishT : null;
    const avg = time ? tr.lapLen / time : 0;
    return { finished: !!c.finished, time, avgSpeed: +avg.toFixed(2), hits: c.hits, hardBrakes, danger: c.hits + hardBrakes };
  }
  const botCheck = (def, opts) => drain(botCheckIter(def, opts));

  // Нейросеть-гонщик (ас) проезжает круг тем же вводом, что у игрока. Сброс (как клавиша «на трассу») - не прошла.
  function* aiCheckIter(def, opts) {
    opts = opts || {};
    const tr = C.buildTrack(def);
    const r = new C.Race({ track: def, mode: 'time', laps: 1, skipCountdown: true, seed: 1,
      entries: [{ name: 'AI', car: opts.car || 'kobalt', ai: { pace: 1, mistakes: 0, neural: { model: opts.model || 'racer', hands: 'ace' } } }] });
    AI.attachRace(r);
    let resets = 0; const reset = r.resetCar.bind(r); r.resetCar = (c) => { resets++; reset(c); };
    const c = r.cars[0];
    yield* runSteps(r, Math.round(Math.max(120, tr.lapLen / 6) / C.DT), () => !resets);
    return { finished: !!c.finished, time: c.finished ? c.finishT : null, resets, hits: c.hits };
  }
  const aiCheck = (def, opts) => drain(aiCheckIter(def, opts));

  // Один кандидат по параметрам и подзерну: { def, tr, attempts } или null.
  function candidate(p, sub, maxAttempts) {
    const prof = PROFILES[p.type];
    const rng = C.mulberry32((p.seed ^ Math.imul(sub + 1, 0x9E3779B1)) >>> 0);
    const code = encode(p);
    for (let a = 0; a < (maxAttempts || 60); a++) {
      const cmds = drawCommands(rng, prof, p);
      if (!cmds) continue;
      const autos = C.solveAutos(cmds);
      const pts = C.runTurtle(cmds, autos).pts;
      const W = prof.width / 2 + prof.runoff, [lo, hi] = LENGTHS[p.length];
      const raw = rawClearance(pts.slice(0, -1), 110, 2 * W + 4);
      if (raw.min < 2 * W + 4 || raw.L < lo * 0.85 || raw.L > hi * 1.15) continue;
      const th = pick(rng, prof.themes);
      const width = prof.width - 0.5 * (p.difficulty - 1);
      const def = {
        id: `gen-${code}-${sub}-${a}`, name: pick(rng, NAMES[p.type]) + ' ' + code, place: 'Новая трасса', theme: th[0],
        closed: true, width, runoff: prof.runoff, surface: th[1], runoffSurf: th[2], laps: p.type === 'drift' ? 2 : 3,
        cmds, elev: drawElevation(rng, prof, p),
        gen: { v: GEN_VERSION, code, type: p.type, difficulty: p.difficulty, length: p.length, sub, attempt: a },
      };
      const tr = C.buildTrack(def);
      if (tr.L < lo * 0.85 || tr.L > hi * 1.15) { C.forgetTrack(def.id); continue; }
      const problems = checkTrack(tr, prof);
      if (problems.length) { C.forgetTrack(def.id); continue; }
      return { def, tr, attempts: a + 1 };
    }
    return null;
  }

  // Опасные места на круге бота: удары о стену и торможение со 120+ до меньше 55 км/ч на 80 м
  // (городская трасса из таких поворотов и состоит, гоночная - нет).
  const HITS_MAX = [0, 1, 2, 3];
  const BRAKES_PER_KM = { race: 1.6, drift: 4.5, mountain: 3.5, city: 8 };

  // Проверка проходимости: бот игры проходит по правилам выше, а нейросеть-ас - круг без сбросов.
  function* validateIter(def, p) {
    const tr = C.buildTrack(def);
    // средняя скорость больше 12 м/с - значит, круг быстрее lapLen / 12: дольше бота не ждём
    const b = yield* botCheckIter(def, { maxTime: tr.lapLen / 12 + 1, stopHits: HITS_MAX[p.difficulty] });
    const botOk = b.finished && b.avgSpeed > 12 && b.avgSpeed < 50 && b.hits <= HITS_MAX[p.difficulty] &&
      b.hardBrakes <= 1 + BRAKES_PER_KM[p.type] * tr.lapLen / 1000 && b.time < tr.lapLen / 10;
    const ai = botOk ? yield* aiCheckIter(def) : null;
    return Object.assign({ ok: botOk && ai.finished && ai.resets === 0, ai }, b);
  }
  const validate = (def, p) => drain(validateIter(def, p));

  // По шагам: после каждого кандидата - yield { done, total } (для полосы загрузки). Итог - return.
  // Лучший из N прошедших проверку по интересности. Если ни один не прошёл за limit кандидатов, а бот игры только
  // застревал в тесных связках (его известная слабость - виляет в S-поворотах), берётся самый интересный из тех,
  // что нейросеть-ас проехала без сбросов и почти без ударов: трасса проходима, это видно по живому водителю.
  function* generateIter(params, opts) {
    opts = opts || {};
    const p = normParams(typeof params === 'string' ? decode(params) : params);
    const N = opts.candidates || 3, limit = opts.limit || N * 3 + 12;
    let best = null; const tried = [], spare = [];
    for (let sub = 0; sub < limit && tried.filter((t) => t.ok).length < N; sub++) {
      const cand = candidate(p, sub, opts.maxAttempts);
      if (cand) {
        const res = opts.validator ? opts.validator(cand.def) : yield* validateIter(cand.def, p);
        const score = interest(cand.tr, cand.def);
        tried.push({ sub, ok: res.ok, score: score.score });
        if (res.ok && (!best || score.score > best.interest.score)) {
          if (best) C.forgetTrack(best.def.id);
          best = { def: cand.def, interest: score, check: Object.assign({ by: 'bot' }, res) };
        } else {
          if (!res.ok && !opts.validator) spare.push({ def: cand.def, interest: score, check: res });
          C.forgetTrack(cand.def.id);
        }
      }
      yield { done: Math.min(N, tried.filter((t) => t.ok).length), total: N, sub, limit };
    }
    if (!best) {
      spare.sort((x, y) => y.interest.score - x.interest.score);
      for (const sp of spare) {
        const ai = yield* aiCheckIter(sp.def);
        if (ai.finished && ai.resets === 0 && ai.hits <= HITS_MAX[p.difficulty] + 3) { best = sp; best.check = Object.assign({}, sp.check, { ok: true, by: 'ai', ai }); break; }
        C.forgetTrack(sp.def.id);
      }
    }
    if (!best) return null;
    best.def.gen.interest = best.interest.score;
    return { code: encode(p), params: p, def: best.def, interest: best.interest, check: best.check, tried };
  }
  const generate = (params, opts) => drain(generateIter(params, opts));

  // Сохранённые трассы из хранилища: [{ code, def, savedAt }]. Описание трассы (def) проверяется поле за полем и
  // собирается заново из чисел и строк известных видов - испорченная запись выбрасывается и не ломает игру.
  const num = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : null);
  function cleanDef(def, code) {
    if (!def || typeof def !== 'object' || !def.gen || def.gen.code !== code) return null;
    const p = decode(code);
    if (typeof def.id !== 'string' || !/^gen-[0-9A-Z-]{3,40}$/.test(def.id) || !D.THEMES[def.theme] || !D.SURF[def.surface] || !D.SURF[def.runoffSurf]) return null;
    const width = num(def.width, 8, 16), runoff = num(def.runoff, 1, 8), laps = num(def.laps, 1, 9);
    if (width === null || runoff === null || laps === null || def.closed !== true) return null;
    if (!Array.isArray(def.cmds) || def.cmds.length < 4 || def.cmds.length > 80 || !Array.isArray(def.elev) || def.elev.length < 2 || def.elev.length > 24) return null;
    const cmds = [];
    for (const c of def.cmds) {
      if (!Array.isArray(c)) return null;
      if (c[0] === 'S' && c.length === 2 && (c[1] === 'auto' || num(c[1], 1, 2000) !== null)) cmds.push(['S', c[1]]);
      else if ((c[0] === 'R' || c[0] === 'L') && c.length === 3 && num(c[1], 1, 360) !== null && num(c[2], 10, 400) !== null) cmds.push([c[0], c[1], c[2]]);
      else return null;
    }
    if (cmds.filter((c) => c[1] === 'auto').length !== 2 || !C.solveAutos(cmds)) return null;
    const elev = def.elev.map((v) => num(v, -300, 300));
    if (elev.some((v) => v === null)) return null;
    const g = def.gen;
    return { id: def.id, name: typeof def.name === 'string' ? def.name.slice(0, 80) : code, place: 'Новая трасса', theme: def.theme, closed: true,
      width, runoff, surface: def.surface, runoffSurf: def.runoffSurf, laps: Math.round(laps), cmds, elev,
      gen: { v: GEN_VERSION, code, type: p.type, difficulty: p.difficulty, length: p.length, sub: num(g.sub, 0, 999) || 0, attempt: num(g.attempt, 0, 999) || 0,
        interest: num(g.interest, 0, 1) || 0 } };
  }
  function sanitizeSaved(list) {
    if (!Array.isArray(list)) return [];
    const out = [], seen = new Set();
    for (const it of list) {
      if (!it || typeof it !== 'object' || typeof it.code !== 'string' || !decode(it.code)) continue;
      const code = encode(decode(it.code));
      if (seen.has(code)) continue;
      const def = cleanDef(it.def, code);
      if (!def) continue;
      seen.add(code);
      out.push({ code, def, savedAt: num(it.savedAt, 0, 1e14) || 0 });
      if (out.length >= 60) break;
    }
    return out;
  }
  // Рекорды новых трасс - по коду (тип, сложность, длина и зерно): { code: { lap, time, drift } }, не больше 300 кодов.
  function sanitizeRecords(r) {
    const out = {};
    if (!r || typeof r !== 'object' || Array.isArray(r)) return out;
    let n = 0;
    for (const k of Object.keys(r)) {
      if (n >= 300) break;
      const p = decode(k), v = r[k];
      if (!p || encode(p) !== k || !v || typeof v !== 'object') continue;
      const o = {};
      for (const f of ['lap', 'time', 'drift']) { const x = num(v[f], 1e-6, 1e9); if (x !== null) o[f] = x; }
      if (Object.keys(o).length) { out[k] = o; n++; }
    }
    return out;
  }

  return { GEN_VERSION, TYPES, TYPE_NAMES, LENGTHS, LENGTH_NAMES, PROFILES, encode, decode, normParams, generate, generateIter, candidate,
    checkTrack, interest, botCheck, aiCheck, validate, rawClearance, cleanDef, sanitizeSaved, sanitizeRecords };
});
