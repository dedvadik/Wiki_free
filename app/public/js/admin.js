/* ============================================================================
   admin.js — удобства страницы «Настройки сайта»
   ============================================================================
     1. Поля цвета «поверх темы» состоят из палитры и текстового поля
        (#RRGGBB или пусто = «как в теме»). Отправляется текстовое поле,
        палитра лишь помогает выбрать цвет — синхронизируем их.
     2. Цветовые пресеты: кнопка с data-preset='{"primary_color":"#..."}'
        заполняет поля; пустые значения («Цвета темы») очищают их.
        Сохраняется всё только по кнопке «Сохранить настройки».
     3. Живой предпросмотр: пока настройки не сохранены, меняем
        CSS-переменные текущей страницы — сразу видно результат. Очищенное
        поле убирает переопределение, и возвращается цвет темы.
   ============================================================================ */
(function () {
  'use strict';

  const form = document.getElementById('settings-form');
  if (!form) return;

  /* Соответствие «поле настройки → CSS-переменная» для живого предпросмотра. */
  const CSS_VARS = {
    primary_color: '--primary',
    header_bg: '--header-bg',
    header_text: '--header-text',
  };
  const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

  /* Применить значение поля к странице (или убрать переопределение). */
  function preview(name, value) {
    const cssVar = CSS_VARS[name];
    if (!cssVar) return;
    if (HEX_RE.test(value)) document.documentElement.style.setProperty(cssVar, value);
    else if (value === '') document.documentElement.style.removeProperty(cssVar);
  }

  /* Текстовое поле изменилось → обновить палитру и предпросмотр. */
  function syncFromText(textInput) {
    const swatch = form.querySelector(`[data-color-for="${textInput.id}"]`);
    const value = textInput.value.trim();
    if (swatch && HEX_RE.test(value) && value.length === 7) swatch.value = value.toLowerCase();
    preview(textInput.name, value);
  }

  /* ---- 1. Необязательные цвета: палитра ↔ текст ---- */
  form.querySelectorAll('[data-color-for]').forEach((swatch) => {
    const textInput = document.getElementById(swatch.dataset.colorFor);
    swatch.addEventListener('input', () => {
      textInput.value = swatch.value;
      preview(textInput.name, swatch.value);
    });
    textInput.addEventListener('input', () => syncFromText(textInput));
  });

  form.querySelectorAll('[data-color-clear]').forEach((button) => {
    button.addEventListener('click', () => {
      const textInput = document.getElementById(button.dataset.colorClear);
      textInput.value = '';
      syncFromText(textInput);
    });
  });

  /* Обязательные цвета (обычная палитра с подписью HEX-кода). */
  form.querySelectorAll('input[type="color"][name]').forEach((input) => {
    input.addEventListener('input', () => {
      const label = form.querySelector(`[data-color-value-for="${input.id}"]`);
      if (label) label.textContent = input.value;
      preview(input.name, input.value);
    });
  });

  /* ---- 2. Цветовые пресеты ---- */
  form.querySelectorAll('[data-preset]').forEach((button) => {
    button.addEventListener('click', () => {
      const values = JSON.parse(button.dataset.preset);
      Object.entries(values).forEach(([name, value]) => {
        const input = form.elements.namedItem(name);
        if (!input) return;
        input.value = value;
        if (input.type === 'color') input.dispatchEvent(new Event('input'));
        else syncFromText(input);
      });
    });
  });
})();
