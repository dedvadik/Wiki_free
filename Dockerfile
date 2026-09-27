# syntax=docker/dockerfile:1
# =============================================================================
#  Dockerfile — мультиплатформенный образ приложения WikiSpace
# =============================================================================
#  Сборка в два этапа (multi-stage build):
#    1) deps    — устанавливает npm-зависимости;
#    2) runtime — минимальный итоговый образ: Node.js + код + node_modules.
#  Инструменты сборки и npm-кэш в итоговый образ не попадают.
#
#  РАСКЛАДКА: контекст сборки — корень репозитория (здесь лежат только файлы
#  для Docker), код приложения — в папке app/. В образ он копируется в /app
#  без этого уровня: /app/src, /app/views, … — как и раньше.
#
#  МУЛЬТИПЛАТФОРМЕННОСТЬ
#  Базовый образ node:*-alpine опубликован для linux/amd64, linux/arm64,
#  linux/arm/v7 и других архитектур. Docker сам берёт вариант под нужную
#  платформу. В проекте НЕТ нативных модулей (pg, bcryptjs — чистый
#  JavaScript), поэтому node_modules одинаковы для любой архитектуры.
#  Благодаря этому этап deps выполняется на «родной» платформе сборщика
#  ($BUILDPLATFORM): npm ci не эмулируется через QEMU и работает быстро,
#  а готовые node_modules просто копируются в образ целевой платформы.
#
#  Сборка под несколько архитектур сразу (см. также docker-bake.hcl):
#    docker buildx build --platform linux/amd64,linux/arm64 -t you/wikispace:1.0 --push .
# =============================================================================

# Версию Node.js можно переопределить: --build-arg NODE_VERSION=24
ARG NODE_VERSION=22


# -----------------------------------------------------------------------------
# Этап 1: зависимости.
# --platform=$BUILDPLATFORM — выполнять на архитектуре машины, где идёт
# сборка (см. пояснение выше).
# -----------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-alpine AS deps
WORKDIR /app

# Сначала копируем ТОЛЬКО манифесты зависимостей. Docker кэширует слои:
# пока package*.json не меняются, этот медленный шаг берётся из кэша, даже
# если вы правили исходный код.
COPY app/package.json app/package-lock.json ./

# npm ci — точная установка по package-lock.json (воспроизводимые сборки).
# --omit=dev — без dev-зависимостей. Кэш npm монтируется только на время
# сборки и в слой образа не попадает.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --no-audit --no-fund


# -----------------------------------------------------------------------------
# Этап 2: итоговый образ (для каждой целевой платформы — свой).
# -----------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS runtime

# Метаданные образа (стандарт OCI) — видны в `docker inspect` и реестрах.
LABEL org.opencontainers.image.title="WikiSpace" \
      org.opencontainers.image.description="Self-hosted база знаний в стиле Confluence" \
      org.opencontainers.image.licenses="MIT"

# Переменные окружения по умолчанию (переопределяются в docker-compose / -e).
#   NODE_ENV=production — включает кэш шаблонов и скрывает детали ошибок;
#   DATA_DIR            — сюда монтируется volume с загруженными файлами;
#   CUSTOM_DIR          — папка пользовательских переопределений.
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/app/data \
    CUSTOM_DIR=/app/custom

WORKDIR /app

# Копируем зависимости из первого этапа и исходный код.
# --chown=node:node — файлы принадлежат непривилегированному пользователю.
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node app/package.json ./
COPY --chown=node:node app/src ./src
COPY --chown=node:node app/views ./views
COPY --chown=node:node app/public ./public
# Техническая документация для импорта на портал (npm run docs:import).
COPY --chown=node:node app/docs ./docs

# Папки для данных и кастомизации. Создаём заранее с владельцем node:
# именованный Docker volume при первом подключении унаследует эти права.
RUN mkdir -p /app/data/uploads /app/custom/views /app/custom/public \
    && chown -R node:node /app/data /app/custom

# Безопасность: приложение работает НЕ от root. Официальный образ node
# уже содержит пользователя node (uid 1000).
USER node

EXPOSE 3000

# Проверка здоровья: Docker раз в 30 секунд запрашивает /healthz.
# Если приложение или БД не отвечают — контейнер помечается unhealthy.
# wget входит в состав alpine (busybox), ставить curl не нужно.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/healthz" || exit 1

# Запуск напрямую через node (не через npm): так сигнал остановки SIGTERM
# доходит до приложения, и оно корректно завершает работу (см. server.js).
CMD ["node", "src/server.js"]
