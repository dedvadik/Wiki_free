/**
 * ============================================================================
 *  routes/profile.js — личный профиль пользователя
 * ============================================================================
 *  Маршруты (все требуют входа):
 *    GET  /profile           — профиль, мои последние правки, формы
 *    POST /profile           — изменение имени и email (только локальные)
 *    POST /profile/password  — смена пароля с проверкой текущего (только локальные)
 *    POST /profile/theme     — выбор своей темы оформления (все, включая LDAP)
 * ============================================================================
 */
import { Router } from 'express';
import { many, one, query } from '../db/pool.js';
import { requireLogin } from '../middleware/auth.js';
import { getSettings } from '../services/settings.js';
import { getTheme, getThemes, hasTheme } from '../services/themes.js';
import { hashPassword, validatePassword, validateUserInput, verifyPassword } from '../services/users.js';
import { HttpError } from '../utils/http.js';

export const profileRouter = Router();

profileRouter.use('/profile', requireLogin);

/* У LDAP-пользователей имя, email и пароль берутся из каталога и
 * перезаписываются при каждом входе, поэтому менять их здесь нельзя. */
function forbidForLdap(req, res, next) {
  if (req.user.auth_source === 'ldap') {
    return next(new HttpError(403, 'Данные этой учётной записи управляются каталогом LDAP'));
  }
  return next();
}

/** Последние правки пользователя — для раздела «Моя активность». */
function recentEdits(userId) {
  return many(
    `SELECT DISTINCT ON (p.id) p.id, p.title, v.version, v.created_at, s.icon AS space_icon, s.name AS space_name
       FROM page_versions v
       JOIN pages p ON p.id = v.page_id
       JOIN spaces s ON s.id = p.space_id
      WHERE v.author_id = $1
      ORDER BY p.id, v.created_at DESC`,
    [userId],
  ).then((rows) => rows.sort((a, b) => b.created_at - a.created_at).slice(0, 15));
}

async function renderProfile(req, res, { errors = [], status = 200 } = {}) {
  res.status(status).render('profile', {
    title: 'Профиль',
    errors,
    edits: await recentEdits(req.user.id),
    themes: getThemes(),
    /* Тема сайта по умолчанию — для подписи варианта «По умолчанию». */
    siteTheme: getTheme(getSettings().theme),
  });
}

profileRouter.get('/profile', (req, res) => renderProfile(req, res));

/* ------------------------- Имя и email ------------------------------------ */
profileRouter.post('/profile', forbidForLdap, async (req, res) => {
  const displayName = String(req.body.display_name ?? '').trim();
  const email = String(req.body.email ?? '').trim();
  const errors = validateUserInput({ displayName, email }, { checkPassword: false, checkUsername: false });

  if (!errors.length) {
    try {
      await query('UPDATE users SET display_name = $2, email = $3 WHERE id = $1', [req.user.id, displayName, email.toLowerCase()]);
      req.flash('success', 'Профиль обновлён');
      return res.redirect('/profile');
    } catch (err) {
      if (err.code !== '23505') throw err;
      errors.push('Этот email уже используется другим пользователем');
    }
  }
  return renderProfile(req, res, { errors, status: 422 });
});

/* ------------------------- Смена пароля ----------------------------------- */
profileRouter.post('/profile/password', forbidForLdap, async (req, res) => {
  const current = String(req.body.current_password ?? '');
  const next = String(req.body.new_password ?? '');
  const errors = [];

  const { password_hash: hash } = await one('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
  if (!(await verifyPassword(current, hash))) errors.push('Текущий пароль указан неверно');
  errors.push(...validatePassword(next));
  if (next !== String(req.body.new_password_confirm ?? '')) errors.push('Новые пароли не совпадают');

  if (errors.length) return renderProfile(req, res, { errors, status: 422 });

  await query('UPDATE users SET password_hash = $2 WHERE id = $1', [req.user.id, await hashPassword(next)]);
  /* Завершаем все ДРУГИЕ сессии пользователя (например, на чужом компьютере). */
  await query("DELETE FROM session WHERE (sess->>'userId')::int = $1 AND sid <> $2", [req.user.id, req.sessionID]);
  req.flash('success', 'Пароль изменён. Остальные сеансы завершены.');
  return res.redirect('/profile');
});

/* ------------------------- Тема оформления --------------------------------
 * Пустое значение — «как на сайте» (NULL в БД): пользователь будет видеть
 * тему, которую выберет администратор, даже если её потом поменяют.
 * ------------------------------------------------------------------------- */
profileRouter.post('/profile/theme', async (req, res) => {
  if (!getSettings().allow_user_themes) throw new HttpError(403, 'Выбор темы отключён администратором');
  const themeId = String(req.body.theme ?? '').trim();
  if (themeId && !hasTheme(themeId)) throw new HttpError(400, 'Такой темы нет');

  await query('UPDATE users SET theme = $2 WHERE id = $1', [req.user.id, themeId || null]);
  req.flash('success', themeId ? `Тема «${getTheme(themeId).name}» применена` : 'Используется тема сайта по умолчанию');
  return res.redirect('/profile#theme');
});
