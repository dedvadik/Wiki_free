/**
 * ============================================================================
 *  services/password-pool.js — пул потоков для bcrypt
 * ============================================================================
 *  Зачем. bcrypt специально медленный (~70–100 мс на пароль при стоимости
 *  10), а bcryptjs — чистый JavaScript. В основном потоке Node.js каждая
 *  проверка пароля на это время останавливала обработку ВСЕХ запросов.
 *  Нагрузочный тест показал: когда сотни людей входят почти одновременно
 *  (утро понедельника), задержки у всех остальных вырастали до секунды.
 *  Теперь хеширование идёт в отдельных потоках (worker_threads) на других
 *  ядрах процессора, а основной поток продолжает отвечать на запросы.
 *
 *  Формат хешей не меняется (тот же bcrypt), нативных модулей не нужно —
 *  мультиплатформенная сборка образа (amd64/arm64/armv7) не усложняется.
 *
 *  Размер пула: число ядер − 1 (основному потоку нужно своё ядро), от 1 до 4.
 *  Задание отдаётся наименее загруженному потоку; упавший поток
 *  перезапускается, а его задания завершаются ошибкой (пользователь
 *  увидит «попробуйте ещё раз», а не зависший запрос).
 * ============================================================================
 */
import os from 'node:os';
import { Worker } from 'node:worker_threads';

const SIZE = Math.max(1, Math.min(4, (os.availableParallelism?.() ?? os.cpus().length) - 1));
const WORKER_URL = new URL('./password-worker.js', import.meta.url);

let nextId = 1;
const workers = [];

function startWorker(slot) {
  const worker = new Worker(WORKER_URL);
  const entry = { worker, pending: new Map() };
  worker.on('message', ({ id, result, error }) => {
    const task = entry.pending.get(id);
    if (!task) return;
    entry.pending.delete(id);
    if (!entry.pending.size) worker.unref();
    if (error) task.reject(new Error(error));
    else task.resolve(result);
  });
  /* Поток упал: отклоняем его задания и запускаем замену. */
  const restart = (err) => {
    for (const task of entry.pending.values()) task.reject(err instanceof Error ? err : new Error('Поток паролей остановлен'));
    entry.pending.clear();
    if (workers[slot] === entry) startWorker(slot);
  };
  worker.on('error', restart);
  worker.on('exit', (code) => { if (code !== 0) restart(new Error(`Поток паролей завершился с кодом ${code}`)); });
  /* Простаивающий поток не мешает процессу завершиться (остановка сервера,
   * консольные скрипты); пока у потока есть задания, он «держит» процесс —
   * см. ref() в run(). */
  worker.unref();
  workers[slot] = entry;
}

function run(op, password, value) {
  if (!workers.length) for (let i = 0; i < SIZE; i++) startWorker(i);
  const entry = workers.reduce((best, w) => (w.pending.size < best.pending.size ? w : best));
  const id = nextId++;
  return new Promise((resolve, reject) => {
    if (!entry.pending.size) entry.worker.ref();
    entry.pending.set(id, { resolve, reject });
    entry.worker.postMessage({ id, op, password: String(password), value });
  });
}

/** bcrypt-хеш пароля (в отдельном потоке). */
export const hashInPool = (password, rounds) => run('hash', password, rounds);

/** Проверка пароля по bcrypt-хешу (в отдельном потоке). */
export const compareInPool = (password, hash) => run('compare', password, hash);
