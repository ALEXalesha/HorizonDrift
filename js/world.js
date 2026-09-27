/* Horizon Drift - открытый мир: карты из данных (таблица областей + граф дорог + зерно), рельеф,
   дороги с мостами и тоннелями, точки (события, радары, зоны дрифта, рампы, щиты), физика свободной езды,
   трафик и бродячие соперники, сохранение. Без DOM и three.js: работает в странице и в node.
   Новая карта - это новая запись в MAPS, а не новый код. */
(function (root, factory) {
  const D = root.DriftData || (typeof require === 'function' ? require('./data.js') : null);
  const C = root.DriftCore || (typeof require === 'function' ? require('./core.js') : null);
  const api = factory(D, C);
  if (typeof module === 'object' && module.exports) module.exports = api; else root.DriftWorld = api;
})(typeof self !== 'undefined' ? self : this, function (D, C) {
  'use strict';
  const G = C.G, DT = C.DT, clamp = C.clamp, lerp = C.lerp;
  const WATER = 0;
  const CHUNK = 256;
  const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

  // ---------- шум ----------
  function hash2(x, z, s) { let h = Math.imul(x | 0, 374761393) ^ Math.imul(z | 0, 668265263) ^ Math.imul(s | 0, 1442695041); h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
  function vnoise(x, z, s) {
    const xi = Math.floor(x), zi = Math.floor(z), xf = x - xi, zf = z - zi;
    const u = xf * xf * (3 - 2 * xf), v = zf * zf * (3 - 2 * zf);
    const a = hash2(xi, zi, s), b = hash2(xi + 1, zi, s), c = hash2(xi, zi + 1, s), d = hash2(xi + 1, zi + 1, s);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }
  function fbm(x, z, s) { return vnoise(x, z, s) * 0.5 + vnoise(x * 2.03, z * 2.03, s + 7) * 0.28 + vnoise(x * 4.1, z * 4.1, s + 13) * 0.14 + vnoise(x * 8.3, z * 8.3, s + 29) * 0.08; }

  // ---------- типы дорог и природа ----------
  const ROAD = {
    highway: { hw: 8, amp: 70, wl: 760, grade: 0.07, lamps: true, traffic: true, name: 'шоссе' },
    road: { hw: 5.5, amp: 90, wl: 460, grade: 0.1, lamps: false, traffic: true, name: 'дорога' },
    dirt: { hw: 4.5, amp: 70, wl: 300, grade: 0.14, lamps: false, traffic: false, name: 'просёлок' },
    serp: { hw: 5, amp: 55, wl: 230, grade: 0.13, lamps: false, traffic: false, name: 'серпантин' },
  };
  const BIOME = {
    grass: { color: '#5d8a3a', surf: 'grass' }, forest: { color: '#3f6e2e', surf: 'grass' }, sand: { color: '#dcc596', surf: 'sand' },
    redsand: { color: '#c67a4c', surf: 'sand' }, snow: { color: '#eef3f8', surf: 'snow' }, concrete: { color: '#7d8087', surf: 'concrete' },
    rock: { color: '#857a6c', surf: 'gravel' }, salt: { color: '#ece6d8', surf: 'concrete' },
  };
  const PROP_R = { tree: 0.7, pine: 0.6, snowpine: 0.6, palm: 0.5, cactus: 0.5, rock: 1.6, building: 0, container: 0 };

  // ---------- карты ----------
  // Координаты областей и узлов даны в «эскизном» масштабе и умножаются на scale.
  // Области: elev - средняя высота, amp - холмистость, biome - природа, decor - что растёт и стоит,
  // track - трасса карьеры, чьи события доступны в этой области.
  const MAPS = [
    { id: 'coast', name: 'Побережье', about: 'Город, порт, пляжи и прибрежное шоссе. Море на востоке и юге.', seed: 101, scale: 1.4, tod: 16, weather: 'clear',
      sea: [{ axis: 'x', from: 3150, to: 3500 }, { axis: '-z', from: 2750, to: 3100 }], lakes: [{ x: 2380, z: -1250, r: 380, depth: 7 }], peaks: [{ x: -600, z: -1650, r: 480, h: 75 }],
      regions: [
        { id: 'fest', name: 'Фестиваль', x: 0, z: 0, elev: 12, amp: 6, biome: 'grass', decor: ['tree', 'lamp'] },
        { id: 'city', name: 'Неоновый квартал', x: 2000, z: 1600, elev: 8, amp: 2, biome: 'concrete', decor: ['building', 'lamp'], track: 'city' },
        { id: 'port', name: 'Порт', x: 2750, z: -300, elev: 4, amp: 1, biome: 'concrete', decor: ['container', 'lamp'], track: 'port' },
        { id: 'beach', name: 'Лазурный берег', x: 1700, z: -2200, elev: 5, amp: 8, biome: 'sand', decor: ['palm', 'rock'], track: 'coast' },
        { id: 'cliff', name: 'Скалы', x: -900, z: -2400, elev: 28, amp: 34, biome: 'rock', decor: ['rock', 'pine'] },
        { id: 'hills', name: 'Зелёные холмы', x: -2700, z: 500, elev: 30, amp: 40, biome: 'forest', decor: ['tree', 'pine', 'rock'] },
        { id: 'vil', name: 'Деревня', x: -1500, z: 2400, elev: 18, amp: 14, biome: 'grass', decor: ['tree', 'building'] },
        { id: 'cape', name: 'Северный мыс', x: 600, z: 3000, elev: 20, amp: 18, biome: 'grass', decor: ['tree', 'rock'] },
      ],
      nodes: { F: [0, 0], CITY: [2000, 1600], PORT: [2750, -300], BEACH: [1800, -2200], CLIFF: [-900, -2450], HILLS: [-2700, 500], VIL: [-1500, 2450],
        CAPE: [500, 3000], C1: [2750, 2150], C2: [2350, 2650], P1: [3000, 500], H1: [-3200, -500] },
      edges: [['F', 'CITY', 'highway'], ['F', 'PORT', 'highway'], ['F', 'BEACH', 'road'], ['F', 'CLIFF', 'road', { tunnel: [0.55, 0.8] }], ['F', 'HILLS', 'road'], ['F', 'VIL', 'road'],
        ['CITY', 'PORT', 'highway'], ['PORT', 'BEACH', 'highway'], ['BEACH', 'CLIFF', 'road'], ['CLIFF', 'H1', 'dirt'], ['H1', 'HILLS', 'dirt'], ['HILLS', 'VIL', 'serp'],
        ['VIL', 'CAPE', 'road'], ['CAPE', 'CITY', 'highway'], ['CITY', 'C1', 'road'], ['C1', 'C2', 'road'], ['C2', 'CITY', 'road'], ['PORT', 'P1', 'road'], ['P1', 'CITY', 'road']],
      points: { radars: 7, drift: 5, jumps: 5, boards: 30 } },
    { id: 'mountains', name: 'Горы', about: 'Серпантины, снежный перевал, озеро и тайга с гравийкой.', seed: 202, scale: 1.45, tod: 11, weather: 'clear',
      sea: [], lakes: [{ x: 2150, z: 2350, r: 520, depth: 9 }],
      regions: [
        { id: 'fest', name: 'Фестиваль', x: 0, z: 0, elev: 30, amp: 10, biome: 'grass', decor: ['tree', 'lamp'] },
        { id: 'serp', name: 'Орлиный серпантин', x: -2300, z: 1200, elev: 120, amp: 80, biome: 'rock', decor: ['pine', 'rock'], track: 'serpentine' },
        { id: 'pass', name: 'Ледяной перевал', x: -400, z: 2800, elev: 110, amp: 60, biome: 'snow', decor: ['snowpine', 'rock'], track: 'pass' },
        { id: 'lake', name: 'Северное озеро', x: 1500, z: 1850, elev: 22, amp: 10, biome: 'snow', decor: ['snowpine', 'rock'], track: 'lake' },
        { id: 'forest', name: 'Лесная тропа', x: -2400, z: -1300, elev: 40, amp: 24, biome: 'forest', decor: ['pine', 'tree', 'rock'], track: 'forest' },
        { id: 'town', name: 'Долина', x: 1600, z: -1200, elev: 20, amp: 8, biome: 'grass', decor: ['tree', 'building', 'lamp'] },
        { id: 'ridge', name: 'Гребень', x: 2800, z: 300, elev: 70, amp: 55, biome: 'rock', decor: ['pine', 'rock'] },
        { id: 'south', name: 'Южная тайга', x: -300, z: -2700, elev: 35, amp: 20, biome: 'forest', decor: ['pine', 'tree'] },
      ],
      nodes: { F: [0, 0], SERP: [-2300, 1150], PASS: [-400, 2800], LAKE: [1350, 1700], FOREST: [-2450, -1300], TOWN: [1600, -1250], RIDGE: [2800, 250],
        S: [-300, -2750], SUM: [-3100, 2150] },
      edges: [['F', 'SERP', 'serp'], ['F', 'PASS', 'road'], ['F', 'LAKE', 'highway'], ['F', 'FOREST', 'dirt'], ['F', 'TOWN', 'highway'], ['F', 'RIDGE', 'road', { tunnel: [0.5, 0.85] }],
        ['SERP', 'PASS', 'serp'], ['PASS', 'LAKE', 'road'], ['LAKE', 'RIDGE', 'road'], ['RIDGE', 'TOWN', 'highway'], ['TOWN', 'S', 'road'], ['S', 'FOREST', 'dirt'],
        ['FOREST', 'SERP', 'dirt'], ['SERP', 'SUM', 'serp']],
      points: { radars: 6, drift: 6, jumps: 5, boards: 30 } },
    { id: 'desert', name: 'Пустыня', about: 'Каньоны, дюны, бездорожье и городок-оазис посреди песков.', seed: 303, scale: 1.4, tod: 14, weather: 'clear',
      sea: [], lakes: [{ x: 120, z: 180, r: 90, depth: 3 }], peaks: [{ x: -1650, z: -650, r: 450, h: 80 }],
      regions: [
        { id: 'fest', name: 'Оазис', x: 0, z: 0, elev: 14, amp: 4, biome: 'sand', decor: ['palm', 'building', 'lamp'] },
        { id: 'canyon', name: 'Красный каньон', x: -2300, z: -900, elev: 40, amp: 70, biome: 'redsand', decor: ['cactus', 'rock'], track: 'desert' },
        { id: 'dunes', name: 'Дюны', x: 2100, z: 1300, elev: 22, amp: 45, biome: 'sand', decor: ['cactus'] },
        { id: 'mesa', name: 'Столовые горы', x: -1800, z: 2200, elev: 55, amp: 60, biome: 'redsand', decor: ['rock', 'cactus'] },
        { id: 'salt', name: 'Солончак', x: 2500, z: -1800, elev: 6, amp: 1, biome: 'salt', decor: [] },
        { id: 'ghost', name: 'Городок-призрак', x: 500, z: -2700, elev: 18, amp: 10, biome: 'sand', decor: ['building', 'cactus'] },
        { id: 'north', name: 'Северные холмы', x: 300, z: 2900, elev: 30, amp: 30, biome: 'redsand', decor: ['cactus', 'rock'] },
      ],
      nodes: { F: [0, 0], CANYON: [-2300, -900], DUNES: [2100, 1300], MESA: [-1750, 2250], SALT: [2500, -1750], GHOST: [500, -2750], N: [300, 2900] },
      edges: [['F', 'CANYON', 'highway', { tunnel: [0.62, 0.82] }], ['F', 'DUNES', 'road'], ['F', 'MESA', 'road'], ['F', 'SALT', 'highway'], ['F', 'GHOST', 'dirt'], ['F', 'N', 'road'],
        ['CANYON', 'MESA', 'dirt'], ['MESA', 'N', 'road'], ['N', 'DUNES', 'road'], ['DUNES', 'SALT', 'dirt'], ['SALT', 'GHOST', 'highway'], ['GHOST', 'CANYON', 'dirt']],
      points: { radars: 6, drift: 5, jumps: 6, boards: 30 } },
    { id: 'metro', name: 'Мегаполис', about: 'Ночной город из районов: кольцевая, развязки, набережная и промзона.', seed: 404, scale: 1.35, tod: 22, weather: 'clear', night: true,
      sea: [{ axis: 'x', from: 3200, to: 3550 }], lakes: [{ x: 700, z: 480, r: 230, depth: 5 }],
      regions: [
        { id: 'fest', name: 'Площадь', x: 0, z: 0, elev: 10, amp: 2, biome: 'concrete', decor: ['building', 'lamp'] },
        { id: 'down', name: 'Центр', x: 1300, z: 900, elev: 8, amp: 2, biome: 'concrete', decor: ['building', 'lamp'], track: 'city' },
        { id: 'docks', name: 'Набережная', x: 2800, z: -600, elev: 4, amp: 1, biome: 'concrete', decor: ['container', 'lamp'], track: 'port' },
        { id: 'ind', name: 'Промзона', x: -1900, z: -1500, elev: 12, amp: 4, biome: 'concrete', decor: ['container', 'building', 'lamp'] },
        { id: 'park', name: 'Парк', x: -2100, z: 1400, elev: 16, amp: 10, biome: 'forest', decor: ['tree', 'lamp'] },
        { id: 'north', name: 'Спальный район', x: 600, z: 2800, elev: 14, amp: 6, biome: 'concrete', decor: ['building', 'lamp'] },
        { id: 'south', name: 'Южный район', x: 700, z: -2600, elev: 12, amp: 5, biome: 'concrete', decor: ['building', 'lamp'] },
      ],
      nodes: { F: [0, 0], DOWN: [1300, 900], DOCKS: [2800, -600], IND: [-1950, -1500], PARK: [-2100, 1400], N: [600, 2850], S: [700, -2650],
        R1: [2300, 2000], R2: [-1000, 2600], R3: [-2900, -200], R4: [-600, -2800], R5: [2400, -2000] },
      edges: [['F', 'DOWN', 'highway'], ['F', 'IND', 'highway'], ['F', 'PARK', 'road'], ['F', 'S', 'road'], ['F', 'DOCKS', 'road'], ['DOWN', 'N', 'road'],
        ['N', 'R1', 'highway'], ['R1', 'DOCKS', 'highway'], ['DOCKS', 'R5', 'highway'], ['R5', 'S', 'highway'], ['S', 'R4', 'highway'], ['R4', 'IND', 'highway'],
        ['IND', 'R3', 'highway'], ['R3', 'PARK', 'highway'], ['PARK', 'R2', 'highway'], ['R2', 'N', 'highway'], ['DOWN', 'R1', 'road'], ['PARK', 'N', 'serp']],
      points: { radars: 7, drift: 5, jumps: 4, boards: 30 } },
  ];

  // ======================= ПОСТРОЕНИЕ КАРТЫ =======================
  const built = {};
  function buildMap(id) {
    if (built[id]) return built[id];
    const def = MAPS.find((m) => m.id === id) || MAPS[0];
    const sc = def.scale, seed = def.seed;
    const R = def.regions.map((r) => Object.assign({}, r, { x: r.x * sc, z: r.z * sc }));
    const sea = def.sea.map((s) => ({ axis: s.axis, from: s.from * sc, to: s.to * sc }));
    const lakes = def.lakes.map((l) => ({ x: l.x * sc, z: l.z * sc, r: l.r * sc, depth: l.depth }));
    const peaks = (def.peaks || []).map((l) => ({ x: l.x * sc, z: l.z * sc, r: l.r * sc, h: l.h }));
    let half = 0;
    for (const k in def.nodes) half = Math.max(half, Math.abs(def.nodes[k][0]), Math.abs(def.nodes[k][1]));
    half = half * sc + 700;
    const M = { id: def.id, def, name: def.name, R, sea, lakes, half, seed, water: WATER };
    const RW = 820 * sc;

    // --- рельеф без дорог ---
    function regionMix(x, z, out) {
      let ws = 0, e = 0, a = 0, best = 0, bi = 0;
      for (let i = 0; i < R.length; i++) {
        const r = R[i], dx = x - r.x, dz = z - r.z, w = Math.exp(-(dx * dx + dz * dz) / (RW * RW)) + 1e-5;
        ws += w; e += w * r.elev; a += w * r.amp;
        if (w > best) { best = w; bi = i; }
      }
      out = out || {}; out.elev = e / ws; out.amp = a / ws; out.i = bi; out.w = best / ws;
      return out;
    }
    const mixTmp = {};
    function seaFactor(x, z) {
      let s = 0;
      for (const q of sea) {
        const v = q.axis === 'x' ? x : q.axis === '-x' ? -x : q.axis === 'z' ? z : -z;
        s = Math.max(s, smooth(q.from, q.to, v));
      }
      return s;
    }
    function rawHeight(x, z) {
      const m = regionMix(x, z, mixTmp);
      let h = m.elev + (fbm(x / 520, z / 520, seed) - 0.45) * m.amp * 2;
      if (R[m.i].biome === 'sand' && m.amp > 20) h += (vnoise(x / 60, z / 60, seed + 3) - 0.5) * 8;       // рябь дюн
      for (const pk of peaks) { const d = Math.hypot(x - pk.x, z - pk.z); if (d < pk.r) h += pk.h * (0.5 + 0.5 * Math.cos(Math.PI * d / pk.r)); }
      const s = seaFactor(x, z);
      if (s > 0) h = h * (1 - s) - 16 * s;
      for (const l of lakes) { const d = Math.hypot(x - l.x, z - l.z), b = 1 - smooth(l.r * 0.6, l.r, d); if (b > 0) h = h * (1 - b) + (WATER - l.depth) * b; }
      const edge = Math.max(Math.abs(x), Math.abs(z));
      if (edge > half - 500) h += smooth(half - 500, half + 400, edge) * 140 * (1 - s);                // горы по краю карты
      return h;
    }
    M.rawHeight = rawHeight;
    M.regionAt = (x, z) => R[regionMix(x, z, mixTmp).i];

    // --- дороги ---
    const nodes = {};
    for (const k in def.nodes) {
      const x = def.nodes[k][0] * sc, z = def.nodes[k][1] * sc;
      nodes[k] = { id: k, x, z, y: Math.max(rawHeight(x, z), WATER + 3), edges: [] };
    }
    const rng = C.mulberry32(seed);
    const edges = [];
    const pts = [];              // временные выборки: [x, z, edge]
    def.edges.forEach((e, ei) => {
      const A = nodes[e[0]], B = nodes[e[1]], T = ROAD[e[2]];
      const dx = B.x - A.x, dz = B.z - A.z, len = Math.hypot(dx, dz), ux = dx / len, uz = dz / len, px = -uz, pz = ux;
      const n = Math.max(2, Math.round(len / (T.wl / 2)));
      const ctrl = [[A.x, A.z]];
      for (let k = 1; k < n; k++) {
        const t = k / n, side = k % 2 ? 1 : -1, amp = T.amp * (0.55 + 0.45 * rng()) * Math.min(1, Math.min(t, 1 - t) * n / 1.5);
        ctrl.push([A.x + dx * t + px * side * amp, A.z + dz * t + pz * side * amp]);
      }
      ctrl.push([B.x, B.z]);
      // Катмулл-Ром и равномерная выборка через 2 м
      const dense = [];
      for (let k = 0; k < ctrl.length - 1; k++) {
        const p0 = ctrl[Math.max(0, k - 1)], p1 = ctrl[k], p2 = ctrl[k + 1], p3 = ctrl[Math.min(ctrl.length - 1, k + 2)];
        for (let j = 0; j < 40; j++) {
          const t = j / 40, t2 = t * t, t3 = t2 * t;
          const f = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
          dense.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
        }
      }
      dense.push([B.x, B.z]);
      const cum = [0];
      for (let k = 1; k < dense.length; k++) cum.push(cum[k - 1] + Math.hypot(dense[k][0] - dense[k - 1][0], dense[k][1] - dense[k - 1][1]));
      const total = cum[cum.length - 1], ns = Math.max(2, Math.round(total / 2)), step = total / ns;
      const edge = { id: ei, a: e[0], b: e[1], type: e[2], T, hw: T.hw, len: total, step, i0: pts.length, i1: pts.length + ns, surf: 'asphalt' };
      let j = 0;
      for (let k = 0; k <= ns; k++) {
        const s = k * step;
        while (j < cum.length - 2 && cum[j + 1] < s) j++;
        const t = (s - cum[j]) / Math.max(1e-9, cum[j + 1] - cum[j]);
        pts.push([lerp(dense[j][0], dense[j + 1][0], t), lerp(dense[j][1], dense[j + 1][1], t), ei, s]);
      }
      // покрытие: шоссе - асфальт; просёлок - гравий или снег; дорога и серпантин - по природе середины
      const mid = pts[(edge.i0 + edge.i1) >> 1], bio = R[regionMix(mid[0], mid[1], mixTmp).i].biome;
      if (e[2] === 'dirt') edge.surf = bio === 'snow' ? 'snow' : 'gravel';
      else if (e[2] !== 'highway' && bio === 'snow') edge.surf = 'snow';
      edges.push(edge);
      A.edges.push(ei); B.edges.push(ei);
    });
    const N = pts.length;
    const X = new Float64Array(N), Z = new Float64Array(N), Y = new Float64Array(N), RAW = new Float64Array(N), TX = new Float64Array(N), TZ = new Float64Array(N),
      S = new Float64Array(N), K = new Float64Array(N), E = new Int32Array(N), FL = new Uint8Array(N);
    for (let i = 0; i < N; i++) { X[i] = pts[i][0]; Z[i] = pts[i][1]; E[i] = pts[i][2]; S[i] = pts[i][3]; RAW[i] = rawHeight(X[i], Z[i]); }
    for (const e of edges) {
      for (let i = e.i0; i <= e.i1; i++) {
        const a = Math.max(e.i0, i - 1), b = Math.min(e.i1, i + 1);
        let tx = X[b] - X[a], tz = Z[b] - Z[a]; const l = Math.hypot(tx, tz) || 1; TX[i] = tx / l; TZ[i] = tz / l;
      }
      // высота дороги: сглаженный рельеф, не ниже воды (мосты), с ограничением уклона, концы - в узлах
      const n = e.i1 - e.i0 + 1, y = new Float64Array(n);
      for (let k = 0; k < n; k++) y[k] = Math.max(RAW[e.i0 + k], WATER + 3);
      for (let pass = 0; pass < 4; pass++) {
        const cp = y.slice(), rad = 25;
        for (let k = 0; k < n; k++) { let s = 0, c = 0; for (let q = Math.max(0, k - rad); q <= Math.min(n - 1, k + rad); q += 2) { s += cp[q]; c++; } y[k] = s / c; }
      }
      const ya = nodes[e.a].y, yb = nodes[e.b].y, blend = Math.min(60, n >> 2);
      for (let k = 0; k < blend; k++) { const t = smooth(0, 1, k / blend); y[k] = lerp(ya, y[k], t); y[n - 1 - k] = lerp(yb, y[n - 1 - k], t); }
      y[0] = ya; y[n - 1] = yb;
      const gmax = e.T.grade * e.step;
      for (let it = 0; it < 3; it++) {
        for (let k = 1; k < n; k++) y[k] = clamp(y[k], y[k - 1] - gmax, y[k - 1] + gmax);
        y[n - 1] = yb;
        for (let k = n - 2; k >= 0; k--) y[k] = clamp(y[k], y[k + 1] - gmax, y[k + 1] + gmax);
        y[0] = ya;
      }
      const opt = def.edges[e.id][3] || {};
      if (opt.tunnel) {
        // тоннель: прямой уклон под горой между краями участка
        const k0 = Math.floor(n * opt.tunnel[0]), k1 = Math.floor(n * opt.tunnel[1]);
        for (let k = k0; k <= k1; k++) y[k] = lerp(y[k0], y[k1], (k - k0) / (k1 - k0));
        e.tunnelRange = [e.i0 + k0, e.i0 + k1];
      }
      for (let k = 0; k < n; k++) {
        const i = e.i0 + k; Y[i] = y[k];
        const over = Y[i] - RAW[i];
        if (over > 4.5 || RAW[i] < WATER + 0.5) FL[i] |= 1;          // мост
        if (-over > (e.tunnelRange && i >= e.tunnelRange[0] && i <= e.tunnelRange[1] ? 6 : 14)) FL[i] |= 2;   // тоннель
      }
      // короткие куски моста/тоннеля склеиваем, чтобы не мигали
      for (const bit of [1, 2]) {
        for (let k = e.i0; k <= e.i1; k++) {
          if (FL[k] & bit) continue;
          let q = k; while (q <= e.i1 && !(FL[q] & bit)) q++;
          if (q - k < 12 && k > e.i0 && q <= e.i1) for (let r = k; r < q; r++) FL[r] |= bit;
          k = q;
        }
      }
      for (let i = e.i0; i <= e.i1; i++) {
        const a = Math.max(e.i0, i - 4), b = Math.min(e.i1, i + 4);
        if (a === i || b === i) { K[i] = 0; continue; }
        const ax = X[a], az = Z[a], bx = X[i], bz = Z[i], cx = X[b], cz = Z[b];
        const ab = Math.hypot(bx - ax, bz - az), bc = Math.hypot(cx - bx, cz - bz), ca = Math.hypot(ax - cx, az - cz);
        K[i] = Math.abs(2 * ((bx - ax) * (cz - az) - (bz - az) * (cx - ax)) / Math.max(1e-6, ab * bc * ca));
      }
    }
    Object.assign(M, { nodes, edges, N, X, Z, Y, RAW, TX, TZ, S, K, E, FL });

    // --- сетка для быстрого поиска ближайшей дороги ---
    const CELL = 32, grid = new Map();
    const key = (cx, cz) => (cx + 4096) * 8192 + (cz + 4096);
    for (const e of edges) {
      for (let i = e.i0; i < e.i1; i++) {
        const k = key(Math.floor((X[i] + X[i + 1]) / 2 / CELL), Math.floor((Z[i] + Z[i + 1]) / 2 / CELL));
        let a = grid.get(k); if (!a) grid.set(k, (a = [])); a.push(i);
      }
    }
    // Ближайший участок дороги в радиусе ~32 м (или null).
    function nearestRoad(x, z, out) {
      const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
      let best = 1e18, bi = -1, bt = 0;
      for (let ox = -1; ox <= 1; ox++) for (let oz = -1; oz <= 1; oz++) {
        const a = grid.get(key(cx + ox, cz + oz)); if (!a) continue;
        for (let q = 0; q < a.length; q++) {
          const i = a[q], ax = X[i], az = Z[i], bx = X[i + 1] - ax, bz = Z[i + 1] - az;
          let t = ((x - ax) * bx + (z - az) * bz) / (bx * bx + bz * bz); t = t < 0 ? 0 : t > 1 ? 1 : t;
          const px = ax + bx * t - x, pz = az + bz * t - z, dd = px * px + pz * pz;
          if (dd < best) { best = dd; bi = i; bt = t; }
        }
      }
      if (bi < 0) return null;
      out = out || {};
      const e = edges[E[bi]], j = bi + 1;
      out.i = bi; out.t = bt; out.edge = e; out.hw = e.hw; out.surf = e.surf; out.d = Math.sqrt(best);
      out.y = lerp(Y[bi], Y[j], bt); out.raw = lerp(RAW[bi], RAW[j], bt);
      let tx = lerp(TX[bi], TX[j], bt), tz = lerp(TZ[bi], TZ[j], bt); const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
      out.tx = tx; out.tz = tz; out.nx = -tz; out.nz = tx;
      out.lat = (x - lerp(X[bi], X[j], bt)) * out.nx + (z - lerp(Z[bi], Z[j], bt)) * out.nz;
      out.bridge = !!(FL[bi] & 1); out.tunnel = !!(FL[bi] & 2);
      out.s = lerp(S[bi], S[j], bt);
      return out;
    }
    M.nearestRoad = nearestRoad;
    const nrTmp = {};
    // Рельеф с дорогами: у дороги земля ровняется под полотно, у тоннеля - прорезь, под мостом - как есть.
    function terrainHeight(x, z) {
      const raw = rawHeight(x, z), q = nearestRoad(x, z, nrTmp);
      if (!q) return raw;
      const hw = q.hw;
      if (q.bridge) return q.d < hw + 1.5 && raw > q.y - 0.3 ? q.y - 0.3 : raw;
      if (q.tunnel) { const t = smooth(hw + 3, hw + 10, q.d); return lerp(q.y - 0.3, raw, t); }
      const t = smooth(hw + 1.5, hw + 26, q.d);
      return lerp(q.y - 0.3, raw, t);
    }
    M.terrainHeight = terrainHeight;
    M.surfAt = (x, z) => BIOME[R[regionMix(x, z, mixTmp).i].biome].surf;
    M.biomeColor = function (x, z, out) {
      // смесь цветов областей
      let ws = 0, r = 0, g = 0, b = 0;
      for (const rg of R) {
        const dx = x - rg.x, dz = z - rg.z, w = Math.exp(-(dx * dx + dz * dz) / (RW * RW * 0.45)) + 1e-6;
        const c = BIOME[rg.biome].color, n = parseInt(c.slice(1), 16);
        r += w * (n >> 16); g += w * ((n >> 8) & 255); b += w * (n & 255); ws += w;
      }
      out = out || [0, 0, 0]; out[0] = r / ws / 255; out[1] = g / ws / 255; out[2] = b / ws / 255;
      return out;
    };

    // --- точки: события, радары, зоны дрифта, рампы, щиты, фестиваль ---
    const prng = C.mulberry32(seed ^ 0x5bd1);
    const P = [];
    const roadside = (i, side, off) => ({ x: X[i] + (-TZ[i]) * side * off, z: Z[i] + TX[i] * side * off });
    const nodeRoad = (k) => { const nd = nodes[k], e = edges[nd.edges[0]], i = e.a === k ? e.i0 + 18 : e.i1 - 18; return i; };
    const fi = nodeRoad('F'), fp = roadside(fi, 1, edges[E[fi]].hw + 42);
    P.push({ id: 'fest', type: 'fest', name: 'Фестиваль', x: fp.x, z: fp.z, i: fi, open: true });
    R.forEach((r) => {
      if (!r.track) return;
      let bestK = null, bd = 1e18;
      for (const k in nodes) { const d = Math.hypot(nodes[k].x - r.x, nodes[k].z - r.z); if (d < bd) { bd = d; bestK = k; } }
      const i = nodeRoad(bestK), p = roadside(i, -1, edges[E[i]].hw + 16);
      const td = D.TRACKS.find((t) => t.id === r.track);
      P.push({ id: 'ev-' + r.track, type: 'event', name: td ? td.name : r.name, track: r.track, x: p.x, z: p.z, i });
    });
    const pickEdges = (types) => edges.filter((e) => types.includes(e.type));
    // радары: прямой участок в середине шоссе и дорог
    const radarEdges = pickEdges(['highway', 'road']).sort((a, b) => b.len - a.len);
    for (let k = 0; k < def.points.radars && radarEdges.length; k++) {
      const e = radarEdges[k % radarEdges.length];
      let bestI = -1, bestK = 1e9;
      const f0 = 0.25 + ((k / radarEdges.length) | 0) * 0.3;
      for (let i = e.i0 + Math.floor((e.i1 - e.i0) * f0); i < e.i0 + Math.floor((e.i1 - e.i0) * (f0 + 0.3)); i += 5) {
        let kk = 0; for (let q = -30; q <= 30; q += 5) kk = Math.max(kk, K[clamp(i + q, e.i0, e.i1)]);
        if (kk < bestK && !FL[i]) { bestK = kk; bestI = i; }
      }
      if (bestI < 0) continue;
      const p = roadside(bestI, 1, e.hw + 2.5);
      P.push({ id: 'radar-' + k, type: 'radar', name: 'Радар ' + (k + 1), x: p.x, z: p.z, i: bestI, cx: X[bestI], cz: Z[bestI], stars: [110, 160, 210].map((v) => v + (e.type === 'highway' ? 30 : 0)) });
    }
    // зоны дрифта: самые извилистые 360 м дорог, серпантинов и просёлков
    const cand = [];
    for (const e of pickEdges(['road', 'serp', 'dirt'])) {
      for (let i = e.i0 + 40; i < e.i1 - 220; i += 30) { let s = 0; for (let q = i; q < i + 180; q += 3) s += K[q]; if (!FL[i] && !FL[i + 180]) cand.push({ e, i, s }); }
    }
    cand.sort((a, b) => b.s - a.s);
    const dz = [];
    for (const c of cand) {
      if (dz.length >= def.points.drift) break;
      if (dz.some((o) => Math.hypot(X[o.i] - X[c.i], Z[o.i] - Z[c.i]) < 900)) continue;
      dz.push(c);
    }
    dz.forEach((c, k) => P.push({ id: 'drift-' + k, type: 'drift', name: 'Зона дрифта ' + (k + 1), x: X[c.i], z: Z[c.i], i: c.i, i0: c.i, i1: c.i + 180, edge: c.e.id,
      stars: [4000, 9000, 16000] }));
    // рампы: у прямых участков просёлков и дорог, рядом с полотном
    const jumpEdges = pickEdges(['dirt', 'road']);
    const ramps = [];
    for (let k = 0; k < def.points.jumps && jumpEdges.length; k++) {
      const e = jumpEdges[(k * 3 + 1) % jumpEdges.length];
      const i = e.i0 + Math.floor((e.i1 - e.i0) * (0.3 + 0.4 * prng()));
      if (FL[i]) continue;
      const side = k % 2 ? 1 : -1, p = roadside(i, side, e.hw + 9);
      const ramp = { x: p.x, z: p.z, tx: TX[i], tz: TX[i] === 0 && TZ[i] === 0 ? 1 : TZ[i], len: 14, w: 6, h: 3.2 };
      ramp.y0 = rawHeight(p.x, p.z);
      ramps.push(ramp);
      P.push({ id: 'jump-' + k, type: 'jump', name: 'Рампа ' + (k + 1), x: p.x, z: p.z, i, ramp, stars: [25, 45, 70] });
    }
    M.ramps = ramps;
    // щиты: разбросаны у дорог, часть - подальше, на бездорожье
    for (let k = 0; k < def.points.boards; k++) {
      const e = edges[Math.floor(prng() * edges.length)];
      const i = e.i0 + 20 + Math.floor(prng() * Math.max(1, e.i1 - e.i0 - 40));
      const off = e.hw + (k % 4 === 0 ? 30 + prng() * 40 : 4 + prng() * 8);
      const p = roadside(i, prng() < 0.5 ? -1 : 1, off);
      if (rawHeight(p.x, p.z) < WATER + 0.5) { k--; continue; }
      P.push({ id: 'board-' + (k < 9 ? '0' : '') + (k + 1), type: 'board', name: 'Щит', x: p.x, z: p.z, i, rot: Math.atan2(TX[i], TZ[i]) });
    }
    for (const p of P) p.y = p.type === 'jump' ? p.ramp.y0 : groundAtRaw(p.x, p.z);
    M.points = P;
    M.pointById = (pid) => P.find((p) => p.id === pid);

    // --- земля для физики: дорога, рельеф, рампы ---
    function rampHeight(x, z) {
      let y = -1e9;
      for (const r of ramps) {
        const dx = x - r.x, dz = z - r.z, u = dx * r.tx + dz * r.tz, v = dx * -r.tz + dz * r.tx;
        if (u >= 0 && u <= r.len && Math.abs(v) <= r.w / 2) y = Math.max(y, r.y0 + r.h * (u / r.len));
      }
      return y;
    }
    function groundAtRaw(x, z) { const q = nearestRoad(x, z, nrTmp); if (q && q.d <= q.hw + 0.6) return q.y; return terrainHeight(x, z); }
    const gq = {};
    M.groundAt = function (x, z, out) {
      out = out || {};
      const q = nearestRoad(x, z, gq);
      if (q && q.d <= q.hw + 0.6) { out.y = q.y; out.surf = q.surf; out.onRoad = true; out.q = q; } else { out.y = terrainHeight(x, z); out.surf = M.surfAt(x, z); out.onRoad = false; out.q = q; }
      const ry = rampHeight(x, z);
      if (ry > out.y) { out.y = ry; out.onRoad = true; out.surf = 'asphalt'; out.ramp = true; } else out.ramp = false;
      out.water = out.y < WATER - 0.2;
      return out;
    };

    // --- декор куска: одинаков для рисования и столкновений ---
    const decorCache = new Map();
    M.chunkDecor = function (cx, cz) {
      const k = key(cx, cz);
      if (decorCache.has(k)) return decorCache.get(k);
      const out = [], r = C.mulberry32((seed * 131 + cx * 7919 + cz * 104729) >>> 0);
      const x0 = cx * CHUNK, z0 = cz * CHUNK;
      const reg = M.regionAt(x0 + CHUNK / 2, z0 + CHUNK / 2);
      const decor = reg.decor || [];
      const dens = { tree: 22, pine: reg.biome === 'forest' ? 34 : 16, snowpine: 20, palm: 10, cactus: 12, rock: 7 };
      for (const type of decor) {
        if (!(type in dens)) continue;
        for (let n = 0; n < dens[type]; n++) {
          const x = x0 + r() * CHUNK, z = z0 + r() * CHUNK, s = 0.75 + r() * 0.7, rot = r() * 6.283;
          const q = nearestRoad(x, z, nrTmp); if (q && q.d < q.hw + 6) continue;
          const y = terrainHeight(x, z); if (y < WATER + 0.4) continue;
          if (Math.abs(x) > half || Math.abs(z) > half) continue;
          out.push({ type, x, y, z, s, rot, r: PROP_R[type] * s * (type === 'rock' ? 1 : 1) });
        }
      }
      if (decor.includes('building') || decor.includes('container')) {
        const btype = decor.includes('building') ? 'building' : 'container';
        const count = btype === 'building' ? (reg.biome === 'concrete' ? 10 : 4) : 12;
        for (let n = 0; n < count; n++) {
          const x = x0 + r() * CHUNK, z = z0 + r() * CHUNK;
          const q = nearestRoad(x, z, nrTmp);
          const w = btype === 'building' ? 14 + r() * 14 : 2.5, d = btype === 'building' ? 14 + r() * 12 : 6.1, h = btype === 'building' ? (reg.biome === 'concrete' ? 12 + r() * 50 : 7 + r() * 6) : 2.6 * (1 + Math.floor(r() * 3));
          if (!q || q.d < q.hw + 6 + Math.max(w, d) * 0.72 || q.d > 90) continue;
          if (out.some((o) => (o.type === btype) && Math.abs(o.x - x) < (o.w + w) * 0.6 && Math.abs(o.z - z) < (o.d + d) * 0.6)) continue;
          const y = terrainHeight(x, z); if (y < WATER + 0.4) continue;
          out.push({ type: btype, x, y, z, w, d, h, rot: Math.atan2(q.tx, q.tz), r: Math.min(w, d) * 0.5, col: r() });
        }
      }
      decorCache.set(k, out);
      if (decorCache.size > 600) decorCache.delete(decorCache.keys().next().value);
      return out;
    };
    M.chunkOf = (x, z) => [Math.floor(x / CHUNK), Math.floor(z / CHUNK)];
    M.CHUNK = CHUNK;
    // выборки дорог, попадающие в кусок (для рисования)
    M.roadSamplesIn = function (cx, cz, margin) {
      const res = [], x0 = cx * CHUNK - margin, z0 = cz * CHUNK - margin, x1 = x0 + CHUNK + 2 * margin, z1 = z0 + CHUNK + 2 * margin;
      const c0x = Math.floor(x0 / CELL), c1x = Math.floor(x1 / CELL), c0z = Math.floor(z0 / CELL), c1z = Math.floor(z1 / CELL);
      const seen = new Set();
      for (let gx = c0x; gx <= c1x; gx++) for (let gz = c0z; gz <= c1z; gz++) { const a = grid.get(key(gx, gz)); if (a) for (const i of a) seen.add(i); }
      for (const i of seen) res.push(i);
      res.sort((a, b) => a - b);
      return res;
    };

    // граф: соседи узлов
    M.adj = {};
    for (const e of edges) { (M.adj[e.a] = M.adj[e.a] || []).push(e.b); (M.adj[e.b] = M.adj[e.b] || []).push(e.a); }
    M.totalRoad = edges.reduce((s, e) => s + e.len, 0);
    built[id] = M;
    return M;
  }

  // Связность графа дорог: из узла festival (F) обходом в ширину.
  function graphConnected(M) {
    const start = Object.keys(M.nodes)[0], seen = new Set([start]), q = [start];
    while (q.length) { const n = q.shift(); for (const m of M.adj[n] || []) if (!seen.has(m)) { seen.add(m); q.push(m); } }
    return { all: Object.keys(M.nodes).length, reached: seen.size };
  }

  // Путь по дорогам между двумя выборками (по рёбрам через узлы) - список рёбер, либо null.
  function routeEdges(M, fromEdge, toEdge) {
    if (fromEdge === toEdge) return [fromEdge];
    const E = M.edges, prev = new Map([[fromEdge, -1]]), q = [fromEdge];
    while (q.length) {
      const e = q.shift();
      for (const nk of [E[e].a, E[e].b]) for (const ne of M.nodes[nk].edges) if (!prev.has(ne)) { prev.set(ne, e); if (ne === toEdge) { const out = [ne]; let c = e; while (c !== -1) { out.unshift(c); c = prev.get(c); } return out; } q.push(ne); }
    }
    return null;
  }

  // ======================= СИМУЛЯЦИЯ СВОБОДНОЙ ЕЗДЫ =======================
  const WEATHER = {
    clear: { name: 'Ясно', grip: { asphalt: 1, gravel: 1, snow: 1 } },
    rain: { name: 'Дождь', grip: { asphalt: 0.8, gravel: 0.9, snow: 0.95, concrete: 0.8, grass: 0.85, sand: 0.95 } },
    fog: { name: 'Туман', grip: {} },
    snow: { name: 'Снег', grip: { asphalt: 0.78, gravel: 0.88, concrete: 0.78, grass: 0.8 } },
  };
  function newSave(mapId) {
    const M = buildMap(mapId);
    const disc = {}; for (const p of M.points) if (p.open) disc[p.id] = true;
    return { v: 1, map: mapId, pos: null, disc, boards: {}, rec: { radar: {}, drift: {}, jump: {} }, weather: M.def.weather, tod: M.def.tod, autoTime: true };
  }

  // Сохранение карты из хранилища: только известные точки, числа в пределах, положение внутри карты.
  function sanitizeSave(mapId, raw) {
    const M = buildMap(mapId), s = newSave(M.id), o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const ids = new Set(M.points.map((p) => p.id));
    const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
    const pos = obj(o.pos);
    if ([pos.x, pos.z].every((v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < M.half)) s.pos = { x: pos.x, z: pos.z, h: Number.isFinite(pos.h) ? pos.h : 0 };
    for (const k in obj(o.disc)) if (ids.has(k) && o.disc[k] === true) s.disc[k] = true;
    for (const k in obj(o.boards)) if (ids.has(k) && k.startsWith('board-') && o.boards[k] === true) s.boards[k] = true;
    const rec = obj(o.rec);
    for (const t of ['radar', 'drift', 'jump']) for (const k in obj(rec[t])) { const n = Number(rec[t][k]); if (ids.has(k) && Number.isFinite(n) && n > 0) s.rec[t][k] = n; }
    if (WEATHER[o.weather]) s.weather = o.weather;
    if (typeof o.tod === 'number' && o.tod >= 0 && o.tod < 24) s.tod = o.tod;
    if (typeof o.autoTime === 'boolean') s.autoTime = o.autoTime;
    if (typeof o.car === 'string' && D.CARS.some((c) => c.id === o.car)) s.car = o.car;
    return s;
  }

  function collidePair(a, b) {
    for (let ka = -1.15; ka <= 1.15; ka += 2.3) {
      for (let kb = -1.15; kb <= 1.15; kb += 2.3) {
        const ax = a.x + Math.sin(a.h) * ka, az = a.z + Math.cos(a.h) * ka, bx = b.x + Math.sin(b.h) * kb, bz = b.z + Math.cos(b.h) * kb;
        let dx = bx - ax, dz = bz - az; const d = Math.hypot(dx, dz);
        if (d >= 2 || d < 1e-6 || Math.abs(a.y - b.y) > 2.5) continue;
        dx /= d; dz /= d;
        const ima = 1 / a.st.mass, imb = 1 / b.st.mass, pen = 2 - d;
        a.x -= dx * pen * ima / (ima + imb); a.z -= dz * pen * ima / (ima + imb); b.x += dx * pen * imb / (ima + imb); b.z += dz * pen * imb / (ima + imb);
        const rax = -Math.cos(a.h), raz = Math.sin(a.h), rbx = -Math.cos(b.h), rbz = Math.sin(b.h);
        const vrel = (b.vx + b.w * kb * rbx - a.vx - a.w * ka * rax) * dx + (b.vz + b.w * kb * rbz - a.vz - a.w * ka * raz) * dz;
        if (vrel >= 0) continue;
        const la = ka * (rax * dx + raz * dz), lb = kb * (rbx * dx + rbz * dz);
        const J = -1.3 * vrel / (ima + imb + la * la / a.st.I + lb * lb / b.st.I);
        b.vx += J * imb * dx; b.vz += J * imb * dz; b.w += J * lb / b.st.I; a.vx -= J * ima * dx; a.vz -= J * ima * dz; a.w -= J * la / a.st.I;
        a.hit = Math.max(a.hit, -vrel); b.hit = Math.max(b.hit, -vrel);
      }
    }
  }

  class World {
    // opts: { map, car, upg, look, save, seed, assist, traffic }
    constructor(opts) {
      this.M = buildMap(opts.map);
      this.save = opts.save || newSave(this.M.id);
      this.rng = C.mulberry32((opts.seed >>> 0) || 7);
      this.t = 0; this.events = []; this.traffic = []; this.rivals = []; this.trafficOn = opts.traffic !== false;
      this.drift = new C.DriftScorer(); this.zone = null; this.radarPass = null; this.jump = null;
      const c = C.makeCar(C.carStats(opts.car, opts.upg), { name: 'Вы', isPlayer: true, look: opts.look });
      if (opts.assist) Object.assign(c.assist, opts.assist);
      this.player = c;
      this.cars = [c];
      this.g = {}; this.tick = 0; this.nearHub = null; this.nearRival = null;
      const p = this.save.pos;
      if (p && isFinite(p.x)) this.placeAt(p.x, p.z, p.h); else this.placeAtPoint('fest');
      this.initRivals();
    }
    get weather() { return this.save.weather; }
    // Поставить машину на дорогу рядом с точкой (x, z), носом по ходу дороги (ближе к heading).
    placeAt(x, z, heading) {
      const c = this.player, M = this.M;
      let q = M.nearestRoad(x, z);
      let i;
      if (!q) { let best = 1e18; for (let k = 0; k < M.N; k += 5) { const d = (M.X[k] - x) ** 2 + (M.Z[k] - z) ** 2; if (d < best) { best = d; i = k; } } } else i = q.i;
      let h = Math.atan2(M.TX[i], M.TZ[i]);
      if (heading !== undefined && Math.cos(heading - h) < 0) h += Math.PI;
      c.x = M.X[i]; c.z = M.Z[i]; c.h = h; c.vx = c.vz = c.w = 0; c.steer = 0; c.gear = 1;
      c.y = M.groundAt(c.x, c.z).y; c.vy = 0; c.air = false; c.prevX = c.x; c.prevZ = c.z;
      this.events.push({ type: 'placed' });
    }
    // Автопилот игрока (для проверок и снимков): едет по дорогам как соперник.
    setAutopilot(cruise) {
      const p = this.player;
      if (!cruise) { p.autopilot = null; return; }
      const q = this.M.nearestRoad(p.x, p.z) || { i: 0 };
      const e = this.M.edges[this.M.E[q.i]], dir = Math.cos(p.h - Math.atan2(this.M.TX[q.i], this.M.TZ[q.i])) >= 0 ? 1 : -1;
      p.autopilot = { car: p, edge: e.id, dir, i: q.i, cruise, rival: true, name: 'Вы' };
      p.assist = { tc: true, abs: true, steer: false, auto: true, sens: 1 };
    }
    placeAtPoint(pid) { const p = this.M.pointById(pid); if (p) this.placeAt(p.x, p.z); }
    resetPlayer() { const c = this.player; this.placeAt(c.x, c.z, c.h); this.events.push({ type: 'reset' }); }
    // Быстрое перемещение: только к открытым точкам.
    fastTravel(pid) {
      if (!this.save.disc[pid]) return false;
      this.placeAtPoint(pid);
      this.events.push({ type: 'travel', id: pid });
      return true;
    }
    discoverNear(radius) {
      const c = this.player; let n = 0;
      for (const p of this.M.points) if (!this.save.disc[p.id] && Math.hypot(p.x - c.x, p.z - c.z) < radius) { this.save.disc[p.id] = true; n++; this.events.push({ type: 'discover', point: p }); }
      if (n) this.dirty = true;
    }

    initRivals() {
      const M = this.M, names = Object.values(D.RIVALS);
      const roads = M.edges.filter((e) => e.type === 'highway' || e.type === 'road');
      for (let k = 0; k < 2 && roads.length; k++) {
        const e = roads[(k * 5 + 2) % roads.length];
        const car = ['sapsan', 'kometa'][k];
        const a = this.spawnAi(e, Math.floor((e.i0 + e.i1) / 2), k ? 1 : -1, car, names[(k + M.seed) % names.length], 30, true);
        this.rivals.push(a);
      }
    }
    spawnAi(e, i, dir, carId, name, cruise, rival) {
      const M = this.M, c = C.makeCar(C.carStats(carId, rival ? { engine: 2, tyres: 2, susp: 2 } : {}), { name });
      c.assist = { tc: true, abs: true, steer: false, auto: true, sens: 1 };
      const lane = dir * e.hw * 0.45;
      c.x = M.X[i] + (-M.TZ[i]) * lane; c.z = M.Z[i] + M.TX[i] * lane; c.h = Math.atan2(M.TX[i] * dir, M.TZ[i] * dir);
      c.y = M.groundAt(c.x, c.z).y; c.vy = 0; c.air = false;
      const sp = cruise * 0.6; c.vx = Math.sin(c.h) * sp; c.vz = Math.cos(c.h) * sp;
      const a = { car: c, edge: e.id, dir, i, cruise, rival: !!rival, name, cool: 0, id: (this.aiId = (this.aiId || 0) + 1) };
      c.world = a; c.rival = !!rival;
      this.cars.push(c);
      return a;
    }
    removeAi(a) {
      this.cars.splice(this.cars.indexOf(a.car), 1);
      const L = a.rival ? this.rivals : this.traffic; L.splice(L.indexOf(a), 1);
      this.events.push({ type: 'despawn', car: a.car });
    }

    updateTraffic() {
      const M = this.M, p = this.player;
      for (const a of this.traffic.slice()) if (Math.hypot(a.car.x - p.x, a.car.z - p.z) > 900) this.removeAi(a);
      if (!this.trafficOn || this.traffic.length >= 6) return;
      // появиться на шоссе или дороге в 300-650 м от игрока
      for (let tries = 0; tries < 20; tries++) {
        const i = Math.floor(this.rng() * M.N), e = M.edges[M.E[i]];
        if (!e.T.traffic || M.FL[i] || i < e.i0 + 30 || i > e.i1 - 30) continue;
        const d = Math.hypot(M.X[i] - p.x, M.Z[i] - p.z);
        if (d < 300 || d > 650) continue;
        const pool = ['iskra', 'kobalt', 'buran', 'sapsan', 'taifun'], car = pool[Math.floor(this.rng() * pool.length)];
        const a = this.spawnAi(e, i, this.rng() < 0.5 ? 1 : -1, car, 'Попутчик', (e.type === 'highway' ? 25 : 18) + this.rng() * 5, false);
        a.car.look = { color: D.PAINTS[Math.floor(this.rng() * D.PAINTS.length)], color2: '#f4f4f4', rims: 'solid', rimColor: '#c9ced6', livery: 'none' };
        this.traffic.push(a);
        break;
      }
    }

    // ИИ свободной езды: по полосе своей стороны, на развилке - случайное продолжение.
    aiDrive(a, dt) {
      const M = this.M, c = a.car, e = M.edges[a.edge];
      // где мы на ребре
      let bi = a.i, bd = 1e18;
      for (let k = a.i - 8; k <= a.i + 8; k++) { if (k < e.i0 || k > e.i1) continue; const d = (M.X[k] - c.x) ** 2 + (M.Z[k] - c.z) ** 2; if (d < bd) { bd = d; bi = k; } }
      a.i = bi;
      const endNear = a.dir > 0 ? e.i1 - a.i < 4 : a.i - e.i0 < 4;
      if (endNear && !a.turned) {
        const node = a.dir > 0 ? e.b : e.a, opts = M.nodes[node].edges.filter((x) => x !== a.edge && (a.rival || M.edges[x].T.traffic));
        if (opts.length) {
          const next = a.next !== undefined && opts.includes(a.next) ? a.next : opts[Math.floor(this.rng() * opts.length)], ne = M.edges[next];
          a.next = undefined;
          a.edge = next; a.dir = ne.a === node ? 1 : -1; a.i = a.dir > 0 ? ne.i0 : ne.i1;
        } else a.dir = -a.dir;                      // тупик - разворот
        a.turned = true;
        return this.aiDrive(a, dt);
      }
      a.turned = false;
      const v = c.speed, E2 = M.edges[a.edge];
      const la = Math.round((6 + v * 0.45) / E2.step), j = clamp(a.i + a.dir * la, E2.i0, E2.i1);
      const lane = a.dir * E2.hw * 0.45;
      const tx = M.X[j] + (-M.TZ[j]) * lane, tz = M.Z[j] + M.TX[j] * lane;
      const fx = Math.sin(c.h), fz = Math.cos(c.h), dx = tx - c.x, dz = tz - c.z;
      const ang = Math.atan2(dx * -fz + dz * fx, Math.max(0.5, dx * fx + dz * fz)), dist = Math.hypot(dx, dz) || 1;
      const smax = c.st.steer / (1 + v / 30);
      c.inp.steer = clamp((Math.atan2(2 * 2.6 * Math.sin(ang), dist) * 1.25 + c.beta * 0.7) / smax, -1, 1); c.inp.analog = true;
      // скорость: по кривизне впереди
      let vt = a.cruise;
      const wg = (WEATHER[this.save.weather] || WEATHER.clear).grip[E2.surf] || 1;
      const mu = c.st.grip * C.surfMu(E2.surf, c.st) * wg * 0.78, dec = mu * G * 0.55;
      for (let q = 0; q < 90; q += 3) {
        const k = clamp(a.i + a.dir * q, E2.i0, E2.i1), kap = M.K[k];
        if (kap > 1e-4) vt = Math.min(vt, Math.sqrt(mu * G / kap + 2 * dec * q * E2.step));
      }
      // развилка впереди: заранее выбрать продолжение и сбросить скорость под угол поворота
      const left = a.dir > 0 ? E2.i1 - a.i : a.i - E2.i0;
      if (left * E2.step < 160) {
        const node = a.dir > 0 ? E2.b : E2.a, opts = M.nodes[node].edges.filter((x) => x !== a.edge && (a.rival || M.edges[x].T.traffic));
        if (a.next === undefined || !opts.includes(a.next)) a.next = opts.length ? opts[Math.floor(this.rng() * opts.length)] : -1;
        let ang = Math.PI;
        if (a.next >= 0) {
          const ne = M.edges[a.next], d2 = ne.a === node ? 1 : -1, j2 = d2 > 0 ? ne.i0 + 6 : ne.i1 - 6, j1 = a.dir > 0 ? E2.i1 - 6 : E2.i0 + 6;
          const t1x = M.TX[j1] * a.dir, t1z = M.TZ[j1] * a.dir, t2x = M.TX[j2] * d2, t2z = M.TZ[j2] * d2;
          ang = Math.acos(clamp(t1x * t2x + t1z * t2z, -1, 1));
        }
        const vj = ang < 0.25 ? a.cruise : Math.sqrt(mu * G * 14 / ang);
        vt = Math.min(vt, Math.sqrt(vj * vj + 2 * dec * left * E2.step));
      }
      // не въезжать в машину впереди
      for (const o of this.cars) {
        if (o === c) continue;
        const ox = o.x - c.x, oz = o.z - c.z, ahead = ox * fx + oz * fz, side = Math.abs(ox * -fz + oz * fx);
        if (ahead > 0 && ahead < 26 && side < 2.8) vt = Math.min(vt, o.speed + (ahead - 9) * 0.5);
      }
      vt = Math.max(0, vt);
      if (v < vt - 0.5) { c.inp.thr = 0.8; c.inp.brk = 0; } else if (v > vt + 1.5) { c.inp.thr = 0; c.inp.brk = clamp((v - vt) / 4, 0.2, 1); } else { c.inp.thr = 0.3; c.inp.brk = 0; }
      c.inp.hb = 0; c.inp.nitro = 0;
    }

    // Один шаг машины в мире: шины на земле, полёт в воздухе, земля по функции рельефа (не по сетке).
    stepCarWorld(c, dt) {
      const M = this.M, g = this.g;
      const g0 = M.groundAt(c.x, c.z, g);
      c.surf = g0.surf; c.onRunoff = !g0.onRoad;
      const wg = WEATHER[this.save.weather] || WEATHER.clear;
      c.gripMul = wg.grip[g0.surf] || 1;
      const yPrev = c.y;
      if (!c.air) C.stepCar(c, dt, g0.surf);
      else { c.x += c.vx * dt; c.z += c.vz * dt; c.h -= c.w * dt; c.w *= 1 - dt * 0.5; c.speed = Math.hypot(c.vx, c.vz); c.skidR = c.skidF = 0; }
      const g1 = M.groundAt(c.x, c.z, g);
      if (!c.air) {
        if (g1.y >= yPrev - 0.35) { c.vy = (g1.y - yPrev) / dt; c.y = g1.y; } else { c.air = true; c.airT = 0; c.vy = Math.min(c.vy || 0, 12); }
      }
      if (c.air) {
        c.airT = (c.airT || 0) + dt;
        c.vy -= G * dt; c.y += c.vy * dt;
        if (c.y <= g1.y) { const impact = -c.vy; c.y = g1.y; c.vy = 0; c.air = false; if (impact > 6) c.hit = Math.max(c.hit || 0, impact * 0.4); c.landed = true; }
      }
      if (c.y < g1.y) c.y = g1.y;                     // никогда не ниже земли
      c.inWater = c.y < WATER - 0.8;
      // ограждения мостов и тоннелей
      const q = g1.q;
      if (q && (q.bridge || q.tunnel) && Math.abs(c.y - q.y) < 3) {
        const lim = q.hw + 0.4 - 0.95;
        if (Math.abs(q.lat) > lim && Math.abs(q.lat) < q.hw + 4) {
          const sg = q.lat > 0 ? 1 : -1, onx = sg * q.nx, onz = sg * q.nz, pen = Math.abs(q.lat) - lim;
          c.x -= onx * pen; c.z -= onz * pen;
          const vn = c.vx * onx + c.vz * onz;
          if (vn > 0) { c.vx -= 1.3 * vn * onx; c.vz -= 1.3 * vn * onz; c.w *= 0.6; c.hit = Math.max(c.hit || 0, vn); }
        }
      }
      // деревья, камни, дома
      const [cx, cz] = M.chunkOf(c.x, c.z);
      for (let ox = -1; ox <= 1; ox++) for (let oz = -1; oz <= 1; oz++) {
        const lx = (c.x - cx * CHUNK), lz = (c.z - cz * CHUNK);
        if ((ox === -1 && lx > 12) || (ox === 1 && lx < CHUNK - 12) || (oz === -1 && lz > 12) || (oz === 1 && lz < CHUNK - 12)) continue;
        for (const d of M.chunkDecor(cx + ox, cz + oz)) {
          if (!d.r) continue;
          const dx = c.x - d.x, dz = c.z - d.z, dist = Math.hypot(dx, dz), min = d.r + 1.0;
          if (dist >= min || dist < 1e-6 || c.y > d.y + (d.h || 6)) continue;
          const nx = dx / dist, nz = dz / dist; c.x += nx * (min - dist); c.z += nz * (min - dist);
          const vn = c.vx * nx + c.vz * nz;
          if (vn < 0) { c.vx -= 1.25 * vn * nx; c.vz -= 1.25 * vn * nz; c.w *= 0.5; c.hit = Math.max(c.hit || 0, -vn); }
        }
      }
    }

    step(dt, pin) {
      dt = dt || DT;
      const M = this.M, p = this.player;
      this.t += dt;
      if (this.save.autoTime) this.save.tod = (this.save.tod + dt / 40) % 24;        // час игры = 40 с
      for (const c of this.cars) { c.hit = 0; c.landed = false; c.prevX = c.x; c.prevZ = c.z; }
      if (pin && !p.autopilot) {
        const q = p.inp; q.thr = pin.thr || 0; q.brk = pin.brk || 0; q.steer = pin.steer || 0; q.hb = pin.hb ? 1 : 0; q.nitro = pin.nitro ? 1 : 0; q.analog = !!pin.analog;
        if (pin.shiftUp) { q.shiftUp = true; pin.shiftUp = false; }
        if (pin.shiftDown) { q.shiftDown = true; pin.shiftDown = false; }
      } else if (p.autopilot) this.aiDrive(p.autopilot, dt);
      for (const a of this.traffic) this.aiDrive(a, dt);
      for (const a of this.rivals) this.aiDrive(a, dt);
      for (const c of this.cars) this.stepCarWorld(c, dt);
      for (let i = 0; i < this.cars.length; i++) for (let j = i + 1; j < this.cars.length; j++) {
        const a = this.cars[i], b = this.cars[j];
        if (Math.abs(a.x - b.x) < 6 && Math.abs(a.z - b.z) < 6) collidePair(a, b);
      }
      p.nitro = Math.min(1, p.nitro + dt * 0.02);
      if (p.inWater) { this.events.push({ type: 'water' }); this.resetPlayer(); }
      this.points(dt);
      if ((this.tick++ % 60) === 0) { this.discoverNear(260); this.updateTraffic(); }
      this.save.pos = { x: p.x, z: p.z, h: p.h };
    }

    // Точки мира: щиты, радары, зоны дрифта, прыжки, события, соперники.
    points(dt) {
      const M = this.M, p = this.player, S = this.save;
      this.nearHub = null;
      for (const pt of M.points) {
        const d = Math.hypot(pt.x - p.x, pt.z - p.z);
        if (pt.type === 'board') {
          if (!S.boards[pt.id] && d < 3.4 && Math.abs(p.y - pt.y) < 4) { S.boards[pt.id] = true; this.dirty = true; this.events.push({ type: 'board', point: pt, reward: 500 }); }
        } else if (pt.type === 'event' || pt.type === 'fest') {
          if (d < 28) this.nearHub = pt;
        } else if (pt.type === 'radar') {
          const dc = Math.hypot(pt.cx - p.x, pt.cz - p.z);
          if (dc < 14) { if (!this.radarPass || this.radarPass.id !== pt.id) this.radarPass = { id: pt.id, v: 0 }; this.radarPass.v = Math.max(this.radarPass.v, p.speed * 3.6); }
          else if (this.radarPass && this.radarPass.id === pt.id && dc > 18) {
            const v = Math.round(this.radarPass.v), best = S.rec.radar[pt.id] || 0;
            if (v > best) { S.rec.radar[pt.id] = v; this.dirty = true; }
            this.events.push({ type: 'radar', point: pt, v, best: Math.max(v, best), record: v > best });
            this.radarPass = null;
          }
        }
      }
      // зона дрифта: пока ближайшая выборка дороги в диапазоне зоны
      const q = this.g.q;
      let zone = null;
      if (q) for (const pt of M.points) if (pt.type === 'drift' && q.i >= pt.i0 && q.i <= pt.i1) zone = pt;
      if (zone && !this.zone) { this.zone = zone; this.drift = new C.DriftScorer(); this.events.push({ type: 'zoneIn', point: zone }); }
      if (this.zone) {
        this.drift.update(dt, Math.abs(p.beta) * 57.2958, p.speed, !p.onRunoff);
        if (p.hit > 2.5 && this.drift.crash()) this.events.push({ type: 'comboLost' });
        if (!zone || zone !== this.zone) {
          this.drift.bank();
          const pts = this.drift.total, pt = this.zone, best = S.rec.drift[pt.id] || 0;
          if (pts > best) { S.rec.drift[pt.id] = pts; this.dirty = true; }
          this.events.push({ type: 'zoneOut', point: pt, pts, best: Math.max(pts, best), record: pts > best });
          this.zone = null;
        }
      }
      // прыжок: взлёт рядом с рампой - замер дальности до приземления
      if (p.air && !this.jump && p.airT < 0.1) {
        for (const pt of M.points) if (pt.type === 'jump' && Math.hypot(pt.x + pt.ramp.tx * pt.ramp.len - p.x, pt.z + pt.ramp.tz * pt.ramp.len - p.z) < 10) this.jump = { pt, x: p.x, z: p.z };
      }
      if (this.jump && p.landed) {
        const dist = Math.round(Math.hypot(p.x - this.jump.x, p.z - this.jump.z) * 10) / 10, pt = this.jump.pt, best = S.rec.jump[pt.id] || 0;
        if (dist > best) { S.rec.jump[pt.id] = dist; this.dirty = true; }
        this.events.push({ type: 'jump', point: pt, dist, best: Math.max(dist, best), record: dist > best });
        this.jump = null;
      }
      if (this.jump && !p.air && !p.landed) this.jump = null;
      // бродячий соперник рядом - предложение дуэли
      this.nearRival = null;
      for (const a of this.rivals) { a.cool = Math.max(0, a.cool - dt); if (a.cool <= 0 && Math.hypot(a.car.x - p.x, a.car.z - p.z) < 30) this.nearRival = a; }
    }

    counts() {
      const M = this.M, S = this.save, by = (t) => M.points.filter((p) => p.type === t);
      return { boards: by('board').filter((p) => S.boards[p.id]).length, boardsAll: by('board').length, disc: M.points.filter((p) => S.disc[p.id]).length, all: M.points.length };
    }
  }

  return { MAPS, ROAD, BIOME, WEATHER, WATER, CHUNK, buildMap, graphConnected, routeEdges, World, newSave, sanitizeSave, fbm, vnoise };
});
