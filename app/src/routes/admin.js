/**
 * ============================================================================
 *  routes/admin.js — администрирование (только роль admin)
 * ============================================================================
 *  Раздел устроен как «Системные настройки»: слева меню разделов
 *  (views/partials/settings-nav.ejs), справа содержимое раздела.
 *
 *  Маршруты:
 *    GET  /admin                     — обзор: статистика, система, разделы
 *    GET  /admin/settings            — перенаправление на первый раздел
 *    GET  /admin/settings/:section   — раздел настроек сайта: general | access |
 *                                      appearance (поля строятся по схеме)
 *    POST /admin/settings/:section   — сохранение полей ТОЛЬКО этого раздела
 *    POST /admin/settings/reset      — сброс группы настроек к умолчаниям
 *    GET  /admin/ldap             — настройки входа через LDAP / Active Directory
 *    POST /admin/ldap             — сохранение настроек LDAP
 *    POST /admin/ldap/test        — пошаговая проверка подключения к LDAP
 *    GET  /admin/users            — список пользователей + форма добавления
 *    POST /admin/users            — создание пользователя администратором
 *    GET  /admin/users/:id        — карточка пользователя
 *    POST /admin/users/:id        — смена роли, блокировка, сброс пароля
 *    POST /admin/users/:id/delete — удаление пользователя (контент остаётся)
 *
 *  Защита от «выстрела себе в ногу»: нельзя заблокировать, понизить или
 *  удалить самого себя и нельзя оставить сайт без единого активного
 *  администратора.
 * ============================================================================
 */
import os from 'node:os';
import { Router } from 'express';
import { many, one, query, transaction } from '../db/pool.js';
import { requireRole } from '../middleware/auth.js';
import { testLdapConnection } from '../services/ldap.js';
import { getThemes } from '../services/themes.js';
import {
  getSchemaGroups, getSettings, hasSecret, keysForTab, resetSettings, THEME_PRESETS, updateSettings,
} from '../services/settings.js';
import {
  createUser, hashPassword, ROLES, validatePassword, validateUserInput, ValidationError,
} from '../services/users.js';
import { backUrl, HttpError, parseId } from '../utils/http.js';

export const adminRouter = Router();

/* Все маршруты этого роутера, начинающиеся с /admin, — только для админов. */
adminRouter.use('/admin', requireRole('admin'));

/* =============================== ОБЗОР =================================== */

adminRouter.get('/admin', async (req, res) => {
  const [stats, newestUsers] = await Promise.all([
    one(
      `SELECT (SELECT count(*)::int FROM users)          AS users,
              (SELECT count(*)::int FROM users WHERE last_login_at > now() - interval '30 days') AS active_users,
              (SELECT count(*)::int FROM users WHERE auth_source = 'ldap') AS ldap_users,
              (SELECT count(*)::int FROM spaces)         AS spaces,
              (SELECT count(*)::int FROM pages)          AS pages,
              (SELECT count(*)::int FROM page_versions)  AS versions,
              (SELECT count(*)::int FROM comments)       AS comments,
              (SELECT count(*)::int FROM attachments)    AS attachments,
              (SELECT coalesce(sum(size_bytes), 0)::bigint FROM attachments) AS attachments_size,
              pg_size_pretty(pg_database_size(current_database())) AS db_size,
              current_setting('server_version') AS pg_version`,
    ),
    many('SELECT id, username, display_name, role, auth_source, created_at FROM users ORDER BY created_at DESC LIMIT 5'),
  ]);
  /* Сведения о среде: пригодятся, чтобы убедиться, на какой архитектуре
   * (amd64/arm64) реально запущен мультиплатформенный образ. */
  const system = {
    node: process.version,
    platform: `${process.platform} / ${process.arch}`,
    uptime: Math.round(process.uptime()),
    memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    hostname: os.hostname(),
  };
  res.render('admin/index', {
    title: 'Администрирование', stats, system, newestUsers, sections: SETTINGS_SECTIONS,
  });
});

/* ============================== НАСТРОЙКИ ================================
 * Разделы настроек сайта. Ключ совпадает со свойством tab в схеме
 * (src/services/settings.js): поле с tab: 'access' попадёт на страницу
 * /admin/settings/access. Чтобы добавить раздел — впишите его сюда, в меню
 * (views/partials/settings-nav.ejs) и укажите tab у нужных полей схемы.
 * ========================================================================= */
export const SETTINGS_SECTIONS = {
  general: { title: 'Общие', icon: 'globe', description: 'Название сайта, логотип, приветствие на главной и объявления.' },
  access: { title: 'Доступ и права', icon: 'lock', description: 'Кто может читать, регистрироваться и оставлять комментарии.' },
  appearance: { title: 'Оформление', icon: 'droplet', description: 'Тема сайта, светлый и тёмный режим, цвета, шрифты и собственный CSS.' },
};

function renderSection(res, section, { values = getSettings(), errors = [], status = 200 } = {}) {
  res.status(status).render('admin/settings', {
    title: SETTINGS_SECTIONS[section].title,
    section,
    meta: SETTINGS_SECTIONS[section],
    groups: getSchemaGroups(section),
    values,
    presets: THEME_PRESETS,
    themes: getThemes(),
    errors,
  });
}

adminRouter.get('/admin/settings', (req, res) => res.redirect('/admin/settings/general'));

/* Сброс группы объявлен РАНЬШЕ маршрута /admin/settings/:section, иначе
 * адрес /admin/settings/reset был бы принят за раздел «reset». */
adminRouter.post('/admin/settings/reset', async (req, res) => {
  const group = String(req.body.group ?? '');
  await resetSettings(group);
  req.flash('success', `Группа «${group}» сброшена к значениям по умолчанию`);
  /* Возвращаемся на страницу, откуда пришли (раздел настроек или LDAP). */
  res.redirect(backUrl(req, '/admin/settings'));
});

adminRouter.get('/admin/settings/:section', (req, res, next) => {
  if (!SETTINGS_SECTIONS[req.params.section]) return next(); /* → 404 */
  return renderSection(res, req.params.section);
});

adminRouter.post('/admin/settings/:section', async (req, res, next) => {
  const { section } = req.params;
  if (!SETTINGS_SECTIONS[section]) return next();
  /* Сохраняем только поля этого раздела: отсутствующий в форме чекбокс
   * означает «выключено», и чужие разделы иначе сбросились бы. */
  const { errors } = await updateSettings(req.body, keysForTab(section));
  if (errors.length) {
    /* При ошибке показываем форму с ВВЕДЁННЫМИ значениями. */
    return renderSection(res, section, { values: { ...getSettings(), ...req.body }, errors, status: 422 });
  }
  req.flash('success', `Раздел «${SETTINGS_SECTIONS[section].title}» сохранён`);
  return res.redirect(`/admin/settings/${section}`);
});

/* ================================ LDAP ===================================
 * Отдельная вкладка: поля строятся по той же схеме (tab: 'ldap'), плюс
 * форма проверки подключения. Проверка всегда использует СОХРАНЁННЫЕ
 * настройки — поэтому сначала «Сохранить», потом «Проверить».
 * ========================================================================= */
function renderLdap(res, { values = getSettings(), errors = [], testResult = null, testLogin = '', status = 200 } = {}) {
  res.status(status).render('admin/ldap', {
    title: 'LDAP / Active Directory',
    groups: getSchemaGroups('ldap'),
    values,
    /* Какие секреты уже сохранены — чтобы показать «пароль сохранён». */
    secretsSet: { ldap_bind_password: hasSecret('ldap_bind_password') },
    errors,
    testResult,
    testLogin,
  });
}

adminRouter.get('/admin/ldap', (req, res) => renderLdap(res));

adminRouter.post('/admin/ldap', async (req, res) => {
  const { errors } = await updateSettings(req.body, keysForTab('ldap'));
  if (errors.length) {
    /* Пароль обратно в форму не возвращаем (secret никогда не выводится). */
    const { ldap_bind_password: _omit, ...entered } = req.body;
    return renderLdap(res, { values: { ...getSettings(), ...entered }, errors, status: 422 });
  }
  req.flash('success', 'Настройки LDAP сохранены. Проверьте подключение ниже.');
  return res.redirect('/admin/ldap');
});

adminRouter.post('/admin/ldap/test', async (req, res) => {
  const testLogin = String(req.body.test_login ?? '').trim();
  const testResult = await testLdapConnection(testLogin, String(req.body.test_password ?? ''));
  renderLdap(res, { testResult, testLogin });
});

/* ============================ ПОЛЬЗОВАТЕЛИ =============================== */

adminRouter.get('/admin/users', async (req, res) => {
  const users = await many(
    `SELECT u.id, u.username, u.email, u.display_name, u.role, u.is_active, u.created_at, u.last_login_at, u.auth_source,
            (SELECT count(*)::int FROM page_versions v WHERE v.author_id = u.id) AS edits
       FROM users u
      ORDER BY u.created_at`,
  );
  res.render('admin/users', { title: 'Пользователи', users, roles: ROLES, values: {}, errors: [] });
});

/* Создание пользователя вручную (актуально, когда регистрация закрыта). */
adminRouter.post('/admin/users', async (req, res) => {
  const values = {
    username: String(req.body.username ?? '').trim(),
    email: String(req.body.email ?? '').trim(),
    displayName: String(req.body.display_name ?? '').trim(),
    role: ROLES.includes(req.body.role) ? req.body.role : 'viewer',
  };
  const password = String(req.body.password ?? '');
  const errors = validateUserInput({ ...values, password });

  if (!errors.length) {
    try {
      await createUser({ ...values, password });
      req.flash('success', `Пользователь ${values.username} создан`);
      return res.redirect('/admin/users');
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      errors.push(err.message);
    }
  }
  const users = await many('SELECT id, username, email, display_name, role, is_active, created_at, last_login_at, auth_source, 0 AS edits FROM users ORDER BY created_at');
  return res.status(422).render('admin/users', { title: 'Пользователи', users, roles: ROLES, values, errors });
});

async function loadUser(id) {
  const user = await one(
    'SELECT id, username, email, display_name, role, is_active, created_at, last_login_at, auth_source, ldap_dn FROM users WHERE id = $1',
    [id],
  );
  if (!user) throw new HttpError(404, 'Пользователь не найден');
  return user;
}

/* Управляется ли роль LDAP-пользователя группами каталога (тогда ручная
 * смена роли будет перезаписана при следующем входе — предупреждаем). */
function ldapRoleManaged(user) {
  const s = getSettings();
  return user.auth_source === 'ldap' && Boolean(s.ldap_admin_group || s.ldap_editor_group);
}

/* true, если user — единственный активный администратор: его нельзя
 * понизить, заблокировать или удалить, иначе сайтом некому управлять. */
async function isLastActiveAdmin(user) {
  if (user.role !== 'admin' || !user.is_active) return false;
  const { count } = await one(
    "SELECT count(*)::int AS count FROM users WHERE role = 'admin' AND is_active AND id <> $1",
    [user.id],
  );
  return count === 0;
}

/* ----------------------------------------------------------------------------
 * Карточка пользователя. activity — сколько контента за ним числится: эти
 * цифры показываются в блоке удаления, чтобы администратор понимал, что
 * именно станет «от удалённого пользователя».
 * ------------------------------------------------------------------------- */
async function renderUser(res, user, errors = [], status = 200) {
  const activity = await one(
    `SELECT (SELECT count(*)::int FROM pages         WHERE created_by  = $1) AS pages,
            (SELECT count(*)::int FROM page_versions WHERE author_id   = $1) AS versions,
            (SELECT count(*)::int FROM comments      WHERE author_id   = $1) AS comments,
            (SELECT count(*)::int FROM attachments   WHERE uploaded_by = $1) AS attachments`,
    [user.id],
  );
  res.status(status).render('admin/user', {
    title: `Пользователь ${user.username}`,
    user,
    roles: ROLES,
    errors,
    roleManaged: ldapRoleManaged(user),
    activity,
    isSelf: user.id === res.locals.currentUser?.id,
  });
}

adminRouter.get('/admin/users/:id', async (req, res) => {
  await renderUser(res, await loadUser(parseId(req.params.id)));
});

adminRouter.post('/admin/users/:id', async (req, res) => {
  const user = await loadUser(parseId(req.params.id));
  const role = ROLES.includes(req.body.role) ? req.body.role : user.role;
  const isActive = req.body.is_active === 'on';
  /* Пароль LDAP-пользователей хранится в каталоге — локально не задаётся. */
  const newPassword = user.auth_source === 'local' ? String(req.body.new_password ?? '') : '';
  const errors = [];

  /* ---- Защитные проверки ---- */
  const isSelf = user.id === req.user.id;
  if (isSelf && (role !== 'admin' || !isActive)) {
    errors.push('Нельзя понизить или заблокировать самого себя');
  }
  if ((role !== 'admin' || !isActive) && (await isLastActiveAdmin(user))) {
    errors.push('Должен остаться хотя бы один активный администратор');
  }
  if (newPassword) errors.push(...validatePassword(newPassword));

  if (errors.length) return renderUser(res, user, errors, 422);

  await query('UPDATE users SET role = $2, is_active = $3 WHERE id = $1', [user.id, role, isActive]);
  if (newPassword) {
    await query('UPDATE users SET password_hash = $2 WHERE id = $1', [user.id, await hashPassword(newPassword)]);
  }
  /* При блокировке сразу завершаем все сессии пользователя. */
  if (!isActive) {
    await query("DELETE FROM session WHERE (sess->>'userId')::int = $1", [user.id]);
  }

  req.flash('success', 'Изменения сохранены');
  return res.redirect('/admin/users');
});

/* =========================== УДАЛЕНИЕ ПОЛЬЗОВАТЕЛЯ ======================
 * Что происходит:
 *  - учётная запись удаляется безвозвратно, все её сеансы завершаются;
 *  - созданный пользователем контент ОСТАЁТСЯ: в схеме БД ссылки на автора
 *    объявлены ON DELETE SET NULL, поэтому страницы, версии, комментарии и
 *    вложения сохраняются с пометкой «удалённый пользователь»;
 *  - его избранное удаляется вместе с ним (ON DELETE CASCADE).
 * Защита:
 *  - нельзя удалить себя и последнего активного администратора;
 *  - нужно ввести логин удаляемого пользователя (как при удалении
 *    пространства) — защита от случайного клика.
 * ========================================================================= */
adminRouter.post('/admin/users/:id/delete', async (req, res) => {
  const user = await loadUser(parseId(req.params.id));
  const errors = [];

  if (user.id === req.user.id) errors.push('Нельзя удалить собственную учётную запись');
  else if (await isLastActiveAdmin(user)) errors.push('Нельзя удалить последнего активного администратора');
  else if (String(req.body.confirm_username ?? '').trim().toLowerCase() !== user.username.toLowerCase()) {
    errors.push('Логин для подтверждения не совпадает — пользователь НЕ удалён');
  }
  if (errors.length) return renderUser(res, user, errors, 422);

  /* Сеансы и учётная запись — одной транзакцией. */
  await transaction(async (db) => {
    await db.query("DELETE FROM session WHERE (sess->>'userId')::int = $1", [user.id]);
    await db.query('DELETE FROM users WHERE id = $1', [user.id]);
  });

  console.log(`[admin] ${req.user.username} удалил(а) пользователя ${user.username} (id ${user.id})`);
  req.flash('success', `Пользователь ${user.username} удалён. Созданные им статьи и комментарии сохранены.`);
  return res.redirect('/admin/users');
});
