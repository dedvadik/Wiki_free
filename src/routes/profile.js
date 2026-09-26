/**
 * ============================================================================
 *  routes/profile.js — страница профиля (информация о пользователе)
 * ============================================================================
 *  Только просмотр: визитка с аватаром и ролью, статистика вклада,
 *  сведения об учётной записи, недавние правки и избранное.
 *  Всё, что можно изменить, — в разделе «Настройки» (routes/settings.js).
 *
 *  Маршрут:
 *    GET /profile — профиль текущего пользователя (требует входа)
 * ============================================================================
 */
import { Router } from 'express';
import { many, one } from '../db/pool.js';
import { requireLogin } from '../middleware/auth.js';

export const profileRouter = Router();

profileRouter.get('/profile', requireLogin, async (req, res) => {
  const userId = req.user.id;

  /* Все данные страницы — параллельными запросами. */
  const [details, stats, edits, favorites] = await Promise.all([
    one('SELECT created_at, last_login_at, ldap_dn FROM users WHERE id = $1', [userId]),
    one(
      `SELECT (SELECT count(*)::int FROM pages         WHERE created_by = $1) AS pages,
              (SELECT count(*)::int FROM page_versions WHERE author_id  = $1) AS edits,
              (SELECT count(*)::int FROM comments      WHERE author_id  = $1) AS comments,
              (SELECT count(*)::int FROM favorites     WHERE user_id    = $1) AS favorites`,
      [userId],
    ),
    /* Последние правки: по одной строке на страницу (DISTINCT ON), затем
     * сортировка по времени правки — свежие сверху. */
    many(
      `SELECT * FROM (
         SELECT DISTINCT ON (p.id) p.id, p.title, v.version, v.created_at,
                s.icon AS space_icon, s.name AS space_name
           FROM page_versions v
           JOIN pages p ON p.id = v.page_id
           JOIN spaces s ON s.id = p.space_id
          WHERE v.author_id = $1
          ORDER BY p.id, v.created_at DESC
       ) t
       ORDER BY created_at DESC
       LIMIT 10`,
      [userId],
    ),
    many(
      `SELECT p.id, p.title, s.icon AS space_icon, s.name AS space_name
         FROM favorites f
         JOIN pages p ON p.id = f.page_id
         JOIN spaces s ON s.id = p.space_id
        WHERE f.user_id = $1
        ORDER BY f.created_at DESC
        LIMIT 10`,
      [userId],
    ),
  ]);

  res.render('profile', { title: 'Профиль', details, stats, edits, favorites });
});
