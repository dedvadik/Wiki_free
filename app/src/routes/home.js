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
import { accessParams, editableSpacesSql, readableSpacesSql } from '../services/permissions.js';
import { getSettings } from '../services/settings.js';

export const homeRouter = Router();

/* ============================== ГЛАВНАЯ ================================== */

homeRouter.get('/', async (req, res) => {
  /* Во всех выборках — только пространства, которые пользователь может
   * читать ($1 — администратор ли он, $2 — его id). Три независимых
   * запроса выполняем параллельно (Promise.all). */
  const params = accessParams(req.user);
  const readable = readableSpacesSql('s', '$1', '$2');
  const [spaces, recent, favorites] = await Promise.all([
    many(`SELECT s.key, s.name, s.icon, s.color, s.visibility,
                 (SELECT count(*)::int FROM pages p WHERE p.space_id = s.id) AS page_count
            FROM spaces s
           WHERE ${readable}
           ORDER BY lower(s.name)`, params),
    many(`SELECT p.id, p.title, p.updated_at, p.version,
                 s.key AS space_key, s.name AS space_name, s.icon AS space_icon,
                 u.display_name AS updated_by_name
            FROM pages p
            JOIN spaces s ON s.id = p.space_id
            LEFT JOIN users u ON u.id = p.updated_by
           WHERE ${readable}
           ORDER BY p.updated_at DESC
           LIMIT 15`, params),
    /* Избранное тоже фильтруем: если доступ к пространству отозвали,
     * его страницы исчезают и из избранного. */
    req.user
      ? many(`SELECT p.id, p.title, s.icon AS space_icon, s.name AS space_name
                FROM favorites f
                JOIN pages p ON p.id = f.page_id
                JOIN spaces s ON s.id = p.space_id
               WHERE f.user_id = $2 AND ${readable}
               ORDER BY f.created_at DESC`, params)
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
/* Сколько самых свежих совпадений ранжировать по релевантности (см. ниже). */
const SEARCH_RANK_LIMIT = 1000;

homeRouter.get('/search', async (req, res) => {
  const q = String(req.query.q ?? '').trim().slice(0, 200);
  const spaceKey = String(req.query.space ?? '').trim().toUpperCase() || null;
  res.locals.searchQuery = q;

  /* Ищем только в пространствах, которые пользователь может читать:
   * закрытое не должно всплывать ни в результатах, ни в фрагментах текста. */
  const [isAdmin, userId] = accessParams(req.user);
  const spaces = await many(
    `SELECT key, name FROM spaces s WHERE ${readableSpacesSql('s', '$1', '$2')} ORDER BY lower(name)`,
    [isAdmin, userId],
  );
  if (!q) return res.render('search', { title: 'Поиск', q, spaceKey, spaces, results: [] });

  /* Экранируем спецсимволы LIKE (% и _), чтобы они искались буквально. */
  const likePattern = `%${q.replace(/[\\%_]/g, '\\$&')}%`;

  /* Запрос в три шага (так он быстрый и на десятках тысяч страниц —
   * см. нагрузочное тестирование, docs/portal/31-load-testing.md):
   *  1. matches — все совпадения по полнотекстовому индексу (GIN). Только
   *     id и дата — это дёшево даже для слова, которое есть везде.
   *     MATERIALIZED не даёт планировщику вместо индекса «идти» по дате
   *     изменения и проверять каждую страницу подряд.
   *  2. candidates — не более SEARCH_RANK_LIMIT самых свежих совпадений плюс
   *     до 200 страниц с подстрокой в заголовке (триграммный индекс).
   *     Вычислять ts_rank дорого (нужно распаковать весь поисковый вектор
   *     страницы): для частого слова вроде «сервер» на 20 000 страниц это
   *     больше секунды. Редкие слова (совпадений меньше предела) ранжируются
   *     полностью, как раньше.
   *  3. Ранжирование кандидатов и фрагменты текста только для 50 лучших
   *     (PostgreSQL вычисляет ts_headline уже после сортировки и LIMIT).
   * Маркеры ⟦ ⟧ вместо HTML-тегов: сначала экранируем фрагмент целиком,
   * а потом безопасно заменяем маркеры на <mark>. */
  const readable = readableSpacesSql('s', '$4', '$5');
  const rows = await many(
    `WITH q AS (SELECT websearch_to_tsquery('russian', $1) AS query),
     matches AS MATERIALIZED (
       SELECT p.id, p.updated_at
         FROM pages p JOIN spaces s ON s.id = p.space_id CROSS JOIN q
        WHERE p.search_vector @@ q.query
          AND ($3::text IS NULL OR s.key = $3) AND ${readable}
     ),
     candidates AS (
       (SELECT id FROM matches ORDER BY updated_at DESC LIMIT ${SEARCH_RANK_LIMIT})
       UNION
       (SELECT p.id FROM pages p JOIN spaces s ON s.id = p.space_id
         WHERE p.title ILIKE $2
           AND ($3::text IS NULL OR s.key = $3) AND ${readable}
         LIMIT 200)
     )
     SELECT p.id, p.title, p.updated_at,
            s.key AS space_key, s.name AS space_name, s.icon AS space_icon,
            ts_rank(p.search_vector, q.query)
              + CASE WHEN p.title ILIKE $2 THEN 1 ELSE 0 END AS rank,
            ts_headline('russian', p.content, q.query,
              'StartSel=⟦, StopSel=⟧, MaxWords=35, MinWords=15, MaxFragments=2, FragmentDelimiter=" … "') AS snippet
       FROM candidates c
       JOIN pages p ON p.id = c.id
       JOIN spaces s ON s.id = p.space_id
       CROSS JOIN q
      ORDER BY rank DESC, p.updated_at DESC
      LIMIT 50`,
    [q, likePattern, spaceKey, isAdmin, userId],
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

/* Метки и счётчики учитывают только страницы доступных пространств. */
homeRouter.get('/labels', async (req, res) => {
  const labels = await many(
    `SELECT l.name, count(pl.page_id)::int AS page_count
       FROM labels l
       JOIN page_labels pl ON pl.label_id = l.id
       JOIN pages p ON p.id = pl.page_id
       JOIN spaces s ON s.id = p.space_id
      WHERE ${readableSpacesSql('s', '$1', '$2')}
      GROUP BY l.id
      ORDER BY l.name`,
    accessParams(req.user),
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
      WHERE l.name = $1 AND ${readableSpacesSql('s', '$2', '$3')}
      ORDER BY p.updated_at DESC`,
    [name, ...accessParams(req.user)],
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
  /* Предлагаем только пространства, где пользователь может править. */
  const spaces = await many(
    `SELECT key, name, icon, color FROM spaces s
      WHERE ${editableSpacesSql('s', '$1', '$2')}
      ORDER BY lower(name)`,
    accessParams(req.user),
  );
  if (spaces.length === 0) return res.redirect('/spaces/new');
  const lastSpace = req.query.space
    ? await one('SELECT key FROM spaces WHERE key = $1', [String(req.query.space).toUpperCase()])
    : null;
  return res.render('create', { title: 'Создать', spaces, selected: lastSpace?.key ?? spaces[0].key });
});
