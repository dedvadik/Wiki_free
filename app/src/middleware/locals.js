/**
 * ============================================================================
 *  middleware/locals.js — общие переменные и функции для ВСЕХ шаблонов
 * ============================================================================
 *  Всё, что записано в res.locals, автоматически доступно в любом
 *  EJS-шаблоне без явной передачи. Здесь же реализованы flash-сообщения —
 *  одноразовые уведомления вида «Страница сохранена», которые переживают
 *  редирект (хранятся в сессии до первого показа).
 * ============================================================================
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { getSettings, getSettingsVersion } from '../services/settings.js';
import { hasRole, initials, ROLE_NAMES } from '../services/users.js';
import { pageUrl } from '../services/pages.js';
import { DEFAULT_THEME_ID, getTheme } from '../services/themes.js';
import { getCsrfToken } from './csrf.js';
import * as format from '../utils/format.js';
import { icon } from '../utils/icons.js';

/* ----------------------------------------------------------------------------
 * Версия статических файлов = время запуска процесса. Добавляется к ссылкам
 * (/css/app.css?v=...), поэтому после обновления контейнера браузеры
 * гарантированно загрузят свежие стили и скрипты, а не старые из кэша.
 * ------------------------------------------------------------------------- */
const ASSET_VERSION = Date.now().toString(36);

/* ----------------------------------------------------------------------------
 * Пользовательские файлы из custom/public: если администратор положил туда
 * custom.css / custom.js, они подключаются на всех страницах. Проверяем
 * один раз при старте (после добавления файла — перезапуск контейнера).
 * ------------------------------------------------------------------------- */
const customAssets = {
  css: fs.existsSync(path.join(config.customDir, 'public', 'custom.css')),
  js: fs.existsSync(path.join(config.customDir, 'public', 'custom.js')),
};

/* ----------------------------------------------------------------------------
 * flash — добавляет req.flash(type, message).
 * type: success | error | info — определяет цвет плашки.
 * ------------------------------------------------------------------------- */
export function flash(req, res, next) {
  req.flash = (type, message) => {
    req.session.flash ??= [];
    req.session.flash.push({ type, message });
  };
  next();
}

/* ----------------------------------------------------------------------------
 * Заполнение res.locals. Функции (can, csrfToken, consumeFlashes) вызываются
 * из шаблонов по требованию — так мы не делаем лишней работы, если шаблон
 * их не использует.
 * ------------------------------------------------------------------------- */
export function locals(req, res, next) {
  Object.assign(res.locals, baseLocals(req));
  next();
}

/* ----------------------------------------------------------------------------
 * resolveTheme — какую тему оформления показать в этом запросе:
 *   1. ?theme=<id> в адресе — ПРЕДПРОСМОТР темы (только эта страница,
 *      ничего не сохраняется; ссылка «Предпросмотр» в выборе темы);
 *   2. тема, выбранная пользователем в профиле (если это разрешено);
 *   3. тема сайта по умолчанию из настроек;
 *   4. «Классическая» — если выбранную тему удалили из папки.
 * ------------------------------------------------------------------------- */
function resolveTheme(req, site) {
  const preview = typeof req.query?.theme === 'string' ? getTheme(req.query.theme) : null;
  if (preview) return { theme: preview, preview: true };
  const userTheme = site.allow_user_themes && req.user?.theme ? getTheme(req.user.theme) : null;
  const theme = userTheme ?? getTheme(site.theme) ?? getTheme(DEFAULT_THEME_ID);
  return { theme, preview: false };
}

/* Вынесено в отдельную функцию, чтобы обработчик ошибок мог заполнить
 * переменные, даже если ошибка произошла до этого middleware. */
export function baseLocals(req) {
  const site = getSettings();
  const { theme, preview } = resolveTheme(req, site);
  return {
    /* Настройки сайта доступны в шаблонах как site.<ключ>.
     * ВАЖНО: переменную НЕЛЬЗЯ называть «settings» — это имя
     * зарезервировано Express (app.locals.settings): через него шаблонизатор
     * получает пути к шаблонам и опции. res.locals.settings перекрыл бы его,
     * и механизм переопределения шаблонов из custom/views перестал бы работать. */
    site,

    /* Активная тема оформления ({ id, name, stylesheet, … }) и признак
     * предпросмотра — шаблон шапки подключает её стили и показывает баннер. */
    activeTheme: theme,
    themePreview: preview,
    themeVersion: getSettingsVersion(),
    assetVersion: ASSET_VERSION,
    customAssets,
    currentUser: req.user ?? null,
    currentPath: req.path,
    searchQuery: '',

    /* can('editor') — есть ли у текущего пользователя такая роль или выше. */
    can: (role) => hasRole(req.user, role),

    /* csrfToken() — токен для скрытого поля форм. */
    csrfToken: () => (req.session ? getCsrfToken(req) : ''),

    /* consumeFlashes() — забрать накопленные уведомления (и удалить их). */
    consumeFlashes: () => {
      const messages = req.session?.flash ?? [];
      if (req.session) delete req.session.flash;
      return messages;
    },

    /* Помощники форматирования и прочее. */
    ...format,
    initials,
    icon,
    pageUrl,
    roleNames: ROLE_NAMES,
  };
}
