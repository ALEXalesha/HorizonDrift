/* Horizon Drift - повреждения: вмятины кузова, отлетающие детали, износ шин, влияние на управление.
   Без DOM и без three.js: работает в странице (window.DriftDamage) и в node (для проверок).

   Как у BeamNG.drive, только легче. Там машина - сетка узлов и балок (JBeam): балка гнётся навсегда, когда сила
   больше beamDeform, и рвётся, когда больше beamStrength; меш кузова привязан к узлам (flexbody), а детали
   отваливаются целыми группами балок (breakGroup). Считать сотни балок на 2000 Гц браузеру не по силам, поэтому:
   - «балки» - четыре зоны кузова (перед, зад, левый и правый бок): удар сильнее порога вмятины (изменение
     скорости больше DEFORM_DV) копит повреждение зоны, слабое касание не оставляет ничего;
   - «flexbody» - вершины меша сдвигаются внутрь по направлению удара, сдвиг гаснет с расстоянием от точки удара
     (гладко, до нуля на радиусе) и ограничен по величине; меш правится только в момент удара;
   - «breakGroup» - зеркала, бамперы и капот отлетают, когда удар сильнее своего порога или зона уже смята.
   Режимы: 'off' - ничего не считается (физика бит в бит как до повреждений), 'visual' - вмятины и детали, физика
   та же, 'full' - ещё износ шин и удары портят управление (увод руля, слабее мотор, меньше сцепление).
   Крючки в физике (core.js, world.js) только читают импульс удара: в 'off' и 'visual' движение не меняется. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api; else root.DriftDamage = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const MODES = ['off', 'visual', 'full'];
  const DEFAULT_MODE = 'visual';
  const ZONES = ['front', 'rear', 'left', 'right'];
  const PARTS = ['mirrorL', 'mirrorR', 'bumperF', 'bumperR', 'hood'];
  // пороги - в изменении скорости машины от удара (импульс / масса), м/с
  const T = {
    DEFORM_DV: 2.5,          // слабее - касание без следа
    ZONE_K: 0.045,           // повреждение зоны на 1 м/с сверх порога
    DENT_K: 0.03,            // глубина вмятины на 1 м/с сверх порога, м
    DENT_MAX: 0.3,           // глубже одна вмятина не бывает
    DENT_TOTAL: 0.42,        // и все вмятины вместе не уводят вершину дальше этого от исходного места
    MIRROR_DV: 6,            // зеркало - удар в свой бок
    BUMPER_DV: 9, BUMPER_ZONE: 0.7,
    HOOD_DV: 13, HOOD_ZONE: 0.85,
    ALIGN_K: 0.0012, ALIGN_MAX: 0.03,  // увод руля от удара в переднее колесо, рад
    POWER_LOSS: 0.45,        // смятый перед отнимает до 45% мощности
    GRIP_LOSS: 0.3,          // стёртые шины держат на 30% хуже (не меньше 0.7 от новых)
    WEAR_SLIP: 0.0006,       // износ за 1 м скольжения боком (занос, срыв)
    WEAR_LOCK: 0.0009,       // износ передних за 1 м юза на заблокированных колёсах
    WEAR_BRAKE: 0.00004,     // износ за 1 м обычного торможения (с АБС)
    WEAR_SPIN: 0.0015,       // износ ведущих за 1 м пробуксовки
  };
  const DENTS = 8, DETACH = 8;          // кольца событий для рисования

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const gripOf = (w) => 1 - T.GRIP_LOSS * Math.pow(clamp(w, 0, 1), 1.5);

  class Damage {
    constructor(mode) {
      this.mode = mode === 'full' ? 'full' : 'visual';
      this.zone = { front: 0, rear: 0, left: 0, right: 0 };
      this.off = { mirrorL: false, mirrorR: false, bumperF: false, bumperR: false, hood: false };
      this.wear = [0, 0, 0, 0];          // шины: перед-лево, перед-право, зад-лево, зад-право
      this.align = 0;                    // увод руля, рад (+ - вправо)
      this.fx = { gripF: 1, gripR: 1, power: 1, pull: 0 };
      this.hits = 0; this.lastDv = 0; this.repairs = 0;
      // вмятины в координатах машины: x - влево (как у меша), z - вперёд; dir - куда давить
      this.dents = []; for (let i = 0; i < DENTS; i++) this.dents.push({ x: 0, y: 0, z: 0, dx: 0, dz: 0, depth: 0, r: 0 });
      this.dentN = 0;                    // сколько вмятин было всего (рисование помнит, сколько уже применило)
      this.detach = []; for (let i = 0; i < DETACH; i++) this.detach.push({ part: '', vx: 0, vy: 0, vz: 0 });
      this.detachN = 0;
    }
    get full() { return this.mode === 'full'; }

    // Удар: (px, pz) - точка касания в мире, (nx, nz) - нормаль от препятствия в машину, J - импульс, Н·с.
    hit(car, px, pz, nx, nz, J) {
      const st = car.st || {}, m = st.mass || 1200, dv = J / m;
      if (!(dv > T.DEFORM_DV)) return 0;
      const over = dv - T.DEFORM_DV;
      const fx = Math.sin(car.h), fz = Math.cos(car.h), rx = -fz, rz = fx;
      const hl = (st.len || 4.3) / 2, hw = (st.wid || 1.8) / 2;
      const ox = px - car.x, oz = pz - car.z, kf = clamp(ox * fx + oz * fz, -hl, hl), kr = clamp(ox * rx + oz * rz, -hw, hw);
      const nf = nx * fx + nz * fz, nr = nx * rx + nz * rz;
      // зона - по направлению удара: нормаль смотрит назад - удар в перед, влево - удар в правый бок
      const zone = Math.abs(nf) >= Math.abs(nr) ? (nf < 0 ? 'front' : 'rear') : (nr < 0 ? 'right' : 'left');
      this.zone[zone] = Math.min(1, this.zone[zone] + over * T.ZONE_K);
      this.hits++; this.lastDv = dv;
      const d = this.dents[this.dentN % DENTS]; this.dentN++;
      d.x = -kr; d.z = kf; d.y = 0.55; d.dx = -nr; d.dz = nf;
      d.depth = Math.min(T.DENT_MAX, over * T.DENT_K); d.r = 0.45 + Math.min(0.6, dv * 0.03);
      // детали
      if (zone === 'left' || zone === 'right') {
        if (dv > T.MIRROR_DV && kf > -hl * 0.2) this.drop(zone === 'left' ? 'mirrorL' : 'mirrorR', car, nx, nz, dv);
      } else if (dv > T.MIRROR_DV * 1.5 && Math.abs(kr) > hw * 0.6 && zone === 'front') this.drop(kr > 0 ? 'mirrorR' : 'mirrorL', car, nx, nz, dv);
      if (zone === 'front') {
        if (dv > T.BUMPER_DV || this.zone.front > T.BUMPER_ZONE) this.drop('bumperF', car, nx, nz, dv);
        if (dv > T.HOOD_DV || this.zone.front > T.HOOD_ZONE) this.drop('hood', car, nx, nz, dv);
      } else if (zone === 'rear' && (dv > T.BUMPER_DV || this.zone.rear > T.BUMPER_ZONE)) this.drop('bumperR', car, nx, nz, dv);
      // удар в переднее колесо (перед или бок у передней оси) гнёт подвеску: руль уводит в сторону удара
      if (this.full && (zone === 'front' ? Math.abs(kr) > hw * 0.35 : kf > hl * 0.3)) {
        const side = zone === 'front' ? (kr > 0 ? 1 : -1) : (zone === 'right' ? 1 : -1);
        this.align = clamp(this.align + side * over * T.ALIGN_K, -T.ALIGN_MAX, T.ALIGN_MAX);
      }
      this.update();
      return dv;
    }
    drop(part, car, nx, nz, dv) {
      if (this.off[part]) return;
      this.off[part] = true;
      const e = this.detach[this.detachN % DETACH]; this.detachN++;
      const k = Math.min(8, dv * 0.35);
      e.part = part; e.vx = (car.vx || 0) * 0.7 + nx * k; e.vz = (car.vz || 0) * 0.7 + nz * k; e.vy = Math.min(5.5, 2 + dv * 0.15);
    }

    // Шаг после физики машины: износ шин (только 'full'). Читает скольжения, которые посчитал stepCar.
    step(car, dt) {
      if (!this.full) return;
      const v = car.speed || 0;
      if (v < 1) return;
      const dist = v * dt, w = this.wear, brk = car.inp ? car.inp.brk || 0 : 0;
      const lock = (car.skidF || 0) >= 1 && brk > 0.85;
      const front = (car.skidF || 0) * T.WEAR_SLIP + (lock ? T.WEAR_LOCK : 0) + (car.braking ? brk * T.WEAR_BRAKE : 0);
      let rear = (car.skidR || 0) * T.WEAR_SLIP + (car.braking ? brk * T.WEAR_BRAKE * 0.6 : 0);
      const spin = (car.spin || 0) * T.WEAR_SPIN, drive = car.st ? car.st.drive : 'rwd';
      let frontSpin = 0;
      if (drive === 'fwd') frontSpin = spin; else if (drive === 'awd') { frontSpin = spin * 0.5; rear += spin * 0.5; } else rear += spin;
      // в повороте внешние колёса нагружены сильнее: w > 0 - поворот влево, внешние - правые
      const lat = clamp((car.w || 0) * v / 9.81, -1, 1), kR = 1 + 0.5 * lat, kL = 1 - 0.5 * lat;
      const f = (front + frontSpin) * dist, r = rear * dist;
      w[0] = Math.min(1, w[0] + f * kL); w[1] = Math.min(1, w[1] + f * kR);
      w[2] = Math.min(1, w[2] + r * kL); w[3] = Math.min(1, w[3] + r * kR);
      this.update();
    }

    update() {
      const fx = this.fx;
      if (!this.full) { fx.gripF = 1; fx.gripR = 1; fx.power = 1; fx.pull = 0; return; }
      fx.gripF = (gripOf(this.wear[0]) + gripOf(this.wear[1])) / 2;
      fx.gripR = (gripOf(this.wear[2]) + gripOf(this.wear[3])) / 2;
      const t = clamp((this.zone.front - 0.25) / 0.75, 0, 1);
      fx.power = 1 - T.POWER_LOSS * t * t * (3 - 2 * t);
      fx.pull = this.align;
    }

    repair() {
      for (const z of ZONES) this.zone[z] = 0;
      for (const p of PARTS) this.off[p] = false;
      for (let i = 0; i < 4; i++) this.wear[i] = 0;
      this.align = 0; this.hits = 0; this.lastDv = 0; this.repairs++;
      this.update();
    }
    // Сводка для HUD и проверок: 0..1.
    total() { const z = this.zone; return Math.max(z.front, z.rear, z.left, z.right); }
  }

  // Подключить повреждения к машине. 'off' (или неизвестный режим) - снять: физика как без них.
  function attach(car, mode) {
    if (mode !== 'visual' && mode !== 'full') { delete car.dmg; delete car.dmgFx; return null; }
    const d = new Damage(mode);
    car.dmg = d;
    if (mode === 'full') car.dmgFx = d.fx; else delete car.dmgFx;
    return d;
  }
  // Режим для заезда: в карьере и в заездах на время - не больше 'visual' (медали и рекорды по одним правилам
  // с эталонным ботом, который едет без повреждений).
  function modeFor(setting, kind, raceMode) {
    const m = MODES.includes(setting) ? setting : DEFAULT_MODE;
    if (m === 'full' && (kind === 'career' || raceMode === 'time')) return 'visual';
    return m;
  }

  // Вмятина в массиве вершин: pos - текущие (x, y, z подряд), rest - исходные. Сдвиг по направлению (dx, 0, dz)
  // на depth * (1 - (d/r)^2)^2, где d - расстояние от точки удара (по высоте вдвое мягче); вершина не уходит от
  // исходного места дальше maxTotal. Возвращает число сдвинутых вершин.
  function applyDent(pos, rest, dent, maxTotal) {
    const n = pos.length / 3, r = dent.r, r2 = r * r, lim = maxTotal || T.DENT_TOTAL;
    let moved = 0;
    for (let i = 0; i < n; i++) {
      const k = i * 3, ax = rest[k] - dent.x, ay = (rest[k + 1] - dent.y) * 0.5, az = rest[k + 2] - dent.z;
      const d2 = ax * ax + ay * ay + az * az;
      if (d2 >= r2) continue;
      // только вершины со стороны удара: не продавливать насквозь дальний борт
      if (ax * dent.dx + az * dent.dz > r * 0.35) continue;
      const q = 1 - d2 / r2, s = dent.depth * q * q;
      // сжатие с лёгкой рябью: смятый металл не гладкий (рябь из исходного места - одинакова у двойников вершины)
      const crumple = 0.75 + 0.5 * Math.abs(Math.sin(rest[k] * 13.1 + rest[k + 1] * 7.3 + rest[k + 2] * 11.7));
      let x = pos[k] + dent.dx * s * crumple, y = pos[k + 1] - s * 0.25 * crumple, z = pos[k + 2] + dent.dz * s * crumple;
      const ox = x - rest[k], oy = y - rest[k + 1], oz = z - rest[k + 2], o = Math.sqrt(ox * ox + oy * oy + oz * oz);
      if (o > lim) { const c = lim / o; x = rest[k] + ox * c; y = rest[k + 1] + oy * c; z = rest[k + 2] + oz * c; }
      pos[k] = x; pos[k + 1] = y; pos[k + 2] = z; moved++;
    }
    return moved;
  }

  // Обломки: пул фиксированного размера, без выделения памяти в кадре. Живут life секунд (последнюю - уменьшаются),
  // при переполнении новый занимает место самого старого. Падают, отскакивают от земли, катятся и останавливаются;
  // машина, наехав, отбрасывает обломок (на саму машину он не действует - физика машин не меняется).
  class Debris {
    constructor(max, life) {
      this.max = max || 24; this.life = life || 12; this.n = 0; this.spawned = 0;
      this.list = [];
      for (let i = 0; i < this.max; i++) this.list.push({ on: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, rx: 0, ry: 0, rz: 0, wx: 0, wy: 0, wz: 0, t: 0, part: '', rest: false, scale: 1, seq: 0, hint: 0, kick: 0 });
    }
    // Новый обломок; возвращает номер места в пуле.
    spawn(x, y, z, vx, vy, vz, part, ry) {
      let slot = -1, oldest = Infinity;
      for (let i = 0; i < this.max; i++) { const d = this.list[i]; if (!d.on) { slot = i; break; } if (d.seq < oldest) { oldest = d.seq; slot = i; } }
      const d = this.list[slot];
      if (!d.on) this.n++;
      const s = ++this.spawned;
      d.on = true; d.x = x; d.y = y; d.z = z; d.vx = vx; d.vy = vy; d.vz = vz; d.rx = 0; d.ry = ry || 0; d.rz = 0;
      d.wx = ((s * 7919) % 13 - 6) * 0.9; d.wy = ((s * 104729) % 11 - 5) * 0.7; d.wz = ((s * 1299709) % 9 - 4) * 0.9;
      d.t = 0; d.part = part; d.rest = false; d.scale = 1; d.seq = s; d.kick = 0.4;     // сначала улетает от своей машины
      return slot;
    }
    // ground(x, z, y, d) - высота земли (может и поправить d.x, d.z у стенки); cars - машины (отбрасывают обломки).
    update(dt, ground, cars) {
      for (let i = 0; i < this.max; i++) {
        const d = this.list[i];
        if (!d.on) continue;
        d.t += dt;
        if (d.t >= this.life) { d.on = false; this.n--; continue; }
        d.scale = d.t > this.life - 1 ? Math.max(0.01, this.life - d.t) : 1;
        if (d.kick > 0) d.kick -= dt;
        // наезд: обломок у земли рядом с кузовом отлетает (один толчок на касание, не держится за машиной)
        if (cars && d.kick <= 0) for (let k = 0; k < cars.length; k++) {
          const c = cars[k], dx = d.x - c.x, dz = d.z - c.z;
          if (dx * dx + dz * dz < 4.4 && (c.speed || 0) > 2 && d.y - (c.y || 0) < 0.8) {
            d.kick = 0.5;
            const l = Math.sqrt(dx * dx + dz * dz) || 1;
            d.vx = c.vx * 0.8 + dx / l * 2; d.vz = c.vz * 0.8 + dz / l * 2; d.vy = 1.5 + (c.speed || 0) * 0.05; d.rest = false;
            d.wx = d.wx || 3; d.wz = d.wz || -3;
          }
        }
        if (d.rest) continue;
        d.vy -= 9.81 * dt;
        d.x += d.vx * dt; d.y += d.vy * dt; d.z += d.vz * dt;
        d.rx += d.wx * dt; d.ry += d.wy * dt; d.rz += d.wz * dt;
        const g = ground ? ground(d.x, d.z, d.y, d) : 0;      // d - чтобы земля могла держать подсказку поиска и стенки
        if (d.y <= g + 0.05) {
          d.y = g + 0.05;
          if (d.vy < 0) d.vy = -d.vy * 0.3;
          const fr = Math.max(0, 1 - 6 * dt);
          d.vx *= fr; d.vz *= fr; d.wx *= fr; d.wy *= fr; d.wz *= fr;
          // лёг плашмя и почти не движется - покой
          if (Math.abs(d.vy) < 0.6 && d.vx * d.vx + d.vz * d.vz < 0.04) { d.vy = 0; d.vx = 0; d.vz = 0; d.wx = d.wy = d.wz = 0; d.rx = 0; d.rz = 0; d.rest = true; }
        }
      }
    }
    clear() { for (const d of this.list) d.on = false; this.n = 0; }
  }

  return { MODES, DEFAULT_MODE, ZONES, PARTS, T, Damage, attach, modeFor, applyDent, Debris, gripOf };
});
