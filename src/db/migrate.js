/**
 * ============================================================================
 *  db/migrate.js — простой механизм миграций схемы базы данных
 * ============================================================================
 *  Миграция — это SQL-файл в папке src/db/migrations с именем вида
 *  "001_init.sql", "002_add_something.sql". Файлы применяются по порядку
 *  имён, каждый ровно один раз. Список применённых миграций хранится в
 *  таблице schema_migrations.
 *
 *  Чтобы изменить схему в будущем, НЕ редактируйте старые файлы — добавьте
 *  новый со следующим номером. При следующем старте он применится сам.
 *
 *  Запуск: автоматически при старте сервера, либо вручную `npm run migrate`.
 * ============================================================================
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { pool, waitForDatabase } from './pool.js';

const MIGRATIONS_DIR = path.join(import.meta.dirname, 'migrations');

/* Произвольный числовой идентификатор для advisory-блокировки PostgreSQL.
 * Если одновременно стартуют несколько копий приложения (например, при
 * масштабировании), только одна из них будет применять миграции, остальные
 * подождут — это защищает от двойного применения. */
const MIGRATION_LOCK_ID = 7300451;

export async function runMigrations() {
  /* Берём отдельное соединение: advisory lock привязан к соединению. */
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);

    /* Служебная таблица учёта миграций (создаётся при самом первом запуске). */
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);

    /* Множество уже применённых миграций. */
    const { rows } = await client.query('SELECT name FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.name));

    /* Все .sql-файлы, отсортированные по имени (поэтому важны ведущие нули). */
    const files = (await fs.readdir(MIGRATIONS_DIR))
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      if (applied.has(file)) continue;

      const sql = await fs.readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      console.log(`[migrate] Применяю ${file} ...`);

      /* Каждая миграция — в своей транзакции: либо применится целиком,
       * либо не применится вовсе (PostgreSQL поддерживает транзакционный DDL). */
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Миграция ${file} не применена: ${err.message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => {});
    client.release();
  }
}

/* ----------------------------------------------------------------------------
 * Режим отдельного скрипта: `node src/db/migrate.js`.
 * Сравниваем URL текущего модуля с файлом, переданным в node, — если совпадают,
 * значит файл запущен напрямую, а не импортирован из server.js.
 * ------------------------------------------------------------------------- */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  waitForDatabase()
    .then(runMigrations)
    .then(() => {
      console.log('[migrate] Все миграции применены');
      return pool.end();
    })
    .catch((err) => {
      console.error('[migrate]', err.message);
      process.exit(1);
    });
}
