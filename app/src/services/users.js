/**
 * ============================================================================
 *  services/users.js — пользователи, роли, пароли
 * ============================================================================
 *  Здесь собрана вся логика, связанная с учётными записями:
 *   - модель ролей и проверка прав (hasRole)
 *   - хеширование и проверка паролей (bcrypt)
 *   - валидация данных при регистрации / редактировании
 *   - создание пользователя и аутентификация по логину или email
 * ============================================================================
 */
import bcrypt from 'bcryptjs';
import { config } from '../config.js';
import { one } from '../db/pool.js';
import { compareInPool, hashInPool } from './password-pool.js';

/* ----------------------------------------------------------------------------
 * Роли упорядочены по возрастанию прав. Проверка «есть ли у пользователя
 * роль editor» означает «editor ИЛИ выше» (т.е. admin тоже подходит).
 * Чтобы добавить роль (например, 'moderator'), впишите её в ROLE_LEVEL,
 * ROLE_NAMES и в CHECK-ограничение таблицы users (новой миграцией).
 * ------------------------------------------------------------------------- */
const ROLE_LEVEL = { viewer: 1, editor: 2, admin: 3 };

export const ROLES = Object.keys(ROLE_LEVEL);

export const ROLE_NAMES = {
  viewer: 'Читатель',
  editor: 'Редактор',
  admin: 'Администратор',
};

/** true, если у пользователя есть указанная роль или более высокая. */
export function hasRole(user, role) {
  return Boolean(user) && (ROLE_LEVEL[user.role] ?? 0) >= ROLE_LEVEL[role];
}

/* ----------------------------------------------------------------------------
 * Ошибка валидации: её сообщение безопасно показывать пользователю.
 * ------------------------------------------------------------------------- */
export class ValidationError extends Error {}

/* ----------------------------------------------------------------------------
 * Пароли. bcrypt — медленная (намеренно) функция хеширования со встроенной
 * «солью»: даже одинаковые пароли дают разные хеши, а перебор утёкшей базы
 * становится очень дорогим. bcryptjs — реализация на чистом JavaScript.
 * Вычисления идут в пуле потоков (services/password-pool.js), чтобы вход
 * одного пользователя не задерживал запросы всех остальных.
 * ------------------------------------------------------------------------- */
export function hashPassword(password) {
  return hashInPool(password, config.bcryptRounds);
}

export function verifyPassword(password, hash) {
  return compareInPool(password, hash);
}

/* Фиктивный хеш для защиты от timing-атаки: если пользователь НЕ найден, мы
 * всё равно выполняем сравнение пароля, чтобы время ответа не выдавало,
 * существует ли такой логин. */
const DUMMY_HASH = bcrypt.hashSync('timing-attack-protection', 10);

/* ----------------------------------------------------------------------------
 * Валидация полей пользователя. Возвращает массив текстов ошибок
 * (пустой массив — всё хорошо).
 *   checkPassword=false — при редактировании профиля без смены пароля.
 * ------------------------------------------------------------------------- */
export function validateUserInput({ username, email, displayName, password }, { checkPassword = true, checkUsername = true } = {}) {
  const errors = [];

  if (checkUsername && !/^[a-zA-Z0-9_.-]{3,50}$/.test(username ?? '')) {
    errors.push('Логин: 3–50 символов, латинские буквы, цифры и знаки _ . -');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email ?? '') || email.length > 255) {
    errors.push('Укажите корректный email');
  }
  if (!displayName || displayName.length > 100) {
    errors.push('Отображаемое имя обязательно (до 100 символов)');
  }
  if (checkPassword) {
    errors.push(...validatePassword(password));
  }
  return errors;
}

/** Правила пароля. bcrypt учитывает только первые 72 БАЙТА, поэтому длиннее не разрешаем. */
export function validatePassword(password) {
  const errors = [];
  if (!password || password.length < 8) errors.push('Пароль должен быть не короче 8 символов');
  else if (Buffer.byteLength(password, 'utf8') > 72) errors.push('Пароль слишком длинный (максимум 72 байта)');
  return errors;
}

/* ----------------------------------------------------------------------------
 * Создание пользователя. Логин и email приводятся к нижнему регистру/без
 * пробелов. Нарушение уникальности (код PostgreSQL 23505) превращаем в
 * понятную ошибку валидации.
 * ------------------------------------------------------------------------- */
export async function createUser({ username, email, displayName, password, role = 'viewer' }) {
  const passwordHash = await hashPassword(password);
  try {
    return await one(
      `INSERT INTO users (username, email, display_name, password_hash, role)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, username, email, display_name, role, is_active`,
      [username.trim(), email.trim().toLowerCase(), displayName.trim(), passwordHash, role],
    );
  } catch (err) {
    if (err.code === '23505') throw new ValidationError('Пользователь с таким логином или email уже существует');
    throw err;
  }
}

/* ----------------------------------------------------------------------------
 * Поиск пользователя по логину ИЛИ email (без учёта регистра).
 * Совпадение по логину приоритетнее совпадения по email.
 * ------------------------------------------------------------------------- */
export function findUserByLogin(login) {
  return one(
    `SELECT * FROM users
      WHERE lower(username) = lower($1) OR lower(email) = lower($1)
      ORDER BY (lower(username) = lower($1)) DESC
      LIMIT 1`,
    [String(login ?? '').trim()],
  );
}

/* ----------------------------------------------------------------------------
 * checkLocalPassword — верен ли пароль ЛОКАЛЬНОЙ учётной записи.
 * Если пользователя нет или у него нет локального пароля (LDAP), всё равно
 * выполняем сравнение с фиктивным хешем — время ответа одинаковое.
 * ------------------------------------------------------------------------- */
export async function checkLocalPassword(user, password) {
  const hasLocalPassword = user?.auth_source === 'local' && Boolean(user.password_hash);
  const ok = await verifyPassword(String(password ?? ''), hasLocalPassword ? user.password_hash : DUMMY_HASH);
  return hasLocalPassword && ok;
}

/* ----------------------------------------------------------------------------
 * upsertLdapUser — создать или обновить учётную запись по профилю из LDAP.
 * Ищем ранее созданного LDAP-пользователя по DN (основной ключ) или логину
 * (на случай, если запись перенесли в другую ветку каталога и DN изменился).
 * Имя, email и DN при каждом входе синхронизируются с каталогом; роль —
 * только если она управляется группами (roleManaged).
 * Локальную учётную запись с тем же логином/email НЕ трогаем — вместо этого
 * ошибка: иначе LDAP-пользователь мог бы «захватить» чужой аккаунт.
 * ------------------------------------------------------------------------- */
export async function upsertLdapUser(profile) {
  const existing = await one(
    `SELECT id FROM users
      WHERE auth_source = 'ldap' AND (lower(ldap_dn) = lower($1) OR lower(username) = lower($2))
      ORDER BY (lower(ldap_dn) = lower($1)) DESC
      LIMIT 1`,
    [profile.dn, profile.username],
  );
  try {
    if (existing) {
      return await one(
        `UPDATE users
            SET ldap_dn = $2, username = $3, email = $4, display_name = $5,
                role = CASE WHEN $6::boolean THEN $7 ELSE role END
          WHERE id = $1
          RETURNING *`,
        [existing.id, profile.dn, profile.username, profile.email, profile.displayName, profile.roleManaged, profile.role],
      );
    }
    return await one(
      `INSERT INTO users (username, email, display_name, password_hash, role, auth_source, ldap_dn)
       VALUES ($1, $2, $3, NULL, $4, 'ldap', $5)
       RETURNING *`,
      [profile.username, profile.email, profile.displayName, profile.role, profile.dn],
    );
  } catch (err) {
    if (err.code === '23505') {
      throw new ValidationError('Логин или email из каталога LDAP уже заняты локальной учётной записью. Обратитесь к администратору.');
    }
    throw err;
  }
}

/* Инициалы для аватара: "Иван Петров" → "ИП". */
export function initials(name) {
  return String(name ?? '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('') || '?';
}
