/**
 * ============================================================================
 *  services/password-worker.js — поток для проверки и хеширования паролей
 * ============================================================================
 *  Запускается из services/password-pool.js как worker_thread. Получает
 *  задания { id, op, password, value } и отвечает { id, result } или
 *  { id, error }:
 *    op = 'hash'    — value = стоимость bcrypt, result = хеш;
 *    op = 'compare' — value = сохранённый хеш, result = true/false.
 *  Внутри потока можно вызывать синхронные функции: они блокируют только
 *  этот поток, а не основной, который обслуживает запросы.
 * ============================================================================
 */
import { parentPort } from 'node:worker_threads';
import bcrypt from 'bcryptjs';

parentPort.on('message', ({ id, op, password, value }) => {
  try {
    const result = op === 'hash' ? bcrypt.hashSync(password, value) : bcrypt.compareSync(password, value);
    parentPort.postMessage({ id, result });
  } catch (err) {
    parentPort.postMessage({ id, error: err.message });
  }
});
