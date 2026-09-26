Шаблоны лежат в `views/`. Шаблонизатор — EJS: обычный HTML со вставками JavaScript.

[[toc]]

## Синтаксис, который используется в проекте

| Конструкция | Что делает | Где применять |
| --- | --- | --- |
| `<%= выражение %>` | вывод **с экранированием** HTML | всегда для данных пользователя |
| `<%- выражение %>` | вывод **без экранирования** | только для уже безопасного HTML: результат `renderMarkdown`, `include`, `icon()` |
| `<% код %>` | JavaScript без вывода | условия, циклы |
| `<%# комментарий %>` | комментарий, в HTML не попадает | описание блоков |

:::warning Ловушка в комментариях
Внутри `<%# … %>` нельзя писать `<%-` или `%>`: парсер EJS увидит там начало или конец тега. На этом однажды сломалась главная страница.
:::

## Каркас страницы

```ejs
<%- include('/partials/header', { title: 'Заголовок вкладки' }) %>

<div class="container"> … содержимое … </div>

<%- include('/partials/footer', { scripts: ['/js/editor.js'] }) %>
```

`header.ejs` открывает `<main>`, `footer.ejs` закрывает его и подключает скрипты.

## Переопределение шаблонов из custom/views

В `app.js` поиск шаблонов настроен на две папки по порядку — `custom/views`, затем `views`:

```javascript
const viewDirs = [path.join(config.customDir, 'views'), config.viewsDir];
app.set('views', viewDirs);                  // для res.render('pages/show')
app.set('view options', { root: viewDirs }); // для include('/partials/…')
```

Все `include` в проекте пишутся с **ведущим слэшем** (`/partials/header`), поэтому ищутся по массиву `root`. Чтобы заменить любой шаблон или его кусок, достаточно положить файл с тем же путём в `custom/views/` и перезапустить приложение. Пример лежит в `custom/examples/footer.ejs`.

## Partials

| Файл | Параметры | Назначение |
| --- | --- | --- |
| `header.ejs` | `title`, `bodyClass`, `createUrl` | `<head>`, стили, шапка, меню пользователя, баннеры, уведомления |
| `footer.ejs` | `scripts` | подвал и скрипты |
| `errors.ejs` | `errors` | список ошибок формы |
| `page-tree.ejs` | `nodes`, `currentPageId`, `openIds` | **рекурсивное** дерево страниц на `<details>` (вызывает сам себя) |
| `space-sidebar.ejs` | `space`, `tree`, … | левая панель пространства |
| `settings-nav.ejs` | `area` (`user`/`admin`), `active` | меню разделов настроек и администрирования |
| `settings-groups.ejs` | `groups`, `values`, `presets`, `themes`, `secretsSet` | поля настроек, построенные по схеме (переключатели, палитры, выбор темы) |
| `theme-picker.ejs` | `name`, `selected`, `themes`, `defaultOption` | карточки тем с мини-превью |

### Как устроен settings-nav

Пункты меню — массивы объектов прямо в шаблоне:

```javascript
{ key: 'access', href: '/admin/settings/access', icon: 'lock', tile: '#ff9500', label: 'Доступ и права' }
```

Цвет плитки передаётся CSS-переменной `style="--tile: #ff9500"`, иконка — `icon('lock')`. Активный пункт выбирается по параметру `active`.

## Переменные, доступные везде

`site` (настройки), `currentUser`, `can(role)`, `csrfToken()`, `activeTheme`, помощники форматирования и другие. Полный список — на странице [Middleware](page:Middleware).

:::note Не называйте переменную `settings`
Это имя зарезервировано Express, см. [Запуск и обработка запроса](page:Запуск и обработка запроса).
:::

## Иконки

`<%- icon('settings') %>` вставляет встроенный SVG из `src/utils/icons.js` (контурный стиль в духе Feather Icons, MIT). Цвет берётся от текста (`stroke="currentColor"`), размер — `1em`. Доступны `user`, `users`, `settings`, `sliders`, `shield`, `lock`, `droplet`, `globe`, `server`, `bar-chart`, `log-out`, `mail`, `calendar`, `clock`, `file-text`, `edit`, `message`, `star`, `key`, `monitor`, `sun`, `moon`, `layout`, `folder`, `paperclip`, `database`, `cpu`, `chevron-right`, `arrow-left`, `check`.

## Цвет аватара

У каждого пользователя свой цвет: `style="--avatar-h: <%= avatarHue(name) %>"`. Оттенок стабильно вычисляется из имени, а CSS рисует градиент `hsl(var(--avatar-h) …)`.
