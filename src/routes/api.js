/**
 * ============================================================================
 *  routes/api.js — служебные маршруты: предпросмотр, тема, проверка здоровья
 * ============================================================================
 *    POST /api/preview — Markdown → HTML для живого предпросмотра в редакторе.
 *                        Рендер на сервере гарантирует, что предпросмотр
 *                        ТОЧНО совпадает с итоговой страницей (те же макросы,
 *                        та же подсветка, та же очистка HTML).
 *    GET  /theme.css   — CSS темы, сгенерированный из настроек админки.
 *    GET  /healthz     — проверка работоспособности для Docker HEALTHCHECK
 *                        и балансировщиков: 200, если БД отвечает.
 * ============================================================================
 */
import { Router } from 'express';
import { pool } from '../db/pool.js';
import { requireRole } from '../middleware/auth.js';
import { renderMarkdown } from '../services/markdown.js';
import { getSettings, getSettingsVersion } from '../services/settings.js';
import { buildThemeCss } from '../services/theme.js';

/* ---------------------------------------------------------------------------
 * publicApiRouter подключается ДО проверки доступа (siteAccess): стили и
 * health-check нужны даже неавторизованным (страница входа тоже стилизуется).
 * ------------------------------------------------------------------------- */
export const publicApiRouter = Router();

publicApiRouter.get('/healthz', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(503).json({ status: 'error', error: err.message });
  }
});

/* ----------------------------------------------------------------------------
 * Ссылка в шаблоне выглядит как /theme.css?v=<версия настроек>.
 * Если версия совпадает с текущей — разрешаем браузеру кэшировать файл
 * «навсегда» (при изменении настроек изменится и ссылка). Иначе — no-cache.
 * ------------------------------------------------------------------------- */
publicApiRouter.get('/theme.css', (req, res) => {
  const current = String(getSettingsVersion());
  res.type('text/css');
  res.set('Cache-Control', req.query.v === current ? 'public, max-age=31536000, immutable' : 'no-cache');
  res.send(buildThemeCss(getSettings()));
});

/* ---------------------------------------------------------------------------
 * apiRouter — после проверки доступа.
 * ------------------------------------------------------------------------- */
export const apiRouter = Router();

apiRouter.post('/api/preview', requireRole('editor'), (req, res) => {
  const content = String(req.body?.content ?? '').slice(0, 2_000_000);
  const { html, toc } = renderMarkdown(content);
  res.json({ html, toc });
});
