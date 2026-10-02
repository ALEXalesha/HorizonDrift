/* Horizon Drift - 3D: один рендерер на всё, витрина с машиной (меню и гараж), трасса из кода
   (лента по осевой линии, земля, стены, декор инстансами), машины, дым, следы шин, камера.
   Все текстуры рисуются на холсте - картинок и сети не нужно. */
(function () {
  'use strict';
  const D = window.DriftData, C = window.DriftCore;
  const R = { renderer: null, camera: null, scene: null, mode: 'none', q: D.QUALITY.high, settings: null };
  window.DriftRender = R;

  // ---------- помощники ----------
  function rngOf(seed) { return C.mulberry32(seed >>> 0); }
  function hash2(x, z) { let h = Math.imul(x | 0, 374761393) ^ Math.imul(z | 0, 668265263); h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
  function vnoise(x, z) {
    const xi = Math.floor(x), zi = Math.floor(z), xf = x - xi, zf = z - zi;
    const u = xf * xf * (3 - 2 * xf), v = zf * zf * (3 - 2 * zf);
    const a = hash2(xi, zi), b = hash2(xi + 1, zi), c = hash2(xi, zi + 1), d = hash2(xi + 1, zi + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }
  function fbm(x, z) { return vnoise(x, z) * 0.55 + vnoise(x * 2.1, z * 2.1) * 0.28 + vnoise(x * 4.3, z * 4.3) * 0.17; }
  const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  let disposables = [];
  function track(o) { disposables.push(o); return o; }
  // Собрать всё, что создано внутри fn, в отдельный список (для открытого мира со своим временем жизни).
  function capture(fn) { const saved = disposables; disposables = []; try { const r = fn(); return { r, owned: disposables }; } finally { disposables = saved; } }

  function canvasTex(w, h, draw, repeat, keep) {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    draw(c.getContext('2d'), w, h);
    const t = new THREE.CanvasTexture(c);
    t.encoding = THREE.sRGBEncoding;
    t.anisotropy = R.aniso || 1;
    if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; }
    if (!keep) track(t);
    return t;
  }
  function speckle(g, w, h, rng, n, colors, rmin, rmax) {
    for (let i = 0; i < n; i++) {
      g.fillStyle = colors[Math.floor(rng() * colors.length)];
      const r = rmin + rng() * (rmax - rmin);
      g.fillRect(rng() * w, rng() * h, r, r);
    }
  }
  function col(hex) { return new THREE.Color(hex); }

  // ---------- рендерер ----------
  // Свободный взгляд: yaw - поворот (0 - вперёд/за машиной), pitch - вверх-вниз, zoom - дальность облёта, back - взгляд назад.
  R.view = { yaw: 0, pitch: 0, zoom: 1, back: false };
  R.VIEW = { cockpitYaw: 2.618, cockpitPitch: 1.047, orbitPitchMin: -0.1745, orbitPitchMax: 1.2217, zoomMin: 0.6, zoomMax: 1.9 };
  // Камера облёта: от опоры за машиной по кругу (yaw), с наклоном (абсолютный угол над горизонтом) и дальностью.
  R.orbitOffset = function (fx, fz, back, up, view, out) {
    const base = Math.atan2(up, back), dist = Math.hypot(back, up) * view.zoom;
    const yaw = view.back ? Math.PI : view.yaw, el = Math.max(R.VIEW.orbitPitchMin, Math.min(R.VIEW.orbitPitchMax, base + view.pitch));
    const cs = Math.cos(yaw), sn = Math.sin(yaw), bx = -fx, bz = -fz, dx = bx * cs + bz * sn, dz = -bx * sn + bz * cs;
    out.x = dx * Math.cos(el) * dist; out.z = dz * Math.cos(el) * dist; out.y = Math.sin(el) * dist; out.free = !!(view.yaw || view.pitch || view.back || view.zoom !== 1);
    return out;
  };
  R.init = function (canvas) {
    const r = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    r.outputEncoding = THREE.sRGBEncoding;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.05;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    R.renderer = r;
    R.aniso = Math.min(8, r.capabilities.getMaxAnisotropy());
    R.camera = new THREE.PerspectiveCamera(62, 1, 0.3, 1200);
    R.resize();
    R.envMap = makeEnv();
    R.showroom = makeShowroom();
    R.cockpit = window.DriftCockpit ? window.DriftCockpit.create(R, D) : null;
    return r;
  };
  R.resize = function () {
    if (!R.renderer) return;
    const w = window.innerWidth, h = window.innerHeight;
    R.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2) * (R.q.pixelRatio || 1));
    R.renderer.setSize(w, h, false);
    R.camera.aspect = w / h; R.camera.updateProjectionMatrix();
  };
  R.applySettings = function (s) {
    R.settings = s;
    R.q = D.QUALITY[s.quality] || D.QUALITY.high;
    R.resize();
    const shadows = s.shadows && R.q.shadowMap > 0;
    R.renderer.shadowMap.enabled = shadows;
    if (R.race) {
      const far = D.DRAW_DIST[s.drawDist] || 1000;
      R.camera.far = far + 200; R.camera.updateProjectionMatrix();
      if (R.race.scene.fog) { R.race.scene.fog.near = far * 0.25; R.race.scene.fog.far = far; }
      if (R.race.sun) {
        R.race.sun.castShadow = shadows;
        const sz = R.q.shadowMap || 1024;
        if (R.race.sun.shadow.mapSize.x !== sz) { R.race.sun.shadow.mapSize.set(sz, sz); if (R.race.sun.shadow.map) { R.race.sun.shadow.map.dispose(); R.race.sun.shadow.map = null; } }
      }
      R.race.scene.traverse((o) => { if (o.material) o.material.needsUpdate = true; });
    }
  };

  // Карта отражений для блеска кузова: маленькая сцена с небом и светлыми панелями.
  function makeEnv() {
    const pm = new THREE.PMREMGenerator(R.renderer);
    const sc = new THREE.Scene();
    const sky = new THREE.Mesh(new THREE.SphereGeometry(10, 16, 8), new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false,
      vertexShader: 'varying vec3 p; void main(){ p = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: 'varying vec3 p; void main(){ float h = normalize(p).y; vec3 c = mix(vec3(0.18,0.16,0.2), vec3(0.75,0.82,0.95), smoothstep(-0.2,0.6,h)); gl_FragColor = vec4(c,1.0); }',
    }));
    sc.add(sky);
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(6, 1.2), new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide }));
    panel.position.set(0, 6, 0); panel.rotation.x = Math.PI / 2; sc.add(panel);
    const p2 = panel.clone(); p2.position.set(6, 2, 3); p2.rotation.set(0, -Math.PI / 2, 0); sc.add(p2);
    const t = pm.fromScene(sc, 0.03).texture;
    pm.dispose();
    return t;
  }

  // ======================= МАШИНЫ =======================
  // Силуэт сбоку: lower - нижняя часть кузова, cabin - стёкла, x от задка (0) к носу (L).
  const SHAPES = {
    hatch: { L: 3.9, W: 1.74, wr: 0.31, ax: [0.72, 3.18], lower: [[0, 0.3], [0, 0.9], [0.2, 0.97], [3.0, 0.97], [3.78, 0.8], [3.92, 0.55], [3.86, 0.3]],
      cabin: [[0.1, 0.92], [0.32, 1.42], [2.1, 1.45], [2.95, 0.92]], spoiler: 'lip' },
    coupe: { L: 4.3, W: 1.8, wr: 0.32, ax: [0.82, 3.45], lower: [[0, 0.32], [0.02, 0.86], [0.3, 0.92], [3.2, 0.9], [4.2, 0.72], [4.32, 0.5], [4.25, 0.3]],
      cabin: [[0.7, 0.88], [1.3, 1.3], [2.5, 1.32], [3.25, 0.88]], spoiler: 'lip' },
    fastback: { L: 4.4, W: 1.82, wr: 0.33, ax: [0.85, 3.5], lower: [[0, 0.32], [0.02, 0.84], [0.35, 0.9], [3.3, 0.88], [4.28, 0.68], [4.42, 0.46], [4.34, 0.3]],
      cabin: [[0.35, 0.87], [1.45, 1.28], [2.55, 1.29], [3.35, 0.86]], spoiler: 'wing' },
    rally: { L: 4.1, W: 1.8, wr: 0.35, ax: [0.75, 3.3], lower: [[0, 0.44], [0, 1.0], [0.2, 1.06], [3.1, 1.06], [3.95, 0.92], [4.1, 0.64], [4.0, 0.42]],
      cabin: [[0.18, 1.02], [0.4, 1.56], [2.2, 1.58], [3.02, 1.02]], spoiler: 'wing', scoop: true, lightbar: true },
    gt: { L: 4.6, W: 1.9, wr: 0.34, ax: [0.9, 3.7], lower: [[0, 0.3], [0.02, 0.82], [0.4, 0.9], [3.6, 0.86], [4.5, 0.66], [4.62, 0.45], [4.55, 0.28]],
      cabin: [[0.9, 0.85], [1.6, 1.24], [2.8, 1.25], [3.62, 0.85]], spoiler: 'lip' },
    muscle: { L: 4.8, W: 1.95, wr: 0.36, ax: [0.95, 3.85], lower: [[0, 0.36], [0, 0.96], [0.3, 1.0], [3.7, 1.0], [4.72, 0.92], [4.82, 0.6], [4.76, 0.34]],
      cabin: [[0.9, 0.97], [1.5, 1.38], [2.7, 1.38], [3.45, 0.97]], spoiler: 'lip', scoop: true },
    wedge: { L: 4.5, W: 1.98, wr: 0.34, ax: [0.9, 3.75], lower: [[0, 0.3], [0, 0.9], [0.3, 0.95], [1.5, 0.95], [4.4, 0.5], [4.52, 0.36], [4.46, 0.28]],
      cabin: [[0.95, 0.9], [1.55, 1.16], [2.35, 1.15], [3.25, 0.72]], spoiler: 'wing' },
    hyper: { L: 4.7, W: 2.02, wr: 0.35, ax: [0.95, 3.9], lower: [[0, 0.28], [0, 0.82], [0.5, 0.88], [1.5, 0.86], [4.6, 0.45], [4.72, 0.33], [4.66, 0.26]],
      cabin: [[1.1, 0.84], [1.85, 1.12], [2.65, 1.1], [3.45, 0.7]], spoiler: 'wing', fins: true },
  };
  R.SHAPES = SHAPES;

  function extrude(pts, depth, bevel) {
    const sh = new THREE.Shape();
    pts.forEach((p, i) => (i ? sh.lineTo(p[0], p[1]) : sh.moveTo(p[0], p[1])));
    const g = new THREE.ExtrudeGeometry(sh, { depth, bevelEnabled: !!bevel, bevelThickness: bevel || 0, bevelSize: bevel || 0, bevelSegments: 2, curveSegments: 4 });
    return g;
  }
  // Кузов: выдавливаем силуэт на ширину, ставим носом в +z и считаем развёртку под рисунок:
  // верх текстуры - вид сбоку, низ - вид сверху.
  function bodyGeom(pts, L, W, H) {
    const g = extrude(pts, W - 0.1, 0.05);
    g.translate(-L / 2, 0, -(W - 0.1) / 2);
    g.rotateY(-Math.PI / 2);
    const pos = g.attributes.position, uv = new Float32Array(pos.count * 2);
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
    for (let i = 0; i < pos.count; i += 3) {
      a.fromBufferAttribute(pos, i); b.fromBufferAttribute(pos, i + 1); c.fromBufferAttribute(pos, i + 2);
      n.subVectors(c, b).cross(a.clone().sub(b)).normalize();
      for (let k = 0; k < 3; k++) {
        const p = k === 0 ? a : k === 1 ? b : c;
        const u = (p.z + L / 2) / L;
        let v;
        if (Math.abs(n.y) > 0.55) v = 0.02 + 0.46 * (p.x / W + 0.5);
        else v = 0.52 + 0.46 * Math.min(1, p.y / H);
        uv[(i + k) * 2] = u; uv[(i + k) * 2 + 1] = v;
      }
    }
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.computeVertexNormals();
    return g;
  }

  let liveryCache = {};
  function liveryTex(carId, look, own) {
    const key = [carId, look.color, look.color2, look.livery].join('|');
    if (!own && liveryCache[key]) return liveryCache[key];
    const t = canvasTex(512, 512, (g, w, h) => {
      g.fillStyle = look.color; g.fillRect(0, 0, w, h);
      const c2 = look.color2, rng = rngOf(C.hashStr(key));
      // лёгкий перелив для глубины цвета
      const gr = g.createLinearGradient(0, 0, 0, 256); gr.addColorStop(0, 'rgba(255,255,255,0.10)'); gr.addColorStop(1, 'rgba(0,0,0,0.18)');
      g.fillStyle = gr; g.fillRect(0, 0, w, 256);
      g.fillStyle = c2; g.strokeStyle = c2;
      const side = (fn) => { g.save(); g.beginPath(); g.rect(0, 0, w, 256); g.clip(); fn(); g.restore(); };
      const top = (fn) => { g.save(); g.beginPath(); g.rect(0, 256, w, 256); g.clip(); fn(); g.restore(); };
      switch (look.livery) {
        case 'stripes':
          top(() => { g.fillRect(0, 256 + 100, w, 18); g.fillRect(0, 256 + 138, w, 18); });
          side(() => { g.fillRect(0, 150, w, 10); });
          break;
        case 'flames':
          side(() => {
            for (let k = 0; k < 7; k++) {
              const y = 120 + k * 14, len = 140 + rng() * 150;
              g.beginPath(); g.moveTo(w, y - 12); g.bezierCurveTo(w - len * 0.4, y - 26, w - len * 0.7, y + 8, w - len, y);
              g.bezierCurveTo(w - len * 0.6, y + 16, w - len * 0.3, y + 14, w, y + 12); g.fill();
            }
          });
          top(() => { for (let k = 0; k < 5; k++) { const y = 256 + 60 + k * 30, len = 90 + rng() * 80; g.beginPath(); g.moveTo(w, y); g.quadraticCurveTo(w - len * 0.5, y - 20, w - len, y + 10); g.quadraticCurveTo(w - len * 0.5, y + 22, w, y + 22); g.fill(); } });
          break;
        case 'checker':
          side(() => { for (let x = 0; x < w; x += 16) for (let y = 170; y < 202; y += 16) if (((x + y) / 16) % 2 === 0) g.fillRect(x, y, 16, 16); });
          top(() => { for (let x = w - 150; x < w; x += 20) for (let y = 256; y < 512; y += 20) if (((x + y) / 20) % 2 === 0) g.fillRect(x, y, 20, 20); });
          break;
        case 'number': {
          const num = String(2 + Math.floor(rng() * 97));
          side(() => { g.fillStyle = '#f4f4f4'; g.beginPath(); g.arc(w * 0.47, 150, 44, 0, Math.PI * 2); g.fill(); g.fillStyle = '#111'; g.font = 'bold 56px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(num, w * 0.47, 152); g.fillStyle = c2; g.fillRect(0, 196, w, 8); });
          top(() => { g.fillStyle = '#f4f4f4'; g.beginPath(); g.arc(w * 0.45, 384, 50, 0, Math.PI * 2); g.fill(); g.fillStyle = '#111'; g.font = 'bold 60px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(num, w * 0.45, 386); });
          break;
        }
        case 'split':
          side(() => { g.beginPath(); g.moveTo(0, 256); g.lineTo(0, 130); g.lineTo(w * 0.45, 190); g.lineTo(w, 190); g.lineTo(w, 256); g.fill(); });
          top(() => { g.fillRect(0, 256, w * 0.4, 256); });
          break;
        case 'shards':
          side(() => { for (let k = 0; k < 16; k++) { const x = rng() * w, y = 110 + rng() * 120; g.beginPath(); g.moveTo(x, y); g.lineTo(x + 20 + rng() * 60, y + (rng() - 0.5) * 50); g.lineTo(x + rng() * 30, y + 20 + rng() * 30); g.fill(); } });
          top(() => { for (let k = 0; k < 12; k++) { const x = rng() * w, y = 256 + rng() * 256; g.beginPath(); g.moveTo(x, y); g.lineTo(x + 30 + rng() * 50, y + (rng() - 0.5) * 60); g.lineTo(x + rng() * 30, y + 30); g.fill(); } });
          break;
        default: break;
      }
    }, false, true);
    if (!own) liveryCache[key] = t;
    return t;
  }

  let rimCache = {};
  function rimTex(style, color, own) {
    const key = style + color;
    if (!own && rimCache[key]) return rimCache[key];
    const t = canvasTex(128, 128, (g, w) => {
      const c = w / 2;
      g.fillStyle = '#1a1b1e'; g.fillRect(0, 0, w, w);
      g.fillStyle = color; g.strokeStyle = color;
      g.beginPath(); g.arc(c, c, 60, 0, Math.PI * 2); g.lineWidth = 8; g.stroke();
      if (style === 'solid') { g.beginPath(); g.arc(c, c, 56, 0, Math.PI * 2); g.fill(); g.fillStyle = 'rgba(0,0,0,0.25)'; g.beginPath(); g.arc(c, c, 40, 0, Math.PI * 2); g.fill(); }
      else if (style === 'mesh') { g.lineWidth = 3; for (let k = 0; k < 12; k++) { const a = k / 12 * Math.PI * 2; g.beginPath(); g.moveTo(c, c); g.lineTo(c + Math.cos(a) * 58, c + Math.sin(a) * 58); g.stroke(); g.beginPath(); g.moveTo(c + Math.cos(a) * 58, c + Math.sin(a) * 58); g.lineTo(c + Math.cos(a + 0.8) * 30, c + Math.sin(a + 0.8) * 30); g.stroke(); } }
      else if (style === 'turbine') { for (let k = 0; k < 10; k++) { const a = k / 10 * Math.PI * 2; g.beginPath(); g.moveTo(c + Math.cos(a) * 14, c + Math.sin(a) * 14); g.quadraticCurveTo(c + Math.cos(a + 0.5) * 40, c + Math.sin(a + 0.5) * 40, c + Math.cos(a + 0.6) * 58, c + Math.sin(a + 0.6) * 58); g.lineTo(c + Math.cos(a + 0.85) * 58, c + Math.sin(a + 0.85) * 58); g.closePath(); g.fill(); } }
      else { g.lineWidth = 12; for (let k = 0; k < 5; k++) { const a = k / 5 * Math.PI * 2; g.beginPath(); g.moveTo(c, c); g.lineTo(c + Math.cos(a) * 58, c + Math.sin(a) * 58); g.stroke(); } }
      g.fillStyle = '#2a2b2f'; g.beginPath(); g.arc(c, c, 12, 0, Math.PI * 2); g.fill();
      g.fillStyle = color; g.beginPath(); g.arc(c, c, 6, 0, Math.PI * 2); g.fill();
    }, false, true);
    if (!own) rimCache[key] = t;
    return t;
  }
  function clearCarTexCaches() {
    for (const k in liveryCache) liveryCache[k].dispose();
    for (const k in rimCache) rimCache[k].dispose();
    liveryCache = {}; rimCache = {};
  }

  let blobTex = null;
  function getBlob() {
    if (!blobTex) blobTex = canvasTex(64, 64, (g, w) => { const gr = g.createRadialGradient(w / 2, w / 2, 4, w / 2, w / 2, w / 2); gr.addColorStop(0, 'rgba(0,0,0,0.75)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(0, 0, w, w); }, false, true);
    return blobTex;
  }

  // Машина: кузов, стёкла, крыша, колёса с дисками, фары, стопы, спойлер, тень-пятно.
  function buildCar(carId, look, opts) {
    opts = opts || {};
    const def = C.carDef(carId), S = SHAPES[def.shape] || SHAPES.coupe;
    const liv = liveryTex(carId, look, opts.own), rim = rimTex(look.rims, look.rimColor, opts.own);
    const L = S.L, W = S.W, grp = new THREE.Group();
    const H = Math.max.apply(null, S.lower.map((p) => p[1]));
    const paint = new THREE.MeshStandardMaterial({ map: liv, metalness: 0.45, roughness: 0.32, envMap: R.envMap, envMapIntensity: 0.9 });
    const glass = new THREE.MeshStandardMaterial({ color: 0x0c1016, metalness: 0.6, roughness: 0.12, envMap: R.envMap, envMapIntensity: 1.2 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x16171a, metalness: 0.2, roughness: 0.7 });
    const body = new THREE.Mesh(bodyGeom(S.lower, L, W, H), paint);
    body.castShadow = true; grp.add(body);
    const cab = new THREE.Mesh(extrude(S.cabin, W - 0.34, 0.04), glass);
    cab.geometry.translate(-L / 2, 0, -(W - 0.34) / 2); cab.geometry.rotateY(-Math.PI / 2); cab.castShadow = true; grp.add(cab);
    // крыша - полоска цвета кузова поверх стёкол
    const cb = S.cabin, roofPts = [[cb[1][0] + 0.05, cb[1][1] - 0.04], [cb[1][0] + 0.08, cb[1][1] + 0.03], [cb[2][0] - 0.05, cb[2][1] + 0.03], [cb[2][0] - 0.02, cb[2][1] - 0.04]];
    const roof = new THREE.Mesh(extrude(roofPts, W - 0.4, 0.02), paint);
    roof.geometry.translate(-L / 2, 0, -(W - 0.4) / 2); roof.geometry.rotateY(-Math.PI / 2); grp.add(roof);
    // бампер-юбка
    const skirt = new THREE.Mesh(new THREE.BoxGeometry(W - 0.02, 0.12, L - 0.1), dark); skirt.position.y = S.lower[0][1] + 0.02; grp.add(skirt);
    if (S.spoiler === 'wing') {
      const wing = new THREE.Mesh(new THREE.BoxGeometry(W - 0.1, 0.05, 0.35), dark); wing.position.set(0, H + 0.32, -L / 2 + 0.25); grp.add(wing);
      for (const sx of [-0.55, 0.55]) { const post = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.3, 0.12), dark); post.position.set(sx, H + 0.16, -L / 2 + 0.3); grp.add(post); }
    } else if (S.spoiler === 'lip') {
      const lip = new THREE.Mesh(new THREE.BoxGeometry(W - 0.2, 0.05, 0.2), dark); lip.position.set(0, H + 0.03, -L / 2 + 0.12); grp.add(lip);
    }
    if (S.scoop) { const sc = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.1, 0.8), dark); sc.position.set(0, H + 0.04, L / 2 - 1.3); grp.add(sc); }
    if (S.fins) for (const sx of [-0.7, 0.7]) { const f = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.35, 0.9), paint); f.position.set(sx, H + 0.1, -L / 2 + 0.7); grp.add(f); }
    // фары и стопы
    const headMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff4d6, emissiveIntensity: 1.2 });
    const tailMat = new THREE.MeshStandardMaterial({ color: 0x550000, emissive: 0xff1a1a, emissiveIntensity: 0.6 });
    const front = S.lower[S.lower.length - 2], rearY = S.lower[1][1] - 0.18;
    for (const sx of [-1, 1]) {
      const hl = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.1, 0.08), headMat); hl.position.set(sx * (W / 2 - 0.35), front[1] + 0.05, front[0] - L / 2 + 0.02); grp.add(hl);
      const tl = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.1, 0.06), tailMat); tl.position.set(sx * (W / 2 - 0.33), rearY, -L / 2 - 0.08); grp.add(tl);
    }
    if (S.lightbar) { const lb = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.1, 0.1), headMat); lb.position.set(0, S.cabin[2][1] + 0.08, S.cabin[2][0] - L / 2 - 0.1); grp.add(lb); }
    // колёса
    const tyreMat = new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.9 });
    const rimMat = new THREE.MeshStandardMaterial({ map: rim, metalness: 0.7, roughness: 0.3, envMap: R.envMap });
    const tyreG = new THREE.CylinderGeometry(S.wr, S.wr, 0.27, 20); tyreG.rotateZ(Math.PI / 2);
    const rimG = new THREE.CylinderGeometry(S.wr * 0.7, S.wr * 0.7, 0.285, 20); rimG.rotateZ(Math.PI / 2);
    const wheels = [];
    for (const [ai, zx] of [[0, S.ax[0]], [1, S.ax[1]]]) {
      for (const sx of [-1, 1]) {
        const pivot = new THREE.Group(); pivot.position.set(sx * (W / 2 - 0.12), S.wr, zx - L / 2);
        const spin = new THREE.Group(); pivot.add(spin);
        const t = new THREE.Mesh(tyreG, tyreMat); t.castShadow = true; spin.add(t);
        const rm = new THREE.Mesh(rimG, [dark, rimMat, rimMat]); spin.add(rm);
        grp.add(pivot); wheels.push({ pivot, spin, front: ai === 1 });
      }
    }
    const blob = new THREE.Mesh(new THREE.PlaneGeometry(W + 0.8, L + 0.9), new THREE.MeshBasicMaterial({ map: getBlob(), transparent: true, depthWrite: false }));
    blob.rotation.x = -Math.PI / 2; blob.position.y = 0.04; blob.renderOrder = 1;
    const root = new THREE.Group(); root.add(grp); root.add(blob);
    return { root, body: grp, paint, rimMat, headMat, tailMat, wheels, blob, S, L, W, carId, look: Object.assign({}, look), mats: [paint, glass, dark, headMat, tailMat, tyreMat, rimMat], ownTex: opts.own ? [liv, rim] : [] };
  }
  R.buildCar = buildCar;
  function disposeCar(cm) {
    if (!cm) return;
    cm.root.traverse((o) => { if (o.geometry && o.geometry !== undefined) o.geometry.dispose(); });
    for (const m of cm.mats) m.dispose();
    for (const t of cm.ownTex || []) t.dispose();
    cm.root.children[1].material.dispose();
  }

  // ======================= ВИТРИНА (меню, гараж) =======================
  function makeShowroom() {
    const sc = new THREE.Scene();
    sc.background = new THREE.Color(0x0b0a14);
    sc.fog = new THREE.Fog(0x0b0a14, 18, 46);
    sc.add(new THREE.HemisphereLight(0x9aa6ff, 0x221a2a, 0.55));
    const key = new THREE.DirectionalLight(0xffffff, 1.1); key.position.set(4, 8, 5); sc.add(key);
    const rim = new THREE.DirectionalLight(0xff7a3a, 0.8); rim.position.set(-6, 3, -6); sc.add(rim);
    const floorTex = canvasTex(512, 512, (g, w) => {
      g.fillStyle = '#0e0d14'; g.fillRect(0, 0, w, w);
      g.strokeStyle = 'rgba(255,110,40,0.16)'; g.lineWidth = 2;
      for (let i = 0; i <= w; i += 32) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, w); g.stroke(); g.beginPath(); g.moveTo(0, i); g.lineTo(w, i); g.stroke(); }
    }, true, true);
    floorTex.repeat.set(10, 10);
    const floor = new THREE.Mesh(new THREE.CircleGeometry(40, 48), new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.85, metalness: 0.1 }));
    floor.rotation.x = -Math.PI / 2; sc.add(floor);
    const plat = new THREE.Mesh(new THREE.CylinderGeometry(3.6, 3.8, 0.18, 48), new THREE.MeshStandardMaterial({ color: 0x17161f, roughness: 0.55, metalness: 0.5, envMap: R.envMap, envMapIntensity: 0.4 }));
    plat.position.y = 0.09; sc.add(plat);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(3.7, 0.04, 8, 64), new THREE.MeshBasicMaterial({ color: 0xff6a1a }));
    ring.rotation.x = Math.PI / 2; ring.position.y = 0.19; sc.add(ring);
    // стена-полукруг с неоновыми полосами
    const wallTex2 = canvasTex(1024, 256, (g, w, h) => {
      const gr = g.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, '#07060c'); gr.addColorStop(1, '#161223'); g.fillStyle = gr; g.fillRect(0, 0, w, h);
      g.fillStyle = 'rgba(255,255,255,0.03)'; for (let x = 0; x < w; x += 64) g.fillRect(x, 0, 2, h);
      const line = (y, c, a) => { g.fillStyle = c; g.globalAlpha = a; g.fillRect(0, y, w, 3); g.globalAlpha = a * 0.25; g.fillRect(0, y - 4, w, 11); g.globalAlpha = 1; };
      line(150, '#ff5a1f', 0.9); line(170, '#9a4dff', 0.7); line(60, '#19d3ff', 0.35);
    }, true, true);
    wallTex2.repeat.set(3, 1);
    const wall = new THREE.Mesh(new THREE.CylinderGeometry(20, 20, 10, 64, 1, true), new THREE.MeshBasicMaterial({ map: wallTex2, side: THREE.BackSide }));
    wall.position.y = 5; sc.add(wall);
    const spot = new THREE.SpotLight(0xffe2c4, 0.7, 30, 0.5, 0.6, 1); spot.position.set(0, 9, 2); spot.target.position.set(0, 0, 0); sc.add(spot); sc.add(spot.target);
    const turn = new THREE.Group(); turn.position.y = 0.18; sc.add(turn);
    return { scene: sc, turn, car: null, angle: 0.6, spin: true, drag: 0, view: 'menu' };
  }
  R.setShowroomCar = function (carId, look) {
    const sr = R.showroom;
    if (sr.car && sr.car.carId === carId && JSON.stringify(sr.car.look) === JSON.stringify(look)) return;
    if (sr.car) { sr.turn.remove(sr.car.root); disposeCar(sr.car); }
    sr.car = buildCar(carId, look, { own: true });
    sr.turn.add(sr.car.root);
  };
  R.showroomView = function (v) { R.showroom.view = v; };
  R.rotateShowroom = function (dx) { R.showroom.angle += dx; R.showroom.drag = 2; };

  function renderShowroom(dt) {
    const sr = R.showroom, cam = R.camera;
    if (sr.drag > 0) sr.drag -= dt; else sr.angle += dt * 0.35;
    sr.turn.rotation.y = sr.angle;
    // машина - в центре свободной части экрана: справа от меню или между списком и панелью гаража
    const W = window.innerWidth, H = window.innerHeight;
    let cx = W * 0.66, dist = 10.5;
    if (sr.view === 'garage') {
      const st = document.getElementById('gStage'), r = st && st.getBoundingClientRect();
      if (r && r.width > 0) cx = r.left + r.width / 2;
      dist = 9 + Math.max(0, 900 - (r ? r.width : 600)) / 150;
    }
    cam.fov = 38; cam.near = 0.1; cam.far = 80;
    cam.setViewOffset(W, H, W / 2 - cx, 0, W, H);
    cam.position.set(dist * 0.55, 2.5, dist * 0.85);
    cam.lookAt(0, 0.75, 0);
    cam.updateProjectionMatrix();
    R.renderer.render(sr.scene, cam);
    cam.clearViewOffset();
  }

  // ======================= ТРАССА =======================
  function surfaceTex(kind) {
    const rng = rngOf(C.hashStr(kind));
    if (kind === 'asphalt') return canvasTex(256, 512, (g, w, h) => {
      g.fillStyle = '#2d2e32'; g.fillRect(0, 0, w, h);
      speckle(g, w, h, rng, 5000, ['#232428', '#393a3f', '#2a2b2f', '#44454a'], 1, 2.5);
      g.fillStyle = 'rgba(0,0,0,0.18)'; g.fillRect(w * 0.18, 0, w * 0.14, h); g.fillRect(w * 0.68, 0, w * 0.14, h);
      g.fillStyle = '#e8e8e8'; g.fillRect(w * 0.025, 0, 6, h); g.fillRect(w * 0.975 - 6, 0, 6, h);
      g.fillStyle = '#e8d24a'; g.fillRect(w / 2 - 3, 0, 6, h * 0.45);
    }, true);
    if (kind === 'gravel') return canvasTex(256, 512, (g, w, h) => {
      g.fillStyle = '#8a7a64'; g.fillRect(0, 0, w, h);
      speckle(g, w, h, rng, 9000, ['#6e604e', '#a39279', '#7d6d58', '#b5a589', '#5a4e40'], 1, 3);
      g.fillStyle = 'rgba(60,45,30,0.25)'; g.fillRect(w * 0.2, 0, w * 0.12, h); g.fillRect(w * 0.68, 0, w * 0.12, h);
    }, true);
    if (kind === 'snow') return canvasTex(256, 512, (g, w, h) => {
      // укатанный снег: серее сугробов, с колеями и синими пунктирами по краям
      g.fillStyle = '#aeb8c6'; g.fillRect(0, 0, w, h);
      speckle(g, w, h, rng, 5000, ['#9eaaba', '#c3ccd8', '#a3aebd', '#b8c1cd'], 1, 3);
      g.fillStyle = 'rgba(70,82,100,0.35)'; g.fillRect(w * 0.2, 0, w * 0.12, h); g.fillRect(w * 0.68, 0, w * 0.12, h);
      g.fillStyle = '#3f7fd0'; for (let y = 0; y < h; y += 64) { g.fillRect(w * 0.03, y, 5, 32); g.fillRect(w * 0.97 - 5, y, 5, 32); }
    }, true);
    const pal = { concrete: ['#8d8f94', ['#7d7f84', '#9fa1a6', '#86888d']], sand: ['#d8c090', ['#c9ae7c', '#e6d2a6', '#bfa575']], grass: ['#4f7a34', ['#446c2c', '#5f8c3e', '#3b5f26', '#6c9646']],
      snowbank: ['#f0f4f8', ['#dfe7f0', '#ffffff', '#d0dae6']], redsand: ['#c4764a', ['#b3673d', '#d4885a', '#a65a33']], snowground: ['#eef3f8', ['#dde6f0', '#ffffff']] };
    const p = pal[kind] || pal.concrete;
    return canvasTex(256, 256, (g, w, h) => { g.fillStyle = p[0]; g.fillRect(0, 0, w, h); speckle(g, w, h, rng, 6000, p[1], 1, 4); }, true);
  }
  function wallTex(kind) {
    return canvasTex(256, 64, (g, w, h) => {
      if (kind === 'rail') {
        g.fillStyle = '#9aa1a8'; g.fillRect(0, 0, w, h); g.fillStyle = '#c5cbd1'; g.fillRect(0, 8, w, 20); g.fillStyle = '#6f757c'; g.fillRect(0, 28, w, 4);
        g.fillStyle = '#4b5056'; for (let x = 10; x < w; x += 64) g.fillRect(x, 0, 8, h);
      } else if (kind === 'tyres') {
        g.fillStyle = '#1b1b1d'; g.fillRect(0, 0, w, h);
        for (let x = 0; x < w; x += 32) for (let y = 0; y < h; y += 32) { g.fillStyle = (x / 32 + y / 32) % 2 ? '#e8e8e8' : '#d8342a'; g.fillRect(x + 2, y + 13, 28, 6); }
      } else if (kind === 'logs') {
        g.fillStyle = '#6b4a2b'; g.fillRect(0, 0, w, h);
        for (let y = 0; y < h; y += 16) { g.fillStyle = y % 32 ? '#7c5634' : '#5e4025'; g.fillRect(0, y, w, 14); }
      } else if (kind === 'snowwall') {
        g.fillStyle = '#f2f6fa'; g.fillRect(0, 0, w, h); const r = rngOf(7); speckle(g, w, h, r, 900, ['#dae3ee', '#ffffff', '#c9d5e3'], 2, 6);
      } else {
        g.fillStyle = '#a7a9ad'; g.fillRect(0, 0, w, h); g.fillStyle = '#8b8d91'; g.fillRect(0, h - 14, w, 14);
        for (let x = 0; x < w; x += 64) { g.fillStyle = (x / 64) % 2 ? '#e8b020' : '#2a2a2a'; g.fillRect(x, 6, 64, 8); }
        g.fillStyle = '#7f8185'; for (let x = 63; x < w; x += 64) g.fillRect(x, 0, 2, h);
      }
    }, true);
  }

  // Лента вдоль осевой линии: от смещения d0 до d1, высота +dy, v по длине с шагом vScale метров.
  function ribbon(tr, i0, i1, d0, d1, dy, vScale, uFlip) {
    const pos = [], uv = [], idx = [];
    let n = 0;
    for (let k = i0; k <= i1; k++) {
      const i = tr.closed ? k % tr.N : Math.min(k, tr.N - 1);
      const s = k >= tr.N ? tr.L + tr.s[i] : tr.s[i];
      const y = tr.y[i] + dy;
      pos.push(tr.x[i] + tr.nx[i] * d0, y, tr.z[i] + tr.nz[i] * d0, tr.x[i] + tr.nx[i] * d1, y, tr.z[i] + tr.nz[i] * d1);
      uv.push(uFlip ? 1 : 0, s / vScale, uFlip ? 0 : 1, s / vScale);
      if (n > 0) { const a = (n - 1) * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
      n++;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx); g.computeVertexNormals();
    return track(g);
  }
  function wallRibbon(tr, d, h, vScale) {
    const pos = [], uv = [], idx = [];
    const last = tr.closed ? tr.N : tr.N - 1;
    for (let k = 0; k <= last; k++) {
      const i = k % tr.N, s = k >= tr.N ? tr.L : tr.s[i];
      const x = tr.x[i] + tr.nx[i] * d, z = tr.z[i] + tr.nz[i] * d, y = tr.y[i];
      pos.push(x, y - 0.6, z, x, y + h, z);
      uv.push(s / vScale, 0, s / vScale, 1);
      if (k > 0) { const a = (k - 1) * 2; if (d > 0) idx.push(a, a + 1, a + 2, a + 2, a + 1, a + 3); else idx.push(a, a + 2, a + 1, a + 2, a + 3, a + 1); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx); g.computeVertexNormals();
    return track(g);
  }

  // Ближайшая точка трассы для любой точки мира (для земли и декора).
  function nearestFn(tr) {
    const stepC = 6;
    return function (x, z) {
      let best = 1e18, bi = 0;
      for (let k = 0; k < tr.N; k += stepC) { const dx = tr.x[k] - x, dz = tr.z[k] - z, d = dx * dx + dz * dz; if (d < best) { best = d; bi = k; } }
      for (let j = bi - stepC; j <= bi + stepC; j++) {
        let i = j; if (tr.closed) i = (i + tr.N) % tr.N; else if (i < 0 || i >= tr.N) continue;
        const dx = tr.x[i] - x, dz = tr.z[i] - z, d = dx * dx + dz * dz; if (d < best) { best = d; bi = i; }
      }
      return { dist: Math.sqrt(best), i: bi, lat: (x - tr.x[bi]) * tr.nx[bi] + (z - tr.z[bi]) * tr.nz[bi], y: tr.y[bi] };
    };
  }
  function insideFn(tr) {
    const px = [], pz = [];
    for (let i = 0; i < tr.N; i += 4) { px.push(tr.x[i]); pz.push(tr.z[i]); }
    return function (x, z) {
      let inside = false;
      for (let i = 0, j = px.length - 1; i < px.length; j = i++) {
        if ((pz[i] > z) !== (pz[j] > z) && x < (px[j] - px[i]) * (z - pz[i]) / (pz[j] - pz[i]) + px[i]) inside = !inside;
      }
      return inside;
    };
  }

  function makeHeightFn(tr, theme) {
    const near = nearestFn(tr), inside = tr.closed ? insideFn(tr) : () => false;
    // плоскость через трассу (для склонов гор)
    let sx = 0, sz = 0, sy = 0, sxx = 0, szz = 0, sxz = 0, sxy = 0, szy = 0; const n = tr.N;
    for (let i = 0; i < n; i++) { const x = tr.x[i], z = tr.z[i], y = tr.y[i]; sx += x; sz += z; sy += y; sxx += x * x; szz += z * z; sxz += x * z; sxy += x * y; szy += z * y; }
    const mx = sx / n, mz = sz / n, my = sy / n;
    const cxx = sxx / n - mx * mx, czz = szz / n - mz * mz, cxz = sxz / n - mx * mz, cxy = sxy / n - mx * my, czy = szy / n - mz * my;
    const det = cxx * czz - cxz * cxz || 1;
    const pa = (cxy * czz - czy * cxz) / det, pb = (czy * cxx - cxy * cxz) / det;
    const plane = (x, z) => my + pa * (x - mx) + pb * (z - mz);
    const W = tr.W, kind = theme.terrain;
    const fn = function (x, z) {
      const nr = near(x, z), base = nr.y - 0.35, d = nr.dist;
      const nz = fbm(x * 0.012, z * 0.012);
      let h;
      if (kind === 'flat' || kind === 'port') h = base + smooth(W + 20, W + 200, d) * (nz - 0.5) * 2;
      else if (kind === 'coast') h = inside(x, z) ? base + smooth(W + 4, W + 70, d) * (nz * 22 + 3) : base - Math.min(14, Math.max(0, d - W - 3) * 0.22);
      else if (kind === 'lake') h = inside(x, z) ? base + (theme.water.level - 0.6 - base) * smooth(W + 3, W + 22, d) : base + smooth(W + 5, W + 60, d) * (nz * 16 + 3);
      else if (kind === 'canyon') h = base + smooth(W + 6, W + 34, d) * (16 + nz * 18) + (d > W + 40 ? (vnoise(x * 0.05, z * 0.05) > 0.62 ? 10 : 0) : 0);
      else if (kind === 'slope') { const far = plane(x, z) + (nz - 0.4) * 26 + Math.max(0, d - W) * 0.1; h = base + (far - base) * smooth(W + 3, W + 45, d); h = Math.max(h, base - 30); }
      else h = base + smooth(W + 4, W + 50, d) * (nz * 14 + 2);
      if (d < W + 1.5) h = Math.min(h, base);
      return h;
    };
    fn.near = near; fn.inside = inside;
    return fn;
  }

  function terrainMesh(tr, theme, hf, bbox) {
    const size = Math.max(bbox.maxx - bbox.minx, bbox.maxz - bbox.minz) + 900;
    const cx = (bbox.minx + bbox.maxx) / 2, cz = (bbox.minz + bbox.maxz) / 2;
    const seg = Math.round(Math.min(200, Math.max(110, size / 7)) * Math.min(1, 0.6 + 0.4 * (R.q.decor || 1)));
    const g = new THREE.PlaneGeometry(size, size, seg, seg); g.rotateX(-Math.PI / 2);
    const pos = g.attributes.position, colors = new Float32Array(pos.count * 3);
    const baseCol = col({ grass: '#5d8a3a', sand: '#d9c292', redsand: '#c67a4c', snow: '#eef3f8', concrete: '#7b7d82' }[theme.ground] || '#6a8a4a');
    const rock = col(theme.ground === 'snow' ? '#8a929e' : theme.ground === 'redsand' ? '#9a4f30' : '#7d7466');
    const dirt = col(theme.ground === 'snow' ? '#dfe6ee' : '#6d5a44');
    const tmp = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i) + cx, z = pos.getZ(i) + cz;
      pos.setX(i, x); pos.setZ(i, z);
      pos.setY(i, hf(x, z));
    }
    g.computeVertexNormals();
    const nrm = g.attributes.normal;
    for (let i = 0; i < pos.count; i++) {
      const slope = 1 - nrm.getY(i);
      tmp.copy(baseCol).lerp(rock, smooth(0.12, 0.45, slope));
      const v = 0.9 + hash2(i, 7) * 0.2; tmp.multiplyScalar(v);
      if (theme.ground !== 'concrete') { const nr = hf.near(pos.getX(i), pos.getZ(i)); if (nr.dist < tr.W + 6) tmp.lerp(dirt, 0.35); }
      colors[i * 3] = tmp.r; colors[i * 3 + 1] = tmp.g; colors[i * 3 + 2] = tmp.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    track(g);
    const tex = surfaceTex(theme.ground === 'snow' ? 'snowground' : theme.ground); tex.repeat.set(size / 18, size / 18);
    const m = new THREE.Mesh(g, track(new THREE.MeshLambertMaterial({ map: tex, vertexColors: true })));
    m.receiveShadow = true;
    return m;
  }

  // ---------- декор ----------
  function mergeGeoms(parts) {
    // parts: [{geo, color, matrix}] -> одна геометрия с цветами вершин
    const pos = [], nor = [], colr = [];
    const m3 = new THREE.Matrix3();
    for (const p of parts) {
      const g = p.geo.index ? p.geo.toNonIndexed() : p.geo;
      if (p.matrix) g.applyMatrix4(p.matrix);
      const c = col(p.color), P = g.attributes.position, N = g.attributes.normal;
      for (let i = 0; i < P.count; i++) { pos.push(P.getX(i), P.getY(i), P.getZ(i)); nor.push(N.getX(i), N.getY(i), N.getZ(i)); colr.push(c.r, c.g, c.b); }
      m3.identity();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(colr, 3));
    return track(g);
  }
  const M4 = (x, y, z, sx, sy, sz, ry) => { const m = new THREE.Matrix4(); m.compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, ry || 0, 0)), new THREE.Vector3(sx || 1, sy || 1, sz || 1)); return m; };

  const PROPS = {
    tree: () => mergeGeoms([{ geo: new THREE.CylinderGeometry(0.25, 0.35, 3, 6), color: '#6b4a2e', matrix: M4(0, 1.5, 0) },
      { geo: new THREE.IcosahedronGeometry(2.4, 0), color: '#4f8a36', matrix: M4(0, 4.4, 0, 1, 1.1, 1) }, { geo: new THREE.IcosahedronGeometry(1.7, 0), color: '#5d9a40', matrix: M4(0.9, 5.6, 0.4) }]),
    pine: () => mergeGeoms([{ geo: new THREE.CylinderGeometry(0.22, 0.3, 2.4, 6), color: '#5e412a', matrix: M4(0, 1.2, 0) },
      { geo: new THREE.ConeGeometry(2.3, 4, 7), color: '#2f6a3a', matrix: M4(0, 4, 0) }, { geo: new THREE.ConeGeometry(1.7, 3.4, 7), color: '#377a43', matrix: M4(0, 6.2, 0) }, { geo: new THREE.ConeGeometry(1.1, 2.6, 7), color: '#3f8a4b', matrix: M4(0, 8.1, 0) }]),
    snowpine: () => mergeGeoms([{ geo: new THREE.CylinderGeometry(0.22, 0.3, 2.4, 6), color: '#5e412a', matrix: M4(0, 1.2, 0) },
      { geo: new THREE.ConeGeometry(2.3, 4, 7), color: '#2f5a44', matrix: M4(0, 4, 0) }, { geo: new THREE.ConeGeometry(1.8, 2, 7), color: '#f2f6fa', matrix: M4(0, 5.3, 0) },
      { geo: new THREE.ConeGeometry(1.5, 3, 7), color: '#2f5a44', matrix: M4(0, 6.4, 0) }, { geo: new THREE.ConeGeometry(0.9, 1.6, 7), color: '#f2f6fa', matrix: M4(0, 7.9, 0) }]),
    palm: () => {
      const parts = [];
      for (let k = 0; k < 5; k++) parts.push({ geo: new THREE.CylinderGeometry(0.2, 0.26, 1.6, 6), color: k % 2 ? '#8a6a44' : '#7a5c3a', matrix: M4(k * 0.18, 0.8 + k * 1.5, 0) });
      for (let k = 0; k < 6; k++) { const a = k / 6 * Math.PI * 2, m = new THREE.Matrix4(); m.compose(new THREE.Vector3(0.9 + Math.cos(a) * 1.4, 8, Math.sin(a) * 1.4), new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.sin(a) * 0.9, -a, Math.cos(a) * -0.9 + 0)), new THREE.Vector3(0.9, 0.12, 3)); parts.push({ geo: new THREE.BoxGeometry(1, 1, 1), color: '#3f8a3a', matrix: m }); }
      return mergeGeoms(parts);
    },
    cactus: () => mergeGeoms([{ geo: new THREE.CylinderGeometry(0.35, 0.4, 4, 7), color: '#4f8a4a', matrix: M4(0, 2, 0) }, { geo: new THREE.CylinderGeometry(0.22, 0.25, 1.6, 6), color: '#4f8a4a', matrix: M4(0.7, 2.4, 0) },
      { geo: new THREE.CylinderGeometry(0.22, 0.25, 1.2, 6), color: '#4f8a4a', matrix: M4(-0.65, 1.9, 0) }, { geo: new THREE.BoxGeometry(0.7, 0.3, 0.3), color: '#4f8a4a', matrix: M4(0.35, 1.7, 0) }, { geo: new THREE.BoxGeometry(0.6, 0.3, 0.3), color: '#4f8a4a', matrix: M4(-0.3, 1.4, 0) }]),
    rock: () => mergeGeoms([{ geo: new THREE.DodecahedronGeometry(1.4, 0), color: '#8a8278', matrix: M4(0, 0.6, 0, 1.4, 0.8, 1.1) }, { geo: new THREE.DodecahedronGeometry(0.9, 0), color: '#7a7268', matrix: M4(1.2, 0.3, 0.4) }]),
    lamp: () => mergeGeoms([{ geo: new THREE.CylinderGeometry(0.1, 0.14, 8, 6), color: '#3a3d44', matrix: M4(0, 4, 0) }, { geo: new THREE.BoxGeometry(0.12, 0.12, 2.2), color: '#3a3d44', matrix: M4(0, 7.9, 1.0) }]),
    container: () => mergeGeoms([{ geo: new THREE.BoxGeometry(2.5, 2.6, 6.1), color: '#ffffff', matrix: M4(0, 1.3, 0) }]),
  };

  function buildingGeom(w, h, d) {
    const g = new THREE.BoxGeometry(w, h, d); g.translate(0, h / 2, 0);
    const uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) { const face = Math.floor(i / 4); const sw = face < 2 ? d : face < 4 ? w : w; const sh = face === 2 || face === 3 ? d : h; uv.setXY(i, uv.getX(i) * sw / 8, uv.getY(i) * sh / 8); }
    return track(g);
  }

  function placeProps(ctx, type, count, dMin, dMax, scaleRange, colors) {
    const { tr, hf, rng, scene } = ctx;
    const geo = PROPS[type]();
    const mat = track(new THREE.MeshLambertMaterial({ vertexColors: true }));
    const im = new THREE.InstancedMesh(geo, mat, count);
    im.castShadow = !!ctx.shadows && type !== 'rock'; im.receiveShadow = false;
    let n = 0, tries = 0;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), v = new THREE.Vector3(), sc = new THREE.Vector3(), c = new THREE.Color();
    while (n < count && tries < count * 8) {
      tries++;
      const i = Math.floor(rng() * tr.N), side = rng() < 0.5 ? -1 : 1;
      const dd = tr.W + dMin + Math.pow(rng(), 1.6) * (dMax - dMin);
      const x = tr.x[i] + tr.nx[i] * dd * side + (rng() - 0.5) * 6, z = tr.z[i] + tr.nz[i] * dd * side + (rng() - 0.5) * 6;
      const nr = hf.near(x, z);
      if (nr.dist < tr.W + dMin - 1) continue;
      const y = hf(x, z);
      if (ctx.water && y < ctx.water.level + 0.3) continue;
      const s = scaleRange[0] + rng() * (scaleRange[1] - scaleRange[0]);
      e.set(0, rng() * Math.PI * 2, 0); q.setFromEuler(e); v.set(x, y - 0.1, z); sc.set(s, s * (0.85 + rng() * 0.3), s);
      m.compose(v, q, sc); im.setMatrixAt(n, m);
      c.set(colors ? colors[Math.floor(rng() * colors.length)] : '#ffffff'); c.multiplyScalar(0.85 + rng() * 0.3); im.setColorAt(n, c);
      n++;
    }
    im.count = n; im.instanceMatrix.needsUpdate = true; if (im.instanceColor) im.instanceColor.needsUpdate = true;
    scene.add(im);
    return im;
  }

  function placeLamps(ctx, every) {
    const { tr, scene } = ctx;
    const pole = PROPS.lamp(), n = Math.floor(tr.L / every);
    const im = new THREE.InstancedMesh(pole, track(new THREE.MeshLambertMaterial({ vertexColors: true })), n);
    const head = new THREE.InstancedMesh(track(new THREE.BoxGeometry(0.5, 0.18, 0.9)), track(new THREE.MeshBasicMaterial({ color: 0xfff1c9 })), n);
    const glowTex = canvasTex(64, 64, (g, w) => { const gr = g.createRadialGradient(w / 2, w / 2, 2, w / 2, w / 2, w / 2); gr.addColorStop(0, 'rgba(255,230,170,0.55)'); gr.addColorStop(1, 'rgba(255,230,170,0)'); g.fillStyle = gr; g.fillRect(0, 0, w, w); });
    const pool = ctx.theme.night ? new THREE.InstancedMesh(track(new THREE.PlaneGeometry(14, 14).rotateX(-Math.PI / 2)), track(new THREE.MeshBasicMaterial({ map: glowTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })), n) : null;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
    for (let k = 0; k < n; k++) {
      const i = Math.floor(k * every / tr.step) % tr.N, side = k % 2 ? 1 : -1, d = (tr.W + 0.6) * side;
      const x = tr.x[i] + tr.nx[i] * d, z = tr.z[i] + tr.nz[i] * d, y = tr.y[i];
      const ang = Math.atan2(-tr.nx[i] * side, -tr.nz[i] * side);
      e.set(0, ang, 0); q.setFromEuler(e);
      m.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(1, 1, 1)); im.setMatrixAt(k, m);
      const hx = x - tr.nx[i] * side * 2, hz = z - tr.nz[i] * side * 2;
      m.compose(new THREE.Vector3(hx, y + 7.8, hz), q, new THREE.Vector3(1, 1, 1)); head.setMatrixAt(k, m);
      if (pool) { m.compose(new THREE.Vector3(hx, y + 0.06, hz), new THREE.Quaternion(), new THREE.Vector3(1, 1, 1)); pool.setMatrixAt(k, m); }
    }
    scene.add(im); scene.add(head); if (pool) { pool.renderOrder = 2; scene.add(pool); }
  }

  function placeBuildings(ctx, count) {
    const { tr, hf, rng, scene, theme } = ctx;
    const winTex = canvasTex(128, 128, (g, w) => {
      g.fillStyle = theme.night ? '#15161f' : '#6f7684'; g.fillRect(0, 0, w, w);
      for (let y = 8; y < w; y += 32) for (let x = 8; x < w; x += 32) {
        const lit = rngOf(x * 31 + y)() < 0.55;
        g.fillStyle = theme.night ? (lit ? ['#ffd98a', '#9fd7ff', '#ffb36b'][(x + y) % 3] : '#23252f') : (lit ? '#a9c4dc' : '#51606f');
        g.fillRect(x, y, 16, 20);
      }
    }, true);
    const mat = track(new THREE.MeshStandardMaterial({ map: winTex, emissiveMap: theme.night ? winTex : null, emissive: theme.night ? 0xffffff : 0x000000, emissiveIntensity: theme.night ? 0.9 : 0, roughness: 0.8 }));
    const variants = [[16, 14, 16], [18, 24, 14], [14, 36, 14], [22, 50, 18], [26, 10, 20]];
    const per = Math.ceil(count / variants.length);
    const occ = [];
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
    for (const vdim of variants) {
      const im = new THREE.InstancedMesh(buildingGeom(vdim[0], vdim[1], vdim[2]), mat, per);
      let n = 0, tries = 0;
      while (n < per && tries < per * 12) {
        tries++;
        const i = Math.floor(rng() * tr.N), side = rng() < 0.5 ? -1 : 1, dd = tr.W + 8 + vdim[2] / 2 + rng() * 60;
        const x = tr.x[i] + tr.nx[i] * dd * side, z = tr.z[i] + tr.nz[i] * dd * side;
        if (hf.near(x, z).dist < tr.W + 5 + Math.max(vdim[0], vdim[2]) * 0.72) continue;
        if (occ.some((o) => Math.abs(o[0] - x) < (o[2] + vdim[0]) * 0.6 && Math.abs(o[1] - z) < (o[2] + vdim[0]) * 0.6)) continue;
        occ.push([x, z, Math.max(vdim[0], vdim[2])]);
        e.set(0, Math.atan2(tr.tx[i], tr.tz[i]), 0); q.setFromEuler(e);
        m.compose(new THREE.Vector3(x, hf(x, z) - 0.2, z), q, new THREE.Vector3(1, 0.8 + rng() * 0.5, 1)); im.setMatrixAt(n++, m);
      }
      im.count = n; im.castShadow = !!ctx.shadows; scene.add(im);
    }
  }

  function placeContainers(ctx, count) {
    const { tr, hf, rng, scene } = ctx;
    const tex = canvasTex(64, 64, (g, w) => { g.fillStyle = '#fff'; g.fillRect(0, 0, w, w); g.fillStyle = 'rgba(0,0,0,0.18)'; for (let x = 0; x < w; x += 6) g.fillRect(x, 0, 2, w); }, true);
    const geo = track(new THREE.BoxGeometry(2.5, 2.6, 6.1)); geo.translate(0, 1.3, 0);
    const im = new THREE.InstancedMesh(geo, track(new THREE.MeshLambertMaterial({ map: tex })), count);
    const colors = ['#c8412e', '#2f6bb0', '#e0a02a', '#3a8a4a', '#8a8f96', '#d06a2a'];
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), c = new THREE.Color();
    let n = 0, tries = 0;
    while (n < count && tries < count * 10) {
      tries++;
      const i = Math.floor(rng() * tr.N), side = rng() < 0.5 ? -1 : 1, dd = tr.W + 5 + rng() * 45;
      const x = tr.x[i] + tr.nx[i] * dd * side, z = tr.z[i] + tr.nz[i] * dd * side;
      if (hf.near(x, z).dist < tr.W + 5) continue;
      const stack = 1 + Math.floor(rng() * 3), ang = Math.atan2(tr.tx[i], tr.tz[i]) + (rng() < 0.3 ? Math.PI / 2 : 0);
      e.set(0, ang, 0); q.setFromEuler(e);
      for (let k = 0; k < stack && n < count; k++) {
        m.compose(new THREE.Vector3(x, hf(x, z) + k * 2.6, z), q, new THREE.Vector3(1, 1, 1)); im.setMatrixAt(n, m);
        c.set(colors[Math.floor(rng() * colors.length)]); im.setColorAt(n, c); n++;
      }
    }
    im.count = n; im.castShadow = !!ctx.shadows; scene.add(im);
    // портовые краны
    const craneMat = track(new THREE.MeshLambertMaterial({ color: 0xe0a02a }));
    for (let k = 0; k < 3; k++) {
      const i = Math.floor((k + 0.3) / 3 * tr.N), x = tr.x[i] + tr.nx[i] * (tr.W + 40), z = tr.z[i] + tr.nz[i] * (tr.W + 40), y = hf(x, z);
      const g = new THREE.Group(); g.position.set(x, y, z); g.rotation.y = Math.atan2(tr.tx[i], tr.tz[i]);
      for (const lx of [-4, 4]) for (const lz of [-4, 4]) { const leg = new THREE.Mesh(track(new THREE.BoxGeometry(0.8, 26, 0.8)), craneMat); leg.position.set(lx, 13, lz); g.add(leg); }
      const beam = new THREE.Mesh(track(new THREE.BoxGeometry(2, 2, 46)), craneMat); beam.position.set(0, 27, 6); g.add(beam);
      scene.add(g);
    }
  }

  function startGantry(ctx, s, label) {
    const { tr, scene } = ctx;
    const p = C.pointAt(tr, s, 0), W = tr.W + 0.5;
    const g = new THREE.Group(); g.position.set(p.x, p.y, p.z); g.rotation.y = p.h;
    const mat = track(new THREE.MeshStandardMaterial({ color: 0x2a2c33, roughness: 0.6, metalness: 0.5 }));
    for (const sx of [-W, W]) { const post = new THREE.Mesh(track(new THREE.BoxGeometry(0.7, 7.5, 0.7)), mat); post.position.set(sx, 3.75, 0); post.castShadow = !!ctx.shadows; g.add(post); }
    const banTex = canvasTex(1024, 128, (c, w, h) => {
      c.fillStyle = '#111'; c.fillRect(0, 0, w, h);
      for (let x = 0; x < w; x += 32) for (let y = 0; y < h; y += 32) if (((x + y) / 32) % 2 === 0) { c.fillStyle = '#eee'; c.fillRect(x, y, 32, 32); }
      c.fillStyle = '#ff5a1f'; c.fillRect(160, 16, w - 320, h - 32);
      c.fillStyle = '#fff'; c.font = 'bold 70px sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(label, w / 2, h / 2 + 4);
    });
    const banMat = track(new THREE.MeshBasicMaterial({ map: banTex, side: THREE.DoubleSide }));
    const ban = new THREE.Mesh(track(new THREE.PlaneGeometry(W * 2, 1.8)), banMat); ban.position.set(0, 6.6, 0); ban.rotation.y = Math.PI; g.add(ban);
    scene.add(g);
    // клетчатая линия
    const lineTex = canvasTex(256, 32, (c, w, h) => { for (let x = 0; x < w; x += 16) for (let y = 0; y < h; y += 16) { c.fillStyle = ((x + y) / 16) % 2 ? '#111' : '#eee'; c.fillRect(x, y, 16, 16); } });
    const line = new THREE.Mesh(track(new THREE.PlaneGeometry(tr.hw * 2, 1.6)), track(new THREE.MeshLambertMaterial({ map: lineTex, transparent: true, polygonOffset: true, polygonOffsetFactor: -2 })));
    line.rotation.x = -Math.PI / 2; line.rotation.z = -p.h; line.position.set(p.x, p.y + 0.035, p.z); line.rotation.order = 'YXZ'; line.rotation.set(-Math.PI / 2, p.h, 0, 'YXZ');
    scene.add(line);
  }

  function stands(ctx, s) {
    const { tr, scene } = ctx;
    const crowd = canvasTex(256, 128, (c, w, h) => {
      c.fillStyle = '#3a3c48'; c.fillRect(0, 0, w, h);
      const r = rngOf(3);
      for (let y = 6; y < h; y += 14) for (let x = 2; x < w; x += 7) { c.fillStyle = ['#e8412c', '#2f7dd8', '#f2b02a', '#f4f4f4', '#3fae5a', '#d83a8c'][Math.floor(r() * 6)]; c.fillRect(x, y + r() * 3, 5, 8); c.fillStyle = '#e8c49a'; c.fillRect(x + 1, y - 3 + r() * 2, 3, 3); }
    }, true);
    for (const side of [-1, 1]) {
      if (!tr.closed && side === 1) continue;
      const p = C.pointAt(tr, s, side * (tr.W + 15));
      const g = new THREE.Group(); g.position.set(p.x, p.y, p.z); g.rotation.y = p.h + (side > 0 ? -Math.PI / 2 : Math.PI / 2);
      const stairs = new THREE.Mesh(track(new THREE.BoxGeometry(36, 6, 9)), track(new THREE.MeshLambertMaterial({ map: crowd })));
      stairs.position.set(0, 3, 0); stairs.rotation.x = -0.45; g.add(stairs);
      const roof = new THREE.Mesh(track(new THREE.BoxGeometry(38, 0.4, 10)), track(new THREE.MeshLambertMaterial({ color: 0xdddddd })));
      roof.position.set(0, 9, -1); g.add(roof);
      scene.add(g);
    }
  }

  function skyDome(theme, far) {
    const g = track(new THREE.SphereGeometry(far * 0.95, 24, 12));
    const m = track(new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { top: { value: col(theme.sky[0]) }, bot: { value: col(theme.sky[1]) } },
      vertexShader: 'varying vec3 p; void main(){ p = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: 'uniform vec3 top; uniform vec3 bot; varying vec3 p; void main(){ float h = normalize(p).y; gl_FragColor = vec4(mix(bot, top, smoothstep(-0.05, 0.55, h)), 1.0); }',
    }));
    const mesh = new THREE.Mesh(g, m); mesh.renderOrder = -10;
    return mesh;
  }

  // ---------- частицы: дым, пыль, снег, пламя нитро ----------
  function particleSystem(max) {
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(max * 3), colr = new Float32Array(max * 3), size = new Float32Array(max), alpha = new Float32Array(max);
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(colr, 3));
    g.setAttribute('size', new THREE.BufferAttribute(size, 1));
    g.setAttribute('alpha', new THREE.BufferAttribute(alpha, 1));
    const tex = canvasTex(64, 64, (c, w) => { const gr = c.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.5, 'rgba(255,255,255,0.45)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); c.fillStyle = gr; c.fillRect(0, 0, w, w); });
    const m = track(new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, vertexColors: true,
      uniforms: { map: { value: tex }, scale: { value: 600 } },
      vertexShader: 'attribute float size; attribute float alpha; varying float va; varying vec3 vc; uniform float scale; void main(){ vc = color; vec4 mv = modelViewMatrix * vec4(position,1.0); float z = -mv.z; va = alpha * smoothstep(1.5, 5.0, z); gl_PointSize = min(size * scale / z, 220.0); gl_Position = projectionMatrix * mv; }',
      fragmentShader: 'uniform sampler2D map; varying float va; varying vec3 vc; void main(){ vec4 t = texture2D(map, gl_PointCoord); gl_FragColor = vec4(vc, t.a * va); }',
    }));
    track(g);
    const pts = new THREE.Points(g, m); pts.frustumCulled = false; pts.renderOrder = 5;
    const P = { pts, max, n: 0, life: new Float32Array(max), maxLife: new Float32Array(max), vel: new Float32Array(max * 3), grow: new Float32Array(max), a0: new Float32Array(max), next: 0 };
    return P;
  }
  function emit(P, x, y, z, vx, vy, vz, size, grow, life, r, gg, b, a) {
    const i = P.next; P.next = (P.next + 1) % P.max;
    const g = P.pts.geometry;
    g.attributes.position.array.set([x, y, z], i * 3); g.attributes.color.array.set([r, gg, b], i * 3);
    g.attributes.size.array[i] = size; g.attributes.alpha.array[i] = a;
    P.vel[i * 3] = vx; P.vel[i * 3 + 1] = vy; P.vel[i * 3 + 2] = vz; P.life[i] = life; P.maxLife[i] = life; P.grow[i] = grow; P.a0[i] = a;
  }
  function updateParticles(P, dt) {
    const g = P.pts.geometry, pos = g.attributes.position.array, size = g.attributes.size.array, alpha = g.attributes.alpha.array;
    for (let i = 0; i < P.max; i++) {
      if (P.life[i] <= 0) { if (alpha[i] !== 0) alpha[i] = 0; continue; }
      P.life[i] -= dt;
      pos[i * 3] += P.vel[i * 3] * dt; pos[i * 3 + 1] += P.vel[i * 3 + 1] * dt; pos[i * 3 + 2] += P.vel[i * 3 + 2] * dt;
      P.vel[i * 3] *= 1 - dt * 1.5; P.vel[i * 3 + 2] *= 1 - dt * 1.5;
      size[i] += P.grow[i] * dt;
      alpha[i] = Math.max(0, P.a0[i] * (P.life[i] / P.maxLife[i]));
    }
    g.attributes.position.needsUpdate = true; g.attributes.size.needsUpdate = true; g.attributes.alpha.needsUpdate = true; g.attributes.color.needsUpdate = true;
  }

  // ---------- следы шин: кольцевой буфер четырёхугольников ----------
  function skidSystem(max) {
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(max * 4 * 3), idx = new Uint32Array(max * 6);
    for (let i = 0; i < max; i++) { const a = i * 4; idx.set([a, a + 1, a + 2, a + 2, a + 1, a + 3], i * 6); }
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.setDrawRange(0, 0);
    const m = track(new THREE.MeshBasicMaterial({ color: 0x0a0a0a, transparent: true, opacity: 0.45, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 }));
    track(g);
    const mesh = new THREE.Mesh(g, m); mesh.frustumCulled = false; mesh.renderOrder = 1;
    return { mesh, max, next: 0, used: 0 };
  }
  function addSkid(S, ax, ay, az, bx, by, bz, w) {
    const dx = bx - ax, dz = bz - az, l = Math.hypot(dx, dz);
    if (l < 0.05 || l > 4) return;
    const px = -dz / l * w / 2, pz = dx / l * w / 2, i = S.next, arr = S.mesh.geometry.attributes.position.array;
    arr.set([ax - px, ay, az - pz, ax + px, ay, az + pz, bx - px, by, bz - pz, bx + px, by, bz + pz], i * 12);
    S.next = (S.next + 1) % S.max; S.used = Math.min(S.max, S.used + 1);
    S.mesh.geometry.setDrawRange(0, S.used * 6);
    S.mesh.geometry.attributes.position.needsUpdate = true;
  }

  // ======================= СБОРКА ЗАЕЗДА =======================
  const nextFrame = () => new Promise((r) => setTimeout(r, 0));
  R.buildRace = async function (race, looks, onProgress) {
    R.disposeRace();
    const s = R.settings, tr = race.track, def = tr.def, theme = D.THEMES[def.theme];
    const far = D.DRAW_DIST[s.drawDist] || 1000;
    const shadows = s.shadows && R.q.shadowMap > 0;
    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(col(theme.fog), far * 0.25, far);
    scene.background = col(theme.fog);
    const ctx = { tr, theme, scene, rng: rngOf(C.hashStr(def.id) ^ 0x9e37), shadows, water: theme.water };
    const prog = async (p, label) => { if (onProgress) onProgress(p, label); await nextFrame(); };
    await prog(0.05, 'Небо и свет');
    scene.add(skyDome(theme, far + 150));
    const hemi = new THREE.HemisphereLight(col(theme.hemi[0]), col(theme.hemi[1]), theme.hemi[2]); scene.add(hemi);
    const sun = new THREE.DirectionalLight(col(theme.sun[0]), theme.sun[1]);
    sun.position.set(80, 140, 60); sun.castShadow = shadows;
    const sz = R.q.shadowMap || 1024; sun.shadow.mapSize.set(sz, sz);
    const sc = sun.shadow.camera; sc.left = -60; sc.right = 60; sc.top = 60; sc.bottom = -60; sc.near = 10; sc.far = 400; sun.shadow.bias = -0.0006;
    scene.add(sun); scene.add(sun.target);
    if (theme.night) {
      const stars = new THREE.BufferGeometry(), sp = [], r = rngOf(11);
      for (let k = 0; k < 900; k++) { const a = r() * Math.PI * 2, e = 0.08 + r() * 1.3, R0 = far * 0.9; sp.push(Math.cos(a) * Math.cos(e) * R0, Math.sin(e) * R0, Math.sin(a) * Math.cos(e) * R0); }
      stars.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3)); track(stars);
      const st = new THREE.Points(stars, track(new THREE.PointsMaterial({ color: 0xffffff, size: 2, sizeAttenuation: false, fog: false })));
      scene.add(st); ctx.stars = st;
    }
    await prog(0.2, 'Дорога');
    // дорога по участкам покрытия
    const runs = []; let start = 0;
    const last = tr.closed ? tr.N : tr.N - 1;
    for (let k = 1; k <= last; k++) { const a = tr.surf[(k - 1) % tr.N], b = tr.surf[k % tr.N]; if (a !== b || k === last) { runs.push([start, k, a]); start = k; } }
    const roadMats = {};
    for (const [i0, i1, sf] of runs) {
      if (!roadMats[sf]) { const t = surfaceTex(sf); roadMats[sf] = track(new THREE.MeshStandardMaterial({ map: t, roughness: sf === 'asphalt' ? 0.85 : 1, metalness: 0 })); }
      const m = new THREE.Mesh(ribbon(tr, i0, i1, -tr.hw, tr.hw, 0.02, 12), roadMats[sf]); m.receiveShadow = true; scene.add(m);
    }
    const runTex = surfaceTex(tr.runoffSurf === 'snowbank' ? 'snowbank' : tr.runoffSurf);
    const runMat = track(new THREE.MeshLambertMaterial({ map: runTex }));
    for (const side of [-1, 1]) {
      const m = new THREE.Mesh(ribbon(tr, 0, last, side < 0 ? -tr.W - 0.3 : tr.hw, side < 0 ? -tr.hw : tr.W + 0.3, 0.0, 8), runMat); m.receiveShadow = true; scene.add(m);
    }
    // бордюры на поворотах асфальтовых трасс
    if (def.surface === 'asphalt') {
      const curbTex = canvasTex(64, 64, (c, w, h) => { for (let y = 0; y < h; y += 32) { c.fillStyle = (y / 32) % 2 ? '#e8e8e8' : '#d8342a'; c.fillRect(0, y, w, 32); } }, true);
      const curbMat = track(new THREE.MeshLambertMaterial({ map: curbTex }));
      for (let i = 0; i < tr.N; i++) {
        if (tr.kappa[i] < 1 / 90) continue;
        let j = i; while (j < tr.N && tr.kappa[j] >= 1 / 90) j++;
        for (const side of [-1, 1]) scene.add(new THREE.Mesh(ribbon(tr, Math.max(0, i - 3), Math.min(last, j + 3), side < 0 ? -tr.hw - 0.9 : tr.hw, side < 0 ? -tr.hw : tr.hw + 0.9, 0.04, 3), curbMat));
        i = j;
      }
    }
    // вешки вдоль заснеженных участков: оранжевые с чёрным верхом, по обе стороны через 18 м
    let poles = 0;
    if (runs.some((r) => r[2] === 'snow')) {
      const pg = mergeGeoms([{ geo: new THREE.CylinderGeometry(0.06, 0.06, 1.6, 5), color: '#ff7a1a', matrix: M4(0, 0.8, 0) }, { geo: new THREE.CylinderGeometry(0.065, 0.065, 0.3, 5), color: '#15161a', matrix: M4(0, 1.7, 0) }]);
      const im = new THREE.InstancedMesh(pg, track(new THREE.MeshLambertMaterial({ vertexColors: true })), Math.ceil(tr.N * tr.step / 18) * 2 + 2);
      const m = new THREE.Matrix4();
      for (let i = 0; i < tr.N; i += Math.round(18 / tr.step)) {
        if (tr.surf[i] !== 'snow') continue;
        for (const sd of [-1, 1]) { const d = sd * (tr.hw + 0.8); m.makeTranslation(tr.x[i] + tr.nx[i] * d, tr.y[i], tr.z[i] + tr.nz[i] * d); im.setMatrixAt(poles++, m); }
      }
      im.count = poles; im.instanceMatrix.needsUpdate = true; scene.add(im);
    }
    const wMat = track(new THREE.MeshLambertMaterial({ map: wallTex(theme.wall), side: THREE.DoubleSide }));
    for (const side of [-1, 1]) { const w = new THREE.Mesh(wallRibbon(tr, side * (tr.W + 0.05), 1.1, 4), wMat); w.castShadow = shadows; w.receiveShadow = true; scene.add(w); }
    if (!tr.closed) for (const e of [0, tr.N - 1]) {
      const p = C.pointAt(tr, tr.s[e], 0), end = new THREE.Mesh(track(new THREE.BoxGeometry(tr.W * 2 + 1, 1.6, 0.8)), wMat);
      end.position.set(p.x, p.y + 0.3, p.z); end.rotation.y = p.h; scene.add(end);
    }
    startGantry(ctx, tr.sStart, tr.closed ? 'СТАРТ · ФИНИШ' : 'СТАРТ');
    if (!tr.closed) startGantry(ctx, tr.sFinish, 'ФИНИШ');
    // столбики чекпоинтов и арка следующего
    const cpMat = track(new THREE.MeshBasicMaterial({ color: 0x19d3ff, transparent: true, opacity: 0.85 }));
    const cpGeo = track(new THREE.BoxGeometry(0.35, 2.4, 0.35));
    tr.cps.forEach((cp, k) => { if (k === 0 || (!tr.closed && k === tr.cps.length - 1)) return; for (const sd of [-1, 1]) { const p = new THREE.Mesh(cpGeo, cpMat); p.position.set(cp.x + cp.nx * sd * (tr.W - 0.3), cp.y + 1.2, cp.z + cp.nz * sd * (tr.W - 0.3)); scene.add(p); } });
    const arch = new THREE.Mesh(track(new THREE.TorusGeometry(tr.W - 0.2, 0.18, 8, 32, Math.PI)), track(new THREE.MeshBasicMaterial({ color: 0x19d3ff, transparent: true, opacity: 0.55, fog: false })));
    scene.add(arch);

    await prog(0.4, 'Рельеф');
    let bbox = { minx: 1e9, maxx: -1e9, minz: 1e9, maxz: -1e9 };
    for (let i = 0; i < tr.N; i++) { bbox.minx = Math.min(bbox.minx, tr.x[i]); bbox.maxx = Math.max(bbox.maxx, tr.x[i]); bbox.minz = Math.min(bbox.minz, tr.z[i]); bbox.maxz = Math.max(bbox.maxz, tr.z[i]); }
    const hf = makeHeightFn(tr, theme); ctx.hf = hf;
    scene.add(terrainMesh(tr, theme, hf, bbox));
    let water = null;
    if (theme.water) {
      const wt = canvasTex(128, 128, (c, w) => { c.fillStyle = theme.water.color; c.fillRect(0, 0, w, w); const r = rngOf(5); speckle(c, w, w, r, 600, theme.water.ice ? ['#d6e6f2', '#a9c6dc', '#ffffff'] : ['rgba(255,255,255,0.25)', 'rgba(0,30,60,0.3)'], 1, theme.water.ice ? 5 : 3); }, true);
      wt.repeat.set(120, 120);
      water = new THREE.Mesh(track(new THREE.PlaneGeometry(6000, 6000).rotateX(-Math.PI / 2)), track(new THREE.MeshStandardMaterial({ map: wt, roughness: theme.water.ice ? 0.25 : 0.15, metalness: theme.water.ice ? 0.1 : 0.3, transparent: !theme.water.ice, opacity: 0.92 })));
      water.position.set((bbox.minx + bbox.maxx) / 2, theme.water.level, (bbox.minz + bbox.maxz) / 2); water.receiveShadow = true; scene.add(water);
    }
    await prog(0.6, 'Деревья и дома');
    const dens = R.q.decor || 1;
    const decor = theme.decor;
    if (decor.includes('building')) placeBuildings(ctx, Math.round(90 * dens));
    if (decor.includes('lamp')) placeLamps(ctx, theme.night ? 32 : 45);
    if (decor.includes('tree')) placeProps(ctx, 'tree', Math.round(260 * dens), 4, 90, [0.8, 1.4], ['#ffffff', '#e0f0c0', '#fff0c0']);
    if (decor.includes('pine')) placeProps(ctx, 'pine', Math.round((def.theme === 'forest' ? 520 : 320) * dens), 3, 100, [0.8, 1.5], ['#ffffff', '#d8f0d0', '#c8e0c0']);
    if (decor.includes('snowpine')) placeProps(ctx, 'snowpine', Math.round(360 * dens), 3, 100, [0.8, 1.5], ['#ffffff']);
    if (decor.includes('palm')) placeProps(ctx, 'palm', Math.round(140 * dens), 3, 50, [0.8, 1.3], ['#ffffff', '#f0ffe0']);
    if (decor.includes('cactus')) placeProps(ctx, 'cactus', Math.round(180 * dens), 4, 90, [0.7, 1.3], ['#ffffff', '#e0f0d0']);
    if (decor.includes('rock')) placeProps(ctx, 'rock', Math.round(120 * dens), 3, 110, [0.6, 2.4], theme.ground === 'snow' ? ['#e8eef4', '#b8c0cc'] : theme.ground === 'redsand' ? ['#d08a60', '#b86a44'] : ['#ffffff', '#d0c8c0']);
    if (decor.includes('container')) placeContainers(ctx, Math.round(160 * dens));
    if (theme.stands) stands(ctx, tr.sStart + 30);

    await prog(0.8, 'Машины');
    const cars = race.cars.map((c, k) => {
      const cm = buildCar(c.carId, looks[k] || C.defaultLook(c.carId));
      cm.root.traverse((o) => { if (o.isMesh && o !== cm.blob) o.castShadow = shadows && c.isPlayer; });
      scene.add(cm.root);
      cm.roll = 0; cm.pitch = 0; cm.spin = 0; cm.lastWheels = null;
      return cm;
    });
    let headlight = null;
    if (theme.headlights && race.player) {
      headlight = new THREE.SpotLight(0xfff2d6, 2.2, 90, 0.55, 0.5, 1.2);
      scene.add(headlight); scene.add(headlight.target);
    }
    const pmax = { low: 300, medium: 800, high: 1600 }[s.particles] || 800;
    const parts = particleSystem(pmax); scene.add(parts.pts);
    const skids = skidSystem(s.particles === 'low' ? 800 : 2400); scene.add(skids.mesh);
    let snow = null;
    if (theme.snowfall) { snow = particleSystem(400); scene.add(snow.pts); }
    // твёрдая обстановка трассы для штанги камеры: стены, рельеф, предметы (не небо, не вода, не полотно, не машины)
    const carRoots = new Set(cars.map((c) => c.root)), solids = scene.children.filter((o) => (o.isMesh || o.isInstancedMesh) && o !== water && !carRoots.has(o) && !(o.material && o.material.side === THREE.BackSide) && !(o.material && o.material.transparent));
    R.race = { race, scene, sun, hemi, cars, arch, parts, skids, snow, water, headlight, theme, ctx, poles, solids, cam: { x: 0, y: 0, z: 0, init: false, fov: 62, shake: 0 }, time: 0 };
    R.applySettings(s);
    await prog(1, 'Готово');
    return R.race;
  };

  R.disposeRace = function () {
    if (!R.race) return;
    for (const cm of R.race.cars) disposeCar(cm);
    // карта теней солнца и фары - свои текстуры, без dispose они копились с каждым заездом
    if (R.race.sun) R.race.sun.dispose();
    if (R.race.headlight) R.race.headlight.dispose();
    R.race.scene.traverse((o) => { if (o.isInstancedMesh) o.dispose(); });
    while (disposables.length) { const o = disposables.pop(); if (o && o.dispose) o.dispose(); }
    clearCarTexCaches();
    R.race = null;
  };

  // ======================= КАДР =======================
  const tmpV = new THREE.Vector3(), tmpV2 = new THREE.Vector3(), orbTmp = {}, armRay = new THREE.Raycaster();
  R.frame = function (dt, alpha, camMode, info) {
    if (!R.renderer) return;
    if (!R.race) { renderShowroom(dt); return; }
    const X = R.race, race = X.race, tr = race.track, s = R.settings;
    X.time += dt;
    const pl = race.player || race.cars[0];
    // машины
    race.cars.forEach((c, k) => {
      const cm = X.cars[k];
      if (c.out) { cm.root.visible = false; return; }
      cm.root.visible = !((camMode === 'hood' || camMode === 'cockpit') && c === pl);
      const x = C.lerp(c.ix !== undefined ? c.ix : c.x, c.x, alpha), z = C.lerp(c.iz !== undefined ? c.iz : c.z, c.z, alpha);
      let h = c.h; if (c.ih !== undefined) { let dh = c.h - c.ih; if (dh > Math.PI) dh -= 2 * Math.PI; if (dh < -Math.PI) dh += 2 * Math.PI; h = c.ih + dh * alpha; }
      cm.root.position.set(x, c.y, z); cm.root.rotation.y = h;
      // наклоны кузова от ускорений
      const k2 = 1 - Math.exp(-dt * 8);
      const latA = c.w * c.speed, lonA = (c.speed - (cm.lastSpeed || 0)) / Math.max(dt, 1e-3);
      cm.lastSpeed = c.speed;
      cm.roll += (C.clamp(-latA * 0.006, -0.07, 0.07) - cm.roll) * k2;
      cm.pitch += (C.clamp(-lonA * 0.004, -0.05, 0.05) - cm.pitch) * k2;
      cm.body.rotation.z = cm.roll; cm.body.rotation.x = cm.pitch;
      // слоп наклона дороги
      const i = c.pr ? c.pr.i : 0, j = tr.closed ? (i + 3) % tr.N : Math.min(tr.N - 1, i + 3);
      cm.root.rotation.x = -Math.atan2(tr.y[j] - tr.y[i], Math.max(1, tr.s[j] - tr.s[i] || 6)) * Math.cos(h - Math.atan2(tr.tx[i], tr.tz[i]));
      cm.root.rotation.order = 'YXZ';
      cm.spin += c.vLong * dt / cm.S.wr;
      for (const w of cm.wheels) { w.spin.rotation.x = cm.spin; if (w.front) w.pivot.rotation.y = c.steer; }
      cm.tailMat.emissiveIntensity = c.braking ? 2.4 : 0.6;
      if (c.ghost > 0) cm.root.visible = cm.root.visible && Math.floor(X.time * 12) % 2 === 0;
      // дым, пыль, снег из-под колёс
      const skid = Math.max(c.skidR, c.skidF * 0.6);
      const loose = c.surf !== 'asphalt' || c.onRunoff;
      const sn = Math.sin(h), cs = Math.cos(h);
      const rearZ = -cm.L / 2 + cm.S.ax[0], hw = cm.W / 2 - 0.15;
      const wl = [[x + cs * hw + sn * rearZ, z - sn * hw + cs * rearZ], [x - cs * hw + sn * rearZ, z + sn * hw + cs * rearZ]];
      const pr = s.particles === 'low' ? 0.35 : s.particles === 'medium' ? 0.65 : 1;
      if ((skid > 0.35 || (loose && c.speed > 8)) && Math.random() < pr) {
        const surfCol = c.surf === 'snow' || tr.runoffSurf === 'snowbank' && c.onRunoff ? [0.95, 0.97, 1] : loose ? (c.surf === 'gravel' ? [0.62, 0.53, 0.42] : [0.85, 0.74, 0.55]) : [0.86, 0.86, 0.88];
        for (const wp of wl) emit(X.parts, wp[0], c.y + 0.3, wp[1], -c.vx * 0.12 + (Math.random() - 0.5) * 2, 0.8 + Math.random(), -c.vz * 0.12 + (Math.random() - 0.5) * 2,
          loose ? 1.0 : 1.2, loose ? 2.2 : 3, loose ? 0.8 : 1.3, surfCol[0], surfCol[1], surfCol[2], Math.min(0.42, 0.14 + skid * 0.3));
      }
      if (c.nitroOn && Math.random() < pr) {
        const ex = x + sn * (-cm.L / 2 - 0.1), ez = z + cs * (-cm.L / 2 - 0.1);
        emit(X.parts, ex, c.y + 0.45, ez, -sn * 6 + c.vx * 0.8, 0.2, -cs * 6 + c.vz * 0.8, 0.28, -0.6, 0.12, 1, 0.55 + Math.random() * 0.3, 0.2, 0.85);
      }
      if (skid > 0.45 && !loose) {
        if (cm.lastWheels) for (let q = 0; q < 2; q++) addSkid(X.skids, cm.lastWheels[q][0], c.y + 0.03, cm.lastWheels[q][1], wl[q][0], c.y + 0.03, wl[q][1], 0.26);
        cm.lastWheels = wl;
      } else cm.lastWheels = null;
    });
    updateParticles(X.parts, dt);
    if (X.snow) {
      for (let k = 0; k < 6; k++) emit(X.snow, R.camera.position.x + (Math.random() - 0.5) * 80, R.camera.position.y + 25, R.camera.position.z + (Math.random() - 0.5) * 80, 0, -4, 0, 0.35, 0, 6, 1, 1, 1, 0.9);
      updateParticles(X.snow, dt);
    }
    // арка следующего чекпоинта
    if (pl && tr.cps.length) {
      let k = pl.nextCp; if (tr.closed && k >= tr.cps.length) k = 0; if (!tr.closed) k = Math.min(k, tr.cps.length - 1);
      const cp = tr.cps[k]; X.arch.position.set(cp.x, cp.y, cp.z); X.arch.rotation.set(0, Math.atan2(cp.tx, cp.tz), 0);
      X.arch.visible = !pl.finished; X.arch.material.opacity = 0.35 + 0.2 * Math.sin(X.time * 5);
    }
    if (X.water && !X.theme.water.ice) X.water.material.map.offset.set(X.time * 0.004, X.time * 0.002);
    // соперник между камерой и своей машиной становится полупрозрачным, чтобы не закрывать её
    race.cars.forEach((c, k) => {
      if (c === pl || c.out) return;
      const cm = X.cars[k];
      const fade = camMode !== 'hood' && fadeBetween(R.camera.position.x, R.camera.position.z, pl.x, pl.z, c.x, c.z);
      if (cm.faded !== fade) {
        cm.faded = fade;
        cm.root.traverse((o) => { if (o.isMesh && o !== cm.blob) { const ms = Array.isArray(o.material) ? o.material : [o.material]; ms.forEach((m) => { m.transparent = fade; m.opacity = fade ? 0.35 : 1; m.depthWrite = !fade; }); } });
      }
    });
    // камера
    const cam = R.camera, st = X.cam;
    const pc = X.cars[race.cars.indexOf(pl)];
    const px = pc.root.position.x, py = pc.root.position.y, pz = pc.root.position.z, ph = pc.root.rotation.y;
    const fx = Math.sin(ph), fz = Math.cos(ph);
    const vx = pl.vx, vz = pl.vz, sp = pl.speed;
    const far = D.DRAW_DIST[s.drawDist] || 1000;
    let fovT = 60 + Math.min(1, sp / 70) * 16 + (pl.nitroOn ? 6 : 0);
    const V = R.view, CK = R.cockpit;
    if (camMode === 'cockpit' && CK && pc) {
      CK.ensure(pl.carId || pl.id || 'iskra');
      CK.update(dt, { car: pl, steerN: (pl.steer || 0) / (pl.st.steer || 0.6), kmh: C.toUnits(pl.speed, s.units), vmax: C.toUnits(pl.st.top, s.units), rpm: pl.rpm || 0, gear: pl.gear, nitro: pl.nitro, dark: X.theme.night ? 1 : 0, light: X.theme.night ? 0.25 : 1, rain: !!X.theme.rain, units: s.units });
      const lim = R.VIEW, look = { yaw: V.back ? lim.cockpitYaw : Math.max(-lim.cockpitYaw, Math.min(lim.cockpitYaw, V.yaw)), pitch: Math.max(-lim.cockpitPitch, Math.min(lim.cockpitPitch, V.pitch)) };
      st.fov += (72 + Math.min(1, sp / 70) * 6 - st.fov) * (1 - Math.exp(-dt * 3)); fovT = st.fov;
      CK.place(cam, pc.root, look, st.fov); st.init = false; st.cockpit = true;
    } else if (camMode === 'hood') {
      if (CK) CK.off();
      cam.position.set(px + fx * 0.35, py + 1.25, pz + fz * 0.35);
      const hy = V.back ? Math.PI : Math.max(-R.VIEW.cockpitYaw, Math.min(R.VIEW.cockpitYaw, V.yaw)), lfx = Math.sin(ph + hy), lfz = Math.cos(ph + hy);
      tmpV.set(px + lfx * 30, py + 1.0 + Math.tan(Math.max(-1, Math.min(1, V.pitch))) * 30, pz + lfz * 30); cam.lookAt(tmpV);
      st.init = false;
    } else {
      if (CK) CK.off();
      const far2 = camMode === 'far';
      const back = far2 ? 9.5 : 6.2, up = far2 ? 3.6 : 2.3;
      // смотрим немного по вектору скорости, чтобы занос был виден
      let dx = fx, dz = fz;
      const vl = Math.hypot(vx, vz);
      if (sp > 4 && vl > 1) { dx = fx * 0.6 + vx / vl * 0.4; dz = fz * 0.6 + vz / vl * 0.4; const l = Math.hypot(dx, dz); dx /= l; dz /= l; }
      const ob = R.orbitOffset(dx, dz, back, up, V, orbTmp);
      const tx = px + ob.x, tz = pz + ob.z, ty = py + ob.y;
      if (!st.init || Math.hypot(tx - st.x, tz - st.z) > 25) { st.x = tx; st.y = ty; st.z = tz; st.init = true; }   // скачок (возврат на трассу) - без долгого догона
      const kk = 1 - Math.exp(-dt * 7);
      st.x += (tx - st.x) * kk; st.y += (ty - st.y) * kk; st.z += (tz - st.z) * kk;
      if (pl.hit > 3) st.shake = Math.min(0.6, pl.hit * 0.05);
      st.shake *= Math.exp(-dt * 6);
      // штанга: луч от машины к камере по нарисованной обстановке трассы; что встало между - камера ближе
      const ax = px, ay = py + 1.4, az = pz;
      let bx = st.x, by = Math.max(st.y, py + 0.8), bz = st.z;
      const len = Math.hypot(bx - ax, by - ay, bz - az);
      if (len > 0.5 && X.solids && X.solids.length) {
        armRay.set(tmpV.set(ax, ay, az), tmpV2.set(bx - ax, by - ay, bz - az).normalize()); armRay.far = len + 0.5;
        const hit = armRay.intersectObjects(X.solids, false)[0];
        const k = hit ? Math.max(0.15, (hit.distance - 0.5) / len) : 1;
        st.arm = st.arm === undefined || k < st.arm ? k : st.arm + (k - st.arm) * 0.08;
        bx = ax + (bx - ax) * st.arm; by = ay + (by - ay) * st.arm; bz = az + (bz - az) * st.arm;
      }
      cam.position.set(bx + (Math.random() - 0.5) * st.shake, by + (Math.random() - 0.5) * st.shake, bz);
      if (ob.free) tmpV.set(px, py + 1.1, pz); else tmpV.set(px + fx * 3, py + 1.1, pz + fz * 3);
      cam.lookAt(tmpV);
    }
    st.fov += (fovT - st.fov) * (1 - Math.exp(-dt * 3));
    cam.fov = st.fov; cam.near = 0.3; cam.far = far + 200; cam.updateProjectionMatrix();
    // солнце и тень едут за игроком
    X.sun.position.set(px + 80, py + 140, pz + 60); X.sun.target.position.set(px, py, pz); X.sun.target.updateMatrixWorld();
    if (X.headlight) { X.headlight.position.set(px + fx * 1.5, py + 1.2, pz + fz * 1.5); X.headlight.target.position.set(px + fx * 25, py, pz + fz * 25); X.headlight.target.updateMatrixWorld(); }
    if (X.ctx.stars) X.ctx.stars.position.set(cam.position.x, 0, cam.position.z);
    if (camMode === 'cockpit' && CK && pc) CK.mirrors(R.renderer, X.scene, pc.root);
    R.renderer.render(X.scene, cam);
    if (camMode === 'cockpit' && CK && pc) CK.render(R.renderer);
  };

  // Точка (qx, qz) закрывает игрока (px, pz) от камеры (cx, cz): рядом с отрезком камера-игрок или вплотную к камере.
  function fadeBetween(cx, cz, px, pz, qx, qz) {
    const dx = px - cx, dz = pz - cz, l2 = dx * dx + dz * dz || 1;
    const t = ((qx - cx) * dx + (qz - cz) * dz) / l2;
    if (Math.hypot(qx - cx, qz - cz) < 3.5) return true;
    if (t <= 0 || t >= 1.05) return false;
    return Math.abs((qx - cx) * dz - (qz - cz) * dx) / Math.sqrt(l2) < 2.4;
  }
  R.fadeBetween = fadeBetween;
  R._ = { capture, canvasTex, surfaceTex, wallTex, PROPS, mergeGeoms, M4, buildingGeom, particleSystem, emit, updateParticles, skidSystem, addSkid,
    buildCar, disposeCar, col, rngOf, getBlob, speckle, fbm };
  // Средняя яркость текстуры покрытия (для проверок: снег на дороге темнее сугробов).
  R.surfaceLuma = function (kind) {
    const t = surfaceTex(kind), c = t.image, g = c.getContext('2d'), d = g.getImageData(0, 0, c.width, c.height).data;
    let s = 0; for (let i = 0; i < d.length; i += 4) s += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    disposables.splice(disposables.indexOf(t), 1); t.dispose();
    return s / (d.length / 4) / 255;
  };

  // Мини-карта трассы: путь в координатах холста (для HUD и превью).
  R.minimapPath = function (tr, w, h, pad) {
    let minx = 1e9, maxx = -1e9, minz = 1e9, maxz = -1e9;
    for (let i = 0; i < tr.N; i++) { minx = Math.min(minx, tr.x[i]); maxx = Math.max(maxx, tr.x[i]); minz = Math.min(minz, tr.z[i]); maxz = Math.max(maxz, tr.z[i]); }
    const sc = Math.min((w - 2 * pad) / (maxx - minx), (h - 2 * pad) / (maxz - minz));
    const ox = (w - (maxx - minx) * sc) / 2, oz = (h - (maxz - minz) * sc) / 2;
    return { map: (x, z) => [ox + (maxx - x) * sc, oz + (z - minz) * sc], sc };
  };
})();
