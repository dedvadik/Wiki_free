/**
 * ============================================================================
 *  services/pages.js — работа с деревом страниц, метками и формой страницы
 * ============================================================================
 *  Страницы внутри пространства образуют дерево (как в Confluence): у каждой
 *  может быть родитель (parent_id) и любое число дочерних страниц.
 *  Этот модуль содержит:
 *   - построение дерева из «плоского» списка строк БД
 *   - получение цепочки предков (для хлебных крошек)
 *   - проверку, что новая родительская страница не создаёт цикл
 *   - разбор и сохранение меток
 *   - разбор и проверку полей формы редактора
 * ============================================================================
 */
import { many, one } from '../db/pool.js';
import { slugify } from './markdown.js';

/* ----------------------------------------------------------------------------
 * URL страницы: /pages/42/название-страницы. Числовой id — главный
 * идентификатор (название можно менять), «слаг» в конце — только для
 * читаемости ссылки и SEO. Маршрут принимает URL и без слага.
 * ------------------------------------------------------------------------- */
export function pageUrl(page) {
  const slug = slugify(page.title);
  return slug ? `/pages/${page.id}/${encodeURIComponent(slug)}` : `/pages/${page.id}`;
}

/* ----------------------------------------------------------------------------
 * buildTree — превращает список строк [{id, parent_id, ...}] в дерево
 * [{..., children: [...]}]. Работает за один проход с помощью Map.
 * Если родитель строки не найден (например, из-за повреждённых данных),
 * страница считается корневой — так она не «потеряется» из навигации.
 * ------------------------------------------------------------------------- */
export function buildTree(rows) {
  const byId = new Map(rows.map((row) => [row.id, { ...row, children: [] }]));
  const roots = [];
  for (const node of byId.values()) {
    const parent = node.parent_id ? byId.get(node.parent_id) : null;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

/* ----------------------------------------------------------------------------
 * flattenTree — обратная операция: дерево → плоский список с глубиной.
 * Используется для выпадающего списка «Родительская страница» в редакторе.
 * excludeId — исключить страницу И всех её потомков (нельзя сделать страницу
 * дочерней самой себе или своему потомку).
 * ------------------------------------------------------------------------- */
export function flattenTree(nodes, excludeId = null, depth = 0, out = []) {
  for (const node of nodes) {
    if (node.id === excludeId) continue;
    out.push({ id: node.id, title: node.title, depth });
    flattenTree(node.children, excludeId, depth + 1, out);
  }
  return out;
}

/* ----------------------------------------------------------------------------
 * getSpaceTreeAround — дерево для боковой панели БЕЗ загрузки всех страниц.
 * В большом пространстве (тысячи страниц) полное дерево — это мегабайты
 * HTML в каждой статье. Поэтому загружаются только:
 *   - корневые страницы пространства;
 *   - дочерние страницы для каждой страницы на пути к открытой
 *     (предки + сама страница) — путь виден раскрытым, как в Confluence.
 * Остальные ветки свёрнуты; у узла есть child_count, и когда пользователь
 * раскрывает ветку, её содержимое подгружается с /api/pages/:id/children
 * (public/js/app.js). Без JavaScript ссылка ведёт на страницу, где эта
 * ветка уже раскрыта, — навигация работает всегда.
 *
 * Путь к странице считается рекурсивным CTE прямо в запросе (как в
 * getAncestors), поэтому дерево можно грузить параллельно с остальными
 * данными статьи. pageId = null — только корневые страницы (главная
 * страница пространства).
 * ------------------------------------------------------------------------- */
export async function getSpaceTreeAround(spaceId, pageId = null) {
  const rows = await many(
    `WITH RECURSIVE chain AS (
        SELECT id, parent_id, 0 AS depth FROM pages WHERE id = $2
        UNION ALL
        SELECT p.id, p.parent_id, c.depth + 1
          FROM pages p JOIN chain c ON p.id = c.parent_id
         WHERE c.depth < 100
     )
     SELECT p.id, p.parent_id, p.title, p.position,
            (SELECT count(*)::int FROM pages c WHERE c.parent_id = p.id) AS child_count
       FROM pages p
      WHERE p.space_id = $1
        AND (p.parent_id IS NULL OR p.parent_id IN (SELECT id FROM chain))
      ORDER BY p.position, lower(p.title)`,
    [spaceId, pageId],
  );
  return buildTree(rows);
}

/* Дочерние страницы одной ветки — для подгрузки свёрнутых веток дерева. */
export function getChildNodes(pageId) {
  return many(
    `SELECT p.id, p.parent_id, p.title, p.position,
            (SELECT count(*)::int FROM pages c WHERE c.parent_id = p.id) AS child_count
       FROM pages p
      WHERE p.parent_id = $1
      ORDER BY p.position, lower(p.title)`,
    [pageId],
  ).then((rows) => rows.map((row) => ({ ...row, children: [] })));
}

/* Дерево ВСЕХ страниц пространства, отсортированное по position и названию.
 * Нужно редактору (список «Родительская страница»); для навигации — см.
 * getSpaceTreeAround. */
export async function getSpaceTree(spaceId) {
  const rows = await many(
    `SELECT id, parent_id, title, position
       FROM pages
      WHERE space_id = $1
      ORDER BY position, lower(title)`,
    [spaceId],
  );
  return buildTree(rows);
}

/* ----------------------------------------------------------------------------
 * getAncestors — цепочка родителей страницы от корня к ближайшему родителю.
 * Рекурсивный CTE: стартуем со страницы и «поднимаемся» по parent_id.
 * depth < 100 — защита от бесконечного цикла при повреждённых данных.
 * ------------------------------------------------------------------------- */
export function getAncestors(pageId) {
  return many(
    `WITH RECURSIVE chain AS (
        SELECT id, parent_id, title, 0 AS depth FROM pages WHERE id = $1
        UNION ALL
        SELECT p.id, p.parent_id, p.title, c.depth + 1
          FROM pages p JOIN chain c ON p.id = c.parent_id
         WHERE c.depth < 100
     )
     SELECT id, title FROM chain WHERE id <> $1 ORDER BY depth DESC`,
    [pageId],
  );
}

/* ----------------------------------------------------------------------------
 * isDescendant — является ли candidateId потомком pageId (на любой глубине).
 * Используется при смене родителя: если сделать страницу дочерней своему же
 * потомку, получится цикл и страницы «выпадут» из дерева.
 * UNION (а не UNION ALL) отбрасывает повторы и гарантирует завершение.
 * ------------------------------------------------------------------------- */
export async function isDescendant(pageId, candidateId) {
  const row = await one(
    `WITH RECURSIVE sub AS (
        SELECT id FROM pages WHERE parent_id = $1
        UNION
        SELECT p.id FROM pages p JOIN sub s ON p.parent_id = s.id
     )
     SELECT 1 AS found FROM sub WHERE id = $2`,
    [pageId, candidateId],
  );
  return Boolean(row);
}

/* ----------------------------------------------------------------------------
 * Метки. Пользователь вводит их через запятую или пробел: "api, backend".
 * Нормализуем: нижний регистр, только буквы/цифры/-/_, до 50 символов,
 * без повторов, не более 20 меток на страницу.
 * ------------------------------------------------------------------------- */
export function parseLabels(input) {
  const labels = String(input ?? '')
    .split(/[,\s]+/)
    .map((l) => l.trim().toLowerCase().replace(/^#/, '').replace(/[^\p{L}\p{N}_-]/gu, '').slice(0, 50))
    .filter(Boolean);
  return [...new Set(labels)].slice(0, 20);
}

/* ----------------------------------------------------------------------------
 * setPageLabels — заменить метки страницы новым набором (внутри транзакции).
 *   1. удаляем старые связи страницы с метками;
 *   2. для каждой метки: создаём, если её ещё нет (UPSERT), и связываем;
 *   3. удаляем «осиротевшие» метки, которые больше ни к чему не привязаны.
 * db — клиент транзакции из transaction().
 * ------------------------------------------------------------------------- */
export async function setPageLabels(db, pageId, labels) {
  await db.query('DELETE FROM page_labels WHERE page_id = $1', [pageId]);
  for (const name of labels) {
    const { rows: [label] } = await db.query(
      `INSERT INTO labels (name) VALUES ($1)
       ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [name],
    );
    await db.query(
      'INSERT INTO page_labels (page_id, label_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [pageId, label.id],
    );
  }
  await db.query(
    'DELETE FROM labels l WHERE NOT EXISTS (SELECT 1 FROM page_labels pl WHERE pl.label_id = l.id)',
  );
}

/* ----------------------------------------------------------------------------
 * linkAttachments — привязать к странице файлы, загруженные в редакторе
 * ДО первого сохранения (у них page_id ещё NULL). Привязываем только файлы
 * текущего пользователя — чужие «бесхозные» вложения не трогаем.
 * ids приходят из скрытого поля формы в виде "12,13,14".
 * ------------------------------------------------------------------------- */
export async function linkAttachments(db, pageId, idsInput, userId) {
  const ids = String(idsInput ?? '')
    .split(',')
    .map((s) => Number.parseInt(s, 10))
    .filter((n) => Number.isInteger(n) && n > 0);
  if (!ids.length) return;
  await db.query(
    `UPDATE attachments SET page_id = $1
      WHERE id = ANY($2::int[]) AND uploaded_by = $3 AND page_id IS NULL`,
    [pageId, ids, userId],
  );
}

/* Максимальная длина текста страницы в символах (≈ 500 страниц А4). */
export const MAX_CONTENT_LENGTH = 1_000_000;

/* ----------------------------------------------------------------------------
 * readPageForm — извлечение и проверка полей формы редактора.
 * Возвращает { form, errors }. form содержит нормализованные значения,
 * которые можно и сохранить в БД, и вернуть обратно в форму при ошибке.
 *
 * Важно: браузер присылает переводы строк из <textarea> как \r\n —
 * приводим к \n, иначе сравнение версий покажет «изменения» в каждой строке.
 * ------------------------------------------------------------------------- */
export function readPageForm(body) {
  const parentId = Number.parseInt(body.parent_id, 10);
  const position = Number.parseInt(body.position, 10);
  const form = {
    title: String(body.title ?? '').trim(),
    content: String(body.content ?? '').replace(/\r\n?/g, '\n'),
    parent_id: Number.isInteger(parentId) && parentId > 0 ? parentId : null,
    position: Number.isInteger(position) ? Math.max(-100000, Math.min(100000, position)) : 0,
    labels: parseLabels(body.labels).join(', '),
    change_note: String(body.change_note ?? '').trim().slice(0, 500),
  };
  const errors = [];
  if (!form.title) errors.push('Заголовок страницы обязателен');
  if (form.title.length > 300) errors.push('Заголовок слишком длинный (максимум 300 символов)');
  /* 1 млн символов ≈ 500 страниц А4. Больше — уже не статья: такой текст
   * отрисовывается секунды и не помещается в лимит формы (см. app.js). */
  if (form.content.length > MAX_CONTENT_LENGTH) errors.push('Текст страницы слишком большой (максимум 1 000 000 символов — разделите его на несколько страниц)');
  return { form, errors };
}
