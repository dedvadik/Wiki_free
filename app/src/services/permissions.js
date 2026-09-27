/**
 * ============================================================================
 *  services/permissions.js — права доступа к пространствам
 * ============================================================================
 *  Глобальная роль пользователя (users.role) задаёт ПОТОЛОК его прав, а
 *  настройки пространства — где именно эти права действуют:
 *
 *   Администратор — может всё во всех пространствах.
 *   Владелец      — (spaces.owner_id, изначально создатель) управляет правами
 *                   и настройками своего пространства, видит его всегда.
 *   Редактор      — правит статьи там, где пространство это разрешает:
 *                   edit_policy = 'editors' (все редакторы, видящие
 *                   пространство) или он участник с доступом 'edit'.
 *   Читатель      — читает всё открытое (visibility = 'public') и закрытые
 *                   пространства, куда его добавили участником.
 *
 *  Читатель, даже добавленный с доступом 'edit', править не может: право
 *  редактирования есть только у глобальной роли «Редактор» и выше.
 *
 *  Модуль даёт два инструмента:
 *   1. getSpaceAccess(user, space) — права на ОДНО пространство
 *      (страница пространства, статья, редактор, файлы);
 *   2. readableSpacesSql / editableSpacesSql — SQL-условие для СПИСКОВ
 *      (поиск, лента изменений, метки, каталог пространств), чтобы
 *      закрытое не просачивалось в выдачу.
 * ============================================================================
 */
import { one } from '../db/pool.js';
import { HttpError } from '../utils/http.js';
import { hasRole } from './users.js';

/* Подписи вариантов — для интерфейса страницы «Права доступа». */
export const VISIBILITY = {
  public: { label: 'Открытое', description: 'Читать могут все, кому доступен сайт' },
  restricted: { label: 'Закрытое', description: 'Читать могут только владелец, участники и администраторы' },
};

export const EDIT_POLICY = {
  editors: { label: 'Все редакторы', description: 'Любой пользователь с ролью «Редактор», который видит пространство' },
  members: { label: 'Только участники', description: 'Только участники с доступом «Редактирование», владелец и администраторы' },
};

export const ACCESS_LEVELS = {
  read: 'Чтение',
  edit: 'Редактирование',
};

/* ----------------------------------------------------------------------------
 * getSpaceAccess — что пользователь может делать в пространстве.
 *   user  — req.user или null (гость)
 *   space — строка spaces (нужны id, owner_id, visibility, edit_policy)
 * Возвращает { canRead, canEdit, canManage, isOwner, member }.
 * member — уровень участника ('read' | 'edit') или null.
 * ------------------------------------------------------------------------- */
export async function getSpaceAccess(user, space) {
  const isAdmin = hasRole(user, 'admin');
  if (isAdmin) return { canRead: true, canEdit: true, canManage: true, isOwner: space.owner_id === user.id, member: null };

  const isOwner = Boolean(user) && space.owner_id === user.id;
  const row = user
    ? await one('SELECT access FROM space_members WHERE space_id = $1 AND user_id = $2', [space.id, user.id])
    : null;
  const member = row?.access ?? null;

  const canRead = space.visibility === 'public' || isOwner || member !== null;
  const canEdit = canRead
    && hasRole(user, 'editor')
    && (space.edit_policy === 'editors' || isOwner || member === 'edit');

  return { canRead, canEdit, canManage: isOwner, isOwner, member };
}

/* ----------------------------------------------------------------------------
 * requireSpaceAccess — «охранник» для маршрутов:
 *   requireSpaceAccess(req, access, 'read' | 'edit' | 'manage')
 * Гостю — 401 со ссылкой на вход (после входа он вернётся сюда же):
 * возможно, у него есть доступ. Вошедшему без прав — 403.
 * ------------------------------------------------------------------------- */
const DENIED = {
  read: 'Это закрытое пространство. Попросите его владельца или администратора открыть вам доступ.',
  edit: 'У вас нет прав на редактирование в этом пространстве.',
  manage: 'Управлять правами пространства может только его владелец или администратор.',
};

export function requireSpaceAccess(req, access, level) {
  const allowed = { read: access.canRead, edit: access.canEdit, manage: access.canManage }[level];
  if (allowed) return;
  if (!req.user) {
    if (req.method === 'GET') req.session.returnTo = req.originalUrl;
    throw new HttpError(401, 'Войдите, чтобы открыть эту страницу: она может быть в закрытом пространстве.');
  }
  throw new HttpError(403, DENIED[level]);
}

/* ----------------------------------------------------------------------------
 * SQL-условия для списков. Используют два параметра запроса:
 *   adminParam — boolean «пользователь администратор» (видит всё);
 *   userParam  — id пользователя или NULL для гостя (сравнение с NULL
 *                всегда ложно, поэтому гость видит только открытое).
 * alias — псевдоним таблицы spaces в запросе.
 *
 * Пример:
 *   const [isAdmin, userId] = accessParams(req.user);
 *   many(`SELECT … FROM pages p JOIN spaces s ON s.id = p.space_id
 *          WHERE ${readableSpacesSql('s', '$1', '$2')}`, [isAdmin, userId]);
 * ------------------------------------------------------------------------- */
export function accessParams(user) {
  return [hasRole(user, 'admin'), user?.id ?? null];
}

export function readableSpacesSql(alias, adminParam, userParam) {
  return `(${adminParam}::boolean
    OR ${alias}.visibility = 'public'
    OR ${alias}.owner_id = ${userParam}::int
    OR EXISTS (SELECT 1 FROM space_members sm
                WHERE sm.space_id = ${alias}.id AND sm.user_id = ${userParam}::int))`;
}

/* Где пользователь может править (для выбора пространства в «+ Создать»).
 * Глобальную роль «Редактор» проверяет маршрут (requireRole). */
export function editableSpacesSql(alias, adminParam, userParam) {
  return `(${adminParam}::boolean
    OR ${alias}.owner_id = ${userParam}::int
    OR EXISTS (SELECT 1 FROM space_members sm
                WHERE sm.space_id = ${alias}.id AND sm.user_id = ${userParam}::int AND sm.access = 'edit')
    OR (${alias}.edit_policy = 'editors' AND ${readableSpacesSql(alias, adminParam, userParam)}))`;
}
