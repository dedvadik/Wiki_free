/**
 * ============================================================================
 *  services/theme.js — генерация /theme.css из настроек админ-панели
 * ============================================================================
 *  Все стили сайта (public/css/app.css и темы оформления из public/themes)
 *  используют CSS-переменные: var(--primary), var(--header-bg), var(--radius)…
 *
 *  Порядок подключения стилей на странице:
 *     app.css  →  стили выбранной темы  →  /theme.css (этот файл)  →  custom.css
 *
 *  /theme.css переопределяет переменные ТОЛЬКО для тех настроек, которые
 *  администратор явно заполнил. Пустое поле («как в теме») не выводится —
 *  и тогда действует значение выбранной темы. Так фирменный цвет компании,
 *  заданный один раз, применяется поверх любой темы, а всё остальное
 *  остаётся «родным» для темы.
 *
 *  Переменные пишутся сразу для двух селекторов — :root и
 *  :root[data-mode="dark"]. Второй специфичнее, и без него тёмный режим темы
 *  перекрывал бы значения из админки.
 *
 *  Безопасность: все значения прошли проверку в settings.normalizeValue
 *  (цвет — строго #RRGGBB, числа — в диапазоне), поэтому внедрить через них
 *  посторонний CSS нельзя.
 * ============================================================================
 */
import { CONTENT_WIDTHS, FONT_STACKS } from './settings.js';

export function buildThemeCss(s) {
  /* Переопределения «поверх темы» — только заполненные. */
  const vars = [];
  if (s.primary_color) vars.push(`--primary: ${s.primary_color};`);
  if (s.header_bg) vars.push(`--header-bg: ${s.header_bg};`);
  if (s.header_text) vars.push(`--header-text: ${s.header_text};`);
  if (FONT_STACKS[s.font_family]) vars.push(`--font-body: ${FONT_STACKS[s.font_family]};`);
  if (s.border_radius !== '' && s.border_radius !== null && s.border_radius !== undefined) {
    vars.push(`--radius: ${s.border_radius}px;`);
  }

  /* Параметры раскладки не зависят от темы и выводятся всегда. */
  vars.push(`--content-font-size: ${s.font_size}px;`);
  vars.push(`--content-max: ${CONTENT_WIDTHS[s.content_width] ?? CONTENT_WIDTHS.normal};`);
  vars.push(`--sidebar-width: ${s.sidebar_width}px;`);

  return `/* ==========================================================
   theme.css — СГЕНЕРИРОВАНО АВТОМАТИЧЕСКИ из настроек
   «Администрирование → Настройки». Не редактируйте вручную.
   ========================================================== */
:root,
:root[data-mode="dark"] {
  ${vars.join('\n  ')}
}

/* ---------- Пользовательский CSS из админ-панели ---------- */
${s.custom_css ?? ''}
`;
}
