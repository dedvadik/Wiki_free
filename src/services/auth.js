/**
 * ============================================================================
 *  services/auth.js — единая точка проверки логина и пароля
 * ============================================================================
 *  Решает, КАК проверять введённые данные: локальным паролем из нашей БД
 *  или через LDAP. Порядок (важен для безопасности):
 *
 *   1. Есть ЛОКАЛЬНАЯ учётная запись с таким логином/email → проверяем
 *      только локальный пароль. LDAP при этом не опрашивается: иначе
 *      пользователь каталога с совпадающим логином мог бы войти в чужой
 *      локальный аккаунт (например, в «admin»).
 *      Если в настройках запрещён вход локальным пользователям — пускаем
 *      только локальных администраторов (аварийный доступ).
 *   2. Иначе, если LDAP включён → проверка через LDAP; при успехе учётная
 *      запись создаётся или обновляется автоматически.
 *   3. Иначе — «неверный логин или пароль».
 *
 *  Результат: { user } при успехе или { error, status } при отказе.
 *  Блокировку (is_active) проверяет маршрут входа.
 * ============================================================================
 */
import { getSettings } from './settings.js';
import { ldapAuthenticate, LdapError } from './ldap.js';
import { checkLocalPassword, findUserByLogin, upsertLdapUser, ValidationError } from './users.js';

const INVALID = { error: 'Неверный логин или пароль', status: 401 };

export async function authenticateUser(login, password) {
  const s = getSettings();
  const existing = await findUserByLogin(login);

  /* ---- 1. Локальная учётная запись ---- */
  if (existing?.auth_source === 'local') {
    if (!(await checkLocalPassword(existing, password))) return INVALID;
    if (s.ldap_enabled && !s.ldap_allow_local && existing.role !== 'admin') {
      return { error: 'Вход разрешён только через корпоративную учётную запись (LDAP)', status: 403 };
    }
    return { user: existing };
  }

  /* ---- 2. LDAP ---- */
  if (s.ldap_enabled) {
    let profile;
    try {
      profile = await ldapAuthenticate(login, password);
    } catch (err) {
      if (!(err instanceof LdapError)) throw err;
      console.error(`[ldap] Ошибка при входе «${login}»: ${err.message}`);
      return { error: 'Сервер каталога (LDAP) недоступен. Попробуйте позже или обратитесь к администратору.', status: 503 };
    }
    if (!profile) return INVALID;

    try {
      return { user: await upsertLdapUser(profile) };
    } catch (err) {
      if (err instanceof ValidationError) return { error: err.message, status: 409 };
      throw err;
    }
  }

  /* ---- 3. Не нашли подходящего способа входа ----
   * Прогоняем «пустую» проверку пароля, чтобы время ответа не выдавало,
   * существует ли такой логин. */
  await checkLocalPassword(null, password);
  return INVALID;
}
