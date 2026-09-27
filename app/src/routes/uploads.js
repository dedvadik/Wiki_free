/**
 * ============================================================================
 *  routes/uploads.js — загрузка и отдача вложений (картинки, документы)
 * ============================================================================
 *  Маршруты:
 *    POST /api/uploads               — загрузка файла из редактора (право правки страницы),
 *                                      отвечает JSON с готовой Markdown-ссылкой
 *    GET  /uploads/:name             — скачивание/просмотр файла (право чтения пространства)
 *    POST /attachments/:id/delete    — удаление вложения (право правки страницы)
 *
 *  Меры безопасности:
 *   - файл сохраняется под СЛУЧАЙНЫМ именем (UUID) — пользователь не может
 *     перезаписать чужой файл или «выйти» из папки через ../;
 *   - «в браузере» (inline) показываются только растровые картинки и видео
 *     (списки — src/utils/media.js); всё остальное (html, svg, js…)
 *     отдаётся как скачиваемый файл — иначе загруженный HTML мог бы
 *     выполнить скрипт от имени нашего сайта;
 *   - дополнительно ответ содержит CSP sandbox и X-Content-Type-Options.
 *
 *  Видео: свой лимит размера (VIDEO_MAX_MB, по умолчанию 200 МБ; остальные
 *  файлы — UPLOAD_MAX_MB, 20 МБ), тип определяется по расширению, а при
 *  отдаче поддерживаются HTTP Range-запросы (их обрабатывает sendFile):
 *  плеер может перематывать ролик, не скачивая его целиком.
 * ============================================================================
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { config } from '../config.js';
import { one, query } from '../db/pool.js';
import { requireRole } from '../middleware/auth.js';
import { getSpaceAccess } from '../services/permissions.js';
import { hasRole } from '../services/users.js';
import { backUrl, HttpError, parseId } from '../utils/http.js';
import { INLINE_IMAGE_EXT, videoTypeFor } from '../utils/media.js';

export const uploadsRouter = Router();

/* ----------------------------------------------------------------------------
 * Права пользователя на пространство, которому принадлежит страница.
 * null — страницы нет (файл «ничей»: загружен для ещё не сохранённой
 * страницы или страницу удалили).
 * ------------------------------------------------------------------------- */
async function accessForPage(user, pageId) {
  if (!pageId) return null;
  const space = await one(
    `SELECT s.id, s.owner_id, s.visibility, s.edit_policy
       FROM pages p JOIN spaces s ON s.id = p.space_id
      WHERE p.id = $1`,
    [pageId],
  );
  return space ? getSpaceAccess(user, space) : null;
}

const MB = 1024 * 1024;

/** Лимит размера для файла с таким именем (видео — свой). */
const limitMbFor = (name) => (videoTypeFor(name) ? config.videoMaxMb : config.uploadMaxMb);

/* Понятное сообщение о превышении размера — с обоими лимитами. */
const tooBigMessage = () => `Файл слишком большой: видео — до ${config.videoMaxMb} МБ, остальные файлы — до ${config.uploadMaxMb} МБ`;

/* ----------------------------------------------------------------------------
 * Настройка multer — библиотеки приёма файлов (multipart/form-data).
 *  - diskStorage: пишем файл сразу на диск потоком, не держа его в памяти;
 *  - имя файла: UUID + исходное расширение (если оно «нормальное»);
 *  - limits: больший из двух лимитов (видео / остальные файлы) и не больше
 *    одного файла за запрос. multer не умеет разный лимит для разных файлов,
 *    поэтому «обычный» файл больше UPLOAD_MAX_MB отклоняется уже после
 *    приёма (см. обработчик ниже);
 *  - defParamCharset utf8: корректные кириллические имена файлов.
 * ------------------------------------------------------------------------- */
const upload = multer({
  storage: multer.diskStorage({
    destination: config.uploadsDir,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${crypto.randomUUID()}${/^\.[a-z0-9]{1,10}$/.test(ext) ? ext : ''}`);
    },
  }),
  limits: { fileSize: Math.max(config.uploadMaxMb, config.videoMaxMb) * MB, files: 1 },
  defParamCharset: 'utf8',
});

/* =============================== ЗАГРУЗКА ================================ */

uploadsRouter.post(
  '/api/uploads',
  requireRole('editor'),
  /* Оборачиваем multer, чтобы его ошибки (слишком большой файл и т.п.)
   * превращались в понятный JSON-ответ, а не в страницу 500. */
  (req, res, next) => {
    upload.single('file')(req, res, (err) => {
      if (!err) return next();
      const message = err.code === 'LIMIT_FILE_SIZE'
        ? tooBigMessage()
        : `Ошибка загрузки: ${err.message}`;
      return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: message });
    });
  },
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Файл не получен' });

    /* Свой лимит для видео и для остальных файлов (multer проверил только
     * больший из них). */
    if (req.file.size > limitMbFor(req.file.originalname) * MB) {
      await fs.unlink(req.file.path).catch(() => {});
      return res.status(413).json({ error: tooBigMessage() });
    }

    /* Если загрузка идёт из редактора существующей страницы — сразу
     * привязываем файл к ней. Для новой страницы привязка произойдёт при
     * первом сохранении (см. linkAttachments). */
    const pageId = Number.parseInt(req.body.page_id, 10);
    const page = Number.isInteger(pageId) ? await one('SELECT id FROM pages WHERE id = $1', [pageId]) : null;

    /* Загружать в страницу может только тот, кто может её править.
     * multer уже записал файл на диск (page_id приходит в том же
     * multipart-теле) — при отказе удаляем его. */
    const access = await accessForPage(req.user, page?.id);
    if (access && !access.canEdit) {
      await fs.unlink(req.file.path).catch(() => {});
      return res.status(403).json({ error: 'Нет прав на редактирование в этом пространстве' });
    }

    const originalName = req.file.originalname.slice(0, 255);
    /* Тип видео — по расширению (браузер для .mov часто присылает
     * application/octet-stream, и плеер отказался бы играть файл). */
    const videoType = videoTypeFor(req.file.filename);
    const mimeType = videoType || req.file.mimetype || 'application/octet-stream';
    const { rows: [attachment] } = await query(
      `INSERT INTO attachments (page_id, stored_name, original_name, mime_type, size_bytes, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [page?.id ?? null, req.file.filename, originalName, mimeType, req.file.size, req.user.id],
    );

    const url = `/uploads/${req.file.filename}`;
    const isImage = INLINE_IMAGE_EXT.has(path.extname(req.file.filename)) && mimeType.startsWith('image/');
    const isVideo = Boolean(videoType);
    /* Квадратные скобки в имени сломали бы Markdown-ссылку — заменяем.
     * Видео вставляется тем же синтаксисом, что и картинка: services/
     * markdown.js превращает ![…](файл.mp4) в плеер. */
    const label = originalName.replace(/[[\]]/g, '');
    return res.json({
      id: attachment.id,
      url,
      name: originalName,
      isImage,
      isVideo,
      markdown: isImage || isVideo ? `![${label}](${url})` : `[📎 ${label}](${url})`,
    });
  },
);

/* =============================== ОТДАЧА ==================================
 * Маршрут подключён ПОСЛЕ siteAccess — в закрытой вики файлы тоже
 * доступны только вошедшим пользователям. Файл страницы из закрытого
 * пространства отдаётся только тем, кто может это пространство читать;
 * остальным — 404, как будто файла нет (не раскрываем его существование).
 * ========================================================================= */
uploadsRouter.get('/uploads/:name', async (req, res) => {
  const { name } = req.params;
  /* Строгая проверка формата имени: UUID + необязательное расширение. */
  if (!/^[0-9a-f-]{36}(\.[a-z0-9]{1,10})?$/.test(name)) throw new HttpError(404, 'Файл не найден');

  const file = await one('SELECT * FROM attachments WHERE stored_name = $1', [name]);
  if (!file) throw new HttpError(404, 'Файл не найден');
  const access = await accessForPage(req.user, file.page_id);
  if (access && !access.canRead) throw new HttpError(404, 'Файл не найден');

  const videoType = videoTypeFor(name);
  const inline = Boolean(videoType) || (INLINE_IMAGE_EXT.has(path.extname(name)) && file.mime_type.startsWith('image/'));

  /* CSP действует и тогда, когда файл открыли прямо в отдельной вкладке:
   * браузер строит вокруг картинки или видео служебную страницу, которой
   * нужно загрузить сам файл, — отсюда img-src и media-src 'self'. */
  res.set({
    'Cache-Control': 'private, max-age=86400',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox",
  });
  if (videoType) {
    /* Видео: тип по расширению; sendFile сам отвечает на Range-запросы
     * (206 Partial Content) — перемотка без скачивания всего файла. */
    res.type(videoType);
  } else if (inline) {
    res.type(file.mime_type);
  } else {
    /* attachment → браузер предложит сохранить файл, а не откроет его. */
    res.attachment(file.original_name);
    res.type('application/octet-stream');
  }

  return res.sendFile(path.join(config.uploadsDir, name), (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
});

/* =============================== УДАЛЕНИЕ ================================ */

/* Удалить вложение страницы может тот, кто может её править; «ничейное»
 * вложение — загрузивший его пользователь или администратор. */
uploadsRouter.post('/attachments/:id/delete', requireRole('editor'), async (req, res) => {
  const file = await one('SELECT * FROM attachments WHERE id = $1', [parseId(req.params.id)]);
  if (!file) throw new HttpError(404, 'Вложение не найдено');
  const access = await accessForPage(req.user, file.page_id);
  const allowed = access ? access.canEdit : (file.uploaded_by === req.user.id || hasRole(req.user, 'admin'));
  if (!allowed) throw new HttpError(403, 'Нет прав на удаление этого вложения');

  await query('DELETE FROM attachments WHERE id = $1', [file.id]);
  /* Файл на диске удаляем после записи в БД; если его уже нет — не страшно. */
  await fs.unlink(path.join(config.uploadsDir, file.stored_name)).catch(() => {});

  req.flash('success', `Вложение «${file.original_name}» удалено`);
  return res.redirect(backUrl(req, file.page_id ? `/pages/${file.page_id}` : '/'));
});
