/* Horizon Drift - данные игры: машины, трассы, чемпионаты, тюнинг, клавиши.
   Всё придумано для этой игры: марок, моделей и настоящих трасс здесь нет.
   Файл работает и в странице (window.DriftData), и в node (require) - для проверок. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api; else root.DriftData = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- Машины ----------
  // kw - мощность, top - максимальная скорость (км/ч), grip - сцепление шин,
  // steer - наибольший угол руля (рад), drift - склонность к заносу 0..1 (задняя ось легче срывается,
  // ручник сильнее), offroad - поправка сцепления на гравии и снегу, drive - ведущие колёса,
  // launch - предел тяги с места в долях веса, aero - прижим на скорости.
  const CARS = [
    { id: 'iskra', name: 'Искра', cls: 'Хэтчбек', price: 0, tier: 1, shape: 'hatch', drive: 'fwd',
      mass: 1050, kw: 105, top: 192, grip: 1.0, steer: 0.62, drift: 0.2, offroad: 1.06, launch: 0.85, aero: 0.05,
      color: '#e8412c', about: 'Лёгкий и послушный городской хэтчбек. С него всё начинается.' },
    { id: 'kobalt', name: 'Кобальт R', cls: 'Купе', price: 8000, tier: 1, shape: 'coupe', drive: 'rwd',
      mass: 1180, kw: 170, top: 214, grip: 1.1, steer: 0.6, drift: 0.55, offroad: 1.0, launch: 0.9, aero: 0.08,
      color: '#2f7dd8', about: 'Заднеприводное купе: быстрее «Искры» и охотно идёт боком.' },
    { id: 'vihr', name: 'Вихрь', cls: 'Дрифт-купе', price: 15000, tier: 2, shape: 'fastback', drive: 'rwd',
      mass: 1220, kw: 220, top: 228, grip: 1.11, steer: 0.68, drift: 0.9, offroad: 0.98, launch: 0.95, aero: 0.1,
      color: '#f2b02a', about: 'Сделан для заноса: большой угол руля и лёгкая задняя ось.' },
    { id: 'buran', name: 'Буран 4x4', cls: 'Раллийный', price: 19000, tier: 2, shape: 'rally', drive: 'awd',
      mass: 1290, kw: 195, top: 222, grip: 1.03, steer: 0.62, drift: 0.45, offroad: 1.28, launch: 1.0, aero: 0.08,
      color: '#3fae5a', about: 'Полный привод и раллийная подвеска: король гравия и снега.' },
    { id: 'sapsan', name: 'Сапсан GT', cls: 'Гран-турер', price: 28000, tier: 3, shape: 'gt', drive: 'rwd',
      mass: 1390, kw: 300, top: 262, grip: 1.2, steer: 0.6, drift: 0.5, offroad: 0.95, launch: 1.0, aero: 0.18,
      color: '#8f98a8', about: 'Быстрый и устойчивый гран-турер для длинных трасс.' },
    { id: 'taifun', name: 'Тайфун V8', cls: 'Маслкар', price: 34000, tier: 3, shape: 'muscle', drive: 'rwd',
      mass: 1560, kw: 390, top: 270, grip: 1.18, steer: 0.58, drift: 0.8, offroad: 0.95, launch: 1.05, aero: 0.1,
      color: '#7a2de0', about: 'Тяжёлый, мощный и шумный. На прямой не догнать, в повороте - держать крепче.' },
    { id: 'kometa', name: 'Комета', cls: 'Суперкар', price: 48000, tier: 4, shape: 'wedge', drive: 'rwd',
      mass: 1340, kw: 440, top: 306, grip: 1.27, steer: 0.58, drift: 0.4, offroad: 0.9, launch: 1.1, aero: 0.3,
      color: '#f06a1a', about: 'Клиновидный суперкар со средним мотором. Очень цепкий на асфальте.' },
    { id: 'mirage', name: 'Мираж X', cls: 'Гиперкар', price: 70000, tier: 4, shape: 'hyper', drive: 'awd',
      mass: 1400, kw: 560, top: 336, grip: 1.33, steer: 0.58, drift: 0.35, offroad: 0.95, launch: 1.2, aero: 0.35,
      color: '#16c7c0', about: 'Вершина гаража: полный привод, огромная мощность, прижим как у болида.' },
  ];

  // ---------- Тюнинг ----------
  // Каждый уровень меняет характеристику на долю из eff: итог = база * (1 + доля * уровень).
  const UPGRADES = [
    { id: 'engine', name: 'Двигатель', about: '+10% мощности и +3% максимальной скорости за уровень', eff: { power: 0.10, top: 0.03 } },
    { id: 'tyres', name: 'Шины', about: '+6% сцепления за уровень', eff: { grip: 0.06 } },
    { id: 'susp', name: 'Подвеска', about: '+3% сцепления и +5% отзывчивости руля за уровень', eff: { grip: 0.03, steer: 0.05 } },
    { id: 'weight', name: 'Облегчение', about: '-5% массы за уровень', eff: { mass: -0.05 } },
    { id: 'nitro', name: 'Нитро', about: '+30% запаса и +10% силы нитро за уровень', eff: { nitroCap: 0.30, nitroBoost: 0.10 } },
  ];
  const UPG_MAX = 3;
  const UPG_PRICE = [1200, 2800, 5500];          // цена уровней 1, 2, 3 до поправки на класс машины
  const TIER_MUL = { 1: 1, 2: 1.4, 3: 1.9, 4: 2.5 };

  // ---------- Покрытия ----------
  const SURF = {
    asphalt: { name: 'асфальт', mu: 1.0, drag: 0, adapt: false },
    gravel: { name: 'гравий', mu: 0.74, drag: 0.02, adapt: true },
    snow: { name: 'снег', mu: 0.56, drag: 0.015, adapt: true },
    grass: { name: 'трава', mu: 0.62, drag: 0.07, adapt: true },
    sand: { name: 'песок', mu: 0.58, drag: 0.09, adapt: true },
    snowbank: { name: 'сугроб', mu: 0.46, drag: 0.09, adapt: true },
    concrete: { name: 'бетон', mu: 0.92, drag: 0.004, adapt: false },
  };

  // ---------- Трассы ----------
  // Трасса задаётся «черепашкой»: S - прямая (длина, м), R/L - дуга вправо/влево (градусы, радиус).
  // Для кольцевых две прямые 'auto' получают такую длину, чтобы кольцо замкнулось.
  // elev - высоты по равным долям длины, surfaces - участки другого покрытия [от, до, покрытие].
  const TRACKS = [
    { id: 'city', name: 'Неоновый квартал', place: 'Ночной город', theme: 'city', closed: true, width: 12, runoff: 3,
      surface: 'asphalt', runoffSurf: 'concrete', laps: 3,
      cmds: [['S', 170], ['R', 90, 24], ['S', 130], ['R', 90, 22], ['S', 70], ['L', 90, 20], ['S', 60], ['R', 90, 22],
        ['S', 'auto'], ['R', 90, 26], ['S', 80], ['R', 45, 40], ['L', 45, 40], ['S', 'auto'], ['R', 90, 24]],
      elev: [0, 0, 1, 3, 4, 2, 0, 0] },
    { id: 'coast', name: 'Лазурный берег', place: 'Побережье', theme: 'coast', closed: true, width: 13, runoff: 4,
      surface: 'asphalt', runoffSurf: 'sand', laps: 3,
      cmds: [['S', 240], ['R', 60, 110], ['S', 90], ['L', 40, 80], ['R', 80, 60], ['S', 'auto'], ['R', 100, 55], ['S', 70],
        ['L', 30, 90], ['R', 70, 60], ['S', 'auto'], ['R', 40, 80], ['R', 80, 70]],
      elev: [2, 4, 9, 14, 12, 6, 3, 2, 2] },
    { id: 'serpentine', name: 'Орлиный серпантин', place: 'Горы', theme: 'mountain', closed: false, width: 10, runoff: 3,
      surface: 'asphalt', runoffSurf: 'grass', laps: 1,
      cmds: [['S', 110], ['L', 30, 90], ['S', 90], ['R', 180, 23], ['S', 150], ['L', 180, 24], ['S', 160], ['R', 60, 55],
        ['S', 70], ['L', 90, 45], ['S', 110], ['R', 180, 23], ['S', 140], ['L', 70, 50], ['S', 120], ['R', 40, 80], ['S', 90]],
      elev: [0, 6, 16, 28, 40, 52, 64, 76, 88, 98, 104] },
    { id: 'desert', name: 'Красный каньон', place: 'Пустыня', theme: 'desert', closed: true, width: 13, runoff: 4,
      surface: 'gravel', runoffSurf: 'sand', laps: 2, surfaces: [[0, 0.1, 'asphalt'], [0.93, 1, 'asphalt']],
      cmds: [['S', 220], ['R', 90, 60], ['S', 'auto'], ['R', 60, 50], ['L', 60, 45], ['S', 80], ['R', 120, 30], ['S', 'auto'],
        ['L', 30, 60], ['R', 90, 50], ['S', 100], ['R', 90, 70]],
      elev: [0, 2, 6, 10, 8, 4, 6, 3, 0] },
    { id: 'forest', name: 'Лесная тропа', place: 'Тайга', theme: 'forest', closed: false, width: 10, runoff: 3,
      surface: 'gravel', runoffSurf: 'grass', laps: 1,
      cmds: [['S', 100], ['R', 50, 70], ['L', 70, 55], ['S', 80], ['R', 90, 40], ['S', 60], ['L', 60, 60], ['R', 40, 80],
        ['S', 120], ['L', 110, 35], ['S', 70], ['R', 70, 50], ['L', 50, 70], ['S', 100], ['R', 100, 38], ['S', 90],
        ['L', 45, 90], ['S', 80]],
      elev: [0, 4, 10, 8, 14, 20, 16, 22, 26, 20, 18] },
    { id: 'pass', name: 'Ледяной перевал', place: 'Зимние горы', theme: 'winter', closed: false, width: 11, runoff: 3,
      surface: 'snow', runoffSurf: 'snowbank', laps: 1,
      cmds: [['S', 120], ['R', 40, 90], ['S', 80], ['L', 180, 26], ['S', 130], ['R', 180, 26], ['S', 120], ['L', 60, 70],
        ['S', 100], ['R', 90, 50], ['S', 80], ['L', 120, 35], ['S', 110], ['R', 60, 80], ['S', 100]],
      elev: [0, 5, 14, 24, 34, 42, 50, 56, 60, 62, 62] },
    { id: 'lake', name: 'Северное озеро', place: 'Зима', theme: 'lake', closed: true, width: 13, runoff: 4,
      surface: 'snow', runoffSurf: 'snowbank', laps: 2, surfaces: [[0, 0.14, 'asphalt'], [0.46, 0.6, 'asphalt']],
      cmds: [['S', 200], ['R', 50, 90], ['L', 40, 70], ['R', 80, 60], ['S', 'auto'], ['R', 60, 80], ['L', 50, 60],
        ['R', 90, 50], ['S', 'auto'], ['R', 60, 70], ['L', 30, 80], ['R', 60, 65], ['S', 90], ['R', 80, 70]],
      elev: [0, 1, 3, 5, 4, 2, 1, 0] },
    { id: 'port', name: 'Портовый дрифт', place: 'Порт на закате', theme: 'port', closed: true, width: 14, runoff: 4,
      surface: 'asphalt', runoffSurf: 'concrete', laps: 3,
      cmds: [['S', 150], ['R', 90, 26], ['S', 'auto'], ['R', 90, 24], ['S', 50], ['L', 180, 22], ['S', 40], ['R', 90, 28],
        ['S', 30], ['R', 90, 26], ['S', 'auto'], ['L', 90, 30], ['R', 90, 28], ['R', 90, 30], ['S', 250], ['R', 90, 28]],
      elev: [0, 0, 0, 0] },
  ];

  // ---------- Оформление трасс ----------
  const THEMES = {
    city: { night: true, sky: ['#05060f', '#1b1440'], fog: '#120d2a', hemi: ['#6d6aa8', '#1a1420', 0.45], sun: ['#8fa2ff', 0.35],
      ground: 'concrete', wall: 'concrete', terrain: 'flat', decor: ['building', 'lamp'], stands: true, water: null, headlights: true },
    coast: { night: false, sky: ['#4f9fe0', '#d8eefc'], fog: '#c9e4f6', hemi: ['#cfe8ff', '#8c7a5a', 0.75], sun: ['#fff4dc', 1.35],
      ground: 'sand', wall: 'rail', terrain: 'coast', decor: ['palm', 'rock', 'lamp'], stands: true, water: { color: '#1d6fa3', level: -3 } },
    mountain: { night: false, sky: ['#e8894a', '#f6d7a8'], fog: '#e9c9a2', hemi: ['#ffd9b0', '#4a4a3a', 0.7], sun: ['#ffc98a', 1.2],
      ground: 'grass', wall: 'rail', terrain: 'slope', decor: ['pine', 'rock'], stands: false, water: null },
    desert: { night: false, sky: ['#4a8fd0', '#f3dcb3'], fog: '#efd6ae', hemi: ['#ffe9c8', '#9a5a36', 0.8], sun: ['#fff0d0', 1.45],
      ground: 'redsand', wall: 'tyres', terrain: 'canyon', decor: ['cactus', 'rock'], stands: true, water: null },
    forest: { night: false, sky: ['#6fa6d6', '#dfeadf'], fog: '#b9cdbc', hemi: ['#d8ecd8', '#3a4a2a', 0.8], sun: ['#fff6e0', 1.1],
      ground: 'grass', wall: 'logs', terrain: 'hills', decor: ['pine', 'tree', 'rock'], stands: false, water: null },
    winter: { night: false, sky: ['#8aa4c4', '#e6edf5'], fog: '#dfe7f0', hemi: ['#ffffff', '#8898aa', 0.9], sun: ['#f2f6ff', 0.95],
      ground: 'snow', wall: 'snowwall', terrain: 'slope', decor: ['snowpine', 'rock'], stands: false, water: null, snowfall: true },
    lake: { night: false, sky: ['#b58ab8', '#f4d6c6'], fog: '#e8d4d0', hemi: ['#fff0f0', '#8090a8', 0.85], sun: ['#ffd8c0', 1.0],
      ground: 'snow', wall: 'snowwall', terrain: 'lake', decor: ['snowpine', 'rock'], stands: true, water: { color: '#bcd6ea', level: -1.2, ice: true } },
    port: { night: false, sunset: true, sky: ['#3b2a5c', '#ff9a5a'], fog: '#d98a6a', hemi: ['#ffc0a0', '#40304a', 0.65], sun: ['#ff9c60', 1.15],
      ground: 'concrete', wall: 'concrete', terrain: 'port', decor: ['container', 'lamp'], stands: true, water: { color: '#24476a', level: -2.5 }, headlights: true },
  };

  // ---------- Чемпионаты ----------
  // pace - темп соперников (доля от их идеального темпа) на сложности «нормально»,
  // pool - машины соперников, mult - множитель призовых. Для заездов на время медали считаются
  // от эталонного круга машины ref: золото = эталон * 1.05, серебро * 1.12, бронза * 1.22 (core.js, TIME_MEDALS).
  const CUPS = [
    { id: 'c1', name: 'Кубок новичка', about: 'Первые шаги: город ночью, побережье и порт.', pace: 0.8, pool: ['iskra', 'kobalt'], mult: 1,
      events: [
        { id: 'c1e1', type: 'race', track: 'city', laps: 2, opp: 3, name: 'Огни квартала' },
        { id: 'c1e2', type: 'drift', track: 'port', laps: 2, goal: [8000, 4500, 1800], name: 'Первый занос' },
        { id: 'c1e3', type: 'time', track: 'coast', laps: 1, ref: 'iskra', name: 'Круг у моря' },
      ] },
    { id: 'c2', name: 'Кубок побережья', about: 'Быстрые виражи у моря и первая дуэль.', pace: 0.82, pool: ['kobalt', 'vihr', 'buran'], mult: 1.6,
      events: [
        { id: 'c2e1', type: 'race', track: 'coast', laps: 2, opp: 4, name: 'Береговая гонка' },
        { id: 'c2e2', type: 'duel', track: 'port', laps: 2, name: 'Дуэль в порту' },
        { id: 'c2e3', type: 'drift', track: 'city', laps: 2, goal: [11000, 6000, 2500], name: 'Неоновый дрифт' },
        { id: 'c2e4', type: 'time', track: 'serpentine', laps: 1, ref: 'kobalt', name: 'Подъём на время' },
      ] },
    { id: 'c3', name: 'Гравийный кубок', about: 'Пыль, гравий и скользкие повороты.', pace: 0.87, pool: ['buran', 'vihr', 'sapsan'], mult: 2.3,
      events: [
        { id: 'c3e1', type: 'race', track: 'desert', laps: 2, opp: 4, name: 'Каньон' },
        { id: 'c3e2', type: 'time', track: 'forest', laps: 1, ref: 'buran', name: 'Лесной спринт' },
        { id: 'c3e3', type: 'drift', track: 'desert', laps: 1, goal: [9500, 5500, 2500], name: 'Пыльный занос' },
        { id: 'c3e4', type: 'elim', track: 'desert', opp: 3, name: 'На вылет' },
      ] },
    { id: 'c4', name: 'Зимний кубок', about: 'Снег и лёд: сцепления мало, ошибок много.', pace: 0.87, pool: ['buran', 'sapsan', 'taifun'], mult: 3,
      events: [
        { id: 'c4e1', type: 'race', track: 'lake', laps: 2, opp: 4, name: 'Вокруг озера' },
        { id: 'c4e2', type: 'drift', track: 'pass', laps: 1, goal: [9000, 5500, 2500], name: 'Снежный вальс' },
        { id: 'c4e3', type: 'elim', track: 'lake', opp: 4, name: 'Ледяное выбывание' },
        { id: 'c4e4', type: 'duel', track: 'pass', laps: 1, name: 'Дуэль на перевале' },
      ] },
    { id: 'c5', name: 'Гран-при Горизонта', about: 'Финал: лучшие гонщики и самые быстрые машины.', pace: 0.87, pool: ['sapsan', 'taifun', 'kometa'], mult: 4,
      events: [
        { id: 'c5e1', type: 'race', track: 'serpentine', laps: 1, opp: 5, name: 'Штурм серпантина' },
        { id: 'c5e2', type: 'elim', track: 'city', opp: 4, name: 'Последний в квартале' },
        { id: 'c5e3', type: 'duel', track: 'coast', laps: 2, name: 'Дуэль чемпионов' },
        { id: 'c5e4', type: 'race', track: 'port', laps: 3, opp: 5, name: 'Большой финал' },
      ] },
  ];

  const EVENT_TYPES = {
    race: { name: 'Гонка', about: 'Обгоните соперников. Медаль за 1-3 место.' },
    drift: { name: 'Дрифт', about: 'Наберите очки заносами. Медаль по очкам, удар срывает комбо.' },
    time: { name: 'На время', about: 'Один на трассе. Медаль по времени.' },
    duel: { name: 'Дуэль', about: 'Один на один с чемпионом кубка. Золото только за победу.' },
    elim: { name: 'На вылет', about: 'После каждого круга последний выбывает. Медаль за 1-3 место.' },
  };

  const BASE_REWARD = 3500;
  const PLACE_SHARE = [1, 0.6, 0.35, 0.15, 0.1, 0.05];       // доля награды за 1-6 место
  const MEDAL_SHARE = { gold: 1, silver: 0.6, bronze: 0.35, none: 0.1 };

  const DRIVERS = ['Рыжий', 'Шторм', 'Барон', 'Лиса', 'Граф', 'Мистраль', 'Ветер', 'Сова', 'Кнут', 'Молния', 'Туман', 'Беркут'];
  const RIVALS = { c1: 'Рыжий', c2: 'Шторм', c3: 'Барон', c4: 'Лиса', c5: 'Граф' };

  // ---------- Внешний вид ----------
  const PAINTS = ['#e8412c', '#f06a1a', '#f2b02a', '#3fae5a', '#16c7c0', '#2f7dd8', '#3a3fd0', '#7a2de0', '#d83a8c',
    '#f4f4f4', '#8f98a8', '#2a2d33', '#101114', '#b08a4a'];
  const RIMS = [{ id: 'spoke5', name: '5 спиц' }, { id: 'mesh', name: 'Сетка' }, { id: 'solid', name: 'Диск' }, { id: 'turbine', name: 'Турбина' }];
  const RIM_COLORS = ['#c9ced6', '#2a2d33', '#d4a83a', '#e8412c', '#f4f4f4'];
  const LIVERIES = [{ id: 'none', name: 'Без рисунка' }, { id: 'stripes', name: 'Полосы' }, { id: 'flames', name: 'Пламя' },
    { id: 'checker', name: 'Шашки' }, { id: 'number', name: 'Номер' }, { id: 'split', name: 'Два цвета' }, { id: 'shards', name: 'Осколки' }];

  // ---------- Управление ----------
  const ACTIONS = [
    { id: 'accel', name: 'Газ' }, { id: 'brake', name: 'Тормоз / назад' }, { id: 'left', name: 'Руль влево' },
    { id: 'right', name: 'Руль вправо' }, { id: 'handbrake', name: 'Ручник' }, { id: 'nitro', name: 'Нитро' },
    { id: 'shiftUp', name: 'Передача вверх' }, { id: 'shiftDown', name: 'Передача вниз' }, { id: 'camera', name: 'Камера' },
    { id: 'reset', name: 'Вернуться на трассу' }, { id: 'pause', name: 'Пауза (и Esc)' },
  ];
  const DEFAULT_BINDINGS = {
    accel: ['KeyW', 'ArrowUp'], brake: ['KeyS', 'ArrowDown'], left: ['KeyA', 'ArrowLeft'], right: ['KeyD', 'ArrowRight'],
    handbrake: ['Space', ''], nitro: ['ShiftLeft', 'ShiftRight'], shiftUp: ['KeyE', ''], shiftDown: ['KeyQ', ''],
    camera: ['KeyC', ''], reset: ['KeyR', ''], pause: ['KeyP', ''],
  };

  const DEFAULT_SETTINGS = {
    musicVol: 0.5, sfxVol: 0.8, engineVol: 0.7, difficulty: 'normal', units: 'kmh',
    bindings: DEFAULT_BINDINGS, steerSens: 1, gearbox: 'auto', tc: true, abs: true, steerAssist: true,
    quality: 'high', shadows: true, drawDist: 'far', particles: 'high', showFps: false, camera: 'chase', motionBlur: true,
    gamepad: true, deadzone: 0.15,
  };
  const QUALITY = {
    low: { pixelRatio: 0.75, shadowMap: 0, decor: 0.35, particles: 'low', drawDist: 'near', aa: false },
    medium: { pixelRatio: 1, shadowMap: 1024, decor: 0.6, particles: 'medium', drawDist: 'mid', aa: false },
    high: { pixelRatio: 1, shadowMap: 2048, decor: 1, particles: 'high', drawDist: 'far', aa: true },
    ultra: { pixelRatio: 1.5, shadowMap: 4096, decor: 1.4, particles: 'high', drawDist: 'far', aa: true },
  };
  const DRAW_DIST = { near: 380, mid: 650, far: 1000 };
  const DIFFICULTY = { easy: { name: 'Легко', pace: -0.07, mistakes: 0.05 }, normal: { name: 'Нормально', pace: 0, mistakes: 0.025 },
    hard: { name: 'Сложно', pace: 0.05, mistakes: 0.008 } };

  return { CARS, UPGRADES, UPG_MAX, UPG_PRICE, TIER_MUL, SURF, TRACKS, THEMES, CUPS, EVENT_TYPES, BASE_REWARD, PLACE_SHARE,
    MEDAL_SHARE, DRIVERS, RIVALS, PAINTS, RIMS, RIM_COLORS, LIVERIES, ACTIONS, DEFAULT_BINDINGS, DEFAULT_SETTINGS, QUALITY,
    DRAW_DIST, DIFFICULTY };
});
