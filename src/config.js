/**
 * ============================================================================
 *  config.js — централизованная конфигурация приложения
 * ============================================================================
 *  Все «инфраструктурные» параметры (порт, БД, секреты, пути к папкам)
 *  читаются здесь из переменных окружения ОДИН раз при старте. Остальной код
 *  импортирует объект `config` и никогда не обращается к process.env напрямую:
 *  так в одном файле видно, какие настройки вообще существуют.
 *
 *  ВАЖНО: настройки внешнего вида и поведения сайта (название, цвета,
 *  открытая/закрытая регистрация и т.д.) хранятся НЕ здесь, а в базе данных
 *  и редактируются через админ-панель — см. src/services/settings.js.
 * ============================================================================
 */
import path from 'node:path';

/* ----------------------------------------------------------------------------
 * Корень проекта. import.meta.dirname — это папка текущего файла (src/),
 * поэтому поднимаемся на уровень выше. Все пути по умолчанию строятся от него,
 * чтобы приложение одинаково работало и локально, и в Docker (/app).
 * ------------------------------------------------------------------------- */
const ROOT_DIR = path.resolve(import.meta.dirname, '..');

/* ----------------------------------------------------------------------------
 * Вспомогательные парсеры. Переменные окружения — всегда строки, поэтому
 * их нужно явно приводить к boolean / number с разумным значением по умолчанию.
 * ------------------------------------------------------------------------- */

/** "1", "true", "yes", "on" → true; пустое/отсутствующее значение → fallback. */
function toBool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

/** Целое число или fallback, если строка не парсится. */
function toInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Настройка Express "trust proxy" — нужна, если приложение стоит за
 * обратным прокси (nginx, Traefik, Caddy). Тогда Express берёт реальный IP
 * клиента и протокол (http/https) из заголовков X-Forwarded-*.
 *   "false"/пусто → не доверять (прямое подключение)
 *   "true"        → доверять всем прокси
 *   "1", "2"      → количество прокси перед приложением
 *   иное          → список подсетей, например "loopback, 10.0.0.0/8"
 */
function parseTrustProxy(value) {
  if (value === undefined || value === '' || value === 'false') return false;
  if (value === 'true') return true;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && String(n) === value.trim() ? n : value;
}

const env = process.env;

/* Папка для изменяемых данных (загруженные файлы, сгенерированный секрет).
 * В Docker сюда монтируется именованный volume, чтобы данные переживали
 * пересоздание контейнера. */
const DATA_DIR = path.resolve(env.DATA_DIR || path.join(ROOT_DIR, 'data'));

/* ----------------------------------------------------------------------------
 * Итоговый объект конфигурации. Object.freeze защищает от случайного
 * изменения настроек во время работы приложения.
 * ------------------------------------------------------------------------- */
export const config = Object.freeze({
  rootDir: ROOT_DIR,

  /* Режим работы. В production скрываются технические детали ошибок. */
  isProduction: env.NODE_ENV === 'production',

  /* HTTP-сервер: порт и интерфейс. 0.0.0.0 — слушать все интерфейсы
   * (обязательно внутри контейнера, иначе порт не будет доступен снаружи). */
  port: toInt(env.PORT, 3000),
  host: env.HOST || '0.0.0.0',

  /* Подключение к PostgreSQL. Если DATABASE_URL не задан, драйвер pg сам
   * возьмёт стандартные переменные PGHOST, PGUSER, PGPASSWORD, PGDATABASE,
   * PGPORT. Этот вариант удобнее: пароль не нужно URL-кодировать. */
  databaseUrl: env.DATABASE_URL || undefined,
  dbPoolMax: toInt(env.DB_POOL_MAX, 10),

  /* Сессии. Если SESSION_SECRET пуст, секрет будет сгенерирован
   * автоматически и сохранён в DATA_DIR (см. server.js). */
  sessionSecret: env.SESSION_SECRET || '',
  sessionMaxAgeDays: toInt(env.SESSION_MAX_AGE_DAYS, 14),
  /* COOKIE_SECURE=true — отдавать cookie только по HTTPS. Включайте, когда
   * сайт работает за HTTPS-прокси (и не забудьте TRUST_PROXY). */
  cookieSecure: toBool(env.COOKIE_SECURE, false),
  trustProxy: parseTrustProxy(env.TRUST_PROXY),

  /* Пути. customDir — папка пользовательских переопределений шаблонов и
   * статики (главный механизм «глубокой» кастомизации, см. README). */
  dataDir: DATA_DIR,
  uploadsDir: path.join(DATA_DIR, 'uploads'),
  customDir: path.resolve(env.CUSTOM_DIR || path.join(ROOT_DIR, 'custom')),
  viewsDir: path.join(ROOT_DIR, 'views'),
  publicDir: path.join(ROOT_DIR, 'public'),

  /* Ограничение размера загружаемого файла (в мегабайтах). */
  uploadMaxMb: toInt(env.UPLOAD_MAX_MB, 20),

  /* Первичный администратор: создаётся при первом запуске, если в базе ещё
   * нет ни одного пользователя и задан ADMIN_PASSWORD. Если не задан —
   * администратором станет первый зарегистрировавшийся пользователь. */
  admin: {
    username: env.ADMIN_USERNAME || 'admin',
    email: env.ADMIN_EMAIL || 'admin@example.com',
    password: env.ADMIN_PASSWORD || '',
    displayName: env.ADMIN_DISPLAY_NAME || 'Администратор',
  },

  /* Создавать ли демо-пространство с документацией при пустой базе. */
  seedDemo: toBool(env.SEED_DEMO, true),

  /* Стоимость хеширования паролей bcrypt. 10 — хороший баланс для чистой
   * JS-реализации (bcryptjs), в том числе на ARM-устройствах вроде Raspberry Pi. */
  bcryptRounds: toInt(env.BCRYPT_ROUNDS, 10),

  /* Сколько попыток входа/регистрации разрешено с одного IP за 15 минут. */
  authRateLimit: toInt(env.AUTH_RATE_LIMIT, 20),
});
