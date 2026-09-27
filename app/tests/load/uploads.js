/**
 * ============================================================================
 *  tests/load/uploads.js — какие файлы можно загрузить и как портал
 *                          выдерживает одновременные загрузки
 * ============================================================================
 *  Сценарий matrix (1 пользователь, один проход) — проверка по типам и размерам:
 *   - 18 типов файлов (картинки, документы, архивы, видео, исполняемые,
 *     HTML/SVG/JS): каждый должен загрузиться; растровые картинки и видео
 *     (mp4, webm, mov) показываются в браузере (inline), всё остальное —
 *     только скачивание (Content-Disposition: attachment); всегда CSP
 *     sandbox + nosniff;
 *   - размеры 1, 10, 19,9 и ровно 20 МБ — принимаются; 20 МБ + 1 байт и
 *     50 МБ — отказ 413 (лимит UPLOAD_MAX_MB, по умолчанию 20);
 *   - видео 50 МБ — принимается (свой лимит VIDEO_MAX_MB, по умолчанию 200),
 *     видео VIDEO_MAX_MB + 1 байт — отказ 413.
 *  Сценарий concurrent — UPLOADERS редакторов непрерывно грузят файлы по
 *  UPLOAD_MB МБ, а параллельно READERS читателей открывают статьи:
 *  видно, мешают ли загрузки остальным.
 *
 *  Запуск:  k6 run -e UPLOADERS=10 -e UPLOAD_MB=5 tests/load/uploads.js
 * ============================================================================
 */
import http from 'k6/http';
import { check, group, sleep } from 'k6';
import encoding from 'k6/encoding';
import { BASE, TEXT, collectPageIds, csrfFrom, login, pickId, summaryTo } from './lib.js';

const MB = 1024 * 1024;
const UPLOADERS = Number(__ENV.UPLOADERS || 10);
const UPLOAD_MB = Number(__ENV.UPLOAD_MB || 5);
const MAX_MB = Number(__ENV.UPLOAD_MAX_MB || 20);
const VIDEO_MAX_MB = Number(__ENV.VIDEO_MAX_MB || 200);

export const options = {
  scenarios: {
    matrix: { executor: 'shared-iterations', vus: 1, iterations: 1, exec: 'matrix', maxDuration: '5m' },
    concurrent: { executor: 'constant-vus', vus: UPLOADERS, duration: '60s', exec: 'concurrent', startTime: '10s' },
    readers: { executor: 'constant-vus', vus: Number(__ENV.READERS || 5), duration: '60s', exec: 'reader', startTime: '10s' },
  },
  discardResponseBodies: true,
  /* Не сбрасывать cookie между итерациями: иначе k6 «разлогинивает» VU
   * после первой же итерации (по умолчанию корзина очищается). */
  noCookiesReset: true,
  setupTimeout: '5m', /* обход дерева страниц в setup() */
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
  thresholds: {
    'http_reqs{name:setup}': ['count>=0'], /* чтобы сводка могла вычесть запросы setup() */
    checks: ['rate>0.99'],
    'http_req_duration{name:upload}': ['p(95)<10000'],
    'http_req_duration{name:page}': ['p(95)<1000'],
    'http_req_duration{name:download}': ['p(95)<5000'],
  },
};

export function setup() {
  return { ids: collectPageIds() };
}

/* Минимальная настоящая картинка PNG 1×1 — для «честной» картинки. */
const PNG_1PX = encoding.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==');

/** Буфер нужного размера: сигнатура формата + заполнитель. */
function makeFile(bytes, header = '') {
  const buf = new Uint8Array(bytes);
  for (let i = 0; i < header.length && i < bytes; i++) buf[i] = header.charCodeAt(i) & 0xff;
  for (let i = header.length; i < bytes; i += 4096) buf[i] = i % 251; /* не нули — как в настоящем файле */
  return buf.buffer;
}

/** Вход редактором (каждый 10-й lt_user — редактор) и CSRF-токен для fetch-запросов. */
function loginEditor(n) {
  login(`lt_user_${n}`);
  return csrfFrom(http.get(`${BASE}/`, { ...TEXT, tags: { name: 'home' } }));
}

function upload(csrf, pageId, data, name, type) {
  return http.post(`${BASE}/api/uploads`, {
    page_id: String(pageId),
    file: http.file(data, name, type),
  }, { ...TEXT, headers: { 'X-CSRF-Token': csrf }, tags: { name: 'upload' }, timeout: '120s' });
}

/* ------------------------------------------------------------------------- */
export function matrix(data) {
  const csrf = loginEditor(10);
  const pageId = data.ids[0][0];

  group('типы файлов', () => {
    /* [имя, тип от браузера, как показывается: image | video | file] */
    const TYPES = [
      ['photo.png', 'image/png', 'image'], ['photo.jpg', 'image/jpeg', 'image'], ['anim.gif', 'image/gif', 'image'],
      ['pic.webp', 'image/webp', 'image'], ['icon.ico', 'image/x-icon', 'image'], ['scheme.svg', 'image/svg+xml', 'file'],
      ['report.pdf', 'application/pdf', 'file'], ['letter.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'file'],
      ['table.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'file'], ['archive.zip', 'application/zip', 'file'],
      ['notes.txt', 'text/plain', 'file'], ['data.csv', 'text/csv', 'file'],
      ['video.mp4', 'video/mp4', 'video'], ['clip.webm', 'video/webm', 'video'], ['iphone.mov', 'application/octet-stream', 'video'],
      ['setup.exe', 'application/x-msdownload', 'file'], ['page.html', 'text/html', 'file'], ['script.js', 'text/javascript', 'file'],
    ];
    for (const [name, type, kind] of TYPES) {
      const inline = kind !== 'file';
      const body = name === 'photo.png' ? PNG_1PX : makeFile(50 * 1024, name.endsWith('.svg') ? '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script>' : '');
      const res = upload(csrf, pageId, body, name, type);
      const json = res.status === 200 ? res.json() : {};
      check(res, {
        [`${name}: загружен`]: (r) => r.status === 200 && Boolean(json.url),
        [`${name}: ${{ image: 'картинка', video: 'видеоплеер', file: 'ссылка на файл' }[kind]}`]: () => json.isImage === (kind === 'image')
          && Boolean(json.isVideo) === (kind === 'video'),
      });
      if (!json.url) continue;
      const file = http.get(`${BASE}${json.url}`, { tags: { name: 'download' } });
      const disposition = String(file.headers['Content-Disposition'] || '');
      check(file, {
        [`${name}: скачивается`]: (r) => r.status === 200,
        [`${name}: ${inline ? 'inline' : 'attachment'}`]: () => (inline ? !disposition.includes('attachment') : disposition.includes('attachment')),
        [`${name}: тип ответа`]: (r) => kind !== 'video' || String(r.headers['Content-Type']).startsWith('video/'),
        [`${name}: CSP sandbox + nosniff`]: (r) => String(r.headers['Content-Security-Policy']).includes('sandbox')
          && r.headers['X-Content-Type-Options'] === 'nosniff',
      });
    }
  });

  group('размеры', () => {
    const SIZES = [
      ['1 МБ', MB, 200], ['10 МБ', 10 * MB, 200], [`${MAX_MB - 0.1} МБ`, Math.floor((MAX_MB - 0.1) * MB), 200],
      [`ровно ${MAX_MB} МБ`, MAX_MB * MB, 200], [`${MAX_MB} МБ + 1 байт`, MAX_MB * MB + 1, 413], ['50 МБ', 50 * MB, 413],
    ];
    for (const [label, bytes, expected] of SIZES) {
      const started = Date.now();
      const res = upload(csrf, pageId, makeFile(bytes, '%PDF-1.7'), 'big.pdf', 'application/pdf');
      console.log(`размер ${label}: HTTP ${res.status} за ${Date.now() - started} мс`);
      check(res, { [`${label}: HTTP ${expected}`]: (r) => r.status === expected });
    }
    /* У видео свой, больший лимит. */
    for (const [label, bytes, expected] of [['видео 50 МБ', 50 * MB, 200], [`видео ${VIDEO_MAX_MB} МБ + 1 байт`, VIDEO_MAX_MB * MB + 1, 413]]) {
      const started = Date.now();
      const res = upload(csrf, pageId, makeFile(bytes), 'big.mp4', 'video/mp4');
      console.log(`размер ${label}: HTTP ${res.status} за ${Date.now() - started} мс`);
      check(res, { [`${label}: HTTP ${expected}`]: (r) => r.status === expected });
    }
  });

  group('права', () => {
    /* Читатель (не редактор) загрузить не может. */
    http.cookieJar().clear(BASE);
    login('lt_user_1');
    const token = csrfFrom(http.get(`${BASE}/`, { ...TEXT, tags: { name: 'home' } }));
    const res = upload(token, pageId, PNG_1PX, 'x.png', 'image/png');
    check(res, { 'читатель: загрузка запрещена (403)': (r) => r.status === 403 });
  });
}

/* ------------------------------------------------------------------------- */
let csrf = null;
let blob = null;

export function concurrent(data) {
  if (!csrf) {
    csrf = loginEditor(10 * (((__VU - 1) % 100) + 1)); /* lt_user_10, 20, … — редакторы */
    blob = makeFile(UPLOAD_MB * MB, '%PDF-1.7');
  }
  const res = upload(csrf, pickId(data.ids), blob, `load-${__VU}-${__ITER}.pdf`, 'application/pdf');
  check(res, { 'параллельная загрузка: 200': (r) => r.status === 200 });
  sleep(1);
}

export function reader(data) {
  const res = http.get(`${BASE}/pages/${pickId(data.ids)}`, { tags: { name: 'page' } });
  check(res, { 'статья во время загрузок: 200': (r) => r.status === 200 });
  sleep(1);
}

export const handleSummary = summaryTo(`uploads-${UPLOADERS}x${UPLOAD_MB}mb`);
