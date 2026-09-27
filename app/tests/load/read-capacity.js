/**
 * ============================================================================
 *  tests/load/read-capacity.js — предельная пропускная способность на чтение
 * ============================================================================
 *  VUS виртуальных пользователей непрерывно (без пауз) открывают страницы:
 *  так измеряется, сколько запросов в секунду портал выдерживает и как
 *  растёт задержка. Запустите с разным VUS (10, 25, 50, 100…) — точка, где
 *  RPS перестаёт расти, а задержка резко увеличивается, и есть предел.
 *
 *  Смесь запросов (как у реальной вики):
 *    60% — статья, 10% — пространство (дерево страниц), 10% — главная,
 *    15% — поиск, 5% — список меток.
 *
 *  Запуск:
 *    k6 run -e VUS=50 -e DURATION=60s tests/load/read-capacity.js
 *    k6 run -e VUS=50 -e LOGIN=1 ...   — читатели вошли в систему
 *                                        (у вошедших на каждый запрос —
 *                                        продление сессии в базе)
 * ============================================================================
 */
import http from 'k6/http';
import { check } from 'k6';
import { BASE, collectPageIds, login, pick, pickId, SEARCH_TERMS, summaryTo } from './lib.js';

const VUS = Number(__ENV.VUS || 20);

export const options = {
  scenarios: {
    read: { executor: 'constant-vus', vus: VUS, duration: __ENV.DURATION || '60s' },
  },
  discardResponseBodies: true,
  /* Не сбрасывать cookie между итерациями: иначе k6 «разлогинивает» VU
   * после первой же итерации (по умолчанию корзина очищается). */
  noCookiesReset: true,
  setupTimeout: '5m', /* обход дерева страниц в setup() */
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
  /* Пороги нужны и для того, чтобы k6 посчитал задержку по каждому типу запроса. */
  thresholds: {
    'http_reqs{name:setup}': ['count>=0'], /* чтобы сводка могла вычесть запросы setup() */
    http_req_failed: ['rate<0.01'],
    'http_req_duration{name:page}': ['p(95)<1000'],
    'http_req_duration{name:space}': ['p(95)<2000'],
    'http_req_duration{name:home}': ['p(95)<1000'],
    'http_req_duration{name:search}': ['p(95)<1500'],
    'http_req_duration{name:labels}': ['p(95)<1000'],
  },
};

export function setup() {
  return { ids: collectPageIds() };
}

let loggedIn = false;

export default function (data) {
  if (__ENV.LOGIN && !loggedIn) {
    loggedIn = login(`lt_user_${((__VU - 1) % 1000) + 1}`);
  }
  const roll = Math.random();
  let res;
  if (roll < 0.6) {
    res = http.get(`${BASE}/pages/${pickId(data.ids)}`, { tags: { name: 'page' } });
  } else if (roll < 0.7) {
    const n = 1 + Math.floor(Math.random() * 45);
    res = http.get(`${BASE}/spaces/LOADT${String(n).padStart(2, '0')}`, { tags: { name: 'space' } });
  } else if (roll < 0.8) {
    res = http.get(`${BASE}/`, { tags: { name: 'home' } });
  } else if (roll < 0.95) {
    res = http.get(`${BASE}/search?q=${encodeURIComponent(pick(SEARCH_TERMS))}`, { tags: { name: 'search' } });
  } else {
    res = http.get(`${BASE}/labels`, { tags: { name: 'labels' } });
  }
  check(res, { 'статус 200': (r) => r.status === 200 });
}

export const handleSummary = summaryTo(`read-${__ENV.LOGIN ? 'auth-' : ''}${VUS}`);
