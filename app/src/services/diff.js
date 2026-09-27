/**
 * ============================================================================
 *  services/diff.js — построчное сравнение двух версий страницы
 * ============================================================================
 *  Используется на странице «Сравнение версий». Библиотека `diff` (jsdiff)
 *  находит минимальный набор добавленных/удалённых фрагментов, а мы
 *  превращаем его в список строк для таблицы в стиле GitHub:
 *
 *     12   12     неизменённая строка        (type: 'ctx')
 *     13    -     удалённая строка            (type: 'del')
 *      -   13     добавленная строка          (type: 'add')
 *     ···  скрыто 40 неизменённых строк  ···  (type: 'skip')
 *
 *  Длинные неизменённые участки сворачиваются, остаётся только `context`
 *  строк вокруг каждого изменения — так легче увидеть суть правок.
 * ============================================================================
 */
import { diffLines } from 'diff';

export function buildLineDiff(oldText, newText, context = 3) {
  /* ---- 1. Разворачиваем фрагменты diff в отдельные строки с номерами ---- */
  const rows = [];
  let oldNo = 1;
  let newNo = 1;
  let added = 0;
  let removed = 0;

  for (const part of diffLines(oldText ?? '', newText ?? '')) {
    /* Фрагмент обычно заканчивается \n — убираем его, чтобы split не дал
     * лишнюю пустую строку в конце. */
    const lines = part.value.replace(/\n$/, '').split('\n');
    for (const text of lines) {
      if (part.added) {
        rows.push({ type: 'add', oldNo: null, newNo: newNo++, text });
        added++;
      } else if (part.removed) {
        rows.push({ type: 'del', oldNo: oldNo++, newNo: null, text });
        removed++;
      } else {
        rows.push({ type: 'ctx', oldNo: oldNo++, newNo: newNo++, text });
      }
    }
  }

  /* ---- 2. Отмечаем строки, которые нужно показать: все изменённые и
   *         `context` строк до и после каждой из них ---- */
  const visible = new Array(rows.length).fill(false);
  rows.forEach((row, i) => {
    if (row.type === 'ctx') return;
    const from = Math.max(0, i - context);
    const to = Math.min(rows.length - 1, i + context);
    for (let j = from; j <= to; j++) visible[j] = true;
  });

  /* ---- 3. Собираем результат, заменяя подряд идущие скрытые строки
   *         одной строкой-разделителем 'skip' с их количеством ---- */
  const result = [];
  let hidden = 0;
  rows.forEach((row, i) => {
    if (visible[i]) {
      if (hidden) result.push({ type: 'skip', count: hidden });
      hidden = 0;
      result.push(row);
    } else {
      hidden++;
    }
  });
  if (hidden) result.push({ type: 'skip', count: hidden });

  return { rows: result, added, removed };
}
