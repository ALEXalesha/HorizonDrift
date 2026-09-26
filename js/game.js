/* Horizon Drift - экраны, гараж, настройки, управление (клавиатура и геймпад), HUD, цикл игры.
   Физика идёт фиксированным шагом (DriftCore.DT), рисование - как позволяет экран.
   Крючок для проверок: window.__drift (он же window.__game). */
(function () {
  'use strict';
  if (typeof THREE === 'undefined') {
    document.body.innerHTML = '<div style="padding:40px;color:#fff;font-family:sans-serif;background:#220000;height:100vh"><h2>Не загрузилась библиотека three.js</h2><p>Файл vendor/three.min.js должен лежать рядом со страницей.</p></div>';
    return;
  }
  const D = window.DriftData, C = window.DriftCore, R = window.DriftRender, A = window.DriftAudio;
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const FIXED_SEED = params.has('seed') ? (Number(params.get('seed')) || 1) : 0;
  const KEY = { settings: 'mix.drift.settings', career: 'mix.drift.career', records: 'mix.drift.records' };
  const load = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* нет хранилища */ } };
  const money = (n) => Math.round(n).toLocaleString('ru-RU') + ' кр';
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const trackDef = (id) => D.TRACKS.find((t) => t.id === id);
  const MEDAL_RU = { gold: 'Золото', silver: 'Серебро', bronze: 'Бронза' };

  const G = {
    settings: C.mergeSettings(load(KEY.settings)),
    records: load(KEY.records) || { tracks: {} },
    screen: 'boot', stack: [], race: null, cfg: null, meta: null, paused: false, manual: false, doneT: -1, resultShown: false,
    input: { thr: 0, brk: 0, steer: 0, hb: 0, nitro: 0, analog: false, shiftUp: false, shiftDown: false },
    override: null, keys: new Set(), camMode: 'chase', seedN: 0, fps: 0, frameTimes: [], restartSettings: null,
    garageCar: null, gTab: 'stats', sTab: 'sound', quick: { track: 'city', mode: 'race', opp: 3, laps: 2, diff: null, car: null },
  };
  if (!G.records.tracks) G.records = { tracks: {} };
  G.career = new C.Career(load(KEY.career), (d) => save(KEY.career, d));
  G.camMode = G.settings.camera;
  const nextSeed = () => (FIXED_SEED ? FIXED_SEED + G.seedN++ : ((Date.now() ^ (Math.random() * 1e9)) >>> 0));

  // ======================= экраны =======================
  const SCREENS = { boot: 'scrBoot', main: 'scrMain', career: 'scrCareer', cup: 'scrCup', quick: 'scrQuick', garage: 'scrGarage', settings: 'scrSettings',
    records: 'scrRecords', help: 'scrHelp', load: 'scrLoad', race: null, victory: 'scrVictory' };
  function show(name, noPush) {
    if (!noPush && G.screen !== name && G.screen !== 'boot' && G.screen !== 'load' && G.screen !== 'race') G.stack.push(G.screen);
    G.screen = name;
    for (const k in SCREENS) if (SCREENS[k]) $(SCREENS[k]).classList.toggle('show', k === name);
    $('hud').classList.toggle('show', name === 'race');
    if (name !== 'race') { $('scrPause').classList.remove('show'); }
    const build = { main: buildMain, career: buildCareer, cup: buildCup, quick: buildQuick, garage: buildGarage, settings: buildSettings, records: buildRecords, help: buildHelp, victory: buildVictory }[name];
    if (build) build();
    if (['main', 'career', 'cup', 'quick', 'garage', 'settings', 'records', 'help'].includes(name) && !G.race) A.music('menu');
  }
  function back() {
    if (G.screen === 'settings' && G.settingsFromPause) { G.settingsFromPause = false; G.screen = 'race'; for (const k in SCREENS) if (SCREENS[k]) $(SCREENS[k]).classList.remove('show'); $('hud').classList.add('show'); $('scrPause').classList.add('show'); return; }
    const prev = G.stack.pop() || 'main';
    show(prev, true);
  }
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-go],[data-back]');
    if (!b) return;
    A.init(); A.play('click');
    if (b.hasAttribute('data-back')) back(); else show(b.getAttribute('data-go'));
  });
  let toastT = 0;
  function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2400); }
  function confirmBox(title, text, yes) {
    $('mdTitle').textContent = title; $('mdText').textContent = text; $('modal').classList.add('show');
    const close = () => $('modal').classList.remove('show');
    $('mdYes').onclick = () => { close(); yes(); };
    $('mdNo').onclick = close;
  }

  function aiLook(name) {
    const r = C.mulberry32(C.hashStr(name));
    return { color: D.PAINTS[Math.floor(r() * D.PAINTS.length)], color2: D.PAINTS[Math.floor(r() * D.PAINTS.length)], rims: D.RIMS[Math.floor(r() * D.RIMS.length)].id,
      rimColor: D.RIM_COLORS[Math.floor(r() * D.RIM_COLORS.length)], livery: D.LIVERIES[Math.floor(r() * D.LIVERIES.length)].id };
  }

  // ======================= главное меню =======================
  function buildMain() {
    const car = C.carDef(G.career.d.current);
    $('mMoney').textContent = money(G.career.money);
    $('mCar').textContent = car.name; $('mCarCls').textContent = car.cls + (G.career.d.victory ? ' · чемпион' : '');
    R.showroomView('menu'); R.setShowroomCar(car.id, G.career.look(car.id));
  }

  // ======================= карьера =======================
  function medalHtml(m) { return `<span class="medal ${m || 'none'}" title="${m ? MEDAL_RU[m] : 'нет медали'}">${m ? m[0].toUpperCase().replace('G', 'З').replace('S', 'С').replace('B', 'Б') : ''}</span>`; }
  function buildCareer() {
    $('cMoney').textContent = money(G.career.money);
    const g = $('cupsGrid'); g.innerHTML = '';
    D.CUPS.forEach((cup, i) => {
      const open = G.career.cupUnlocked(i), done = G.career.cupComplete(i);
      const b = document.createElement('button'); b.className = 'card' + (open ? '' : ' locked'); b.disabled = !open;
      b.dataset.cup = String(i);
      b.innerHTML = `<div class="lock">${open ? (done ? 'пройден' : 'открыт') : 'закрыт'}</div><span class="badge">Кубок ${i + 1}</span><h3>${esc(cup.name)}</h3>
        <div class="sub">${esc(cup.about)}</div><div class="sub" style="margin-top:6px">Соперники: ${cup.pool.map((c) => esc(C.carDef(c).name)).join(', ')}</div>
        <div class="medals">${cup.events.map((e) => medalHtml(G.career.eventMedal(e.id))).join('')}</div>
        ${open ? '' : `<div class="sub" style="margin-top:8px">Нужна медаль в каждом событии кубка «${esc(D.CUPS[i - 1].name)}»</div>`}`;
      b.onclick = () => { G.cup = i; show('cup'); };
      g.appendChild(b);
    });
  }
  function drawMini(canvas, trackId) {
    const tr = C.buildTrack(trackId), g = canvas.getContext('2d'), w = canvas.width, h = canvas.height;
    g.clearRect(0, 0, w, h);
    const mp = R.minimapPath(tr, w, h, 10);
    g.lineJoin = 'round'; g.lineCap = 'round';
    g.strokeStyle = 'rgba(255,255,255,0.18)'; g.lineWidth = 7; g.beginPath();
    for (let i = 0; i < tr.N; i += 2) { const p = mp.map(tr.x[i], tr.z[i]); i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]); }
    if (tr.closed) g.closePath(); g.stroke();
    g.strokeStyle = '#ff8a1f'; g.lineWidth = 2.5; g.stroke();
    const s = mp.map(tr.x[tr.cps[0].i], tr.z[tr.cps[0].i]); g.fillStyle = '#fff'; g.beginPath(); g.arc(s[0], s[1], 4, 0, Math.PI * 2); g.fill();
    if (!tr.closed) { const f = mp.map(tr.x[tr.cps[tr.cps.length - 1].i], tr.z[tr.cps[tr.cps.length - 1].i]); g.fillStyle = '#19d3ff'; g.beginPath(); g.arc(f[0], f[1], 4, 0, Math.PI * 2); g.fill(); }
  }
  function goalText(evt) {
    if (evt.type === 'race' || evt.type === 'elim') return 'Медаль: 1-3 место';
    if (evt.type === 'duel') return 'Золото: победа в дуэли';
    if (evt.type === 'drift') return `Очки: ${evt.goal.map((v) => v.toLocaleString('ru-RU')).join(' / ')}`;
    if (evt.type === 'time') return 'Время: ' + C.timeThresholds(evt).map(C.fmtTime).join(' / ');
    return '';
  }
  function buildCup() {
    const i = G.cup || 0, cup = D.CUPS[i];
    $('cupTitle').textContent = cup.name; $('cupAbout').textContent = cup.about + ' Сейчас ваша машина: ' + C.carDef(G.career.d.current).name + '.';
    $('cupMoney').textContent = money(G.career.money);
    const g = $('eventsGrid'); g.innerHTML = '';
    cup.events.forEach((evt) => {
      const td = trackDef(evt.track), res = G.career.d.res[evt.id] || {};
      const laps = evt.type === 'elim' ? (td.closed ? (evt.opp || 3) + ' кругов' : '') : td.closed ? (evt.laps || 1) + ' ' + (evt.laps === 1 ? 'круг' : 'круга') : 'из точки в точку';
      const who = evt.type === 'duel' ? 'Соперник: ' + D.RIVALS[cup.id] : evt.opp ? 'Соперников: ' + evt.opp : 'В одиночку';
      let best = '';
      if (res.best != null) best = evt.type === 'drift' ? 'Лучший: ' + Math.round(res.best).toLocaleString('ru-RU') : evt.type === 'time' ? 'Лучшее: ' + C.fmtTime(res.best) : 'Лучшее место: ' + res.best;
      const d = document.createElement('div'); d.className = 'card evt';
      d.innerHTML = `<span class="badge">${D.EVENT_TYPES[evt.type].name}</span><span class="badge cy">${esc(D.SURF[td.surface].name)}</span>
        <h3 style="margin-top:6px">${esc(evt.name)}</h3><div class="sub">${esc(td.name)} · ${esc(td.place)} · ${laps}</div><canvas class="mini" width="280" height="96"></canvas>
        <div class="sub">${esc(D.EVENT_TYPES[evt.type].about)}</div><div class="sub">${who} · ${goalText(evt)}</div>
        <div class="row"><span>${medalHtml(res.medal)} <span class="sub">${best}</span></span><button class="go" data-evt="${evt.id}">Старт</button></div>`;
      g.appendChild(d);
      drawMini(d.querySelector('canvas'), evt.track);
      d.querySelector('.go').onclick = () => startCareerEvent(evt.id);
    });
  }

  function playerAssist() {
    const s = G.settings;
    return { tc: s.tc, abs: s.abs, steer: s.steerAssist, auto: s.gearbox === 'auto', sens: s.steerSens };
  }
  function startCareerEvent(id) {
    const f = C.findEvent(id); if (!f || !G.career.cupUnlocked(f.ci)) return;
    const carId = G.career.d.current;
    const entries = C.eventEntries(f.evt, f.ci, { difficulty: G.settings.difficulty, car: carId, upg: G.career.d.upg[carId], look: G.career.look(carId), seed: FIXED_SEED });
    entries.forEach((e) => { if (!e.isPlayer) e.look = aiLook(e.name); });
    const cfg = { track: f.evt.track, mode: f.evt.type, laps: f.evt.laps || 1, entries, seed: nextSeed(), assist: playerAssist() };
    const meta = { kind: 'career', evtId: id, title: f.evt.name, thresholds: f.evt.type === 'time' ? C.timeThresholds(f.evt) : null, goal: f.evt.goal || null };
    return startRace(cfg, meta);
  }

  // ======================= быстрая гонка =======================
  function buildQuick() {
    const q = G.quick;
    if (!q.car || !G.career.owns(q.car)) q.car = G.career.d.current;
    if (!q.diff) q.diff = G.settings.difficulty;
    const td = trackDef(q.track);
    const g = $('qTracks'); g.innerHTML = '';
    for (const t of D.TRACKS) {
      const b = document.createElement('button'); b.className = 'card' + (t.id === q.track ? ' sel' : ''); b.dataset.track = t.id;
      b.innerHTML = `<h3>${esc(t.name)}</h3><div class="sub">${esc(t.place)} · ${esc(D.SURF[t.surface].name)} · ${t.closed ? 'кольцо' : 'из точки в точку'}</div><canvas class="mini" width="200" height="80" style="height:80px"></canvas>`;
      b.onclick = () => { q.track = t.id; A.play('click'); buildQuick(); };
      g.appendChild(b); drawMini(b.querySelector('canvas'), t.id);
    }
    const seg = (el, items, cur, fn, dis) => {
      el.innerHTML = '';
      for (const it of items) {
        const b = document.createElement('button'); b.textContent = it[1]; b.className = it[0] === cur ? 'on' : ''; b.disabled = !!(dis && dis(it[0]));
        b.onclick = () => { fn(it[0]); A.play('click'); buildQuick(); };
        el.appendChild(b);
      }
    };
    seg($('qMode'), [['race', 'Гонка'], ['drift', 'Дрифт'], ['time', 'На время']], q.mode, (v) => { q.mode = v; });
    seg($('qCar'), G.career.d.owned.map((id) => [id, C.carDef(id).name]), q.car, (v) => { q.car = v; });
    seg($('qOpp'), [0, 1, 2, 3, 4, 5].map((n) => [n, String(n)]), q.opp, (v) => { q.opp = v; }, () => q.mode !== 'race');
    seg($('qLaps'), [1, 2, 3, 4, 5].map((n) => [n, String(n)]), td.closed ? q.laps : 1, (v) => { q.laps = v; }, () => !td.closed);
    seg($('qDiff'), Object.keys(D.DIFFICULTY).map((k) => [k, D.DIFFICULTY[k].name]), q.diff, (v) => { q.diff = v; }, () => q.mode !== 'race' || q.opp === 0);
    $('qNote').textContent = `${td.name}: ${Math.round(C.buildTrack(td.id).lapLen)} м, покрытие - ${D.SURF[td.surface].name}${td.surfaces ? ' с участками асфальта' : ''}.`;
    R.showroomView('menu'); R.setShowroomCar(q.car, G.career.look(q.car));
  }
  $('qStart').onclick = () => {
    A.init();
    const q = G.quick, td = trackDef(q.track), rng = C.mulberry32(nextSeed());
    if (!q.car || !G.career.owns(q.car)) q.car = G.career.d.current;
    if (!q.diff) q.diff = G.settings.difficulty;
    const diff = D.DIFFICULTY[q.diff] || D.DIFFICULTY.normal;
    const entries = [];
    const myTier = C.carDef(q.car).tier;
    const pool = D.CARS.filter((c) => Math.abs(c.tier - myTier) <= 1);
    const names = D.DRIVERS.slice();
    const opp = q.mode === 'race' ? q.opp : 0;
    for (let k = 0; k < opp; k++) {
      const car = pool[Math.floor(rng() * pool.length)].id, name = names.splice(Math.floor(rng() * names.length), 1)[0];
      entries.push({ name, car, upg: { engine: 1, tyres: 1, susp: 1, weight: 1, nitro: 1 }, look: aiLook(name),
        ai: { pace: C.clamp(0.9 + diff.pace + (k / Math.max(1, opp - 1) - 0.5) * 0.04, 0.6, 1.02), mistakes: diff.mistakes, laneBase: (rng() - 0.5) * 1.6 } });
    }
    entries.push({ name: 'Вы', car: q.car, upg: G.career.d.upg[q.car], look: G.career.look(q.car), isPlayer: true });
    return startRace({ track: td.id, mode: q.mode, laps: td.closed ? q.laps : 1, entries, seed: nextSeed(), assist: playerAssist() }, { kind: 'quick', title: 'Быстрая гонка' });
  };

  // ======================= гараж =======================
  const STAT_MAX = { top: 380, acc: 3, grip: 1.6, mass: 1700, drift: 60, nitro: 6 };
  function carNums(id, upg) {
    const st = C.carStats(id, upg), def = C.carDef(id);
    return { top: st.top * 3.6, acc: C.accelTime(st), grip: st.grip, mass: st.mass, drift: Math.round(30 + 30 * def.drift), nitro: st.nitroCap, power: st.power / 1000, steer: st.steer, st };
  }
  function buildGarage() {
    const car = G.garageCar || G.career.d.current; G.garageCar = car;
    const def = C.carDef(car), owned = G.career.owns(car);
    $('gMoney').textContent = money(G.career.money);
    const list = $('gCars'); list.innerHTML = '';
    for (const c of D.CARS) {
      const b = document.createElement('button'); const own = G.career.owns(c.id);
      b.className = 'card' + (c.id === car ? ' sel' : ''); b.dataset.car = c.id;
      b.innerHTML = `<h3>${esc(c.name)}</h3><div class="sub">${esc(c.cls)} · ${c.drive === 'awd' ? 'полный' : c.drive === 'fwd' ? 'передний' : 'задний'} привод</div>
        <div class="sub" style="margin-top:4px;color:${own ? '#3fd67a' : '#ffb02e'}">${c.id === G.career.d.current ? 'выбрана' : own ? 'в гараже' : money(c.price)}</div>`;
      b.onclick = () => { G.garageCar = c.id; A.play('click'); buildGarage(); };
      list.appendChild(b);
    }
    $('gName').textContent = def.name; $('gAbout').textContent = def.cls + '. ' + def.about;
    document.querySelectorAll('#gTabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === G.gTab));
    const body = $('gBody'); body.innerHTML = '';
    const upg = G.career.d.upg[car] || {};
    const cur = carNums(car, upg), base = carNums(car, {});
    if (G.gTab === 'stats') {
      const row = (k, name, v, b0, max, fmt, inv) => {
        const f = (x) => Math.max(0.04, Math.min(1, inv ? (max - x) / (max - (inv)) : x / max));
        return `<div class="stat"><span class="k">${name}</span><div class="bar"><b style="width:${f(v) * 100}%"></b><i style="width:${f(b0) * 100}%"></i></div><span class="v">${fmt(v)}</span></div>`;
      };
      body.innerHTML = row('top', 'Макс. скорость', cur.top, base.top, STAT_MAX.top, (v) => Math.round(v) + ' км/ч')
        + row('acc', 'Разгон 0-100', cur.acc, base.acc, 9, (v) => v.toFixed(1) + ' с', 2.5)
        + row('grip', 'Сцепление', cur.grip, base.grip, STAT_MAX.grip, (v) => v.toFixed(2))
        + row('mass', 'Масса', cur.mass, base.mass, 1800, (v) => Math.round(v) + ' кг', 800)
        + row('drift', 'Угол дрифта', cur.drift, base.drift, STAT_MAX.drift, (v) => v + '°')
        + row('nitro', 'Запас нитро', cur.nitro, base.nitro, STAT_MAX.nitro, (v) => v.toFixed(1) + ' с')
        + `<p class="note">Мощность ${Math.round(cur.power)} кВт · привод: ${def.drive === 'awd' ? 'полный' : def.drive === 'fwd' ? 'передний' : 'задний'} · на гравии и снегу: ${def.offroad >= 1.2 ? 'отлично' : def.offroad >= 1 ? 'нормально' : 'скользко'}.</p>
          <p class="note">Голубая часть полосы - прибавка от тюнинга.</p>`;
    } else if (G.gTab === 'tune') {
      if (!owned) body.innerHTML = '<p class="note">Купите машину, чтобы ставить на неё детали.</p>';
      else {
        const lv = G.career.levels(car);
        for (const u of D.UPGRADES) {
          const price = G.career.upgradePrice(car, u.id);
          const d = document.createElement('div'); d.className = 'upg';
          d.innerHTML = `<span class="nm">${u.name}<span class="pips">${[1, 2, 3].map((k) => `<i class="${lv[u.id] >= k ? 'on' : ''}"></i>`).join('')}</span></span>
            <button class="buy" data-upg="${u.id}" ${price == null || price > G.career.money ? 'disabled' : ''}>${price == null ? 'Максимум' : money(price)}</button><span class="ab">${u.about}</span>`;
          d.querySelector('button').onclick = () => {
            const r = G.career.buyUpgrade(car, u.id);
            if (r.ok) { A.play('buy'); toast(`${u.name}: уровень ${G.career.levels(car)[u.id]}`); } else toast(r.reason);
            buildGarage();
          };
          body.appendChild(d);
        }
        body.insertAdjacentHTML('beforeend', `<p class="note">Сейчас: ${Math.round(cur.power)} кВт, ${Math.round(cur.top)} км/ч, сцепление ${cur.grip.toFixed(2)}, ${Math.round(cur.mass)} кг, нитро ${cur.nitro.toFixed(1)} с.</p>`);
      }
    } else {
      if (!owned) body.innerHTML = '<p class="note">Внешний вид меняется у машин в гараже.</p>';
      else {
        const look = G.career.look(car);
        const sw = (arr, cur2, key) => `<div class="swatches">${arr.map((c) => `<button class="sw ${c === cur2 ? 'on' : ''}" style="background:${c}" data-look="${key}" data-v="${c}" title="${c}"></button>`).join('')}</div>`;
        const segL = (arr, cur2, key) => `<div class="seg">${arr.map((r) => `<button class="${r.id === cur2 ? 'on' : ''}" data-look="${key}" data-v="${r.id}">${r.name}</button>`).join('')}</div>`;
        body.innerHTML = `<div class="lbl">Цвет кузова</div>${sw(D.PAINTS, look.color, 'color')}<div class="lbl">Цвет рисунка</div>${sw(D.PAINTS, look.color2, 'color2')}
          <div class="lbl">Рисунок</div>${segL(D.LIVERIES, look.livery, 'livery')}<div class="lbl">Диски</div>${segL(D.RIMS, look.rims, 'rims')}
          <div class="lbl">Цвет дисков</div>${sw(D.RIM_COLORS, look.rimColor, 'rimColor')}`;
        body.querySelectorAll('[data-look]').forEach((b) => { b.onclick = () => { const p = {}; p[b.dataset.look] = b.dataset.v; G.career.setLook(car, p); A.play('click'); buildGarage(); }; });
      }
    }
    const act = $('gActions'); act.innerHTML = '';
    if (owned) {
      const b = document.createElement('button'); b.className = 'buy'; b.id = 'gSelect';
      b.textContent = car === G.career.d.current ? 'Выбрана для гонок' : 'Выбрать для гонок'; b.disabled = car === G.career.d.current;
      b.onclick = () => { G.career.select(car); A.play('click'); toast(def.name + ' - ваша машина'); buildGarage(); };
      act.appendChild(b);
    } else {
      const b = document.createElement('button'); b.className = 'buy'; b.id = 'gBuy';
      b.textContent = 'Купить за ' + money(def.price); b.disabled = G.career.money < def.price;
      b.onclick = () => confirmBox('Покупка', `Купить «${def.name}» за ${money(def.price)}? Останется ${money(G.career.money - def.price)}.`, () => {
        const r = G.career.buyCar(car); if (r.ok) { A.play('buy'); toast(def.name + ' в гараже!'); } else toast(r.reason); buildGarage();
      });
      act.appendChild(b);
    }
    R.showroomView('garage'); R.setShowroomCar(car, owned ? G.career.look(car) : C.defaultLook(car));
  }
  document.querySelectorAll('#gTabs button').forEach((b) => { b.onclick = () => { G.gTab = b.dataset.tab; A.play('click'); buildGarage(); }; });
  (function dragRotate() {
    const st = $('gStage'); let down = false, lx = 0;
    st.addEventListener('pointerdown', (e) => { down = true; lx = e.clientX; st.setPointerCapture(e.pointerId); });
    st.addEventListener('pointermove', (e) => { if (down) { R.rotateShowroom((e.clientX - lx) * 0.01); lx = e.clientX; } });
    st.addEventListener('pointerup', () => { down = false; });
  })();

  // ======================= настройки =======================
  function setSetting(k, v) {
    G.settings[k] = v;
    if (k === 'quality') {
      const q = D.QUALITY[v];
      G.settings.shadows = q.shadowMap > 0; G.settings.particles = q.particles; G.settings.drawDist = q.drawDist;
    }
    save(KEY.settings, G.settings);
    applySettings();
  }
  function applySettings() {
    const s = G.settings;
    A.applyVolumes(s);
    R.applySettings(s);
    if (G.race && G.race.player) Object.assign(G.race.player.assist, playerAssist());
    $('hFps').style.display = s.showFps ? 'block' : 'none';
    updateKeysHint();
  }
  const keyName = (code) => {
    if (!code) return '—';
    const m = { Space: 'Пробел', ShiftLeft: 'Shift', ShiftRight: 'Shift (пр.)', ControlLeft: 'Ctrl', ControlRight: 'Ctrl (пр.)', AltLeft: 'Alt', AltRight: 'Alt (пр.)',
      ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace' };
    if (m[code]) return m[code];
    if (code.startsWith('Key')) return code.slice(3);
    if (code.startsWith('Digit')) return code.slice(5);
    if (code.startsWith('Numpad')) return 'Num ' + code.slice(6);
    return code;
  };
  function buildSettings() {
    const s = G.settings, body = $('sBody');
    document.querySelectorAll('#sTabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === G.sTab));
    const seg = (key, items) => `<div class="seg" data-set="${key}">${items.map((it) => `<button data-v="${it[0]}" class="${String(s[key]) === String(it[0]) ? 'on' : ''}">${it[1]}</button>`).join('')}</div>`;
    const onoff = (key) => seg(key, [[true, 'Вкл'], [false, 'Выкл']]);
    const range = (key, min, max, step) => `<input type="range" data-range="${key}" min="${min}" max="${max}" step="${step}" value="${s[key]}">`;
    const row = (label, ctrl, sub) => `<div class="set"><div class="k">${label}${sub ? `<small>${sub}</small>` : ''}</div><div>${ctrl}</div></div>`;
    let h = '';
    if (G.sTab === 'sound') {
      h = row('Музыка', range('musicVol', 0, 1, 0.05)) + row('Эффекты', range('sfxVol', 0, 1, 0.05), 'удары, шины, сигналы') + row('Мотор', range('engineVol', 0, 1, 0.05));
    } else if (G.sTab === 'game') {
      h = row('Сложность соперников', seg('difficulty', Object.keys(D.DIFFICULTY).map((k) => [k, D.DIFFICULTY[k].name])), 'темп и число ошибок ИИ')
        + row('Скорость', seg('units', [['kmh', 'км/ч'], ['mph', 'mph']]))
        + row('Камера по умолчанию', seg('camera', [['chase', 'Сзади'], ['far', 'Дальняя'], ['hood', 'С капота']]), 'в гонке - клавиша C')
        + row('Коробка передач', seg('gearbox', [['auto', 'Автомат'], ['manual', 'Ручная']]), 'ручная: E - вверх, Q - вниз')
        + row('Антипробуксовка', onoff('tc')) + row('АБС', onoff('abs'), 'без АБС колёса блокируются, руль хуже слушается')
        + row('Помощь рулём', onoff('steerAssist'), 'меньше угол на скорости и подруливание в заносе')
        + row('Чувствительность руля', range('steerSens', 0.5, 1.6, 0.05))
        + row('Прогресс карьеры', '<button class="danger" id="sReset">Сбросить прогресс…</button>', 'деньги, машины, медали');
    } else if (G.sTab === 'controls') {
      h = '<p class="note">Нажмите на клавишу, затем новую. Esc - отмена, Backspace - очистить. Если клавиша занята, действия поменяются клавишами.</p>';
      for (const a of D.ACTIONS) {
        h += row(a.name, `<div class="keyrow">${[0, 1].map((k) => `<button class="keyslot" data-act="${a.id}" data-slot="${k}">${esc(keyName(s.bindings[a.id][k]))}</button>`).join('')}</div>`);
      }
      h += row('', '<button class="back" id="sKeysReset">Вернуть клавиши по умолчанию</button>');
      h += row('Геймпад', onoff('gamepad'), `<span id="padState">${padName() || 'не подключён'}</span>`) + row('Мёртвая зона стика', range('deadzone', 0, 0.4, 0.01))
        + '<p class="note">Геймпад: левый стик - руль, RT - газ, LT - тормоз, X - ручник, A - нитро, Y - камера, LB/RB - передачи, Back - на трассу, Start - пауза.</p>';
    } else {
      h = row('Качество', seg('quality', [['low', 'Низкое'], ['medium', 'Среднее'], ['high', 'Высокое'], ['ultra', 'Ультра']]), 'набор настроек ниже')
        + row('Тени', onoff('shadows')) + row('Дальность прорисовки', seg('drawDist', [['near', 'Близко'], ['mid', 'Средне'], ['far', 'Далеко']]))
        + row('Частицы (дым, пыль)', seg('particles', [['low', 'Мало'], ['medium', 'Средне'], ['high', 'Много']]))
        + row('Размытие скорости', onoff('motionBlur'), 'полосы по краям экрана на большой скорости') + row('Показывать FPS', onoff('showFps'));
    }
    body.innerHTML = h;
    body.querySelectorAll('[data-set]').forEach((el) => el.querySelectorAll('button').forEach((b) => {
      b.onclick = () => { let v = b.dataset.v; if (v === 'true') v = true; else if (v === 'false') v = false; setSetting(el.dataset.set, v); A.play('click'); buildSettings(); };
    }));
    body.querySelectorAll('[data-range]').forEach((el) => { el.oninput = () => setSetting(el.dataset.range, Number(el.value)); });
    body.querySelectorAll('.keyslot').forEach((b) => { b.onclick = () => { G.rebinding = { action: b.dataset.act, slot: Number(b.dataset.slot), el: b }; b.classList.add('wait'); b.textContent = 'Нажмите…'; }; });
    const rs = $('sReset'); if (rs) rs.onclick = () => confirmBox('Сбросить прогресс?', 'Деньги, купленные машины, тюнинг и медали пропадут. Настройки и рекорды останутся. Отменить это нельзя.', () => {
      G.career = new C.Career(null, (d) => save(KEY.career, d)); save(KEY.career, G.career.d); toast('Прогресс сброшен'); buildSettings();
    });
    const kr = $('sKeysReset'); if (kr) kr.onclick = () => { G.settings.bindings = JSON.parse(JSON.stringify(D.DEFAULT_BINDINGS)); save(KEY.settings, G.settings); applySettings(); buildSettings(); };
  }
  document.querySelectorAll('#sTabs button').forEach((b) => { b.onclick = () => { G.sTab = b.dataset.tab; A.play('click'); buildSettings(); }; });
  function finishRebind(code) {
    const rb = G.rebinding; G.rebinding = null;
    if (code === null) { buildSettings(); return; }
    const r = C.rebind(G.settings.bindings, rb.action, rb.slot, code);
    G.settings.bindings = r.bindings; save(KEY.settings, G.settings); applySettings();
    buildSettings();
    if (r.conflict) {
      const other = D.ACTIONS.find((a) => a.id === r.conflict.action);
      toast(`Клавиша ${keyName(code)} была у «${other.name}» - поменяли местами`);
      const el = document.querySelector(`.keyslot[data-act="${r.conflict.action}"][data-slot="${r.conflict.slot}"]`); if (el) el.classList.add('conflict');
    }
  }

  // ======================= рекорды и помощь =======================
  function buildRecords() {
    const rec = G.records.tracks, st = G.career.d.stats;
    let medals = { gold: 0, silver: 0, bronze: 0 };
    D.CUPS.forEach((c, i) => { const m = G.career.cupMedals(i); medals.gold += m.gold; medals.silver += m.silver; medals.bronze += m.bronze; });
    let h = '<table><tr><th>Трасса</th><th>Место</th><th>Лучший круг</th><th>Лучший заезд на время</th><th>Лучший дрифт</th></tr>';
    for (const t of D.TRACKS) {
      const r = rec[t.id] || {};
      h += `<tr><td>${esc(t.name)}</td><td>${esc(t.place)}</td><td>${r.lap ? C.fmtTime(r.lap) : '—'}</td><td>${r.time ? C.fmtTime(r.time) : '—'}</td><td>${r.drift ? r.drift.toLocaleString('ru-RU') : '—'}</td></tr>`;
    }
    h += '</table><h3 style="margin:22px 0 8px;letter-spacing:2px">КАРЬЕРА</h3><table>';
    h += `<tr><td>Заездов</td><td>${st.races}</td></tr><tr><td>Побед</td><td>${st.wins}</td></tr><tr><td>Медали</td><td>${medalHtml('gold')} ${medals.gold} &nbsp; ${medalHtml('silver')} ${medals.silver} &nbsp; ${medalHtml('bronze')} ${medals.bronze}</td></tr>`;
    h += `<tr><td>Заработано</td><td>${money(st.earned)}</td></tr><tr><td>Потрачено</td><td>${money(st.spent)}</td></tr><tr><td>Лучшая серия дрифта</td><td>${(st.driftBest || 0).toLocaleString('ru-RU')}</td></tr>`;
    h += `<tr><td>Машин в гараже</td><td>${G.career.d.owned.length} из ${D.CARS.length}</td></tr><tr><td>Чемпион</td><td>${G.career.d.victory ? 'да' : 'пока нет'}</td></tr></table>`;
    $('recBody').innerHTML = h;
  }
  function buildHelp() {
    const b = G.settings.bindings, k = (a) => b[a].filter(Boolean).map((c) => `<kbd>${esc(keyName(c))}</kbd>`).join(' ');
    $('helpBody').innerHTML = `
      <h3>Управление</h3><ul>
      <li>${k('accel')} газ, ${k('brake')} тормоз и задний ход</li><li>${k('left')} ${k('right')} руль</li>
      <li>${k('handbrake')} ручник - сорвать заднюю ось в занос</li><li>${k('nitro')} нитро (копится в заносе)</li>
      <li>${k('camera')} камера: сзади, дальняя, с капота</li><li>${k('reset')} вернуться на трассу</li>
      <li>${k('pause')} или <kbd>Esc</kbd> пауза</li><li>${k('shiftUp')} ${k('shiftDown')} передачи (ручная коробка)</li></ul>
      <p>Клавиши меняются в «Настройках». Геймпад: стик - руль, курки - газ и тормоз.</p>
      <h3>Режимы</h3><ul><li><b>Гонка</b> - обгоните соперников, медаль за 1-3 место.</li><li><b>Дрифт</b> - очки за занос: шире угол и дольше серия - больше очков, множитель растёт до ×5. Удар о стену или машину срывает серию.</li>
      <li><b>На время</b> - один на трассе, медаль по времени.</li><li><b>Дуэль</b> - один на один с чемпионом кубка.</li><li><b>На вылет</b> - после каждого круга последний выбывает.</li></ul>
      <h3>Трасса</h3><ul><li>Голубая арка - следующий чекпоинт. Круг засчитывается, только если взяты все чекпоинты: срезать нельзя.</li>
      <li>Покрытие меняет сцепление: асфальт держит лучше всего, гравий хуже, снег хуже всего. Полноприводный «Буран» на гравии и снегу сильнее всех.</li>
      <li>Красная стрелка «Не туда» - вы едете против хода. <kbd>R</kbd> вернёт на трассу.</li></ul>
      <h3>Карьера</h3><ul><li>5 кубков по 3-4 события. Медаль в каждом событии открывает следующий кубок.</li>
      <li>За места и медали платят. Деньги - на машины и тюнинг в «Гараже».</li><li>Выиграйте «Гран-при Горизонта» - станете чемпионом.</li></ul>
      <h3>Советы</h3><ul><li>Тормозите до поворота, газ - на выходе.</li><li>Для заноса: скорость, руль в поворот и короткий ручник, затем газом держите угол.</li>
      <li>Без антипробуксовки заднеприводные машины легко идут боком.</li><li>Мощность мало решает, если шины не держат: ставьте «Шины» и «Подвеску».</li></ul>
      <h3>Об игре</h3><p>Horizon Drift - фан-концепт, не связан с Microsoft/Playground Games. Все машины, трассы, гонщики и названия выдуманы. Модели, текстуры, звук и музыка сделаны кодом прямо в игре.</p>`;
  }

  // ======================= победа =======================
  let confettiRaf = 0;
  function buildVictory() {
    A.music('victory');
    $('creditsRoll').innerHTML = `<h4>Horizon Drift</h4><p>Аркадные гонки для «Игротеки»</p>
      <h4>Чемпион</h4><p>Вы - ${G.career.d.stats.wins} побед, ${money(G.career.d.stats.earned)} призовых</p>
      <h4>Трассы</h4><p>${D.TRACKS.map((t) => esc(t.name)).join(' · ')}</p>
      <h4>Машины</h4><p>${D.CARS.map((c) => esc(c.name)).join(' · ')}</p>
      <h4>Соперники</h4><p>${D.DRIVERS.join(' · ')}</p>
      <h4>Графика</h4><p>three.js r149 (лицензия MIT), модели и текстуры - кодом</p>
      <h4>Звук и музыка</h4><p>Синтез WebAudio прямо в игре</p>
      <h4>Важно</h4><p>Фан-концепт, не связан с Microsoft/Playground Games.<br>Все марки, трассы и имена выдуманы.</p>
      <h4>Спасибо за игру!</h4>`;
    const cv = $('confetti'), g = cv.getContext('2d'); cv.width = innerWidth; cv.height = innerHeight;
    const rng = C.mulberry32(7), bits = [];
    for (let i = 0; i < 160; i++) bits.push({ x: rng() * cv.width, y: -rng() * cv.height, v: 60 + rng() * 120, r: rng() * 6, c: D.PAINTS[Math.floor(rng() * 9)], a: rng() * 6 });
    let last = performance.now();
    cancelAnimationFrame(confettiRaf);
    const tick = (now) => {
      if (G.screen !== 'victory') return;
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      g.clearRect(0, 0, cv.width, cv.height);
      for (const b of bits) { b.y += b.v * dt; b.a += dt * 3; if (b.y > cv.height) b.y = -10; g.save(); g.translate(b.x + Math.sin(b.a) * 12, b.y); g.rotate(b.a); g.fillStyle = b.c; g.fillRect(-4, -2, 8 + b.r, 4); g.restore(); }
      confettiRaf = requestAnimationFrame(tick);
    };
    confettiRaf = requestAnimationFrame(tick);
  }
  $('vMenu').onclick = () => { G.stack = []; show('main'); };
  $('vGarage').onclick = () => { G.stack = ['main']; show('garage'); };

  // ======================= заезд =======================
  const TIPS = ['Голубая арка показывает следующий чекпоинт.', 'Ручник срывает заднюю ось - так начинается занос.', 'Нитро копится, пока вы в заносе.',
    'На снегу тормозите раньше: сцепления почти вдвое меньше.', 'Удар о стену срывает серию дрифта - очки серии пропадают.', 'В паузе можно сменить камеру и управление в «Настройках».',
    'Клавиша R вернёт машину на трассу, если вы застряли.', 'Соперники тоже ошибаются - особенно на лёгкой сложности.'];
  async function startRace(cfg, meta) {
    A.init();
    stopRace();
    G.cfg = cfg; G.meta = meta; G.paused = false; G.doneT = -1; G.resultShown = false; G.camMode = G.settings.camera;
    const td = trackDef(cfg.track);
    $('loadName').textContent = meta.title && meta.kind === 'career' ? meta.title : td.name;
    $('loadPlace').textContent = td.name + ' · ' + td.place + ' · ' + D.EVENT_TYPES[cfg.mode === 'free' ? 'race' : cfg.mode].name;
    $('loadTip').textContent = TIPS[Math.floor(Math.random() * TIPS.length)];
    drawMini($('loadMap'), cfg.track);
    $('loadBar').style.width = '0%';
    show('load');
    let race;
    try {
      race = new C.Race(cfg);
      const looks = cfg.entries.map((e) => e.look || C.defaultLook(e.car));
      await R.buildRace(race, looks, (p) => { $('loadBar').style.width = Math.round(p * 100) + '%'; });
    } catch (err) {
      R.disposeRace(); G.stack = []; show('main', true); toast('Не удалось загрузить трассу');
      throw err;
    }
    G.race = race;
    G.lastStep = performance.now(); G.acc = 0;
    prepareHud();
    show('race');
    A.music('race');
    return race;
  }
  function stopRace() {
    if (G.race) { R.disposeRace(); G.race = null; }
    A.silenceRace();
    $('scrResults').classList.remove('show'); $('scrPause').classList.remove('show');
  }
  function quitToMenu() { stopRace(); G.stack = []; show('main'); }
  function setPaused(p) {
    if (!G.race || G.screen !== 'race' || G.resultShown) return;
    G.paused = p;
    $('scrPause').classList.toggle('show', p);
    G.keys.clear(); clearInput();
    if (p) A.silenceRace();
    G.acc = 0; G.lastStep = performance.now();
    if (p) setTimeout(() => $('pResume').focus(), 0);
  }
  G.setPaused = setPaused;
  $('hPauseBtn').onclick = (e) => { e.currentTarget.blur(); setPaused(true); };
  $('pResume').onclick = () => setPaused(false);
  $('pSettings').onclick = () => { G.settingsFromPause = true; $('scrPause').classList.remove('show'); G.stack = []; G.screen = 'settings'; $('hud').classList.remove('show'); $('scrSettings').classList.add('show'); buildSettings(); };
  $('pRestart').onclick = () => restart();
  $('pMenu').onclick = () => quitToMenu();
  function restart() { const cfg = Object.assign({}, G.cfg, { seed: nextSeed() }); startRace(cfg, G.meta); }
  $('resAgain').onclick = () => restart();
  $('resMenu').onclick = () => quitToMenu();
  $('resNext').onclick = () => {
    const m = G.meta, vict = G.lastApply && G.lastApply.victory;
    stopRace();
    if (vict) { G.stack = ['main']; show('victory', true); return; }
    if (m && m.kind === 'career') { G.stack = ['main', 'career']; show('cup', true); } else { G.stack = ['main']; show('quick', true); }
  };

  // ======================= HUD =======================
  let mapBase = null;
  const hudCache = {};
  const setText = (id, v) => { if (hudCache[id] !== v) { hudCache[id] = v; $(id).textContent = v; } };
  const setHtml = (id, v) => { if (hudCache[id] !== v) { hudCache[id] = v; $(id).innerHTML = v; } };
  function prepareHud() {
    for (const k in hudCache) delete hudCache[k];
    const race = G.race, tr = race.track;
    const c = $('hMapC'), w = c.width;
    mapBase = document.createElement('canvas'); mapBase.width = w; mapBase.height = w;
    const g = mapBase.getContext('2d'), mp = R.minimapPath(tr, w, w, 14);
    G.mapFn = mp.map;
    g.lineJoin = 'round'; g.lineCap = 'round';
    g.beginPath(); for (let i = 0; i < tr.N; i += 2) { const p = mp.map(tr.x[i], tr.z[i]); i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]); } if (tr.closed) g.closePath();
    g.strokeStyle = 'rgba(0,0,0,0.5)'; g.lineWidth = 9; g.stroke(); g.strokeStyle = 'rgba(255,255,255,0.75)'; g.lineWidth = 4; g.stroke();
    const s0 = mp.map(tr.cps[0].x, tr.cps[0].z); g.fillStyle = '#fff'; g.fillRect(s0[0] - 3, s0[1] - 3, 6, 6);
    $('hDriftRow').style.display = race.mode === 'drift' ? 'flex' : 'none';
    $('hBoard').style.display = race.cars.length > 1 ? 'block' : 'none';
    const m = G.meta || {};
    let goal = '';
    if (race.mode === 'drift' && m.goal) goal = 'Цели: ' + m.goal.map((v) => v.toLocaleString('ru-RU')).join(' / ');
    if (race.mode === 'time' && m.thresholds) goal = 'Медали: ' + m.thresholds.map(C.fmtTime).join(' / ');
    if (race.mode === 'elim') goal = 'После круга последний выбывает';
    if (race.mode === 'duel') goal = 'Дуэль: только победа';
    $('hGoal').textContent = goal;
    $('hMsg').classList.remove('show');
    updateKeysHint();
  }
  function updateKeysHint() {
    const b = G.settings.bindings, k = (a) => keyName(b[a][0] || b[a][1]);
    $('hKeys').textContent = `${k('accel')}/${k('brake')} газ-тормоз · ${k('left')}/${k('right')} руль · ${k('handbrake')} ручник · ${k('nitro')} нитро · ${k('camera')} камера · ${k('reset')} на трассу · Esc пауза`;
  }
  let msgT = 0;
  function showMsg(big, small, ms) {
    const el = $('hMsg'); el.innerHTML = esc(big) + (small ? `<small>${esc(small)}</small>` : ''); el.classList.add('show');
    clearTimeout(msgT); msgT = setTimeout(() => el.classList.remove('show'), ms || 1400);
  }
  function drawSpeedo(pl) {
    const cv = $('hSpeedC'), g = cv.getContext('2d'), w = cv.width, c = w / 2, r = c - 16;
    g.clearRect(0, 0, w, w);
    const a0 = Math.PI * 0.75, sweep = Math.PI * 1.5, rpmN = C.clamp((pl.rpm || 900) / 8000, 0, 1.05);
    g.lineCap = 'round';
    g.lineWidth = 9; g.strokeStyle = 'rgba(255,255,255,0.1)'; g.beginPath(); g.arc(c, c, r, a0, a0 + sweep); g.stroke();
    g.strokeStyle = 'rgba(255,74,90,0.55)'; g.beginPath(); g.arc(c, c, r, a0 + sweep * 0.85, a0 + sweep); g.stroke();
    const grd = g.createLinearGradient(0, w, w, 0); grd.addColorStop(0, '#ff5a1f'); grd.addColorStop(1, '#ffd23a');
    g.strokeStyle = rpmN > 0.88 ? '#ff4a5a' : grd; g.beginPath(); g.arc(c, c, r, a0, a0 + sweep * Math.min(1, rpmN)); g.stroke();
    g.fillStyle = 'rgba(255,255,255,0.55)'; g.font = `${Math.round(w * 0.055)}px Bahnschrift, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
    for (let k = 0; k <= 8; k++) { const a = a0 + sweep * k / 8; g.fillText(String(k), c + Math.cos(a) * (r - 20), c + Math.sin(a) * (r - 20)); }
    const sp = Math.round(C.toUnits(pl.speed, G.settings.units));
    g.fillStyle = '#fff'; g.font = `bold ${Math.round(w * 0.24)}px Bahnschrift, sans-serif`; g.fillText(String(sp), c, c - 4);
    g.fillStyle = '#ffb02e'; g.font = `${Math.round(w * 0.065)}px Bahnschrift, sans-serif`; g.fillText(G.settings.units === 'mph' ? 'MPH' : 'КМ/Ч', c, c + w * 0.14);
    const gear = pl.gear === -1 ? 'R' : String(pl.gear);
    g.fillStyle = 'rgba(255,255,255,0.1)'; g.fillRect(c - 18, c + w * 0.2, 36, 30);
    g.fillStyle = pl.shiftT > 0 ? '#19d3ff' : '#fff'; g.font = `bold ${Math.round(w * 0.1)}px Bahnschrift, sans-serif`; g.fillText(gear, c, c + w * 0.2 + 16);
    g.fillStyle = 'rgba(255,255,255,0.5)'; g.font = `${Math.round(w * 0.045)}px Bahnschrift, sans-serif`; g.fillText('×1000 об/мин', c, c + w * 0.36);
  }
  function drawMap(race) {
    const cv = $('hMapC'), g = cv.getContext('2d'), w = cv.width;
    g.clearRect(0, 0, w, w); g.drawImage(mapBase, 0, 0);
    const tr = race.track, pl = race.player;
    if (pl && tr.cps.length) {
      let k = pl.nextCp; if (tr.closed && k >= tr.cps.length) k = 0; k = Math.min(k, tr.cps.length - 1);
      const cp = G.mapFn(tr.cps[k].x, tr.cps[k].z); g.strokeStyle = '#19d3ff'; g.lineWidth = 2; g.beginPath(); g.arc(cp[0], cp[1], 6, 0, Math.PI * 2); g.stroke();
    }
    for (const c of race.cars) {
      if (c.out || c === pl) continue;
      const p = G.mapFn(c.x, c.z); g.fillStyle = c.rival ? '#ff4a5a' : '#ffb02e'; g.beginPath(); g.arc(p[0], p[1], 4, 0, Math.PI * 2); g.fill();
    }
    if (pl) {
      const p = G.mapFn(pl.x, pl.z), a = Math.atan2(-Math.sin(pl.h), Math.cos(pl.h));
      g.save(); g.translate(p[0], p[1]); g.rotate(a); g.fillStyle = '#19d3ff'; g.strokeStyle = '#000'; g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(0, 8); g.lineTo(5, -5); g.lineTo(-5, -5); g.closePath(); g.fill(); g.stroke(); g.restore();
    }
  }
  function updateHud(dtFrame) {
    const race = G.race, pl = race.player; if (!pl) return;
    const tr = race.track, mode = race.mode;
    const alive = race.cars.filter((c) => !c.out).length;
    if (mode === 'drift' || mode === 'time' || race.cars.length === 1) setHtml('hPos', D.EVENT_TYPES[mode === 'free' ? 'race' : mode] ? `<span style="font-size:30px">${D.EVENT_TYPES[mode].name.toUpperCase()}</span>` : '');
    else setHtml('hPos', `${pl.place}<small>/${alive}</small>`);
    if (tr.closed) { setText('hLapK', 'КРУГ'); setText('hLap', `${Math.min(race.laps, pl.lap + 1)}/${race.laps}`); } else { setText('hLapK', 'ЧЕКПОИНТ'); setText('hLap', `${Math.max(0, pl.nextCp - 1)}/${tr.cps.length - 1}`); }
    setText('hTime', C.fmtTime(pl.finished ? pl.finishT : race.t));
    setText('hBest', pl.bestLap ? C.fmtTime(pl.bestLap) : '--:--.--');
    setText('hDriftTotal', race.drift.total.toLocaleString('ru-RU'));
    const dr = race.drift, showDrift = dr.active && dr.pending > 0;
    $('hDrift').style.display = showDrift ? 'block' : 'none';
    if (showDrift) { setText('hDriftPts', '+' + dr.pending.toLocaleString('ru-RU')); setText('hDriftMul', '×' + dr.mult); $('hDriftGrace').style.width = Math.round((1 - dr.grace / 1.2) * 100) + '%'; }
    if (race.cars.length > 1) {
      let h = '';
      const ref = pl.dist;
      race.order.forEach((c, i) => {
        let gap = '';
        if (c !== pl && !c.out) { const d = ref - c.dist, v = Math.max(12, pl.speed); gap = (d > 0 ? '−' : '+') + Math.abs(d / v).toFixed(1); }
        h += `<div class="${c === pl ? 'me' : ''}${c.out ? ' out' : ''}"><span>${i + 1}. ${esc(c.name)}</span><span>${c.out ? 'выбыл' : c.finished ? 'финиш' : gap}</span></div>`;
      });
      setHtml('hBoard', h);
    }
    $('hNitroBar').style.height = `calc((100% - 6px) * ${pl.nitro.toFixed(3)})`;
    $('hNitroBar').style.opacity = pl.nitroOn ? '1' : '0.8';
    $('hWrong').style.display = pl.wrong && !pl.finished ? 'block' : 'none';
    const cd = $('hCount');
    if (race.phase === 'countdown') { cd.style.display = 'block'; setText('hCount', String(Math.ceil(race.countdown))); }
    else if (race.t < 0.8) { cd.style.display = 'block'; setText('hCount', 'СТАРТ!'); } else cd.style.display = 'none';
    drawSpeedo(pl); drawMap(race);
    if (G.settings.showFps) setText('hFps', G.fps + ' FPS');
  }
  // полосы скорости по краям экрана
  function drawFx(pl) {
    const cv = $('fx'), g = cv.getContext('2d');
    if (cv.width !== innerWidth || cv.height !== innerHeight) { cv.width = innerWidth; cv.height = innerHeight; }
    g.clearRect(0, 0, cv.width, cv.height);
    if (!pl || !G.settings.motionBlur || G.paused) return;
    const k = C.clamp((pl.speed - 30) / 50, 0, 1) + (pl.nitroOn ? 0.4 : 0);
    if (k <= 0) return;
    const w = cv.width, h = cv.height, cx = w / 2, cy = h * 0.45, R0 = Math.hypot(w, h) / 2;
    g.strokeStyle = `rgba(255,255,255,${0.1 * k})`; g.lineWidth = 2;
    for (let i = 0; i < 40; i++) {
      const a = Math.random() * Math.PI * 2, r1 = R0 * (0.55 + Math.random() * 0.2), r2 = r1 + R0 * (0.15 + 0.3 * k);
      g.beginPath(); g.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1); g.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2); g.stroke();
    }
    const gr = g.createRadialGradient(cx, cy, R0 * 0.5, cx, cy, R0); gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, `rgba(0,0,0,${0.35 * k})`);
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
  }

  // ======================= события заезда =======================
  function handleEvents() {
    const race = G.race, pl = race.player;
    if (pl && pl.events.length) { for (const e of pl.events) if (e === 'up' || e === 'down') A.play('shift'); }
    if (!race.events.length) return;
    for (const e of race.events) {
      switch (e.type) {
        case 'count': A.play('count'); break;
        case 'go': A.play('go'); break;
        case 'cp': A.play('cp'); showMsg('Чекпоинт', '', 700); break;
        case 'lap': A.play('lap'); showMsg(e.lap === race.laps ? 'Последний круг!' : `Круг ${e.lap}`, 'круг за ' + C.fmtTime(e.time), 1600); break;
        case 'missed': A.play('miss'); showMsg('Пропущен чекпоинт!', 'круг не засчитан - вернитесь к голубой арке', 2200); break;
        case 'driftBank': A.play('bank'); showMsg('+' + e.pts.toLocaleString('ru-RU'), 'дрифт засчитан', 1100); break;
        case 'comboLost': A.play('lost'); showMsg('Комбо сорвано!', 'удар срывает серию дрифта', 1300); break;
        case 'hit': if (e.car === pl || (pl && Math.hypot(e.car.x - pl.x, e.car.z - pl.z) < 30)) A.play('hit', e.v); break;
        case 'elim': A.play('elim'); showMsg(e.car === pl ? 'Вы выбыли' : `${e.car.name} выбывает`, '', 1800); break;
        case 'reset': showMsg('Снова на трассе', '', 900); break;
        case 'finish': showMsg('Финиш!', '', 1800); break;
        case 'done': G.doneT = 1.6; onRaceDone(); break;
        default: break;
      }
    }
    race.events.length = 0;
  }
  function saveRecords(res) {
    const r = G.records.tracks[res.track] = G.records.tracks[res.track] || {};
    if (res.bestLap && (!r.lap || res.bestLap < r.lap)) r.lap = Math.round(res.bestLap * 1000) / 1000;
    if (res.mode === 'time' && res.time && (!r.time || res.time < r.time)) r.time = Math.round(res.time * 1000) / 1000;
    if (res.drift && (!r.drift || res.drift > r.drift)) r.drift = res.drift;
    save(KEY.records, G.records);
  }
  function onRaceDone() {
    const res = G.race.result, m = G.meta || {};
    res.thresholds = m.thresholds || null;
    saveRecords(res);
    G.lastApply = m.kind === 'career' ? G.career.applyResult(m.evtId, res) : null;
    G.lastResult = res;
  }
  function showResults() {
    const res = G.lastResult, ap = G.lastApply, m = G.meta || {};
    if (!res) return;
    G.resultShown = true;
    $('scrPause').classList.remove('show');
    const medal = ap ? ap.medal : null;
    $('resTitle').textContent = res.out ? 'Выбыли' : res.mode === 'drift' ? 'Дрифт окончен' : 'Финиш';
    const mEl = $('resMedal');
    if (m.kind === 'career') { mEl.style.display = 'grid'; mEl.className = 'bigmedal medal ' + (medal || 'none'); mEl.textContent = medal ? MEDAL_RU[medal] : 'без медали'; } else mEl.style.display = 'none';
    let txt = '';
    if (res.mode === 'drift') txt = `Очки дрифта: <b>${res.drift.toLocaleString('ru-RU')}</b>${m.goal ? `<br><span class="note">Цели: ${m.goal.map((v) => v.toLocaleString('ru-RU')).join(' / ')}</span>` : ''}<br>Лучшая серия: ${res.driftBest.toLocaleString('ru-RU')}`;
    else if (res.mode === 'time') txt = `Время: <b>${C.fmtTime(res.time)}</b>${m.thresholds ? `<br><span class="note">Золото / серебро / бронза: ${m.thresholds.map(C.fmtTime).join(' / ')}</span>` : ''}`;
    else txt = `Место: <b>${res.place}</b> из ${res.table.length}${res.time ? '<br>Время: ' + C.fmtTime(res.time) : ''}`;
    if (res.bestLap && res.mode !== 'time' && G.race && G.race.track.closed) txt += `<br>Лучший круг: ${C.fmtTime(res.bestLap)}`;
    if (ap) txt += `<br><span class="reward">+${money(ap.reward)}</span>`;
    $('resText').innerHTML = txt;
    let ban = '';
    if (ap && ap.better) ban += `<div class="banner">Новая медаль: ${MEDAL_RU[ap.medal]}!</div>`;
    if (ap && ap.unlocked) ban += `<div class="banner">Открыт кубок «${esc(ap.unlocked.name)}»!</div>`;
    if (ap && ap.victory) ban += '<div class="banner">Все кубки пройдены - вы чемпион!</div>';
    if (m.kind === 'career' && !medal) ban += '<div class="banner" style="background:rgba(255,74,90,0.15);color:#ffc6cb">Медали нет - попробуйте ещё раз или улучшите машину в гараже</div>';
    $('resBanners').innerHTML = ban;
    if (res.table.length > 1) {
      const lead = res.table[0].time;
      let h = '<table><tr><th>#</th><th>Гонщик</th><th>Машина</th><th>Время</th><th>Лучший круг</th></tr>';
      for (const r of res.table) {
        const t = r.out ? 'выбыл' : r.time == null ? '—' : r.place === 1 ? C.fmtTime(r.time) : '+' + (r.time - lead).toFixed(2) + (r.est ? '*' : '');
        h += `<tr class="${r.isPlayer ? 'me' : ''}"><td>${r.place}</td><td>${esc(r.name)}</td><td>${esc(C.carDef(r.carId).name)}</td><td>${t}</td><td>${r.bestLap ? C.fmtTime(r.bestLap) : '—'}</td></tr>`;
      }
      h += '</table>' + (res.table.some((r) => r.est) ? '<p class="note">* по темпу: соперник ещё не доехал</p>' : '');
      $('resTable').innerHTML = h;
    } else $('resTable').innerHTML = '';
    $('resNext').textContent = ap && ap.victory ? 'К награде' : 'Дальше';
    $('scrResults').classList.add('show');
    if (medal) A.play('medal');
    setTimeout(() => $('resNext').focus(), 0);
  }

  // ======================= управление =======================
  const actionDown = (a) => { const b = G.settings.bindings[a]; return (b[0] && G.keys.has(b[0])) || (b[1] && G.keys.has(b[1])); };
  const actionFor = (code) => { for (const a in G.settings.bindings) if (G.settings.bindings[a].includes(code)) return a; return null; };
  function clearInput() { Object.assign(G.input, { thr: 0, brk: 0, steer: 0, hb: 0, nitro: 0, analog: false }); }
  document.addEventListener('keydown', (e) => {
    A.init();
    if (G.rebinding) {
      e.preventDefault();
      if (e.code === 'Escape') finishRebind(null);
      else if (e.code === 'Backspace') finishRebind('');
      else finishRebind(e.code);
      return;
    }
    if ($('modal').classList.contains('show')) { if (e.code === 'Escape') $('modal').classList.remove('show'); return; }
    if (G.screen === 'race' && G.race) {
      const act = actionFor(e.code);
      if (act || e.code === 'Escape') e.preventDefault();
      if (G.resultShown) return;
      if (e.code === 'Escape' || act === 'pause') { if (!e.repeat) setPaused(!G.paused); return; }
      if (G.paused) return;
      G.keys.add(e.code);
      if (e.repeat) return;
      if (act === 'camera') { const order = ['chase', 'far', 'hood']; G.camMode = order[(order.indexOf(G.camMode) + 1) % order.length]; showMsg({ chase: 'Камера сзади', far: 'Дальняя камера', hood: 'Камера с капота' }[G.camMode], '', 700); }
      if (act === 'reset' && G.race.player && G.race.phase === 'race' && !G.race.player.finished) G.race.resetCar(G.race.player);
      if (act === 'shiftUp') G.input.shiftUp = true;
      if (act === 'shiftDown') G.input.shiftDown = true;
      return;
    }
    if (e.code === 'Escape' && !['main', 'boot', 'load'].includes(G.screen)) { if (G.screen === 'victory') show('main'); else back(); }
  });
  document.addEventListener('keyup', (e) => { G.keys.delete(e.code); });
  window.addEventListener('blur', () => { G.keys.clear(); clearInput(); });
  document.addEventListener('pointerdown', () => A.init());

  let padPrev = [];
  function padName() { const p = getPad(); return p ? p.id.replace(/\(.*?\)/g, '').trim().slice(0, 40) + ' подключён' : ''; }
  function getPad() { if (!navigator.getGamepads) return null; const ps = navigator.getGamepads(); for (const p of ps) if (p && p.connected) return p; return null; }
  function readInput() {
    const inp = G.input;
    if (G.override) { Object.assign(inp, G.override); return; }
    let steer = (actionDown('right') ? 1 : 0) - (actionDown('left') ? 1 : 0);
    let thr = actionDown('accel') ? 1 : 0, brk = actionDown('brake') ? 1 : 0, hb = actionDown('handbrake') ? 1 : 0, nitro = actionDown('nitro') ? 1 : 0, analog = false;
    const p = G.settings.gamepad ? getPad() : null;
    if (p) {
      const dz = G.settings.deadzone, x = p.axes[0] || 0;
      if (Math.abs(x) > dz) { const v = (Math.abs(x) - dz) / (1 - dz); steer = Math.sign(x) * Math.pow(v, 1.6 - 0.5 * (G.settings.steerSens - 1)); analog = true; }
      const bv = (i) => (p.buttons[i] ? p.buttons[i].value || (p.buttons[i].pressed ? 1 : 0) : 0);
      thr = Math.max(thr, bv(7)); brk = Math.max(brk, bv(6));
      if (bv(2) > 0.5) hb = 1; if (bv(0) > 0.5) nitro = 1;
      const edge = (i) => bv(i) > 0.5 && !padPrev[i];
      if (G.screen === 'race' && G.race) {
        if (edge(9)) setPaused(!G.paused);
        if (!G.paused) {
          if (edge(3)) { const order = ['chase', 'far', 'hood']; G.camMode = order[(order.indexOf(G.camMode) + 1) % order.length]; }
          if (edge(5)) inp.shiftUp = true; if (edge(4)) inp.shiftDown = true;
          if (edge(8) && G.race.player && G.race.phase === 'race') G.race.resetCar(G.race.player);
        }
      }
      padPrev = p.buttons.map((b) => (b.value || (b.pressed ? 1 : 0)) > 0.5);
    }
    inp.thr = thr; inp.brk = brk; inp.steer = steer; inp.hb = hb; inp.nitro = nitro; inp.analog = analog;
  }

  // ======================= вкладка скрыта =======================
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (G.race && G.screen === 'race' && !G.paused && !G.resultShown) setPaused(true);
      A.suspend();
    } else {
      A.resume();                                  // звук меню возвращается; заезд остаётся на паузе
      G.lastStep = performance.now(); G.acc = 0;
    }
  });

  // ======================= цикл =======================
  function snapshot(race) { for (const c of race.cars) { c.ix = c.x; c.iz = c.z; c.ih = c.h; } }
  function stepRace(n) {
    const race = G.race;
    for (let i = 0; i < n; i++) { snapshot(race); race.step(C.DT, G.input); handleEvents(); }
  }
  let last = performance.now(), fpsAcc = 0, fpsN = 0;
  function loop(now) {
    requestAnimationFrame(loop);
    const dtRaw = (now - last) / 1000; last = now;
    const dt = Math.min(0.1, Math.max(0, dtRaw));
    fpsAcc += dt; fpsN++; if (fpsAcc > 0.5) { G.fps = Math.round(fpsN / fpsAcc); fpsAcc = 0; fpsN = 0; }
    const t0 = performance.now();
    readInput();
    let alpha = 1;
    if (G.race && (G.screen === 'race' || G.screen === 'settings') && !G.paused && G.screen === 'race' && !G.manual) {
      G.acc = (G.acc || 0) + dt;
      let n = 0;
      while (G.acc >= C.DT && n < 12) { stepRace(1); G.acc -= C.DT; n++; if (!G.race) break; }
      if (n >= 12) G.acc = 0;
      alpha = G.acc / C.DT;
      if (G.doneT > 0) { G.doneT -= dt; if (G.doneT <= 0 && !G.resultShown) showResults(); }
    }
    const tSim = performance.now();
    if (G.race) {
      R.frame(dt, G.manual ? 1 : alpha, G.camMode);
      if (G.screen === 'race') {
        updateHud(dt);
        const pl = G.race.player;
        let near = null;
        if (pl) for (const c of G.race.cars) { if (c === pl || c.out) continue; const d = Math.hypot(c.x - pl.x, c.z - pl.z); if (!near || d < near.dist) near = { car: c, dist: d }; }
        A.updateRace(pl, near, G.paused || G.resultShown && false);
        drawFx(pl);
      }
    } else { R.frame(dt, 1, G.camMode); drawFx(null); }
    const t1 = performance.now();
    G.frameTimes.push({ dt: dtRaw * 1000, sim: tSim - t0, work: t1 - t0 }); if (G.frameTimes.length > 600) G.frameTimes.shift();
  }

  window.addEventListener('resize', () => R.resize());

  // ======================= запуск =======================
  function boot() {
    R.init($('gl'));
    applySettings();
    A.applyVolumes(G.settings);
    $('bootBar').style.width = '100%';
    show('main', true);
    requestAnimationFrame(loop);
    api.ready = true;
  }

  // ======================= крючок для проверок =======================
  const api = {
    ready: false, core: C, data: D, render: R, audio: A,
    get settings() { return G.settings; }, get career() { return G.career; }, get records() { return G.records; },
    get race() { return G.race; }, get player() { return G.race ? G.race.player : null; }, get screen() { return G.screen; },
    get paused() { return G.paused; }, get camMode() { return G.camMode; }, get renderer() { return R.renderer; }, get lastResult() { return G.lastResult; }, get lastApply() { return G.lastApply; },
    set manual(v) { G.manual = !!v; }, get manual() { return G.manual; },
    setSetting, show, toMenu: quitToMenu, pause: () => setPaused(true), resume: () => setPaused(false),
    startCareer: (id) => startCareerEvent(id),
    startQuick: (o) => { Object.assign(G.quick, o || {}); return $('qStart').onclick(); },
    startRace: (cfg, meta) => startRace(cfg, meta || { kind: 'quick', title: 'Проверка' }),
    // шаги физики без рисования; input - {thr, brk, steer, hb, nitro}
    step(n, input) { if (input) G.override = Object.assign({ thr: 0, brk: 0, steer: 0, hb: 0, nitro: 0, analog: false }, input); readInput(); if (G.race && !G.paused) stepRace(n || 1); G.override = null; return G.race; },
    setInput(o) { G.override = o ? Object.assign({ thr: 0, brk: 0, steer: 0, hb: 0, nitro: 0, analog: false }, o) : null; },
    showResults, frames: () => G.frameTimes.slice(), fps: () => G.fps,
    reloadCareer() { G.career = new C.Career(load(KEY.career), (d) => save(KEY.career, d)); },
  };
  window.__drift = api;
  window.__game = api;
  boot();
})();
