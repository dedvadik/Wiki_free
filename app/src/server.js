/**
 * ============================================================================
 *  server.js — точка входа: подготовка окружения и запуск HTTP-сервера
 * ============================================================================
 *  Последовательность запуска:
 *   1. создать папки для данных (загрузки);
 *   2. получить секрет сессий (из env или сгенерировать и сохранить);
 *   3. дождаться готовности PostgreSQL;
 *   4. применить миграции схемы БД;
 *   5. найти темы оформления и загрузить настройки сайта в память;
 *   6. создать администратора и демо-контент (только на пустой базе);
 *   7. запустить HTTP-сервер (и сервер метрик, если задан METRICS_PORT);
 *   8. корректно завершаться по сигналам SIGTERM/SIGINT (docker stop, Ctrl+C).
 *
 *  Несколько копий (Kubernetes): шаги 4 и 6 выполняет init-контейнер
 *  (tools/prepare.js), а здесь они пропускаются при RUN_MIGRATIONS=false;
 *  настройки сайта раз в SETTINGS_SYNC_SECONDS перечитываются из базы,
 *  чтобы изменения из админки дошли до всех копий.
 * ============================================================================
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { closePools, waitForDatabase } from './db/pool.js';
import { runMigrations } from './db/migrate.js';
import { loadSettings, startSettingsSync } from './services/settings.js';
import { loadThemes } from './services/themes.js';
import { bootstrapData } from './services/bootstrap.js';
import { startDraining } from './services/lifecycle.js';
import { startMetricsServer } from './services/metrics.js';
import { createApp } from './app.js';

/* ----------------------------------------------------------------------------
 * Секрет для подписи cookie сессий. Если его знает злоумышленник, он может
 * подделать cookie, поэтому:
 *   - если задан SESSION_SECRET — используем его;
 *   - иначе генерируем криптостойкий случайный секрет ОДИН раз и сохраняем
 *     в DATA_DIR (volume), чтобы после перезапуска контейнера пользователей
 *     не «выкидывало» из системы.
 *  Файл создаётся с флагом 'wx' («только если его ещё нет»): если несколько
 *  копий с общим томом стартуют одновременно, выиграет одна, а остальные
 *  прочитают её секрет — у всех копий он должен быть одинаковым. (В
 *  Kubernetes секрет всегда приходит из Secret через SESSION_SECRET.)
 * ------------------------------------------------------------------------- */
async function resolveSessionSecret() {
  if (config.sessionSecret) return config.sessionSecret;

  const file = path.join(config.dataDir, '.session-secret');
  try {
    const saved = (await fs.readFile(file, 'utf8')).trim();
    if (saved.length >= 32) return saved;
  } catch {
    /* файла ещё нет — создадим ниже */
  }
  const secret = crypto.randomBytes(48).toString('hex');
  try {
    await fs.writeFile(file, secret, { mode: 0o600, flag: 'wx' });
  } catch (err) {
    if (err.code === 'EEXIST') return (await fs.readFile(file, 'utf8')).trim(); /* другая копия успела первой */
    throw err;
  }
  console.log(`[server] SESSION_SECRET не задан — сгенерирован новый и сохранён в ${file}`);
  return secret;
}

async function main() {
  console.log(`[server] Запуск WikiSpace (Node ${process.version}, ${process.platform}/${process.arch})`);

  /* 1. Папки для данных. recursive: true — не ошибка, если уже существуют. */
  await fs.mkdir(config.uploadsDir, { recursive: true });

  /* 2–6. Подготовка. */
  const sessionSecret = await resolveSessionSecret();
  await waitForDatabase();
  if (config.runMigrations) await runMigrations();
  /* Темы читаются до настроек: настройка «тема сайта» проверяется по реестру. */
  loadThemes();
  await loadSettings();
  if (config.runMigrations) await bootstrapData();
  startSettingsSync(config.settingsSyncSeconds);

  /* 7. HTTP-сервер. */
  const { app, sessionStore } = createApp({ sessionSecret });
  const server = app.listen(config.port, config.host, () => {
    console.log(`[server] Сайт доступен на http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);
  });
  /* Время на приём ВСЕГО запроса. По умолчанию в Node.js — 5 минут: видео
   * на сотни мегабайт по медленному каналу (VPN, мобильный интернет) не
   * успевало бы загрузиться. Час с запасом; от медленной отправки
   * заголовков по-прежнему защищает headersTimeout (60 с). */
  server.requestTimeout = 60 * 60 * 1000;
  /* Keep-alive дольше, чем у балансировщика перед приложением (nginx ingress
   * держит соединение до 60 с): иначе Node закрывал бы соединение, которое
   * балансировщик ещё считает открытым, и часть запросов получала бы 502.
   * headersTimeout обязан быть больше keepAliveTimeout. */
  server.keepAliveTimeout = 65 * 1000;
  server.headersTimeout = 66 * 1000;

  const metricsServer = config.metricsPort ? startMetricsServer(config.metricsPort) : null;

  /* --------------------------------------------------------------------------
   * 8. Корректное завершение (graceful shutdown) в два этапа:
   *   а) «draining»: /healthz начинает отвечать 503, балансировщик
   *      (Kubernetes) убирает копию из ротации, а она ещё
   *      SHUTDOWN_DELAY_SECONDS принимает запросы, которые успели к ней
   *      направить (в docker compose — 0 с, ждать некого);
   *   б) перестаём принимать новые соединения, даём завершиться текущим
   *      запросам, закрываем пулы БД и выходим.
   * Если что-то зависло — через SHUTDOWN_DELAY + SHUTDOWN_TIMEOUT секунд
   * выходим принудительно (docker stop ждёт 10 с, Kubernetes — сколько
   * задано в terminationGracePeriodSeconds).
   * ---------------------------------------------------------------------- */
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    startDraining();
    console.log(`[server] Получен ${signal}, завершаю работу...`);
    setTimeout(() => process.exit(1), (config.shutdownDelaySeconds + config.shutdownTimeoutSeconds) * 1000).unref();
    setTimeout(() => {
      server.close(async () => {
        sessionStore.close();
        metricsServer?.close();
        await closePools();
        console.log('[server] Остановлен');
        process.exit(0);
      });
      /* Закрываем «висящие» keep-alive соединения, иначе close() будет ждать их. */
      server.closeIdleConnections?.();
    }, config.shutdownDelaySeconds * 1000);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[server] Не удалось запустить приложение:', err);
  process.exit(1);
});
