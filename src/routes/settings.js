/**
 * ============================================================================
 *  routes/settings.js — личные настройки пользователя
 * ============================================================================
 *  Раздел оформлен как «Системные настройки»: слева меню, справа страница
 *  (общий шаблон меню — views/partials/settings-nav.ejs, area: 'user').
 *  Информация о профиле — отдельная страница /profile (routes/profile.js),
 *  настройки сайта — раздел /admin (routes/admin.js).
 *
 *  Маршруты (все требуют входа):
 *    GET  /settings                  — перенаправление на «Учётную запись»
 *    GET  /settings/account          — имя и email
 *    POST /settings/account          — сохранение (только локальные учётки)
 *    GET  /settings/security         — пароль и активные сеансы
 *    POST /settings/password         — смена пароля (только локальные учётки)
 *    POST /settings/sessions/revoke  — выйти на всех других устройствах
 *    GET  /settings/appearance       — тема оформления, режим, редактор
 *    POST /settings/theme            — выбор своей темы оформления
 * ============================================================================
 */
import { Router } from 'express';
import { one, query } from '../db/pool.js';
import { requireLogin } from '../middleware/auth.js';
import { getSettings } from '../services/settings.js';
import { getTheme, getThemes, hasTheme } from '../services/themes.js';
import { hashPassword, validatePassword, validateUserInput, verifyPassword } from '../services/users.js';
import { HttpError } from '../utils/http.js';

export const settingsRouter = Router();

settingsRouter.use('/settings', requireLogin);

/* У LDAP-пользователей имя, email и пароль берутся из каталога и
 * перезаписываются при каждом входе, поэтому менять их здесь нельзя. */
function forbidForLdap(req, res, next) {
  if (req.user.auth_source === 'ldap') {
    return next(new HttpError(403, 'Данные этой учётной записи управляются каталогом LDAP'));
  }
  return next();
}

settingsRouter.get('/settings', (req, res) => res.redirect('/settings/account'));

/* ============================ УЧЁТНАЯ ЗАПИСЬ ============================= */

function renderAccount(res, { errors = [], values = null, status = 200 } = {}) {
  res.status(status).render('settings/account', { title: 'Учётная запись', errors, values });
}

settingsRouter.get('/settings/account', (req, res) => renderAccount(res));

settingsRouter.post('/settings/account', forbidForLdap, async (req, res) => {
  const displayName = String(req.body.display_name ?? '').trim();
  const email = String(req.body.email ?? '').trim();
  const errors = validateUserInput({ displayName, email }, { checkPassword: false, checkUsername: false });

  if (!errors.length) {
    try {
      await query('UPDATE users SET display_name = $2, email = $3 WHERE id = $1', [req.user.id, displayName, email.toLowerCase()]);
      req.flash('success', 'Данные учётной записи сохранены');
      return res.redirect('/settings/account');
    } catch (err) {
      if (err.code !== '23505') throw err;
      errors.push('Этот email уже используется другим пользователем');
    }
  }
  /* Возвращаем в форму введённые значения, а не сохранённые. */
  return renderAccount(res, { errors, values: { display_name: displayName, email }, status: 422 });
});

/* ============================= БЕЗОПАСНОСТЬ ==============================
 * «Другие сеансы» — записи в таблице session с тем же userId, кроме
 * текущей и уже истёкших: браузеры и устройства, где пользователь вошёл.
 * ========================================================================= */
async function renderSecurity(req, res, { errors = [], status = 200 } = {}) {
  const { count } = await one(
    `SELECT count(*)::int AS count FROM session
      WHERE (sess->>'userId')::int = $1 AND sid <> $2 AND expire > now()`,
    [req.user.id, req.sessionID],
  );
  res.status(status).render('settings/security', { title: 'Безопасность', errors, otherSessions: count });
}

settingsRouter.get('/settings/security', (req, res) => renderSecurity(req, res));

settingsRouter.post('/settings/password', forbidForLdap, async (req, res) => {
  const current = String(req.body.current_password ?? '');
  const next = String(req.body.new_password ?? '');
  const errors = [];

  const { password_hash: hash } = await one('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
  if (!(await verifyPassword(current, hash))) errors.push('Текущий пароль указан неверно');
  errors.push(...validatePassword(next));
  if (next !== String(req.body.new_password_confirm ?? '')) errors.push('Новые пароли не совпадают');

  if (errors.length) return renderSecurity(req, res, { errors, status: 422 });

  await query('UPDATE users SET password_hash = $2 WHERE id = $1', [req.user.id, await hashPassword(next)]);
  /* После смены пароля завершаем все ДРУГИЕ сеансы — на случай, если пароль
   * меняют именно потому, что кто-то посторонний вошёл в учётную запись. */
  await query("DELETE FROM session WHERE (sess->>'userId')::int = $1 AND sid <> $2", [req.user.id, req.sessionID]);
  req.flash('success', 'Пароль изменён. Сеансы на других устройствах завершены.');
  return res.redirect('/settings/security');
});

settingsRouter.post('/settings/sessions/revoke', async (req, res) => {
  const { rowCount } = await query(
    "DELETE FROM session WHERE (sess->>'userId')::int = $1 AND sid <> $2",
    [req.user.id, req.sessionID],
  );
  req.flash('success', rowCount ? `Завершено сеансов: ${rowCount}. Вы остались в системе на этом устройстве.` : 'Других сеансов нет');
  return res.redirect('/settings/security');
});

/* ============================== ОФОРМЛЕНИЕ ===============================
 * Тема оформления хранится в БД (действует на всех устройствах), а
 * светлый/тёмный режим и режим редактора — в браузере (localStorage):
 * их переключает public/js/app.js прямо на странице, без отправки формы.
 * ========================================================================= */
settingsRouter.get('/settings/appearance', (req, res) => {
  res.render('settings/appearance', {
    title: 'Оформление',
    themes: getThemes(),
    siteTheme: getTheme(getSettings().theme),
  });
});

/* Пустое значение — «как на сайте» (NULL в БД): пользователь будет видеть
 * тему, которую выберет администратор, даже если её потом поменяют. */
settingsRouter.post('/settings/theme', async (req, res) => {
  if (!getSettings().allow_user_themes) throw new HttpError(403, 'Выбор темы отключён администратором');
  const themeId = String(req.body.theme ?? '').trim();
  if (themeId && !hasTheme(themeId)) throw new HttpError(400, 'Такой темы нет');

  await query('UPDATE users SET theme = $2 WHERE id = $1', [req.user.id, themeId || null]);
  req.flash('success', themeId ? `Тема «${getTheme(themeId).name}» применена` : 'Используется тема сайта по умолчанию');
  return res.redirect('/settings/appearance');
});
