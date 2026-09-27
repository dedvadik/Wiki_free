/**
 * ============================================================================
 *  app.js — сборка Express-приложения: цепочка middleware и маршруты
 * ============================================================================
 *  Каждый HTTP-запрос проходит через middleware СТРОГО СВЕРХУ ВНИЗ в порядке
 *  подключения (app.use). Порядок здесь принципиален — он определяет, что
 *  доступно без входа, где проверяется CSRF, где подгружается пользователь.
 *
 *   1. helmet            — защитные HTTP-заголовки (CSP и др.)
 *   2. статика           — custom/public, затем public (без сессий, быстро)
 *   3. логирование       — метод, адрес, статус, время ответа
 *   4. разбор тела       — формы (urlencoded) и JSON
 *   5. сессия            — cookie ↔ запись в PostgreSQL
 *   6. flash, loadUser, locals, csrf
 *   7. публичные маршруты — /healthz, /theme.css, /login, /register, /logout
 *   8. siteAccess        — «закрытая вики»: всё ниже требует входа (если включено)
 *   9. основные маршруты — главная, пространства, страницы, файлы, админка
 *  10. 404 и обработчик ошибок
 * ============================================================================
 */
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import helmet from 'helmet';
import { config } from './config.js';
import { pool } from './db/pool.js';
import { loadUser, siteAccess } from './middleware/auth.js';
import { csrfProtection } from './middleware/csrf.js';
import { errorHandler, notFound } from './middleware/errors.js';
import { flash, locals } from './middleware/locals.js';
import { adminRouter } from './routes/admin.js';
import { apiRouter, publicApiRouter } from './routes/api.js';
import { authRouter } from './routes/auth.js';
import { homeRouter } from './routes/home.js';
import { pagesRouter } from './routes/pages.js';
import { profileRouter } from './routes/profile.js';
import { settingsRouter } from './routes/settings.js';
import { spacesRouter } from './routes/spaces.js';
import { uploadsRouter } from './routes/uploads.js';

export function createApp({ sessionSecret }) {
  const app = express();

  /* --------------------------------------------------------------------------
   * Базовые настройки Express.
   *  - trust proxy: см. config.js (важно для HTTPS-прокси и лимитов по IP);
   *  - x-powered-by отключаем, чтобы не сообщать, на чём работает сервер.
   * ---------------------------------------------------------------------- */
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');

  /* --------------------------------------------------------------------------
   * Шаблонизатор EJS и МЕХАНИЗМ ПЕРЕОПРЕДЕЛЕНИЯ ШАБЛОНОВ.
   * Шаблоны ищутся сначала в custom/views, затем во встроенной папке views.
   *  - 'views' (массив) — для res.render('pages/show');
   *  - 'view options'.root (массив) — для include('/partials/header') внутри
   *    шаблонов. Поэтому все include в проекте пишутся с ведущим «/».
   * Итог: чтобы заменить любой шаблон или его кусок, достаточно положить
   * файл с тем же относительным путём в custom/views — код менять не нужно.
   *
   * Как ищутся include. Если передать EJS массив папок, он проверяет
   * существование файла (fs.existsSync) при КАЖДОМ include в КАЖДОМ
   * запросе. Нагрузочный тест показал, что это ~16% всей работы сервера
   * (custom/ — том с диска хоста, проверка там особенно медленная). Поэтому:
   *  - root — одна встроенная папка views: путь к файлу EJS вычисляет без
   *    обращения к диску;
   *  - includer — наша функция, которую EJS вызывает для каждого include:
   *    если в custom/views есть файл с тем же путём, подставляем его.
   *    В production результат проверки запоминается (переопределения и так
   *    подхватываются только после перезапуска), в разработке файл
   *    проверяется каждый раз — можно править custom/ «на горячую».
   * ---------------------------------------------------------------------- */
  const customViews = path.join(config.customDir, 'views');
  const overrideCache = new Map();
  const customOverride = (includePath) => {
    const relative = includePath.replace(/^[/\\]+/, '');
    const file = path.resolve(customViews, path.extname(relative) ? relative : `${relative}.ejs`);
    if (!file.startsWith(customViews + path.sep)) return null; /* «../» за пределы custom/views */
    if (!config.isProduction) return fs.existsSync(file) ? file : null;
    if (!overrideCache.has(file)) overrideCache.set(file, fs.existsSync(file) ? file : null);
    return overrideCache.get(file);
  };
  app.set('view engine', 'ejs');
  app.set('views', [customViews, config.viewsDir]);
  app.set('view options', {
    root: config.viewsDir,
    includer: (includePath) => {
      const file = customOverride(includePath);
      return file ? { filename: file } : undefined;
    },
  });

  /* --------------------------------------------------------------------------
   * 1. helmet — набор защитных заголовков. Главный — Content-Security-Policy:
   *    браузер выполнит JavaScript ТОЛЬКО из файлов нашего сайта ('self'),
   *    поэтому даже если в статью как-то попадёт <script>, он не запустится.
   *    - img-src https: — разрешаем картинки со сторонних сайтов в статьях;
   *    - style-src 'unsafe-inline' — для атрибутов style (цвет пространства);
   *    - upgrade-insecure-requests отключён: иначе сайт, открытый по http
   *      через IP-адрес в локальной сети, не загрузил бы свои стили;
   *    - HSTS включаем только когда сайт точно работает по HTTPS.
   * ---------------------------------------------------------------------- */
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        'img-src': ["'self'", 'data:', 'https:'],
        'script-src': ["'self'"],
        'style-src': ["'self'", "'unsafe-inline'"],
        'upgrade-insecure-requests': null,
      },
    },
    strictTransportSecurity: config.cookieSecure ? { maxAge: 15552000 } : false,
    crossOriginEmbedderPolicy: false,
  }));

  /* --------------------------------------------------------------------------
   * 2. Статические файлы. Сначала custom/public (пользовательские файлы
   *    имеют приоритет и могут заменить, например, /img/logo.svg), потом
   *    встроенные. Статика отдаётся ДО сессий — это быстрее и не создаёт
   *    лишних записей в БД.
   * ---------------------------------------------------------------------- */
  const staticOptions = { maxAge: config.isProduction ? '7d' : 0, index: false };
  app.use(express.static(path.join(config.customDir, 'public'), staticOptions));
  app.use(express.static(config.publicDir, staticOptions));
  /* Браузерная сборка библиотеки turndown (HTML → Markdown) для визуального
   * редактора — прямо из node_modules, без внешних CDN. */
  app.use('/vendor/turndown', express.static(path.join(config.rootDir, 'node_modules', 'turndown', 'lib'), staticOptions));

  /* --------------------------------------------------------------------------
   * 3. Простое логирование запросов: «GET /pages/5 200 12ms».
   *    Событие 'finish' срабатывает, когда ответ полностью отправлен.
   *    /healthz не логируем — Docker дёргает его каждые 30 секунд.
   * ---------------------------------------------------------------------- */
  app.use((req, res, next) => {
    if (req.path === '/healthz') return next();
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${ms.toFixed(0)}ms`);
    });
    return next();
  });

  /* --------------------------------------------------------------------------
   * 4. Разбор тела запроса: HTML-формы и JSON (fetch из редактора).
   *    Лимиты согласованы с максимальной длиной статьи (1 млн символов,
   *    MAX_CONTENT_LENGTH): форма кодирует каждую русскую букву как
   *    «%D0%B0» — 6 байт, поэтому статье предельной длины нужно до ~6 МБ;
   *    в JSON та же буква — 2 байта. Раньше лимит формы был 5 МБ и длинная
   *    русская статья получала непонятную ошибку 413 вместо подсказки.
   * ---------------------------------------------------------------------- */
  app.use(express.urlencoded({ extended: false, limit: '8mb' }));
  app.use(express.json({ limit: '5mb' }));

  /* --------------------------------------------------------------------------
   * 5. Сессии в PostgreSQL (таблица "session" создаётся миграцией).
   *  - saveUninitialized: false — не создавать сессию, пока в неё ничего
   *    не записали (анонимные читатели не засоряют базу);
   *  - rolling: true — срок жизни продлевается при каждом визите;
   *  - httpOnly — cookie недоступна JavaScript'у (защита от кражи через XSS);
   *  - sameSite: 'lax' — cookie не отправляется в POST-запросах с чужих сайтов.
   * ---------------------------------------------------------------------- */
  const PgStore = connectPgSimple(session);
  const sessionStore = new PgStore({ pool, tableName: 'session', createTableIfMissing: false });
  app.use(session({
    name: 'wiki.sid',
    secret: sessionSecret,
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.cookieSecure,
      maxAge: config.sessionMaxAgeDays * 24 * 60 * 60 * 1000,
    },
  }));

  /* --------------------------------------------------------------------------
   * 6. Flash-сообщения, текущий пользователь, общие переменные шаблонов,
   *    проверка CSRF-токена для всех изменяющих запросов.
   * ---------------------------------------------------------------------- */
  app.use(flash);
  app.use(loadUser);
  app.use(locals);
  app.use(csrfProtection);

  /* 7. Публичные маршруты (доступны всегда). */
  app.use(publicApiRouter);
  app.use(authRouter);

  /* 8. Дальше — только для вошедших, если включена «Закрытая вики». */
  app.use(siteAccess);

  /* 9. Основная функциональность. */
  app.use(homeRouter);
  app.use(spacesRouter);
  app.use(pagesRouter);
  app.use(uploadsRouter);
  app.use(apiRouter);
  app.use(profileRouter);
  app.use(settingsRouter);
  app.use(adminRouter);

  /* 10. Ничего не подошло → 404; любая ошибка → единый обработчик. */
  app.use(notFound);
  app.use(errorHandler);

  return { app, sessionStore };
}
