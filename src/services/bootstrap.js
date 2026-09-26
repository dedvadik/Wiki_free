/**
 * ============================================================================
 *  services/bootstrap.js — первичная инициализация данных при старте
 * ============================================================================
 *  Выполняется один раз при каждом запуске сервера, но реально что-то
 *  делает только на ПУСТОЙ базе:
 *   1. ensureInitialAdmin — создаёт администратора из переменных окружения
 *      ADMIN_USERNAME / ADMIN_EMAIL / ADMIN_PASSWORD, если пользователей нет.
 *   2. seedDemoContent — создаёт демо-пространство «Документация» со
 *      страницами-руководствами (тексты лежат в src/seed/*.md), если нет
 *      ни одного пространства. Отключается SEED_DEMO=false.
 * ============================================================================
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { one, transaction } from '../db/pool.js';
import { createUser, validatePassword } from './users.js';

const SEED_DIR = path.join(import.meta.dirname, '..', 'seed');

/* ----------------------------------------------------------------------------
 * Администратор из переменных окружения.
 * ------------------------------------------------------------------------- */
export async function ensureInitialAdmin() {
  const { admin } = config;
  if (!admin.password) return;

  const { count } = await one('SELECT count(*)::int AS count FROM users');
  if (count > 0) return;

  const problems = validatePassword(admin.password);
  if (problems.length) {
    console.warn(`[bootstrap] ADMIN_PASSWORD не подходит: ${problems.join('; ')}. Администратор не создан.`);
    return;
  }

  await createUser({
    username: admin.username,
    email: admin.email,
    displayName: admin.displayName,
    password: admin.password,
    role: 'admin',
  });
  console.log(`[bootstrap] Создан администратор "${admin.username}"`);
}

/* ----------------------------------------------------------------------------
 * Демо-контент. Структура дерева:
 *   📘 Документация (DOCS)
 *     └─ Добро пожаловать
 *          ├─ Руководство по разметке
 *          └─ Кастомизация сайта
 * Всё создаётся в одной транзакции: или целиком, или никак.
 * ------------------------------------------------------------------------- */
export async function seedDemoContent() {
  if (!config.seedDemo) return;

  const { count } = await one('SELECT count(*)::int AS count FROM spaces');
  if (count > 0) return;

  /* Автор демо-страниц — первый администратор (если он уже есть). */
  const author = await one("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1");
  const authorId = author?.id ?? null;

  const read = (name) => fs.readFile(path.join(SEED_DIR, name), 'utf8');
  const [welcome, markdownGuide, customization] = await Promise.all([
    read('welcome.md'), read('markdown-guide.md'), read('customization.md'),
  ]);

  await transaction(async (db) => {
    const { rows: [space] } = await db.query(
      `INSERT INTO spaces (key, name, description, icon, color, created_by)
       VALUES ('DOCS', 'Документация', $1, '📘', '#0052cc', $2) RETURNING id`,
      ['Пространство с руководствами по работе с базой знаний. Его можно отредактировать или удалить.', authorId],
    );

    /* Вспомогательная функция: страница + её первая версия в истории. */
    const createPage = async (title, content, parentId, position) => {
      const { rows: [page] } = await db.query(
        `INSERT INTO pages (space_id, parent_id, title, content, position, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $6) RETURNING id`,
        [space.id, parentId, title, content, position, authorId],
      );
      await db.query(
        `INSERT INTO page_versions (page_id, version, title, content, change_note, author_id)
         VALUES ($1, 1, $2, $3, 'Создано автоматически', $4)`,
        [page.id, title, content, authorId],
      );
      return page.id;
    };

    const rootId = await createPage('Добро пожаловать', welcome, null, 0);
    await createPage('Руководство по разметке', markdownGuide, rootId, 1);
    await createPage('Кастомизация сайта', customization, rootId, 2);
  });

  console.log('[bootstrap] Создано демо-пространство DOCS');
}
