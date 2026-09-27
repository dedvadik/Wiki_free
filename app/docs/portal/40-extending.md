Пошаговые рецепты типовых доработок. В каждом указано, какие файлы трогать.

[[toc]]

## Новая настройка сайта

1. Добавьте объект в `SETTINGS_SCHEMA` (`src/services/settings.js`):
   ```javascript
   { tab: 'general', group: 'Общие', key: 'support_email', label: 'Email поддержки',
     type: 'text', default: '', help: 'Показывается в подвале.' },
   ```
2. Используйте в любом шаблоне: `<%= site.support_email %>`.

Поле появится в **Администрирование → Общие**, пройдёт проверку по типу, а значение по умолчанию можно будет задать переменной `SETTING_SUPPORT_EMAIL`.

## Новый раздел администрирования

1. Добавьте раздел в `SETTINGS_SECTIONS` (`src/routes/admin.js`): `notify: { title: 'Уведомления', icon: 'mail', description: '…' }`.
2. Укажите `tab: 'notify'` у нужных полей схемы.
3. Добавьте пункт меню в `views/partials/settings-nav.ejs` (массив для `area === 'admin'`).

Маршруты `/admin/settings/:section` и шаблон подхватят раздел сами.

## Изменение схемы базы данных

1. Создайте `src/db/migrations/004_описание.sql` (старые файлы не меняйте):
   ```sql
   ALTER TABLE pages ADD COLUMN is_pinned BOOLEAN NOT NULL DEFAULT FALSE;
   ```
2. Перезапустите приложение: миграция применится одной транзакцией.

## Новая страница сайта (маршрут + шаблон)

1. Добавьте обработчик в подходящий роутер (`src/routes/*.js`) или создайте новый и подключите его в `src/app.js` **после** `siteAccess`, если страница не должна быть публичной в закрытой вики:
   ```javascript
   homeRouter.get('/about', (req, res) => res.render('about', { title: 'О портале' }));
   ```
2. Создайте `views/about.ejs`:
   ```ejs
   <%- include('/partials/header', { title }) %>
   <div class="narrow"><div class="card"><h1>О портале</h1></div></div>
   <%- include('/partials/footer') %>
   ```
3. Для изменяющих запросов используйте `POST`, скрытое поле `_csrf`, проверку прав (`requireRole`) и схему «POST → Redirect → GET».

## Новый макрос разметки

1. В `src/services/markdown.js` создайте расширение по образцу `statusExtension`: `name`, `level` (`'block'` или `'inline'`), `start`, `tokenizer`, `renderer`.
2. Добавьте его в массив `extensions` при создании `new Marked(...)`.
3. Если макрос выводит новые теги или атрибуты, разрешите их в `SANITIZE_OPTIONS`, иначе очистка их удалит.
4. Стили — в `public/css/app.css`; кнопка в редакторе — см. следующий рецепт.

## Новая кнопка в редакторе

1. `views/pages/form.ejs`: `<button type="button" data-md="kbd" title="Клавиша">⌨</button>`.
2. `public/js/editor.js`, объект `ACTIONS`: `kbd: () => wrap('<kbd>', '</kbd>', 'Ctrl')`.

## Своя тема оформления

1. Создайте `custom/public/themes/my-theme/theme.json`:
   ```json
   { "name": "Моя тема", "description": "…",
     "preview": { "bg": "#fff", "header": "#111", "headerText": "#fff", "accent": "#e60023", "radius": 8 } }
   ```
2. Рядом — `theme.css`, где переопределены переменные для обоих режимов:
   ```css
   :root { --primary: #e60023; --header-bg: #111; --header-text: #fff; }
   :root[data-mode="dark"] { --bg: #0b0b0b; --surface: #161616; }
   ```
3. `docker compose restart app` — тема появится в **Администрирование → Оформление** и **Настройки → Оформление**.

Подробности и полный список переменных — `public/themes/README.md` и страница [Стили и темы оформления](page:Стили и темы оформления).

## Замена куска интерфейса

Скопируйте нужный шаблон из `views/` в `custom/views/` с тем же путём (например, `partials/footer.ejs`), отредактируйте копию и перезапустите приложение. Для мелких правок стилей хватит поля «Собственный CSS» в админке, для своих скриптов — `custom/public/custom.js`.

## Новая роль

1. `src/services/users.js`: добавьте роль в `ROLE_LEVEL` и `ROLE_NAMES`.
2. Новая миграция с изменённым `CHECK` для `users.role`.
3. Используйте `requireRole('moderator')` в маршрутах и `can('moderator')` в шаблонах.

## Новая иконка

Добавьте в объект `ICONS` (`src/utils/icons.js`) содержимое SVG для `viewBox="0 0 24 24"` и используйте `<%- icon('имя') %>`.

## Новая страница этой документации

1. Создайте `docs/portal/NN-название.md`.
2. Добавьте её в дерево `docs/portal/manifest.json`: `{ "title": "…", "file": "NN-название.md", "labels": ["…"] }`.
3. Ссылайтесь на другие страницы как `[текст](page:Точный заголовок)`.
4. `docker compose exec app npm run docs:import`. Изменившиеся страницы получат новую версию, остальные не изменятся.

## Проверка изменений

- Быстрая проверка: `docker compose up -d --build`, затем `GET /healthz`.
- Сквозная проверка в духе тех, что прогонялись при разработке: `curl` с cookie-файлом по основным сценариям (вход, создание, правка, история, поиск, права). CSRF-токен берётся из скрытого поля `_csrf` на странице формы.
- Для запросов с кириллицей из Windows запускайте `curl` в Linux-контейнере: Git Bash отправляет аргументы в кодировке CP1251.
