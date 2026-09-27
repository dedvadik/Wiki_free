/**
 * ============================================================================
 *  routes/pages.js — страницы (статьи): просмотр, редактор, история версий
 * ============================================================================
 *  Права: «чтение» / «правка» — это права на ПРОСТРАНСТВО страницы
 *  (services/permissions.js). Правка требует ещё и глобальной роли editor+.
 *
 *  Маршруты:
 *    GET  /spaces/:key/pages/new?parent=ID  — редактор новой страницы   (правка)
 *    POST /spaces/:key/pages                — создание страницы         (правка)
 *    GET  /pages/:id/edit                   — редактор существующей     (правка)
 *    POST /pages/:id                        — сохранение новой версии   (правка)
 *    POST /pages/:id/delete                 — удаление                  (правка)
 *    GET  /pages/:id/history                — список версий             (чтение)
 *    GET  /pages/:id/versions/:v            — просмотр старой версии    (чтение)
 *    GET  /pages/:id/diff?from=&to=         — сравнение двух версий     (чтение)
 *    POST /pages/:id/versions/:v/restore    — откат к версии            (правка)
 *    GET  /pages/:id/export.md              — скачать как Markdown      (чтение)
 *    POST /pages/:id/favorite               — избранное                 (чтение + вход)
 *    POST /pages/:id/comments               — добавить комментарий      (чтение + вход)
 *    POST /comments/:id/delete              — удалить комментарий (автор, владелец пространства, админ)
 *    GET  /pages/:id{/:slug}                — ПРОСМОТР страницы         (чтение)
 *
 *  ВАЖНО про порядок: маршрут просмотра /pages/:id{/:slug} объявлен
 *  ПОСЛЕДНИМ. Иначе адрес /pages/5/history совпал бы с ним (slug="history")
 *  и открылась бы страница вместо истории. Express проверяет маршруты
 *  строго в порядке объявления.
 * ============================================================================
 */
import { Router } from 'express';
import { many, one, query, transaction } from '../db/pool.js';
import { requireLogin, requireRole } from '../middleware/auth.js';
import { buildLineDiff } from '../services/diff.js';
import { renderMarkdown, renderPageCached, slugify } from '../services/markdown.js';
import {
  flattenTree, getAncestors, getChildNodes, getSpaceTree, getSpaceTreeAround, isDescendant, linkAttachments, pageUrl, readPageForm, setPageLabels,
} from '../services/pages.js';
import { getSpaceAccess, requireSpaceAccess } from '../services/permissions.js';
import { getSettings } from '../services/settings.js';
import { hasRole } from '../services/users.js';
import { backUrl, HttpError, parseId } from '../utils/http.js';
import { loadSpace, loadSpaceWithAccess } from './spaces.js';

export const pagesRouter = Router();

/* ----------------------------------------------------------------------------
 * loadPage — страница вместе с данными пространства и именами авторов.
 * LEFT JOIN с users — автор мог быть удалён, страница при этом остаётся.
 * ------------------------------------------------------------------------- */
async function loadPage(id) {
  const page = await one(
    `SELECT p.*,
            s.key AS space_key, s.name AS space_name, s.icon AS space_icon, s.color AS space_color,
            s.owner_id AS space_owner_id, s.visibility AS space_visibility, s.edit_policy AS space_edit_policy,
            cu.display_name AS created_by_name,
            uu.display_name AS updated_by_name
       FROM pages p
       JOIN spaces s ON s.id = p.space_id
       LEFT JOIN users cu ON cu.id = p.created_by
       LEFT JOIN users uu ON uu.id = p.updated_by
      WHERE p.id = $1`,
    [id],
  );
  if (!page) throw new HttpError(404, 'Страница не найдена');
  return page;
}

/* ----------------------------------------------------------------------------
 * loadPageFor — страница + права текущего пользователя на её пространство
 * с немедленной проверкой нужного уровня ('read' | 'edit'):
 *     const { page, access } = await loadPageFor(req, req.params.id, 'edit');
 * Нет прав → 401 (гость) или 403, см. services/permissions.js.
 * ------------------------------------------------------------------------- */
async function loadPageFor(req, rawId, level) {
  const page = await loadPage(parseId(rawId));
  const access = await getSpaceAccess(req.user, {
    id: page.space_id,
    owner_id: page.space_owner_id,
    visibility: page.space_visibility,
    edit_policy: page.space_edit_policy,
  });
  requireSpaceAccess(req, access, level);
  return { page, access };
}

/** Метки страницы строкой "api, backend" — для поля ввода в редакторе. */
async function labelsString(pageId) {
  const rows = await many(
    `SELECT l.name FROM page_labels pl JOIN labels l ON l.id = pl.label_id
      WHERE pl.page_id = $1 ORDER BY l.name`,
    [pageId],
  );
  return rows.map((r) => r.name).join(', ');
}

/* ----------------------------------------------------------------------------
 * validateParent — проверка выбранной родительской страницы:
 *   - она существует и лежит в ТОМ ЖЕ пространстве;
 *   - это не сама страница и не её потомок (иначе получится цикл).
 * Возвращает текст ошибки или null.
 * ------------------------------------------------------------------------- */
async function validateParent(parentId, spaceId, pageId = null) {
  if (!parentId) return null;
  const parent = await one('SELECT id, space_id FROM pages WHERE id = $1', [parentId]);
  if (!parent || parent.space_id !== spaceId) return 'Родительская страница не найдена в этом пространстве';
  if (pageId && (parentId === pageId || (await isDescendant(pageId, parentId)))) {
    return 'Нельзя сделать страницу дочерней для самой себя или своей дочерней страницы';
  }
  return null;
}

/* ----------------------------------------------------------------------------
 * renderEditor — общий код отрисовки редактора (для новой и существующей
 * страницы, а также при ошибках валидации и конфликте версий).
 * ------------------------------------------------------------------------- */
async function renderEditor(res, { space, page = null, form, errors = [], baseVersion = null, status = 200, conflict = null }) {
  const tree = await getSpaceTree(space.id);
  res.status(status).render('pages/form', {
    title: page ? `Редактирование: ${page.title}` : 'Новая страница',
    space,
    page,
    form,
    errors,
    conflict,
    baseVersion,
    isNew: !page,
    /* Для существующей страницы исключаем её саму и её поддерево из
     * списка возможных родителей. */
    parentOptions: flattenTree(tree, page?.id ?? null),
  });
}

/* ======================== СОЗДАНИЕ СТРАНИЦЫ ============================== */

pagesRouter.get('/spaces/:key/pages/new', requireRole('editor'), async (req, res) => {
  const { space, access } = await loadSpaceWithAccess(req, req.params.key);
  requireSpaceAccess(req, access, 'edit');
  const parentId = Number.parseInt(req.query.parent, 10);
  await renderEditor(res, {
    space,
    form: {
      title: '',
      content: '',
      parent_id: Number.isInteger(parentId) ? parentId : null,
      position: 0,
      labels: '',
      change_note: '',
    },
  });
});

pagesRouter.post('/spaces/:key/pages', requireRole('editor'), async (req, res) => {
  const { space, access } = await loadSpaceWithAccess(req, req.params.key);
  requireSpaceAccess(req, access, 'edit');
  const { form, errors } = readPageForm(req.body);
  const parentError = await validateParent(form.parent_id, space.id);
  if (parentError) errors.push(parentError);
  if (errors.length) return renderEditor(res, { space, form, errors, status: 422 });

  /* Страница, её первая версия, метки и вложения — одной транзакцией. */
  const pageId = await transaction(async (db) => {
    const { rows: [page] } = await db.query(
      `INSERT INTO pages (space_id, parent_id, title, content, position, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $6)
       RETURNING id`,
      [space.id, form.parent_id, form.title, form.content, form.position, req.user.id],
    );
    await db.query(
      `INSERT INTO page_versions (page_id, version, title, content, change_note, author_id)
       VALUES ($1, 1, $2, $3, $4, $5)`,
      [page.id, form.title, form.content, form.change_note || 'Создание страницы', req.user.id],
    );
    await setPageLabels(db, page.id, form.labels ? form.labels.split(', ') : []);
    await linkAttachments(db, page.id, req.body.attachment_ids, req.user.id);
    return page.id;
  });

  req.flash('success', 'Страница создана');
  return res.redirect(pageUrl({ id: pageId, title: form.title }));
});

/* ====================== РЕДАКТИРОВАНИЕ СТРАНИЦЫ ========================== */

pagesRouter.get('/pages/:id/edit', requireRole('editor'), async (req, res) => {
  const { page } = await loadPageFor(req, req.params.id, 'edit');
  const space = await loadSpace(page.space_key);
  await renderEditor(res, {
    space,
    page,
    baseVersion: page.version,
    form: {
      title: page.title,
      content: page.content,
      parent_id: page.parent_id,
      position: page.position,
      labels: await labelsString(page.id),
      change_note: '',
    },
  });
});

/* ----------------------------------------------------------------------------
 * Сохранение с ОПТИМИСТИЧНОЙ БЛОКИРОВКОЙ.
 * Форма редактора содержит base_version — номер версии, которую человек
 * открыл. UPDATE выполняется с условием «WHERE version = base_version».
 * Если за это время кто-то уже сохранил страницу, условие не выполнится
 * (0 строк) — значит, конфликт. Мы НЕ теряем текст пользователя, а
 * показываем редактор снова с предупреждением и ссылкой на изменения.
 * Повторное сохранение (base_version уже обновлён) перезапишет страницу
 * осознанно.
 * ------------------------------------------------------------------------- */
pagesRouter.post('/pages/:id', requireRole('editor'), async (req, res) => {
  const { page } = await loadPageFor(req, req.params.id, 'edit');
  const space = await loadSpace(page.space_key);
  const { form, errors } = readPageForm(req.body);
  const baseVersion = Number.parseInt(req.body.base_version, 10);

  const parentError = await validateParent(form.parent_id, space.id, page.id);
  if (parentError) errors.push(parentError);
  if (errors.length) return renderEditor(res, { space, page, form, errors, baseVersion, status: 422 });

  /* Новую версию создаём, только если изменились заголовок или текст.
   * Перемещение в дереве и смена меток версию не увеличивают. */
  const contentChanged = form.title !== page.title || form.content !== page.content;

  const saved = await transaction(async (db) => {
    if (contentChanged) {
      const { rows } = await db.query(
        `UPDATE pages
            SET title = $2, content = $3, parent_id = $4, position = $5,
                version = version + 1, updated_by = $6, updated_at = now()
          WHERE id = $1 AND version = $7
          RETURNING version`,
        [page.id, form.title, form.content, form.parent_id, form.position, req.user.id, baseVersion],
      );
      if (!rows.length) return false; /* конфликт версий */
      await db.query(
        `INSERT INTO page_versions (page_id, version, title, content, change_note, author_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [page.id, rows[0].version, form.title, form.content, form.change_note, req.user.id],
      );
    } else {
      await db.query('UPDATE pages SET parent_id = $2, position = $3 WHERE id = $1', [page.id, form.parent_id, form.position]);
    }
    await setPageLabels(db, page.id, form.labels ? form.labels.split(', ') : []);
    await linkAttachments(db, page.id, req.body.attachment_ids, req.user.id);
    return true;
  });

  if (!saved) {
    const fresh = await loadPage(page.id);
    return renderEditor(res, {
      space,
      page: fresh,
      form,
      baseVersion: fresh.version,
      status: 409,
      conflict: {
        by: fresh.updated_by_name ?? 'другой пользователь',
        version: fresh.version,
        diffUrl: `/pages/${page.id}/diff?from=${baseVersion}&to=${fresh.version}`,
      },
    });
  }

  req.flash('success', contentChanged ? 'Изменения сохранены' : 'Изменений в тексте нет — обновлены только свойства страницы');
  return res.redirect(pageUrl({ id: page.id, title: form.title }));
});

/* ============================ УДАЛЕНИЕ ===================================
 * Два режима:
 *  - по умолчанию дочерние страницы «поднимаются» на уровень удаляемой
 *    (переходят к её родителю) — ничего лишнего не теряется;
 *  - with_children=1 — удаляется всё поддерево (рекурсивный CTE).
 * ========================================================================= */
pagesRouter.post('/pages/:id/delete', requireRole('editor'), async (req, res) => {
  const { page } = await loadPageFor(req, req.params.id, 'edit');
  const withChildren = req.body.with_children === '1';

  await transaction(async (db) => {
    if (withChildren) {
      await db.query(
        `WITH RECURSIVE sub AS (
            SELECT id FROM pages WHERE id = $1
            UNION
            SELECT p.id FROM pages p JOIN sub s ON p.parent_id = s.id
         )
         DELETE FROM pages WHERE id IN (SELECT id FROM sub)`,
        [page.id],
      );
    } else {
      await db.query('UPDATE pages SET parent_id = $2 WHERE parent_id = $1', [page.id, page.parent_id]);
      await db.query('DELETE FROM pages WHERE id = $1', [page.id]);
    }
  });

  req.flash('success', `Страница «${page.title}» удалена`);
  return res.redirect(`/spaces/${page.space_key}`);
});

/* ========================= ИСТОРИЯ ВЕРСИЙ ================================ */

pagesRouter.get('/pages/:id/history', async (req, res) => {
  const { page, access } = await loadPageFor(req, req.params.id, 'read');
  const versions = await many(
    `SELECT v.version, v.title, v.change_note, v.created_at, length(v.content) AS size,
            u.display_name AS author_name
       FROM page_versions v
       LEFT JOIN users u ON u.id = v.author_id
      WHERE v.page_id = $1
      ORDER BY v.version DESC`,
    [page.id],
  );
  res.render('pages/history', { title: `История: ${page.title}`, page, versions, access });
});

/** Загрузка конкретной версии страницы (404, если такой нет). */
async function loadVersion(pageId, version) {
  const row = await one(
    `SELECT v.*, u.display_name AS author_name
       FROM page_versions v LEFT JOIN users u ON u.id = v.author_id
      WHERE v.page_id = $1 AND v.version = $2`,
    [pageId, version],
  );
  if (!row) throw new HttpError(404, `Версия ${version} не найдена`);
  return row;
}

pagesRouter.get('/pages/:id/versions/:version', async (req, res) => {
  const { page, access } = await loadPageFor(req, req.params.id, 'read');
  const version = await loadVersion(page.id, parseId(req.params.version));
  const { html } = renderMarkdown(version.content);
  res.render('pages/version', { title: `${version.title} (версия ${version.version})`, page, version, contentHtml: html, access });
});

/* ------------------------- Сравнение версий ------------------------------
 * По умолчанию сравниваются предыдущая и текущая версии. Если from > to,
 * меняем их местами, чтобы «старое» всегда было слева.
 * ------------------------------------------------------------------------- */
pagesRouter.get('/pages/:id/diff', async (req, res) => {
  const { page } = await loadPageFor(req, req.params.id, 'read');
  let to = Number.parseInt(req.query.to, 10) || page.version;
  let from = Number.parseInt(req.query.from, 10) || Math.max(1, to - 1);
  if (from > to) [from, to] = [to, from];

  const [a, b] = await Promise.all([loadVersion(page.id, from), loadVersion(page.id, to)]);
  const diff = buildLineDiff(a.content, b.content);
  res.render('pages/diff', { title: `Сравнение версий: ${page.title}`, page, a, b, diff });
});

/* ------------------------- Откат к версии --------------------------------
 * Откат НЕ удаляет историю: создаётся НОВАЯ версия с содержимым старой.
 * Так всегда можно «откатить откат».
 * ------------------------------------------------------------------------- */
pagesRouter.post('/pages/:id/versions/:version/restore', requireRole('editor'), async (req, res) => {
  const { page } = await loadPageFor(req, req.params.id, 'edit');
  const old = await loadVersion(page.id, parseId(req.params.version));

  await transaction(async (db) => {
    const { rows: [updated] } = await db.query(
      `UPDATE pages SET title = $2, content = $3, version = version + 1, updated_by = $4, updated_at = now()
        WHERE id = $1 RETURNING version`,
      [page.id, old.title, old.content, req.user.id],
    );
    await db.query(
      `INSERT INTO page_versions (page_id, version, title, content, change_note, author_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [page.id, updated.version, old.title, old.content, `Восстановлено из версии ${old.version}`, req.user.id],
    );
  });

  req.flash('success', `Страница восстановлена из версии ${old.version}`);
  return res.redirect(pageUrl({ id: page.id, title: old.title }));
});

/* ============================== ЭКСПОРТ ================================== */

pagesRouter.get('/pages/:id/export.md', async (req, res) => {
  const { page } = await loadPageFor(req, req.params.id, 'read');
  /* res.attachment корректно кодирует кириллицу в имени файла (filename*). */
  res.attachment(`${slugify(page.title) || `page-${page.id}`}.md`);
  res.type('text/markdown; charset=utf-8');
  res.send(`# ${page.title}\n\n${page.content}\n`);
});

/* ============================= ИЗБРАННОЕ =================================
 * Переключатель: если запись была — удаляем, если не было — добавляем.
 * ========================================================================= */
pagesRouter.post('/pages/:id/favorite', requireLogin, async (req, res) => {
  const { page } = await loadPageFor(req, req.params.id, 'read');
  const removed = await query('DELETE FROM favorites WHERE user_id = $1 AND page_id = $2', [req.user.id, page.id]);
  if (removed.rowCount === 0) {
    await query('INSERT INTO favorites (user_id, page_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.user.id, page.id]);
  }
  return res.redirect(backUrl(req, pageUrl(page)));
});

/* ============================ КОММЕНТАРИИ ================================ */

pagesRouter.post('/pages/:id/comments', requireLogin, async (req, res) => {
  if (!getSettings().allow_comments) throw new HttpError(403, 'Комментарии отключены администратором');
  /* Комментировать может любой, кто видит страницу (включая читателей). */
  const { page } = await loadPageFor(req, req.params.id, 'read');
  const content = String(req.body.content ?? '').replace(/\r\n?/g, '\n').trim();

  if (!content) req.flash('error', 'Комментарий не может быть пустым');
  else if (content.length > 10000) req.flash('error', 'Комментарий слишком длинный (максимум 10 000 символов)');
  else {
    const { rows: [comment] } = await query(
      'INSERT INTO comments (page_id, author_id, content) VALUES ($1, $2, $3) RETURNING id',
      [page.id, req.user.id, content],
    );
    return res.redirect(`${pageUrl(page)}#comment-${comment.id}`);
  }
  return res.redirect(`${pageUrl(page)}#comments`);
});

/* Удалить комментарий может его автор, владелец пространства (модерация
 * своего раздела) или администратор. */
pagesRouter.post('/comments/:id/delete', requireLogin, async (req, res) => {
  const comment = await one(
    'SELECT c.id, c.author_id, p.id AS page_id, p.title FROM comments c JOIN pages p ON p.id = c.page_id WHERE c.id = $1',
    [parseId(req.params.id)],
  );
  if (!comment) throw new HttpError(404, 'Комментарий не найден');
  const { access } = await loadPageFor(req, comment.page_id, 'read');
  if (comment.author_id !== req.user.id && !access.canManage) {
    throw new HttpError(403, 'Удалить комментарий может автор, владелец пространства или администратор');
  }
  await query('DELETE FROM comments WHERE id = $1', [comment.id]);
  req.flash('success', 'Комментарий удалён');
  return res.redirect(`${pageUrl({ id: comment.page_id, title: comment.title })}#comments`);
});

/* =================== ПОДГРУЗКА ВЕТКИ ДЕРЕВА НАВИГАЦИИ ======================
 * Боковая панель показывает только путь к открытой странице (см.
 * getSpaceTreeAround). Когда пользователь раскрывает свёрнутую ветку,
 * public/js/app.js запрашивает её здесь и получает готовый HTML — тот же
 * шаблон partials/page-tree, поэтому вид веток одинаковый. Права — как
 * на чтение самой страницы.
 * ========================================================================= */
pagesRouter.get('/api/pages/:id/children', async (req, res) => {
  const { page } = await loadPageFor(req, req.params.id, 'read');
  const nodes = await getChildNodes(page.id);
  return res.render('partials/page-tree', { nodes });
});

/* ======================== ПРОСМОТР СТРАНИЦЫ ==============================
 * {/:slug} — необязательная часть пути (синтаксис Express 5).
 * Если slug в адресе устарел (страницу переименовали), перенаправляем на
 * актуальный адрес — старые ссылки продолжают работать.
 * ========================================================================= */
pagesRouter.get('/pages/:id{/:slug}', async (req, res) => {
  const { page, access } = await loadPageFor(req, req.params.id, 'read');

  const canonical = pageUrl(page);
  if (req.params.slug !== undefined && encodeURIComponent(req.params.slug) !== canonical.split('/')[3]) {
    return res.redirect(301, canonical);
  }

  /* Все данные для страницы загружаются параллельно. */
  const [space, tree, ancestors, children, labels, comments, attachments, favorite] = await Promise.all([
    loadSpace(page.space_key),
    getSpaceTreeAround(page.space_id, page.id),
    getAncestors(page.id),
    many('SELECT id, title FROM pages WHERE parent_id = $1 ORDER BY position, lower(title)', [page.id]),
    many(
      `SELECT l.name FROM page_labels pl JOIN labels l ON l.id = pl.label_id
        WHERE pl.page_id = $1 ORDER BY l.name`,
      [page.id],
    ),
    many(
      `SELECT c.id, c.content, c.created_at, c.author_id, u.display_name AS author_name
         FROM comments c LEFT JOIN users u ON u.id = c.author_id
        WHERE c.page_id = $1 ORDER BY c.created_at`,
      [page.id],
    ),
    many(
      `SELECT a.id, a.stored_name, a.original_name, a.mime_type, a.size_bytes, a.created_at,
              u.display_name AS uploaded_by_name
         FROM attachments a LEFT JOIN users u ON u.id = a.uploaded_by
        WHERE a.page_id = $1 ORDER BY a.created_at`,
      [page.id],
    ),
    req.user
      ? one('SELECT 1 AS yes FROM favorites WHERE user_id = $1 AND page_id = $2', [req.user.id, page.id])
      : null,
  ]);

  const { html, toc } = renderPageCached(page);

  return res.render('pages/show', {
    title: page.title,
    page,
    space,
    /* Права на пространство: шаблон показывает кнопки правки только тем,
     * кто действительно может править (сами маршруты проверяют это ещё раз). */
    access,
    tree,
    ancestors,
    children,
    labels,
    attachments,
    isFavorite: Boolean(favorite),
    contentHtml: html,
    toc,
    comments: comments.map((c) => ({ ...c, html: renderMarkdown(c.content).html })),
  });
});
