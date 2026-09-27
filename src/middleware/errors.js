/**
 * ============================================================================
 *  middleware/errors.js — страница 404 и общий обработчик ошибок
 * ============================================================================
 *  Подключаются в САМОМ КОНЦЕ цепочки middleware (см. app.js):
 *   - notFound: ни один маршрут не подошёл → ошибка 404;
 *   - errorHandler: сюда попадает любое исключение из любого маршрута.
 * ============================================================================
 */
import { config } from '../config.js';
import { HttpError } from '../utils/http.js';
import { baseLocals } from './locals.js';

export function notFound(req, res, next) {
  next(new HttpError(404, 'Страница не найдена'));
}

/* ----------------------------------------------------------------------------
 * Express распознаёт обработчик ошибок по ЧЕТЫРЁМ параметрам (err, req, res,
 * next), поэтому next обязателен в сигнатуре, даже если почти не используется.
 * ------------------------------------------------------------------------- */
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  /* Статус: из HttpError, из ошибок библиотек (body-parser, multer) или 500. */
  let status = err.status ?? err.statusCode ?? 500;
  if (err.code === 'LIMIT_FILE_SIZE') status = 413;
  if (status < 400 || status > 599) status = 500;

  /* Серверные ошибки логируем полностью (со стеком) — это баги. */
  if (status >= 500) console.error(`[error] ${req.method} ${req.originalUrl}\n`, err);

  /* Если ответ уже начал отправляться, ничего исправить нельзя —
   * отдаём ошибку стандартному обработчику Express (он закроет соединение). */
  if (res.headersSent) return next(err);

  /* В production не раскрываем внутренние детали 500-х ошибок. */
  let message = status >= 500 && config.isProduction
    ? 'Внутренняя ошибка сервера. Попробуйте позже.'
    : err.message;
  /* Тело запроса больше лимита (app.js, п. 4): у body-parser сообщение
   * по-английски — заменяем понятным. Кнопка «Назад» в браузере вернёт
   * форму с набранным текстом. */
  if (err.type === 'entity.too.large') {
    message = 'Слишком большой объём данных: текст страницы должен быть не длиннее 1 000 000 символов. '
      + 'Вернитесь назад — набранный текст сохранится — и разделите его на несколько страниц.';
  }

  /* JS-запросы (fetch к /api/...) получают JSON, браузер — HTML-страницу. */
  if (req.path.startsWith('/api/') || req.accepts(['html', 'json']) === 'json') {
    return res.status(status).json({ error: message });
  }

  /* Если ошибка случилась раньше, чем заполнились общие переменные шаблонов
   * (например, упала база при загрузке сессии), дозаполняем их. */
  if (!res.locals.site) Object.assign(res.locals, baseLocals(req));

  return res.status(status).render('error', { title: `Ошибка ${status}`, status, message }, (renderErr, html) => {
    /* Последний рубеж: даже шаблон ошибки не отрисовался — простой текст. */
    if (renderErr) {
      console.error('[error] Не удалось отрисовать страницу ошибки:', renderErr);
      return res.type('text').send(`Ошибка ${status}: ${message}`);
    }
    return res.send(html);
  });
}
