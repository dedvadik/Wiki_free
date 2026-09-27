/**
 * ============================================================================
 *  routes/auth.js — вход, регистрация, выход
 * ============================================================================
 *  Маршруты:
 *    GET  /login      — форма входа
 *    POST /login      — проверка логина/пароля (локально или через LDAP),
 *                       создание сессии
 *    GET  /register   — форма регистрации
 *    POST /register   — создание учётной записи
 *    POST /logout     — завершение сессии (именно POST + CSRF, чтобы чужой
 *                       сайт не мог «разлогинить» пользователя картинкой)
 *
 *  Этот роутер подключается ДО siteAccess, поэтому доступен и в режиме
 *  закрытой вики.
 * ============================================================================
 */
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { config } from '../config.js';
import { one, query } from '../db/pool.js';
import { getSettings } from '../services/settings.js';
import { authenticateUser } from '../services/auth.js';
import { createUser, validateUserInput, ValidationError } from '../services/users.js';
import { HttpError, regenerateSession, safeReturnTo } from '../utils/http.js';

export const authRouter = Router();

/* ----------------------------------------------------------------------------
 * Ограничитель частоты попыток: не более N POST-запросов на вход/регистрацию
 * с одного IP за 15 минут. Защищает от перебора паролей.
 * За обратным прокси обязательно задайте TRUST_PROXY, иначе все запросы
 * будут выглядеть как пришедшие с IP прокси.
 * ------------------------------------------------------------------------- */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: config.authRateLimit,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res, next) => next(new HttpError(429, 'Слишком много попыток. Подождите 15 минут и попробуйте снова.')),
});

/* ----------------------------------------------------------------------------
 * Регистрация разрешена, если она включена в настройках ИЛИ в системе ещё
 * нет ни одного пользователя (иначе при выключенной регистрации и без
 * ADMIN_PASSWORD было бы невозможно создать первого администратора).
 * ------------------------------------------------------------------------- */
async function registrationAllowed() {
  if (getSettings().allow_registration) return true;
  const { count } = await one('SELECT count(*)::int AS count FROM users');
  return count === 0;
}

/* ============================== ВХОД ===================================== */

authRouter.get('/login', (req, res) => {
  if (req.user) return res.redirect('/');
  return res.render('auth/login', { title: 'Вход', login: '', error: null });
});

authRouter.post('/login', authLimiter, async (req, res) => {
  const login = String(req.body.login ?? '').trim();
  const password = String(req.body.password ?? '');

  /* Проверка локальным паролем или через LDAP — см. services/auth.js.
   * При неудаче намеренно не уточняем, что именно неверно (логин или
   * пароль), — иначе перебором можно было бы выяснить список логинов. */
  const result = await authenticateUser(login, password);
  if (result.error) {
    return res.status(result.status).render('auth/login', { title: 'Вход', login, error: result.error });
  }
  const { user } = result;
  if (!user.is_active) {
    return res.status(403).render('auth/login', { title: 'Вход', login, error: 'Учётная запись заблокирована администратором' });
  }

  /* Запоминаем, куда вернуть пользователя, ДО пересоздания сессии
   * (regenerate удаляет все данные старой сессии). */
  const returnTo = safeReturnTo(req.session.returnTo);
  await regenerateSession(req);
  req.session.userId = user.id;
  await query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);

  req.flash('success', `С возвращением, ${user.display_name}!`);
  return res.redirect(returnTo);
});

/* =========================== РЕГИСТРАЦИЯ ================================= */

authRouter.get('/register', async (req, res) => {
  if (req.user) return res.redirect('/');
  if (!(await registrationAllowed())) throw new HttpError(403, 'Регистрация закрыта. Обратитесь к администратору.');
  return res.render('auth/register', { title: 'Регистрация', values: {}, errors: [] });
});

authRouter.post('/register', authLimiter, async (req, res) => {
  if (!(await registrationAllowed())) throw new HttpError(403, 'Регистрация закрыта. Обратитесь к администратору.');

  /* Собираем значения формы (пароль в values НЕ кладём — чтобы не
   * возвращать его обратно в HTML при ошибке). */
  const values = {
    username: String(req.body.username ?? '').trim(),
    email: String(req.body.email ?? '').trim(),
    displayName: String(req.body.display_name ?? '').trim(),
  };
  const password = String(req.body.password ?? '');

  const errors = validateUserInput({ ...values, password });
  if (password !== String(req.body.password_confirm ?? '')) errors.push('Пароли не совпадают');
  if (errors.length) return res.status(422).render('auth/register', { title: 'Регистрация', values, errors });

  /* Если администраторов ещё нет — первый зарегистрированный им становится.
   * Иначе роль берётся из настроек («Роль новых пользователей»). */
  const { count: adminCount } = await one("SELECT count(*)::int AS count FROM users WHERE role = 'admin'");
  const role = adminCount === 0 ? 'admin' : getSettings().default_role;

  let user;
  try {
    user = await createUser({ ...values, password, role });
  } catch (err) {
    if (err instanceof ValidationError) {
      return res.status(422).render('auth/register', { title: 'Регистрация', values, errors: [err.message] });
    }
    throw err;
  }

  /* Сразу входим под новым пользователем. */
  await regenerateSession(req);
  req.session.userId = user.id;
  req.flash('success', role === 'admin'
    ? 'Учётная запись создана. Вы — администратор этого сайта.'
    : 'Учётная запись создана. Добро пожаловать!');
  return res.redirect('/');
});

/* ============================== ВЫХОД ==================================== */

authRouter.post('/logout', (req, res, next) => {
  req.session.destroy((err) => {
    if (err) return next(err);
    res.clearCookie('wiki.sid');
    return res.redirect('/');
  });
});
