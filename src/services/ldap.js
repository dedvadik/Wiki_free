/**
 * ============================================================================
 *  services/ldap.js — проверка логина и пароля через LDAP / Active Directory
 * ============================================================================
 *  Используется классическая схема «search & bind»:
 *
 *   1. Подключаемся к серверу (ldap:// или ldaps://, при необходимости STARTTLS).
 *   2. Входим служебной учётной записью (Bind DN) — или анонимно, если она
 *      не задана — и ИЩЕМ пользователя по фильтру, например (uid=ivan).
 *   3. Найдена ровно одна запись → пробуем войти (bind) с её DN и паролем,
 *      который ввёл человек, на ОТДЕЛЬНОМ соединении. Успешный bind =
 *      пароль верный. Сам пароль у нас нигде не сохраняется.
 *   4. Читаем атрибуты (логин, email, имя) и определяем роль по членству
 *      в группах администраторов/редакторов.
 *
 *  Проверка членства в группе работает двумя способами (подходит и для
 *  Active Directory, и для OpenLDAP/FreeIPA/389-ds):
 *    а) атрибут memberOf у записи пользователя;
 *    б) поиск в самой группе: member / uniqueMember (DN) или memberUid (логин).
 *  Вложенные группы AD не раскрываются.
 *
 *  Библиотека ldapts написана на чистом TypeScript/JavaScript — без нативных
 *  модулей, поэтому не мешает мультиплатформенной сборке Docker-образа.
 * ============================================================================
 */
import { Client, InvalidCredentialsError } from 'ldapts';
import { getSecret, getSettings } from './settings.js';

/* ----------------------------------------------------------------------------
 * Ошибка связи/настройки LDAP (сервер недоступен, неверная служебная
 * учётная запись, ошибка сертификата…). В отличие от «неверного пароля»,
 * это проблема не пользователя, а администратора.
 * ------------------------------------------------------------------------- */
export class LdapError extends Error {
  constructor(cause) {
    super(describeLdapError(cause));
    this.cause = cause;
  }
}

/* ----------------------------------------------------------------------------
 * Экранирование значения для LDAP-фильтра по RFC 4515.
 * Без этого логин вида  *)(uid=*  превратил бы фильтр (uid={{username}})
 * в «найти всех» — классическая LDAP-инъекция.
 *   \  →  \5c     *  →  \2a     (  →  \28     )  →  \29     NUL  →  \00
 * ------------------------------------------------------------------------- */
export function escapeFilterValue(value) {
  return String(value).replace(/[\\*()\0]/g, (ch) => `\\${ch.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

/* ----------------------------------------------------------------------------
 * Человекочитаемое описание ошибки — для журнала и страницы проверки
 * подключения в админке. Сетевые ошибки Node имеют строковый code,
 * ошибки протокола LDAP — числовой код результата (RFC 4511).
 * ------------------------------------------------------------------------- */
export function describeLdapError(err) {
  const code = err?.code;
  const messages = {
    ECONNREFUSED: 'сервер отклонил соединение — проверьте адрес и порт',
    ENOTFOUND: 'хост не найден — проверьте имя сервера (DNS)',
    EAI_AGAIN: 'не удалось разрешить имя сервера (DNS)',
    ETIMEDOUT: 'сервер не ответил вовремя (таймаут)',
    ECONNRESET: 'соединение разорвано сервером — возможно, нужен ldaps:// или STARTTLS',
    DEPTH_ZERO_SELF_SIGNED_CERT: 'самоподписанный TLS-сертификат — добавьте CA или отключите проверку сертификата',
    SELF_SIGNED_CERT_IN_CHAIN: 'в цепочке TLS-сертификатов самоподписанный корневой — добавьте CA или отключите проверку',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'не удалось проверить TLS-сертификат сервера',
    ERR_TLS_CERT_ALTNAME_INVALID: 'имя в TLS-сертификате не совпадает с адресом сервера',
    CERT_HAS_EXPIRED: 'срок действия TLS-сертификата истёк',
    32: 'объект не найден — проверьте Base DN или DN группы (код 32)',
    34: 'некорректный синтаксис DN (код 34)',
    49: 'неверный DN или пароль (код 49)',
    50: 'недостаточно прав для операции (код 50)',
    52: 'сервер временно недоступен (код 52)',
    53: 'сервер отказался выполнять операцию (код 53)',
    87: 'некорректный фильтр поиска (код 87)',
  };
  if (err instanceof InvalidCredentialsError) return messages[49];
  if (/timeout/i.test(err?.message ?? '') && !messages[code]) return messages.ETIMEDOUT;
  return messages[code] ?? err?.message ?? String(err);
}

/* ----------------------------------------------------------------------------
 * Работа с атрибутами записи. ldapts возвращает значения как строку,
 * массив строк или Buffer, а имена атрибутов — в том регистре, в котором их
 * прислал сервер (sAMAccountName vs samaccountname). Нормализуем.
 * ------------------------------------------------------------------------- */
function attrValues(entry, name) {
  const key = Object.keys(entry).find((k) => k.toLowerCase() === String(name).toLowerCase());
  if (!key) return [];
  const raw = entry[key];
  return (Array.isArray(raw) ? raw : [raw]).map((v) => (Buffer.isBuffer(v) ? v.toString('utf8') : String(v)));
}

const firstAttr = (entry, name) => (attrValues(entry, name)[0] ?? '').trim();

/** Упрощённая нормализация DN для сравнения: регистр и пробелы вокруг «,» и «=». */
function normalizeDn(dn) {
  return String(dn).toLowerCase().replace(/\s*([,=])\s*/g, '$1').trim();
}

/* ----------------------------------------------------------------------------
 * Создание клиента. Соединение устанавливается «лениво» — при первой
 * операции (startTLS, bind или search).
 *  - timeout / connectTimeout — чтобы вход не «висел» при недоступном сервере;
 *  - rejectUnauthorized — проверка TLS-сертификата (настройка ldap_tls_verify);
 *  - strictDN: false — разрешает bind по userPrincipalName (ivan@corp.local),
 *    который принимает Active Directory, хотя это не DN.
 *
 *  ВАЖНО: tlsOptions передаём в конструктор ТОЛЬКО для ldaps://. ldapts
 *  включает TLS-рукопожатие уже при наличии tlsOptions — и для обычного
 *  ldap:// сервер просто разрывал бы соединение. Для STARTTLS параметры
 *  TLS передаются в сам вызов startTLS().
 * ------------------------------------------------------------------------- */
async function openConnection(s) {
  const tlsOptions = { rejectUnauthorized: s.ldap_tls_verify };
  const secure = s.ldap_url.toLowerCase().startsWith('ldaps://');
  const client = new Client({
    url: s.ldap_url,
    timeout: s.ldap_timeout * 1000,
    connectTimeout: s.ldap_timeout * 1000,
    ...(secure ? { tlsOptions } : {}),
    strictDN: false,
  });
  if (s.ldap_starttls && !secure) {
    await client.startTLS(tlsOptions);
  }
  return client;
}

/** Вход служебной учётной записью (или ничего — тогда поиск анонимный). */
async function bindService(client, s) {
  if (s.ldap_bind_dn) await client.bind(s.ldap_bind_dn, getSecret('ldap_bind_password'));
}

/** Поиск записей пользователя по фильтру из настроек. */
async function searchUser(client, s, login) {
  const filter = s.ldap_user_filter.replaceAll('{{username}}', escapeFilterValue(login));
  const { searchEntries } = await client.search(s.ldap_search_base, {
    scope: 'sub',
    filter,
    attributes: [s.ldap_attr_username, s.ldap_attr_email, s.ldap_attr_display_name, 'memberOf'],
  });
  return searchEntries;
}

/* ----------------------------------------------------------------------------
 * Проверка пароля: bind от имени найденного пользователя на отдельном
 * соединении (служебное соединение нужно дальше для проверки групп).
 * Неверный пароль → false; любые другие проблемы → исключение.
 * ------------------------------------------------------------------------- */
async function verifyUserPassword(s, dn, password) {
  const client = await openConnection(s);
  try {
    await client.bind(dn, password);
    return true;
  } catch (err) {
    if (err instanceof InvalidCredentialsError || err?.code === 49) return false;
    throw err;
  } finally {
    await client.unbind().catch(() => {});
  }
}

/* ----------------------------------------------------------------------------
 * Членство в группе (см. описание в шапке файла).
 * Ошибка поиска группы (нет прав, неверный DN) = «не состоит», а не падение
 * входа: пользователь просто получит роль по умолчанию.
 * ------------------------------------------------------------------------- */
async function isMemberOf(client, groupDn, entry, username) {
  if (!groupDn) return false;
  const target = normalizeDn(groupDn);
  if (attrValues(entry, 'memberOf').some((dn) => normalizeDn(dn) === target)) return true;

  const dn = escapeFilterValue(entry.dn);
  const filter = `(|(member=${dn})(uniqueMember=${dn})(memberUid=${escapeFilterValue(username)}))`;
  try {
    const { searchEntries } = await client.search(groupDn, { scope: 'base', filter, attributes: ['1.1'] });
    return searchEntries.length > 0;
  } catch {
    return false;
  }
}

/* ----------------------------------------------------------------------------
 * Роль пользователя:
 *   - группы не заданы → роль по умолчанию, roleManaged=false (назначается
 *     только при создании учётной записи, дальше её меняет администратор);
 *   - группы заданы → admin / editor / роль по умолчанию, roleManaged=true
 *     (пересчитывается при каждом входе — каталог «главнее» сайта).
 * ------------------------------------------------------------------------- */
async function resolveRole(client, s, entry, username) {
  if (!s.ldap_admin_group && !s.ldap_editor_group) {
    return { role: s.ldap_default_role, roleManaged: false, groups: [] };
  }
  const groups = [];
  if (await isMemberOf(client, s.ldap_admin_group, entry, username)) groups.push('admin');
  if (await isMemberOf(client, s.ldap_editor_group, entry, username)) groups.push('editor');
  const role = groups.includes('admin') ? 'admin' : groups.includes('editor') ? 'editor' : s.ldap_default_role;
  return { role, roleManaged: true, groups };
}

/** Профиль пользователя из записи каталога (с запасными значениями). */
function buildProfile(s, entry, login) {
  const username = (firstAttr(entry, s.ldap_attr_username) || login).slice(0, 50);
  return {
    dn: entry.dn,
    username,
    /* email обязателен и уникален в нашей БД. Если в каталоге его нет —
     * подставляем адрес в зарезервированном домене .invalid (RFC 2606). */
    email: (firstAttr(entry, s.ldap_attr_email) || `${username}@ldap.invalid`).toLowerCase().slice(0, 255),
    displayName: (firstAttr(entry, s.ldap_attr_display_name) || username).slice(0, 100),
  };
}

/* ============================================================================
 * ldapAuthenticate — ГЛАВНАЯ ФУНКЦИЯ: проверка логина и пароля.
 * Возвращает:
 *   профиль { dn, username, email, displayName, role, roleManaged } — успех;
 *   null — пользователь не найден, найдено несколько записей или неверный пароль;
 * Бросает LdapError — сервер недоступен или LDAP неверно настроен.
 * ========================================================================= */
export async function ldapAuthenticate(login, password) {
  const s = getSettings();
  /* КРИТИЧНО: пустой пароль отклоняем сразу. По стандарту LDAP bind с
   * пустым паролем — это «неаутентифицированный» вход, и многие серверы
   * отвечают на него УСПЕХОМ. Без этой проверки в любую учётную запись
   * можно было бы войти без пароля. */
  if (!login || !password) return null;

  let client;
  try {
    client = await openConnection(s);
    await bindService(client, s);

    const entries = await searchUser(client, s, login);
    /* 0 записей — нет такого пользователя; больше одной — фильтр
     * неоднозначен, пускать нельзя (непонятно, чей это пароль). */
    if (entries.length !== 1) return null;
    const [entry] = entries;

    if (!(await verifyUserPassword(s, entry.dn, password))) return null;

    const profile = buildProfile(s, entry, login);
    const { role, roleManaged } = await resolveRole(client, s, entry, profile.username);
    return { ...profile, role, roleManaged };
  } catch (err) {
    throw err instanceof LdapError ? err : new LdapError(err);
  } finally {
    await client?.unbind().catch(() => {});
  }
}

/* ============================================================================
 * testLdapConnection — пошаговая диагностика для кнопки «Проверить» в
 * админке. Выполняет те же шаги, что и вход, и возвращает журнал:
 *   [{ ok: true|false, text: '...' }, ...]
 * login и password необязательны: без логина проверяются только подключение
 * и доступность базы поиска, без пароля — всё, кроме проверки пароля.
 * ========================================================================= */
export async function testLdapConnection(login, password) {
  const s = getSettings();
  const steps = [];
  const step = (ok, text) => steps.push({ ok, text });

  let client;
  try {
    client = await openConnection(s);
    if (s.ldap_starttls) step(true, 'STARTTLS: соединение зашифровано');

    if (s.ldap_bind_dn) {
      await bindService(client, s);
      step(true, `Вход служебной учётной записью: ${s.ldap_bind_dn}`);
    } else {
      step(true, 'Служебная учётная запись не задана — поиск выполняется анонимно');
    }

    if (!login) {
      await client.search(s.ldap_search_base, { scope: 'base', filter: '(objectClass=*)', attributes: ['1.1'] });
      step(true, `Подключение к ${s.ldap_url} установлено, база поиска ${s.ldap_search_base} доступна`);
      step(true, 'Укажите тестовый логин, чтобы проверить поиск пользователя и определение роли');
      return steps;
    }

    const entries = await searchUser(client, s, login);
    if (entries.length === 0) {
      step(false, `Пользователь «${login}» не найден. Проверьте базу поиска и фильтр`);
      return steps;
    }
    if (entries.length > 1) {
      step(false, `Найдено записей: ${entries.length}. Фильтр должен находить ровно одного пользователя`);
      return steps;
    }
    const [entry] = entries;
    const profile = buildProfile(s, entry, login);
    step(true, `Найден: ${entry.dn}`);
    step(Boolean(firstAttr(entry, s.ldap_attr_username)), `Логин (${s.ldap_attr_username}): ${firstAttr(entry, s.ldap_attr_username) || 'атрибут пуст — будет использован введённый логин'}`);
    step(Boolean(firstAttr(entry, s.ldap_attr_email)), `Email (${s.ldap_attr_email}): ${firstAttr(entry, s.ldap_attr_email) || `атрибут пуст — будет ${profile.email}`}`);
    step(true, `Имя (${s.ldap_attr_display_name}): ${profile.displayName}`);

    const { role, roleManaged, groups } = await resolveRole(client, s, entry, profile.username);
    const roleNames = { admin: 'Администратор', editor: 'Редактор', viewer: 'Читатель' };
    step(true, roleManaged
      ? `Роль по группам: ${roleNames[role]} (найдено членство: ${groups.length ? groups.join(', ') : 'нет'})`
      : `Группы не заданы — при первом входе роль: ${roleNames[role]}`);

    if (password) {
      const ok = await verifyUserPassword(s, entry.dn, password);
      step(ok, ok ? 'Пароль принят — вход будет работать' : 'Пароль отклонён сервером');
    } else {
      step(true, 'Пароль не указан — проверка пароля пропущена');
    }
  } catch (err) {
    step(false, `Ошибка: ${describeLdapError(err)}`);
  } finally {
    await client?.unbind().catch(() => {});
  }
  return steps;
}
