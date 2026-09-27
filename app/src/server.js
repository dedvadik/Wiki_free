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
 *   7. запустить HTTP-сервер;
 *   8. корректно завершаться по сигналам SIGTERM/SIGINT (docker stop, Ctrl+C).
 * ============================================================================
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { pool, waitForDatabase } from './db/pool.js';
import { runMigrations } from './db/migrate.js';
import { loadSettings } from './services/settings.js';
import { loadThemes } from './services/themes.js';
import { ensureInitialAdmin, seedDemoContent } from './services/bootstrap.js';
import { createApp } from './app.js';

/* ----------------------------------------------------------------------------
 * Секрет для подписи cookie сессий. Если его знает злоумышленник, он может
 * подделать cookie, поэтому:
 *   - если задан SESSION_SECRET — используем его;
 *   - иначе генерируем криптостойкий случайный секрет ОДИН раз и сохраняем
 *     в DATA_DIR (volume), чтобы после перезапуска контейнера пользователей
 *     не «выкидывало» из системы.
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
  await fs.writeFile(file, secret, { mode: 0o600 });
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
  await runMigrations();
  /* Темы читаются до настроек: настройка «тема сайта» проверяется по реестру. */
  loadThemes();
  await loadSettings();
  await ensureInitialAdmin();
  await seedDemoContent();

  /* 7. HTTP-сервер. */
  const { app, sessionStore } = createApp({ sessionSecret });
  const server = app.listen(config.port, config.host, () => {
    console.log(`[server] Сайт доступен на http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);
  });

  /* --------------------------------------------------------------------------
   * 8. Корректное завершение (graceful shutdown).
   * docker stop посылает SIGTERM и ждёт 10 секунд, затем убивает процесс.
   * Мы перестаём принимать новые соединения, даём завершиться текущим
   * запросам, закрываем пул БД и выходим. Если что-то зависло — через 8 с
   * выходим принудительно.
   * ---------------------------------------------------------------------- */
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[server] Получен ${signal}, завершаю работу...`);
    setTimeout(() => process.exit(1), 8000).unref();
    server.close(async () => {
      sessionStore.close();
      await pool.end().catch(() => {});
      console.log('[server] Остановлен');
      process.exit(0);
    });
    /* Закрываем «висящие» keep-alive соединения, иначе close() будет ждать их. */
    server.closeIdleConnections?.();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[server] Не удалось запустить приложение:', err);
  process.exit(1);
});
