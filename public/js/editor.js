/* ============================================================================
   editor.js — Markdown-редактор страниц
   ============================================================================
   Возможности:
     - панель инструментов: вставка разметки вокруг выделенного текста;
     - горячие клавиши: Ctrl+B / Ctrl+I / Ctrl+K / Ctrl+S, Tab — отступ;
     - живой предпросмотр: текст отправляется на сервер (/api/preview)
       через 400 мс после последнего нажатия клавиши — результат
       гарантированно совпадает с итоговой страницей;
     - три режима: «Текст», «Оба», «Просмотр» (выбор запоминается);
     - загрузка файлов: кнопка 📎, вставка из буфера (Ctrl+V), перетаскивание;
     - защита от потери изменений при уходе со страницы.

   Всё находится через data-атрибуты разметки (views/pages/form.ejs),
   поэтому шаблон можно менять, не трогая этот файл.
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
  const workspace = form.querySelector('.editor-workspace');
  const fileInput = form.querySelector('[data-editor-file]');
  const attachmentsInput = form.querySelector('[data-editor-attachments]');
  const status = form.querySelector('[data-editor-status]');
  const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content || '';
  const pageId = form.dataset.pageId || '';

  let dirty = false; /* есть ли несохранённые изменения */

  /* =====================================================================
     1. ОПЕРАЦИИ С ТЕКСТОМ
     setRangeText заменяет часть текста в textarea и умеет выставлять
     курсор/выделение после замены.
     ===================================================================== */

  /** Обернуть выделение: **текст**. Если ничего не выделено — вставить заглушку и выделить её. */
  function wrap(before, after = before, placeholder = 'текст') {
    const { selectionStart: start, selectionEnd: end, value } = textarea;
    const selected = value.slice(start, end) || placeholder;
    textarea.setRangeText(before + selected + after, start, end, 'end');
    textarea.setSelectionRange(start + before.length, start + before.length + selected.length);
    afterEdit();
  }

  /**
   * Добавить префикс к каждой выделенной строке («- », «> », «1. »).
   * Выделение расширяется до целых строк.
   * prefix — строка или функция (номер строки) → строка.
   */
  function prefixLines(prefix) {
    const { value } = textarea;
    const start = value.lastIndexOf('\n', textarea.selectionStart - 1) + 1;
    let end = value.indexOf('\n', textarea.selectionEnd);
    if (end === -1) end = value.length;
    const lines = value.slice(start, end).split('\n')
      .map((line, i) => (typeof prefix === 'function' ? prefix(i) : prefix) + line);
    textarea.setRangeText(lines.join('\n'), start, end, 'select');
    afterEdit();
  }

  /** Вставить блок (таблицу, панель…) на отдельных строках, отделив пустой строкой. */
  function insertBlock(text) {
    const { selectionStart: start, selectionEnd: end, value } = textarea;
    const before = value.slice(0, start);
    let lead = '';
    if (before && !before.endsWith('\n\n')) lead = before.endsWith('\n') ? '\n' : '\n\n';
    textarea.setRangeText(`${lead}${text}\n`, start, end, 'end');
    afterEdit();
  }

  /** Общие действия после любой правки: фокус, флаг изменений, предпросмотр. */
  function afterEdit() {
    textarea.focus();
    markDirty();
  }

  /* ---------------------------------------------------------------------
     Действия кнопок панели инструментов (data-md="имя").
     Чтобы добавить кнопку: добавьте <button data-md="myaction"> в шаблон
     и функцию myaction сюда.
     --------------------------------------------------------------------- */
  const ACTIONS = {
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
    upload: () => fileInput.click(),
  };

  form.querySelectorAll('[data-md]').forEach((button) => {
    button.addEventListener('click', () => ACTIONS[button.dataset.md]?.());
  });

  /* =====================================================================
     2. ГОРЯЧИЕ КЛАВИШИ
     ===================================================================== */
  textarea.addEventListener('keydown', (event) => {
    const mod = event.ctrlKey || event.metaKey; /* Ctrl на Windows/Linux, ⌘ на macOS */
    const key = event.key.toLowerCase();
    if (mod && key === 'b') { event.preventDefault(); ACTIONS.bold(); }
    else if (mod && key === 'i') { event.preventDefault(); ACTIONS.italic(); }
    else if (mod && key === 'k') { event.preventDefault(); ACTIONS.link(); }
    else if (event.key === 'Tab' && !event.shiftKey && !mod) {
      /* Tab вставляет отступ, а не уводит фокус из поля. */
      event.preventDefault();
      textarea.setRangeText('  ', textarea.selectionStart, textarea.selectionEnd, 'end');
      markDirty();
    }
  });

  /* Ctrl+S — сохранить из любого места страницы (перехватываем «Сохранить как» браузера). */
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      form.requestSubmit();
    }
  });

  /* =====================================================================
     3. ЖИВОЙ ПРЕДПРОСМОТР
     «Debounce»: ждём паузу в наборе 400 мс, чтобы не слать запрос на каждую
     букву. AbortController отменяет предыдущий запрос, если он не успел
     завершиться, — результат всегда соответствует последнему тексту.
     ===================================================================== */
  let previewTimer = null;
  let previewController = null;

  async function refreshPreview() {
    if (workspace.dataset.mode === 'edit') return; /* предпросмотр скрыт — не тратим ресурсы */
    previewController?.abort();
    previewController = new AbortController();
    try {
      const response = await fetch('/api/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ content: textarea.value }),
        signal: previewController.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      /* HTML уже очищен сервером (sanitize-html), вставлять безопасно. */
      preview.innerHTML = data.html || '<p class="muted">Здесь появится результат…</p>';
    } catch (err) {
      if (err.name !== 'AbortError') preview.innerHTML = '<p class="muted">Не удалось построить предпросмотр.</p>';
    }
  }

  function markDirty() {
    dirty = true;
    clearTimeout(previewTimer);
    previewTimer = setTimeout(refreshPreview, 400);
  }

  textarea.addEventListener('input', markDirty);
  form.querySelectorAll('input:not([type=hidden]), select').forEach((el) => {
    el.addEventListener('input', () => { dirty = true; });
  });

  /* =====================================================================
     4. РЕЖИМЫ ПРОСМОТРА. Выбор запоминается в localStorage.
     ===================================================================== */
  const viewButtons = form.querySelectorAll('[data-view]');

  function setMode(mode) {
    workspace.dataset.mode = mode;
    viewButtons.forEach((b) => b.classList.toggle('active', b.dataset.view === mode));
    try { localStorage.setItem('editor-mode', mode); } catch { /* не критично */ }
    refreshPreview();
  }

  viewButtons.forEach((button) => button.addEventListener('click', () => setMode(button.dataset.view)));

  let savedMode = 'split';
  try { savedMode = localStorage.getItem('editor-mode') || 'split'; } catch { /* не критично */ }
  setMode(['edit', 'split', 'preview'].includes(savedMode) ? savedMode : 'split');

  /* =====================================================================
     5. ЗАГРУЗКА ФАЙЛОВ
     Пока файл грузится, в текст вставляется заглушка; после ответа сервера
     она заменяется на готовую Markdown-ссылку. id загруженного файла
     добавляется в скрытое поле attachment_ids — при сохранении новой
     страницы сервер привяжет к ней эти вложения.
     ===================================================================== */
  function setStatus(text) {
    if (status) status.textContent = text;
  }

  async function uploadFiles(files) {
    for (const file of files) {
      const placeholder = `![Загрузка «${file.name}»…]()`;
      insertAtCursor(placeholder);
      setStatus(`Загрузка ${file.name}…`);

      const body = new FormData();
      body.append('file', file);
      if (pageId) body.append('page_id', pageId);

      try {
        const response = await fetch('/api/uploads', {
          method: 'POST',
          headers: { 'X-CSRF-Token': csrfToken },
          body,
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);

        textarea.value = textarea.value.replace(placeholder, data.markdown);
        attachmentsInput.value = [attachmentsInput.value, data.id].filter(Boolean).join(',');
        setStatus(`Загружено: ${data.name}`);
      } catch (err) {
        textarea.value = textarea.value.replace(placeholder, '');
        setStatus('');
        window.alert(`Не удалось загрузить «${file.name}»: ${err.message}`);
      }
      markDirty();
    }
  }

  function insertAtCursor(text) {
    const { selectionStart: start, selectionEnd: end } = textarea;
    textarea.setRangeText(text, start, end, 'end');
  }

  fileInput.addEventListener('change', () => {
    uploadFiles([...fileInput.files]);
    fileInput.value = ''; /* чтобы можно было выбрать тот же файл повторно */
  });

  /* Вставка картинки из буфера обмена (скриншот → Ctrl+V). */
  textarea.addEventListener('paste', (event) => {
    const files = [...(event.clipboardData?.files || [])];
    if (files.length) {
      event.preventDefault();
      uploadFiles(files);
    }
  });

  /* Перетаскивание файлов мышью в поле редактора. */
  textarea.addEventListener('dragover', (event) => {
    if (event.dataTransfer?.types.includes('Files')) {
      event.preventDefault();
      workspace.classList.add('drag-over');
    }
  });
  textarea.addEventListener('dragleave', () => workspace.classList.remove('drag-over'));
  textarea.addEventListener('drop', (event) => {
    workspace.classList.remove('drag-over');
    const files = [...(event.dataTransfer?.files || [])];
    if (files.length) {
      event.preventDefault();
      uploadFiles(files);
    }
  });

  /* =====================================================================
     6. ЗАЩИТА ОТ ПОТЕРИ ИЗМЕНЕНИЙ
     Браузер покажет стандартный вопрос «Покинуть страницу?», если есть
     несохранённые правки. При отправке формы флаг сбрасываем.
     ===================================================================== */
  window.addEventListener('beforeunload', (event) => {
    if (!dirty) return;
    event.preventDefault();
    event.returnValue = '';
  });
  form.addEventListener('submit', () => { dirty = false; });
})();
