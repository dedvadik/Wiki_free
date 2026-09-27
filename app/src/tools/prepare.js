/**
 * ============================================================================
 *  tools/prepare.js — подготовка базы данных отдельной командой
 * ============================================================================
 *  Делает то же, что сервер при старте с RUN_MIGRATIONS=true, но без
 *  запуска сайта:
 *    1. ждёт, пока PostgreSQL начнёт принимать соединения;
 *    2. применяет миграции схемы (под advisory-блокировкой);
 *    3. создаёт администратора и демо-пространство на пустой базе
 *       (тоже под блокировкой);
 *    4. если DOCS_IMPORT=true — публикует документацию кода (docs/portal).
 *
 *  Зачем отдельно. В Kubernetes эта команда выполняется init-контейнером
 *  каждой копии приложения ДО основного контейнера, причём напрямую с
 *  PostgreSQL (мимо PgBouncer: advisory-блокировки привязаны к соединению
 *  и через пулер в режиме транзакций не работают). Основной контейнер
 *  стартует с RUN_MIGRATIONS=false и сразу обслуживает запросы. Благодаря
 *  блокировкам безопасно, даже если одновременно стартуют десятки копий:
 *  работу выполнит первая, остальные увидят готовую базу за миллисекунды.
 *
 *  Запуск:  node src/tools/prepare.js      (npm run prepare-db)
 * ============================================================================
 */
import { closePools, waitForDatabase, withAdvisoryLock } from '../db/pool.js';
import { runMigrations } from '../db/migrate.js';
import { bootstrapData } from '../services/bootstrap.js';
import { loadSettings } from '../services/settings.js';
import { loadThemes } from '../services/themes.js';
import { importDocs } from './import-docs.js';

const DOCS_LOCK_ID = 7300453;

async function main() {
  const started = Date.now();
  /* В кластере PostgreSQL может подниматься дольше, чем контейнер приложения:
   * ждём до 5 минут (60 попыток по 5 секунд). */
  await waitForDatabase({ attempts: 60, delayMs: 5000 });
  await runMigrations();
  loadThemes();
  await loadSettings();
  await bootstrapData();
  /* Импорт документации — тоже под блокировкой: иначе одновременно
   * стартующие копии попытались бы создать одно и то же пространство. */
  if (process.env.DOCS_IMPORT === 'true') await withAdvisoryLock(DOCS_LOCK_ID, importDocs);
  console.log(`[prepare] База данных готова (${Date.now() - started} мс)`);
}

main()
  .then(() => closePools())
  .catch(async (err) => {
    console.error('[prepare] Подготовка базы не выполнена:', err.message);
    await closePools();
    process.exit(1);
  });
