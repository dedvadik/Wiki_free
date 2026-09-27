/* ============================================================================
   editor.js — редактор страниц: визуальный и Markdown
   ============================================================================
   Два типа редактора над ОДНИМ и тем же текстом страницы:

     Markdown   — textarea с разметкой и живым предпросмотром справа;
     Визуальный — редактируемая область (contenteditable), форматирование
                  видно сразу, как в Word или Confluence.

   Страница всегда хранится в Markdown (скрытое поле формы — это textarea):
     Markdown → визуальный: текст рендерится на сервере (/api/preview) — тем
                  же кодом, что и готовая статья, — и HTML попадает в
                  редактируемую область;
     визуальный → Markdown: при сохранении или переключении HTML
                  превращается обратно в Markdown библиотекой turndown с
                  правилами для наших макросов (панели, статусы, оглавление,
                  таблицы, списки задач).
   Если в визуальном режиме ничего не меняли, исходный Markdown сохраняется
   как есть — разметку не «переформатирует» простое переключение режимов.

   Общее для обоих типов:
     - одна панель инструментов (кнопки data-md="действие");
     - горячие клавиши: Ctrl+B / Ctrl+I / Ctrl+K, Ctrl+S — сохранить;
     - загрузка файлов: кнопка 📎, вставка из буфера, перетаскивание;
     - защита от потери изменений при уходе со страницы.

   Выбор типа запоминается в localStorage['editor-type'] (по умолчанию —
   настройка администратора data-default-editor на <html>).
   Всё находится через data-атрибуты разметки (views/pages/form.ejs).
   ============================================================================ */
(function () {
  'use strict';

  const form = document.querySelector('[data-editor-form]');
  if (!form) return;

  /* ---------------------------------------------------------------------
     Элементы редактора
     --------------------------------------------------------------------- */
  const textarea = form.querySelector('[data-editor-input]');
  const preview = form.querySelector('[data-editor-preview]');
  const visual = form.querySelector('[data-editor-visual]');
  const workspace = form.querySelector('.editor-workspace');
  const fileInput = form.querySelector('[data-editor-file]');
  const attachmentsInput = form.querySelector('[data-editor-attachments]');
  const status = form.querySelector('[data-editor-status]');
  const typeSwitch = form.querySelector('[data-editor-type-switch]');
  const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content || '';
  const pageId = form.dataset.pageId || '';

  let dirty = false;         /* есть несохранённые изменения */
  let editorType = 'markdown';
  let visualDirty = false;   /* меняли ли текст в визуальном режиме */

  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const readPref = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
  const writePref = (key, value) => { try { localStorage.setItem(key, value); } catch { /* приватный режим */ } };

  function markDirty() {
    dirty = true;
    if (editorType === 'visual') visualDirty = true;
    else schedulePreview();
  }

  /* =====================================================================
     1. MARKDOWN: ОПЕРАЦИИ С ТЕКСТОМ
     setRangeText заменяет часть текста в textarea и умеет выставлять
     курсор/выделение после замены.
     ===================================================================== */

  /** Обернуть выделение: **текст**. Если ничего не выделено — вставить заглушку и выделить её. */
  function wrap(before, after = before, placeholder = 'текст') {
    const { selectionStart: start, selectionEnd: end, value } = textarea;
    const selected = value.slice(start, end) || placeholder;
    textarea.setRangeText(before + selected + after, start, end, 'end');
    textarea.setSelectionRange(start + before.length, start + before.length + selected.length);
    afterMarkdownEdit();
  }

  /** Префикс к каждой выделенной строке («- », «> », «1. »); prefix — строка или функция(номер строки). */
  function prefixLines(prefix) {
    const { value } = textarea;
    const start = value.lastIndexOf('\n', textarea.selectionStart - 1) + 1;
    let end = value.indexOf('\n', textarea.selectionEnd);
    if (end === -1) end = value.length;
    const lines = value.slice(start, end).split('\n')
      .map((line, i) => (typeof prefix === 'function' ? prefix(i) : prefix) + line);
    textarea.setRangeText(lines.join('\n'), start, end, 'select');
    afterMarkdownEdit();
  }

  /** Убрать у выделенных строк префикс заголовка (кнопка «¶ Обычный текст»). */
  function stripHeading() {
    const { value } = textarea;
    const start = value.lastIndexOf('\n', textarea.selectionStart - 1) + 1;
    let end = value.indexOf('\n', textarea.selectionEnd);
    if (end === -1) end = value.length;
    const lines = value.slice(start, end).split('\n').map((line) => line.replace(/^#{1,6}\s+/, ''));
    textarea.setRangeText(lines.join('\n'), start, end, 'select');
    afterMarkdownEdit();
  }

  /** Вставить блок (таблицу, панель…) на отдельных строках, отделив пустой строкой. */
  function insertBlock(text) {
    const { selectionStart: start, selectionEnd: end, value } = textarea;
    const before = value.slice(0, start);
    let lead = '';
    if (before && !before.endsWith('\n\n')) lead = before.endsWith('\n') ? '\n' : '\n\n';
    textarea.setRangeText(`${lead}${text}\n`, start, end, 'end');
    afterMarkdownEdit();
  }

  function afterMarkdownEdit() {
    textarea.focus();
    markDirty();
  }

  const MARKDOWN_ACTIONS = {
    paragraph: stripHeading,
    h2: () => prefixLines('## '),
    h3: () => prefixLines('### '),
    bold: () => wrap('**'),
    italic: () => wrap('_'),
    strike: () => wrap('~~'),
    code: () => wrap('`', '`', 'код'),
    link: () => {
      const url = window.prompt('Адрес ссылки:', 'https://');
      if (url) wrap('[', `](${url})`, 'текст ссылки');
    },
    ul: () => prefixLines('- '),
    ol: () => prefixLines((i) => `${i + 1}. `),
    task: () => prefixLines('- [ ] '),
    quote: () => prefixLines('> '),
    codeblock: () => wrap('```\n', '\n```', 'код'),
    table: () => insertBlock('| Столбец 1 | Столбец 2 | Столбец 3 |\n| --- | --- | --- |\n| Ячейка | Ячейка | Ячейка |'),
    hr: () => insertBlock('---'),
    info: () => insertBlock(':::info Информация\nТекст панели\n:::'),
    warning: () => insertBlock(':::warning Внимание\nТекст панели\n:::'),
    tip: () => insertBlock(':::tip Совет\nТекст панели\n:::'),
    status: () => wrap('{{status:green:', '}}', 'ГОТОВО'),
    toc: () => insertBlock('[[toc]]'),
  };

  /* =====================================================================
     2. ВИЗУАЛЬНЫЙ РЕДАКТОР: ФОРМАТИРОВАНИЕ
     Используются встроенные команды браузера для contenteditable
     (document.execCommand): они поддерживаются всеми браузерами и сами
     ведут историю отмены (Ctrl+Z). Вставки делаются напрямую в DOM:
     блоки — insertBlock, строчные элементы — insertInline (см. ниже, почему).
     ===================================================================== */

  /* Enter создаёт <p>, а не <div> — так HTML ближе к структуре Markdown. */
  try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch { /* старые браузеры */ }

  /* Выделение пропадает, когда открывается prompt() — сохраняем и восстанавливаем. */
  let savedRange = null;
  function saveSelection() {
    const sel = window.getSelection();
    savedRange = sel.rangeCount && visual.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null;
  }
  function restoreSelection() {
    visual.focus();
    if (!savedRange) return;
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(savedRange);
  }

  function exec(command, value = null) {
    visual.focus();
    document.execCommand(command, false, value);
    markDirty();
  }

  /** Вставка HTML командой браузера — для вставки из буфера обмена. */
  function insertHtml(html) {
    visual.focus();
    document.execCommand('insertHTML', false, html);
    markDirty();
  }

  /**
   * Вставка СТРОЧНОГО элемента (статус, код, ссылка, картинка) точно в место
   * курсора. insertHTML браузера здесь ненадёжен: неизменяемый статус
   * (contenteditable="false") в конце абзаца он кладёт ПОСЛЕ абзаца.
   * Курсор ставится сразу за вставленным — можно продолжать печатать.
   */
  function insertInline(html) {
    visual.focus();
    const sel = window.getSelection();
    let range = sel.rangeCount && visual.contains(sel.anchorNode) ? sel.getRangeAt(0) : null;
    if (!range) {
      /* Курсора в редакторе нет — в конец последнего абзаца. */
      let last = visual.lastElementChild;
      if (!last || !/^(P|H[1-6])$/.test(last.nodeName)) last = visual.appendChild(document.createElement('p'));
      range = document.createRange();
      range.selectNodeContents(last);
      range.collapse(false);
    }
    range.deleteContents();
    /* Курсор между блоками (прямо в редакторе) — строчному элементу нужен абзац. */
    if (range.startContainer === visual) {
      const p = document.createElement('p');
      range.insertNode(p);
      range.selectNodeContents(p);
    }
    const template = document.createElement('template');
    template.innerHTML = html;
    const lastNode = template.content.lastChild;
    range.insertNode(template.content);
    const after = document.createRange();
    after.setStartAfter(lastNode);
    after.collapse(true);
    sel.removeAllRanges();
    sel.addRange(after);
    updateEmptyHint();
    markDirty();
  }

  const selectedText = () => window.getSelection().toString();

  /** Ячейка таблицы, в которой стоит курсор (или null). */
  function currentCell() {
    const node = window.getSelection().anchorNode;
    const el = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    return el && visual.contains(el) ? el.closest('td, th') : null;
  }

  function addTableRow() {
    const cell = currentCell();
    if (!cell) return setStatus('Поставьте курсор в ячейку таблицы');
    const table = cell.closest('table');
    const columns = cell.parentElement.children.length;
    const row = document.createElement('tr');
    for (let i = 0; i < columns; i++) row.appendChild(Object.assign(document.createElement('td'), { innerHTML: '<br>' }));
    /* Строка из шапки добавляется в начало тела таблицы, иначе — после текущей. */
    if (cell.parentElement.parentElement.tagName === 'THEAD') {
      const body = table.tBodies[0] || table.appendChild(document.createElement('tbody'));
      body.insertBefore(row, body.firstChild);
    } else {
      cell.parentElement.after(row);
    }
    markDirty();
  }

  function addTableColumn() {
    const cell = currentCell();
    if (!cell) return setStatus('Поставьте курсор в ячейку таблицы');
    const index = [...cell.parentElement.children].indexOf(cell);
    cell.closest('table').querySelectorAll('tr').forEach((tr) => {
      const isHead = tr.parentElement.tagName === 'THEAD';
      const newCell = document.createElement(isHead ? 'th' : 'td');
      newCell.innerHTML = isHead ? 'Столбец' : '<br>';
      const ref = tr.children[index];
      if (ref) ref.after(newCell); else tr.appendChild(newCell);
    });
    markDirty();
  }

  /* ---- Вставка БЛОКОВ (таблица, панель, код, список задач, линия, оглавление) ----
     execCommand('insertHTML') для блоков не годится: браузер вкладывает их
     внутрь текущего абзаца (<p><pre>…</pre></p>), а пустой абзац после блока
     «съедает» — и дальше писать можно только внутри панели или таблицы.
     Поэтому блок вставляется прямо в DOM:
       - после абзаца (заголовка, списка…), где стоит курсор, а пустой абзац
         блок просто заменяет;
       - после блока всегда остаётся абзац, чтобы можно было писать дальше;
       - курсор ставится на текст-заглушку внутри блока (его сразу можно
         перепечатать) или в абзац после блока.
     Отменить такую вставку через Ctrl+Z нельзя (браузер не записывает
     изменения DOM в историю) — удаляется она обычным выделением и Delete. */

  /** Элемент верхнего уровня редактора, в котором стоит курсор (или null). */
  function currentBlock() {
    const sel = window.getSelection();
    if (!sel.rangeCount) return null;
    let node = sel.getRangeAt(0).startContainer;
    if (node === visual) return visual.childNodes[Math.max(0, sel.getRangeAt(0).startOffset - 1)] || null;
    if (!visual.contains(node)) return null;
    while (node.parentNode !== visual) node = node.parentNode;
    return node;
  }

  const isEmptyElement = (el) => !el.textContent.trim() && !el.querySelector('img, table, input, hr');

  /** Подсказка «Начните писать…» (CSS-класс is-empty) — пока в редакторе нет содержимого. */
  const updateEmptyHint = () => visual.classList.toggle('is-empty', isEmptyElement(visual));

  function placeCaret(target, { select = false, atEnd = false } = {}) {
    const range = document.createRange();
    range.selectNodeContents(target);
    if (!select) range.collapse(!atEnd);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  /**
   * Вставить блок. focus — куда поставить курсор: { select: 'css' } —
   * выделить содержимое элемента внутри блока, { end: 'css' } — в конец
   * элемента; без focus — в абзац после блока.
   */
  function insertBlock(html, focus = null) {
    const sel = window.getSelection();
    /* Выделенный текст блок заменяет (для кода текст уже взят в html). */
    if (sel.rangeCount && !sel.isCollapsed && visual.contains(sel.anchorNode)) sel.deleteFromDocument();
    /* Пустой пункт списка (Enter после последнего пункта) — это «выход из
     * списка»: убираем его, а блок встаёт после списка. */
    const anchor = sel.anchorNode?.nodeType === Node.TEXT_NODE ? sel.anchorNode.parentElement : sel.anchorNode;
    const emptyItem = anchor && visual.contains(anchor) ? anchor.closest('li') : null;
    if (emptyItem && isEmptyElement(emptyItem)) {
      const list = emptyItem.parentElement;
      placeCaret(list, { atEnd: true });
      emptyItem.remove();
      if (!list.children.length) list.remove();
    }

    const current = currentBlock();
    const template = document.createElement('template');
    template.innerHTML = html.trim();
    const block = template.content.firstElementChild;
    if (current && current.nodeType === Node.ELEMENT_NODE && /^(P|DIV|H[1-6])$/.test(current.nodeName)
        && !current.classList.contains('panel') && isEmptyElement(current)) {
      current.replaceWith(block);
    } else if (current) {
      current.after(block);
    } else {
      visual.append(block);
    }
    const next = block.nextElementSibling;
    if (!next || !/^(P|H[1-6]|UL|OL|BLOCKQUOTE)$/.test(next.nodeName)) {
      block.after(Object.assign(document.createElement('p'), { innerHTML: '<br>' }));
    }

    visual.focus();
    const target = focus && block.querySelector(focus.select || focus.end);
    if (target) placeCaret(target, { select: Boolean(focus.select), atEnd: Boolean(focus.end) });
    else placeCaret(block.nextElementSibling);
    markDirty();
  }

  const PANEL_ICONS = { info: 'ℹ️', warning: '⚠️', tip: '💡' };
  const panelHtml = (kind, title) => `<div class="panel panel-${kind}"><span class="panel-icon" contenteditable="false">${PANEL_ICONS[kind]}</span>`
    + `<div class="panel-body"><div class="panel-title">${title}</div><p>Текст панели</p></div></div>`;

  const STATUS_COLORS = ['grey', 'red', 'yellow', 'green', 'blue', 'purple'];

  const VISUAL_ACTIONS = {
    paragraph: () => exec('formatBlock', '<p>'),
    h2: () => exec('formatBlock', '<h2>'),
    h3: () => exec('formatBlock', '<h3>'),
    bold: () => exec('bold'),
    italic: () => exec('italic'),
    strike: () => exec('strikeThrough'),
    code: () => insertInline(`<code>${escapeHtml(selectedText() || 'код')}</code>&nbsp;`),
    link: () => {
      saveSelection();
      const url = window.prompt('Адрес ссылки:', 'https://');
      restoreSelection();
      if (!url) return;
      if (selectedText()) exec('createLink', url);
      else insertInline(`<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>&nbsp;`);
    },
    ul: () => exec('insertUnorderedList'),
    ol: () => exec('insertOrderedList'),
    task: () => insertBlock('<ul><li><input type="checkbox"> задача</li></ul>', { end: 'li' }),
    quote: () => exec('formatBlock', '<blockquote>'),
    codeblock: () => insertBlock(`<pre><code>${escapeHtml(selectedText() || 'код')}</code></pre>`, { select: 'code' }),
    table: () => insertBlock('<table><thead><tr><th>Столбец 1</th><th>Столбец 2</th><th>Столбец 3</th></tr></thead>'
      + '<tbody><tr><td>Ячейка</td><td>Ячейка</td><td>Ячейка</td></tr></tbody></table>', { select: 'th' }),
    row: addTableRow,
    col: addTableColumn,
    hr: () => insertBlock('<hr>'),
    info: () => insertBlock(panelHtml('info', 'Информация'), { select: '.panel-body p' }),
    warning: () => insertBlock(panelHtml('warning', 'Внимание'), { select: '.panel-body p' }),
    tip: () => insertBlock(panelHtml('tip', 'Совет'), { select: '.panel-body p' }),
    status: () => {
      saveSelection();
      const text = window.prompt('Текст статуса:', 'ГОТОВО');
      const color = text ? window.prompt(`Цвет: ${STATUS_COLORS.join(', ')}`, 'green') : null;
      restoreSelection();
      if (!text) return;
      const safeColor = STATUS_COLORS.includes(color) ? color : 'grey';
      insertInline(`<span class="status status-${safeColor}" contenteditable="false">${escapeHtml(text.slice(0, 40))}</span>&nbsp;`);
    },
    toc: () => insertBlock('<nav class="toc-macro" contenteditable="false"><div class="toc-title">Содержание</div>'
      + '<p class="muted small">Оглавление соберётся из заголовков после сохранения</p></nav>'),
  };

  /* =====================================================================
     3. ПРЕОБРАЗОВАНИЕ HTML → MARKDOWN (turndown)
     Стандартные правила turndown понимают заголовки, списки, ссылки,
     картинки, код, цитаты. Здесь добавлены правила для того, что turndown
     не знает: зачёркивание, таблицы, чекбоксы задач и наши макросы.
     ===================================================================== */
  function createTurndown() {
    if (!window.TurndownService) return null;
    const td = new window.TurndownService({
      headingStyle: 'atx',          /* ## Заголовок */
      hr: '---',
      bulletListMarker: '-',
      codeBlockStyle: 'fenced',     /* ```код``` */
      emDelimiter: '_',
      strongDelimiter: '**',
      linkStyle: 'inlined',
    });

    /* Эти теги разрешены в статьях как есть — сохраняем их HTML. */
    td.keep(['details', 'summary', 'kbd', 'mark', 'sup', 'sub', 'ins']);
    td.remove(['script', 'style']);

    const hasClass = (node, cls) => node.classList && node.classList.contains(cls);

    /* Пустые абзацы (Enter на пустой строке) в Markdown не нужны:
       turndown превратил бы их в строки из пробелов. */
    td.addRule('emptyParagraph', {
      filter: (n) => (n.nodeName === 'P' || n.nodeName === 'DIV') && !n.textContent.trim()
        && !n.querySelector('img, input, table, hr, pre'),
      replacement: () => '\n\n',
    });

    /* Значок «#» у заголовков (добавляет сервер) — не часть текста. */
    td.addRule('headingAnchor', { filter: (n) => n.nodeName === 'A' && hasClass(n, 'heading-anchor'), replacement: () => '' });
    td.addRule('strike', { filter: ['del', 's', 'strike'], replacement: (content) => `~~${content}~~` });
    td.addRule('taskCheckbox', {
      filter: (n) => n.nodeName === 'INPUT' && n.type === 'checkbox',
      replacement: (content, n) => (n.checked ? '[x] ' : '[ ] '),
    });

    /* Пункт списка. Отличия от стандартного правила turndown:
       - маркер «- » / «1. » и отступ продолжения ровно по его ширине
         (стандартное даёт «-   » с тремя пробелами);
       - «плотный» список (в пунктах нет <p>) остаётся плотным: пустые строки
         между текстом пункта и вложенным блоком (кодом, списком) убираются —
         иначе Markdown-парсер сочтёт список «разреженным» и обернёт каждый
         пункт в абзац. Внутри блоков кода ``` пустые строки не трогаются;
       - пустой пункт (Enter в конце списка) не сохраняется. */
    const collapseOutsideCode = (s) => s.split(/(^```[^\n]*\n[\s\S]*?\n```$)/m)
      .map((part, i) => (i % 2 ? part : part.replace(/\n{2,}/g, '\n'))).join('');
    td.addRule('listItem', {
      filter: 'li',
      replacement: (content, node) => {
        const parent = node.parentNode;
        const prefix = parent.nodeName === 'OL'
          ? `${Number(parent.getAttribute('start') || 1) + [...parent.children].indexOf(node)}. `
          : '- ';
        const loose = [...node.children].some((child) => child.nodeName === 'P');
        let text = content.replace(/^\n+/, '').replace(/\n+$/, '');
        if (!text.trim()) return '';
        if (!loose) text = collapseOutsideCode(text);
        text = text.replace(/^\[( |x)\]\s+/, '[$1] ');
        const body = text.replace(/\n/g, `\n${' '.repeat(prefix.length)}`);
        return `${prefix}${body}${node.nextElementSibling ? (loose ? '\n\n' : '\n') : ''}`;
      },
    });

    /* {{status:цвет:ТЕКСТ}} */
    td.addRule('status', {
      filter: (n) => n.nodeName === 'SPAN' && hasClass(n, 'status'),
      replacement: (content, n) => {
        const color = [...n.classList].find((c) => c.startsWith('status-'))?.slice(7) || 'grey';
        return `{{status:${color}:${n.textContent.trim()}}}`;
      },
    });

    /* [[toc]] — оглавление в визуальном режиме показывается блоком-заглушкой. */
    td.addRule('toc', { filter: (n) => n.nodeName === 'NAV' && hasClass(n, 'toc-macro'), replacement: () => '\n\n[[toc]]\n\n' });

    /* :::тип Заголовок … ::: — содержимое панели само превращается в Markdown. */
    td.addRule('panel', {
      filter: (n) => n.nodeName === 'DIV' && hasClass(n, 'panel'),
      replacement: (content, n) => {
        const kind = [...n.classList].find((c) => c.startsWith('panel-'))?.slice(6) || 'info';
        const body = (n.querySelector('.panel-body') || n).cloneNode(true);
        const titleEl = body.querySelector('.panel-title');
        const title = titleEl ? titleEl.textContent.trim() : '';
        if (titleEl) titleEl.remove();
        body.querySelectorAll('.panel-icon').forEach((el) => el.remove());
        const inner = td.turndown(body.innerHTML).trim();
        return `\n\n:::${kind}${title ? ` ${title}` : ''}\n${inner}\n:::\n\n`;
      },
    });

    /* ---- Таблицы в формате GFM: | a | b | + строка-разделитель под шапкой ---- */
    /* В GFM у таблицы всегда есть строка шапки — ею считается первая строка
       (даже если во вставленной таблице она из <td>). */
    const isHeadingRow = (tr) => tr.closest('table')?.rows[0] === tr;
    td.addRule('tableCell', {
      filter: ['th', 'td'],
      replacement: (content, n) => {
        const first = n.parentNode.firstElementChild === n;
        const text = content.trim().replace(/\n+/g, ' ').replace(/\|/g, '\\|') || ' ';
        return `${first ? '| ' : ' '}${text} |`;
      },
    });
    /* Выравнивание столбца (атрибут align из GFM) → :--- / :---: / ---: */
    const ALIGN_MARKS = { left: ':---', center: ':---:', right: '---:' };
    td.addRule('tableRow', {
      filter: 'tr',
      replacement: (content, n) => {
        const divider = isHeadingRow(n)
          ? `\n${[...n.children].map((c, i) => `${i === 0 ? '| ' : ' '}${ALIGN_MARKS[c.getAttribute('align')] || '---'} |`).join('')}`
          : '';
        return `\n${content}${divider}`;
      },
    });
    td.addRule('tableSection', { filter: ['thead', 'tbody', 'tfoot'], replacement: (content) => content });
    td.addRule('table', { filter: 'table', replacement: (content) => `\n\n${content.replace(/\n{2,}/g, '\n').trim()}\n\n` });

    return td;
  }

  const turndown = createTurndown();

  function visualToMarkdown() {
    return turndown.turndown(visual.innerHTML)
      /* Браузер при наборе ставит неразрывные пробелы (&nbsp;) в конце строк
       * и рядом со вставками — в Markdown они не нужны и мешают поиску
       * и сравнению версий. */
      .replace(/ /g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /** Markdown → HTML через сервер (тот же рендер, что у готовой статьи). */
  async function renderOnServer(markdown, signal) {
    const response = await fetch('/api/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      body: JSON.stringify({ content: markdown }),
      signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()).html || '';
  }

  /** Подготовить HTML сервера к редактированию: «неразборные» элементы
   *  (значки панелей, статусы, оглавление) нельзя повредить набором текста. */
  function loadIntoVisual(html) {
    /* Пустая страница начинается с пустого абзаца: иначе первая строка
     * окажется «голым» текстом вне <p>, а вставки блоков — внутри неё. */
    visual.innerHTML = html.trim() || '<p><br></p>';
    updateEmptyHint();
    visual.querySelectorAll('.heading-anchor').forEach((a) => a.remove());
    visual.querySelectorAll('.panel-icon, .status, .toc-macro').forEach((el) => el.setAttribute('contenteditable', 'false'));
    visual.querySelectorAll('input[type="checkbox"]').forEach((box) => box.removeAttribute('disabled'));
  }

  /* =====================================================================
     4. ПЕРЕКЛЮЧЕНИЕ ТИПА РЕДАКТОРА
     ===================================================================== */
  async function setEditorType(type) {
    if (type === 'visual' && !turndown) type = 'markdown'; /* библиотека не загрузилась */
    if (type === editorType) return;

    if (type === 'visual') {
      setStatus('Открываю визуальный редактор…');
      try {
        loadIntoVisual(await renderOnServer(textarea.value));
      } catch {
        setStatus('Не удалось открыть визуальный редактор — остаётся Markdown');
        return;
      }
      visualDirty = false;
      setStatus('');
    } else {
      syncVisualToMarkdown();
    }

    editorType = type;
    workspace.dataset.type = type;
    form.dataset.editorType = type;
    typeSwitch.querySelectorAll('[data-editor-type-choice]').forEach((b) => {
      b.classList.toggle('active', b.dataset.editorTypeChoice === type);
    });
    writePref('editor-type', type);
    if (type === 'markdown') refreshPreview();
  }

  /** Перенести текст из визуального редактора в textarea (только если его меняли). */
  function syncVisualToMarkdown() {
    if (editorType === 'visual' && visualDirty) {
      textarea.value = visualToMarkdown();
      visualDirty = false;
    }
  }

  if (turndown) {
    typeSwitch.hidden = false;
    typeSwitch.querySelectorAll('[data-editor-type-choice]').forEach((button) => {
      button.addEventListener('click', () => setEditorType(button.dataset.editorTypeChoice));
    });
  }

  /* =====================================================================
     5. ПАНЕЛЬ ИНСТРУМЕНТОВ И ГОРЯЧИЕ КЛАВИШИ
     mousedown.preventDefault — клик по кнопке не уводит фокус (и выделение)
     из визуального редактора.
     ===================================================================== */
  function runAction(name) {
    if (name === 'upload') {
      if (editorType === 'visual') saveSelection(); /* позиция вставки после диалога выбора файла */
      return fileInput.click();
    }
    const actions = editorType === 'visual' ? VISUAL_ACTIONS : MARKDOWN_ACTIONS;
    return actions[name]?.();
  }

  form.querySelectorAll('[data-md]').forEach((button) => {
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', () => runAction(button.dataset.md));
  });

  function handleHotkeys(event) {
    const mod = event.ctrlKey || event.metaKey; /* Ctrl на Windows/Linux, ⌘ на macOS */
    const key = event.key.toLowerCase();
    if (mod && key === 'b') { event.preventDefault(); runAction('bold'); }
    else if (mod && key === 'i') { event.preventDefault(); runAction('italic'); }
    else if (mod && key === 'k') { event.preventDefault(); runAction('link'); }
    else if (event.key === 'Tab' && !mod && event.currentTarget === textarea && !event.shiftKey) {
      /* В Markdown Tab вставляет отступ, а не уводит фокус из поля. */
      event.preventDefault();
      textarea.setRangeText('  ', textarea.selectionStart, textarea.selectionEnd, 'end');
      markDirty();
    } else if (event.key === 'Tab' && !mod && event.currentTarget === visual && currentListItem()) {
      /* В визуальном: Tab / Shift+Tab — вложенность пункта списка. */
      event.preventDefault();
      exec(event.shiftKey ? 'outdent' : 'indent');
    }
  }

  function currentListItem() {
    const node = window.getSelection().anchorNode;
    const el = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    return el && visual.contains(el) ? el.closest('li') : null;
  }

  textarea.addEventListener('keydown', handleHotkeys);
  visual.addEventListener('keydown', handleHotkeys);

  /* Ctrl+S — сохранить из любого места страницы (перехватываем «Сохранить как» браузера). */
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      form.requestSubmit();
    }
  });

  /* =====================================================================
     6. ЖИВОЙ ПРЕДПРОСМОТР (Markdown-режим)
     Ждём паузу в наборе 400 мс; AbortController отменяет устаревший запрос.
     ===================================================================== */
  let previewTimer = null;
  let previewController = null;

  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(refreshPreview, 400);
  }

  async function refreshPreview() {
    if (editorType !== 'markdown' || workspace.dataset.mode === 'edit') return;
    previewController?.abort();
    previewController = new AbortController();
    try {
      /* HTML уже очищен сервером (sanitize-html), вставлять безопасно. */
      preview.innerHTML = (await renderOnServer(textarea.value, previewController.signal))
        || '<p class="muted">Здесь появится результат…</p>';
    } catch (err) {
      if (err.name !== 'AbortError') preview.innerHTML = '<p class="muted">Не удалось построить предпросмотр.</p>';
    }
  }

  textarea.addEventListener('input', markDirty);
  visual.addEventListener('input', () => {
    /* Всё стёрли — возвращаем пустой абзац (см. loadIntoVisual). */
    if (!visual.firstElementChild && !visual.textContent.trim()) {
      visual.innerHTML = '<p><br></p>';
      placeCaret(visual.firstElementChild);
    }
    updateEmptyHint();
    markDirty();
  });
  form.querySelectorAll('input:not([type=hidden]), select').forEach((el) => {
    el.addEventListener('input', () => { dirty = true; });
  });

  /* Чекбоксы задач в визуальном редакторе переключаются кликом. */
  visual.addEventListener('change', (event) => {
    if (event.target.matches('input[type="checkbox"]')) {
      event.target.toggleAttribute('checked', event.target.checked);
      markDirty();
    }
  });

  /* Виды Markdown-режима: «Текст», «Оба», «Просмотр» (выбор запоминается). */
  const viewButtons = form.querySelectorAll('[data-view]');
  function setMode(mode) {
    workspace.dataset.mode = mode;
    viewButtons.forEach((b) => b.classList.toggle('active', b.dataset.view === mode));
    writePref('editor-mode', mode);
    refreshPreview();
  }
  viewButtons.forEach((button) => button.addEventListener('click', () => setMode(button.dataset.view)));
  const savedMode = readPref('editor-mode');
  setMode(['edit', 'split', 'preview'].includes(savedMode) ? savedMode : 'split');

  /* =====================================================================
     7. ЗАГРУЗКА ФАЙЛОВ
     В Markdown-режиме на время загрузки вставляется заглушка, затем —
     готовая Markdown-ссылка; в визуальном — сразу картинка или ссылка.
     id файла добавляется в скрытое поле attachment_ids: при сохранении
     новой страницы сервер привяжет к ней эти вложения.
     ===================================================================== */
  function setStatus(text) {
    if (status) status.textContent = text;
  }

  async function uploadFiles(files) {
    /* Визуальный режим: запоминаем, где стоял курсор, — пока файл
     * выбирается в диалоге и загружается, фокус уходит из редактора. */
    if (editorType === 'visual' && visual.contains(window.getSelection().anchorNode)) saveSelection();
    for (const file of files) {
      const placeholder = `![Загрузка «${file.name}»…]()`;
      if (editorType === 'markdown') {
        textarea.setRangeText(placeholder, textarea.selectionStart, textarea.selectionEnd, 'end');
      }
      setStatus(`Загрузка ${file.name}…`);

      const body = new FormData();
      body.append('file', file);
      if (pageId) body.append('page_id', pageId);

      try {
        const response = await fetch('/api/uploads', { method: 'POST', headers: { 'X-CSRF-Token': csrfToken }, body });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);

        if (editorType === 'markdown') {
          textarea.value = textarea.value.replace(placeholder, data.markdown);
        } else {
          restoreSelection();
          insertInline(data.isImage
            ? `<img src="${escapeHtml(data.url)}" alt="${escapeHtml(data.name)}">`
            : `<a href="${escapeHtml(data.url)}">📎 ${escapeHtml(data.name)}</a>&nbsp;`);
        }
        attachmentsInput.value = [attachmentsInput.value, data.id].filter(Boolean).join(',');
        setStatus(`Загружено: ${data.name}`);
      } catch (err) {
        if (editorType === 'markdown') textarea.value = textarea.value.replace(placeholder, '');
        setStatus('');
        window.alert(`Не удалось загрузить «${file.name}»: ${err.message}`);
      }
      markDirty();
    }
  }

  fileInput.addEventListener('change', () => {
    uploadFiles([...fileInput.files]);
    fileInput.value = ''; /* чтобы можно было выбрать тот же файл повторно */
  });

  /* ---- Вставка из буфера и перетаскивание: файлы → загрузка ---- */
  function onPaste(event) {
    const files = [...(event.clipboardData?.files || [])];
    if (files.length) {
      event.preventDefault();
      uploadFiles(files);
      return;
    }
    /* В визуальный редактор HTML из Word/браузера вставляем «очищенным»:
     * без стилей, шрифтов и классов — иначе редактор показывал бы чужое
     * оформление, которого не будет в сохранённой статье. */
    if (event.currentTarget === visual) {
      const html = event.clipboardData?.getData('text/html');
      if (html) {
        event.preventDefault();
        insertHtml(cleanPastedHtml(html));
      }
    }
  }

  const ALLOWED_PASTE_TAGS = new Set(['P', 'BR', 'B', 'STRONG', 'I', 'EM', 'S', 'DEL', 'U', 'A', 'UL', 'OL', 'LI', 'H1', 'H2', 'H3', 'H4',
    'BLOCKQUOTE', 'PRE', 'CODE', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'IMG', 'HR']);
  function cleanPastedHtml(html) {
    const template = document.createElement('template');
    template.innerHTML = html;
    template.content.querySelectorAll('script, style, meta, link, title').forEach((el) => el.remove());
    template.content.querySelectorAll('*').forEach((el) => {
      if (!ALLOWED_PASTE_TAGS.has(el.tagName)) { el.replaceWith(...el.childNodes); return; }
      [...el.attributes].forEach((attr) => {
        const keep = (el.tagName === 'A' && attr.name === 'href') || (el.tagName === 'IMG' && ['src', 'alt'].includes(attr.name));
        if (!keep) el.removeAttribute(attr.name);
      });
    });
    return template.innerHTML;
  }

  function onDragOver(event) {
    if (event.dataTransfer?.types.includes('Files')) {
      event.preventDefault();
      workspace.classList.add('drag-over');
    }
  }
  function onDrop(event) {
    workspace.classList.remove('drag-over');
    const files = [...(event.dataTransfer?.files || [])];
    if (files.length) {
      event.preventDefault();
      uploadFiles(files);
    }
  }
  [textarea, visual].forEach((el) => {
    el.addEventListener('paste', onPaste);
    el.addEventListener('dragover', onDragOver);
    el.addEventListener('dragleave', () => workspace.classList.remove('drag-over'));
    el.addEventListener('drop', onDrop);
  });

  /* =====================================================================
     8. СОХРАНЕНИЕ И ЗАЩИТА ОТ ПОТЕРИ ИЗМЕНЕНИЙ
     Перед отправкой формы текст визуального редактора переносится в
     textarea (в Markdown). Браузер спросит «Покинуть страницу?», если есть
     несохранённые правки.
     ===================================================================== */
  form.addEventListener('submit', () => {
    syncVisualToMarkdown();
    dirty = false;
  });
  window.addEventListener('beforeunload', (event) => {
    if (!dirty) return;
    event.preventDefault();
    event.returnValue = '';
  });

  /* =====================================================================
     9. СТАРТ: выбранный пользователем тип редактора или настройка сайта
     ===================================================================== */
  const preferred = readPref('editor-type') || document.documentElement.dataset.defaultEditor || 'visual';
  if (preferred === 'visual' && turndown) {
    setEditorType('visual');
  } else {
    typeSwitch.querySelector('[data-editor-type-choice="markdown"]')?.classList.add('active');
    refreshPreview();
  }
})();
