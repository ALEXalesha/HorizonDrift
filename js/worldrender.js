/* Horizon Drift - рисование открытого мира: потоковая загрузка кусков 256x256 м с тремя уровнями
   детализации (вблизи всё, дальше проще, ещё дальше - общий грубый рельеф и туман), дороги, мосты,
   тоннели, фонари, декор инстансами, точки мира, время суток и погода, машины, камера и фото-режим.
   Земля для физики считается функцией (DriftWorld), а не по этой сетке: провалиться нельзя. */
(function () {
  'use strict';
  const D = window.DriftData, C = window.DriftCore, R = window.DriftRender, WD = window.DriftWorld;
  const W = { world: null };
  window.DriftWorldRender = W;
  const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const col = (h) => new THREE.Color(h);

  // ---------- время суток ----------
  const TOD = [
    [0, '#05060f', '#141630', '#0b0c1c', '#8fa2ff', 0.12, 0.2],
    [5, '#24305a', '#e0906a', '#6a5a6a', '#ffb080', 0.35, 0.35],
    [7.5, '#4a8fd8', '#cfe6f7', '#bcd6ea', '#fff0d8', 1.05, 0.7],
    [13, '#3f86d8', '#d8ecfa', '#c9e0f2', '#fff6e8', 1.3, 0.8],
    [17.5, '#3b5a9a', '#ffc690', '#e0b89a', '#ffc080', 0.9, 0.6],
    [20, '#1a1f45', '#c86a5a', '#4a3040', '#ff9060', 0.3, 0.32],
    [22, '#05060f', '#141630', '#0b0c1c', '#8fa2ff', 0.12, 0.2],
    [24, '#05060f', '#141630', '#0b0c1c', '#8fa2ff', 0.12, 0.2],
  ];
  function todAt(h) {
    let i = 0; while (i < TOD.length - 2 && TOD[i + 1][0] <= h) i++;
    const a = TOD[i], b = TOD[i + 1], t = (h - a[0]) / (b[0] - a[0]);
    const mix = (k) => col(a[k]).lerp(col(b[k]), t);
    return { top: mix(1), hor: mix(2), fog: mix(3), sun: mix(4), sunI: a[5] + (b[5] - a[5]) * t, hemi: a[6] + (b[6] - a[6]) * t, night: h < 5.5 || h > 20.5 };
  }
  W.todAt = todAt;

  // ======================= СБОРКА =======================
  W.init = function (world, settings) {
    W.dispose();
    const M = world.M, _ = R._;
    W.world = world; W.M = M; W.settings = settings;
    const scene = new THREE.Scene();
    W.scene = scene;
    W.chunks = new Map(); W.queue = []; W.built = 0; W.lastBuildMs = 0;
    W.carMeshes = new Map();
    W.cam = { x: 0, y: 0, z: 0, init: false, fov: 62, shake: 0 };
    W.photo = null; W.time = 0;
    // общие материалы и геометрии - живут, пока открыт мир
    const cap = _.capture(() => {
      const m = {};
      const detail = _.canvasTex(128, 128, (g, w) => { g.fillStyle = '#808080'; g.fillRect(0, 0, w, w); _.speckle(g, w, w, _.rngOf(9), 2500, ['#6a6a6a', '#959595', '#7a7a7a', '#8a8a8a'], 1, 4); }, true);
      detail.repeat.set(1, 1);
      m.terrain = new THREE.MeshLambertMaterial({ map: detail, vertexColors: true });
      m.road = {};
      for (const sf of ['asphalt', 'gravel', 'snow']) { const t = _.surfaceTex(sf); m.road[sf] = new THREE.MeshLambertMaterial({ map: t, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }); }
      m.concrete = new THREE.MeshLambertMaterial({ color: 0x9a9ca2 });
      m.rail = new THREE.MeshLambertMaterial({ map: _.wallTex('rail'), side: THREE.DoubleSide });
      m.tunnel = new THREE.MeshLambertMaterial({ color: 0x5a5c63, side: THREE.DoubleSide });
      m.tunnelLight = new THREE.MeshBasicMaterial({ color: 0xffe6a8 });
      m.lampPole = new THREE.MeshLambertMaterial({ color: 0x3a3d44 });
      m.lampHead = new THREE.MeshBasicMaterial({ color: 0x777777 });
      m.prop = new THREE.MeshLambertMaterial({ vertexColors: true });
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
      return { m, geo };
    });
    W.mat = cap.r.m; W.geo = cap.r.geo; W.owned = cap.owned;
    for (const t of Object.values(W.mat.road)) t.map.repeat.set(1, 1);
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
    W.hemi = new THREE.HemisphereLight(0xcfe8ff, 0x5a4a3a, 0.7); scene.add(W.hemi);
    W.sun = new THREE.DirectionalLight(0xffffff, 1.2);
    const sc = W.sun.shadow.camera; sc.left = -70; sc.right = 70; sc.top = 70; sc.bottom = -70; sc.near = 10; sc.far = 500; W.sun.shadow.bias = -0.0007;
    scene.add(W.sun); scene.add(W.sun.target);
    W.headlight = new THREE.SpotLight(0xfff2d6, 0, 110, 0.55, 0.5, 1.2); scene.add(W.headlight); scene.add(W.headlight.target);
    const wtex = R._.canvasTex(128, 128, (g, w) => { g.fillStyle = '#1d5f8a'; g.fillRect(0, 0, w, w); R._.speckle(g, w, w, R._.rngOf(3), 700, ['rgba(255,255,255,0.22)', 'rgba(0,30,60,0.3)'], 1, 3); }, true);
    wtex.repeat.set(400, 400);
    W.water = new THREE.Mesh(new THREE.PlaneGeometry(20000, 20000).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ map: wtex, transparent: true, opacity: 0.9 }));
    W.water.position.y = WD.WATER; scene.add(W.water);
    W.far = farTerrain(M); scene.add(W.far);
    // осадки
    W.rain = rainSystem(); scene.add(W.rain);
    W.snowP = R._.capture(() => R._.particleSystem(900)); W.owned.push(...W.snowP.owned); W.snowP = W.snowP.r; scene.add(W.snowP.pts);
    const pc = R._.capture(() => ({ parts: R._.particleSystem({ low: 300, medium: 700, high: 1400 }[settings.particles] || 700), skids: R._.skidSystem(1600) }));
    W.parts = pc.r.parts; W.skids = pc.r.skids; W.owned.push(...pc.owned);
    scene.add(W.parts.pts); scene.add(W.skids.mesh);
    // точки мира
    W.markers = buildMarkers(M, world);
    scene.add(W.markers.group);
    W.applySettings(settings);
    // сразу загрузить кусок под машиной и соседей, чтобы не ждать
    W.stream(true);
    // общие материалы и геометрии тоже сразу: иначе они догружаются, когда впервые попадут в кадр
    const warm = new THREE.Group(), basic = new THREE.MeshBasicMaterial();
    for (const g of Object.values(W.geo)) warm.add(new THREE.Mesh(g, basic));
    const mats = [W.mat.terrain, W.mat.concrete, W.mat.rail, W.mat.tunnel, W.mat.tunnelLight, W.mat.lampPole, W.mat.lampHead, W.mat.prop, W.mat.building, W.mat.container, ...Object.values(W.mat.road)];
    mats.forEach((m, k) => { const mesh = new THREE.Mesh(W.geo.building, m); mesh.position.x = k; warm.add(mesh); });
    // дождь, следы шин и частицы тоже: до первого дождя и первого заноса они в кадр не попадают
    for (const o of [W.rain, W.skids.mesh, W.parts.pts, W.snowP.pts]) { o.userData.parent = o.parent; warm.add(o); }
    const rv = W.rain.visible; W.rain.visible = true; W.skids.mesh.geometry.setDrawRange(0, 6);
    preupload(warm); basic.dispose();
    W.rain.visible = rv; W.skids.mesh.geometry.setDrawRange(0, 0);
    for (const o of [W.rain, W.skids.mesh, W.parts.pts, W.snowP.pts]) o.userData.parent.add(o);
    preupload(W.markers.group);
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
    W.radius = { near: 2, mid: 3, far: 4 }[s.drawDist] || 3;
    W.scene.traverse((o) => { if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => { m.needsUpdate = true; }); });
  };

  function farTerrain(M) {
    const n = 110, size = M.half * 2 + 1200;
    const g = new THREE.PlaneGeometry(size, size, n, n); g.rotateX(-Math.PI / 2);
    const pos = g.attributes.position, cols = new Float32Array(pos.count * 3), c = [0, 0, 0];
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i), y = M.rawHeight(x, z) - 2.5;
      pos.setY(i, y);
      M.biomeColor(x, z, c); const k = y < 0.5 ? 0.8 : 1; cols[i * 3] = c[0] * k; cols[i * 3 + 1] = c[1] * k; cols[i * 3 + 2] = c[2] * k;
    }
    g.setAttribute('color', new THREE.BufferAttribute(cols, 3)); g.computeVertexNormals();
    return new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true }));
  }
  function rainSystem() {
    const n = 1500, pos = new Float32Array(n * 6), r = R._.rngOf(17);
    for (let i = 0; i < n; i++) { const x = (r() - 0.5) * 120, y = r() * 60, z = (r() - 0.5) * 120; pos.set([x, y, z, x + 0.1, y - 1.2, z], i * 6); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xaec4dc, transparent: true, opacity: 0.45 }));
    l.frustumCulled = false; l.visible = false;
    return l;
  }

  // ---------- точки мира: фестиваль, события, радары, зоны дрифта, рампы, щиты ----------
  function labelTex(text, color) {
    return R._.canvasTex(512, 128, (g, w, h) => {
      g.fillStyle = 'rgba(10,9,18,0.82)'; g.fillRect(0, 0, w, h); g.fillStyle = color; g.fillRect(0, h - 10, w, 10);
      g.fillStyle = '#fff'; g.font = 'bold 46px Bahnschrift, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(text, w / 2, h / 2 - 4);
    });
  }
  function buildMarkers(M, world) {
    const cap = R._.capture(() => {
      const group = new THREE.Group(), boards = {}, anim = [];
      // одна текстура на все щиты
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
          const mat = new THREE.MeshLambertMaterial({ color: 0xff5a1f }), mat2 = new THREE.MeshLambertMaterial({ color: 0x2a2c33 });
          const stage = new THREE.Mesh(new THREE.BoxGeometry(26, 1.2, 14), mat2); stage.position.set(p.x, y + 0.6, p.z); group.add(stage);
          const scr = new THREE.Mesh(new THREE.PlaneGeometry(20, 8), new THREE.MeshBasicMaterial({ map: labelTex('HORIZON DRIFT · ФЕСТИВАЛЬ', '#ff5a1f'), side: THREE.DoubleSide }));
          scr.position.set(p.x, y + 7, p.z - 6); group.add(scr);
          for (let k = 0; k < 8; k++) {
            const a = k / 8 * Math.PI * 2, tx = p.x + Math.cos(a) * 22, tz = p.z + Math.sin(a) * 22, ty = M.groundAt(tx, tz).y;
            const tent = new THREE.Mesh(new THREE.ConeGeometry(5, 5, 6), k % 2 ? mat : new THREE.MeshLambertMaterial({ color: 0xf4f4f4 })); tent.position.set(tx, ty + 2.5, tz); group.add(tent);
            const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 12, 5), mat2); pole.position.set(tx, ty + 6, tz); group.add(pole);
            const flag = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 1.4), new THREE.MeshBasicMaterial({ color: [0xff5a1f, 0x19d3ff, 0xffb02e, 0x9a4dff][k % 4], side: THREE.DoubleSide }));
            flag.position.set(tx + 1.2, ty + 11.2, tz); group.add(flag); anim.push({ m: flag, flag: true, k });
          }
          sign('ФЕСТИВАЛЬ', '#ff5a1f', p.x, y + 14, p.z, 1.3);
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
            const e = M.edges[M.E[i]], x = M.X[i], z = M.Z[i], yy = M.Y[i], h = Math.atan2(M.TX[i], M.TZ[i]);
            const arch = new THREE.Mesh(new THREE.TorusGeometry(e.hw + 1, 0.3, 8, 24, Math.PI), new THREE.MeshBasicMaterial({ color: 0xff5ad8 })); arch.position.set(x, yy, z); arch.rotation.y = h + Math.PI / 2; group.add(arch);
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

  // Загрузить в видеокарту все точки мира сразу (иначе они догружались бы по мере поездки и счётчики росли).
  function preupload(group) {
    const saved = [];
    group.traverse((o) => { if (o.isMesh) { saved.push(o); o.frustumCulled = false; } if (o.material) for (const t of ['map', 'emissiveMap']) if (o.material[t]) R.renderer.initTexture(o.material[t]); });
    const rt = new THREE.WebGLRenderTarget(4, 4), cam = new THREE.PerspectiveCamera();
    const sc = new THREE.Scene(); sc.add(new THREE.AmbientLight(0xffffff, 1)); const parent = group.parent; sc.add(group);
    R.renderer.setRenderTarget(rt); R.renderer.render(sc, cam); R.renderer.setRenderTarget(null);
    if (parent) parent.add(group);
    for (const o of saved) o.frustumCulled = true;
    rt.dispose();
  }

  // ---------- куски ----------
  const key = (cx, cz) => cx + ',' + cz;
  function buildChunk(cx, cz, lod) {
    const M = W.M, CH = WD.CHUNK, x0 = cx * CH, z0 = cz * CH, group = new THREE.Group(), geos = [], inst = [];
    const add = (geo, mat) => { const m = new THREE.Mesh(geo, mat); geos.push(geo); group.add(m); return m; };
    // рельеф с «юбкой» по краю, чтобы между кусками разной детальности не было щелей
    const seg = [40, 18, 8][lod], n = seg + 3, pos = new Float32Array(n * n * 3), colr = new Float32Array(n * n * 3), uv = new Float32Array(n * n * 2), idx = [];
    const c = [0, 0, 0];
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const ii = Math.min(seg, Math.max(0, i - 1)), jj = Math.min(seg, Math.max(0, j - 1)), edge = i === 0 || j === 0 || i === n - 1 || j === n - 1;
        const x = x0 + ii / seg * CH, z = z0 + jj / seg * CH;
        let y = lod === 2 ? M.rawHeight(x, z) : M.terrainHeight(x, z);
        if (lod === 2) { const q = M.nearestRoad(x, z); if (q && q.d < q.hw + 20 && !q.bridge) y = Math.min(y, q.y - 0.6); }
        if (edge) y -= 5;
        const k = (j * n + i) * 3; pos[k] = x; pos[k + 1] = y; pos[k + 2] = z;
        M.biomeColor(x, z, c);
        // песок у воды, снег на вершинах, камень на кручах добавим после нормалей
        if (y < WD.WATER + 1.2) { c[0] = c[0] * 0.4 + 0.52; c[1] = c[1] * 0.4 + 0.48; c[2] = c[2] * 0.4 + 0.36; }
        if (y > 95) { const t = smooth(95, 120, y); c[0] += (0.94 - c[0]) * t; c[1] += (0.96 - c[1]) * t; c[2] += (0.98 - c[2]) * t; }
        const v = 0.9 + ((i * 7 + j * 13) % 10) * 0.02;
        colr[k] = c[0] * v; colr[k + 1] = c[1] * v; colr[k + 2] = c[2] * v;
        uv[(j * n + i) * 2] = x / 24; uv[(j * n + i) * 2 + 1] = z / 24;
      }
    }
    for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) { const a = j * n + i, b = a + 1, cc = a + n, d = cc + 1; idx.push(a, cc, b, b, cc, d); }
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.BufferAttribute(pos, 3)); tg.setAttribute('color', new THREE.BufferAttribute(colr, 3)); tg.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    tg.setIndex(idx); tg.computeVertexNormals();
    const nr = tg.attributes.normal;
    for (let k = 0; k < nr.count; k++) { const s = 1 - nr.getY(k); if (s > 0.18) { const t = smooth(0.18, 0.5, s); colr[k * 3] += (0.5 - colr[k * 3]) * t; colr[k * 3 + 1] += (0.47 - colr[k * 3 + 1]) * t; colr[k * 3 + 2] += (0.43 - colr[k * 3 + 2]) * t; } }
    const tm = add(tg, W.mat.terrain); tm.receiveShadow = lod === 0;
    // дороги: полосы по выборкам, попавшим в кусок
    const segs = M.roadSamplesIn(cx, cz, 0);
    const runs = [];
    for (const i of segs) { const last = runs[runs.length - 1]; if (last && last[1] === i && M.E[i] === M.E[last[0]]) last[1] = i + 1; else runs.push([i, i + 1]); }
    const byMat = {};
    const lamps = [];
    for (const [a, b] of runs) {
      const e = M.edges[M.E[a]], hw = e.hw, step = lod === 2 ? 4 : lod === 1 ? 2 : 1, lift = lod === 0 ? 0.06 : 0.25;
      const list = []; for (let i = a; i < b; i += step) list.push(i); list.push(b);
      const P = byMat[e.surf] = byMat[e.surf] || { pos: [], uv: [], idx: [] };
      const base = P.pos.length / 3;
      list.forEach((i, k) => {
        const nx = -M.TZ[i], nz = M.TX[i], y = M.Y[i] + lift;
        P.pos.push(M.X[i] - nx * hw, y, M.Z[i] - nz * hw, M.X[i] + nx * hw, y, M.Z[i] + nz * hw);
        P.uv.push(0, M.S[i] / 12, 1, M.S[i] / 12);
        if (k > 0) { const q = base + (k - 1) * 2; P.idx.push(q, q + 1, q + 2, q + 1, q + 3, q + 2); }
      });
      // мост: ограждения и опоры; тоннель: стены, свод и лампы
      if (lod < 2) {
        const bridge = list.filter((i) => M.FL[i] & 1), tunnel = list.filter((i) => M.FL[i] & 2);
        if (bridge.length > 1) {
          for (const sd of [-1, 1]) add(stripGeom(M, bridge, sd * (hw + 0.2), 0.05, 1.1, 'wall'), W.mat.rail);
          add(stripGeom(M, bridge, -hw - 0.3, -1.4, hw + 0.3, 'slab'), W.mat.concrete);
          if (lod === 0) for (let k = 0; k < bridge.length; k += Math.max(1, Math.round(26 / e.step / step))) {
            const i = bridge[k], ground = Math.max(M.RAW[i], WD.WATER - 6), hgt = M.Y[i] - 1.4 - ground;
            if (hgt > 1) { const pg = W.geo.pillar; const mm = new THREE.Mesh(pg, W.mat.concrete); mm.scale.set(1, hgt, 1); mm.position.set(M.X[i], M.Y[i] - 1.4, M.Z[i]); group.add(mm); }
          }
        }
        if (tunnel.length > 1) {
          for (const sd of [-1, 1]) add(stripGeom(M, tunnel, sd * (hw + 1), 0, 7, 'wall'), W.mat.tunnel);
          add(stripGeom(M, tunnel, -hw - 1.2, 7, hw + 1.2, 'slab'), W.mat.tunnel);
          add(stripGeom(M, tunnel, -0.3, 6.9, 0.3, 'slab'), W.mat.tunnelLight);
        }
      }
      if (e.T.lamps && lod < 2) for (let i = a; i < b; i++) if (M.S[i] % 60 < e.step && !(M.FL[i] & 2)) lamps.push([i, (Math.floor(M.S[i] / 60) % 2) ? 1 : -1, hw]);
    }
    for (const sf in byMat) {
      const P = byMat[sf], g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(P.pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(P.uv, 2)); g.setIndex(P.idx); g.computeVertexNormals();
      const m = add(g, W.mat.road[sf] || W.mat.road.asphalt); m.receiveShadow = lod === 0;
    }
    // фонари
    if (lamps.length) {
      const poles = new THREE.InstancedMesh(W.geo.lampPole, W.mat.prop, lamps.length), heads = new THREE.InstancedMesh(W.geo.lampHead, W.mat.lampHead, lamps.length);
      const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), v = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);
      lamps.forEach(([i, sd, hw], k) => {
        const nx = -M.TZ[i], nz = M.TX[i], x = M.X[i] + nx * sd * (hw + 0.8), z = M.Z[i] + nz * sd * (hw + 0.8);
        e.set(0, Math.atan2(-nx * sd, -nz * sd), 0); q.setFromEuler(e);
        m.compose(v.set(x, M.Y[i], z), q, one); poles.setMatrixAt(k, m);
        m.compose(v.set(x - nx * sd * 2, M.Y[i] + 7.8, z - nz * sd * 2), q, one); heads.setMatrixAt(k, m);
      });
      group.add(poles); group.add(heads); inst.push(poles, heads);
    }
    // декор: общий список куска (тот же, что для столкновений)
    const decor = M.chunkDecor(cx, cz), byType = {};
    for (const d of decor) {
      if (lod === 2 && d.type !== 'building') continue;
      if (lod === 1 && d.type === 'rock') continue;
      (byType[d.type] = byType[d.type] || []).push(d);
    }
    const mm = new THREE.Matrix4(), qq = new THREE.Quaternion(), ee = new THREE.Euler(), vv = new THREE.Vector3(), ss = new THREE.Vector3(), cc2 = new THREE.Color();
    for (const t in byType) {
      const L = byType[t];
      const mat = t === 'building' ? W.mat.building : t === 'container' ? W.mat.container : W.mat.prop;
      const im = new THREE.InstancedMesh(W.geo[t], mat, L.length);
      L.forEach((d, k) => {
        ee.set(0, d.rot, 0); qq.setFromEuler(ee); vv.set(d.x, d.y - 0.15, d.z);
        if (t === 'building') ss.set(d.w, d.h, d.d); else if (t === 'container') ss.set(1, d.h / 2.6, 1); else ss.set(d.s, d.s, d.s);
        mm.compose(vv, qq, ss); im.setMatrixAt(k, mm);
        if (t === 'container') { cc2.set(['#c8412e', '#2f6bb0', '#e0a02a', '#3a8a4a', '#8a8f96'][Math.floor(d.col * 5)]); im.setColorAt(k, cc2); }
        else if (t === 'building') { cc2.setHSL(0.6, 0.05, 0.55 + d.col * 0.35); im.setColorAt(k, cc2); }
      });
      im.castShadow = lod === 0 && t !== 'rock'; im.receiveShadow = false;
      group.add(im); inst.push(im);
    }
    return { key: key(cx, cz), cx, cz, lod, group, geos, inst };
  }
  // Полоса вдоль выборок: 'wall' - вертикальная стенка на смещении d от y0 до y1; 'slab' - горизонталь от d0 до d1 на высоте dy.
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
  function disposeChunk(ch) {
    W.scene.remove(ch.group);
    for (const g of ch.geos) g.dispose();
    for (const im of ch.inst) im.dispose();
  }

  // Какие куски нужны и с какой детальностью; строим ближние первыми, не больше бюджета за кадр.
  W.stream = function (sync, budgetMs) {
    const M = W.M, p = W.world.player, [pcx, pcz] = M.chunkOf(p.x, p.z), R0 = W.radius || 3;
    const want = new Map();
    for (let dz = -R0; dz <= R0; dz++) for (let dx = -R0; dx <= R0; dx++) {
      const d = Math.max(Math.abs(dx), Math.abs(dz)), cx = pcx + dx, cz = pcz + dz;
      if (Math.abs(cx * WD.CHUNK) > M.half + 600 || Math.abs(cz * WD.CHUNK) > M.half + 600) continue;
      want.set(key(cx, cz), { cx, cz, lod: d <= 1 ? 0 : d <= 2 ? 1 : 2, d });
    }
    for (const [k, ch] of W.chunks) { if (!want.has(k)) { disposeChunk(ch); W.chunks.delete(k); } }
    const todo = [];
    for (const [k, w] of want) { const ch = W.chunks.get(k); if (!ch || ch.lod !== w.lod) todo.push(w); }
    todo.sort((a, b) => a.d - b.d || a.lod - b.lod);
    const t0 = performance.now(), budget = budgetMs === undefined ? 5 : budgetMs;
    let n = 0;
    for (const w of todo) {
      if (!sync && n > 0 && performance.now() - t0 > budget) break;
      if (sync && w.d > 1 && n > 0 && performance.now() - t0 > 40) break;
      const old = W.chunks.get(key(w.cx, w.cz));
      const ch = buildChunk(w.cx, w.cz, w.lod);
      if (old) disposeChunk(old);
      W.chunks.set(ch.key, ch); W.scene.add(ch.group); n++; W.built++;
    }
    W.pending = todo.length - n;
    return n;
  };

  // ---------- машины ----------
  function syncCars(dt) {
    const world = W.world, seen = new Set();
    for (const c of world.cars) {
      seen.add(c);
      let cm = W.carMeshes.get(c);
      if (!cm) {
        const look = c.look || C.defaultLook(c.carId);
        const cp = R._.capture(() => R._.buildCar(c.carId, look, { own: true }));
        cm = cp.r; cm.owned = cp.owned; cm.roll = 0; cm.pitch = 0; cm.spin = 0; cm.lastWheels = null;
        cm.root.traverse((o) => { if (o.isMesh && o !== cm.blob) o.castShadow = c.isPlayer; });
        W.scene.add(cm.root); W.carMeshes.set(c, cm);
      }
    }
    for (const [c, cm] of W.carMeshes) if (!seen.has(c)) { W.scene.remove(cm.root); R._.disposeCar(cm); for (const o of cm.owned) if (o.dispose) o.dispose(); W.carMeshes.delete(c); }
  }

  // ======================= КАДР =======================
  const tmpV = new THREE.Vector3(), gq = {};
  W.frame = function (dt, alpha, camMode) {
    if (!W.world) return;
    const world = W.world, M = W.M, p = world.player, s = W.settings, sv = world.save;
    W.time += dt;
    W.stream(false, 4);
    syncCars(dt);
    // время суток и погода
    const T = todAt(sv.tod), wth = sv.weather;
    const grey = wth === 'rain' ? 0.55 : wth === 'fog' ? 0.35 : wth === 'snow' ? 0.4 : 0;
    const gcol = col(wth === 'snow' ? '#dfe6ee' : '#8a929c');
    const top = T.top.clone().lerp(gcol.clone().multiplyScalar(T.night ? 0.25 : 1), grey), hor = T.hor.clone().lerp(gcol.clone().multiplyScalar(T.night ? 0.3 : 1), grey);
    W.sky.material.uniforms.top.value.copy(top); W.sky.material.uniforms.bot.value.copy(hor);
    const fogC = T.fog.clone().lerp(gcol.clone().multiplyScalar(T.night ? 0.25 : 1), grey);
    W.scene.fog.color.copy(fogC); W.scene.background = fogC;
    const farD = (W.radius + 0.5) * WD.CHUNK;
    W.scene.fog.near = wth === 'fog' ? 25 : wth === 'rain' || wth === 'snow' ? 60 : farD * 0.3;
    W.scene.fog.far = wth === 'fog' ? 260 : wth === 'rain' || wth === 'snow' ? 650 : farD;
    const ang = (sv.tod - 6) / 12 * Math.PI, el = Math.sin(ang);
    W.sun.color.copy(T.sun); W.sun.intensity = T.sunI * (1 - grey * 0.6);
    W.sun.position.set(p.x + Math.cos(ang) * 160, p.y + Math.max(40, el * 200 + 60), p.z + 90);
    W.sun.target.position.set(p.x, p.y, p.z); W.sun.target.updateMatrixWorld();
    W.hemi.intensity = T.hemi * (1 - grey * 0.3);
    W.stars.material.opacity = T.night && wth === 'clear' ? 1 : 0;
    W.mat.lampHead.color.set(T.night || grey > 0.4 ? 0xfff0c0 : 0x777777);
    W.mat.building.emissiveIntensity = T.night ? 0.9 : 0;
    W.headlight.intensity = T.night || wth === 'fog' ? 2.2 : 0;
    W.water.position.x = Math.round(p.x / 1000) * 1000; W.water.position.z = Math.round(p.z / 1000) * 1000;
    W.water.material.map.offset.set(W.time * 0.004, W.time * 0.002);
    for (const r of Object.values(W.mat.road)) r.color.setScalar(wth === 'rain' ? 0.75 : 1);
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
    if (snowing) for (let k = 0; k < 8; k++) R._.emit(W.snowP, R.camera.position.x + (Math.random() - 0.5) * 90, R.camera.position.y + 25, R.camera.position.z + (Math.random() - 0.5) * 90, 0, -4, 0, 0.35, 0, 7, 1, 1, 1, 0.9);
    R._.updateParticles(W.snowP, dt);
    // машины
    const cars = world.cars;
    for (const c of cars) {
      const cm = W.carMeshes.get(c); if (!cm) continue;
      const x = c.ix !== undefined ? C.lerp(c.ix, c.x, alpha) : c.x, z = c.iz !== undefined ? C.lerp(c.iz, c.z, alpha) : c.z, y = c.iy !== undefined ? C.lerp(c.iy, c.y, alpha) : c.y;
      let h = c.h; if (c.ih !== undefined) { let dh = c.h - c.ih; if (dh > Math.PI) dh -= 2 * Math.PI; if (dh < -Math.PI) dh += 2 * Math.PI; h = c.ih + dh * alpha; }
      cm.root.position.set(x, y, z); cm.root.rotation.order = 'YXZ'; cm.root.rotation.y = h;
      const fx = Math.sin(h), fz = Math.cos(h);
      if (!c.air) { const yf = M.groundAt(x + fx * 1.8, z + fz * 1.8, gq).y, yb = M.groundAt(x - fx * 1.8, z - fz * 1.8, gq).y; cm.pitch += (-Math.atan2(yf - yb, 3.6) - cm.pitch) * Math.min(1, dt * 10); }
      else cm.pitch += (Math.max(-0.4, Math.min(0.4, -c.vy * 0.03)) - cm.pitch) * Math.min(1, dt * 3);
      cm.root.rotation.x = cm.pitch;
      const k2 = 1 - Math.exp(-dt * 8);
      cm.roll += (C.clamp(-(c.w || 0) * (c.speed || 0) * 0.006, -0.07, 0.07) - cm.roll) * k2; cm.body.rotation.z = cm.roll;
      cm.spin += (c.vLong || 0) * dt / cm.S.wr;
      for (const w of cm.wheels) { w.spin.rotation.x = cm.spin; if (w.front) w.pivot.rotation.y = c.steer; }
      cm.tailMat.emissiveIntensity = c.braking ? 2.4 : 0.6;
      cm.root.visible = !(camMode === 'hood' && c === p && !W.photo);
      // дым, пыль, снег
      const skid = Math.max(c.skidR || 0, (c.skidF || 0) * 0.6), loose = c.surf !== 'asphalt' && c.surf !== 'concrete';
      if (!c.air && (skid > 0.35 || (loose && c.speed > 9)) && Math.random() < 0.8 && Math.hypot(x - p.x, z - p.z) < 120) {
        const rz = -cm.L / 2 + cm.S.ax[0], hw = cm.W / 2 - 0.15, sn = Math.sin(h), cs = Math.cos(h);
        const colr = c.surf === 'snow' ? [0.95, 0.97, 1] : c.surf === 'sand' ? [0.85, 0.74, 0.55] : c.surf === 'gravel' || c.surf === 'grass' ? [0.6, 0.52, 0.4] : [0.86, 0.86, 0.88];
        for (const sd of [-1, 1]) R._.emit(W.parts, x + cs * hw * sd + sn * rz, y + 0.3, z - sn * hw * sd + cs * rz, -c.vx * 0.12 + (Math.random() - 0.5) * 2, 0.8, -c.vz * 0.12 + (Math.random() - 0.5) * 2, 1.1, 2.5, 1.0, colr[0], colr[1], colr[2], Math.min(0.42, 0.14 + skid * 0.3));
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
    // камера
    camera(dt, camMode);
    // небо и звёзды всегда внутри дальней плоскости камеры
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
      let ty = py + up; const gy = W.M.groundAt(tx, tz, gq).y; if (ty < gy + 1.2) ty = gy + 1.2;
      if (!st.init || Math.hypot(tx - st.x, tz - st.z) > 25) { st.x = tx; st.y = ty; st.z = tz; st.init = true; }
      const kk = 1 - Math.exp(-dt * 7); st.x += (tx - st.x) * kk; st.y += (ty - st.y) * kk; st.z += (tz - st.z) * kk;
      cam.position.set(st.x, st.y, st.z); tmpV.set(px + fx * 3, py + 1.1, pz + fz * 3); cam.lookAt(tmpV);
    }
    const fovT = 60 + Math.min(1, p.speed / 70) * 16 + (p.nitroOn ? 6 : 0);
    st.fov += (fovT - st.fov) * (1 - Math.exp(-dt * 3));
    cam.fov = W.photo ? 55 : st.fov; cam.near = 0.3; cam.far = farD; cam.updateProjectionMatrix();
    W.headlight.position.set(px + fx * 1.5, py + 1.2, pz + fz * 1.5); W.headlight.target.position.set(px + fx * 30, py, pz + fz * 30); W.headlight.target.updateMatrixWorld();
  }

  W.photoMode = function (on) { W.photo = on ? { yaw: (W.world.player.h || 0) + Math.PI + 0.6, pitch: 0.25, dist: 9 } : null; };
  W.photoMove = function (dyaw, dpitch, dzoom) { if (!W.photo) return; W.photo.yaw += dyaw; W.photo.pitch = C.clamp(W.photo.pitch + dpitch, -0.1, 1.3); W.photo.dist = C.clamp(W.photo.dist * dzoom, 3.5, 40); };
  W.breakBoard = function (pt) {
    const x = pt.x, z = pt.z, y = W.M.groundAt(x, z).y + 2;
    for (let k = 0; k < 40; k++) R._.emit(W.parts, x, y, z, (Math.random() - 0.5) * 14, Math.random() * 8, (Math.random() - 0.5) * 14, 0.6, 0.2, 1.2, 1, 0.5 + Math.random() * 0.4, 0.1, 1);
  };
  // Высота отрисованного рельефа под точкой (луч вниз по кускам) - для проверки «земля сетки = земля физики».
  W.meshHeight = function (x, z) {
    const ray = new THREE.Raycaster(new THREE.Vector3(x, 2000, z), new THREE.Vector3(0, -1, 0), 0, 5000);
    const objs = []; for (const ch of W.chunks.values()) objs.push(ch.group.children[0]);
    const hit = ray.intersectObjects(objs, false)[0];
    return hit ? hit.point.y : null;
  };
  W.info = function () { const lods = [0, 0, 0]; for (const ch of W.chunks.values()) lods[ch.lod]++; return { chunks: W.chunks.size, lods, built: W.built, pending: W.pending, cars: W.carMeshes.size }; };

  W.dispose = function () {
    if (!W.scene) return;
    for (const ch of W.chunks.values()) disposeChunk(ch);
    W.chunks.clear();
    for (const [c, cm] of W.carMeshes) { R._.disposeCar(cm); for (const o of cm.owned) if (o.dispose) o.dispose(); }
    W.carMeshes.clear();
    W.scene.traverse((o) => {
      if (o.isInstancedMesh) o.dispose();
      if (o.geometry && !Object.values(W.geo).includes(o.geometry)) o.geometry.dispose();
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => { if (m.map) m.map.dispose(); if (m.emissiveMap) m.emissiveMap.dispose(); m.dispose(); });
    });
    for (const o of W.owned) if (o && o.dispose) o.dispose();
    for (const g of Object.values(W.geo)) g.dispose();
    W.sun.dispose(); W.headlight.dispose();
    W.scene = null; W.world = null; W.owned = [];
  };
})();
