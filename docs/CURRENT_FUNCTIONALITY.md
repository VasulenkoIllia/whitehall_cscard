# Поточний функціонал (CS-Cart scope)

## Поточний фокус
- Активний сценарій міграції: тільки `CS-Cart`.
- `Horoshop` тимчасово винесено за межі поточного етапу.
- Frontend перенесення на React закрито по плану (Phase 5).
- Проект задеплоєний на `https://whitehallshop.workflo.space/admin` (Docker + Traefik).

## UI (React-адмінка)
- `Огляд` — системні KPI/readiness + JSON snapshot + **Активні джоби** (progress bar для `import_all`) + **Останні пайплайни** (тип / статус / тривалість / час).
- `Ручне керування` — покроковий pipeline-run + розширені операторські дії.
- `Постачальники` — search/sort + select-all + CRUD + модалка мапінгу + масове призначення rule set.
- `Націнки` — markup rule sets: list/create/update/default + conditions editor.
- `Дані` — merged/final/compare preview + `В магазині` (store mirror) + `До відправки` (store preview) + server filters/sort/paging + підтаб **Розміри**.
- `Крон` — runtime-налаштування scheduler (`update_pipeline`, `store_mirror_sync`, `cleanup`).
- `Моніторинг` — jobs/logs + 5 останніх error + modal-деталі + filter by level/jobId.
- Авторефреш на вкладці `Дані` **видалено** — пагінація стабільна, дані не стрибають.
- Активна вкладка зберігається в URL `?tab=` + localStorage.
- Form-level валідації, inline помилки, preflight-підтвердження для destructive дій, retry UX, глобальна toast/notification система.
- Фронтенд-структура модульна: `frontend/src/tabs/*`, `App.jsx` — контейнер стану.
- Subtitle прибрано з topbar.
- `/` → автоматичний редірект: залогінений → `/admin`, не залогінений → `/admin/login`.

## Управління розмірами (підтаб `Дані → Розміри`)

### Таблиця відповідностей (size_mappings)
- CRUD маппінгів: `size_from` (оригінал від постачальника) → `size_to` (нормалізований).
- **Маппінг на пустий рядок** — галочка "Пустий рядок (видалити розмір з артикулу)":
  - `size_to = ''` → під час finalize розмір стає `NULL` → SKU = тільки article (без суфіксу).
  - Захист: потрібен явний флаг `allow_empty_size_to=true` в API щоб уникнути випадкового очищення.
  - В таблиці відображається курсивом `пустий рядок` замість порожньої комірки.
- Пагінація: 50 записів на сторінку.
- Пошук по `size_from` / `size_to`.
- Фільтр: Всі / Числові / Буквені.
- **CSV bulk import** (кнопка "Імпорт CSV"):
  - Формат: `Розмір,Відповідність` (перший рядок — заголовок, пропускається).
  - Порожня "Відповідність" допускається — маппінг на пустий рядок.
  - **Перезаписує існуючі маппінги** (`ON CONFLICT DO UPDATE SET size_to, notes, is_active=TRUE`).
  - Якщо завантажено < реального total незнайомих → надсилаються всі CSV рядки на сервер.
  - Preview показує першіх 30 рядків з попередженням якщо truncated.
- `POST /admin/api/size-mappings/bulk-import`.

### Незнайомі розміри
- Показує розміри з `products_raw` які ще не мають маппінгу.
- **Реальний тотал** через CTE + `COUNT(*) OVER()` window function — не обмежується limit.
- Ліміт завантаження: 2000 (топ за кількістю товарів).
- Бейдж на вкладці "Розміри" показує реальний тотал з БД.
- Якщо завантажено < реального тоталу — банер попередження "Завантажено топ N з M".
- Пагінація: 50 записів на сторінку.
- Пошук по raw_size.
- Фільтр: Всі (без лічильника) / Числові / Буквені.
- Кнопка `[+ Маппінг]` pre-fills форму і перемикає на вкладку відповідностей.

### Нормалізація розмірів під час finalize
- `NULLIF(TRIM(COALESCE(szm.size_to, UPPER(TRIM(pr.size)))), '') AS size`
- Якщо маппінг дає `''` — результат `NULL` (не порожній рядок), щоб `DISTINCT ON (article, size)` коректно дедуплікував з іншими NULL-size рядками того ж артикулу.
- Якщо маппінгу немає → `UPPER(TRIM(size))` як fallback.
- Тільки активні маппінги (`is_active = TRUE`).
- Нормалізація відбувається до `DISTINCT ON` — рядки `"xl"` і `"XL"` зливаються в один `"XL"`.
- `products_raw.size` — зберігається без змін (оригінал).
- `products_final.size` — нормалізований розмір (або NULL).

## Імпорт даних
- Імпорт Google Sheets → `products_raw` з перевіркою mapping і skip-логікою.
- Підтримується тільки `source_type=google_sheet`.
- Сценарії: `import_all`, `import_source`, `import_supplier`.
- **`import_all` та `finalize` — асинхронний (fire-and-forget):**
  - Повертають `{ jobId }` негайно. Job у фоні.
  - Прогрес у `jobs.meta.progress` (`{ completed, total }`).
  - Фронтенд поллить `GET /admin/api/jobs/:id` кожні 3с, показує progress bar.
- **Google Sheets оптимізація:** пропускає `spreadsheets.get` якщо `sheetName` вже відомий (~130 API-запитів на `import_all`).

## Auth і користувачі
- **Ролі:** `admin` (повний доступ) / `viewer` (тільки читання, всі GET).
- **Стратегія:** `AUTH_STRATEGY=db` (продакшн) / `env` (локальна розробка).
- **`db` стратегія:** користувачі в таблиці `users`. Зміна без рестарту сервера.
- **Seed:** `AUTH_USERS_JSON` в `.env` → `npm run seed:users` (idempotent `ON CONFLICT DO UPDATE`).
- **Генерація хешу:** `npm run hash-password <пароль>` (bcrypt 12 rounds).
- Сесії in-memory, TTL = `AUTH_SESSION_TTL_MINUTES` (default 720хв).
- Сесії скидаються при рестарті сервера (in-memory store).
- `GET /` → redirect: залогінений → `/admin`, не залогінений → `/admin/login`.

## Деплой (Docker)
- `Dockerfile` — multi-stage build: builder (tsc + vite) → production (тільки dist + migrations + public).
- `docker-compose.yml` — сервіси: `whitehall-cscard-db` (postgres:16) + `whitehall-cscard-app`.
- Traefik router: `whitehall-cscard` → `whitehallshop.workflo.space`.
- БД доступна локально через SSH-тунель: `ssh -L 5433:localhost:5432 user@server -N`.
- **Міграції запускаються автоматично** при старті app: `node dist/scripts/runMigrations.js && node dist/index.js`.
- `.dockerignore` виключає `data/`, `node_modules/`, `.env*`, `output/` з build context.
- `.env.deploy` — тестовий конфіг з реальними кредами (в `.gitignore`).

### Міграції
| # | Файл | Що робить |
|---|------|-----------|
| 001 | `001_init.sql` | Базова схема |
| 020-028 | ... | Users, partitions, indexes, mirror, cron, mappings, markup, comment, sku_prefix |
| 029 | `029_add_size_mappings.sql` | Таблиця `size_mappings` + CI unique index + CHECK constraint |
| 030 | `030_allow_empty_size_to.sql` | Знімає CHECK constraint — дозволяє `size_to = ''` |

### Config snapshot (перенос даних між середовищами)
- `npm run export:config` → `output/prod_config_snapshot.json` (постачальники, джерела, маппінги колонок, націнки, розміри).
- `npm run import:config` → `INPUT_PATH=<path>` idempotent import (`ON CONFLICT DO NOTHING` + reset sequences).
- `output/` НЕ в gitignore — snapshot комітується в репо для деплою без scp.

## Catalog admin API (backend)
- CRUD: `suppliers`, `sources`, `mappings`, `markup rule sets/conditions`, `size_mappings`.
- `size_mappings`: `createSizeMapping` / `updateSizeMapping` вимагають явного `allow_empty_size_to=true` для порожнього `size_to`.
- `POST /admin/api/size-mappings/bulk-import` — bulk upsert (DO UPDATE), підтримує порожній `size_to`.
- `GET /admin/api/size-mappings/unmapped?limit=N` — повертає `{ total, fetchedCount, rows }` де `total` — реальний тотал через window function.
- Review/export API: `merged-preview`, `final-preview`, `compare-preview`, `store-mirror-preview`, `store-preview`, CSV exports.
- `store-preview` режими: `candidates` / `delta` (з `previewTotal`, `batchTotal`, `batchMeta`).

## Finalize і preview
- Finalize формує `products_final` через staged merge з `DISTINCT ON (article, size)`.
- Нормалізація розмірів — до дедупу (деталі в секції "Управління розмірами").
- Preview з `products_final` з optional supplier-фільтром.

## CS-Cart import
- Mirror-index каталогу перед імпортом (`product_code → product_id/state/price/parent`).
- Scope: тільки SKU з feature `Оновлення товару API` = `"Y"` (feature_id=564).
- Optimizer (3 рівні): feature scope → deactivate missing → delta filter.
- Auto-hidden missing SKU при full import (без supplier-фільтра).
- `parent_article` — метадані для групування варіантів, **не блокує** товар від відправки (відмінність від старого Horoshop-коду де `realParentArticles` блокував товар).
- Resume після failed `store_import`.
- Progress checkpoints у `jobs.meta`.

## Jobs / scheduler
- **Graceful shutdown:** SIGTERM → позначає running jobs як failed перед закриттям pool.
- **Startup cleanup:** orphaned `running` jobs → `failed` при старті.
- Scheduler (env-driven): `update_pipeline`, `store_mirror_sync`, `cleanup`.
- Runtime API для scheduler: `GET/PUT /admin/api/cron-settings` (персистенс у `cron_settings`, без рестарту).

## Стабільність
- Daily partition для `products_raw`.
- Cleanup job — старі partitions/рядки/логи/jobs.
- Payload truncation логів (`LOG_PAYLOAD_MAX_BYTES`).
- Telegram alert-sink для error-рівня.
- Scripted аудити: `audit:load`, `audit:stress`, `test:invariants`, `backend:readiness`, `store:sku-audit`.
- Live benchmark (2026-03-25): 10K SKU, ~22 SKU/s, повний rollback підтверджено.

## Ще не закрито
- E2E cutover-прогін на production-like даних (`import_supplier → finalize → store_import`) з фіксацією метрик.
- Staging tuning baseline для rate-limit параметрів CS-Cart.
- Джерела 229, 243, 249 — "Mapping validation failed", потребують ремаппінгу колонок.
