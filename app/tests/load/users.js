/**
 * ============================================================================
 *  tests/load/users.js — сколько пользователей могут работать одновременно
 * ============================================================================
 *  Каждый виртуальный пользователь ведёт себя как человек:
 *   - входит под своим логином (lt_user_N из seed-load.js) и загружает
 *     стили/скрипты, как браузер при первом визите;
 *   - дальше по кругу: действие → пауза «читаю» THINK_MIN…THINK_MAX секунд.
 *
 *  Действия (доли):
 *    45% статья (+ иногда раскрывает ветку дерева)   8% главная
 *    10% пространство                                10% поиск → открывает результат
 *     5% метки         5% история страницы           3% избранное (POST)
 *     2% комментарий (POST)
 *    у редакторов (каждый 10-й пользователь) 12% действий — правка статьи:
 *    открыть редактор → сохранить новую версию (как в браузере).
 *
 *  Нагрузка: USERS пользователей набираются за RAMP, держатся HOLD.
 *  Запуск:
 *    k6 run -e USERS=500 tests/load/users.js
 *    k6 run -e USERS=1000 -e RAMP=3m -e HOLD=5m -e THINK_MIN=10 -e THINK_MAX=30 tests/load/users.js
 *
 *  Итог «портал выдерживает N пользователей» — наибольшее USERS, при
 *  котором ошибок < 1% и 95% открытий статей быстрее 1 секунды.
 * ============================================================================
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import exec from 'k6/execution';
import { BASE, TEXT, collectPageIds, csrfFrom, login, pick, pickId, SEARCH_TERMS, summaryTo, think } from './lib.js';

const USERS = Number(__ENV.USERS || 200);
const THINK_MIN = Number(__ENV.THINK_MIN || 5);
const THINK_MAX = Number(__ENV.THINK_MAX || 15);
/* Длительность набора пользователей в мс ("90s", "2m" → число). */
const RAMP = __ENV.RAMP || '2m';
const RAMP_MS = (parseFloat(RAMP) || 0) * (RAMP.endsWith('m') ? 60000 : 1000);

const NAMES = ['page', 'children', 'space', 'home', 'search', 'labels', 'history', 'favorite', 'comment', 'edit_form', 'save', 'login'];

export const options = {
  scenarios: {
    users: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: RAMP, target: USERS },
        { duration: __ENV.HOLD || '3m', target: USERS },
        { duration: '20s', target: 0 },
      ],
      gracefulRampDown: '30s',
    },
  },
  discardResponseBodies: true,
  /* Не сбрасывать cookie между итерациями: иначе k6 «разлогинивает» VU
   * после первой же итерации (по умолчанию корзина очищается). */
  noCookiesReset: true,
  setupTimeout: '5m', /* обход дерева страниц в setup() */
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
  thresholds: {
    'http_reqs{name:setup}': ['count>=0'], /* чтобы сводка могла вычесть запросы setup() */
    http_req_failed: ['rate<0.01'],
    /* Отдельно — фаза удержания (все уже вошли): это и есть «работают одновременно». */
    'http_req_failed{phase:hold}': ['rate<0.01'],
    'http_req_duration{phase:hold}': ['p(95)<1000'],
    'http_req_duration{name:page,phase:hold}': ['p(95)<1000'],
    'http_req_duration{name:search,phase:hold}': ['p(95)<2000'],
    'http_req_duration{name:page}': ['p(95)<1000'],
    ...Object.fromEntries(NAMES.filter((n) => n !== 'page').map((n) => [`http_req_duration{name:${n}}`, ['p(95)<3000']])),
  },
};

export function setup() {
  return { ids: collectPageIds() };
}

/* Состояние VU (у каждого VU свой экземпляр модуля): сессия, CSRF-токен, роль. */
let me = null;

/** Первый визит: вход + главная + статика (как у браузера с пустым кэшем). */
function start() {
  const n = ((__VU - 1) % 1000) + 1;
  const ok = login(`lt_user_${n}`);
  const home = http.get(`${BASE}/`, { ...TEXT, tags: { name: 'home' } });
  http.batch(['/css/app.css', '/js/app.js', '/js/theme-init.js', '/theme.css', '/img/logo.svg']
    .map((url) => ['GET', BASE + url, null, { tags: { name: 'static' } }]));
  me = { ok, isEditor: n % 10 === 0, csrf: csrfFrom(home) };
}

const ok200 = (res, what) => check(res, { [`${what}: 200`]: (r) => r.status === 200 });

function viewPage(id) {
  ok200(http.get(`${BASE}/pages/${id}`, { tags: { name: 'page' } }), 'статья');
}

/** Правка статьи: GET редактора, разбор формы, POST новой версии. */
function editPage(data) {
  const id = pickId(data.ids);
  const form = http.get(`${BASE}/pages/${id}/edit`, { ...TEXT, tags: { name: 'edit_form' } });
  if (!ok200(form, 'редактор')) return;
  const body = form.body;
  const unescape = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#34;/g, '"').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  const field = (re) => { const m = body.match(re); return m ? unescape(m[1]) : ''; };
  const payload = {
    _csrf: csrfFrom(form),
    base_version: field(/name="base_version" value="(\d+)"/),
    attachment_ids: '',
    title: field(/class="editor-title" name="title" value="([^"]*)"/),
    content: `${field(/<textarea name="content"[^>]*>\n?([\s\S]*?)<\/textarea>/)}\n\nПравка из нагрузочного теста ${Date.now()}.`,
    parent_id: field(/<option value="(\d+)" selected>/),
    position: field(/name="position" value="(-?\d+)"/) || '0',
    labels: field(/id="labels" name="labels" value="([^"]*)"/),
    change_note: 'Нагрузочный тест',
  };
  sleep(think(20, 60)); /* человек редактирует текст */
  const saved = http.post(`${BASE}/pages/${id}`, payload, { redirects: 0, tags: { name: 'save' } });
  check(saved, { 'сохранение: 302': (r) => r.status === 302 });
}

export default function (data) {
  /* Метка фазы: ramp — пользователи ещё входят, hold — все на месте. */
  exec.vu.metrics.tags.phase = Date.now() - exec.scenario.startTime < RAMP_MS ? 'ramp' : 'hold';
  if (!me) start();

  const roll = Math.random();
  if (me.isEditor && roll < 0.12) {
    editPage(data);
  } else if (roll < 0.45) {
    viewPage(pickId(data.ids));
    if (Math.random() < 0.2) {
      ok200(http.get(`${BASE}/api/pages/${pickId(data.ids)}/children`, { tags: { name: 'children' } }), 'ветка дерева');
    }
  } else if (roll < 0.55) {
    const n = 1 + Math.floor(Math.random() * 45);
    ok200(http.get(`${BASE}/spaces/LOADT${String(n).padStart(2, '0')}`, { tags: { name: 'space' } }), 'пространство');
  } else if (roll < 0.63) {
    ok200(http.get(`${BASE}/`, { tags: { name: 'home' } }), 'главная');
  } else if (roll < 0.73) {
    const res = http.get(`${BASE}/search?q=${encodeURIComponent(pick(SEARCH_TERMS))}`, { ...TEXT, tags: { name: 'search' } });
    ok200(res, 'поиск');
    const found = [...(res.body || '').matchAll(/href="\/pages\/(\d+)/g)].map((m) => m[1]);
    if (found.length) { sleep(think(2, 5)); viewPage(pick(found)); }
  } else if (roll < 0.78) {
    ok200(http.get(`${BASE}/labels`, { tags: { name: 'labels' } }), 'метки');
  } else if (roll < 0.83) {
    ok200(http.get(`${BASE}/pages/${pickId(data.ids)}/history`, { tags: { name: 'history' } }), 'история');
  } else if (roll < 0.86) {
    const res = http.post(`${BASE}/pages/${pickId(data.ids)}/favorite`, { _csrf: me.csrf }, { redirects: 0, tags: { name: 'favorite' } });
    check(res, { 'избранное: 302': (r) => r.status === 302 });
  } else if (roll < 0.88) {
    const res = http.post(`${BASE}/pages/${pickId(data.ids)}/comments`,
      { _csrf: me.csrf, content: `Комментарий нагрузочного теста, VU ${__VU}.` }, { redirects: 0, tags: { name: 'comment' } });
    check(res, { 'комментарий: 302': (r) => r.status === 302 });
  } else {
    viewPage(pickId(data.ids));
  }

  sleep(think(THINK_MIN, THINK_MAX));
}

export const handleSummary = summaryTo(`users-${USERS}`);
