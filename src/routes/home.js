/**
 * ============================================================================
 *  routes/home.js — главная страница, поиск, метки, мастер «Создать»
 * ============================================================================
 *  Маршруты:
 *    GET /              — дашборд: приветствие, недавние изменения,
 *                          пространства, избранное
 *    GET /search?q=     — полнотекстовый поиск по всем страницам
 *    GET /labels        — облако всех меток
 *    GET /labels/:name  — страницы с указанной меткой
 *    GET /create        — выбор пространства для новой страницы
 * ============================================================================
 */
import { Router } from 'express';
import { many, one } from '../db/pool.js';
import { requireRole } from '../middleware/auth.js';
import { escapeHtml, excerpt, renderMarkdown } from '../services/markdown.js';
import { getSettings } from '../services/settings.js';

export const homeRouter = Router();

/* ============================== ГЛАВНАЯ ================================== */

homeRouter.get('/', async (req, res) => {
  /* Три независимых запроса выполняем параллельно (Promise.all) —
   * страница открывается быстрее, чем при последовательных запросах. */
  const [spaces, recent, favorites] = await Promise.all([
    many(`SELECT s.key, s.name, s.icon, s.color,
                 (SELECT count(*)::int FROM pages p WHERE p.space_id = s.id) AS page_count
            FROM spaces s
           ORDER BY lower(s.name)`),
    many(`SELECT p.id, p.title, p.updated_at, p.version,
                 s.key AS space_key, s.name AS space_name, s.icon AS space_icon,
                 u.display_name AS updated_by_name
            FROM pages p
            JOIN spaces s ON s.id = p.space_id
            LEFT JOIN users u ON u.id = p.updated_by
           ORDER BY p.updated_at DESC
           LIMIT 15`),
    req.user
      ? many(`SELECT p.id, p.title, s.icon AS space_icon, s.name AS space_name
                FROM favorites f
                JOIN pages p ON p.id = f.page_id
                JOIN spaces s ON s.id = p.space_id
               WHERE f.user_id = $1
               ORDER BY f.created_at DESC`, [req.user.id])
      : [],
  ]);

  const welcomeHtml = renderMarkdown(getSettings().welcome_markdown).html;
  res.render('home', { title: null, spaces, recent, favorites, welcomeHtml });
});

/* =============================== ПОИСК ===================================
 * Используется встроенный полнотекстовый поиск PostgreSQL:
 *  - websearch_to_tsquery понимает синтаксис как у поисковиков:
 *      слово1 слово2      — оба слова
 *      "точная фраза"     — фраза
 *      слово1 or слово2   — любое из слов
 *      -слово             — исключить
 *  - ts_rank сортирует по релевантности (совпадение в заголовке весит больше);
 *  - ts_headline строит фрагмент текста с подсвеченными совпадениями.
 *  Дополнительно ищем подстроку в заголовке (ILIKE), чтобы находились
 *  и частично набранные слова: «докер» найдёт «Докеризация».
 * ========================================================================= */
homeRouter.get('/search', async (req, res) => {
  const q = String(req.query.q ?? '').trim().slice(0, 200);
  const spaceKey = String(req.query.space ?? '').trim().toUpperCase() || null;
  res.locals.searchQuery = q;

  const spaces = await many('SELECT key, name FROM spaces ORDER BY lower(name)');
  if (!q) return res.render('search', { title: 'Поиск', q, spaceKey, spaces, results: [] });

  /* Экранируем спецсимволы LIKE (% и _), чтобы они искались буквально. */
  const likePattern = `%${q.replace(/[\\%_]/g, '\\$&')}%`;

  /* Маркеры ⟦ ⟧ вместо HTML-тегов: сначала экранируем фрагмент целиком,
   * а потом безопасно заменяем маркеры на <mark>. */
  const rows = await many(
    `WITH q AS (SELECT websearch_to_tsquery('russian', $1) AS query)
     SELECT p.id, p.title, p.updated_at,
            s.key AS space_key, s.name AS space_name, s.icon AS space_icon,
            ts_rank(p.search_vector, q.query)
              + CASE WHEN p.title ILIKE $2 THEN 1 ELSE 0 END AS rank,
            ts_headline('russian', p.content, q.query,
              'StartSel=⟦, StopSel=⟧, MaxWords=35, MinWords=15, MaxFragments=2, FragmentDelimiter=" … "') AS snippet
       FROM pages p
       JOIN spaces s ON s.id = p.space_id
       CROSS JOIN q
      WHERE (p.search_vector @@ q.query OR p.title ILIKE $2)
        AND ($3::text IS NULL OR s.key = $3)
      ORDER BY rank DESC, p.updated_at DESC
      LIMIT 50`,
    [q, likePattern, spaceKey],
  );

  const results = rows.map((row) => {
    let text = escapeHtml(excerpt(row.snippet, 400));
    /* Обрезка фрагмента могла «отрезать» закрывающий маркер — досчитываем. */
    const unclosed = (text.match(/⟦/g) ?? []).length - (text.match(/⟧/g) ?? []).length;
    if (unclosed > 0) text += '⟧'.repeat(unclosed);
    return { ...row, snippetHtml: text.replaceAll('⟦', '<mark>').replaceAll('⟧', '</mark>') };
  });

  return res.render('search', { title: `Поиск: ${q}`, q, spaceKey, spaces, results });
});

/* =============================== МЕТКИ =================================== */

homeRouter.get('/labels', async (req, res) => {
  const labels = await many(
    `SELECT l.name, count(pl.page_id)::int AS page_count
       FROM labels l
       JOIN page_labels pl ON pl.label_id = l.id
      GROUP BY l.id
      ORDER BY l.name`,
  );
  res.render('labels/index', { title: 'Метки', labels });
});

homeRouter.get('/labels/:name', async (req, res) => {
  const name = String(req.params.name).toLowerCase();
  const pages = await many(
    `SELECT p.id, p.title, p.content, p.updated_at,
            s.key AS space_key, s.name AS space_name, s.icon AS space_icon
       FROM labels l
       JOIN page_labels pl ON pl.label_id = l.id
       JOIN pages p ON p.id = pl.page_id
       JOIN spaces s ON s.id = p.space_id
      WHERE l.name = $1
      ORDER BY p.updated_at DESC`,
    [name],
  );
  /* Текст статьи целиком шаблону не нужен — только короткий фрагмент. */
  const items = pages.map(({ content, ...page }) => ({ ...page, excerpt: excerpt(content, 180) }));
  res.render('labels/show', { title: `Метка: ${name}`, name, pages: items });
});

/* ======================== МАСТЕР «СОЗДАТЬ» ===============================
 * Кнопка «+ Создать» в шапке вне пространства ведёт сюда: пользователь
 * выбирает, в каком пространстве создать страницу (или создаёт новое).
 * ========================================================================= */
homeRouter.get('/create', requireRole('editor'), async (req, res) => {
  const spaces = await many('SELECT key, name, icon, color FROM spaces ORDER BY lower(name)');
  if (spaces.length === 0) return res.redirect('/spaces/new');
  const lastSpace = req.query.space
    ? await one('SELECT key FROM spaces WHERE key = $1', [String(req.query.space).toUpperCase()])
    : null;
  return res.render('create', { title: 'Создать', spaces, selected: lastSpace?.key ?? spaces[0].key });
});
