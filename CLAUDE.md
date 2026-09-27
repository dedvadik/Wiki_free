# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

WikiSpace: a self-hosted, Confluence-style knowledge base. It has spaces, a page tree, version history, full-text search, LDAP login, per-space permissions, themes and customization. The stack is Node.js 22 (ESM), Express 5, EJS server-side templates and PostgreSQL 17. There is no build step, no bundler, no linter and no unit-test framework.

**Layout:** the repo root holds only the Docker files (`Dockerfile`, `docker-compose.yml`, `docker-bake.hcl`, `.dockerignore`, `.env.example`) plus `custom/` (admin overrides, bind-mounted into the container) and `kubernetes/` (Helm chart + examples). All application code lives in `app/`. Paths below (`src/…`, `views/…`, `public/…`) are relative to `app/`. Inside the container the code sits directly in `/app` (`/app/src`, …), so `docker compose exec app node src/…` commands have no `app/` prefix.

UI text, code comments and docs are in **Russian**. The house style is a detailed Russian comment above every non-trivial block (the original requirement for the project). Match it when adding code.

## Commands

```bash
docker compose up -d --build                # full stack (app + PostgreSQL), http://localhost:${APP_PORT:-8080}
docker compose exec app npm run docs:import # publish app/docs/portal/*.md to the portal (space CODE)
cd app && npm run dev                        # local dev without Docker: node --watch, reads app/.env (needs PG* or DATABASE_URL); custom/ is picked up as ../custom
npm run migrate                             # apply migrations manually (the server also applies them on start)
docker buildx bake                          # multi-arch image: amd64, arm64, arm/v7 (docker-bake.hcl)
```

Migrations, first-admin creation (`ADMIN_*` env) and the demo space (`SEED_DEMO`) all run automatically in `src/server.js` → `src/services/bootstrap.js`.

### Verifying changes

There are no automated unit or e2e tests in the repo. Verify against a separate Compose project, so an instance that is already running on 8080 (project `wikispace`) is not touched:

```bash
APP_PORT=18080 ADMIN_PASSWORD=Admin12345 POSTGRES_PASSWORD=testpass AUTH_RATE_LIMIT=100000 \
  docker compose -p wikitest up -d --build
docker compose -p wikitest down -v   # clean up afterwards
```

Quick HTTP checks work best as a Node script run inside the app container (`docker exec wikitest-app-1 node /tmp/x.mjs` against `http://127.0.0.1:3000`), with a manual cookie jar and the CSRF token parsed from `name="_csrf" value="…"`.

Do not use curl against the Compose hostname `app`. Recent curl builds (with libpsl) treat single-label hosts as public suffixes and silently drop cookies, so every POST fails with a CSRF 403. Use the container IP instead.

### Load tests (k6)

`app/tests/load/` holds `read-capacity.js`, `users.js`, `spike.js` and `uploads.js`, plus `lib.js` for shared helpers. `app/tests/load/README.md` has the full procedure.

```bash
docker compose -p wikitest exec app node src/tools/seed-load.js --yes     # 1000 users, 50 spaces, 20k pages; --clean removes them
docker run --rm -i --network wikitest_default -v "$PWD/app/tests/load:/scripts" grafana/k6 run -e USERS=600 /scripts/users.js
```

Scripts need `noCookiesReset: true`: otherwise k6 clears cookies every iteration and logged-in VUs become anonymous. `setup()` crawls the page tree. Pass the printed `-e PAGE_RANGES=…` to later runs to skip the crawl. Results and conclusions are in `docs/portal/31-load-testing.md`.

## Architecture

### Request pipeline (`src/app.js`)

Order matters:

1. helmet (CSP `script-src 'self'`)
2. static files (`custom/public`, `public`, `/vendor/turndown`), served before sessions
3. logger
4. body parsers (form 8 MB, JSON 5 MB, sized for the 1M-character page limit)
5. `express-session` stored in PostgreSQL (`connect-pg-simple`, cookie `wiki.sid`, `rolling: true`)
6. `flash`, `loadUser`, `locals`, `csrfProtection`
7. public routes (`/healthz`, `/theme.css`, auth)
8. `siteAccess` (the "private wiki" gate)
9. feature routers
10. 404 and the error handler

- **CSP forbids inline scripts and handlers.** All JS lives in `public/js/*.js` and finds elements through `data-*` attributes (`data-md`, `data-pref`, `data-editor-*`, `data-tree-lazy`).
- **CSRF** is custom and lazy: the token lives in the session and is checked globally before routing. Send it as the `_csrf` form field or the `X-CSRF-Token` header (read from `<meta name="csrf-token">`).
- **Express 5** catches async handler errors automatically. Throw `HttpError(status, msg)` from `src/utils/http.js`.
- **The page-view route `/pages/:id{/:slug}` must stay the last route in `src/routes/pages.js`.** Otherwise `/pages/5/history` would match as a slug.

### Templates and customization

- EJS includes always use a **leading slash** (`include('/partials/header')`).
- Overrides come from `custom/views/` and are resolved by the EJS `includer` option in `app.js`. In production the resolution is memoized; in development it is checked on every call. Passing EJS an array `root` makes it call `existsSync` on every include, which was ~16% of CPU.
- Site settings are exposed to templates as **`site`**, not `settings`. `res.locals.settings` would shadow Express's own settings and break includes.

### Settings (`src/services/settings.js`)

- `SETTINGS_SCHEMA` drives everything. Each entry has `tab`, `group`, `key`, `type` (text/url/bool/color/select/number/secret/theme/markdown/code), `default` and optional `options`/`pattern`.
- The admin forms (`/admin/settings/:tab`) are generated from the schema. Saving a tab updates only that tab's keys; an absent checkbox means false.
- Values are read in templates as `site.<key>`. Env vars `SETTING_<KEY>` provide defaults.
- `secret` fields never reach templates; code reads them with `getSecret(key)`.

### Permissions (`src/services/permissions.js`)

- Global roles are `admin`, `editor` and `viewer`.
- Per space there are `visibility` (public/restricted), `edit_policy` (editors/members), `space_members` (read/edit) and `owner_id` (manages the space's permissions).
- `getSpaceAccess(user, space)` returns `{canRead, canEdit, canManage}`.
- `requireSpaceAccess(req, access, level)` throws 401 for anonymous users and 403 for logged-in users.
- **Every listing query must filter with `readableSpacesSql(...)`**: home, search, labels, profile and uploads. Otherwise restricted content leaks.

### Content pipeline

- **Pages are always stored as Markdown**, whichever editor wrote them. History, diff, search and `.md` export depend on this.
- `renderMarkdown()` in `src/services/markdown.js` runs marked with custom extensions:
  - panels: `:::info|note|tip|success|warning|error Title … :::`
  - table of contents: `[[toc]]`
  - status: `{{status:color:TEXT}}`
  - then highlight.js and a strict `sanitize-html` allowlist. New tags or classes must be added to `SANITIZE_OPTIONS`.
- `renderPageCached(page)` caches HTML by `id:version:updated_at`. **Any code path that changes page content must bump `pages.version`** and insert a `page_versions` row.
- `/api/preview` renders with `{ editing: true }`, so an empty `[[toc]]` stays visible as a placeholder.
- Search (`src/routes/home.js`) runs in three steps:
  1. a `MATERIALIZED` CTE finds matches through the GIN tsvector index;
  2. candidates are the 1000 freshest matches (`SEARCH_RANK_LIMIT`) plus title `ILIKE` hits via the `pg_trgm` index;
  3. `ts_rank` and `ts_headline` run only on those candidates.

  Do not reintroduce `search_vector @@ q OR title ILIKE` in a single WHERE clause: it forces a full table scan.
- Page tree:
  - Sidebars use `getSpaceTreeAround(spaceId, pageId)`: root pages, children along the path to the open page, and a `child_count` per node.
  - Collapsed branches render as `<details data-tree-lazy>` and are loaded from `GET /api/pages/:id/children` (`public/js/app.js`).
  - The full `getSpaceTree` is used only for the editor's parent `<select>`.

### Editor (`public/js/editor.js` + `views/pages/form.ejs`)

Two editor types over one textarea: **Markdown** (textarea with live preview) and **visual** (contenteditable).

- Markdown → visual: the text is rendered by `/api/preview`.
- Visual → Markdown: `turndown` (served from `node_modules` at `/vendor/turndown`) with custom rules for macros, GFM tables, tight lists, task checkboxes and empty paragraphs. The conversion runs only if the visual text changed (`visualDirty`).
- In visual mode, block elements are inserted with `insertBlock` and inline elements with `insertInline` (DOM and Range API). **Not with `execCommand('insertHTML')`:** it nests blocks inside `<p>` and misplaces `contenteditable="false"` nodes.
- A new toolbar button needs `data-md="name"` in `form.ejs`, an entry in both `MARKDOWN_ACTIONS` and `VISUAL_ACTIONS`, and a turndown rule if it produces new HTML. Use `markdown-only` / `visual-only` classes for type-specific buttons.

### Other services

- **Passwords**: bcryptjs runs in a `worker_threads` pool (`password-pool.js` + `password-worker.js`). Never hash on the main thread; mass logins used to stall every request.
- **LDAP** (`services/ldap.js`, ldapts): search-and-bind with roles mapped from groups. `tlsOptions` must be passed only for `ldaps://` URLs.
- **Uploads** (`routes/uploads.js`, multer): stored on disk as UUID-named files. Only raster images and videos (list in `src/utils/media.js`, shared by uploads, markdown and the editor) are served inline; everything else is an attachment. Videos have their own size limit (`VIDEO_MAX_MB`) and are embedded with image syntax `![title](/uploads/x.mp4)`, which `renderMarkdown` turns into `<video controls>`. Every file gets `CSP: sandbox` and `nosniff`.
- **Themes**: `public/themes/<id>/theme.json` + `theme.css`, with a registry in `services/themes.js`. Custom themes go in `custom/themes/`. Styling is built on CSS variables, with `data-mode` light/dark on `<html>`. `/theme.css` is generated from the admin color settings.

### Running several instances (Kubernetes, `kubernetes/helm/wikispace`)

The app is designed to run as N interchangeable replicas; keep it that way:
- **No per-instance state.** Sessions live in PostgreSQL, files on a shared RWX volume, and `SESSION_SECRET` must be identical across replicas (the chart puts it in a Secret).
- **In-memory caches must be safe to diverge briefly.** Site settings are re-read every `SETTINGS_SYNC_SECONDS` (`startSettingsSync`, polling, not LISTEN/NOTIFY, because PgBouncer runs in transaction mode). The `/theme.css` version and the static asset version are content hashes, identical across replicas. The page HTML cache is keyed by page version.
- **One-time work goes under `withAdvisoryLock`** (`db/pool.js`): migrations, `bootstrapData`, docs import. In k8s it runs in the init container `node src/tools/prepare.js` against the primary directly (advisory locks don't work through PgBouncer). The main container uses `RUN_MIGRATIONS=false`.
- **Probes:** `/livez` (no DB, liveness) and `/healthz` (DB + not draining, readiness). SIGTERM → `startDraining()` → wait `SHUTDOWN_DELAY_SECONDS` → `server.close`.
- **Reads:** heavy read-only queries may use `readMany` (`DATABASE_READ_URL` → replicas; falls back to the primary pool). Never use it for data the user just wrote.
- **Metrics:** `METRICS_PORT` starts a separate Prometheus server (`services/metrics.js`); the HPA/KEDA settings in `values.yaml` are tuned from the load-test numbers.
- Validate chart changes with `helm lint` / `helm template` (e.g. via the `alpine/helm` image) for all files in `kubernetes/examples/`.

### Database

- Numbered SQL files in `src/db/migrations/` are applied at startup under an advisory lock.
- **Never edit an existing migration**; add the next number (currently `006_…`).
- The `pg` wrapper `src/db/pool.js` provides `one`, `many`, `query` and `transaction`. Queries are always parameterized.

### Docker

- Two-stage `Dockerfile` with the repo root as build context: `npm ci` (from `app/package*.json`) runs on `$BUILDPLATFORM`, then `node_modules` and `app/{src,views,public,docs}` are copied into `/app` of the target image.
- **Keep dependencies pure JS (no native modules)**. This is what makes the arm64/arm-v7 builds cheap.
- `.dockerignore` excludes `**/*.md` except `app/docs/**` and `app/src/seed/*.md`, plus `app/tests`, `custom` and all `node_modules`.
- `custom/` is bind-mounted read-only.

### Documentation convention

`app/docs/portal/*.md` plus `manifest.json` describe the code itself and are published to the portal with `npm run docs:import`. Cross-links use `[text](page:Page title)`. When you change behavior covered there, update the relevant page in the same change. The README also has feature and limit tables.
