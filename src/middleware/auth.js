/**
 * ============================================================================
 *  middleware/auth.js — авторизация: кто пользователь и что ему можно
 * ============================================================================
 *  Схема работы:
 *   1. При входе в req.session.userId записывается id пользователя
 *      (сама сессия хранится в PostgreSQL, в браузере — только cookie с
 *      подписанным случайным идентификатором).
 *   2. loadUser на КАЖДОМ запросе загружает пользователя из БД по этому id.
 *      Так блокировка или смена роли администратором действует сразу,
 *      а не после повторного входа.
 *   3. requireLogin / requireRole — «охранники» для отдельных маршрутов.
 *   4. siteAccess — «охранник» всего сайта в режиме закрытой вики.
 * ============================================================================
 */
import { one } from '../db/pool.js';
import { getSettings } from '../services/settings.js';
import { hasRole } from '../services/users.js';
import { HttpError } from '../utils/http.js';

/* ----------------------------------------------------------------------------
 * loadUser — определить текущего пользователя.
 * Если пользователь удалён или заблокирован — «разлогиниваем» его.
 * Хеш пароля намеренно не выбираем: он не нужен дальше по цепочке.
 * ------------------------------------------------------------------------- */
export async function loadUser(req, res, next) {
  req.user = null;
  const userId = req.session?.userId;
  if (userId) {
    const user = await one(
      'SELECT id, username, email, display_name, role, is_active, auth_source, theme FROM users WHERE id = $1',
      [userId],
    );
    if (user?.is_active) req.user = user;
    else delete req.session.userId;
  }
  next();
}

/* ----------------------------------------------------------------------------
 * redirectToLogin — запомнить, куда шёл пользователь, и отправить на вход.
 * После успешного входа он вернётся на запомненную страницу.
 * Для API-запросов (fetch из JS) вместо редиректа возвращаем 401.
 * ------------------------------------------------------------------------- */
function redirectToLogin(req, res, next) {
  if (req.path.startsWith('/api/')) return next(new HttpError(401, 'Требуется вход в систему'));
  if (req.method === 'GET') req.session.returnTo = req.originalUrl;
  req.flash('info', 'Войдите, чтобы продолжить');
  return res.redirect('/login');
}

/** Маршрут доступен только вошедшим пользователям (любая роль). */
export function requireLogin(req, res, next) {
  if (!req.user) return redirectToLogin(req, res, next);
  return next();
}

/* ----------------------------------------------------------------------------
 * requireRole('editor') — маршрут доступен роли editor и выше.
 * Гость → на страницу входа; вошедший, но без прав → ошибка 403.
 * ------------------------------------------------------------------------- */
export function requireRole(role) {
  return (req, res, next) => {
    if (!req.user) return redirectToLogin(req, res, next);
    if (!hasRole(req.user, role)) return next(new HttpError(403, 'Недостаточно прав для этого действия'));
    return next();
  };
}

/* ----------------------------------------------------------------------------
 * siteAccess — если в настройках включена «Закрытая вики», все маршруты,
 * подключённые ПОСЛЕ этого middleware, требуют входа. Страницы входа,
 * регистрации, стили темы и статика подключены раньше и остаются доступны.
 * ------------------------------------------------------------------------- */
export function siteAccess(req, res, next) {
  if (req.user || !getSettings().require_login) return next();
  return redirectToLogin(req, res, next);
}
