/* Horizon Drift - звук целиком синтезом WebAudio: мотор по оборотам, визг шин, шорох гравия,
   ветер, удары, переключения, нитро, сигналы старта и музыка (три зацикленные темы).
   Громкость: музыка, эффекты и мотор - отдельными шинами. */
(function () {
  'use strict';
  const A = { ctx: null, ready: false, vol: { music: 0.5, sfx: 0.8, engine: 0.7 }, song: null, raceOn: false };
  window.DriftAudio = A;

  A.init = function () {
    if (A.ctx) { if (A.ctx.state === 'suspended' && !document.hidden && !A.hiddenSuspend) A.ctx.resume().catch(() => {}); return A.ctx; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    let ctx;
    try { ctx = new AC(); } catch (e) { return null; }
    A.ctx = ctx;
    A.master = ctx.createGain(); A.master.gain.value = 0.9;
    const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -14; comp.ratio.value = 4;
    A.master.connect(comp); comp.connect(ctx.destination);
    A.musicBus = ctx.createGain(); A.sfxBus = ctx.createGain(); A.engineBus = ctx.createGain();
    A.raceBus = ctx.createGain();      // мотор и шины заезда: гасится на паузе
    A.musicBus.connect(A.master); A.sfxBus.connect(A.master); A.engineBus.connect(A.raceBus); A.raceBus.connect(A.master);
    A.raceBus.gain.value = 0;
    A.applyVolumes();
    // белый шум для шин, ударов, ветра
    const len = ctx.sampleRate * 2, buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    let seed = 12345;
    for (let i = 0; i < len; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; d[i] = seed / 0x3fffffff - 1; }
    A.noise = buf;
    buildEngine(); buildLoops();
    A.ready = true;
    A.scheduler = setInterval(schedule, 25);
    return ctx;
  };

  A.applyVolumes = function (s) {
    if (s) A.vol = { music: s.musicVol, sfx: s.sfxVol, engine: s.engineVol };
    if (!A.ctx) return;
    const t = A.ctx.currentTime;
    A.musicBus.gain.setValueAtTime(A.vol.music, t);
    A.sfxBus.gain.setValueAtTime(A.vol.sfx, t);
    A.engineBus.gain.setValueAtTime(A.vol.engine, t);
    // значение сразу, без ожидания звукового потока (и для проверок)
    A.musicBus.gain.value = A.vol.music; A.sfxBus.gain.value = A.vol.sfx; A.engineBus.gain.value = A.vol.engine;
  };

  function buildEngine() {
    const ctx = A.ctx;
    const e = {};
    e.o1 = ctx.createOscillator(); e.o1.type = 'sawtooth';
    e.o2 = ctx.createOscillator(); e.o2.type = 'square';
    e.o3 = ctx.createOscillator(); e.o3.type = 'sawtooth';
    e.f = ctx.createBiquadFilter(); e.f.type = 'lowpass'; e.f.Q.value = 2;
    e.g = ctx.createGain(); e.g.gain.value = 0;
    const g2 = ctx.createGain(); g2.gain.value = 0.5; const g3 = ctx.createGain(); g3.gain.value = 0.35;
    e.o1.connect(e.f); e.o2.connect(g2); g2.connect(e.f); e.o3.connect(g3); g3.connect(e.f);
    e.f.connect(e.g); e.g.connect(A.engineBus);
    e.o1.start(); e.o2.start(); e.o3.start();
    // соперник поблизости - один голос на всех
    e.ai = ctx.createOscillator(); e.ai.type = 'sawtooth'; e.aif = ctx.createBiquadFilter(); e.aif.type = 'lowpass'; e.aif.frequency.value = 700;
    e.aig = ctx.createGain(); e.aig.gain.value = 0;
    e.ai.connect(e.aif); e.aif.connect(e.aig); e.aig.connect(A.engineBus); e.ai.start();
    A.eng = e;
  }
  function noiseLoop(type, freq, q) {
    const ctx = A.ctx, src = ctx.createBufferSource(); src.buffer = A.noise; src.loop = true;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q || 1;
    const g = ctx.createGain(); g.gain.value = 0;
    src.connect(f); f.connect(g); g.connect(A.raceBus); src.start();
    return { src, f, g };
  }
  function buildLoops() {
    A.screech = noiseLoop('bandpass', 1900, 4);
    A.rumble = noiseLoop('lowpass', 380, 0.8);
    A.wind = noiseLoop('highpass', 1200, 0.5);
    A.nitro = noiseLoop('bandpass', 700, 0.7);
  }
  const ramp = (p, v, t) => { const now = A.ctx.currentTime; p.cancelScheduledValues(now); p.setTargetAtTime(v, now, t || 0.05); };

  // Звук заезда за кадр: обороты, газ, занос, покрытие, скорость, нитро, ближний соперник.
  A.updateRace = function (car, near, paused) {
    if (!A.ready) return;
    const e = A.eng;
    if (!car || paused) { ramp(A.raceBus.gain, 0, 0.05); return; }
    ramp(A.raceBus.gain, 1, 0.1);
    const rpm = car.rpm || 900, thr = car.inp ? car.inp.thr : 0;
    const f0 = rpm / 60 * 2;              // 4 цилиндра: 2 вспышки за оборот
    ramp(e.o1.frequency, f0, 0.02); ramp(e.o2.frequency, f0 * 0.5, 0.02); ramp(e.o3.frequency, f0 * 1.51, 0.02);
    ramp(e.f.frequency, 300 + rpm * 0.28 + thr * 900, 0.03);
    ramp(e.g.gain, 0.09 + thr * 0.1 + (car.shiftT > 0 ? -0.05 : 0), 0.03);
    const skid = Math.min(1, Math.max(car.skidR || 0, car.skidF || 0));
    const loose = car.surf !== 'asphalt' || car.onRunoff;
    ramp(A.screech.g.gain, !loose && car.speed > 4 ? skid * 0.22 : 0, 0.04);
    ramp(A.screech.f.frequency, 1500 + car.speed * 12, 0.1);
    ramp(A.rumble.g.gain, loose ? Math.min(0.3, car.speed / 60 * 0.3 + skid * 0.1) : Math.min(0.06, car.speed / 80 * 0.06), 0.08);
    ramp(A.wind.g.gain, Math.min(0.12, (car.speed / 90) * (car.speed / 90) * 0.12), 0.2);
    ramp(A.nitro.g.gain, car.nitroOn ? 0.18 : 0, 0.06);
    if (near) {
      ramp(e.ai.frequency, (near.car.rpm || 900) / 60 * 2, 0.05);
      ramp(e.aig.gain, Math.max(0, 0.06 * (1 - near.dist / 45)), 0.1);
    } else ramp(e.aig.gain, 0, 0.1);
  };
  A.silenceRace = function () { if (A.ready) ramp(A.raceBus.gain, 0, 0.03); };

  // Короткие звуки
  function burst(dur, type, freq, gain, bus) {
    const ctx = A.ctx, t = ctx.currentTime;
    const src = ctx.createBufferSource(); src.buffer = A.noise;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq;
    const g = ctx.createGain(); g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f); f.connect(g); g.connect(bus || A.sfxBus); src.start(t, Math.random() * 1.5); src.stop(t + dur + 0.05);
  }
  function tone(freq, dur, type, gain, when, bus, slideTo) {
    const ctx = A.ctx, t = ctx.currentTime + (when || 0);
    const o = ctx.createOscillator(); o.type = type || 'square'; o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(bus || A.sfxBus); o.start(t); o.stop(t + dur + 0.05);
  }
  A.play = function (name, v) {
    if (!A.ready || A.ctx.state !== 'running') return;
    switch (name) {
      case 'hit': burst(0.35, 'lowpass', 900, Math.min(0.9, 0.15 + (v || 5) * 0.05)); tone(70, 0.25, 'sine', Math.min(0.8, 0.2 + (v || 5) * 0.04), 0, null, 40); break;
      case 'scrape': burst(0.25, 'bandpass', 2500, 0.15); break;
      case 'shift': burst(0.12, 'highpass', 2500, 0.08); break;
      case 'count': tone(620, 0.25, 'square', 0.18); break;
      case 'go': tone(930, 0.6, 'square', 0.22); break;
      case 'cp': tone(880, 0.12, 'triangle', 0.2); tone(1320, 0.18, 'triangle', 0.2, 0.08); break;
      case 'lap': [660, 880, 1100].forEach((f, i) => tone(f, 0.18, 'triangle', 0.2, i * 0.09)); break;
      case 'bank': tone(990, 0.12, 'sine', 0.2); tone(1480, 0.2, 'sine', 0.18, 0.07); break;
      case 'lost': tone(300, 0.35, 'sawtooth', 0.12, 0, null, 120); break;
      case 'miss': tone(220, 0.4, 'square', 0.14); break;
      case 'click': tone(1200, 0.05, 'triangle', 0.08); break;
      case 'buy': [784, 988, 1175, 1568].forEach((f, i) => tone(f, 0.14, 'triangle', 0.16, i * 0.06)); break;
      case 'medal': [523, 659, 784, 1047, 784, 1047].forEach((f, i) => tone(f, 0.22, 'square', 0.12, i * 0.12)); break;
      case 'elim': tone(440, 0.3, 'sawtooth', 0.14, 0, null, 220); break;
      default: break;
    }
  };

  // ---------- музыка: секвенсор 16-х долей с опережением ----------
  const N = (n) => 440 * Math.pow(2, (n - 69) / 12);
  const SONGS = {
    menu: { bpm: 96, chords: [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]], bass: [45, 41, 36, 43],
      drums: { k: [1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0], s: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0], h: [0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0] },
      arp: [0, 1, 2, 1, 0, 2, 1, 2, 0, 1, 2, 1, 0, 2, 1, 2], arpOct: 12, lead: null, pad: true },
    race: { bpm: 126, chords: [[52, 55, 59], [48, 52, 55], [55, 59, 62], [50, 54, 57]], bass: [40, 36, 43, 38],
      drums: { k: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], s: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1], h: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1] },
      bassPat: [1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1], arp: [0, 2, 1, 2, 0, 2, 1, 2, 0, 2, 1, 2, 0, 2, 1, 2], arpOct: 24,
      lead: [[76, 4], [74, 2], [71, 2], [72, 4], [71, 4], [74, 4], [76, 2], [79, 2], [78, 8]], pad: false },
    victory: { bpm: 112, chords: [[60, 64, 67], [55, 59, 62], [57, 60, 64], [53, 57, 60]], bass: [48, 43, 45, 41],
      drums: { k: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], s: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0], h: [0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1] },
      bassPat: [1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 0, 0, 1, 0], arp: [0, 1, 2, 1, 0, 1, 2, 1, 0, 1, 2, 1, 0, 1, 2, 1], arpOct: 24,
      lead: [[72, 2], [76, 2], [79, 4], [77, 2], [76, 2], [74, 4], [72, 2], [74, 2], [76, 4], [72, 8]], pad: true },
  };
  const seq = { step: 0, next: 0, leadIdx: 0, leadLeft: 0 };
  A.music = function (name) {
    if (A.song === name) return;
    A.song = name;
    if (!A.ctx) return;
    seq.step = 0; seq.next = A.ctx.currentTime + 0.1; seq.leadIdx = 0; seq.leadLeft = 0;
  };
  function drum(kind, t) {
    const ctx = A.ctx, bus = A.musicBus;
    if (kind === 'k') {
      const o = ctx.createOscillator(), g = ctx.createGain(); o.type = 'sine';
      o.frequency.setValueAtTime(140, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.14);
      g.gain.setValueAtTime(0.55, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.28);
      o.connect(g); g.connect(bus); o.start(t); o.stop(t + 0.3);
    } else {
      const src = ctx.createBufferSource(); src.buffer = A.noise;
      const f = ctx.createBiquadFilter(); f.type = kind === 's' ? 'bandpass' : 'highpass'; f.frequency.value = kind === 's' ? 1800 : 7000;
      const g = ctx.createGain(), dur = kind === 's' ? 0.16 : 0.04;
      g.gain.setValueAtTime(kind === 's' ? 0.3 : 0.08, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      src.connect(f); f.connect(g); g.connect(bus); src.start(t, Math.random()); src.stop(t + dur + 0.02);
    }
  }
  function note(freq, t, dur, type, gain, cutoff) {
    const ctx = A.ctx, o = ctx.createOscillator(), g = ctx.createGain(), f = ctx.createBiquadFilter();
    o.type = type; o.frequency.value = freq; f.type = 'lowpass'; f.frequency.value = cutoff || 2400;
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + 0.012); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(f); f.connect(g); g.connect(A.musicBus); o.start(t); o.stop(t + dur + 0.03);
  }
  function schedule() {
    const ctx = A.ctx;
    if (!ctx || ctx.state !== 'running' || !A.song || A.vol.music <= 0.001) { if (ctx) seq.next = Math.max(seq.next, ctx.currentTime + 0.05); return; }
    const S = SONGS[A.song], dt16 = 60 / S.bpm / 4;
    if (seq.next < ctx.currentTime - 0.2) seq.next = ctx.currentTime + 0.05;
    while (seq.next < ctx.currentTime + 0.14) {
      const st = seq.step % 16, bar = Math.floor(seq.step / 16) % S.chords.length, t = seq.next;
      const ch = S.chords[bar];
      if (S.drums.k[st]) drum('k', t);
      if (S.drums.s[st]) drum('s', t);
      if (S.drums.h[st]) drum('h', t);
      if (S.bassPat ? S.bassPat[st] : st % 4 === 0) note(N(S.bass[bar]), t, dt16 * (S.bassPat ? 0.9 : 3.5), 'sawtooth', 0.16, 500);
      note(N(ch[S.arp[st]] + S.arpOct - 12), t, dt16 * 0.9, 'triangle', 0.07, 3000);
      if (S.pad && st === 0) for (const n of ch) note(N(n), t, dt16 * 15, 'sawtooth', 0.035, 900);
      if (S.lead && bar % 2 === 1) {
        if (seq.leadLeft <= 0) { const L = S.lead[seq.leadIdx % S.lead.length]; seq.leadIdx++; seq.leadLeft = L[1]; note(N(L[0]), t, dt16 * L[1] * 0.95, 'square', 0.06, 2600); }
        seq.leadLeft--;
      }
      seq.step++; seq.next += dt16;
    }
  }

  // Вкладка скрыта - звук выключается целиком; вернулись - звук идёт снова (игра остаётся на паузе).
  A.suspend = function () { A.hiddenSuspend = true; if (A.ctx && A.ctx.state === 'running') A.ctx.suspend().catch(() => {}); };
  A.resume = function () { A.hiddenSuspend = false; if (A.ctx && A.ctx.state === 'suspended') A.ctx.resume().catch(() => {}); };
})();
