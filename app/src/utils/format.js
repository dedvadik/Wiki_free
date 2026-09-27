/**
 * ============================================================================
 *  utils/format.js — форматирование дат, размеров и чисел для шаблонов
 * ============================================================================
 *  Все функции отсюда доступны в каждом EJS-шаблоне (см. middleware/locals.js),
 *  например: <%= timeAgo(page.updated_at) %>.
 *  Часовой пояс берётся из переменной окружения TZ контейнера.
 * ============================================================================
 */

/* Форматтеры Intl создаются один раз — это заметно быстрее, чем на каждый вызов. */
const dateTimeFormatter = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
});
const dateFormatter = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
const relativeFormatter = new Intl.RelativeTimeFormat('ru', { numeric: 'auto' });

/** «25 сентября 2026 г., 14:05» */
export function formatDateTime(value) {
  return value ? dateTimeFormatter.format(new Date(value)) : '';
}

/** «25 сентября 2026 г.» */
export function formatDate(value) {
  return value ? dateFormatter.format(new Date(value)) : '';
}

/* ----------------------------------------------------------------------------
 * timeAgo — относительное время: «5 минут назад», «вчера», «3 дня назад».
 * Для дат старше месяца выводим обычную дату — так понятнее.
 * ------------------------------------------------------------------------- */
export function timeAgo(value) {
  if (!value) return '';
  const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 45) return 'только что';
  if (abs < 3600) return relativeFormatter.format(Math.round(seconds / 60), 'minute');
  if (abs < 86400) return relativeFormatter.format(Math.round(seconds / 3600), 'hour');
  if (abs < 86400 * 30) return relativeFormatter.format(Math.round(seconds / 86400), 'day');
  return formatDate(value);
}

/** Размер файла в человекочитаемом виде: 1536 → «1,5 КБ». */
export function fileSize(bytes) {
  const units = ['Б', 'КБ', 'МБ', 'ГБ'];
  let size = Number(bytes) || 0;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  return `${size.toLocaleString('ru-RU', { maximumFractionDigits: unit ? 1 : 0 })} ${units[unit]}`;
}

/* ----------------------------------------------------------------------------
 * authorName — имя автора для вывода. Когда администратор удаляет
 * пользователя, его статьи, правки и комментарии остаются, а ссылка на
 * автора в БД становится NULL (ON DELETE SET NULL) — показываем пометку.
 * ------------------------------------------------------------------------- */
export function authorName(name) {
  return name || 'удалённый пользователь';
}

/* ----------------------------------------------------------------------------
 * avatarHue — оттенок (0–359) цвета аватара, стабильно вычисленный из имени:
 * у каждого пользователя свой цвет, и он не меняется между страницами.
 * В шаблоне: <span class="avatar" style="--avatar-h: <%= avatarHue(name) %>">
 * ------------------------------------------------------------------------- */
export function avatarHue(name) {
  let hash = 0;
  for (const ch of String(name ?? '')) hash = (hash * 31 + ch.codePointAt(0)) % 360;
  return hash;
}

/* ----------------------------------------------------------------------------
 * plural — русское склонение слова после числа:
 *   plural(1, 'страница', 'страницы', 'страниц') → «1 страница»
 *   plural(3, ...) → «3 страницы»,  plural(11, ...) → «11 страниц»
 * ------------------------------------------------------------------------- */
export function plural(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  let word = many;
  if (mod10 === 1 && mod100 !== 11) word = one;
  else if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) word = few;
  return `${n} ${word}`;
}
