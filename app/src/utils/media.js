/**
 * ============================================================================
 *  utils/media.js — какие файлы портал показывает прямо в браузере
 * ============================================================================
 *  Один список на весь сайт: его используют загрузка файлов
 *  (routes/uploads.js), разметка статей (services/markdown.js — видео
 *  вместо картинки) и редактор (атрибут data-video-ext формы).
 *
 *  Видео: форматы, которые умеют воспроизводить сами браузеры, без плагинов.
 *  Тип (MIME) определяется по расширению, а не по тому, что прислал браузер
 *  при загрузке: для .mov он часто присылает application/octet-stream, и
 *  тогда плеер отказался бы играть файл.
 *    .mp4 / .m4v — H.264 + AAC: играет везде (самый надёжный вариант);
 *    .webm       — VP8/VP9/AV1: Chrome, Edge, Firefox, Safari 14.1+;
 *    .ogv        — Ogg: Firefox (в Chrome/Edge Theora больше не поддерживается);
 *    .mov        — видео с iPhone/Mac: играет, если внутри H.264; HEVC —
 *                  только Safari и часть браузеров с аппаратной поддержкой.
 *  AVI, MKV, WMV браузеры не воспроизводят — такие файлы остаются
 *  обычными вложениями «на скачивание».
 * ============================================================================
 */
import path from 'node:path';

/* Расширение → MIME-тип для воспроизводимых видео. */
export const VIDEO_TYPES = Object.freeze({
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.mov': 'video/quicktime',
});

/* Растровые картинки, которые безопасно показывать прямо в браузере (SVG
 * сюда не входит: внутри него может быть скрипт). */
export const INLINE_IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.ico']);

/** Расширения видео без точки через запятую — для атрибута data-video-ext редактора. */
export const VIDEO_EXT_LIST = Object.keys(VIDEO_TYPES).map((ext) => ext.slice(1)).join(',');

/**
 * MIME-тип видео по имени файла или адресу (query и #якорь отбрасываются),
 * либо null, если это не воспроизводимое видео.
 */
export function videoTypeFor(nameOrUrl) {
  const clean = String(nameOrUrl ?? '').split(/[?#]/)[0];
  return VIDEO_TYPES[path.extname(clean).toLowerCase()] ?? null;
}
