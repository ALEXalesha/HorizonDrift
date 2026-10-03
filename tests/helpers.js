// Общие помощники проверок: адрес страницы и сбор ошибок консоли.
// Страницы открываются по файловому адресу: сервер им не нужен.
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
// Где лежит страница в этом репозитории (имя папки в исходном сборнике -> папка здесь)
const DIRS = require('./pages.json');
const WEB = ROOT;

function dirOf(name) {
  return name in DIRS ? path.join(ROOT, DIRS[name]) : path.join(ROOT, name);
}

function pages() {
  return Object.keys(DIRS).filter((d) => fs.existsSync(path.join(dirOf(d), 'index.html'))).sort();
}

function pageUrl(name) {
  return pathToFileURL(path.join(dirOf(name), 'index.html')).href;
}

// Захват мыши в проверках только поддельный: настоящий requestPointerLock в безголовом
// Chromium на Windows зажимает курсор пользователя в скрытом окне. Ставится до скриптов
// страницы и во всех её рамках; помощники отдельных игр ставят свою, более полную подмену.
function fakePointerLock() {
  if (window.__lockStubbed || window.__fakeLockBase) return;
  window.__fakeLockBase = true;
  let el = null;
  const fire = () => document.dispatchEvent(new Event('pointerlockchange'));
  Element.prototype.requestPointerLock = function () { el = this; setTimeout(fire); return Promise.resolve(); };
  Document.prototype.exitPointerLock = function () { if (!el) return; el = null; setTimeout(fire); };
  Object.defineProperty(Document.prototype, 'pointerLockElement', { configurable: true, get() { return el; } });
}

// Открыть страницу и собирать всё, что она роняет: исключения и console.error.
// Внешние запросы (шрифты, CDN) отсекаются: страница обязана работать без сети.
async function open(page, name) {
  const errors = [];
  await page.addInitScript(fakePointerLock);
  page.on('pageerror', (e) => errors.push(String(e && e.stack || e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.route(/^https?:\/\//, (route) => route.abort());
  await page.goto(pageUrl(name));
  return errors;
}

module.exports = { ROOT, WEB, dirOf, pages, pageUrl, open, fakePointerLock };
