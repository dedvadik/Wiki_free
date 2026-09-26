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
     7. печать страницы.
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
})();
