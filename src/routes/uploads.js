/**
 * ============================================================================
 *  routes/uploads.js — загрузка и отдача вложений (картинки, документы)
 * ============================================================================
 *  Маршруты:
 *    POST /api/uploads               — загрузка файла из редактора (editor+),
 *                                      отвечает JSON с готовой Markdown-ссылкой
 *    GET  /uploads/:name             — скачивание/просмотр файла
 *    POST /attachments/:id/delete    — удаление вложения (editor+)
 *
 *  Меры безопасности:
 *   - файл сохраняется под СЛУЧАЙНЫМ именем (UUID) — пользователь не может
 *     перезаписать чужой файл или «выйти» из папки через ../;
 *   - «в браузере» (inline) показываются только растровые картинки;
 *     всё остальное (html, svg, js…) отдаётся как скачиваемый файл —
 *     иначе загруженный HTML мог бы выполнить скрипт от имени нашего сайта;
 *   - дополнительно ответ содержит CSP sandbox и X-Content-Type-Options.
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
import { backUrl, HttpError, parseId } from '../utils/http.js';

export const uploadsRouter = Router();

/* Расширения и MIME-типы, которые безопасно показывать прямо в браузере. */
const INLINE_IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.ico']);

/* ----------------------------------------------------------------------------
 * Настройка multer — библиотеки приёма файлов (multipart/form-data).
 *  - diskStorage: пишем файл сразу на диск потоком, не держа его в памяти;
 *  - имя файла: UUID + исходное расширение (если оно «нормальное»);
 *  - limits: максимальный размер и не больше одного файла за запрос;
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
  limits: { fileSize: config.uploadMaxMb * 1024 * 1024, files: 1 },
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
        ? `Файл больше ${config.uploadMaxMb} МБ`
        : `Ошибка загрузки: ${err.message}`;
      return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: message });
    });
  },
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Файл не получен' });

    /* Если загрузка идёт из редактора существующей страницы — сразу
     * привязываем файл к ней. Для новой страницы привязка произойдёт при
     * первом сохранении (см. linkAttachments). */
    const pageId = Number.parseInt(req.body.page_id, 10);
    const page = Number.isInteger(pageId) ? await one('SELECT id FROM pages WHERE id = $1', [pageId]) : null;

    const originalName = req.file.originalname.slice(0, 255);
    const { rows: [attachment] } = await query(
      `INSERT INTO attachments (page_id, stored_name, original_name, mime_type, size_bytes, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [page?.id ?? null, req.file.filename, originalName, req.file.mimetype || 'application/octet-stream', req.file.size, req.user.id],
    );

    const url = `/uploads/${req.file.filename}`;
    const isImage = INLINE_IMAGE_EXT.has(path.extname(req.file.filename)) && req.file.mimetype.startsWith('image/');
    /* Квадратные скобки в имени сломали бы Markdown-ссылку — заменяем. */
    const label = originalName.replace(/[[\]]/g, '');
    return res.json({
      id: attachment.id,
      url,
      name: originalName,
      isImage,
      markdown: isImage ? `![${label}](${url})` : `[📎 ${label}](${url})`,
    });
  },
);

/* =============================== ОТДАЧА ==================================
 * Маршрут подключён ПОСЛЕ siteAccess — в закрытой вики файлы тоже
 * доступны только вошедшим пользователям.
 * ========================================================================= */
uploadsRouter.get('/uploads/:name', async (req, res) => {
  const { name } = req.params;
  /* Строгая проверка формата имени: UUID + необязательное расширение. */
  if (!/^[0-9a-f-]{36}(\.[a-z0-9]{1,10})?$/.test(name)) throw new HttpError(404, 'Файл не найден');

  const file = await one('SELECT * FROM attachments WHERE stored_name = $1', [name]);
  if (!file) throw new HttpError(404, 'Файл не найден');

  const inline = INLINE_IMAGE_EXT.has(path.extname(name)) && file.mime_type.startsWith('image/');

  res.set({
    'Cache-Control': 'private, max-age=86400',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
  });
  if (inline) {
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

uploadsRouter.post('/attachments/:id/delete', requireRole('editor'), async (req, res) => {
  const file = await one('SELECT * FROM attachments WHERE id = $1', [parseId(req.params.id)]);
  if (!file) throw new HttpError(404, 'Вложение не найдено');

  await query('DELETE FROM attachments WHERE id = $1', [file.id]);
  /* Файл на диске удаляем после записи в БД; если его уже нет — не страшно. */
  await fs.unlink(path.join(config.uploadsDir, file.stored_name)).catch(() => {});

  req.flash('success', `Вложение «${file.original_name}» удалено`);
  return res.redirect(backUrl(req, file.page_id ? `/pages/${file.page_id}` : '/'));
});
