/**
 * ============================================================================
 *  tests/load/lib.js — общие функции для сценариев k6
 * ============================================================================
 *  k6 (https://k6.io) — инструмент нагрузочного тестирования: каждый
 *  «виртуальный пользователь» (VU) выполняет функцию сценария в цикле,
 *  у каждого VU своя cookie-корзина (своя сессия на портале).
 *
 *  Переменные окружения (передаются через -e ИМЯ=значение):
 *    BASE_URL  — адрес портала (по умолчанию http://app:3000 — имя сервиса
 *                в docker compose, если k6 запущен в той же сети);
 *    PASSWORD  — пароль тестовых пользователей (по умолчанию из seed-load.js);
 *    PAGE_RANGES — id тестовых страниц, например "39994-58457" или
 *                "10-500,900-1200". Без неё setup() сам обходит дерево
 *                страниц (несколько тысяч запросов, 10–30 секунд) и
 *                печатает готовое значение для следующих запусков.
 * ============================================================================
 */
import http from 'k6/http';
import { check, fail } from 'k6';
import { Trend } from 'k6/metrics';

/* Длительность setup() — чтобы в сводке считать запросы в секунду только
 * за время самого теста (без обхода дерева страниц). */
const setupTime = new Trend('setup_time', true);

export const BASE = __ENV.BASE_URL || 'http://app:3000';
export const PASSWORD = __ENV.PASSWORD || 'LoadTest123!';

/* Ответы, тело которых нужно разобрать (CSRF-токен, id страниц), читаются
 * с responseType 'text'; для остальных тело отбрасывается
 * (discardResponseBodies в options сценария) — k6 тратит меньше памяти. */
export const TEXT = { responseType: 'text' };

/** Случайный элемент массива. */
export const pick = (list) => list[Math.floor(Math.random() * list.length)];

/** Пауза «пользователь читает страницу»: от min до max секунд. */
export const think = (min, max) => min + Math.random() * (max - min);

/** CSRF-токен из формы (<input name="_csrf">) или из <meta name="csrf-token">. */
export function csrfFrom(res) {
  const body = res.body || '';
  const m = body.match(/name="_csrf" value="([^"]+)"/) || body.match(/name="csrf-token" content="([^"]+)"/);
  return m ? m[1] : null;
}

/**
 * Вход пользователя: GET /login (получаем CSRF и cookie), POST /login.
 * Возвращает true при успехе. Сессионная cookie сохраняется в корзине VU.
 */
export function login(username, password = PASSWORD) {
  const page = http.get(`${BASE}/login`, { ...TEXT, tags: { name: 'login_form' } });
  const token = csrfFrom(page);
  if (!token) return false;
  const res = http.post(`${BASE}/login`, { _csrf: token, login: username, password }, {
    redirects: 0,
    tags: { name: 'login' },
  });
  return check(res, { 'вход выполнен (302)': (r) => r.status === 302 && !String(r.headers.Location).includes('/login') });
}

/**
 * id страниц открытых пространств LOADT01–LOADT45 — вызывается в setup()
 * один раз перед тестом. Результат setup() копируется в КАЖДЫЙ VU, поэтому
 * 20 000 id сжимаются в диапазоны [от, до] (seed-load.js создаёт страницы
 * подряд) — иначе при тысячах VU k6 потратил бы гигабайты памяти.
 */
export function collectPageIds(maxSpaces = 45) {
  if (__ENV.PAGE_RANGES) {
    return __ENV.PAGE_RANGES.split(',').map((part) => part.split('-').map(Number)).map(([a, b]) => [a, b ?? a]);
  }
  const started = Date.now();
  const ids = new Set();
  const queue = [];
  const harvest = (body) => {
    for (const m of body.matchAll(/href="\/pages\/(\d+)/g)) ids.add(Number(m[1]));
    for (const m of body.matchAll(/data-tree-lazy="(\d+)"/g)) queue.push(Number(m[1]));
  };
  /* Страница пространства показывает только корневые страницы; свёрнутые
   * ветки (data-tree-lazy) обходим через /api/pages/:id/children — по 25
   * запросов параллельно, как дерево раскрывал бы пользователь. */
  for (let i = 1; i <= maxSpaces; i++) {
    const key = `LOADT${String(i).padStart(2, '0')}`;
    const res = http.get(`${BASE}/spaces/${key}`, { ...TEXT, tags: { name: 'setup' } });
    if (res.status === 200) harvest(res.body);
  }
  const seen = new Set();
  while (queue.length) {
    const batch = queue.splice(0, 25).filter((id) => !seen.has(id) && seen.add(id));
    const responses = http.batch(batch.map((id) => ['GET', `${BASE}/api/pages/${id}/children`, null, { ...TEXT, tags: { name: 'setup' } }]));
    responses.forEach((res) => { if (res.status === 200) harvest(res.body); });
  }
  if (!ids.size) fail('Нет тестовых страниц — сначала запустите: node src/tools/seed-load.js --yes');
  const sorted = [...ids].sort((a, b) => a - b);
  const ranges = [];
  for (const id of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && id === last[1] + 1) last[1] = id;
    else ranges.push([id, id]);
  }
  console.log(`Страниц для теста: ${sorted.length} (диапазонов: ${ranges.length})`);
  if (ranges.length <= 20) console.log(`Для следующих запусков: -e PAGE_RANGES=${ranges.map(([a, b]) => (a === b ? a : `${a}-${b}`)).join(',')}`);
  setupTime.add(Date.now() - started);
  return ranges;
}

/** Случайный id из диапазонов collectPageIds (с учётом длины диапазонов). */
export function pickId(ranges) {
  const total = ranges.reduce((sum, [a, b]) => sum + b - a + 1, 0);
  let n = Math.floor(Math.random() * total);
  for (const [a, b] of ranges) {
    if (n <= b - a) return a + n;
    n -= b - a + 1;
  }
  return ranges[0][0];
}

/* Редкие «термины» из словаря seed-load.js — функция должна совпадать с term() там. */
const SYLLABLES = ['ка', 'ро', 'ми', 'та', 'ле', 'ну', 'со', 'вер', 'ди', 'па', 'лу', 'ник', 'ост', 'ран', 'зе', 'бы'];
function term(i) {
  let n = i + 256;
  let word = '';
  while (n > 0) { word = SYLLABLES[n % 16] + word; n = Math.floor(n / 16); }
  return word;
}

/**
 * Поисковые запросы разной «частоты» (словарь seed-load.js распределён по Ципфу):
 *   сервер, база данных      — самые частые слова, есть почти на каждой странице
 *                              (худший случай: ранжировать приходится всё);
 *   пароль, согласование…    — средние, на части страниц;
 *   термины                  — редкие, от нескольких процентов страниц до единиц;
 *   несуществующее слово     — пустой результат.
 */
export const SEARCH_TERMS = ['сервер', 'база данных', 'пароль', 'согласование срок', 'ответственный',
  term(50), term(300), term(1500), term(6000), term(15000), 'несуществующееслово', `${term(100)} ${term(900)}`];

/** Сводка в JSON для отчёта: k6 run ... → /out/<name>.json (если папка смонтирована). */
export function summaryTo(name) {
  return (data) => {
    const out = { stdout: textSummary(data) };
    if (__ENV.OUT_DIR) out[`${__ENV.OUT_DIR}/${name}.json`] = JSON.stringify(data, null, 1);
    return out;
  };
}

/* Короткая текстовая сводка: RPS, задержки по типам запросов, ошибки. */
function textSummary(data) {
  const m = data.metrics;
  const fmt = (v) => (v === undefined ? '-' : v >= 1000 ? `${(v / 1000).toFixed(2)}s` : `${v.toFixed(0)}ms`);
  const lines = [];
  /* Запросы setup() (тег name:setup) не считаем: RPS — только за время теста. */
  const setupCount = m['http_reqs{name:setup}']?.values.count ?? 0;
  const count = (m.http_reqs?.values.count ?? 0) - setupCount;
  const seconds = (data.state.testRunDurationMs - (m.setup_time?.values.max ?? 0)) / 1000;
  const failed = m.http_req_failed?.values;
  const dur = m.http_req_duration?.values;
  lines.push(`\n  запросов: ${count}  (${(count / seconds).toFixed(1)}/с)   ошибок: ${((failed?.rate ?? 0) * 100).toFixed(2)}%`);
  lines.push(`  задержка всех: p50=${fmt(dur?.med)} p90=${fmt(dur?.['p(90)'])} p95=${fmt(dur?.['p(95)'])} p99=${fmt(dur?.['p(99)'])} max=${fmt(dur?.max)}`);
  for (const [key, metric] of Object.entries(m)) {
    const tag = key.match(/^http_req_duration\{name:([^,}]+)\}$/);
    if (!tag || tag[1] === 'setup') continue;
    const v = metric.values;
    lines.push(`    ${tag[1].padEnd(14)} p50=${fmt(v.med)} p95=${fmt(v['p(95)'])} p99=${fmt(v['p(99)'])} max=${fmt(v.max)}`);
  }
  /* users.js: фаза удержания (все пользователи уже вошли) — отдельным блоком. */
  const hold = m['http_req_duration{phase:hold}']?.values;
  if (hold) {
    const holdFailed = m['http_req_failed{phase:hold}']?.values;
    lines.push(`  [удержание] все: p50=${fmt(hold.med)} p95=${fmt(hold['p(95)'])} p99=${fmt(hold['p(99)'])} max=${fmt(hold.max)}   ошибок: ${((holdFailed?.rate ?? 0) * 100).toFixed(2)}%`);
    for (const name of ['page', 'search']) {
      const v = m[`http_req_duration{name:${name},phase:hold}`]?.values;
      if (v) lines.push(`  [удержание] ${name.padEnd(8)} p50=${fmt(v.med)} p95=${fmt(v['p(95)'])} p99=${fmt(v['p(99)'])} max=${fmt(v.max)}`);
    }
  }
  const checks = m.checks?.values;
  if (checks) lines.push(`  проверок пройдено: ${(checks.rate * 100).toFixed(2)}% (${checks.passes} из ${checks.passes + checks.fails})`);
  if (m.vus_max) lines.push(`  VU максимум: ${m.vus_max.values.max}`);
  return `${lines.join('\n')}\n`;
}
