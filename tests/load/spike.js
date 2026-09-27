/**
 * ============================================================================
 *  tests/load/spike.js — всплеск: все пришли одновременно
 * ============================================================================
 *  Поведение пользователей — как в users.js (вход, чтение, поиск, правки),
 *  но нагрузка меняется скачком:
 *    1 мин  — фон BASE пользователей;
 *    15 с   — резкий рост до SPIKE (утро понедельника, рассылка со ссылкой);
 *    2 мин  — держим пик;
 *    15 с   — спад до BASE;
 *    1 мин  — проверяем, что портал «пришёл в себя» (задержки как до пика).
 *  Главное здесь — нет ли ошибок и зависаний во время массового входа
 *  (проверка пароля bcrypt — самая дорогая операция на сервере).
 *
 *  Запуск:  k6 run -e BASE_USERS=50 -e SPIKE=800 tests/load/spike.js
 * ============================================================================
 */
import users, { setup } from './users.js';
import { summaryTo } from './lib.js';

const BASE_USERS = Number(__ENV.BASE_USERS || 50);
const SPIKE = Number(__ENV.SPIKE || 800);

export { setup };

export const options = {
  scenarios: {
    spike: {
      executor: 'ramping-vus',
      startVUs: BASE_USERS,
      stages: [
        { duration: '1m', target: BASE_USERS },
        { duration: '15s', target: SPIKE },
        { duration: '2m', target: SPIKE },
        { duration: '15s', target: BASE_USERS },
        { duration: '1m', target: BASE_USERS },
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
    'http_req_duration{name:page}': ['p(95)<2000'],
    'http_req_duration{name:login}': ['p(95)<5000'],
    'http_req_duration{name:search}': ['p(95)<3000'],
    'http_req_duration{name:home}': ['p(95)<2000'],
  },
};

export default users;

export const handleSummary = summaryTo(`spike-${BASE_USERS}-${SPIKE}`);
