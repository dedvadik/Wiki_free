/**
 * ============================================================================
 *  services/themes.js — реестр тем оформления
 * ============================================================================
 *  Тема оформления — это папка с двумя файлами:
 *
 *     <id>/theme.json   — описание: название, автор, цвета для превью
 *     <id>/theme.css    — стили темы (необязателен: у «Классической» темы
 *                         его нет, она и есть базовый public/css/app.css)
 *
 *  Где ищутся темы (при старте сервера):
 *     public/themes/<id>/          — встроенные темы
 *     custom/public/themes/<id>/   — ваши темы; тема с тем же id
 *                                    ЗАМЕНЯЕТ встроенную
 *  Обе папки раздаются как статика, поэтому стили темы доступны по адресу
 *  /themes/<id>/theme.css без дополнительного кода.
 *
 *  Как подключаются стили (порядок важен — последний «побеждает»):
 *     app.css  →  theme.css выбранной темы  →  /theme.css (цвета из админки)
 *     →  custom.css
 *  Тема переопределяет CSS-переменные и стили компонентов базового app.css;
 *  цвета, явно заданные в админке, применяются поверх любой темы.
 *
 *  Подробная инструкция по созданию темы — public/themes/README.md.
 * ============================================================================
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

/** Тема по умолчанию. Всегда существует, даже если папку удалили. */
export const DEFAULT_THEME_ID = 'classic';

/* id темы используется в URL и в имени папки — только безопасные символы. */
const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/* Цвета превью вставляются в атрибут style карточки темы — пропускаем
 * только простые значения цветов, чтобы через theme.json нельзя было
 * внедрить посторонний CSS. */
const COLOR_RE = /^(#[0-9a-f]{3,8}|rgba?\(\s*[\d.\s,%]+\)|transparent)$/i;
const PREVIEW_KEYS = ['bg', 'header', 'headerText', 'sidebar', 'card', 'text', 'accent'];

const FALLBACK_PREVIEW = {
  bg: '#ffffff', header: '#0747a6', headerText: '#ffffff', sidebar: '#f4f5f7',
  card: '#ffffff', text: '#172b4d', accent: '#0052cc', radius: 6,
};

let registry = new Map();

/* ----------------------------------------------------------------------------
 * Чтение одной папки с темами. Ошибки (битый JSON, неверный id) не роняют
 * сервер — тема просто пропускается с предупреждением в журнале.
 * ------------------------------------------------------------------------- */
function scanDir(baseDir, source) {
  const themes = [];
  if (!fs.existsSync(baseDir)) return themes;

  for (const id of fs.readdirSync(baseDir)) {
    const dir = path.join(baseDir, id);
    const manifestPath = path.join(dir, 'theme.json');
    if (!fs.statSync(dir).isDirectory() || !fs.existsSync(manifestPath)) continue;
    if (!ID_RE.test(id)) {
      console.warn(`[themes] Пропущена тема «${id}»: имя папки — латиница в нижнем регистре, цифры и дефис`);
      continue;
    }
    try {
      /* replace(/^﻿/) — убираем метку BOM: Блокнот Windows и PowerShell
       * сохраняют UTF-8 с ней, а JSON.parse на ней падает. */
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^﻿/, ''));
      const preview = { ...FALLBACK_PREVIEW };
      for (const key of PREVIEW_KEYS) {
        const value = manifest.preview?.[key];
        if (typeof value === 'string' && COLOR_RE.test(value.trim())) preview[key] = value.trim();
      }
      /* Скругление углов в превью (число пикселей 0–24). */
      const radius = Number(manifest.preview?.radius);
      preview.radius = Number.isFinite(radius) ? Math.min(24, Math.max(0, Math.round(radius))) : 6;
      themes.push({
        id,
        name: String(manifest.name || id).slice(0, 60),
        description: String(manifest.description || '').slice(0, 300),
        author: String(manifest.author || '').slice(0, 100),
        source,
        preview,
        /* URL таблицы стилей, если у темы есть theme.css. */
        stylesheet: fs.existsSync(path.join(dir, 'theme.css')) ? `/themes/${id}/theme.css` : null,
      });
    } catch (err) {
      console.warn(`[themes] Пропущена тема «${id}»: не удалось прочитать theme.json (${err.message})`);
    }
  }
  return themes;
}

/* ----------------------------------------------------------------------------
 * loadThemes — вызывается при старте сервера. Пользовательские темы
 * читаются вторыми и перекрывают встроенные с тем же id.
 * ------------------------------------------------------------------------- */
export function loadThemes() {
  const next = new Map();
  for (const theme of scanDir(path.join(config.publicDir, 'themes'), 'built-in')) next.set(theme.id, theme);
  for (const theme of scanDir(path.join(config.customDir, 'public', 'themes'), 'custom')) next.set(theme.id, theme);

  /* Страховка: тема по умолчанию есть всегда. */
  if (!next.has(DEFAULT_THEME_ID)) {
    next.set(DEFAULT_THEME_ID, {
      id: DEFAULT_THEME_ID, name: 'Классическая', description: '', author: '', source: 'built-in',
      preview: FALLBACK_PREVIEW, stylesheet: null,
    });
  }
  registry = next;
  console.log(`[themes] Темы оформления: ${[...registry.keys()].join(', ')}`);
}

/** Все темы: «Классическая» первой, остальные по названию. */
export function getThemes() {
  return [...registry.values()].sort((a, b) => {
    if (a.id === DEFAULT_THEME_ID) return -1;
    if (b.id === DEFAULT_THEME_ID) return 1;
    return a.name.localeCompare(b.name, 'ru');
  });
}

/** Тема по id или null. */
export function getTheme(id) {
  return registry.get(String(id ?? '')) ?? null;
}

export function hasTheme(id) {
  return registry.has(String(id ?? ''));
}
