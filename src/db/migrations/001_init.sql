-- ============================================================================
--  001_init.sql — начальная схема базы данных
-- ============================================================================
--  Модель данных повторяет идею Confluence:
--    users          — пользователи и их роли
--    spaces         — пространства (разделы базы знаний, например "DEV", "HR")
--    pages          — страницы-статьи, образуют ДЕРЕВО внутри пространства
--    page_versions  — полная история изменений каждой страницы
--    labels         — метки (теги) и связь с страницами page_labels
--    comments       — комментарии к страницам
--    attachments    — вложения (картинки, файлы)
--    favorites      — избранные страницы пользователя
--    settings       — настройки сайта (key-value), редактируются в админке
--    session        — хранилище HTTP-сессий (для connect-pg-simple)
-- ============================================================================


-- ----------------------------------------------------------------------------
-- Пользователи.
-- role: admin  — полный доступ, настройки сайта, управление пользователями
--       editor — создание и редактирование пространств и страниц
--       viewer — только чтение и комментарии
-- is_active = false — учётная запись заблокирована (вход запрещён).
-- Пароль хранится только в виде bcrypt-хеша, никогда в открытом виде.
-- ----------------------------------------------------------------------------
CREATE TABLE users (
  id             SERIAL PRIMARY KEY,
  username       VARCHAR(50)  NOT NULL,
  email          VARCHAR(255) NOT NULL,
  display_name   VARCHAR(100) NOT NULL,
  password_hash  TEXT         NOT NULL,
  role           VARCHAR(20)  NOT NULL DEFAULT 'viewer'
                 CHECK (role IN ('admin', 'editor', 'viewer')),
  is_active      BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  last_login_at  TIMESTAMPTZ
);

-- Уникальность логина и почты БЕЗ учёта регистра: "Ivan" и "ivan" — один логин.
CREATE UNIQUE INDEX users_username_lower_idx ON users (lower(username));
CREATE UNIQUE INDEX users_email_lower_idx    ON users (lower(email));


-- ----------------------------------------------------------------------------
-- Пространства. key — короткий уникальный код (как в Confluence: "DOCS"),
-- используется в URL: /spaces/DOCS. icon — эмодзи, color — цвет плашки.
-- ----------------------------------------------------------------------------
CREATE TABLE spaces (
  id           SERIAL PRIMARY KEY,
  key          VARCHAR(20)  NOT NULL UNIQUE,
  name         VARCHAR(200) NOT NULL,
  description  TEXT         NOT NULL DEFAULT '',
  icon         VARCHAR(32)  NOT NULL DEFAULT '📘',
  color        VARCHAR(7)   NOT NULL DEFAULT '#0052cc',
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);


-- ----------------------------------------------------------------------------
-- Страницы. parent_id ссылается на родительскую страницу того же
-- пространства — так строится дерево (как в боковой панели Confluence).
-- NULL в parent_id означает страницу верхнего уровня.
--
-- version — номер текущей версии; используется для «оптимистичной
-- блокировки»: если двое редактируют страницу одновременно, второй
-- сохраняющий увидит предупреждение о конфликте, а не молча затрёт правки.
--
-- search_vector — ГЕНЕРИРУЕМАЯ колонка для полнотекстового поиска.
-- PostgreSQL сам пересчитывает её при каждом изменении title/content.
-- Заголовку дан вес 'A' (важнее), тексту — 'B'. Конфигурация 'russian'
-- приводит слова к основе (морфология): «статьи» найдётся по запросу «статья».
-- Латинские слова обрабатываются английским стеммером.
-- ----------------------------------------------------------------------------
CREATE TABLE pages (
  id          SERIAL PRIMARY KEY,
  space_id    INTEGER      NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  parent_id   INTEGER      REFERENCES pages(id) ON DELETE SET NULL,
  title       VARCHAR(300) NOT NULL,
  content     TEXT         NOT NULL DEFAULT '',
  position    INTEGER      NOT NULL DEFAULT 0,
  version     INTEGER      NOT NULL DEFAULT 1,
  created_by  INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  updated_by  INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  search_vector tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('russian', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('russian', coalesce(content, '')), 'B')
  ) STORED
);

-- Индекс для быстрого построения дерева и списков страниц пространства.
CREATE INDEX pages_tree_idx    ON pages (space_id, parent_id, position);
-- Индекс для ленты «недавно обновлённые».
CREATE INDEX pages_updated_idx ON pages (updated_at DESC);
-- GIN-индекс — делает полнотекстовый поиск быстрым даже на тысячах страниц.
CREATE INDEX pages_search_idx  ON pages USING GIN (search_vector);


-- ----------------------------------------------------------------------------
-- История версий. При каждом сохранении страницы сюда пишется ПОЛНЫЙ снимок
-- заголовка и текста. Это позволяет просмотреть любую старую версию,
-- сравнить две версии (diff) и откатиться.
-- ----------------------------------------------------------------------------
CREATE TABLE page_versions (
  id           SERIAL PRIMARY KEY,
  page_id      INTEGER      NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  version      INTEGER      NOT NULL,
  title        VARCHAR(300) NOT NULL,
  content      TEXT         NOT NULL,
  change_note  VARCHAR(500) NOT NULL DEFAULT '',
  author_id    INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (page_id, version)
);


-- ----------------------------------------------------------------------------
-- Метки (теги). Связь «многие ко многим» через page_labels.
-- ----------------------------------------------------------------------------
CREATE TABLE labels (
  id    SERIAL PRIMARY KEY,
  name  VARCHAR(50) NOT NULL UNIQUE
);

CREATE TABLE page_labels (
  page_id   INTEGER NOT NULL REFERENCES pages(id)  ON DELETE CASCADE,
  label_id  INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  PRIMARY KEY (page_id, label_id)
);

CREATE INDEX page_labels_label_idx ON page_labels (label_id);


-- ----------------------------------------------------------------------------
-- Комментарии к страницам (текст в формате Markdown).
-- ----------------------------------------------------------------------------
CREATE TABLE comments (
  id          SERIAL PRIMARY KEY,
  page_id     INTEGER     NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  author_id   INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  content     TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX comments_page_idx ON comments (page_id, created_at);


-- ----------------------------------------------------------------------------
-- Вложения. Сам файл лежит на диске (в volume), здесь — метаданные.
-- stored_name — случайное имя файла на диске (UUID), original_name — имя,
-- которое видел пользователь. page_id может быть NULL: файл загружен при
-- создании ещё не сохранённой страницы, либо страница была удалена
-- (ссылки на файл из других статей при этом продолжают работать).
-- ----------------------------------------------------------------------------
CREATE TABLE attachments (
  id             SERIAL PRIMARY KEY,
  page_id        INTEGER      REFERENCES pages(id) ON DELETE SET NULL,
  stored_name    VARCHAR(255) NOT NULL UNIQUE,
  original_name  VARCHAR(255) NOT NULL,
  mime_type      VARCHAR(150) NOT NULL DEFAULT 'application/octet-stream',
  size_bytes     INTEGER      NOT NULL DEFAULT 0,
  uploaded_by    INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX attachments_page_idx ON attachments (page_id);


-- ----------------------------------------------------------------------------
-- Избранное: пользователь «отмечает звёздочкой» страницы, они выводятся
-- на главной.
-- ----------------------------------------------------------------------------
CREATE TABLE favorites (
  user_id     INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  page_id     INTEGER     NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, page_id)
);


-- ----------------------------------------------------------------------------
-- Настройки сайта: пары ключ → значение (значение сериализовано в JSON,
-- чтобы сохранять тип: строка, число, boolean). Список допустимых ключей и
-- значения по умолчанию описаны в коде: src/services/settings.js.
-- ----------------------------------------------------------------------------
CREATE TABLE settings (
  key         VARCHAR(100) PRIMARY KEY,
  value       TEXT         NOT NULL,
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);


-- ----------------------------------------------------------------------------
-- Таблица сессий в формате, который ожидает библиотека connect-pg-simple.
-- Хранение сессий в БД (а не в памяти процесса) означает, что пользователи
-- не «вылетают» при перезапуске контейнера.
-- ----------------------------------------------------------------------------
CREATE TABLE "session" (
  "sid"    VARCHAR      NOT NULL COLLATE "default" PRIMARY KEY,
  "sess"   JSON         NOT NULL,
  "expire" TIMESTAMP(6) NOT NULL
);

CREATE INDEX "IDX_session_expire" ON "session" ("expire");
