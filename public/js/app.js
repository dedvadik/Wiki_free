/* ============================================================================
   app.js — общие мелкие улучшения интерфейса (на всех страницах)
   ============================================================================
   Сайт полностью работает и БЕЗ JavaScript (формы, ссылки, меню на
   <details>). Этот файл лишь делает работу удобнее:
     1. переключатель светлого/тёмного режима;
     2. подтверждение опасных действий (формы с data-confirm);
     3. закрытие выпадающих меню по клику вне их и по Esc;
     4. выезжающая боковая панель на мобильных;
     5. кнопка «Копировать» у блоков кода;
     6. подсветка текущего раздела в оглавлении при прокрутке;
     7. печать страницы;
     8. настройки этого браузера на странице «Настройки → Оформление».
     9. подгрузка свёрнутых веток дерева страниц.
   ============================================================================ */
(function () {
  'use strict';

  /* ---------------------------------------------------------------------
     1. Режим (светлый/тёмный). Сохраняем выбор в localStorage — его прочитает theme-init.js
        при следующей загрузке любой страницы.
     --------------------------------------------------------------------- */
  document.querySelectorAll('[data-action="toggle-theme"]').forEach((button) => {
    button.addEventListener('click', () => {
      const root = document.documentElement;
      const next = root.dataset.mode === 'dark' ? 'light' : 'dark';
      root.dataset.mode = next;
      try { localStorage.setItem('color-mode', next); } catch { /* приватный режим */ }
    });
  });

  /* ---------------------------------------------------------------------
     2. Подтверждение. Любая форма с атрибутом data-confirm="Текст?"
        перед отправкой покажет диалог. Слушаем событие в фазе перехвата
        (третий аргумент true), чтобы сработать раньше других обработчиков.
     --------------------------------------------------------------------- */
  document.addEventListener('submit', (event) => {
    const message = event.target.dataset && event.target.dataset.confirm;
    if (message && !window.confirm(message)) event.preventDefault();
  }, true);

  /* ---------------------------------------------------------------------
     3. Выпадающие меню на <details class="dropdown">: закрываем открытые,
        если кликнули мимо или нажали Esc.
     --------------------------------------------------------------------- */
  const closeDropdowns = (except) => {
    document.querySelectorAll('details.dropdown[open]').forEach((d) => {
      if (d !== except) d.removeAttribute('open');
    });
  };
  document.addEventListener('click', (event) => {
    closeDropdowns(event.target.closest('details.dropdown'));
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeDropdowns(null);
      document.body.classList.remove('sidebar-open');
    }
  });

  /* ---------------------------------------------------------------------
     4. Боковая панель на мобильных: кнопка «☰ Страницы» добавляет класс
        body.sidebar-open, CSS выдвигает панель. Клик по ссылке в панели
        или мимо неё — закрывает.
     --------------------------------------------------------------------- */
  document.querySelectorAll('[data-action="toggle-sidebar"]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      document.body.classList.toggle('sidebar-open');
    });
  });
  document.addEventListener('click', (event) => {
    if (!document.body.classList.contains('sidebar-open')) return;
    const sidebar = document.getElementById('sidebar');
    if (!sidebar || !sidebar.contains(event.target) || event.target.closest('a')) {
      document.body.classList.remove('sidebar-open');
    }
  });

  /* ---------------------------------------------------------------------
     5. «Копировать» у каждого блока кода в статьях.
        navigator.clipboard работает только по HTTPS или на localhost —
        на обычном http кнопку просто не показываем.
     --------------------------------------------------------------------- */
  if (navigator.clipboard && window.isSecureContext) {
    document.querySelectorAll('.page-content pre').forEach((pre) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'copy-btn';
      button.textContent = 'Копировать';
      button.addEventListener('click', async () => {
        const code = pre.querySelector('code');
        await navigator.clipboard.writeText((code || pre).innerText);
        button.textContent = 'Скопировано ✓';
        setTimeout(() => { button.textContent = 'Копировать'; }, 1500);
      });
      pre.appendChild(button);
    });
  }

  /* ---------------------------------------------------------------------
     6. Оглавление «На этой странице»: IntersectionObserver сообщает, какие
        заголовки сейчас видны, и мы подсвечиваем соответствующий пункт.
     --------------------------------------------------------------------- */
  const tocLinks = document.querySelectorAll('.page-toc a[href^="#"]');
  if (tocLinks.length && 'IntersectionObserver' in window) {
    const linkById = new Map();
    tocLinks.forEach((link) => linkById.set(decodeURIComponent(link.hash.slice(1)), link));

    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        tocLinks.forEach((l) => l.classList.remove('active'));
        const link = linkById.get(entry.target.id);
        if (link) link.classList.add('active');
      });
    }, { rootMargin: '-70px 0px -70% 0px' });

    linkById.forEach((_, id) => {
      const heading = document.getElementById(id);
      if (heading) observer.observe(heading);
    });
  }

  /* ---------------------------------------------------------------------
     7. Печать (пункт меню «⋯ → Печать»). Стили для печати — в app.css.
     --------------------------------------------------------------------- */
  document.querySelectorAll('[data-action="print"]').forEach((link) => {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      window.print();
    });
  });

  /* ---------------------------------------------------------------------
     8. Настройки этого браузера («Настройки → Оформление»): радиокнопки с
        data-pref="color-mode" | "editor-mode" | "editor-type". Значение хранится в
        localStorage и применяется сразу, без отправки формы:
          color-mode  — light | dark | auto (его читает theme-init.js);
          editor-mode — edit | split | preview (его читает editor.js).
          editor-type — visual | markdown (его читает editor.js).
     --------------------------------------------------------------------- */
  const PREF_DEFAULTS = {
    'color-mode': () => document.documentElement.dataset.defaultMode || 'light',
    'editor-mode': () => 'split',
    // Тип редактора: по умолчанию — выбранный администратором (атрибут <html>).
    'editor-type': () => document.documentElement.dataset.defaultEditor || 'visual',
  };
  const readPref = (key) => {
    try { return localStorage.getItem(key); } catch { return null; }
  };

  document.querySelectorAll('input[data-pref]').forEach((input) => {
    const key = input.dataset.pref;
    /* Отмечаем текущее значение (сервер его не знает — оно в браузере). */
    input.checked = input.value === (readPref(key) || PREF_DEFAULTS[key]?.());

    input.addEventListener('change', () => {
      if (!input.checked) return;
      try { localStorage.setItem(key, input.value); } catch { /* приватный режим */ }
      if (key === 'color-mode') {
        const mode = input.value === 'auto'
          ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
          : input.value;
        document.documentElement.dataset.mode = mode;
      }
    });
  });

  /* ---------------------------------------------------------------------
     9. Дерево страниц в боковой панели. Сервер присылает только путь к
        открытой странице; остальные ветки приходят свёрнутыми
        (<details data-tree-lazy="id"> с «Загрузка…» внутри). При первом
        раскрытии ветки подгружаем её HTML с /api/pages/:id/children.
        Событие toggle не всплывает, поэтому слушаем его на фазе
        перехвата (третий аргумент true) — один обработчик на всю страницу,
        он работает и для веток, подгруженных позже.
     --------------------------------------------------------------------- */
  document.addEventListener('toggle', async (event) => {
    const branch = event.target;
    if (!(branch instanceof HTMLDetailsElement) || !branch.open || !branch.dataset.treeLazy) return;
    const id = branch.dataset.treeLazy;
    delete branch.dataset.treeLazy; /* не загружать повторно */
    const placeholder = branch.querySelector(':scope > ul.tree');
    try {
      const response = await fetch(`/api/pages/${encodeURIComponent(id)}/children`, { headers: { Accept: 'text/html' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      /* HTML собран сервером из шаблона page-tree (названия экранированы). */
      placeholder.outerHTML = await response.text();
    } catch {
      branch.dataset.treeLazy = id; /* дать попробовать ещё раз */
      placeholder.innerHTML = '<li class="tree-loading muted small">Не удалось загрузить — сверните и раскройте ещё раз</li>';
    }
  }, true);
})();
