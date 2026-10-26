// Закон «повреждения выкл = физика как раньше»: три заезда (гонка с соперниками и стенами, дрифт ботом, свободная
// езда с трафиком и предметами) идут фиксированными шагами, а состояние всех машин на каждом шаге (биты float64)
// сворачивается в хэш FNV. Запись tests/web/fixtures/horizon_drift_law.json сделана до кода повреждений
// (в Chromium: page.evaluate(lawRun, null), результат - в файл; Node округляет Math иначе в последнем бите);
// с повреждениями «выкл» и «только вид» хэши обязаны совпасть бит в бит. Меняя физику нарочно - записать заново.
// Функция выполняется в странице: page.evaluate(lawRun, mode).
async function lawRun(mode) {
  const C = __drift.core, WD = __drift.worldData, DM = window.DriftDamage, DT = C.DT;
  const buf = new Float64Array(1), u = new Uint32Array(buf.buffer);
  const attach = (c) => { if (DM && mode) DM.attach(c, mode); };
  const out = {};
  const trace = (cars, steps, stepFn) => {
    let h = 2166136261 >>> 0;
    const mix = (v) => { buf[0] = v; h = Math.imul(h ^ u[0], 16777619) >>> 0; h = Math.imul(h ^ u[1], 16777619) >>> 0; };
    const samples = [];
    for (let i = 0; i < steps; i++) {
      stepFn(i);
      for (const c of cars()) { mix(c.x); mix(c.z); mix(c.h); mix(c.vx); mix(c.vz); mix(c.w); mix(c.steer); mix(c.nitro); mix(c.y || 0); mix(c.rpm); }
      if (i % 600 === 599) samples.push(cars().map((c) => [+c.x.toFixed(3), +c.z.toFixed(3), +c.speed.toFixed(3)]));
    }
    return { hash: h.toString(16), samples };
  };
  // 1. гонка: 4 машины плотной сеткой (касания на старте), игрок - заданный ввод с ручником, нитро и стенами
  {
    const entries = [0, 1, 2].map((k) => ({ name: 'ИИ' + k, car: ['kobalt', 'sapsan', 'iskra'][k], ai: { pace: 0.95, mistakes: 0.03, laneBase: (k - 1) * 0.8 } }));
    entries.splice(1, 0, { name: 'Вы', car: 'buran', isPlayer: true });
    const r = new C.Race({ track: 'coast', mode: 'race', laps: 2, skipCountdown: true, seed: 7, entries });
    r.cars.forEach(attach);
    const pin = { thr: 1, brk: 0, steer: 0, hb: 0, nitro: 0 };
    out.race = trace(() => r.cars, 40 / DT, (i) => {
      const t = i * DT;
      pin.thr = t % 9 < 7 ? 1 : 0; pin.brk = t % 9 >= 7.5 ? 1 : 0; pin.steer = Math.sin(t * 0.9) * 0.8 + (t > 20 && t < 22 ? 1 : 0);
      pin.hb = t % 11 > 10.4 ? 1 : 0; pin.nitro = t % 6 < 3 ? 1 : 0;
      r.step(DT, pin);
    });
    out.race.hits = r.cars.map((c) => c.hits);
  }
  // 2. дрифт: игрок - бот-дрифтер, город
  {
    const r = new C.Race({ track: 'city', mode: 'drift', laps: 1, skipCountdown: true, seed: 3, entries: [{ name: 'Вы', car: 'vihr', isPlayer: true }] });
    r.cars.forEach(attach);
    r.setAutopilot(r.player, 0.85, true);
    out.drift = trace(() => r.cars, 30 / DT, () => r.step(DT));
    out.drift.points = r.drift.total;
  }
  // 3. свободная езда: трафик, соперники, предметы и ограждения
  {
    const w = new WD.World({ map: 'metro', car: 'sapsan', seed: 5, attach: DM && mode ? attach : undefined });
    const pin = { thr: 1, brk: 0, steer: 0, hb: 0, nitro: 0 };
    out.world = trace(() => w.cars, 40 / DT, (i) => {
      const t = i * DT;
      pin.thr = t % 7 < 5.5 ? 1 : 0.2; pin.brk = t % 7 > 6.2 ? 1 : 0; pin.steer = Math.sin(t * 0.7) * 0.9; pin.nitro = t % 5 < 2 ? 1 : 0; pin.hb = t % 13 > 12.5 ? 1 : 0;
      w.step(DT, pin);
    });
    out.world.cars = w.cars.length;
  }
  return out;
}

module.exports = { lawRun };
