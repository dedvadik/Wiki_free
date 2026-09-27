/**
 * ============================================================================
 *  routes/spaces.js — пространства и права доступа к ним
 * ============================================================================
 *  Маршруты:
 *    GET  /spaces                         — список пространств, которые видит пользователь
 *    GET  /spaces/new                     — форма создания              (editor+)
 *    POST /spaces                         — создание; создатель = владелец (editor+)
 *    GET  /spaces/:key                    — главная пространства        (чтение)
 *    GET  /spaces/:key/edit               — настройки: название, описание (владелец, admin)
 *    POST /spaces/:key                    — сохранение настроек         (владелец, admin)
 *    POST /spaces/:key/delete             — удаление со всеми страницами (только admin)
 *    GET  /spaces/:key/permissions        — права доступа               (владелец, admin)
 *    POST /spaces/:key/permissions        — кто читает, кто правит, владелец
 *    POST /spaces/:key/members            — добавить участника или сменить его доступ
 *    POST /spaces/:key/members/:id/delete — убрать участника
 *
 *  Правила доступа — src/services/permissions.js.
 * ============================================================================
 */
import { Router } from 'express';
import { many, one, query } from '../db/pool.js';
import { requireLogin, requireRole } from '../middleware/auth.js';
import { excerpt, renderMarkdown } from '../services/markdown.js';
import { getSpaceTreeAround } from '../services/pages.js';
import {
  ACCESS_LEVELS, accessParams, EDIT_POLICY, getSpaceAccess, readableSpacesSql, requireSpaceAccess, VISIBILITY,
} from '../services/permissions.js';
import { hasRole } from '../services/users.js';
import { HttpError, parseId } from '../utils/http.js';

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

/* Пространство + права текущего пользователя на него. */
export async function loadSpaceWithAccess(req, key) {
  const space = await loadSpace(key);
  return { space, access: await getSpaceAccess(req.user, space) };
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
    /* Доступ выбирается при создании; потом — на странице «Права доступа». */
    visibility: body.visibility === 'restricted' ? 'restricted' : 'public',
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

/* ============================ СПИСОК =====================================
 * Только пространства, которые пользователь может читать: закрытые чужие
 * не показываются вовсе (даже их названия).
 * ========================================================================= */
spacesRouter.get('/spaces', async (req, res) => {
  const rows = await many(
    `SELECT s.*, o.display_name AS owner_name,
            (SELECT count(*)::int FROM pages p WHERE p.space_id = s.id) AS page_count,
            (SELECT max(p.updated_at) FROM pages p WHERE p.space_id = s.id) AS last_update
       FROM spaces s
       LEFT JOIN users o ON o.id = s.owner_id
      WHERE ${readableSpacesSql('s', '$1', '$2')}
      ORDER BY lower(s.name)`,
    accessParams(req.user),
  );
  const spaces = rows.map((s) => ({ ...s, excerpt: excerpt(s.description, 160) }));
  res.render('spaces/index', { title: 'Пространства', spaces });
});

/* ============================ СОЗДАНИЕ =================================== */

spacesRouter.get('/spaces/new', requireRole('editor'), (req, res) => {
  res.render('spaces/form', {
    title: 'Новое пространство',
    isNew: true,
    space: { key: '', name: '', description: '', icon: '📘', color: '#0052cc', visibility: 'public' },
    errors: [],
    visibilityOptions: VISIBILITY,
  });
});

spacesRouter.post('/spaces', requireRole('editor'), async (req, res) => {
  const { data, errors } = readSpaceForm(req.body, { isNew: true });
  if (!errors.length) {
    try {
      /* Создатель становится владельцем: он управляет правами пространства. */
      await query(
        `INSERT INTO spaces (key, name, description, icon, color, visibility, created_by, owner_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
        [data.key, data.name, data.description, data.icon, data.color, data.visibility, req.user.id],
      );
      req.flash('success', data.visibility === 'restricted'
        ? `Закрытое пространство «${data.name}» создано. Добавьте участников в «Права доступа».`
        : `Пространство «${data.name}» создано`);
      return res.redirect(`/spaces/${data.key}`);
    } catch (err) {
      /* 23505 — нарушение уникальности: такой ключ уже занят. */
      if (err.code !== '23505') throw err;
      errors.push(`Ключ ${data.key} уже занят другим пространством`);
    }
  }
  return res.status(422).render('spaces/form', {
    title: 'Новое пространство', isNew: true, space: data, errors, visibilityOptions: VISIBILITY,
  });
});

/* ======================== ГЛАВНАЯ ПРОСТРАНСТВА =========================== */

spacesRouter.get('/spaces/:key', async (req, res) => {
  const { space, access } = await loadSpaceWithAccess(req, req.params.key);
  requireSpaceAccess(req, access, 'read');

  const [tree, recent, owner] = await Promise.all([
    getSpaceTreeAround(space.id),
    many(
      `SELECT p.id, p.title, p.updated_at, u.display_name AS updated_by_name
         FROM pages p LEFT JOIN users u ON u.id = p.updated_by
        WHERE p.space_id = $1
        ORDER BY p.updated_at DESC
        LIMIT 10`,
      [space.id],
    ),
    space.owner_id ? one('SELECT display_name FROM users WHERE id = $1', [space.owner_id]) : null,
  ]);
  res.render('spaces/show', {
    title: space.name,
    space,
    access,
    tree,
    recent,
    ownerName: owner?.display_name ?? null,
    descriptionHtml: renderMarkdown(space.description).html,
  });
});

/* ======================== НАСТРОЙКИ ПРОСТРАНСТВА ==========================
 * Название, иконку, цвет и описание меняет владелец или администратор.
 * ========================================================================= */
spacesRouter.get('/spaces/:key/edit', requireLogin, async (req, res) => {
  const { space, access } = await loadSpaceWithAccess(req, req.params.key);
  requireSpaceAccess(req, access, 'manage');
  res.render('spaces/form', { title: `Настройки: ${space.name}`, isNew: false, space, errors: [] });
});

spacesRouter.post('/spaces/:key', requireLogin, async (req, res) => {
  const { space, access } = await loadSpaceWithAccess(req, req.params.key);
  requireSpaceAccess(req, access, 'manage');
  const { data, errors } = readSpaceForm(req.body, { isNew: false });
  if (errors.length) {
    return res.status(422).render('spaces/form', {
      title: `Настройки: ${space.name}`, isNew: false, space: { ...space, ...data, key: space.key }, errors,
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

/* ============================ ПРАВА ДОСТУПА ===============================
 * Страница владельца пространства (и администраторов): кто читает, кто
 * правит, список участников, передача владения.
 * ========================================================================= */
async function renderPermissions(req, res, space, { errors = [], status = 200 } = {}) {
  const [owner, members, users] = await Promise.all([
    space.owner_id ? one('SELECT id, username, display_name, role FROM users WHERE id = $1', [space.owner_id]) : null,
    many(
      `SELECT u.id, u.username, u.display_name, u.role, u.is_active, m.access, m.created_at,
              a.display_name AS added_by_name
         FROM space_members m
         JOIN users u ON u.id = m.user_id
         LEFT JOIN users a ON a.id = m.added_by
        WHERE m.space_id = $1
        ORDER BY lower(u.display_name)`,
      [space.id],
    ),
    /* Кандидаты в участники и владельцы — активные пользователи. */
    many('SELECT id, username, display_name, role FROM users WHERE is_active ORDER BY lower(display_name) LIMIT 1000'),
  ]);
  const memberIds = new Set(members.map((m) => m.id));
  res.status(status).render('spaces/permissions', {
    title: `Права доступа: ${space.name}`,
    space,
    owner,
    members,
    users,
    /* Кого можно добавить: не владелец и ещё не участник. */
    candidates: users.filter((u) => u.id !== space.owner_id && !memberIds.has(u.id)),
    errors,
    visibilityOptions: VISIBILITY,
    editPolicyOptions: EDIT_POLICY,
    accessLevels: ACCESS_LEVELS,
    canChangeOwner: hasRole(req.user, 'admin') || space.owner_id === req.user.id,
  });
}

spacesRouter.get('/spaces/:key/permissions', requireLogin, async (req, res) => {
  const { space, access } = await loadSpaceWithAccess(req, req.params.key);
  requireSpaceAccess(req, access, 'manage');
  await renderPermissions(req, res, space);
});

/* ---- Кто читает, кто правит, владелец ---- */
spacesRouter.post('/spaces/:key/permissions', requireLogin, async (req, res) => {
  const { space, access } = await loadSpaceWithAccess(req, req.params.key);
  requireSpaceAccess(req, access, 'manage');

  const visibility = VISIBILITY[req.body.visibility] ? req.body.visibility : space.visibility;
  const editPolicy = EDIT_POLICY[req.body.edit_policy] ? req.body.edit_policy : space.edit_policy;
  let ownerId = space.owner_id;
  const errors = [];

  /* Смена владельца: новый владелец — активный пользователь. */
  const requestedOwner = Number.parseInt(req.body.owner_id, 10);
  if (Number.isInteger(requestedOwner) && requestedOwner !== space.owner_id) {
    const candidate = await one('SELECT id FROM users WHERE id = $1 AND is_active', [requestedOwner]);
    if (!candidate) errors.push('Новый владелец не найден или заблокирован');
    else ownerId = candidate.id;
  }
  if (errors.length) return renderPermissions(req, res, space, { errors, status: 422 });

  await query(
    'UPDATE spaces SET visibility = $2, edit_policy = $3, owner_id = $4, updated_at = now() WHERE id = $1',
    [space.id, visibility, editPolicy, ownerId],
  );
  if (ownerId !== space.owner_id) {
    /* Новый владелец не должен дублироваться в списке участников… */
    await query('DELETE FROM space_members WHERE space_id = $1 AND user_id = $2', [space.id, ownerId]);
    /* …а бывший владелец остаётся участником с правом редактирования:
     * иначе, передав закрытое пространство, он потерял бы к нему доступ. */
    if (space.owner_id) {
      await query(
        `INSERT INTO space_members (space_id, user_id, access, added_by) VALUES ($1, $2, 'edit', $3)
         ON CONFLICT (space_id, user_id) DO NOTHING`,
        [space.id, space.owner_id, req.user.id],
      );
    }
  }

  /* Бывший владелец (не администратор) после передачи теряет управление —
   * отправляем его на страницу пространства, а не на недоступную ему форму. */
  const lostControl = ownerId !== space.owner_id && space.owner_id === req.user.id && !hasRole(req.user, 'admin');
  req.flash('success', lostControl
    ? 'Владение пространством передано. Вы остались участником с правом редактирования.'
    : 'Права доступа сохранены');
  return res.redirect(lostControl ? `/spaces/${space.key}` : `/spaces/${space.key}/permissions`);
});

/* ---- Добавить участника или сменить его уровень доступа ----
 * Пользователь задаётся логином или email. Право «Редактирование» имеет
 * смысл только для глобальной роли «Редактор» и выше — читателю его не
 * выдаём, чтобы настройки не вводили в заблуждение. */
spacesRouter.post('/spaces/:key/members', requireLogin, async (req, res) => {
  const { space, access } = await loadSpaceWithAccess(req, req.params.key);
  requireSpaceAccess(req, access, 'manage');

  const login = String(req.body.login ?? '').trim();
  const level = ACCESS_LEVELS[req.body.access] ? req.body.access : 'read';
  const user = login
    ? await one('SELECT id, display_name, role, is_active FROM users WHERE lower(username) = lower($1) OR lower(email) = lower($1)', [login])
    : null;

  const errors = [];
  if (!user || !user.is_active) errors.push(`Пользователь «${login}» не найден или заблокирован`);
  else if (user.id === space.owner_id) errors.push('Владелец и так имеет полный доступ к пространству');
  else if (level === 'edit' && !hasRole(user, 'editor')) {
    errors.push(`${user.display_name} — читатель: право редактирования получают только пользователи с ролью «Редактор». Роль меняет администратор.`);
  }
  if (errors.length) return renderPermissions(req, res, space, { errors, status: 422 });

  await query(
    `INSERT INTO space_members (space_id, user_id, access, added_by) VALUES ($1, $2, $3, $4)
     ON CONFLICT (space_id, user_id) DO UPDATE SET access = EXCLUDED.access`,
    [space.id, user.id, level, req.user.id],
  );
  req.flash('success', `${user.display_name}: доступ «${ACCESS_LEVELS[level]}»`);
  return res.redirect(`/spaces/${space.key}/permissions`);
});

spacesRouter.post('/spaces/:key/members/:userId/delete', requireLogin, async (req, res) => {
  const { space, access } = await loadSpaceWithAccess(req, req.params.key);
  requireSpaceAccess(req, access, 'manage');
  await query('DELETE FROM space_members WHERE space_id = $1 AND user_id = $2', [space.id, parseId(req.params.userId)]);
  req.flash('success', 'Участник удалён из пространства');
  return res.redirect(`/spaces/${space.key}/permissions`);
});
