/**
 * ============================================================================
 *  tools/seed-load.js — тестовые данные для нагрузочного тестирования
 * ============================================================================
 *  Наполняет базу реалистичным объёмом: пользователи, пространства, дерево
 *  страниц с настоящей Markdown-разметкой (заголовки, списки, таблицы, код,
 *  панели), история версий, метки и комментарии. На таких данных видно, как
 *  портал ведёт себя «через пару лет работы», а не на пустой базе.
 *
 *  Запуск (в Docker):
 *      docker compose exec app node src/tools/seed-load.js --yes
 *      docker compose exec app node src/tools/seed-load.js --yes --pages 50000 --users 5000
 *      docker compose exec app node src/tools/seed-load.js --clean      — удалить всё созданное
 *
 *  Параметры (значения по умолчанию):
 *      --users 1000     пользователи lt_user_1 … lt_user_N (10% — редакторы),
 *                       пароль у всех: LoadTest123!
 *      --spaces 50      пространства LOADT01 … LOADTnn; первое — «большое»
 *                       (четверть всех страниц), пять — закрытые (restricted)
 *      --pages 20000    страниц всего; у ~30% есть 2–3 версии в истории
 *
 *  Безопасность: всё создаётся с узнаваемыми префиксами (пространства
 *  LOADT*, пользователи lt_user_*, метки lt-*), поэтому --clean удаляет
 *  ровно то, что создал этот скрипт, и ничего больше. Без --yes скрипт
 *  ничего не пишет — защита от случайного запуска на рабочей базе.
 *  Повторный запуск без --clean добавит ЕЩЁ один набор страниц в те же
 *  пространства (пользователи и метки не дублируются).
 * ============================================================================
 */
import { pathToFileURL } from 'node:url';
import { pool, waitForDatabase } from '../db/pool.js';
import { runMigrations } from '../db/migrate.js';
import { hashPassword } from '../services/users.js';

const SPACE_PREFIX = 'LOADT';
const USER_PREFIX = 'lt_user_';
const LABEL_PREFIX = 'lt-';
const PASSWORD = 'LoadTest123!';

/* ----------------------------------------------------------------------------
 * Параметры командной строки: --name value и флаги --yes / --clean.
 * ------------------------------------------------------------------------- */
function parseArgs(argv) {
  const args = { users: 1000, spaces: 50, pages: 20000, yes: false, clean: false };
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i].replace(/^--/, '');
    if (name === 'yes' || name === 'clean') args[name] = true;
    else if (name in args) args[name] = Math.max(1, Number.parseInt(argv[++i], 10) || args[name]);
  }
  args.spaces = Math.min(args.spaces, 99); /* ключи LOADT01 … LOADT99 */
  return args;
}

/* ----------------------------------------------------------------------------
 * Детерминированный генератор случайных чисел (mulberry32): при одинаковых
 * параметрах получаются одинаковые данные — результаты тестов сравнимы.
 * ------------------------------------------------------------------------- */
function createRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = createRandom(20260926);
const pick = (list) => list[Math.floor(random() * list.length)];
const between = (min, max) => min + Math.floor(random() * (max - min + 1));

/* ----------------------------------------------------------------------------
 * Генерация текста. Словарь — типичная лексика технической базы знаний,
 * чтобы полнотекстовый поиск (русская морфология) работал как в жизни.
 * ------------------------------------------------------------------------- */
const WORDS = ('сервер база данных запрос ответ пользователь доступ настройка конфигурация '
  + 'развертывание контейнер образ сеть порт журнал ошибка предупреждение релиз версия ветка '
  + 'проект команда задача инструкция регламент процесс проверка тест нагрузка мониторинг '
  + 'метрика отчёт документ страница пространство право роль администратор редактор читатель '
  + 'резервная копия восстановление миграция схема таблица индекс поиск кэш очередь сообщение '
  + 'интеграция сервис клиент API ключ токен сертификат шифрование пароль вход выход сессия '
  + 'обновление установка удаление скрипт параметр значение переменная окружение продакшен '
  + 'стенд разработка аналитика требование согласование срок приоритет ответственный этап').split(' ');
const TOPICS = ['Регламент', 'Инструкция', 'Архитектура', 'Руководство', 'Протокол встречи', 'Решение',
  'План релиза', 'Описание сервиса', 'Чек-лист', 'FAQ', 'Инцидент', 'Требования'];

/* Частоты слов в живом тексте подчиняются закону Ципфа: слово с рангом r
 * встречается примерно в 1/r раз реже самого частого. Если брать слова
 * равномерно из маленького словаря, КАЖДОЕ слово окажется почти на каждой
 * странице и поиск будет нереалистично тяжёлым. Поэтому словарь =
 * WORDS (частые слова, ранги 0–119) + 20 000 «терминов» (редкие слова,
 * названия систем и т.п.), а ранг выбирается логарифмически-равномерно —
 * это и есть распределение Ципфа. В итоге «сервер» есть почти везде,
 * слова из конца WORDS — примерно на половине страниц, а термины — от
 * нескольких процентов страниц до единичных. */
const SYLLABLES = ['ка', 'ро', 'ми', 'та', 'ле', 'ну', 'со', 'вер', 'ди', 'па', 'лу', 'ник', 'ост', 'ран', 'зе', 'бы'];
/** i-й термин: число в 16-ричной системе, где «цифры» — слоги. Та же функция — в tests/load/lib.js. */
export function term(i) {
  let n = i + 256; /* минимум три слога */
  let word = '';
  while (n > 0) { word = SYLLABLES[n % 16] + word; n = Math.floor(n / 16); }
  return word;
}
const VOCABULARY = [...WORDS, ...Array.from({ length: 20000 }, (_, i) => term(i))];
const LOG_SIZE = Math.log(VOCABULARY.length);
const word = () => VOCABULARY[Math.min(VOCABULARY.length - 1, Math.floor(Math.exp(random() * LOG_SIZE)) - 1)];

const sentence = () => {
  const words = Array.from({ length: between(6, 16) }, word);
  words[0] = words[0][0].toUpperCase() + words[0].slice(1);
  return `${words.join(' ')}.`;
};
const paragraph = () => Array.from({ length: between(2, 5) }, sentence).join(' ');
const title = (n) => `${pick(TOPICS)}: ${pick(WORDS)} ${pick(WORDS)} №${n}`;

/** Страница Markdown ~3–8 КБ: заголовки, абзацы, список, таблица, код, панель. */
function pageContent() {
  const parts = [];
  if (random() < 0.3) parts.push('[[toc]]');
  parts.push(paragraph());
  const sections = between(2, 5);
  for (let s = 1; s <= sections; s++) {
    parts.push(`## Раздел ${s}. ${pick(WORDS)} и ${pick(WORDS)}`);
    parts.push(paragraph(), paragraph());
    const extra = random();
    if (extra < 0.25) {
      parts.push(Array.from({ length: between(3, 6) }, () => `- ${sentence()}`).join('\n'));
    } else if (extra < 0.45) {
      parts.push('| Параметр | Значение | Комментарий |\n| --- | --- | --- |\n'
        + Array.from({ length: between(3, 8) }, () => `| ${pick(WORDS)} | ${between(1, 9999)} | ${sentence()} |`).join('\n'));
    } else if (extra < 0.6) {
      parts.push(`\`\`\`bash\ndocker compose exec app ${pick(WORDS)} --${pick(WORDS)}=${between(1, 100)}\necho "${sentence()}"\n\`\`\``);
    } else if (extra < 0.72) {
      parts.push(`:::${pick(['info', 'warning', 'tip'])} ${pick(WORDS)}\n${paragraph()}\n:::`);
    }
  }
  if (random() < 0.2) parts.push(`Статус: {{status:${pick(['green', 'yellow', 'red', 'blue'])}:${pick(['ГОТОВО', 'В РАБОТЕ', 'ЧЕРНОВИК'])}}}`);
  return parts.join('\n\n');
}

/* ----------------------------------------------------------------------------
 * Пакетная вставка: один INSERT на много строк — в сотни раз быстрее
 * построчной. PostgreSQL ограничивает запрос 65 535 параметрами, поэтому
 * строки режутся на пачки.
 * ------------------------------------------------------------------------- */
async function insertMany(client, table, columns, rows, returning = '') {
  const result = [];
  const perBatch = Math.floor(60000 / columns.length);
  for (let start = 0; start < rows.length; start += perBatch) {
    const batch = rows.slice(start, start + perBatch);
    const params = [];
    const tuples = batch.map((row) => `(${row.map((value) => { params.push(value); return `$${params.length}`; }).join(', ')})`);
    const { rows: out } = await client.query(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${tuples.join(', ')} ${returning}`,
      params,
    );
    result.push(...out);
  }
  return result;
}

/* ----------------------------------------------------------------------------
 * Удаление всего, что создаёт этот скрипт. Страницы, версии, метки страниц,
 * комментарии и участники удаляются каскадно вместе с пространствами.
 * ------------------------------------------------------------------------- */
async function clean(client) {
  const spaces = await client.query(`DELETE FROM spaces WHERE key ~ $1`, [`^${SPACE_PREFIX}[0-9]+$`]);
  const users = await client.query(`DELETE FROM users WHERE username LIKE $1`, [`${USER_PREFIX}%`]);
  const labels = await client.query(`DELETE FROM labels WHERE name LIKE $1`, [`${LABEL_PREFIX}%`]);
  console.log(`[seed] Удалено: пространств ${spaces.rowCount}, пользователей ${users.rowCount}, меток ${labels.rowCount}`);
}

async function seed(client, args) {
  const started = Date.now();

  /* ---- 1. Пользователи (хеш пароля считается один раз — bcrypt медленный) ---- */
  const hash = await hashPassword(PASSWORD);
  const userRows = Array.from({ length: args.users }, (_, i) => {
    const n = i + 1;
    return [`${USER_PREFIX}${n}`, `${USER_PREFIX}${n}@loadtest.local`, `Тестовый пользователь ${n}`, hash, n % 10 === 0 ? 'editor' : 'viewer'];
  });
  await insertMany(client, 'users', ['username', 'email', 'display_name', 'password_hash', 'role'], userRows,
    'ON CONFLICT DO NOTHING');
  const { rows: users } = await client.query(`SELECT id, role FROM users WHERE username LIKE $1 ORDER BY id`, [`${USER_PREFIX}%`]);
  const authors = users.filter((u) => u.role === 'editor').map((u) => u.id);
  if (!authors.length) authors.push(users[0].id);
  console.log(`[seed] Пользователей: ${users.length} (редакторов ${authors.length}), пароль ${PASSWORD}`);

  /* ---- 2. Пространства: первое — большое, пять последних — закрытые ---- */
  const spaceRows = Array.from({ length: args.spaces }, (_, i) => {
    const key = `${SPACE_PREFIX}${String(i + 1).padStart(2, '0')}`;
    const restricted = args.spaces > 5 && i >= args.spaces - 5;
    return [key, `Нагрузочный тест ${i + 1}${i === 0 ? ' (большое)' : ''}`, paragraph(), '🧪',
      restricted ? 'restricted' : 'public', authors[0], authors[0]];
  });
  await insertMany(client, 'spaces', ['key', 'name', 'description', 'icon', 'visibility', 'created_by', 'owner_id'], spaceRows,
    'ON CONFLICT (key) DO NOTHING');
  const { rows: spaces } = await client.query(`SELECT id, visibility FROM spaces WHERE key ~ $1 ORDER BY key`, [`^${SPACE_PREFIX}[0-9]+$`]);

  /* Участники закрытых пространств: по 50 случайных пользователей. */
  const members = [];
  for (const space of spaces.filter((s) => s.visibility === 'restricted')) {
    const chosen = new Set(Array.from({ length: Math.min(50, users.length) }, () => pick(users).id));
    chosen.forEach((userId) => members.push([space.id, userId, random() < 0.3 ? 'edit' : 'read']));
  }
  if (members.length) {
    await insertMany(client, 'space_members', ['space_id', 'user_id', 'access'], members, 'ON CONFLICT DO NOTHING');
  }

  /* ---- 3. Метки ---- */
  const labelRows = Array.from({ length: 200 }, (_, i) => [`${LABEL_PREFIX}${pick(WORDS).toLowerCase()}-${i + 1}`.slice(0, 50)]);
  await insertMany(client, 'labels', ['name'], labelRows, 'ON CONFLICT (name) DO NOTHING');
  const { rows: labels } = await client.query(`SELECT id FROM labels WHERE name LIKE $1`, [`${LABEL_PREFIX}%`]);

  /* ---- 4. Страницы по пространствам ---- */
  const bigShare = spaces.length > 1 ? Math.floor(args.pages / 4) : args.pages;
  const restShare = spaces.length > 1 ? Math.floor((args.pages - bigShare) / (spaces.length - 1)) : 0;
  let totalPages = 0;
  let totalVersions = 0;
  for (const [index, space] of spaces.entries()) {
    const count = index === 0 ? bigShare : restShare;
    if (!count) continue;

    const pageRows = [];
    const versions = [];
    for (let i = 0; i < count; i++) {
      const author = pick(authors);
      const versionCount = random() < 0.3 ? between(2, 3) : 1;
      const content = pageContent();
      pageRows.push([space.id, title(totalPages + i + 1), content, i, versionCount, author, author]);
      versions.push({ versionCount, content, author });
    }
    const inserted = await insertMany(client, 'pages',
      ['space_id', 'title', 'content', 'position', 'version', 'created_by', 'updated_by'], pageRows, 'RETURNING id');
    const ids = inserted.map((r) => r.id);

    /* Дерево: первые 10 страниц — корневые, остальные — дочерние к одной из
     * предыдущих (с перекосом к началу — дерево широкое, а не «лесенка»). */
    const parents = ids.slice(10).map((id, i) => [id, ids[Math.floor(random() * random() * (i + 10))]]);
    for (let start = 0; start < parents.length; start += 5000) {
      const chunk = parents.slice(start, start + 5000);
      const params = chunk.flat();
      await client.query(
        `UPDATE pages p SET parent_id = v.parent FROM (VALUES ${chunk.map((_, i) => `($${i * 2 + 1}::int, $${i * 2 + 2}::int)`).join(', ')}) AS v(id, parent)
          WHERE p.id = v.id`,
        params,
      );
    }

    /* История версий: у последней версии — текущий текст, у старых — укороченный. */
    const versionRows = [];
    ids.forEach((id, i) => {
      const { versionCount, content, author } = versions[i];
      for (let v = 1; v <= versionCount; v++) {
        const text = v === versionCount ? content : content.slice(0, Math.floor(content.length * (0.5 + 0.2 * v)));
        versionRows.push([id, v, pageRows[i][1], text, v === 1 ? 'Создание страницы' : 'Правка', author]);
      }
    });
    await insertMany(client, 'page_versions', ['page_id', 'version', 'title', 'content', 'change_note', 'author_id'], versionRows);

    /* Метки (0–3 на страницу) и комментарии (0–3 на страницу). */
    const pageLabels = [];
    const comments = [];
    ids.forEach((id) => {
      new Set(Array.from({ length: between(0, 3) }, () => pick(labels).id)).forEach((labelId) => pageLabels.push([id, labelId]));
      for (let c = between(0, 3); c > 0; c--) comments.push([id, pick(users).id, sentence()]);
    });
    if (pageLabels.length) await insertMany(client, 'page_labels', ['page_id', 'label_id'], pageLabels, 'ON CONFLICT DO NOTHING');
    if (comments.length) await insertMany(client, 'comments', ['page_id', 'author_id', 'content'], comments);

    totalPages += ids.length;
    totalVersions += versionRows.length;
    process.stdout.write(`\r[seed] Страниц: ${totalPages} / ${args.pages}`);
  }

  await client.query('ANALYZE');
  const { rows: [size] } = await client.query('SELECT pg_size_pretty(pg_database_size(current_database())) AS size');
  console.log(`\n[seed] Готово за ${((Date.now() - started) / 1000).toFixed(0)} с: страниц ${totalPages}, версий ${totalVersions}, размер базы ${size.size}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.yes && !args.clean) {
    console.log('Скрипт добавит в базу тестовые данные. Для запуска добавьте --yes (или --clean для удаления). Подробности — в начале файла.');
    process.exit(0);
  }
  waitForDatabase()
    .then(runMigrations)
    .then(async () => {
      const client = await pool.connect();
      try {
        if (args.clean) await clean(client);
        else await seed(client, args);
      } finally {
        client.release();
      }
    })
    .then(() => pool.end())
    .catch((err) => {
      console.error('[seed] Ошибка:', err.message);
      process.exit(1);
    });
}

