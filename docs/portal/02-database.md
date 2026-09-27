Всё хранится в PostgreSQL: пользователи, пространства, страницы с историей версий, метки, комментарии, метаданные вложений, настройки и HTTP-сессии. Сами файлы вложений лежат на диске (volume `app-data`).

[[toc]]

## Подключение: src/db/pool.js

Используется пул соединений из драйвера `pg`. Он держит несколько открытых соединений и раздаёт их запросам. Помощники:

| Функция | Возвращает | Пример |
| --- | --- | --- |
| `query(sql, params)` | полный результат (`rows`, `rowCount`) | удаление с проверкой `rowCount` |
| `many(sql, params)` | массив строк | списки |
| `one(sql, params)` | первую строку или `null` | загрузка по id |
| `transaction(async (db) => …)` | результат функции | несколько запросов атомарно |
| `waitForDatabase()` | — | ожидание БД при старте |

```javascript
// Страница и её первая версия — вместе или никак.
const pageId = await transaction(async (db) => {
  const { rows: [page] } = await db.query('INSERT INTO pages (...) VALUES (...) RETURNING id', [...]);
  await db.query('INSERT INTO page_versions (...) VALUES (...)', [page.id, ...]);
  return page.id;
});
```

:::warning Только параметризованные запросы
Значения всегда передаются отдельно (`$1`, `$2`…), текст SQL никогда не склеивается со строками пользователя. Это полностью исключает SQL-инъекции.
:::

## Миграции: src/db/migrate.js

Миграция — это SQL-файл `src/db/migrations/NNN_описание.sql`. При старте сервера `runMigrations()`:

1. берёт advisory-блокировку PostgreSQL (`pg_advisory_lock`), чтобы две копии приложения не применяли миграции одновременно;
2. создаёт таблицу `schema_migrations`, если её нет;
3. применяет по порядку имён файлы, которых нет в `schema_migrations`, **каждый в своей транзакции**: DDL в PostgreSQL транзакционный, поэтому миграция применяется целиком или не применяется вовсе.

Отдельный запуск: `npm run migrate`. **Старые миграции не редактируются**: изменения схемы всегда оформляются новым файлом со следующим номером.

| Файл | Что делает |
| --- | --- |
| `001_init.sql` | вся начальная схема (ниже) |
| `002_ldap.sql` | `users.auth_source` (`local`/`ldap`), `users.ldap_dn`, пароль становится необязательным, уникальный индекс по DN |
| `003_themes.sql` | `users.theme` — выбранная пользователем тема; удаление сохранённых старых умолчаний цветов, чтобы они не перекрывали новые темы |
| `004_space_permissions.sql` | права на пространства: `spaces.owner_id`, `visibility`, `edit_policy`, таблица `space_members`; существующие пространства остаются открытыми |
| `005_performance.sql` | индексы по итогам нагрузочного тестирования: `pages_parent_idx` и триграммный `pages_title_trgm_idx` (расширение `pg_trgm`; если прав на него нет, миграция не падает) |

## Схема

```text
users ─┬─< spaces.created_by
       ├─< pages.created_by / updated_by
       ├─< page_versions.author_id
       ├─< comments.author_id
       ├─< attachments.uploaded_by
       └─< favorites.user_id ──> pages

spaces ──< pages ──< page_versions
             │  ├──< comments
             │  ├──< attachments
             │  ├──< page_labels >── labels
             │  └──< favorites
             └── parent_id ──> pages (дерево)

settings (key → JSON)        session (HTTP-сессии)        schema_migrations
```

| Таблица | Назначение | Ключевые поля |
| --- | --- | --- |
| `users` | учётные записи | `username`, `email` (уникальны без учёта регистра), `password_hash` (bcrypt, NULL у LDAP), `role` (`admin`/`editor`/`viewer`), `is_active`, `auth_source`, `ldap_dn`, `theme` |
| `spaces` | пространства | `key` (уникальный код, в URL), `name`, `description` (Markdown), `icon`, `color`, `owner_id`, `visibility` (`public`/`restricted`), `edit_policy` (`editors`/`members`) |
| `space_members` | участники пространств | первичный ключ `(space_id, user_id)`, `access` (`read`/`edit`), `added_by` |
| `pages` | статьи, образуют дерево | `space_id`, `parent_id`, `title`, `content`, `position`, `version`, `search_vector` |
| `page_versions` | полная история | `page_id`, `version` (уникальны вместе), снимок `title` и `content`, `change_note`, `author_id` |
| `labels`, `page_labels` | метки | связь «многие ко многим» |
| `comments` | комментарии | `page_id`, `author_id`, `content` (Markdown) |
| `attachments` | метаданные файлов | `stored_name` (UUID на диске), `original_name`, `mime_type`, `size_bytes`, `page_id` |
| `favorites` | избранное | первичный ключ `(user_id, page_id)` |
| `settings` | настройки сайта | `key`, `value` — значение в JSON, чтобы сохранить тип |
| `session` | HTTP-сессии | формат `connect-pg-simple`: `sid`, `sess` (JSON с `userId`), `expire` |

### Что происходит при удалении

| Удаляем | Последствия | Правило в схеме |
| --- | --- | --- |
| пользователя | его статьи, версии, комментарии, вложения остаются, автор = NULL («удалённый пользователь»); избранное и участие в пространствах удаляются; у его пространств владелец = NULL (управляют администраторы) | `ON DELETE SET NULL` / `CASCADE` |
| пространство | удаляются все его страницы, их версии, комментарии, связи с метками, участники | `ON DELETE CASCADE` |
| страницу | удаляются версии, комментарии, избранное; вложения остаются «ничьими» | `CASCADE` / `SET NULL` |
| родительскую страницу | дочерние перевешиваются на деда (в коде) или удаляются вместе с ней (по флажку) | см. [Статьи: разметка, дерево, версии, поиск](page:Статьи: разметка, дерево, версии, поиск) |

## Полнотекстовый поиск

В `pages` есть **генерируемая колонка**: PostgreSQL сам пересчитывает её при каждом изменении страницы.

```sql
search_vector tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('russian', coalesce(title, '')), 'A') ||
  setweight(to_tsvector('russian', coalesce(content, '')), 'B')
) STORED
```

- Конфигурация `russian` приводит слова к основе: запрос «статьи» найдёт «статья». Латиница обрабатывается английским стеммером.
- Вес `A` у заголовка выше, чем `B` у текста, поэтому совпадения в заголовке поднимаются выше.
- GIN-индекс `pages_search_idx` делает поиск быстрым и на тысячах страниц.

Сам запрос поиска разобран на странице [Статьи: разметка, дерево, версии, поиск](page:Статьи: разметка, дерево, версии, поиск).

## Индексы

| Индекс | Для чего |
| --- | --- |
| `pages_tree_idx (space_id, parent_id, position)` | построение дерева страниц пространства |
| `pages_updated_idx (updated_at DESC)` | лента «Недавние изменения» |
| `pages_search_idx GIN (search_vector)` | полнотекстовый поиск |
| `pages_parent_idx (parent_id)` | дочерние страницы и признак «есть дочерние» в дереве навигации |
| `pages_title_trgm_idx GIN (title gin_trgm_ops)` | поиск подстроки в заголовке (`ILIKE '%…%'`) |
| `users_*_lower_idx` | уникальность логина и email без учёта регистра |
| `users_ldap_dn_idx` (частичный) | один DN — одна учётная запись |
| `page_labels_label_idx`, `comments_page_idx`, `attachments_page_idx` | выборки по связям |
| `IDX_session_expire` | очистка истёкших сессий |

## Рекурсивные запросы

Дерево страниц хранится через `parent_id`, поэтому цепочки родителей и потомков получаются рекурсивными CTE (функции в `src/services/pages.js`):

```sql
-- Предки страницы (для хлебных крошек); depth < 100 защищает от циклов.
WITH RECURSIVE chain AS (
  SELECT id, parent_id, title, 0 AS depth FROM pages WHERE id = $1
  UNION ALL
  SELECT p.id, p.parent_id, p.title, c.depth + 1
    FROM pages p JOIN chain c ON p.id = c.parent_id
   WHERE c.depth < 100
)
SELECT id, title FROM chain WHERE id <> $1 ORDER BY depth DESC;
```
