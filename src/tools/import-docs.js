/**
 * ============================================================================
 *  tools/import-docs.js — импорт документации из docs/portal в сам портал
 * ============================================================================
 *  Техническая документация хранится в репозитории как обычные Markdown-файлы
 *  (docs/portal/*.md) — её удобно править вместе с кодом и читать на GitHub.
 *  Этот скрипт публикует её на портале: создаёт пространство и дерево
 *  страниц, описанные в docs/portal/manifest.json.
 *
 *  Запуск:
 *      npm run docs:import                               — локально
 *      docker compose exec app npm run docs:import       — в Docker
 *
 *  Скрипт идемпотентен — его можно запускать сколько угодно раз:
 *   - отсутствующие страницы создаются;
 *   - изменившиеся (по заголовку или тексту) получают НОВУЮ ВЕРСИЮ в истории
 *     с комментарием «Обновлено импортом документации»;
 *   - неизменившиеся не трогаются (история не засоряется);
 *   - страницы, созданные на портале вручную, не удаляются.
 *  Страница ищется по заголовку внутри пространства, поэтому переименованная
 *  на портале страница при следующем импорте будет создана заново.
 *
 *  Ссылки между страницами документации пишутся как [текст](page:Заголовок)
 *  и при импорте превращаются в настоящие адреса /pages/<id>.
 * ============================================================================
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { config } from '../config.js';
import { one, pool, transaction, waitForDatabase } from '../db/pool.js';
import { runMigrations } from '../db/migrate.js';
import { parseLabels, setPageLabels } from '../services/pages.js';

const DOCS_DIR = path.join(config.rootDir, 'docs', 'portal');
const CHANGE_NOTE = 'Обновлено импортом документации';

/* ----------------------------------------------------------------------------
 * Разворачиваем дерево из manifest.json в плоский список с указанием
 * родителя и порядка — так его проще обрабатывать в два прохода.
 * ------------------------------------------------------------------------- */
function flatten(entries, parentTitle = null, out = []) {
  entries.forEach((entry, index) => {
    out.push({ ...entry, parentTitle, position: index + 1 });
    flatten(entry.children ?? [], entry.title, out);
  });
  return out;
}

/* ----------------------------------------------------------------------------
 * [текст](page:Заголовок) → [текст](/pages/<id>).
 * Если страницы с таким заголовком нет — оставляем только текст и
 * предупреждаем в журнале (битая ссылка лучше, чем падение импорта).
 *
 * Код не трогаем: внутри ```блоков``` и `строчного кода` ссылки page: — это
 * примеры синтаксиса. split с группой захвата кладёт куски кода на нечётные
 * позиции массива, их возвращаем как есть.
 * ------------------------------------------------------------------------- */
const CODE_RE = /(```[\s\S]*?```|`[^`\n]*`)/g;
const PAGE_LINK_RE = /\[([^\]]+)\]\(page:([^)]+)\)/g;

function resolveLinks(markdown, idByTitle, file) {
  return markdown
    .split(CODE_RE)
    .map((part, index) => (index % 2 === 1 ? part : part.replace(PAGE_LINK_RE, (match, text, title) => {
      const id = idByTitle.get(title.trim());
      if (id) return `[${text}](/pages/${id})`;
      console.warn(`[docs] ${file}: ссылка на неизвестную страницу «${title}»`);
      return text;
    })))
    .join('');
}

export async function importDocs() {
  const manifest = JSON.parse(await fs.readFile(path.join(DOCS_DIR, 'manifest.json'), 'utf8'));
  const entries = flatten(manifest.pages);

  /* Тексты всех страниц читаем заранее: ошибка «файл не найден» должна
   * случиться ДО того, как мы что-то запишем в базу. */
  for (const entry of entries) {
    const raw = await fs.readFile(path.join(DOCS_DIR, entry.file), 'utf8');
    entry.source = raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n').trim();
  }

  /* Автор страниц — первый активный администратор (или «без автора»). */
  const author = await one("SELECT id FROM users WHERE role = 'admin' AND is_active ORDER BY id LIMIT 1");
  const authorId = author?.id ?? null;
  const stats = { created: 0, updated: 0, unchanged: 0 };

  await transaction(async (db) => {
    /* ---- Пространство: создаём или обновляем описание ----
     * Владелец (управляет правами) — автор импорта; у существующего
     * пространства владелец и настройки доступа НЕ меняются. */
    const s = manifest.space;
    const { rows: [space] } = await db.query(
      `INSERT INTO spaces (key, name, description, icon, color, created_by, owner_id)
       VALUES ($1, $2, $3, $4, $5, $6, $6)
       ON CONFLICT (key) DO UPDATE
         SET name = EXCLUDED.name, description = EXCLUDED.description,
             icon = EXCLUDED.icon, color = EXCLUDED.color, updated_at = now()
       RETURNING id`,
      [s.key, s.name, s.description, s.icon, s.color, authorId],
    );

    /* ---- Проход 1: у каждой страницы должен появиться id ----
     * Новые страницы создаются пустыми (без записи в истории) — их текст
     * запишется во втором проходе, когда станут известны id всех страниц
     * для ссылок page:… */
    const idByTitle = new Map();
    for (const entry of entries) {
      const parentId = entry.parentTitle ? idByTitle.get(entry.parentTitle) : null;
      const existing = await db.query(
        'SELECT id, title, content, version FROM pages WHERE space_id = $1 AND title = $2 ORDER BY id LIMIT 1',
        [space.id, entry.title],
      );
      if (existing.rows.length) {
        entry.page = existing.rows[0];
        await db.query('UPDATE pages SET parent_id = $2, position = $3 WHERE id = $1', [entry.page.id, parentId, entry.position]);
      } else {
        const { rows: [created] } = await db.query(
          `INSERT INTO pages (space_id, parent_id, title, content, position, created_by, updated_by)
           VALUES ($1, $2, $3, '', $4, $5, $5) RETURNING id`,
          [space.id, parentId, entry.title, entry.position, authorId],
        );
        entry.page = { id: created.id, isNew: true };
      }
      idByTitle.set(entry.title, entry.page.id);
    }

    /* ---- Проход 2: текст, версии, метки ---- */
    for (const entry of entries) {
      const content = resolveLinks(entry.source, idByTitle, entry.file);
      const { page } = entry;

      if (page.isNew) {
        await db.query('UPDATE pages SET content = $2 WHERE id = $1', [page.id, content]);
        await db.query(
          `INSERT INTO page_versions (page_id, version, title, content, change_note, author_id)
           VALUES ($1, 1, $2, $3, $4, $5)`,
          [page.id, entry.title, content, 'Создано импортом документации', authorId],
        );
        stats.created++;
      } else if (page.content !== content) {
        const { rows: [updated] } = await db.query(
          `UPDATE pages SET content = $2, version = version + 1, updated_by = $3, updated_at = now()
            WHERE id = $1 RETURNING version`,
          [page.id, content, authorId],
        );
        await db.query(
          `INSERT INTO page_versions (page_id, version, title, content, change_note, author_id)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [page.id, updated.version, entry.title, content, CHANGE_NOTE, authorId],
        );
        stats.updated++;
      } else {
        stats.unchanged++;
      }
      await setPageLabels(db, page.id, parseLabels((entry.labels ?? []).join(',')));
    }
  });

  console.log(`[docs] Пространство ${manifest.space.key}: создано ${stats.created}, обновлено ${stats.updated}, без изменений ${stats.unchanged}`);
  return stats;
}

/* ----------------------------------------------------------------------------
 * Запуск как отдельного скрипта. Миграции применяются на случай, если
 * импорт запускают до первого старта сервера (advisory-блокировка в
 * migrate.js защищает от одновременного запуска с сервером).
 * ------------------------------------------------------------------------- */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  waitForDatabase()
    .then(runMigrations)
    .then(importDocs)
    .then(() => pool.end())
    .catch((err) => {
      console.error('[docs] Импорт не выполнен:', err.message);
      process.exit(1);
    });
}
