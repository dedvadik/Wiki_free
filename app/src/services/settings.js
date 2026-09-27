/**
 * ============================================================================
 *  services/settings.js — настройки сайта, редактируемые в админ-панели
 * ============================================================================
 *  Это главный механизм «мягкой» кастомизации без правки кода.
 *
 *  Как это устроено:
 *   1. SETTINGS_SCHEMA — декларативное описание ВСЕХ настроек: ключ, тип,
 *      подпись, группа, значение по умолчанию. Страница /admin/settings
 *      строится АВТОМАТИЧЕСКИ по этой схеме. Чтобы добавить новую настройку,
 *      достаточно дописать объект в массив — поле само появится в админке,
 *      а значение будет доступно во всех шаблонах как site.<ключ>.
 *   2. Значения хранятся в таблице settings (JSON-строка на ключ).
 *   3. При старте все значения загружаются в кэш в памяти, поэтому чтение
 *      настроек на каждом запросе ничего не стоит. При сохранении из
 *      админки кэш обновляется.
 *   4. Значение по умолчанию можно переопределить переменной окружения
 *      SETTING_<КЛЮЧ_В_ВЕРХНЕМ_РЕГИСТРЕ>, например SETTING_SITE_NAME="Wiki".
 *      Это удобно для автоматического развёртывания (infrastructure as code).
 *
 *  Замечание: кэш живёт в памяти процесса. Если запускать несколько копий
 *  приложения за балансировщиком, после изменения настроек перезапустите
 *  остальные копии (или добавьте периодическую перезагрузку кэша).
 * ============================================================================
 */
import crypto from 'node:crypto';
import { many, transaction } from '../db/pool.js';
import { hasTheme } from './themes.js';

/* ----------------------------------------------------------------------------
 * Готовые наборы шрифтов (стеки font-family). Используются типом "select"
 * настройки font_family и генератором theme.css. Шрифты системные — сайт
 * не зависит от внешних CDN и работает в закрытой сети.
 * ------------------------------------------------------------------------- */
export const FONT_STACKS = {
  system: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif',
  apple: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "Helvetica Neue", "Segoe UI", Roboto, sans-serif',
  humanist: '"Segoe UI", Candara, "Bitstream Vera Sans", "DejaVu Sans", "Trebuchet MS", Verdana, sans-serif',
  serif: 'Georgia, Cambria, "Times New Roman", Times, serif',
  mono: 'ui-monospace, "Cascadia Code", "JetBrains Mono", Menlo, Consolas, monospace',
};

/* Ширина колонки с текстом статьи. */
export const CONTENT_WIDTHS = {
  narrow: '760px',
  normal: '960px',
  wide: '1200px',
  full: 'none',
};

/* ----------------------------------------------------------------------------
 * Цветовые пресеты: кнопки в админке, которые одним кликом заполняют поля
 * цветов (они применяются поверх выбранной темы). Первый пресет очищает
 * поля — тогда действуют цвета самой темы. Добавьте свой пресет — он
 * появится в интерфейсе.
 * ------------------------------------------------------------------------- */
export const THEME_PRESETS = [
  { name: 'Цвета темы', values: { primary_color: '', header_bg: '', header_text: '' } },
  { name: 'Confluence', values: { primary_color: '#0052cc', header_bg: '#0747a6', header_text: '#ffffff' } },
  { name: 'Лес', values: { primary_color: '#2f855a', header_bg: '#22543d', header_text: '#ffffff' } },
  { name: 'Виноград', values: { primary_color: '#6b46c1', header_bg: '#44337a', header_text: '#ffffff' } },
  { name: 'Закат', values: { primary_color: '#dd6b20', header_bg: '#7b341e', header_text: '#ffffff' } },
  { name: 'Графит', values: { primary_color: '#3182ce', header_bg: '#1a202c', header_text: '#e2e8f0' } },
  { name: 'Минимализм', values: { primary_color: '#0052cc', header_bg: '#ffffff', header_text: '#172b4d' } },
];

/* ----------------------------------------------------------------------------
 * СХЕМА НАСТРОЕК.
 * Поля объекта:
 *   key      — имя настройки (в шаблонах: site.key)
 *   tab      — раздел администрирования, на странице которого показано поле:
 *              'general' (по умолчанию, «Общие»), 'access' («Доступ и права»),
 *              'appearance' («Оформление»), 'ldap' («LDAP»). Каждый раздел —
 *              отдельная страница и сохраняет только свои поля.
 *   group    — заголовок блока на странице админки
 *   label    — подпись поля
 *   type     — text | textarea | markdown | code | url | bool | color | select
 *              | number | secret | theme
 *   default  — значение по умолчанию
 *   options  — для select: массив [значение, подпись]
 *   min/max  — для number: допустимый диапазон
 *   optional — для color/number: разрешено пустое значение («как в теме»)
 *   help     — подсказка под полем
 *
 * Тип secret (пароли): значение НИКОГДА не попадает в шаблоны и HTML — в
 * форме показывается только «сохранён / не задан», а пустое поле при
 * сохранении означает «оставить как есть».
 * ------------------------------------------------------------------------- */
export const SETTINGS_SCHEMA = [
  /* ---- Общие ---- */
  { group: 'Общие', key: 'site_name', label: 'Название сайта', type: 'text', default: 'База знаний',
    help: 'Показывается в шапке и в заголовке вкладки браузера.' },
  { group: 'Общие', key: 'site_tagline', label: 'Подзаголовок', type: 'text', default: 'Документация и статьи команды' },
  { group: 'Общие', key: 'logo_url', label: 'URL логотипа', type: 'url', default: '',
    help: 'Путь (/uploads/…, /logo.png из custom/public) или https://… Пусто — стандартный логотип.' },
  { group: 'Общие', key: 'favicon_url', label: 'URL иконки вкладки (favicon)', type: 'url', default: '' },
  { group: 'Общие', key: 'welcome_markdown', label: 'Приветствие на главной (Markdown)', type: 'markdown',
    default: '## Добро пожаловать!\n\nЭто база знаний вашей команды. Создавайте **пространства** для разных направлений, наполняйте их **страницами** и связывайте их между собой.' },
  { group: 'Общие', key: 'announcement', label: 'Объявление (баннер под шапкой)', type: 'text', default: '',
    help: 'Пусто — баннер не показывается.' },
  { group: 'Общие', key: 'footer_text', label: 'Текст в подвале', type: 'text', default: 'Работает на WikiSpace' },

  /* ---- Доступ ---- */
  { tab: 'access', group: 'Доступ и права', key: 'require_login', label: 'Закрытая вики: читать могут только вошедшие пользователи', type: 'bool', default: false },
  { tab: 'access', group: 'Доступ и права', key: 'allow_registration', label: 'Разрешить самостоятельную регистрацию', type: 'bool', default: true,
    help: 'Если выключено, новых пользователей добавляет администратор.' },
  { tab: 'access', group: 'Доступ и права', key: 'default_role', label: 'Роль новых пользователей', type: 'select', default: 'editor',
    options: [['viewer', 'Читатель — только просмотр и комментарии'], ['editor', 'Редактор — может создавать и править страницы']] },
  { tab: 'access', group: 'Доступ и права', key: 'allow_comments', label: 'Разрешить комментарии к страницам', type: 'bool', default: true },

  /* ---- Тема оформления ----
   * Список тем берётся из src/services/themes.js (папки public/themes и
   * custom/public/themes), поэтому у поля свой тип 'theme'. */
  { tab: 'appearance', group: 'Тема оформления', key: 'theme', label: 'Тема сайта по умолчанию', type: 'theme', default: 'classic' },
  { tab: 'appearance', group: 'Тема оформления', key: 'allow_user_themes', label: 'Пользователи могут выбрать свою тему в профиле', type: 'bool', default: true,
    help: 'Гости и пользователи, не выбравшие тему, видят тему сайта по умолчанию.' },
  /* Ключ исторически называется default_theme, но хранит РЕЖИМ (светлый/тёмный). */
  { tab: 'appearance', group: 'Тема оформления', key: 'default_theme', label: 'Цветовой режим по умолчанию', type: 'select', default: 'light',
    options: [['light', 'Светлый'], ['dark', 'Тёмный'], ['auto', 'Как в системе пользователя']],
    help: 'Каждый пользователь может переключить режим кнопкой ◐ в шапке. Все темы поддерживают оба режима.' },

  /* ---- Интерфейс ---- */
  { tab: 'appearance', group: 'Интерфейс', key: 'hide_caret', label: 'Мигающий текстовый курсор — только в редакторе страниц', type: 'bool', default: true,
    help: 'В остальных местах (поиск, вход, комментарии, настройки) мигающий курсор не отображается, а над текстом мышь показывает обычную стрелку. Активное поле по-прежнему выделяется рамкой.' },
  { tab: 'appearance', group: 'Интерфейс', key: 'default_editor', label: 'Редактор страниц по умолчанию', type: 'select', default: 'visual',
    options: [['visual', 'Визуальный — как в Word/Confluence'], ['markdown', 'Markdown — текстовая разметка']],
    help: 'Каждый пользователь может выбрать свой вариант в «Настройки → Оформление» или переключить прямо в редакторе.' },

  /* ---- Цвета и шрифты поверх темы ----
   * Поля с optional: true можно оставить пустыми — тогда действует значение
   * выбранной темы. Заполненное значение применяется поверх ЛЮБОЙ темы
   * (например, фирменный цвет компании). */
  { tab: 'appearance', group: 'Цвета и шрифты', key: 'primary_color', label: 'Основной цвет (ссылки, кнопки)', type: 'color', optional: true, default: '',
    help: 'Пусто — цвет выбранной темы.' },
  { tab: 'appearance', group: 'Цвета и шрифты', key: 'header_bg', label: 'Фон шапки', type: 'color', optional: true, default: '' },
  { tab: 'appearance', group: 'Цвета и шрифты', key: 'header_text', label: 'Цвет текста шапки', type: 'color', optional: true, default: '' },
  { tab: 'appearance', group: 'Цвета и шрифты', key: 'font_family', label: 'Шрифт', type: 'select', default: 'theme',
    options: [['theme', 'Как в теме'], ['system', 'Системный'], ['apple', 'Apple (SF Pro)'], ['humanist', 'Гуманистический'], ['serif', 'С засечками'], ['mono', 'Моноширинный']] },
  { tab: 'appearance', group: 'Цвета и шрифты', key: 'font_size', label: 'Размер шрифта статей (px)', type: 'number', default: 16, min: 12, max: 22 },
  { tab: 'appearance', group: 'Цвета и шрифты', key: 'content_width', label: 'Ширина текста статьи', type: 'select', default: 'normal',
    options: [['narrow', 'Узкая (760px)'], ['normal', 'Обычная (960px)'], ['wide', 'Широкая (1200px)'], ['full', 'Во всю ширину']] },
  { tab: 'appearance', group: 'Цвета и шрифты', key: 'sidebar_width', label: 'Ширина боковой панели (px)', type: 'number', default: 280, min: 200, max: 480 },
  { tab: 'appearance', group: 'Цвета и шрифты', key: 'border_radius', label: 'Скругление углов (px)', type: 'number', optional: true, default: '', min: 0, max: 24,
    help: 'Пусто — как в теме.' },
  { tab: 'appearance', group: 'Цвета и шрифты', key: 'custom_css', label: 'Собственный CSS', type: 'code', default: '',
    help: 'Подключается после всех стилей и тем. Можно адресовать конкретную тему: :root[data-ui-theme="icloud"] .topbar { … }' },

  /* ---- LDAP / Active Directory (отдельная вкладка админки) ----
   * Как работает вход через LDAP — см. src/services/ldap.js и src/services/auth.js. */
  { tab: 'ldap', group: 'Подключение к серверу', key: 'ldap_enabled', label: 'Включить вход через LDAP / Active Directory', type: 'bool', default: false },
  { tab: 'ldap', group: 'Подключение к серверу', key: 'ldap_url', label: 'Адрес сервера', type: 'text', default: 'ldap://ldap.example.com:389',
    pattern: /^ldaps?:\/\/[^\s/]+\/?$/i, patternError: 'адрес должен иметь вид ldap://хост:порт или ldaps://хост:порт',
    help: 'ldap://хост:389 — без шифрования или со STARTTLS; ldaps://хост:636 — TLS-соединение.' },
  { tab: 'ldap', group: 'Подключение к серверу', key: 'ldap_starttls', label: 'Использовать STARTTLS (шифрование поверх ldap://)', type: 'bool', default: false },
  { tab: 'ldap', group: 'Подключение к серверу', key: 'ldap_tls_verify', label: 'Проверять TLS-сертификат сервера', type: 'bool', default: true,
    help: 'Отключайте только для тестов с самоподписанным сертификатом.' },
  { tab: 'ldap', group: 'Подключение к серверу', key: 'ldap_timeout', label: 'Таймаут операций, секунд', type: 'number', default: 10, min: 1, max: 60 },

  { tab: 'ldap', group: 'Поиск пользователей', key: 'ldap_bind_dn', label: 'Служебная учётная запись (Bind DN)', type: 'text', default: '',
    help: 'Под ней выполняется поиск пользователей. Например: cn=wiki-reader,ou=service,dc=example,dc=com или wiki-reader@corp.example.com (AD). Пусто — анонимный поиск.' },
  { tab: 'ldap', group: 'Поиск пользователей', key: 'ldap_bind_password', label: 'Пароль служебной учётной записи', type: 'secret', default: '' },
  { tab: 'ldap', group: 'Поиск пользователей', key: 'ldap_search_base', label: 'База поиска (Base DN)', type: 'text', default: 'dc=example,dc=com',
    help: 'Ветка каталога, в которой ищутся пользователи, например ou=people,dc=example,dc=com.' },
  { tab: 'ldap', group: 'Поиск пользователей', key: 'ldap_user_filter', label: 'Фильтр поиска пользователя', type: 'text', default: '(uid={{username}})',
    pattern: /^\(.*\{\{username\}\}.*\)$/, patternError: 'фильтр должен быть в скобках и содержать {{username}}',
    help: '{{username}} заменяется на введённый логин (спецсимволы экранируются). AD: (sAMAccountName={{username}}). Вход по логину или почте: (|(uid={{username}})(mail={{username}})). Пускать только членов группы: (&(uid={{username}})(memberOf=cn=wiki,ou=groups,dc=example,dc=com)).' },

  { tab: 'ldap', group: 'Атрибуты и роли', key: 'ldap_attr_username', label: 'Атрибут логина', type: 'text', default: 'uid', help: 'AD: sAMAccountName' },
  { tab: 'ldap', group: 'Атрибуты и роли', key: 'ldap_attr_email', label: 'Атрибут email', type: 'text', default: 'mail' },
  { tab: 'ldap', group: 'Атрибуты и роли', key: 'ldap_attr_display_name', label: 'Атрибут отображаемого имени', type: 'text', default: 'cn', help: 'AD: displayName' },
  { tab: 'ldap', group: 'Атрибуты и роли', key: 'ldap_admin_group', label: 'DN группы администраторов', type: 'text', default: '',
    help: 'Например cn=wiki-admins,ou=groups,dc=example,dc=com' },
  { tab: 'ldap', group: 'Атрибуты и роли', key: 'ldap_editor_group', label: 'DN группы редакторов', type: 'text', default: '',
    help: 'Если задана хотя бы одна группа, роль LDAP-пользователя пересчитывается при КАЖДОМ входе по членству в группах. Если группы не заданы, роль назначается один раз при первом входе и дальше меняется вручную в «Пользователях».' },
  { tab: 'ldap', group: 'Атрибуты и роли', key: 'ldap_default_role', label: 'Роль LDAP-пользователя вне этих групп', type: 'select', default: 'viewer',
    options: [['viewer', 'Читатель'], ['editor', 'Редактор']] },
  { tab: 'ldap', group: 'Атрибуты и роли', key: 'ldap_allow_local', label: 'Разрешить вход локальным (не-LDAP) пользователям', type: 'bool', default: true,
    help: 'Локальные администраторы могут войти всегда — это аварийный доступ на случай недоступности LDAP.' },
];

/* Быстрый доступ к описанию настройки по ключу. */
const SCHEMA_BY_KEY = new Map(SETTINGS_SCHEMA.map((def) => [def.key, def]));

/* ----------------------------------------------------------------------------
 * Кэш значений и «версия» настроек. Версия добавляется к ссылке
 * /theme.css?v=..., чтобы после сохранения браузер сразу загрузил новые
 * стили, а не взял старые из своего кэша. Это хеш содержимого таблицы
 * settings, а не время загрузки: у всех копий приложения (Kubernetes)
 * версия одинаковая, и кэш браузера работает, на какую бы копию ни
 * попал запрос.
 * ------------------------------------------------------------------------- */
const cache = new Map();
let version = '0';

/* ----------------------------------------------------------------------------
 * normalizeValue — приведение «сырого» значения (из формы, env или БД)
 * к правильному типу с проверкой. Возвращает { value } или { error }.
 * Никакое значение не попадёт в настройки без этой проверки — это важно,
 * потому что цвета и числа потом вставляются прямо в CSS.
 * ------------------------------------------------------------------------- */
export function normalizeValue(def, raw) {
  switch (def.type) {
    case 'bool':
      /* Чекбокс HTML-формы присылает "on", если отмечен, и ничего — если нет. */
      return { value: raw === true || ['on', 'true', '1', 'yes'].includes(String(raw ?? '').toLowerCase()) };

    case 'number': {
      /* Необязательное число: пусто = «как в теме». */
      if (def.optional && String(raw ?? '').trim() === '') return { value: '' };
      const n = Number.parseInt(raw, 10);
      if (!Number.isFinite(n)) return { error: `«${def.label}»: нужно число` };
      /* Не ругаемся, а аккуратно «прижимаем» значение к допустимому диапазону. */
      return { value: Math.min(def.max ?? n, Math.max(def.min ?? n, n)) };
    }

    case 'color': {
      const v = String(raw ?? '').trim();
      if (def.optional && v === '') return { value: '' };
      /* Только #rgb или #rrggbb — никакой возможности вставить в CSS постороннее. */
      if (!/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v)) return { error: `«${def.label}»: цвет должен быть в формате #RRGGBB` };
      return { value: v.toLowerCase() };
    }

    case 'select': {
      const v = String(raw ?? '');
      if (!def.options.some(([optionValue]) => optionValue === v)) return { error: `«${def.label}»: недопустимое значение` };
      return { value: v };
    }

    case 'url': {
      const v = String(raw ?? '').trim();
      /* Разрешены пустое значение, локальный путь "/..." и http(s)-адреса.
       * Схемы вроде javascript: отсекаются — защита от XSS через логотип. */
      if (v && !/^(\/(?!\/)|https?:\/\/)/i.test(v)) return { error: `«${def.label}»: адрес должен начинаться с / или https://` };
      return { value: v.slice(0, 1000) };
    }

    case 'text': {
      const v = String(raw ?? '').trim().slice(0, 500);
      /* Необязательная проверка формата: поле pattern в схеме (для
       * непустых значений), например адрес LDAP-сервера. */
      if (v && def.pattern && !def.pattern.test(v)) return { error: `«${def.label}»: ${def.patternError}` };
      return { value: v };
    }

    /* Тема оформления: должна существовать в реестре тем. */
    case 'theme': {
      const v = String(raw ?? '').trim();
      if (!hasTheme(v)) return { error: `«${def.label}»: тема «${v}» не найдена` };
      return { value: v };
    }

    /* Пароли: пробелы по краям — часть пароля, поэтому НЕ обрезаем. */
    case 'secret':
      return { value: String(raw ?? '').slice(0, 1000) };

    /* textarea / markdown / code — многострочный текст. Приводим переводы
     * строк Windows (\r\n) к Unix (\n) и ограничиваем размер. */
    default:
      return { value: String(raw ?? '').replace(/\r\n?/g, '\n').slice(0, 50_000) };
  }
}

/* ----------------------------------------------------------------------------
 * Значение по умолчанию с учётом переменной окружения SETTING_<KEY>.
 * Пустая переменная считается НЕЗАДАННОЙ: docker-compose передаёт все
 * SETTING_LDAP_* всегда, и незаполненные в .env не должны затирать
 * значения по умолчанию пустыми строками.
 * Если в env записано некорректное значение — используем default из схемы.
 * ------------------------------------------------------------------------- */
function defaultFor(def) {
  const fromEnv = process.env[`SETTING_${def.key.toUpperCase()}`];
  if (fromEnv === undefined || fromEnv === '') return def.default;
  const { value, error } = normalizeValue(def, fromEnv);
  if (error) {
    console.warn(`[settings] Некорректное значение SETTING_${def.key.toUpperCase()}: ${error}`);
    return def.default;
  }
  return value;
}

/* ----------------------------------------------------------------------------
 * loadSettings — загрузка значений из БД в кэш (вызывается при старте).
 * Неизвестные ключи (например, оставшиеся от удалённой настройки)
 * игнорируются; испорченный JSON — тоже, с предупреждением в логе.
 * ------------------------------------------------------------------------- */
export async function loadSettings() {
  const rows = await many('SELECT key, value FROM settings ORDER BY key');
  /* Кэш очищается и заполняется без await между шагами — запросы никогда
   * не увидят «половину» настроек. */
  cache.clear();
  for (const { key, value } of rows) {
    if (!SCHEMA_BY_KEY.has(key)) continue;
    try {
      cache.set(key, JSON.parse(value));
    } catch {
      console.warn(`[settings] Не удалось прочитать значение настройки ${key}`);
    }
  }
  const previous = version;
  version = crypto.createHash('sha1').update(rows.map((r) => `${r.key}=${r.value}`).join('\n')).digest('hex').slice(0, 12);
  return version !== previous;
}

/* ----------------------------------------------------------------------------
 * startSettingsSync — для нескольких копий приложения. Настройки хранятся
 * в памяти каждой копии; когда администратор сохраняет их, обновляется
 * только та копия, которая обработала запрос. Остальные раз в seconds
 * секунд перечитывают таблицу settings (один маленький запрос) и через
 * несколько секунд тоже видят изменения. seconds = 0 — не проверять.
 * Работает через любой пулер соединений (в отличие от LISTEN/NOTIFY,
 * который ломается за PgBouncer в режиме транзакций).
 * ------------------------------------------------------------------------- */
export function startSettingsSync(seconds) {
  if (!seconds) return null;
  const timer = setInterval(async () => {
    try {
      if (await loadSettings()) console.log('[settings] Настройки изменены на другой копии приложения — загружены');
    } catch (err) {
      console.warn('[settings] Не удалось проверить настройки:', err.message);
    }
  }, seconds * 1000);
  timer.unref(); /* не мешает процессу завершиться */
  return timer;
}

/** Текущее значение одной настройки: из БД или значение по умолчанию. */
function currentValue(def) {
  return cache.has(def.key) ? cache.get(def.key) : defaultFor(def);
}

/* ----------------------------------------------------------------------------
 * getSettings — объект со ВСЕМИ настройками: значения из БД поверх
 * значений по умолчанию. Вызывается на каждом запросе (дёшево — из памяти).
 * Этот объект попадает в шаблоны (site.*), поэтому секреты (type: 'secret')
 * в нём ЗАМЕНЕНЫ пустой строкой: даже переопределённый шаблон из custom/
 * не сможет случайно вывести пароль на страницу.
 * ------------------------------------------------------------------------- */
export function getSettings() {
  const result = {};
  for (const def of SETTINGS_SCHEMA) {
    result[def.key] = def.type === 'secret' ? '' : currentValue(def);
  }
  return result;
}

/* ----------------------------------------------------------------------------
 * getSecret / hasSecret — доступ к секретным настройкам только из кода
 * сервера (например, пароль служебной учётной записи LDAP).
 * ------------------------------------------------------------------------- */
export function getSecret(key) {
  const def = SCHEMA_BY_KEY.get(key);
  return def?.type === 'secret' ? String(currentValue(def) ?? '') : '';
}

export function hasSecret(key) {
  return getSecret(key) !== '';
}

export function getSettingsVersion() {
  return version;
}

/* ----------------------------------------------------------------------------
 * updateSettings — сохранение значений из формы админки.
 *   input  — req.body формы
 *   keys   — какие ключи сохранять (по умолчанию все из схемы)
 * Сначала ВСЕ значения проверяются; если есть ошибки — ничего не
 * сохраняется и возвращается список ошибок. Иначе все значения
 * записываются одной транзакцией (UPSERT) и обновляется кэш.
 *
 * ВАЖНО: передавайте в keys только поля, которые реально есть в форме
 * (см. keysForTab). Отсутствующий в форме чекбокс означает «выключено»,
 * поэтому сохранение «чужих» ключей сбросило бы их в false.
 * ------------------------------------------------------------------------- */
export async function updateSettings(input, keys = SETTINGS_SCHEMA.map((d) => d.key)) {
  const errors = [];
  const values = [];

  for (const key of keys) {
    const def = SCHEMA_BY_KEY.get(key);
    if (!def) continue;
    /* Пустое поле пароля = «не менять сохранённый». */
    if (def.type === 'secret' && !input[key]) continue;
    const { value, error } = normalizeValue(def, input[key]);
    if (error) errors.push(error);
    else values.push([key, value]);
  }
  if (errors.length) return { errors };

  await transaction(async (db) => {
    for (const [key, value] of values) {
      await db.query(
        `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [key, JSON.stringify(value)],
      );
    }
  });

  /* Перечитываем из базы: так версия (хеш содержимого) совпадёт с той, что
   * вычислят остальные копии приложения. */
  await loadSettings();
  return { errors: [] };
}

/* ----------------------------------------------------------------------------
 * resetSettings — сброс группы настроек к значениям по умолчанию
 * (кнопка «Сбросить» в админке). Просто удаляем строки из БД — тогда
 * getSettings() вернёт default.
 * ------------------------------------------------------------------------- */
export async function resetSettings(group) {
  const keys = SETTINGS_SCHEMA.filter((d) => d.group === group).map((d) => d.key);
  if (!keys.length) return;
  await transaction((db) => db.query('DELETE FROM settings WHERE key = ANY($1)', [keys]));
  await loadSettings();
}

/** Вкладка настройки: у большинства полей не указана — значит 'general'. */
const tabOf = (def) => def.tab ?? 'general';

/** Ключи всех настроек указанной вкладки админки. */
export function keysForTab(tab) {
  return SETTINGS_SCHEMA.filter((def) => tabOf(def) === tab).map((def) => def.key);
}

/* ----------------------------------------------------------------------------
 * Схема вкладки, сгруппированная по group, — удобно для вывода формы.
 * Результат: [{ name: 'Общие', fields: [...] }, ...] в порядке объявления.
 * ------------------------------------------------------------------------- */
export function getSchemaGroups(tab = 'general') {
  const groups = new Map();
  for (const def of SETTINGS_SCHEMA) {
    if (tabOf(def) !== tab) continue;
    if (!groups.has(def.group)) groups.set(def.group, []);
    groups.get(def.group).push(def);
  }
  return [...groups].map(([name, fields]) => ({ name, fields }));
}
