Портал поставляется как Docker-образ и запускается одной командой вместе с PostgreSQL. Образ собирается под amd64, arm64 и arm/v7.

[[toc]]

## Быстрый старт

```bash
cp .env.example .env          # задайте POSTGRES_PASSWORD и ADMIN_PASSWORD (≥ 8 символов)
docker compose up -d --build  # сборка и запуск
# → http://localhost:8080
```

## Dockerfile — двухэтапная сборка

| Этап | База | Что делает |
| --- | --- | --- |
| `deps` | `node:22-alpine` на **платформе сборщика** (`--platform=$BUILDPLATFORM`) | `npm ci --omit=dev` по `package-lock.json` с кэшем npm |
| `runtime` | `node:22-alpine` **целевой платформы** | копирует `node_modules`, `src`, `views`, `public`, `docs`; создаёт `/app/data` и `/app/custom`; пользователь `node` |

:::tip Почему сборка под ARM быстрая
В проекте нет нативных модулей, поэтому `node_modules` одинаковы для любой архитектуры. Этап `deps` выполняется на «родной» платформе сборщика без эмуляции QEMU, а готовые зависимости просто копируются в образ ARM.
:::

Другие решения в `Dockerfile`:

- **Кэш слоёв:** сначала копируются только `package*.json`, поэтому при правке кода медленный `npm ci` берётся из кэша.
- **Безопасность:** приложение работает от непривилегированного пользователя `node`, а не от root.
- **HEALTHCHECK:** каждые 30 с `wget http://127.0.0.1:3000/healthz`; неответ помечает контейнер как `unhealthy`.
- **Запуск** `CMD ["node", "src/server.js"]` — напрямую, не через npm: так `SIGTERM` доходит до приложения и срабатывает корректная остановка.
- `.dockerignore` не отправляет в сборку `node_modules`, `data`, `.env`, `custom` и Markdown-файлы, кроме `src/seed/*.md` и `docs/**/*.md`.

## docker-compose.yml

| Сервис | Образ | Особенности |
| --- | --- | --- |
| `db` | `postgres:17-alpine` | данные в volume `db-data`; порт **не** публикуется наружу; `healthcheck` через `pg_isready` |
| `app` | собирается из `Dockerfile` (`APP_IMAGE`) | стартует только после `db: service_healthy`; порт `${APP_PORT:-8080}:3000`; `init: true` |

Volumes и монтирование:

| Путь в контейнере | Источник | Что там |
| --- | --- | --- |
| `/var/lib/postgresql/data` | volume `db-data` | база данных |
| `/app/data` | volume `app-data` | вложения и сгенерированный секрет сессий |
| `/app/custom` | папка `./custom` (только чтение) | переопределения шаблонов, стилей, темы администратора |

Подключение к БД передаётся стандартными переменными `PGHOST`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`: так пароль со спецсимволами не нужно URL-кодировать. Переменные `SETTING_LDAP_*` передаются всегда, но пустое значение считается незаданным и не перекрывает умолчания.

## Мультиплатформенная сборка

```bash
# все платформы с публикацией в реестр
IMAGE=ghcr.io/you/wikispace TAG=1.0.0 docker buildx bake --push

# то же без bake
docker buildx build --platform linux/amd64,linux/arm64,linux/arm/v7 \
  -t ghcr.io/you/wikispace:1.0.0 --push .
```

`docker-bake.hcl` описывает цели `default` (три платформы) и `local` (текущая архитектура с загрузкой в локальный Docker). На сервере достаточно указать `APP_IMAGE=…` в `.env` и выполнить `docker compose pull && docker compose up -d`: Docker сам скачает вариант под свою архитектуру. Какая архитектура реально запущена, видно в **Администрирование → Обзор**.

## Эксплуатация

```bash
docker compose logs -f app                      # журнал
docker compose restart app                      # после правок в custom/
docker compose up -d --build                    # обновление (миграции применятся сами)
docker compose exec app npm run docs:import     # опубликовать эту документацию

# резервная копия
docker compose exec db pg_dump -U wiki wiki > backup.sql
docker compose cp app:/app/data ./data-backup
# восстановление базы (в пустую БД)
docker compose exec -T db psql -U wiki wiki < backup.sql
```

## HTTPS и обратный прокси

Приложение слушает HTTP на порту 3000 в контейнере. Для HTTPS поставьте перед ним nginx, Caddy или Traefik и задайте:

```dotenv
TRUST_PROXY=1        # доверять X-Forwarded-* от прокси (правильные IP для лимита входа)
COOKIE_SECURE=true   # cookie только по HTTPS; включает HSTS
```

Полный список переменных — в `.env.example` и на странице [Запуск и обработка запроса](page:Запуск и обработка запроса).
