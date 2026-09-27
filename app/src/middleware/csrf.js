/**
 * ============================================================================
 *  middleware/csrf.js — защита от CSRF (межсайтовой подделки запроса)
 * ============================================================================
 *  Угроза: вредоносный сайт может заставить браузер вошедшего пользователя
 *  отправить POST-форму на наш сайт (браузер сам приложит cookie сессии) —
 *  например, «удалить страницу».
 *
 *  Защита (паттерн «synchronizer token»):
 *   1. В сессии хранится случайный секретный токен.
 *   2. Каждая наша форма содержит его в скрытом поле _csrf, а JS-запросы
 *      передают его в заголовке X-CSRF-Token (берут из <meta name=csrf-token>).
 *   3. Любой изменяющий запрос (POST/PUT/PATCH/DELETE) без правильного токена
 *      отклоняется с кодом 403. Чужой сайт токен узнать не может.
 *
 *  Токен создаётся «лениво» — только когда шаблон действительно вызывает
 *  csrfToken(). Благодаря этому анонимные читатели и поисковые роботы не
 *  создают лишних записей сессий в базе.
 *  Дополнительно cookie сессии имеет SameSite=Lax (см. app.js).
 * ============================================================================
 */
import crypto from 'node:crypto';
import { HttpError } from '../utils/http.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Получить (или создать) токен текущей сессии. */
export function getCsrfToken(req) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  return req.session.csrfToken;
}

/* ----------------------------------------------------------------------------
 * Сравнение за постоянное время (timingSafeEqual): время проверки не зависит
 * от того, сколько первых символов совпало, — нельзя подобрать токен по
 * времени ответа.
 * ------------------------------------------------------------------------- */
function tokensEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

export function csrfProtection(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();

  const expected = req.session?.csrfToken;
  /* Для multipart-запросов (загрузка файлов) тело ещё не разобрано на этом
   * этапе, поэтому для них токен ожидается в заголовке. */
  const provided = req.body?._csrf ?? req.get('X-CSRF-Token');

  if (!expected || !provided || !tokensEqual(expected, provided)) {
    return next(new HttpError(403, 'Сессия устарела или форма недействительна. Обновите страницу и попробуйте снова.'));
  }
  return next();
}
