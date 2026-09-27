/* Horizon Drift - рисование открытого мира: потоковая загрузка кусков 256x256 м с тремя уровнями
   детализации (вблизи всё, дальше проще, ещё дальше - общий грубый рельеф и туман), дороги с
   перекрёстками и тротуарами, мосты, тоннели в горе с порталами, фонари, декор инстансами,
   точки мира, время суток и погода, фары, машины, камера и фото-режим.
   Земля для физики считается функцией (DriftWorld), а не по этой сетке: провалиться нельзя.
   Все шейдеры собираются при входе в мир (прогрев), куски строятся по частям в пределах бюджета кадра. */
(function () {
  'use strict';
  const D = window.DriftData, C = window.DriftCore, R = window.DriftRender, WD = window.DriftWorld;
  const W = { world: null };
  window.DriftWorldRender = W;
  const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const col = (h) => new THREE.Color(h);
  const COVER = 9.5;                       // гора над тоннелем не ниже этого над полотном (как в world.js)

  // ---------- время суток: цвета считаются в заранее созданные объекты, без мусора в кадре ----------
  const TOD = [
    [0, '#05060f', '#141630', '#0b0c1c', '#8fa2ff', 0.12, 0.2],
    [5, '#24305a', '#e0906a', '#6a5a6a', '#ffb080', 0.35, 0.35],
    [7.5, '#4a8fd8', '#cfe6f7', '#bcd6ea', '#fff0d8', 1.05, 0.7],
    [13, '#3f86d8', '#d8ecfa', '#c9e0f2', '#fff6e8', 1.3, 0.8],
    [17.5, '#3b5a9a', '#ffc690', '#e0b89a', '#ffc080', 0.9, 0.6],
    [20, '#1a1f45', '#c86a5a', '#4a3040', '#ff9060', 0.3, 0.32],
    [22, '#05060f', '#141630', '#0b0c1c', '#8fa2ff', 0.12, 0.2],
    [24, '#05060f', '#141630', '#0b0c1c', '#8fa2ff', 0.12, 0.2],
  ].map((r) => [r[0], col(r[1]), col(r[2]), col(r[3]), col(r[4]), r[5], r[6]]);
  const TT = { top: new THREE.Color(), hor: new THREE.Color(), fog: new THREE.Color(), sun: new THREE.Color(), sunI: 0, hemi: 0, night: false, dark: 0 };
  function todAt(h, out) {
    out = out || TT;
    let i = 0; while (i < TOD.length - 2 && TOD[i + 1][0] <= h) i++;
    const a = TOD[i], b = TOD[i + 1], t = (h - a[0]) / (b[0] - a[0]);
    out.top.copy(a[1]).lerp(b[1], t); out.hor.copy(a[2]).lerp(b[2], t); out.fog.copy(a[3]).lerp(b[3], t); out.sun.copy(a[4]).lerp(b[4], t);
    out.sunI = a[5] + (b[5] - a[5]) * t; out.hemi = a[6] + (b[6] - a[6]) * t; out.night = h < 5.5 || h > 20.5;
    out.dark = 1 - smooth(0.25, 0.9, out.sunI);             // 1 - ночь, 0 - день; сумерки между
    return out;
  }
  W.todAt = (h) => todAt(h, { top: new THREE.Color(), hor: new THREE.Color(), fog: new THREE.Color(), sun: new THREE.Color() });
  const tmpC1 = new THREE.Color(), tmpC2 = new THREE.Color(), tmpV = new THREE.Vector3(), gq = {};

  // ---------- текстуры света ----------
  function glowTex(kind) {
    return R._.canvasTex(128, 128, (g, w) => {
      if (kind === 'cone') {
        // пятно фар: ярко у машины (внизу текстуры), к дальнему краю и к бокам гаснет
        const img = g.createImageData(w, w);
        for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) {
          const u = x / (w - 1) * 2 - 1, v = 1 - y / (w - 1), far = 1 - v, spread = 0.3 + 0.7 * far;   // v=1 - у машины, v=0 - дальний край
          const side = Math.max(0, 1 - Math.pow(Math.abs(u) / spread, 2)), along = Math.pow(v, 0.7) * smooth(0, 0.08, far);
          const a = Math.min(1, side * along * 1.3), k = (y * w + x) * 4;
          img.data[k] = 255; img.data[k + 1] = 238; img.data[k + 2] = 205; img.data[k + 3] = a * 255;
        }
        g.putImageData(img, 0, 0);
      } else {
        const gr = g.createRadialGradient(w / 2, w / 2, 2, w / 2, w / 2, w / 2);
        gr.addColorStop(0, 'rgba(255,226,160,0.95)'); gr.addColorStop(0.45, 'rgba(255,214,140,0.45)'); gr.addColorStop(1, 'rgba(255,214,140,0)');
        g.fillStyle = gr; g.fillRect(0, 0, w, w);
      }
    });
  }
  function labelTex(text, color, wide) {
    const W0 = wide ? 1024 : 512;
    return R._.canvasTex(W0, 128, (g, w, h) => {
      g.fillStyle = 'rgba(10,9,18,0.86)'; g.fillRect(0, 0, w, h); g.fillStyle = color; g.fillRect(0, h - 10, w, 10);
      let fs = 50; g.font = `bold ${fs}px Bahnschrift, sans-serif`;
      while (fs > 18 && g.measureText(text).width > w - 36) { fs -= 2; g.font = `bold ${fs}px Bahnschrift, sans-serif`; }   // текст всегда влезает
      g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(text, w / 2, h / 2 - 4);
    });
  }
  W.labelFits = function (text, wide) {
    const c = document.createElement('canvas').getContext('2d'); let fs = 50; c.font = `bold ${fs}px Bahnschrift, sans-serif`;
    while (fs > 18 && c.measureText(text).width > (wide ? 1024 : 512) - 36) { fs -= 2; c.font = `bold ${fs}px Bahnschrift, sans-serif`; }
    return c.measureText(text).width <= (wide ? 1024 : 512) - 36;
  };

  // ======================= СБОРКА =======================
  W.init = function (world, settings) {
    W.dispose();
    const M = world.M, _ = R._;
    W.world = world; W.M = M; W.settings = settings;
    const scene = new THREE.Scene();
    W.scene = scene;
    W.chunks = new Map(); W.built = 0; W.job = null; W.wantKey = ''; W.want = null; W.poolMeshes = new Set();
    W.carMeshes = new Map();
    W.cam = { x: 0, y: 0, z: 0, init: false, fov: 62, shake: 0 };
    W.photo = null; W.time = 0;
    // общие материалы и геометрии - живут, пока открыт мир
    const cap = _.capture(() => {
      const m = {};
      const detail = _.canvasTex(128, 128, (g, w) => { g.fillStyle = '#808080'; g.fillRect(0, 0, w, w); _.speckle(g, w, w, _.rngOf(9), 2500, ['#6a6a6a', '#959595', '#7a7a7a', '#8a8a8a'], 1, 4); }, true);
      m.terrain = new THREE.MeshLambertMaterial({ map: detail, vertexColors: true });
      m.road = {};
      for (const sf of ['asphalt', 'gravel', 'snow']) { const t = _.surfaceTex(sf); m.road[sf] = new THREE.MeshLambertMaterial({ map: t, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }); }
      // перекрёсток: асфальт без разметки поверх концов дорог
      const plain = _.canvasTex(256, 256, (g, w) => { g.fillStyle = '#2d2e32'; g.fillRect(0, 0, w, w); _.speckle(g, w, w, _.rngOf(21), 3000, ['#232428', '#393a3f', '#2a2b2f', '#44454a'], 1, 2.5); }, true);
      m.plain = new THREE.MeshLambertMaterial({ map: plain, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
      m.sidewalk = new THREE.MeshLambertMaterial({ color: 0xa9abb2, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
      m.concrete = new THREE.MeshLambertMaterial({ color: 0x9a9ca2 });
      m.rail = new THREE.MeshLambertMaterial({ map: _.wallTex('rail'), side: THREE.DoubleSide });
      m.tunnel = new THREE.MeshLambertMaterial({ color: 0x5a5c63, side: THREE.DoubleSide });
      m.tunnelLight = new THREE.MeshBasicMaterial({ color: 0xffe6a8 });
      m.rock = new THREE.MeshLambertMaterial({ map: detail, color: 0x857a6c, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
      m.lampHead = new THREE.MeshBasicMaterial({ color: 0x777777 });
      m.prop = new THREE.MeshLambertMaterial({ vertexColors: true });
      m.pool = new THREE.MeshBasicMaterial({ map: glowTex('round'), side: THREE.DoubleSide, transparent: true, depthWrite: false, blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneMinusDstColorFactor, blendDst: THREE.OneFactor, premultipliedAlpha: true, opacity: 0, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6 });
      // свет фар ложится «экраном»: тёмный асфальт светлеет, светлая разметка не выгорает в белое пятно
      m.beam = new THREE.MeshBasicMaterial({ map: glowTex('cone'), side: THREE.DoubleSide, transparent: true, depthWrite: false, blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneMinusDstColorFactor, blendDst: THREE.OneFactor, premultipliedAlpha: true, opacity: 0, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6 });
      const win = _.canvasTex(128, 128, (g, w) => {
        g.fillStyle = '#5f6776'; g.fillRect(0, 0, w, w);
        for (let y = 8; y < w; y += 32) for (let x = 8; x < w; x += 32) { g.fillStyle = _.rngOf(x * 31 + y)() < 0.55 ? '#ffd98a' : '#2a2e3a'; g.fillRect(x, y, 16, 20); }
      }, true);
      m.building = new THREE.MeshLambertMaterial({ map: win, emissiveMap: win, emissive: 0xffffff, emissiveIntensity: 0 });
      const cont = _.canvasTex(64, 64, (g, w) => { g.fillStyle = '#fff'; g.fillRect(0, 0, w, w); g.fillStyle = 'rgba(0,0,0,0.18)'; for (let x = 0; x < w; x += 6) g.fillRect(x, 0, 2, w); }, true);
      m.container = new THREE.MeshLambertMaterial({ map: cont });
      const geo = {};
      for (const t of ['tree', 'pine', 'snowpine', 'palm', 'cactus', 'rock']) geo[t] = _.PROPS[t]();
      geo.building = new THREE.BoxGeometry(1, 1, 1); geo.building.translate(0, 0.5, 0);
      geo.container = new THREE.BoxGeometry(2.5, 2.6, 6.1); geo.container.translate(0, 1.3, 0);
      geo.lampPole = _.mergeGeoms([{ geo: new THREE.CylinderGeometry(0.1, 0.14, 8, 5), color: '#3a3d44', matrix: _.M4(0, 4, 0) }, { geo: new THREE.BoxGeometry(0.12, 0.12, 2.2), color: '#3a3d44', matrix: _.M4(0, 7.9, 1.0) }]);
      geo.lampHead = new THREE.BoxGeometry(0.5, 0.18, 0.9);
      geo.pillar = new THREE.BoxGeometry(1.4, 1, 1.4); geo.pillar.translate(0, -0.5, 0);
      geo.box = new THREE.BoxGeometry(1, 1, 1);
      geo.pool = new THREE.PlaneGeometry(16, 16); geo.pool.rotateX(-Math.PI / 2);
      geo.disc = new THREE.CircleGeometry(1, 40); geo.disc.rotateX(-Math.PI / 2);
      return { m, geo };
    });
    W.mat = cap.r.m; W.geo = cap.r.geo; W.owned = cap.owned;
    // небо, свет, вода, дальний рельеф
    W.sky = new THREE.Mesh(new THREE.SphereGeometry(2600, 24, 12), new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { top: { value: col('#4a8fd8') }, bot: { value: col('#cfe6f7') } },
      vertexShader: 'varying vec3 p; void main(){ p = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: 'uniform vec3 top; uniform vec3 bot; varying vec3 p; void main(){ float h = normalize(p).y; gl_FragColor = vec4(mix(bot, top, smoothstep(-0.05, 0.5, h)), 1.0); }',
    }));
    W.sky.renderOrder = -10; scene.add(W.sky);
    const sp = [], r = R._.rngOf(5);
    for (let k = 0; k < 900; k++) { const a = r() * 6.283, e = 0.08 + r() * 1.3; sp.push(Math.cos(a) * Math.cos(e) * 2400, Math.sin(e) * 2400, Math.sin(a) * Math.cos(e) * 2400); }
    const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3));
    W.stars = new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xffffff, size: 2, sizeAttenuation: false, fog: false, transparent: true }));
    scene.add(W.stars);
    scene.fog = new THREE.Fog(0xc9e0f2, 300, 1300);
    scene.background = new THREE.Color();
    W.hemi = new THREE.HemisphereLight(0xcfe8ff, 0x5a4a3a, 0.7); scene.add(W.hemi);
    W.sun = new THREE.DirectionalLight(0xffffff, 1.2);
    const sc = W.sun.shadow.camera; sc.left = -70; sc.right = 70; sc.top = 70; sc.bottom = -70; sc.near = 10; sc.far = 500; W.sun.shadow.bias = -0.0007;
    scene.add(W.sun); scene.add(W.sun.target);
    // фара: высоко над машиной и вниз вперёд - свет падает на полотно под заметным углом
    W.headlight = new THREE.SpotLight(0xfff2d6, 0, 70, 0.6, 0.55, 1); scene.add(W.headlight); scene.add(W.headlight.target);
    const wtex = R._.canvasTex(128, 128, (g, w) => { g.fillStyle = '#1d5f8a'; g.fillRect(0, 0, w, w); R._.speckle(g, w, w, R._.rngOf(3), 700, ['rgba(255,255,255,0.22)', 'rgba(0,30,60,0.3)'], 1, 3); }, true);
    wtex.repeat.set(400, 400);
    W.water = new THREE.Mesh(new THREE.PlaneGeometry(20000, 20000).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ map: wtex, transparent: true, opacity: 0.9 }));
    W.water.position.y = WD.WATER; scene.add(W.water);
    W.far = farTerrain(M); scene.add(W.far);
    // пятно фар на дороге: сетка, которая каждый кадр ложится на землю перед машиной
    W.beam = beamMesh(); scene.add(W.beam);
    // осадки, частицы, следы
    W.rain = rainSystem(); scene.add(W.rain);
    const pc = R._.capture(() => ({ snow: R._.particleSystem(900), parts: R._.particleSystem({ low: 300, medium: 700, high: 1400 }[settings.particles] || 700), skids: R._.skidSystem(1600) }));
    W.snowP = pc.r.snow; W.parts = pc.r.parts; W.skids = pc.r.skids; W.owned.push(...pc.owned);
    scene.add(W.snowP.pts); scene.add(W.parts.pts); scene.add(W.skids.mesh);
    // точки мира
    W.markers = buildMarkers(M, world);
    scene.add(W.markers.group);
    W.applySettings(settings);
    W.stream(true);
    syncCars(0);
    warmUp();
    return W;
  };

  W.applySettings = function (s) {
    W.settings = s;
    if (!W.scene) return;
    const shadows = s.shadows && (D.QUALITY[s.quality] || D.QUALITY.high).shadowMap > 0;
    R.renderer.shadowMap.enabled = shadows;
    W.sun.castShadow = shadows;
    const sz = (D.QUALITY[s.quality] || D.QUALITY.high).shadowMap || 1024;
    if (W.sun.shadow.mapSize.x !== sz) { W.sun.shadow.mapSize.set(sz, sz); if (W.sun.shadow.map) { W.sun.shadow.map.dispose(); W.sun.shadow.map = null; } }
    const r0 = { near: 2, mid: 3, far: 4 }[s.drawDist] || 3;
    if (r0 !== W.radius) { W.radius = r0; W.wantKey = ''; }
    W.scene.traverse((o) => { if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => { m.needsUpdate = true; }); });
    if (W.warmed) warmUp();                     // другие тени - другие шейдеры: собрать их сразу
  };

  // Дальний рельеф - грубая сетка на всю карту. Там, где уже лежат куски, он не рисуется (круг вырезается
  // в шейдере), поэтому не просвечивает сквозь дорогу и склоны.
  function farTerrain(M) {
    const n = 110, size = M.half * 2 + 1200;
    const g = new THREE.PlaneGeometry(size, size, n, n); g.rotateX(-Math.PI / 2);
    const pos = g.attributes.position, cols = new Float32Array(pos.count * 3), c = [0, 0, 0];
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i), y = M.rawHeight(x, z) - 1.5;
      pos.setY(i, y);
      M.biomeColor(x, z, c); const k = y < 0.5 ? 0.8 : 1; cols[i * 3] = c[0] * k; cols[i * 3 + 1] = c[1] * k; cols[i * 3 + 2] = c[2] * k;
    }
    g.setAttribute('color', new THREE.BufferAttribute(cols, 3)); g.computeVertexNormals();
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    const uni = { farCenter: { value: new THREE.Vector2() }, farHole: { value: 0 } };
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.farCenter = uni.farCenter; sh.uniforms.farHole = uni.farHole;
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec2 vFarXZ;').replace('#include <project_vertex>', '#include <project_vertex>\nvFarXZ = (modelMatrix * vec4(transformed, 1.0)).xz;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec2 vFarXZ; uniform vec2 farCenter; uniform float farHole;')
        .replace('void main() {', 'void main() {\n  vec2 dFar = abs(vFarXZ - farCenter); if (max(dFar.x, dFar.y) < farHole) discard;');
    };
    mat.customProgramCacheKey = () => 'farTerrain';
    const mesh = new THREE.Mesh(g, mat); mesh.userData.uni = uni;
    return mesh;
  }
  function rainSystem() {
    const n = 1500, pos = new Float32Array(n * 6), r = R._.rngOf(17);
    for (let i = 0; i < n; i++) { const x = (r() - 0.5) * 120, y = r() * 60, z = (r() - 0.5) * 120; pos.set([x, y, z, x + 0.1, y - 1.2, z], i * 6); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xaec4dc, transparent: true, opacity: 0.45 }));
    l.frustumCulled = false; l.visible = false;
    return l;
  }
  const BEAM_NX = 7, BEAM_NZ = 13;
  function beamMesh() {
    const g = new THREE.PlaneGeometry(1, 1, BEAM_NX - 1, BEAM_NZ - 1);
    const m = new THREE.Mesh(g, W.mat.beam); m.frustumCulled = false; m.renderOrder = 3;
    return m;
  }
  function updateBeam(px, py, pz, h, strength) {
    const g = W.beam.geometry, pos = g.attributes.position, uv = g.attributes.uv, fx = Math.sin(h), fz = Math.cos(h), rx = -fz, rz = fx;
    W.beam.visible = strength > 0.01; W.mat.beam.opacity = strength;
    if (!W.beam.visible) return;
    for (let j = 0; j < BEAM_NZ; j++) {
      const t = j / (BEAM_NZ - 1), ahead = 2.5 + t * 46, half = 1.8 + t * 9;
      for (let i = 0; i < BEAM_NX; i++) {
        const u = i / (BEAM_NX - 1), side = (u * 2 - 1) * half, x = px + fx * ahead + rx * side, z = pz + fz * ahead + rz * side;
        const k = j * BEAM_NX + i;
        pos.setXYZ(k, x, W.M.groundAt(x, z, gq, py).y + 0.12, z); uv.setXY(k, u, 1 - t);
      }
    }
    pos.needsUpdate = true; uv.needsUpdate = true;
    g.computeBoundingSphere();
  }

  // ---------- точки мира: фестиваль, события, радары, зоны дрифта, рампы, щиты ----------
  function buildMarkers(M, world) {
    const cap = R._.capture(() => {
      const group = new THREE.Group(), boards = {}, anim = [];
      const boardTex = R._.canvasTex(256, 128, (c, w, h) => { const gr = c.createLinearGradient(0, 0, w, 0); gr.addColorStop(0, '#ff3c00'); gr.addColorStop(1, '#ffd23a'); c.fillStyle = gr; c.fillRect(0, 0, w, h); c.fillStyle = '#fff'; c.font = 'bold 44px Bahnschrift, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('HORIZON', w / 2, h / 2 - 16); c.font = 'bold 30px Bahnschrift, sans-serif'; c.fillText('ЩИТ', w / 2, h / 2 + 24); }, true);
      const boardMat = new THREE.MeshLambertMaterial({ map: boardTex }), legMat = new THREE.MeshLambertMaterial({ color: 0x2a2c33 }), legGeo = new THREE.BoxGeometry(0.15, 3, 0.15), plateGeo = new THREE.BoxGeometry(3.6, 1.8, 0.12);
      const S = world.save;
      const sign = (text, color, x, y, z, s) => {
        const m = new THREE.Mesh(new THREE.PlaneGeometry(8 * (s || 1), 2 * (s || 1)), new THREE.MeshBasicMaterial({ map: labelTex(text, color), side: THREE.DoubleSide, transparent: true, fog: false }));
        m.position.set(x, y, z); group.add(m); anim.push({ m, bill: true }); return m;
      };
      for (const p of M.points) {
        const y = M.groundAt(p.x, p.z).y;
        if (p.type === 'fest') {
          // площадка развёрнута к дороге: сцена, экран лицом к подъезду, шатры вокруг
          const fg = new THREE.Group(), toRoad = Math.atan2(M.X[p.i] - p.x, M.Z[p.i] - p.z);
          fg.position.set(p.x, y, p.z); fg.rotation.y = toRoad; group.add(fg); W.festGroup = fg;
          const mat = new THREE.MeshLambertMaterial({ color: 0xff5a1f }), mat2 = new THREE.MeshLambertMaterial({ color: 0x2a2c33 }), white = new THREE.MeshLambertMaterial({ color: 0xf4f4f4 });
          const pad = new THREE.Mesh(new THREE.CylinderGeometry(40, 40, 0.5, 40), new THREE.MeshLambertMaterial({ color: 0x6f7178 })); pad.position.y = -0.1; fg.add(pad);
          const stage = new THREE.Mesh(new THREE.BoxGeometry(26, 1.2, 14), mat2); stage.position.set(0, 0.6, -12); fg.add(stage);
          const scr = new THREE.Mesh(new THREE.PlaneGeometry(22, 5.5), new THREE.MeshBasicMaterial({ map: labelTex('HORIZON DRIFT · ФЕСТИВАЛЬ', '#ff5a1f', true) }));
          scr.position.set(0, 7.5, -17.8); fg.add(scr); W.festScreen = scr;
          const back = new THREE.Mesh(new THREE.PlaneGeometry(22, 5.5), mat2); back.rotation.y = Math.PI; back.position.set(0, 7.5, -17.9); fg.add(back);
          for (const sx of [-11.5, 11.5]) { const post = new THREE.Mesh(new THREE.BoxGeometry(0.5, 10.5, 0.5), mat2); post.position.set(sx, 5.2, -17.9); fg.add(post); }
          for (let k = 0; k < 8; k++) {
            const a = (k / 7 - 0.5) * Math.PI * 1.2 + Math.PI, tx = Math.sin(a) * 30, tz = Math.cos(a) * 30;
            const tent = new THREE.Mesh(new THREE.ConeGeometry(4.5, 5, 6), k % 2 ? mat : white); tent.position.set(tx, 2.5, tz); fg.add(tent);
            const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 12, 5), mat2); pole.position.set(tx, 6, tz); fg.add(pole);
            const flag = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 1.4), new THREE.MeshBasicMaterial({ color: [0xff5a1f, 0x19d3ff, 0xffb02e, 0x9a4dff][k % 4], side: THREE.DoubleSide }));
            flag.position.set(tx + 1.2, 11.2, tz); fg.add(flag); anim.push({ m: flag, flag: true, k });
          }
          sign('ФЕСТИВАЛЬ', '#ff5a1f', p.x, y + 15, p.z, 1.3);
        } else if (p.type === 'event') {
          const ring = new THREE.Mesh(new THREE.TorusGeometry(9, 0.35, 8, 40), new THREE.MeshBasicMaterial({ color: 0xff8a1f })); ring.rotation.x = Math.PI / 2; ring.position.set(p.x, y + 0.3, p.z); group.add(ring);
          const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 0.8, 40, 12, 1, true), new THREE.MeshBasicMaterial({ color: 0xff8a1f, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false, fog: false }));
          beam.position.set(p.x, y + 20, p.z); group.add(beam); anim.push({ m: beam, pulse: true });
          sign('СОБЫТИЯ · ' + p.name.toUpperCase(), '#ff8a1f', p.x, y + 8, p.z);
        } else if (p.type === 'radar') {
          const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.15, 6, 6), new THREE.MeshLambertMaterial({ color: 0x3a3d44 })); pole.position.set(p.x, y + 3, p.z); group.add(pole);
          const cam = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.6, 1.2), new THREE.MeshLambertMaterial({ color: 0xffb02e })); cam.position.set(p.x, y + 6.2, p.z); group.add(cam);
          sign('РАДАР', '#19d3ff', p.x, y + 8.5, p.z, 0.6);
        } else if (p.type === 'drift') {
          for (const i of [p.i0, p.i1]) {
            const e = M.edges[M.E[i]], h = Math.atan2(M.TX[i], M.TZ[i]);
            const arch = new THREE.Mesh(new THREE.TorusGeometry(e.hw + 1, 0.3, 8, 24, Math.PI), new THREE.MeshBasicMaterial({ color: 0xff5ad8 })); arch.position.set(M.X[i], M.Y[i], M.Z[i]); arch.rotation.y = h; group.add(arch);
          }
          sign('ЗОНА ДРИФТА', '#ff5ad8', M.X[p.i0], M.Y[p.i0] + 9, M.Z[p.i0], 0.8);
        } else if (p.type === 'jump') {
          const rp = p.ramp, shape = new THREE.Shape();
          shape.moveTo(0, 0); shape.lineTo(rp.len, 0); shape.lineTo(rp.len, rp.h); shape.lineTo(0, 0);
          const g = new THREE.ExtrudeGeometry(shape, { depth: rp.w, bevelEnabled: false }); g.translate(0, 0, -rp.w / 2); g.rotateY(-Math.PI / 2);
          const tex = R._.canvasTex(64, 64, (c, w) => { for (let k = 0; k < 8; k++) { c.fillStyle = k % 2 ? '#ffb02e' : '#1b1b1d'; c.fillRect(0, k * 8, w, 8); } }, true);
          const ramp = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ map: tex })); ramp.position.set(rp.x, rp.y0, rp.z); ramp.rotation.y = Math.atan2(rp.tx, rp.tz); group.add(ramp);
          sign('РАМПА', '#ffb02e', rp.x, rp.y0 + 7, rp.z, 0.6);
        } else if (p.type === 'board') {
          const g = new THREE.Group(); g.position.set(p.x, y, p.z); g.rotation.y = p.rot;
          for (const sx of [-1.4, 1.4]) { const leg = new THREE.Mesh(legGeo, legMat); leg.position.set(sx, 1.5, 0); g.add(leg); }
          const plate = new THREE.Mesh(plateGeo, boardMat); plate.position.y = 3; g.add(plate);
          group.add(g); boards[p.id] = g;
          if (S.boards[p.id]) g.visible = false;
        }
      }
      return { group, boards, anim };
    });
    const mk = cap.r; W.owned.push(...cap.owned);
    return mk;
  }

  // ---------- прогрев: все виды кусков, декора и материалов рисуются один раз при входе ----------
  // Шейдеры (и для теней тоже) собираются здесь, а не посреди езды, когда кусок впервые попал в кадр.
  function warmUp() {
    const g = new THREE.Group(), made = [], M = W.M, p = W.world.player;
    const mesh = (geo, mat, o) => { const m = new THREE.Mesh(geo, mat); Object.assign(m, o || {}); g.add(m); return m; };
    const inst = (geo, mat, o) => {
      const im = new THREE.InstancedMesh(geo, mat, 2); im.setMatrixAt(0, new THREE.Matrix4()); im.setMatrixAt(1, new THREE.Matrix4().makeTranslation(3, 0, 0));
      if (o && o.color) { im.setColorAt(0, new THREE.Color(0xffffff)); im.setColorAt(1, new THREE.Color(0x888888)); }
      Object.assign(im, o || {}); delete im.color; g.add(im); made.push(im); return im;
    };
    const plane = new THREE.PlaneGeometry(4, 4); made.push(plane);
    for (const shadow of [false, true]) {
      for (const t of ['tree', 'pine', 'snowpine', 'palm', 'cactus', 'rock']) inst(W.geo[t], W.mat.prop, { castShadow: shadow });
      inst(W.geo.building, W.mat.building, { castShadow: shadow, color: true });
      inst(W.geo.container, W.mat.container, { castShadow: shadow, color: true });
      for (const rs of [false, true]) {
        mesh(plane, W.mat.terrain, { receiveShadow: rs, castShadow: shadow });
        for (const m of [...Object.values(W.mat.road), W.mat.plain, W.mat.sidewalk]) mesh(plane, m, { receiveShadow: rs, castShadow: shadow });
      }
    }
    inst(W.geo.lampPole, W.mat.prop, {}); inst(W.geo.lampHead, W.mat.lampHead, {}); inst(W.geo.pool, W.mat.pool, {});
    for (const rs of [false, true]) mesh(W.geo.disc, W.mat.plain, { receiveShadow: rs });
    for (const m of [W.mat.concrete, W.mat.rail, W.mat.tunnel, W.mat.tunnelLight, W.mat.rock]) { mesh(W.geo.box, m); mesh(W.geo.pillar, m); }
    // всё - перед камерой, чтобы прошло отсечение
    const fx = Math.sin(p.h), fz = Math.cos(p.h);
    g.position.set(p.x + fx * 12, p.y + 1, p.z + fz * 12);
    g.traverse((o) => { o.frustumCulled = false; });
    const vis = [W.rain.visible, W.beam.visible, W.far.visible];
    W.rain.visible = true; W.beam.visible = true; W.skids.mesh.geometry.setDrawRange(0, 6);
    W.mat.pool.opacity = 0.5; W.mat.beam.opacity = 0.5; W.headlight.intensity = 1;
    W.scene.add(g);
    // точки мира (щиты, знаки, рампы, фестиваль) грузятся в видеокарту сразу, а не когда впервые попадут в кадр
    const culled = []; W.markers.group.traverse((o) => { if (o.frustumCulled) { culled.push(o); o.frustumCulled = false; } });
    const cam = R.camera; cam.position.set(p.x - fx * 6, p.y + 3, p.z - fz * 6); cam.lookAt(g.position); cam.near = 0.3; cam.far = 2000; cam.updateProjectionMatrix();
    R.renderer.compile(W.scene, cam);
    const rt = new THREE.WebGLRenderTarget(64, 64);
    R.renderer.setRenderTarget(rt); R.renderer.render(W.scene, cam); R.renderer.setRenderTarget(null);
    rt.dispose();
    W.scene.remove(g);
    for (const o of culled) o.frustumCulled = true;
    for (const o of made) o.dispose();
    W.rain.visible = vis[0]; W.beam.visible = vis[1]; W.skids.mesh.geometry.setDrawRange(0, W.skids.used * 6);
    W.warmed = true; W.warmPrograms = R.renderer.info.programs.length;
  }

  // ======================= КУСКИ =======================
  const key = (cx, cz) => cx + ',' + cz;
  const nodeInfo = new Map();                 // радиус площадки перекрёстка у каждого узла
  function junctionR(M, nk) {
    const c = nodeInfo.get(M.id + nk); if (c !== undefined) return c;
    const nd = M.nodes[nk]; let hw = 0; for (const e of nd.edges) hw = Math.max(hw, M.edges[e].hw);
    const r = nd.edges.length >= 2 ? hw + 4.5 : 0; nodeInfo.set(M.id + nk, r); return r;
  }
  function inJunction(M, i) {
    const e = M.edges[M.E[i]];
    for (const nk of [e.a, e.b]) { const r = junctionR(M, nk); if (r && Math.hypot(M.nodes[nk].x - M.X[i], M.nodes[nk].z - M.Z[i]) < r - 0.5) return true; }
    return false;
  }
  const urbanCache = new Map();
  function urbanAt(M, i) {                    // тротуары - в городских областях
    const k = M.id + ':' + (i >> 4); let v = urbanCache.get(k);
    if (v === undefined) { v = M.regionAt(M.X[i], M.Z[i]).biome === 'concrete'; urbanCache.set(k, v); }
    return v;
  }

  // Кусок строится по частям (генератор): рельеф по полосам строк, дороги, декор. Между частями - другие дела кадра.
  function* buildChunkGen(cx, cz, lod) {
    const M = W.M, CH = WD.CHUNK, x0 = cx * CH, z0 = cz * CH, group = new THREE.Group(), geos = [], inst = [];
    const add = (geo, mat) => { const m = new THREE.Mesh(geo, mat); geos.push(geo); group.add(m); return m; };
    // рельеф с «юбкой» по краю, чтобы между кусками разной детальности не было щелей
    const seg = [40, 18, 8][lod], n = seg + 3, pos = new Float32Array(n * n * 3), colr = new Float32Array(n * n * 3), uv = new Float32Array(n * n * 2), cut = new Uint8Array(n * n);
    const c = [0, 0, 0], q = {};
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const ii = Math.min(seg, Math.max(0, i - 1)), jj = Math.min(seg, Math.max(0, j - 1)), edge = i === 0 || j === 0 || i === n - 1 || j === n - 1;
        const x = x0 + ii / seg * CH, z = z0 + jj / seg * CH;
        let y;
        const road = M.nearestRoad(x, z, q);
        if (lod === 2) {
          y = M.rawHeight(x, z);
          if (road && road.tunnel) y = Math.max(y, road.y + COVER);
          else if (road && road.d < road.hw + 20 && !road.bridge) y = Math.min(y, road.y - 0.6);
        } else y = M.terrainHeight(x, z);
        // над тоннелем в сетке прорезь: её закрывает свод горы, и рельеф не лезет в стены
        if (road && road.tunnel && road.d < road.hw + 2.5) cut[j * n + i] = 1;
        if (edge) y -= 5;
        const k = (j * n + i) * 3; pos[k] = x; pos[k + 1] = y; pos[k + 2] = z;
        M.biomeColor(x, z, c);
        if (y < WD.WATER + 1.2) { c[0] = c[0] * 0.4 + 0.52; c[1] = c[1] * 0.4 + 0.48; c[2] = c[2] * 0.4 + 0.36; }
        if (y > 95) { const t = smooth(95, 120, y); c[0] += (0.94 - c[0]) * t; c[1] += (0.96 - c[1]) * t; c[2] += (0.98 - c[2]) * t; }
        const v = 0.9 + ((i * 7 + j * 13) % 10) * 0.02;
        colr[k] = c[0] * v; colr[k + 1] = c[1] * v; colr[k + 2] = c[2] * v;
        uv[(j * n + i) * 2] = x / 24; uv[(j * n + i) * 2 + 1] = z / 24;
      }
      if (lod === 0 && j % 11 === 10) yield;
    }
    const idx = [];
    for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) {
      const a = j * n + i, b = a + 1, cc = a + n, d = cc + 1;
      if (cut[a] || cut[b] || cut[cc] || cut[d]) continue;
      idx.push(a, cc, b, b, cc, d);
    }
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.BufferAttribute(pos, 3)); tg.setAttribute('color', new THREE.BufferAttribute(colr, 3)); tg.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    tg.setIndex(idx); tg.computeVertexNormals();
    const nr = tg.attributes.normal;
    for (let k = 0; k < nr.count; k++) { const s = 1 - nr.getY(k); if (s > 0.18) { const t = smooth(0.18, 0.5, s); colr[k * 3] += (0.5 - colr[k * 3]) * t; colr[k * 3 + 1] += (0.47 - colr[k * 3 + 1]) * t; colr[k * 3 + 2] += (0.43 - colr[k * 3 + 2]) * t; } }
    const tm = add(tg, W.mat.terrain); tm.receiveShadow = lod === 0;
    yield;
    // дороги: полосы по выборкам, попавшим в кусок; концы у перекрёстков закрывает площадка
    const segs = M.roadSamplesIn(cx, cz, 0);
    const runs = [];
    for (const i of segs) { const last = runs[runs.length - 1]; if (last && last[1] === i && M.E[i] === M.E[last[0]]) last[1] = i + 1; else runs.push([i, i + 1]); }
    const byMat = {}, walk = { pos: [], idx: [] };
    const lamps = [];
    const strip = (P, list, d0, d1, lift, vScale) => {
      if (list.length < 2) return;
      const base = P.pos.length / 3;
      list.forEach((i, k) => {
        const nx = -M.TZ[i], nz = M.TX[i], y = M.Y[i] + lift;
        P.pos.push(M.X[i] + nx * d0, y, M.Z[i] + nz * d0, M.X[i] + nx * d1, y, M.Z[i] + nz * d1);
        if (P.uv) P.uv.push(0, M.S[i] / vScale, 1, M.S[i] / vScale);
        if (k > 0) { const b = base + (k - 1) * 2; P.idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2); }
      });
    };
    for (const [a, b] of runs) {
      const e = M.edges[M.E[a]], hw = e.hw, step = lod === 2 ? 4 : lod === 1 ? 2 : 1, lift = lod === 0 ? 0.06 : 0.25;
      const list = []; for (let i = a; i < b; i += step) list.push(i); list.push(b);
      // покрытие по точкам: полоса режется там, где меняется покрытие или начинается перекрёсток
      let cur = [], curSf = null;
      const flush = () => { if (cur.length > 1) { const P = byMat[curSf] = byMat[curSf] || { pos: [], uv: [], idx: [] }; strip(P, cur, -hw, hw, lift, 12); } cur = []; };
      for (const i of list) {
        if (inJunction(M, i)) { flush(); continue; }
        const sf = M.SF[i];
        if (sf !== curSf && cur.length) { const last = cur[cur.length - 1]; flush(); cur.push(last); }
        curSf = sf; cur.push(i);
      }
      flush();
      // тротуары в городе
      if (lod < 2) {
        let wl = [];
        const wflush = () => { if (wl.length > 1) for (const sd of [-1, 1]) strip(walk, wl, sd * hw, sd * (hw + 3), lift + 0.12, 1); wl = []; };
        for (const i of list) { if (!inJunction(M, i) && !(M.FL[i] & 3) && urbanAt(M, i)) wl.push(i); else wflush(); }
        wflush();
      }
      // мост: ограждения и опоры; тоннель: стены, свод, свет, гора сверху и порталы
      if (lod < 2) {
        const bridge = list.filter((i) => M.FL[i] & 1), tunnel = list.filter((i) => M.FL[i] & 2);
        if (bridge.length > 1) {
          for (const sd of [-1, 1]) add(stripGeom(M, bridge, sd * (hw + 0.2), 0.05, 1.1, 'wall'), W.mat.rail);
          add(stripGeom(M, bridge, -hw - 0.3, -1.4, hw + 0.3, 'slab'), W.mat.concrete);
          if (lod === 0) for (let k = 0; k < bridge.length; k += Math.max(1, Math.round(26 / e.step / step))) {
            const i = bridge[k], ground = Math.max(M.RAW[i], WD.WATER - 6), hgt = M.Y[i] - 1.4 - ground;
            if (hgt > 1) { const mm = new THREE.Mesh(W.geo.pillar, W.mat.concrete); mm.scale.set(1, hgt, 1); mm.position.set(M.X[i], M.Y[i] - 1.4, M.Z[i]); group.add(mm); }
          }
        }
        if (tunnel.length > 1) {
          for (const sd of [-1, 1]) add(stripGeom(M, tunnel, sd * (hw + 1), 0, 7, 'wall'), W.mat.tunnel);
          add(stripGeom(M, tunnel, -hw - 1.2, 7, hw + 1.2, 'slab'), W.mat.tunnel);
          add(stripGeom(M, tunnel, -hw - 1.1, 0.0, hw + 1.1, 'slab'), W.mat.tunnel);          // пол тоннеля от стены до стены
          add(stripGeom(M, tunnel, -0.3, 6.9, 0.3, 'slab'), W.mat.tunnelLight);
          add(capGeom(M, tunnel, hw + 7.5), W.mat.rock);
          for (const i of tunnel) {
            const first = !(M.FL[i - 1] & 2), last = !(M.FL[i + 1] & 2);
            if ((first && i > e.i0) || (last && i < e.i1)) portal(M, i, hw, group);
          }
        }
      }
      if (e.T.lamps && lod < 2) for (let i = a; i < b; i++) if (M.S[i] % 60 < e.step && !(M.FL[i] & 2) && !inJunction(M, i)) lamps.push([i, (Math.floor(M.S[i] / 60) % 2) ? 1 : -1, hw]);
    }
    for (const sf in byMat) {
      const P = byMat[sf], g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(P.pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(P.uv, 2)); g.setIndex(P.idx); g.computeVertexNormals();
      const m = add(g, W.mat.road[sf] || W.mat.road.asphalt); m.receiveShadow = lod === 0;
    }
    if (walk.pos.length) {
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(walk.pos, 3)); g.setIndex(walk.idx); g.computeVertexNormals();
      const m = add(g, W.mat.sidewalk); m.receiveShadow = lod === 0;
    }
    // площадки перекрёстков - у узлов внутри куска
    for (const nk in M.nodes) {
      const nd = M.nodes[nk], r0 = junctionR(M, nk);
      if (!r0 || Math.floor(nd.x / CH) !== cx || Math.floor(nd.z / CH) !== cz) continue;
      const m = new THREE.Mesh(W.geo.disc, W.mat.plain); m.scale.set(r0 + 0.6, 1, r0 + 0.6); m.position.set(nd.x, nd.y + 0.08, nd.z); m.receiveShadow = lod === 0; group.add(m);
    }
    yield;
    // фонари и пятна света под ними
    if (lamps.length) {
      const poles = new THREE.InstancedMesh(W.geo.lampPole, W.mat.prop, lamps.length), heads = new THREE.InstancedMesh(W.geo.lampHead, W.mat.lampHead, lamps.length), pools = new THREE.InstancedMesh(W.geo.pool, W.mat.pool, lamps.length);
      const m = new THREE.Matrix4(), qq = new THREE.Quaternion(), e = new THREE.Euler(), v = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);
      lamps.forEach(([i, sd, hw], k) => {
        const nx = -M.TZ[i], nz = M.TX[i], x = M.X[i] + nx * sd * (hw + 0.8), z = M.Z[i] + nz * sd * (hw + 0.8);
        e.set(0, Math.atan2(-nx * sd, -nz * sd), 0); qq.setFromEuler(e);
        m.compose(v.set(x, M.Y[i], z), qq, one); poles.setMatrixAt(k, m);
        m.compose(v.set(x - nx * sd * 2, M.Y[i] + 7.8, z - nz * sd * 2), qq, one); heads.setMatrixAt(k, m);
        e.set(0, Math.atan2(M.TX[i], M.TZ[i]), 0); qq.setFromEuler(e);
        m.compose(v.set(x - nx * sd * 3, M.Y[i] + 0.1, z - nz * sd * 3), qq, one); pools.setMatrixAt(k, m);
      });
      pools.renderOrder = 2;
      group.add(poles); group.add(heads); group.add(pools); inst.push(poles, heads, pools); W.poolMeshes.add(pools);
    }
    // декор: общий список куска (тот же, что для столкновений)
    const decor = M.chunkDecor(cx, cz), byType = {};
    for (const d of decor) {
      if (lod === 2 && d.type !== 'building') continue;
      if (lod === 1 && d.type === 'rock') continue;
      (byType[d.type] = byType[d.type] || []).push(d);
    }
    const mm = new THREE.Matrix4(), q2 = new THREE.Quaternion(), ee = new THREE.Euler(), vv = new THREE.Vector3(), ss = new THREE.Vector3(), cc2 = new THREE.Color();
    for (const t in byType) {
      const L = byType[t];
      const mat = t === 'building' ? W.mat.building : t === 'container' ? W.mat.container : W.mat.prop;
      const im = new THREE.InstancedMesh(W.geo[t], mat, L.length);
      L.forEach((d, k) => {
        ee.set(0, d.rot, 0); q2.setFromEuler(ee); vv.set(d.x, d.y - 0.15, d.z);
        if (t === 'building') ss.set(d.w, d.h, d.d); else if (t === 'container') ss.set(1, d.h / 2.6, 1); else ss.set(d.s, d.s, d.s);
        mm.compose(vv, q2, ss); im.setMatrixAt(k, mm);
        if (t === 'container') { cc2.set(['#c8412e', '#2f6bb0', '#e0a02a', '#3a8a4a', '#8a8f96'][Math.floor(d.col * 5)]); im.setColorAt(k, cc2); }
        else if (t === 'building') { cc2.setHSL(0.58 + d.col * 0.1, 0.08, d.h > 45 ? 0.72 + d.col * 0.2 : 0.5 + d.col * 0.35); im.setColorAt(k, cc2); }
      });
      im.castShadow = lod === 0 && t !== 'rock'; im.receiveShadow = false;
      group.add(im); inst.push(im);
    }
    return { key: key(cx, cz), cx, cz, lod, group, geos, inst };
  }
  function buildChunk(cx, cz, lod) { const g = buildChunkGen(cx, cz, lod); let r = g.next(); while (!r.done) r = g.next(); return r.value; }

  // Полоса вдоль выборок: 'wall' - вертикальная стенка на смещении a от b до c над полотном; 'slab' - горизонталь от a до c на высоте b.
  function stripGeom(M, list, a, b, c, kind) {
    const pos = [], uv = [], idx = [];
    list.forEach((i, k) => {
      const nx = -M.TZ[i], nz = M.TX[i], y = M.Y[i];
      if (kind === 'wall') pos.push(M.X[i] + nx * a, y + b, M.Z[i] + nz * a, M.X[i] + nx * a, y + c, M.Z[i] + nz * a);
      else pos.push(M.X[i] + nx * a, y + b, M.Z[i] + nz * a, M.X[i] + nx * c, y + b, M.Z[i] + nz * c);
      uv.push(M.S[i] / 4, 0, M.S[i] / 4, 1);
      if (k > 0) { const q = (k - 1) * 2; idx.push(q, q + 1, q + 2, q + 1, q + 3, q + 2); }
    });
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx); g.computeVertexNormals();
    return g;
  }
  // Свод горы над тоннелем: полоса на высоте рельефа над осью, шире прорези в сетке.
  function capGeom(M, list, half) {
    const pos = [], uv = [], idx = [];
    list.forEach((i, k) => {
      const nx = -M.TZ[i], nz = M.TX[i];
      for (const sd of [-1, 0, 1]) {
        const x = M.X[i] + nx * sd * half, z = M.Z[i] + nz * sd * half;
        pos.push(x, M.terrainHeight(x, z) + 0.08, z); uv.push(x / 24, z / 24);
      }
      if (k > 0) { const b = (k - 1) * 3; idx.push(b, b + 3, b + 1, b + 1, b + 3, b + 4, b + 1, b + 4, b + 2, b + 2, b + 4, b + 5); }
    });
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx); g.computeVertexNormals();
    return g;
  }
  // Портал тоннеля: две опоры по бокам проезда и перемычка над ним, до верха горы.
  function portal(M, i, hw, group) {
    const h = Math.atan2(M.TX[i], M.TZ[i]), y = M.Y[i], top = Math.max(M.terrainHeight(M.X[i], M.Z[i]), y + COVER) + 0.6, nx = -M.TZ[i], nz = M.TX[i];
    const side = 13, thick = 2.2;
    const box = (cxl, cy, w, hgt) => {
      const m = new THREE.Mesh(W.geo.box, W.mat.concrete); m.scale.set(w, hgt, thick);
      m.position.set(M.X[i] + nx * cxl, cy, M.Z[i] + nz * cxl); m.rotation.y = h; group.add(m);
    };
    for (const sd of [-1, 1]) box(sd * (hw + 1 + side / 2), (y - 3 + top) / 2, side, top - y + 3);
    box(0, (y + 7 + top) / 2, 2 * (hw + 1) + 0.2, top - y - 7);
  }
  function disposeChunk(ch) {
    W.scene.remove(ch.group);
    for (const g of ch.geos) g.dispose();
    for (const im of ch.inst) { im.dispose(); W.poolMeshes.delete(im); }
  }

  // Какие куски нужны и с какой детальностью; ближние строятся первыми, по частям, в пределах бюджета кадра.
  // Список нужного пересчитывается только при переходе машины в другой кусок.
  W.stream = function (sync, budgetMs) {
    const M = W.M, p = W.world.player, [pcx, pcz] = M.chunkOf(p.x, p.z), R0 = W.radius || 3, wk = pcx + ',' + pcz + ',' + R0;
    if (wk !== W.wantKey) {
      W.wantKey = wk;
      const want = new Map();
      for (let dz = -R0; dz <= R0; dz++) for (let dx = -R0; dx <= R0; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dz)), cx = pcx + dx, cz = pcz + dz;
        if (Math.abs(cx * WD.CHUNK) > M.half + 600 || Math.abs(cz * WD.CHUNK) > M.half + 600) continue;
        want.set(key(cx, cz), { cx, cz, lod: d <= 1 ? 0 : d <= 2 ? 1 : 2, d });
      }
      for (const [k, ch] of W.chunks) { if (!want.has(k)) { disposeChunk(ch); W.chunks.delete(k); } }
      W.want = want;
      W.far.userData.uni.farCenter.value.set((pcx + 0.5) * WD.CHUNK, (pcz + 0.5) * WD.CHUNK);
    }
    // дальний рельеф вырезается только там, где куски уже есть (кольцо вокруг машины)
    let ring = 0; for (let d = 0; d <= R0; d++) { let all = true; for (const w of W.want.values()) if (w.d === d && !W.chunks.has(key(w.cx, w.cz))) { all = false; break; } if (!all) break; ring = d + 1; }
    W.far.userData.uni.farHole.value = ring > 0 ? (ring - 0.5) * WD.CHUNK - 4 : 0;
    const todo = [];
    for (const [k, w] of W.want) { const ch = W.chunks.get(k); if (!ch || ch.lod !== w.lod) todo.push(w); }
    todo.sort((a, b) => a.d - b.d || a.lod - b.lod);
    W.pending = todo.length;
    const t0 = performance.now(), budget = budgetMs === undefined ? 5 : budgetMs;
    let n = 0;
    while (true) {
      if (!W.job) {
        const w = todo.shift(); if (!w) break;
        W.job = { w, gen: buildChunkGen(w.cx, w.cz, w.lod) };
      }
      const r = W.job.gen.next();
      if (r.done) {
        const w = W.job.w, k = key(w.cx, w.cz), old = W.chunks.get(k); W.job = null;
        if (!W.want.has(k)) { W.scene.add(r.value.group); disposeChunk(r.value); continue; }   // пока строился, машина уехала
        if (old) disposeChunk(old);
        W.chunks.set(k, r.value); W.scene.add(r.value.group); n++; W.built++;
      }
      const spent = performance.now() - t0;
      if (sync) { if (todo.length && todo[0].d > 1 && spent > 40 && !W.job) break; continue; }
      if (spent > budget) break;
    }
    // незаконченный кусок, который больше не нужен (машина уехала), бросаем
    if (W.job && !W.want.has(key(W.job.w.cx, W.job.w.cz))) { W.job.gen.return(); W.job = null; }
    W.pending = todo.length + (W.job ? 1 : 0);
    return n;
  };

  // ---------- машины ----------
  function syncCars() {
    const world = W.world;
    for (const c of world.cars) {
      if (W.carMeshes.has(c)) continue;
      const look = c.look || C.defaultLook(c.carId);
      const cp = R._.capture(() => R._.buildCar(c.carId, look, { own: true }));
      const cm = cp.r; cm.owned = cp.owned; cm.roll = 0; cm.pitch = 0; cm.spin = 0;
      cm.root.traverse((o) => { if (o.isMesh && o !== cm.blob) o.castShadow = c.isPlayer; });
      W.scene.add(cm.root); W.carMeshes.set(c, cm);
    }
    if (W.carMeshes.size > world.cars.length) {
      for (const [c, cm] of W.carMeshes) if (!world.cars.includes(c)) { W.scene.remove(cm.root); R._.disposeCar(cm); for (const o of cm.owned) if (o.dispose) o.dispose(); W.carMeshes.delete(c); }
    }
  }
  // Число геометрий машин (для счёта памяти кусков отдельно от машин).
  W.carGeometryCount = function () { let n = 0; for (const cm of W.carMeshes.values()) { const set = new Set(); cm.root.traverse((o) => { if (o.geometry) set.add(o.geometry); }); n += set.size; } return n; };
  W.chunkGeometryCount = function () { let n = 0; for (const ch of W.chunks.values()) n += ch.geos.length; if (W.job) n += 0; return n; };

  // ======================= КАДР =======================
  W.frame = function (dt, alpha, camMode) {
    if (!W.world) return;
    const world = W.world, M = W.M, p = world.player, sv = world.save;
    W.time += dt;
    W.stream(false, 4);
    syncCars();
    // время суток и погода
    const T = todAt(sv.tod), wth = Object.prototype.hasOwnProperty.call(WD.WEATHER, sv.weather) ? sv.weather : 'clear';
    const grey = wth === 'rain' ? 0.55 : wth === 'fog' ? 0.35 : wth === 'snow' ? 0.4 : 0, nightK = T.night ? 0.25 : 1;
    tmpC2.set(wth === 'snow' ? 0xdfe6ee : 0x8a929c).multiplyScalar(nightK);
    W.sky.material.uniforms.top.value.copy(T.top).lerp(tmpC2, grey); W.sky.material.uniforms.bot.value.copy(T.hor).lerp(tmpC2, grey);
    tmpC1.copy(T.fog).lerp(tmpC2, grey);
    W.scene.fog.color.copy(tmpC1); W.scene.background.copy(tmpC1);
    const farD = (W.radius + 0.5) * WD.CHUNK;
    W.scene.fog.near = wth === 'fog' ? 25 : wth === 'rain' || wth === 'snow' ? 60 : farD * 0.3;
    W.scene.fog.far = wth === 'fog' ? 260 : wth === 'rain' || wth === 'snow' ? 650 : farD;
    const ang = (sv.tod - 6) / 12 * Math.PI, el = Math.sin(ang);
    W.sun.color.copy(T.sun); W.sun.intensity = T.sunI * (1 - grey * 0.6);
    W.sun.position.set(p.x + Math.cos(ang) * 160, p.y + Math.max(40, el * 200 + 60), p.z + 90);
    W.sun.target.position.set(p.x, p.y, p.z); W.sun.target.updateMatrixWorld();
    W.hemi.intensity = T.hemi * (1 - grey * 0.3);
    W.stars.material.opacity = T.night && wth === 'clear' ? 1 : 0;
    // свет: фонари и фары - в темноте, в тумане и в дождь; мокрый асфальт темнее, пятна света ярче
    const dark = Math.max(T.dark, wth === 'fog' ? 0.5 : 0, wth === 'rain' ? 0.35 : 0);
    W.mat.lampHead.color.setScalar(0.47 + 0.53 * dark); if (dark > 0.3) W.mat.lampHead.color.setRGB(1, 0.94, 0.75);
    W.mat.pool.opacity = dark * (wth === 'rain' ? 0.7 : 0.55);
    W.mat.building.emissiveIntensity = T.night ? 0.9 : 0;
    W.headlight.intensity = dark * 3.2;
    W.water.position.x = Math.round(p.x / 1000) * 1000; W.water.position.z = Math.round(p.z / 1000) * 1000;
    W.water.material.map.offset.set(W.time * 0.004, W.time * 0.002);
    const wet = wth === 'rain' ? 0.62 : 1;
    for (const k in W.mat.road) W.mat.road[k].color.setScalar(wet);
    W.mat.plain.color.setScalar(wet);
    const snowK = wth === 'snow' ? (T.night ? 0.12 : 0.38) : 0;
    W.mat.terrain.emissive.setRGB(snowK, snowK, snowK * 1.05); W.mat.prop.emissive.setRGB(snowK * 0.6, snowK * 0.6, snowK * 0.65);
    // осадки вокруг камеры
    W.rain.visible = wth === 'rain';
    if (W.rain.visible) {
      const a = W.rain.geometry.attributes.position.array, cx = R.camera.position.x, cy = R.camera.position.y, cz = R.camera.position.z;
      for (let i = 0; i < a.length; i += 6) {
        let y = a[i + 1] - dt * 28; let x = a[i], z = a[i + 2];
        if (y < cy - 20 || Math.abs(x - cx) > 60 || Math.abs(z - cz) > 60) { x = cx + (Math.random() - 0.5) * 120; z = cz + (Math.random() - 0.5) * 120; y = cy + 20 + Math.random() * 20; }
        a[i] = x; a[i + 1] = y; a[i + 2] = z; a[i + 3] = x + 0.1; a[i + 4] = y - 1.3; a[i + 5] = z;
      }
      W.rain.geometry.attributes.position.needsUpdate = true;
    }
    const snowing = wth === 'snow' || (M.regionAt(p.x, p.z).biome === 'snow' && wth !== 'clear');
    if (snowing) for (let k = 0; k < 14; k++) R._.emit(W.snowP, R.camera.position.x + (Math.random() - 0.5) * 70, R.camera.position.y + 18, R.camera.position.z + (Math.random() - 0.5) * 70, (Math.random() - 0.5) * 2, -3.5, (Math.random() - 0.5) * 2, 0.7, 0, 6, 1, 1, 1, 0.95);
    R._.updateParticles(W.snowP, dt);
    // машины
    for (const c of world.cars) {
      const cm = W.carMeshes.get(c); if (!cm) continue;
      const x = c.ix !== undefined ? C.lerp(c.ix, c.x, alpha) : c.x, z = c.iz !== undefined ? C.lerp(c.iz, c.z, alpha) : c.z, y = c.iy !== undefined ? C.lerp(c.iy, c.y, alpha) : c.y;
      let h = c.h; if (c.ih !== undefined) { let dh = c.h - c.ih; if (dh > Math.PI) dh -= 2 * Math.PI; if (dh < -Math.PI) dh += 2 * Math.PI; h = c.ih + dh * alpha; }
      cm.root.position.set(x, y, z); cm.root.rotation.order = 'YXZ'; cm.root.rotation.y = h;
      const fx = Math.sin(h), fz = Math.cos(h);
      if (!c.air) { const yf = M.groundAt(x + fx * 1.8, z + fz * 1.8, gq, y).y, yb = M.groundAt(x - fx * 1.8, z - fz * 1.8, gq, y).y; cm.pitch += (-Math.atan2(yf - yb, 3.6) - cm.pitch) * Math.min(1, dt * 10); }
      else cm.pitch += (Math.max(-0.4, Math.min(0.4, -c.vy * 0.03)) - cm.pitch) * Math.min(1, dt * 3);
      cm.root.rotation.x = cm.pitch;
      const k2 = 1 - Math.exp(-dt * 8);
      cm.roll += (C.clamp(-(c.w || 0) * (c.speed || 0) * 0.006, -0.07, 0.07) - cm.roll) * k2; cm.body.rotation.z = cm.roll;
      cm.spin += (c.vLong || 0) * dt / cm.S.wr;
      for (const w of cm.wheels) { w.spin.rotation.x = cm.spin; if (w.front) w.pivot.rotation.y = c.steer; }
      cm.tailMat.emissiveIntensity = c.braking ? 2.4 : 0.6;
      cm.headMat.emissiveIntensity = 1.2 + dark * 1.8;
      cm.root.visible = !(camMode === 'hood' && c === p && !W.photo);
      const skid = Math.max(c.skidR || 0, (c.skidF || 0) * 0.6), loose = c.surf !== 'asphalt' && c.surf !== 'concrete';
      if (!c.air && (skid > 0.35 || (loose && c.speed > 9)) && Math.random() < 0.8 && Math.abs(x - p.x) + Math.abs(z - p.z) < 160) {
        const rz = -cm.L / 2 + cm.S.ax[0], hw = cm.W / 2 - 0.15, sn = Math.sin(h), cs = Math.cos(h);
        const r0 = c.surf === 'snow' ? 0.95 : c.surf === 'sand' ? 0.85 : loose ? 0.6 : 0.86, g0 = c.surf === 'snow' ? 0.97 : c.surf === 'sand' ? 0.74 : loose ? 0.52 : 0.86, b0 = c.surf === 'snow' ? 1 : c.surf === 'sand' ? 0.55 : loose ? 0.4 : 0.88;
        for (let sd = -1; sd <= 1; sd += 2) R._.emit(W.parts, x + cs * hw * sd + sn * rz, y + 0.3, z - sn * hw * sd + cs * rz, -c.vx * 0.12 + (Math.random() - 0.5) * 2, 0.8, -c.vz * 0.12 + (Math.random() - 0.5) * 2, 1.1, 2.5, 1.0, r0, g0, b0, Math.min(0.42, 0.14 + skid * 0.3));
      }
    }
    R._.updateParticles(W.parts, dt);
    // точки: флаги, лучи, таблички к камере, разбитые щиты
    for (const a of W.markers.anim) {
      if (a.bill) a.m.lookAt(R.camera.position.x, a.m.position.y, R.camera.position.z);
      if (a.pulse) a.m.material.opacity = 0.25 + 0.15 * Math.sin(W.time * 3);
      if (a.flag) a.m.rotation.y = Math.sin(W.time * 2 + a.k) * 0.3;
    }
    for (const id in W.markers.boards) W.markers.boards[id].visible = !sv.boards[id];
    camera(dt, camMode);
    // пятно фар на полотне перед машиной
    const pcm = W.carMeshes.get(p);
    if (pcm) updateBeam(pcm.root.position.x, pcm.root.position.y, pcm.root.position.z, pcm.root.rotation.y, dark * (wth === 'rain' ? 0.95 : 0.8));
    const sk = R.camera.far * 0.9 / 2600;
    W.sky.position.copy(R.camera.position); W.sky.scale.setScalar(sk);
    W.stars.position.copy(R.camera.position); W.stars.scale.setScalar(sk);
    R.renderer.render(W.scene, R.camera);
  };

  function camera(dt, camMode) {
    const cam = R.camera, st = W.cam, p = W.world.player, cm = W.carMeshes.get(p);
    const px = cm ? cm.root.position.x : p.x, py = cm ? cm.root.position.y : p.y, pz = cm ? cm.root.position.z : p.z, ph = cm ? cm.root.rotation.y : p.h;
    const fx = Math.sin(ph), fz = Math.cos(ph), farD = (W.radius + 0.6) * WD.CHUNK + 400;
    if (W.photo) {
      const ph2 = W.photo;
      cam.position.set(px + Math.sin(ph2.yaw) * Math.cos(ph2.pitch) * ph2.dist, py + 1 + Math.sin(ph2.pitch) * ph2.dist, pz + Math.cos(ph2.yaw) * Math.cos(ph2.pitch) * ph2.dist);
      tmpV.set(px, py + 1, pz); cam.lookAt(tmpV);
    } else if (camMode === 'hood') {
      cam.position.set(px + fx * 0.35, py + 1.25, pz + fz * 0.35); tmpV.set(px + fx * 30, py + 1.0, pz + fz * 30); cam.lookAt(tmpV); st.init = false;
    } else {
      const far2 = camMode === 'far', back = far2 ? 9.5 : 6.2, up = far2 ? 3.6 : 2.3;
      let dx = fx, dz = fz; const sp = p.speed;
      if (sp > 4) { const vl = Math.hypot(p.vx, p.vz); dx = fx * 0.6 + p.vx / vl * 0.4; dz = fz * 0.6 + p.vz / vl * 0.4; const l = Math.hypot(dx, dz); dx /= l; dz /= l; }
      const tx = px - dx * back, tz = pz - dz * back;
      let ty = py + up; const gy = W.M.groundAt(tx, tz, gq, py).y; if (ty < gy + 1.2) ty = gy + 1.2;
      if (!st.init || Math.hypot(tx - st.x, tz - st.z) > 25) { st.x = tx; st.y = ty; st.z = tz; st.init = true; }
      const kk = 1 - Math.exp(-dt * 7); st.x += (tx - st.x) * kk; st.y += (ty - st.y) * kk; st.z += (tz - st.z) * kk;
      cam.position.set(st.x, st.y, st.z); tmpV.set(px + fx * 3, py + 1.1, pz + fz * 3); cam.lookAt(tmpV);
    }
    const fovT = 60 + Math.min(1, p.speed / 70) * 16 + (p.nitroOn ? 6 : 0);
    st.fov += (fovT - st.fov) * (1 - Math.exp(-dt * 3));
    cam.fov = W.photo ? 55 : st.fov; cam.near = 0.3; cam.far = farD; cam.updateProjectionMatrix();
    // фара: над машиной, светит вниз-вперёд
    W.headlight.position.set(px + fx * 0.5, py + 4.5, pz + fz * 0.5); W.headlight.target.position.set(px + fx * 22, py, pz + fz * 22); W.headlight.target.updateMatrixWorld();
  }

  W.photoMode = function (on) { W.photo = on ? { yaw: (W.world.player.h || 0) + Math.PI + 0.6, pitch: 0.25, dist: 9 } : null; };
  W.photoMove = function (dyaw, dpitch, dzoom) { if (!W.photo) return; W.photo.yaw += dyaw; W.photo.pitch = C.clamp(W.photo.pitch + dpitch, -0.1, 1.3); W.photo.dist = C.clamp(W.photo.dist * dzoom, 3.5, 40); };
  W.breakBoard = function (pt) {
    const x = pt.x, z = pt.z, y = W.M.groundAt(x, z).y + 2;
    for (let k = 0; k < 40; k++) R._.emit(W.parts, x, y, z, (Math.random() - 0.5) * 14, Math.random() * 8, (Math.random() - 0.5) * 14, 0.6, 0.2, 1.2, 1, 0.5 + Math.random() * 0.4, 0.1, 1);
  };
  // Высота отрисованного рельефа под точкой (луч вниз по кускам) - для сверки сетки с физикой.
  const ray = new THREE.Raycaster(), rayO = new THREE.Vector3(), rayD = new THREE.Vector3(0, -1, 0);
  W.meshHeight = function (x, z, chunkList) {
    rayO.set(x, 3000, z); ray.set(rayO, rayD); ray.far = 6000;
    const objs = []; for (const ch of chunkList || W.chunks.values()) objs.push(ch.group.children[0]);
    const hit = ray.intersectObjects(objs, false)[0];
    return hit ? hit.point.y : null;
  };
  W._build = (cx, cz, lod) => { const ch = buildChunk(cx, cz, lod); ch.group.updateMatrixWorld(true); return ch; };
  W._dispose = (ch) => { for (const g of ch.geos) g.dispose(); for (const im of ch.inst) { im.dispose(); W.poolMeshes.delete(im); } };
  W.info = function () { const lods = [0, 0, 0]; for (const ch of W.chunks.values()) lods[ch.lod]++; return { chunks: W.chunks.size, lods, built: W.built, pending: W.pending, cars: W.carMeshes.size }; };

  W.dispose = function () {
    if (!W.scene) return;
    for (const ch of W.chunks.values()) disposeChunk(ch);
    W.chunks.clear(); W.job = null;
    for (const [, cm] of W.carMeshes) { R._.disposeCar(cm); for (const o of cm.owned) if (o.dispose) o.dispose(); }
    W.carMeshes.clear();
    const shared = new Set(Object.values(W.geo));
    W.scene.traverse((o) => {
      if (o.isInstancedMesh) o.dispose();
      if (o.geometry && !shared.has(o.geometry)) o.geometry.dispose();
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => { if (m.map) m.map.dispose(); if (m.emissiveMap) m.emissiveMap.dispose(); m.dispose(); });
    });
    for (const o of W.owned) if (o && o.dispose) o.dispose();
    for (const g of shared) g.dispose();
    W.sun.dispose(); W.headlight.dispose();
    W.scene = null; W.world = null; W.owned = []; W.warmed = false;
  };
})();
