/**
 * ============================================================================
 *  services/metrics.js — метрики для Prometheus и автомасштабирования
 * ============================================================================
 *  Включаются переменной METRICS_PORT (например, 9464): метрики отдаются на
 *  ОТДЕЛЬНОМ порту по адресу /metrics. Этот порт не публикуется наружу
 *  (в Kubernetes его видят только Prometheus и KEDA внутри кластера), поэтому
 *  посторонние не узнают, сколько у портала запросов и памяти.
 *
 *  Формат — текстовый формат Prometheus 0.0.4; внешних зависимостей нет.
 *
 *  Что измеряется:
 *    wikispace_http_requests_total{method,status}  — счётчик запросов;
 *    wikispace_http_request_duration_seconds        — гистограмма времени ответа;
 *    wikispace_http_requests_in_flight              — запросов в работе сейчас
 *                                                     (лучший сигнал для KEDA);
 *    wikispace_event_loop_lag_seconds{quantile}      — задержка цикла событий
 *                                                     Node.js: растёт, когда
 *                                                     процесс перегружен;
 *    wikispace_db_pool_connections{pool,state}       — соединения с PostgreSQL
 *                                                     (waiting > 0 — нехватка);
 *    process_* / nodejs_*                            — память, CPU, время работы.
 *  Проверки /healthz и /livez в счётчики запросов не попадают.
 * ============================================================================
 */
import http from 'node:http';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { pool, readPool } from '../db/pool.js';

/* Границы корзин гистограммы времени ответа (секунды). */
const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

const requestCounts = new Map(); /* "METHOD|status" → число */
const duration = { buckets: new Array(BUCKETS.length).fill(0), sum: 0, count: 0 };
let inFlight = 0;

/* Задержка цикла событий: Node.js сам замеряет её в фоне. */
const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();

const PROBES = new Set(['/healthz', '/livez']);

/** Middleware: считает каждый запрос (подключается первым в app.js). */
export function metricsMiddleware(req, res, next) {
  if (PROBES.has(req.path)) return next();
  const started = process.hrtime.bigint();
  inFlight += 1;
  let done = false;
  const finish = () => {
    if (done) return; /* 'close' приходит и после 'finish' */
    done = true;
    inFlight -= 1;
    const seconds = Number(process.hrtime.bigint() - started) / 1e9;
    const key = `${req.method}|${res.statusCode}`;
    requestCounts.set(key, (requestCounts.get(key) ?? 0) + 1);
    duration.sum += seconds;
    duration.count += 1;
    /* Корзины накопительные: наблюдение попадает во все корзины с le ≥ seconds. */
    for (let i = 0; i < BUCKETS.length; i++) if (seconds <= BUCKETS[i]) duration.buckets[i] += 1;
  };
  res.on('finish', finish);
  res.on('close', finish);
  return next();
}

/** Текст всех метрик в формате Prometheus. */
function render() {
  const lines = [];
  const metric = (name, type, help, samples) => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    for (const [labels, value] of samples) lines.push(`${name}${labels} ${value}`);
  };

  metric('wikispace_http_requests_total', 'counter', 'Обработанные HTTP-запросы',
    [...requestCounts].map(([key, n]) => {
      const [method, status] = key.split('|');
      return [`{method="${method}",status="${status}"}`, n];
    }));

  lines.push('# HELP wikispace_http_request_duration_seconds Время ответа на HTTP-запрос',
    '# TYPE wikispace_http_request_duration_seconds histogram');
  BUCKETS.forEach((le, i) => lines.push(`wikispace_http_request_duration_seconds_bucket{le="${le}"} ${duration.buckets[i]}`));
  lines.push(`wikispace_http_request_duration_seconds_bucket{le="+Inf"} ${duration.count}`,
    `wikispace_http_request_duration_seconds_sum ${duration.sum}`,
    `wikispace_http_request_duration_seconds_count ${duration.count}`);

  metric('wikispace_http_requests_in_flight', 'gauge', 'Запросов в работе прямо сейчас', [['', inFlight]]);

  /* Значения — в наносекундах, переводим в секунды. После выдачи сбрасываем,
   * чтобы метрика показывала задержку за последний интервал опроса. */
  metric('wikispace_event_loop_lag_seconds', 'gauge', 'Задержка цикла событий Node.js', [
    ['{quantile="0.5"}', loopDelay.percentile(50) / 1e9],
    ['{quantile="0.99"}', loopDelay.percentile(99) / 1e9],
    ['{quantile="1"}', loopDelay.max / 1e9],
  ]);
  loopDelay.reset();

  const pools = [['primary', pool]];
  if (readPool !== pool) pools.push(['read', readPool]);
  metric('wikispace_db_pool_connections', 'gauge', 'Соединения пула PostgreSQL',
    pools.flatMap(([name, p]) => [
      [`{pool="${name}",state="total"}`, p.totalCount],
      [`{pool="${name}",state="idle"}`, p.idleCount],
      [`{pool="${name}",state="waiting"}`, p.waitingCount],
    ]));

  const memory = process.memoryUsage();
  const cpu = process.cpuUsage();
  metric('process_resident_memory_bytes', 'gauge', 'Занятая процессом память', [['', memory.rss]]);
  metric('nodejs_heap_used_bytes', 'gauge', 'Используемая куча V8', [['', memory.heapUsed]]);
  metric('nodejs_heap_total_bytes', 'gauge', 'Выделенная куча V8', [['', memory.heapTotal]]);
  metric('process_cpu_seconds_total', 'counter', 'Процессорное время', [['', (cpu.user + cpu.system) / 1e6]]);
  metric('process_uptime_seconds', 'gauge', 'Время работы процесса', [['', process.uptime()]]);
  return `${lines.join('\n')}\n`;
}

/** Запустить сервер метрик на отдельном порту; вернёт http.Server. */
export function startMetricsServer(port) {
  const server = http.createServer((req, res) => {
    if (req.url !== '/metrics') {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
    res.end(render());
  });
  server.listen(port, '0.0.0.0', () => console.log(`[metrics] Метрики Prometheus: http://0.0.0.0:${port}/metrics`));
  return server;
}
