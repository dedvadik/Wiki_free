/**
 * ============================================================================
 *  routes/spaces.js — пространства (крупные разделы базы знаний)
 * ============================================================================
 *  Маршруты:
 *    GET  /spaces              — список всех пространств
 *    GET  /spaces/new          — форма создания        (editor+)
 *    POST /spaces              — создание              (editor+)
 *    GET  /spaces/:key         — главная пространства: описание, дерево, изменения
 *    GET  /spaces/:key/edit    — форма настроек        (editor+)
 *    POST /spaces/:key         — сохранение настроек   (editor+)
 *    POST /spaces/:key/delete  — удаление со всеми страницами (только admin,
 *                                с подтверждением вводом ключа)
 * ============================================================================
 */
import { Router } from 'express';
import { many, one, query } from '../db/pool.js';
import { requireRole } from '../middleware/auth.js';
import { excerpt, renderMarkdown } from '../services/markdown.js';
import { getSpaceTree } from '../services/pages.js';
import { HttpError } from '../utils/http.js';

export const spacesRouter = Router();

/* ----------------------------------------------------------------------------
 * Загрузка пространства по ключу из URL (регистр не важен: /spaces/docs
 * и /spaces/DOCS — одно и то же). Нет такого — 404.
 * ------------------------------------------------------------------------- */
export async function loadSpace(key) {
  const space = await one('SELECT * FROM spaces WHERE key = $1', [String(key).toUpperCase()]);
  if (!space) throw new HttpError(404, 'Пространство не найдено');
  return space;
}

/* ----------------------------------------------------------------------------
 * Разбор и проверка полей формы пространства.
 * Ключ проверяется только при создании — после создания он не меняется,
 * потому что используется в ссылках.
 * Иконка — эмодзи; Array.from корректно считает составные эмодзи
 * (например, флаги) как несколько кодовых точек, ограничиваем до 8.
 * ------------------------------------------------------------------------- */
function readSpaceForm(body, { isNew }) {
  const data = {
    key: String(body.key ?? '').trim().toUpperCase(),
    name: String(body.name ?? '').trim(),
    description: String(body.description ?? '').replace(/\r\n?/g, '\n'),
    icon: Array.from(String(body.icon ?? '').trim()).slice(0, 8).join('') || '📘',
    color: /^#[0-9a-f]{6}$/i.test(body.color ?? '') ? body.color.toLowerCase() : '#0052cc',
  };
  const errors = [];
  if (isNew && !/^[A-Z][A-Z0-9]{1,19}$/.test(data.key)) {
    errors.push('Ключ: от 2 до 20 латинских заглавных букв и цифр, начинается с буквы (например, DEV или HR2)');
  }
  if (!data.name) errors.push('Укажите название пространства');
  if (data.name.length > 200) errors.push('Название слишком длинное (максимум 200 символов)');
  if (data.description.length > 20000) errors.push('Описание слишком длинное');
  return { data, errors };
}

/* ============================ СПИСОК ===================================== */

spacesRouter.get('/spaces', async (req, res) => {
  const rows = await many(
    `SELECT s.*,
            (SELECT count(*)::int FROM pages p WHERE p.space_id = s.id) AS page_count,
            (SELECT max(p.updated_at) FROM pages p WHERE p.space_id = s.id) AS last_update
       FROM spaces s
      ORDER BY lower(s.name)`,
  );
  const spaces = rows.map((s) => ({ ...s, excerpt: excerpt(s.description, 160) }));
  res.render('spaces/index', { title: 'Пространства', spaces });
});

/* ============================ СОЗДАНИЕ =================================== */

spacesRouter.get('/spaces/new', requireRole('editor'), (req, res) => {
  res.render('spaces/form', {
    title: 'Новое пространство',
    isNew: true,
    space: { key: '', name: '', description: '', icon: '📘', color: '#0052cc' },
    errors: [],
  });
});

spacesRouter.post('/spaces', requireRole('editor'), async (req, res) => {
  const { data, errors } = readSpaceForm(req.body, { isNew: true });
  if (!errors.length) {
    try {
      await query(
        `INSERT INTO spaces (key, name, description, icon, color, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [data.key, data.name, data.description, data.icon, data.color, req.user.id],
      );
      req.flash('success', `Пространство «${data.name}» создано`);
      return res.redirect(`/spaces/${data.key}`);
    } catch (err) {
      /* 23505 — нарушение уникальности: такой ключ уже занят. */
      if (err.code !== '23505') throw err;
      errors.push(`Ключ ${data.key} уже занят другим пространством`);
    }
  }
  return res.status(422).render('spaces/form', { title: 'Новое пространство', isNew: true, space: data, errors });
});

/* ======================== ГЛАВНАЯ ПРОСТРАНСТВА =========================== */

spacesRouter.get('/spaces/:key', async (req, res) => {
  const space = await loadSpace(req.params.key);
  const [tree, recent] = await Promise.all([
    getSpaceTree(space.id),
    many(
      `SELECT p.id, p.title, p.updated_at, u.display_name AS updated_by_name
         FROM pages p LEFT JOIN users u ON u.id = p.updated_by
        WHERE p.space_id = $1
        ORDER BY p.updated_at DESC
        LIMIT 10`,
      [space.id],
    ),
  ]);
  res.render('spaces/show', {
    title: space.name,
    space,
    tree,
    recent,
    descriptionHtml: renderMarkdown(space.description).html,
  });
});

/* ======================== РЕДАКТИРОВАНИЕ ================================= */

spacesRouter.get('/spaces/:key/edit', requireRole('editor'), async (req, res) => {
  const space = await loadSpace(req.params.key);
  res.render('spaces/form', { title: `Настройки: ${space.name}`, isNew: false, space, errors: [] });
});

spacesRouter.post('/spaces/:key', requireRole('editor'), async (req, res) => {
  const space = await loadSpace(req.params.key);
  const { data, errors } = readSpaceForm(req.body, { isNew: false });
  if (errors.length) {
    return res.status(422).render('spaces/form', {
      title: `Настройки: ${space.name}`, isNew: false, space: { ...data, key: space.key }, errors,
    });
  }
  await query(
    `UPDATE spaces SET name = $2, description = $3, icon = $4, color = $5, updated_at = now()
      WHERE id = $1`,
    [space.id, data.name, data.description, data.icon, data.color],
  );
  req.flash('success', 'Настройки пространства сохранены');
  return res.redirect(`/spaces/${space.key}`);
});

/* ============================ УДАЛЕНИЕ ===================================
 * Удаление необратимо: каскадно удаляются все страницы, их версии,
 * комментарии и метки (ON DELETE CASCADE в схеме БД). Поэтому требуем
 * ввести ключ пространства для подтверждения — как на GitHub.
 * ========================================================================= */
spacesRouter.post('/spaces/:key/delete', requireRole('admin'), async (req, res) => {
  const space = await loadSpace(req.params.key);
  if (String(req.body.confirm_key ?? '').trim().toUpperCase() !== space.key) {
    req.flash('error', 'Ключ подтверждения не совпадает — пространство НЕ удалено');
    return res.redirect(`/spaces/${space.key}/edit`);
  }
  await query('DELETE FROM spaces WHERE id = $1', [space.id]);
  req.flash('success', `Пространство «${space.name}» удалено`);
  return res.redirect('/spaces');
});
