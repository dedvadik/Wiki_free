/**
 * ============================================================================
 *  services/markdown.js — превращение Markdown-текста статьи в HTML
 * ============================================================================
 *  Статьи хранятся в формате Markdown (простой текст с разметкой). При показе
 *  страницы текст проходит через конвейер:
 *
 *     Markdown ──marked──▶ HTML ──sanitize-html──▶ безопасный HTML
 *
 *  1. marked — парсер Markdown с поддержкой GFM (таблицы, списки задач,
 *     зачёркивание). Мы расширяем его «макросами» в духе Confluence:
 *       :::info Заголовок ... :::   — цветные информационные панели
 *       [[toc]]                     — автоматическое оглавление
 *       {{status:green:ГОТОВО}}     — цветной «статус-лозунг»
 *     а также подсветкой синтаксиса кода (highlight.js) и якорями у заголовков.
 *  2. sanitize-html — вычищает всё опасное (теги <script>, обработчики onclick,
 *     ссылки javascript:). Это защита от XSS: пользователь может вставить в
 *     статью сырой HTML, но исполняемый код до браузера читателя не дойдёт.
 * ============================================================================
 */
import { Marked } from 'marked';
import { markedHighlight } from 'marked-highlight';
import hljs from 'highlight.js';
import sanitizeHtml from 'sanitize-html';

/* ----------------------------------------------------------------------------
 * Утилиты для работы со строками
 * ------------------------------------------------------------------------- */

/** Экранирование HTML-спецсимволов — для вставки текста внутрь разметки. */
export function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

/** Обратная операция для основных сущностей (нужна для текста оглавления). */
function decodeEntities(str) {
  return str.replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => (
    { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }[e]
  ));
}

/**
 * slugify — «человекочитаемый» идентификатор из текста:
 * "Установка и Настройка!" → "установка-и-настройка".
 * \p{L} и \p{N} — любые буквы и цифры Юникода, поэтому кириллица сохраняется.
 */
export function slugify(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/* ----------------------------------------------------------------------------
 * Состояние ТЕКУЩЕГО рендера: собранное оглавление и счётчик идентификаторов
 * заголовков (чтобы два заголовка «Пример» получили разные id: "h-пример" и
 * "h-пример-1"). marked работает синхронно, а JavaScript однопоточен, поэтому
 * два рендера не могут перемешаться — переменная модуля здесь безопасна.
 * ------------------------------------------------------------------------- */
let renderState = null;

/* ----------------------------------------------------------------------------
 * Расширение 1: информационные панели (аналог макросов Info/Note/Warning
 * в Confluence). Синтаксис:
 *
 *   :::warning Внимание
 *   Текст панели, **можно** использовать любую разметку.
 *   :::
 *
 * tokenizer находит блок и разбирает его содержимое как обычный Markdown
 * (this.lexer.blockTokens), renderer оборачивает результат в <div>.
 * ------------------------------------------------------------------------- */
const PANEL_TYPES = ['info', 'note', 'tip', 'success', 'warning', 'error'];
const PANEL_ICONS = { info: 'ℹ️', note: '📝', tip: '💡', success: '✅', warning: '⚠️', error: '⛔' };

const panelExtension = {
  name: 'panel',
  level: 'block',
  /* Подсказка парсеру, где в тексте МОЖЕТ начинаться панель (только с начала строки). */
  start(src) {
    return src.match(/^:::/m)?.index;
  },
  tokenizer(src) {
    const re = new RegExp(`^:::(${PANEL_TYPES.join('|')})[ \\t]*([^\\n]*)\\n([\\s\\S]*?)\\n:::[ \\t]*(?:\\n+|$)`);
    const match = re.exec(src);
    if (!match) return undefined;
    const token = { type: 'panel', raw: match[0], kind: match[1], title: match[2].trim(), tokens: [] };
    this.lexer.blockTokens(match[3], token.tokens);
    return token;
  },
  renderer(token) {
    const title = token.title
      ? `<div class="panel-title">${escapeHtml(token.title)}</div>`
      : '';
    return `<div class="panel panel-${token.kind}"><span class="panel-icon" aria-hidden="true">${PANEL_ICONS[token.kind]}</span>`
      + `<div class="panel-body">${title}${this.parser.parse(token.tokens)}</div></div>\n`;
  },
};

/* ----------------------------------------------------------------------------
 * Расширение 2: макрос оглавления [[toc]] на отдельной строке.
 * На этапе разбора мы ещё не знаем все заголовки документа, поэтому
 * вставляем пустой маркер, а после рендера заменяем его на готовый список.
 * ------------------------------------------------------------------------- */
const TOC_PLACEHOLDER = '<div class="toc-macro"></div>';

const tocExtension = {
  name: 'tocMacro',
  level: 'block',
  start(src) {
    return src.match(/^\[\[toc\]\]/m)?.index;
  },
  tokenizer(src) {
    const match = /^\[\[toc\]\][ \t]*(?:\n+|$)/.exec(src);
    return match ? { type: 'tocMacro', raw: match[0] } : undefined;
  },
  renderer() {
    return TOC_PLACEHOLDER;
  },
};

/* ----------------------------------------------------------------------------
 * Расширение 3: статус-лозунг {{status:цвет:ТЕКСТ}} — цветная плашка внутри
 * строки, как макрос Status в Confluence. Удобно для таблиц статусов задач.
 * Разделитель — двоеточие, а НЕ «|»: вертикальная черта в GFM-таблицах
 * разделяет ячейки, и статус внутри таблицы «разорвал» бы строку.
 * ------------------------------------------------------------------------- */
const STATUS_COLORS = ['grey', 'red', 'yellow', 'green', 'blue', 'purple'];

const statusExtension = {
  name: 'status',
  level: 'inline',
  start(src) {
    const i = src.indexOf('{{status:');
    return i >= 0 ? i : undefined;
  },
  tokenizer(src) {
    const re = new RegExp(`^\\{\\{status:(${STATUS_COLORS.join('|')}):([^}\\n]{1,40})\\}\\}`);
    const match = re.exec(src);
    return match ? { type: 'status', raw: match[0], color: match[1], text: match[2].trim() } : undefined;
  },
  renderer(token) {
    return `<span class="status status-${token.color}">${escapeHtml(token.text)}</span>`;
  },
};

/* ----------------------------------------------------------------------------
 * Экземпляр парсера marked со всеми расширениями.
 * markedHighlight — подсветка синтаксиса блоков кода ```js ... ``` на сервере
 * (читателю не нужно грузить никакой JavaScript). Если язык не указан или
 * неизвестен — код выводится как обычный текст.
 * ------------------------------------------------------------------------- */
const marked = new Marked(
  markedHighlight({
    emptyLangClass: 'hljs',
    langPrefix: 'hljs language-',
    highlight(code, lang) {
      const language = lang && hljs.getLanguage(lang) ? lang : 'plaintext';
      return hljs.highlight(code, { language }).value;
    },
  }),
  {
    gfm: true, /* GitHub Flavored Markdown: таблицы, ~~зачёркивание~~, - [ ] задачи */
    breaks: false, /* одиночный перенос строки НЕ превращается в <br> (как в стандарте) */
    extensions: [panelExtension, tocExtension, statusExtension],
    renderer: {
      /* Заголовки получают id (для ссылок вида #раздел) и значок-якорь «#».
       * Заодно собираем их в оглавление текущего документа. */
      heading({ tokens, depth }) {
        const inner = this.parser.parseInline(tokens);
        const plain = decodeEntities(inner.replace(/<[^>]*>/g, '')).trim();
        let id = `h-${slugify(plain) || 'section'}`;
        if (renderState) {
          const seen = renderState.slugs.get(id) ?? 0;
          renderState.slugs.set(id, seen + 1);
          if (seen) id = `${id}-${seen}`;
          renderState.toc.push({ level: depth, text: plain, id });
        }
        return `<h${depth} id="${escapeHtml(id)}">${inner}<a class="heading-anchor" href="#${escapeHtml(id)}" aria-hidden="true">#</a></h${depth}>\n`;
      },
    },
  },
);

/* ----------------------------------------------------------------------------
 * Правила очистки HTML (белый список). Всё, что не перечислено, удаляется.
 *  - allowedTags: стандартный набор sanitize-html + картинки, спойлеры и т.д.
 *  - allowedAttributes: только безопасные атрибуты; никаких on*-обработчиков
 *    и style (чтобы нельзя было «сломать» вёрстку сайта из статьи).
 *  - allowedSchemes: допустимые протоколы ссылок — javascript: запрещён.
 *  - transformTags: внешние ссылки открываются в новой вкладке с rel=noopener,
 *    картинки грузятся лениво, чекбоксы задач — только для чтения.
 * ------------------------------------------------------------------------- */
const SANITIZE_OPTIONS = {
  allowedTags: [
    ...sanitizeHtml.defaults.allowedTags,
    'img', 'del', 'ins', 'input', 'details', 'summary', 'sup', 'sub', 'mark', 'kbd', 'h1', 'h2',
  ],
  allowedAttributes: {
    '*': ['id', 'class', 'title', 'aria-hidden'],
    a: ['href', 'name', 'target', 'rel'],
    img: ['src', 'alt', 'width', 'height', 'loading'],
    input: ['type', 'checked', 'disabled'],
    th: ['align', 'colspan', 'rowspan'],
    td: ['align', 'colspan', 'rowspan'],
    ol: ['start'],
    details: ['open'],
  },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowedSchemesByTag: { img: ['http', 'https', 'data'] },
  allowProtocolRelative: false,
  /* <input> оставляем только как чекбокс (списки задач). */
  exclusiveFilter: (frame) => frame.tag === 'input' && frame.attribs.type !== 'checkbox',
  transformTags: {
    a: (tagName, attribs) => (/^https?:\/\//i.test(attribs.href ?? '')
      ? { tagName, attribs: { ...attribs, target: '_blank', rel: 'noopener noreferrer' } }
      : { tagName, attribs }),
    img: (tagName, attribs) => ({ tagName, attribs: { ...attribs, loading: 'lazy' } }),
    input: (tagName, attribs) => ({ tagName, attribs: { ...attribs, disabled: '' } }),
  },
};

/* ----------------------------------------------------------------------------
 * HTML-оглавление для макроса [[toc]]. Уровни отступов считаются от самого
 * «крупного» заголовка документа (если в статье нет h1, то h2 — нулевой уровень).
 * Если заголовков нет, в статье макрос просто не виден, а в редакторе
 * (editing) остаётся заглушка — иначе визуальный редактор «потерял» бы
 * [[toc]] при обратном преобразовании в Markdown.
 * ------------------------------------------------------------------------- */
function buildTocHtml(toc, editing = false) {
  if (!toc.length) {
    return editing
      ? '<nav class="toc-macro"><div class="toc-title">Содержание</div><p class="muted small">Оглавление соберётся из заголовков страницы</p></nav>'
      : '';
  }
  const minLevel = Math.min(...toc.map((t) => t.level));
  const items = toc
    .map((t) => `<li class="toc-l${t.level - minLevel}"><a href="#${escapeHtml(t.id)}">${escapeHtml(t.text)}</a></li>`)
    .join('');
  return `<nav class="toc-macro"><div class="toc-title">Содержание</div><ul>${items}</ul></nav>`;
}

/* ----------------------------------------------------------------------------
 * ГЛАВНАЯ ФУНКЦИЯ МОДУЛЯ.
 * Возвращает { html, toc }:
 *   html — безопасный HTML для вставки в страницу
 *   toc  — массив заголовков [{ level, text, id }] для боковой панели
 *          «На этой странице»
 * Параметр editing: true — HTML для редактора (предпросмотр и визуальный
 * режим): пустое оглавление показывается заглушкой.
 * ------------------------------------------------------------------------- */
export function renderMarkdown(source, { editing = false } = {}) {
  renderState = { toc: [], slugs: new Map() };
  try {
    const rawHtml = marked.parse(String(source ?? ''));
    let html = sanitizeHtml(rawHtml, SANITIZE_OPTIONS);
    const { toc } = renderState;
    /* Замена маркера [[toc]] — ПОСЛЕ очистки, т.к. оглавление строим мы сами
     * из уже экранированного текста. */
    if (html.includes(TOC_PLACEHOLDER)) html = html.replaceAll(TOC_PLACEHOLDER, buildTocHtml(toc, editing));
    return { html, toc };
  } finally {
    renderState = null;
  }
}

/* ----------------------------------------------------------------------------
 * renderPageCached — renderMarkdown для просмотра статьи с кэшем в памяти.
 * Разбор Markdown, подсветка кода и очистка HTML — около трети работы
 * сервера при каждом показе статьи (замер нагрузочного теста), а текст
 * меняется редко. Ключ кэша — id, номер версии и время изменения: любая
 * правка текста создаёт новую версию, поэтому устаревший HTML не покажется
 * никогда (старая запись просто вытеснится).
 * Map помнит порядок вставки: повторное обращение переносит запись в конец,
 * а при переполнении удаляется самая давняя — простейший LRU-кэш.
 * В каждом процессе свой кэш; 500 статей ≈ 10–20 МБ памяти.
 * ------------------------------------------------------------------------- */
const PAGE_CACHE_SIZE = 500;
const pageCache = new Map();

export function renderPageCached(page) {
  const key = `${page.id}:${page.version}:${new Date(page.updated_at).getTime()}`;
  const cached = pageCache.get(key);
  if (cached) {
    pageCache.delete(key);
    pageCache.set(key, cached);
    return cached;
  }
  const result = renderMarkdown(page.content);
  pageCache.set(key, result);
  if (pageCache.size > PAGE_CACHE_SIZE) pageCache.delete(pageCache.keys().next().value);
  return result;
}

/* ----------------------------------------------------------------------------
 * excerpt — короткий фрагмент текста без разметки (для списков страниц и
 * результатов поиска): убираем блоки кода, картинки, символы Markdown.
 * ------------------------------------------------------------------------- */
export function excerpt(markdown, maxLength = 200) {
  const text = String(markdown ?? '')
    .replace(/```[\s\S]*?```/g, ' ')              /* блоки кода */
    .replace(/^:::.*$/gm, ' ')                    /* границы панелей */
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')        /* картинки */
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')      /* ссылки → только текст */
    .replace(/\{\{status:\w+:([^}]*)\}\}/g, '$1') /* статусы → текст */
    .replace(/\[\[toc\]\]/g, ' ')
    .replace(/<[^>]+>/g, ' ')                     /* HTML-теги */
    .replace(/^[\s|:-]+$/gm, ' ')                 /* разделители таблиц и линии --- */
    .replace(/^\s*(?:[-+*]|\d+\.)\s+(?:\[[ x]\]\s+)?/gim, ' ') /* маркеры списков */
    .replace(/[#>*_`~|]+/g, ' ')                  /* прочие символы разметки */
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > maxLength ? `${text.slice(0, maxLength).trimEnd()}…` : text;
}
