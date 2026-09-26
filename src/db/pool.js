/**
 * ============================================================================
 *  db/pool.js — подключение к PostgreSQL и вспомогательные функции запросов
 * ============================================================================
 *  Используется пул соединений из драйвера `pg` (чистый JavaScript, без
 *  нативных модулей — важно для сборки Docker-образа под разные архитектуры).
 *
 *  Пул держит несколько открытых соединений и раздаёт их запросам, чтобы
 *  не тратить время на установку нового TCP-соединения при каждом запросе.
 *
 *  Все SQL-запросы в проекте ПАРАМЕТРИЗОВАНЫ ($1, $2, ...): значения
 *  передаются отдельно от текста запроса, что исключает SQL-инъекции.
 * ============================================================================
 */
import pg from 'pg';
import { config } from '../config.js';

/* ----------------------------------------------------------------------------
 * Создание пула. connectionString может быть undefined — тогда pg читает
 * стандартные переменные окружения PGHOST / PGUSER / PGPASSWORD / PGDATABASE.
 * idleTimeoutMillis — через сколько закрывать простаивающее соединение.
 * ------------------------------------------------------------------------- */
export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: config.dbPoolMax,
  idleTimeoutMillis: 30_000,
});

/* Ошибка на простаивающем соединении (например, перезапуск PostgreSQL) не
 * должна «ронять» весь процесс — пул сам пересоздаст соединение. Логируем. */
pool.on('error', (err) => {
  console.error('[db] Ошибка простаивающего соединения:', err.message);
});

/* ----------------------------------------------------------------------------
 * Короткие обёртки над pool.query, чтобы в маршрутах писать меньше кода:
 *   query(sql, params) → полный результат (rows, rowCount, ...)
 *   many(sql, params)  → массив строк
 *   one(sql, params)   → первая строка или null
 * ------------------------------------------------------------------------- */
export function query(text, params = []) {
  return pool.query(text, params);
}

export async function many(text, params = []) {
  const { rows } = await pool.query(text, params);
  return rows;
}

export async function one(text, params = []) {
  const { rows } = await pool.query(text, params);
  return rows[0] ?? null;
}

/* ----------------------------------------------------------------------------
 * transaction(fn) — выполнить несколько запросов атомарно.
 * Берём ОДНО соединение из пула (транзакция живёт в рамках соединения),
 * открываем BEGIN, вызываем fn(client). Если fn бросила исключение —
 * ROLLBACK (ни одно изменение не сохранится), иначе COMMIT.
 * Соединение возвращается в пул в любом случае (finally).
 * ------------------------------------------------------------------------- */
export async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/* ----------------------------------------------------------------------------
 * waitForDatabase — ожидание готовности БД при старте.
 * В Docker контейнер приложения может запуститься раньше, чем PostgreSQL
 * начнёт принимать соединения. Поэтому пробуем подключиться несколько раз
 * с паузой, а не падаем сразу.
 * ------------------------------------------------------------------------- */
export async function waitForDatabase({ attempts = 30, delayMs = 2000 } = {}) {
  for (let i = 1; i <= attempts; i++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      console.warn(`[db] База данных недоступна (попытка ${i}/${attempts}): ${err.message}`);
      if (i === attempts) throw err;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}
