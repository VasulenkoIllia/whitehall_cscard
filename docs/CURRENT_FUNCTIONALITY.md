# Поточний функціонал (CS-Cart scope)

**Останнє оновлення:** 2026-04-20 (виправлення skipDeactivationWithoutCreate + фікс націнки "За замовчуванням")

## Поточний фокус
- Активний сценарій міграції: тільки `CS-Cart`.
- `Horoshop` тимчасово винесено за межі поточного етапу.
- Frontend перенесення на React закрито по плану (Phase 5).
- **PROD:** `https://whitehallshop.workflo.space/admin` — гілка `main`, папка `/var/www/projects/whitehall_cscard`
- **TEST:** `https://whitehallshoptest.workflo.space/admin` — гілка `develop`, папка `/var/www/projects/whitehall_cscard_test`
- Деплой та workflow описані в [`docs/DEPLOYMENT.md`](./DEPLOYMENT.md).

## UI (React-адмінка)
- `Огляд` — системні KPI/readiness + JSON snapshot + **Активні джоби** (progress bar для `import_all`) + **Останні пайплайни** (тип / статус / тривалість / час).
- `Ручне керування` — покроковий pipeline-run + розширені операторські дії.
- `Постачальники` — search/sort + select-all + CRUD + модалка мапінгу + масове призначення rule set.
  - Модалка мапінгу: кнопка **"Показати прев'ю"** завжди перезавантажує прев'ю з Google Sheets (враховує поточний `Рядок заголовку`). Поле `Рядок заголовку` вказує який рядок таблиці використовується як назви колонок — після зміни треба натиснути "Показати прев'ю" щоб дропдаун оновився.
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
  - Приклад: постачальник A дає `size='-'` (маппінг → `''` → `NULL`), постачальник B дає `size=NULL` — обидва зливаються в один рядок `MA0986-K5X` з мінімальною ціною.
- Якщо маппінгу немає → `UPPER(TRIM(size))` як fallback.
- Тільки активні маппінги (`is_active = TRUE`).
- Нормалізація відбувається до `DISTINCT ON` — рядки `"xl"` і `"XL"` зливаються в один `"XL"`.
- `products_raw.size` — зберігається без змін (оригінал).
- `products_final.size` — нормалізований розмір (або NULL).
- **Деdup порожніх рядків** (`deduplicateEmptySizeRowsSql`): після всіх операцій finalize видаляє рядки з `size=''` якщо для того ж `article+job_id` вже є `size=NULL`. Захист від legacy-даних що залишились до впровадження NULLIF. В нормальному режимі видаляє 0 рядків.
- **SKU при `size=NULL`**: `WHEN pf.size IS NULL OR btrim(pf.size) = '' THEN pf.article` — суфікс не додається, SKU = тільки article.

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
| 031 | `031_add_amount_to_store_mirror.sql` | Додає колонку `amount INTEGER NOT NULL DEFAULT 0` до `store_mirror` (для синхронізації реальної кількості) |

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

## Націнки (markup rule sets)

- Rule sets: список умов (price_from/price_to → action_type/action_value).
- Кожен постачальник може мати **власний** rule set або **"За замовчуванням"** (`markup_rule_set_id = null`).
- **"За замовчуванням"** (`markup_rule_set_id = null`) → пайплайн підтягує `markup_settings.global_rule_set_id` через SQL COALESCE при імпорті. Якщо глобальне правило зміниться — всі постачальники з null автоматично отримають нове.
- **Виправлений баг (2026-04-20):** раніше коли `markup_rule_set_id = null`, LEFT JOIN до `markup_rule_sets` нічого не знаходив → `rule_set_active = false` → `ruleSetId = null` → **націнка не застосовувалась**. Фікс: додано `LEFT JOIN markup_settings` + `COALESCE(s.markup_rule_set_id, ms.global_rule_set_id)` — тепер fallback до глобального правила відбувається на рівні SQL.
- `markup_settings` — singleton таблиця (id=1), зберігає `global_rule_set_id`.

## Finalize і preview
- Finalize формує `products_final` через staged merge з `DISTINCT ON (article, size)`.
- Нормалізація розмірів — до дедупу (деталі в секції "Управління розмірами").
- Preview з `products_final` з optional supplier-фільтром.

## CS-Cart import
- Scope: тільки SKU з feature `Оновлення товару API` = `"Y"` (feature_id=564).
- Optimizer (4 рівні): feature scope → deactivate missing → delta filter → store gateway.
- Auto-hidden missing SKU при full import (без supplier-фільтра).
- `parent_article` — метадані для групування варіантів, **не блокує** товар від відправки.
- Resume після failed `store_import`.
- Progress checkpoints у `jobs.meta`.
- **Реальна кількість товару (quantity)** синхронізується від `products_final` через весь ланцюг.

### Архітектура передачі даних: article + size + quantity

**Побудова повного артикулу** (`exportPreviewDb.buildNeutralPreview`):
- `products_final` зберігає: `article` = код товару (напр. `"GY6433"`), `size` = розмір (напр. `"37.5"`), `quantity` = кількість.
- Повний артикул для CS-Cart: `article + '-' + size` коли `size` не порожній (напр. `"GY6433-37.5"`).
- Товари де розмір вже в артикулі (напр. `article="NK1234-37"`, `size=null`) залишаються як-є.
- **Важливо:** логіка навмисно проста — без перевірки `endsWith`. Існують реальні товари де модель закінчується тими ж символами що й розмір (напр. `389390-39` + size `39` → `389390-39-39`). Будь-яка евристика типу `endsWith` ламає такі товари. Правильне вирішення "double-size" потребує JOIN до `store_mirror` (не реалізовано, заплановано).
- `visibility` = `quantity > 0` (замість hardcoded `true`).
- `parentArticle` = `null` для товарів з окремим полем size (не намагаємося виводити з-за суфіксу).

**Ланцюг передачі quantity**:
1. `ExportPreviewDb.buildNeutralPreview` → `ExportPreviewRow.quantity`
2. `CsCartConnector.createImportBatch` → `CsCartImportRow.amount = row.quantity`
3. `StoreMirrorService.filterCsCartDelta` → `CsCartDeltaInputRow.amount` (використовується для порівняння змін)
4. `CsCartGateway.importProducts` → `desiredAmount = visibility ? normalizeAmount(row.amount) : 0`

### Архітектура імпорту (memory-safe, 500K+ scale)

**Feature scope filter** (`filterCsCartRowsByFeature`):
- Два паралельних SQL-запити: один фільтрує по feature value в JSONB, другий отримує всі article.
- Node.js отримує тільки рядки article — **не завантажує raw JSONB** (~5KB/товар) у пам'ять.
- До рефакторингу: `SELECT article, raw FROM store_mirror` → 177K × 5KB ≈ 885MB → OOM.
- Після: тільки `Set<string>` з article-кодів, ~10MB незалежно від розміру каталогу.

**Delta filter** (`filterCsCartDelta`):
- Порівнює `visibility`, `price`, `amount`, `parentProductId` з `store_mirror`.
- Поле `amount` синхронізується через міграцію 031 та отримує реальне значення з `products_final.quantity`.
- Логіка: `desiredAmount = visibility ? Math.max(0, Math.trunc(row.amount)) : 0` (приховані товари мають amount=0).
- Збагачує рядки `productId` та `resolvedParentProductId` прямо з `store_mirror` — без API-запиту.

**Gateway import** (`CsCartGateway.importProducts`):
- **Normal path** (дзеркало актуальне): `productId` вже pre-resolved з `store_mirror` → тільки PUT-запити до CS-Cart, `fetchProductIndexByCode()` не викликається.
- **Fallback path** (дзеркало застаріле/порожнє): завантажує індекс через API → другорівнева delta-перевірка → PUT/POST.
- `needsFallback` = `true` тільки якщо хоча б один рядок має `productId === undefined`.
- В нормальному `update_pipeline` (mirror_sync → store_import) fallback ніколи не спрацьовує.
- **Amount в PUT/POST**: `amount: desiredAmount` (реальна кількість, або 0 для прихованих товарів).

### Механізм appendCsCartMissingAsHidden

**Умова активації** (`createApplication.ts`):
```
appendCsCartMissingAsHidden ЗАПУСКАЄТЬСЯ якщо:
- disableMissingOnFullImport === true (за замовчуванням)
- Нема supplier-фільтра (full import, всі постачальники)
```

**Двосторонній автоматичний цикл:**
- Товар зник від постачальника → повний імпорт → `appendCsCartMissingAsHidden` → прихований в CS-Cart.
- Товар з'явився знову → будь-який імпорт → `filterCsCartDelta` бачить зміну visibility → відкривається в CS-Cart.

**Важливо:** механізм спрацьовує тільки на **повному імпорті** (без фільтра постачальника). При імпорті одного постачальника деактивація вимкнена — система не знає чи товар відсутній бо цей постачальник його прибрав, чи інший постачальник ще надає.

**Нові товари постачальників не ховаються помилково:** вони присутні в `sourceCodes` (вхідні рядки), тому `appendCsCartMissingAsHidden` їх пропускає — навіть якщо їх нема в дзеркалі.

**Виправлений баг (2026-04-20):** раніше існувала умова `skipDeactivationWithoutCreate` яка вимикала деактивацію якщо хоч один товар з `products_final` був відсутній у дзеркалі. З `CSCART_ALLOW_CREATE=false` (прод-конфіг) ця умова спрацьовувала майже завжди → "будуть приховані: 0" навіть при повному імпорті → зниклі товари ніколи не ховались. Умову видалено — дві операції незалежні.

## Jobs / scheduler
- **Graceful shutdown:** SIGTERM → позначає running jobs як failed + видаляє job_locks перед закриттям pool.
- **Startup cleanup:** orphaned `running` jobs → `failed` + `DELETE FROM job_locks` при старті.
  - Cleanup awaited перед `scheduler.start()` — усуває race condition де scheduler знаходив застарілі `running` jobs і кидав 409 ("інший джоб виконується").
- Scheduler (env-driven): `update_pipeline`, `store_mirror_sync`, `cleanup`.
- Runtime API для scheduler: `GET/PUT /admin/api/cron-settings` (персистенс у `cron_settings`, без рестарту).
- **Job lock self-healing:** `acquireJobLock` автоматично видаляє stale lock якщо referenced job вже не `running`.

## Стабільність
- Daily partition для `products_raw`.
- Cleanup job — старі partitions/рядки/логи/jobs.
- Payload truncation логів (`LOG_PAYLOAD_MAX_BYTES`).
- Telegram alert-sink для error-рівня.
- Scripted аудити: `audit:load`, `audit:stress`, `test:invariants`, `backend:readiness`, `store:sku-audit`.
- Live benchmark (2026-03-25): 10K SKU, ~22 SKU/s, повний rollback підтверджено.
- **Memory profile (2026-04-06):** пік ~202MB при повному sync 177K товарів після усунення OOM-вектора `filterCsCartRowsByFeature`.
- `NODE_OPTIONS=--max-old-space-size=4096` — тимчасово додано в `.env` прод як safety net; може бути прибрано після підтвердження стабільності.

## Root cause analysis (виправлені баги, 2026-04-07)

**Bug #1: Article format mismatch → productId=null in store gateway**
- **Симптом**: товари відправлялись в CS-Cart з productCode=null → відповідно не оновлювались (gateway пропускав).
- **Root cause**: `products_final` зберігає article і size окремо (`article="GY6433"`, `size="37.5"`), але `store_mirror` (синхронізована з CS-Cart) містить повний артикул (`article="GY6433-37.5"`). `buildNeutralPreview` передавав тільки `article` як `productCode` → не знаходилось в store_mirror → `productId=null` → gateway не знав що оновлювати.
- **Виправлення**: побудова повного артикулу: `article + '-' + size` в `buildNeutralPreview` (строки 68-69 `exportPreviewDb.ts`).

**Bug #2: Quantity never passed through import chain → amount=1 for all products**
- **Симптом**: усі видимі товари відправлялись в CS-Cart з `amount: 1` замість реальної кількості з `products_final.quantity`.
- **Root cause**: поле `amount` не існувало в `CsCartDeltaInputRow` інтерфейсу. `filterCsCartDelta` завжди використовував `desiredAmount = visibility ? 1 : 0`. Реальна кількість з `products_final` просто ігнорувалась.
- **Виправлення**: додано `amount: number` до `CsCartDeltaInputRow` (та пов'язані інтерфейси), передання `row.quantity` через весь ланцюг (`CsCartConnector` → `StoreMirrorService` → `CsCartGateway`), використання реальної кількості в gateway `desiredAmount = visibility ? normalizeAmount(row.amount) : 0` (строка 371 `CsCartGateway.ts`).

**Bug #3: Deactivation logic always disabled → missing products never hidden**
- **Симптом**: товари що зникли з асортименту постачальника залишались видимими в CS-Cart.
- **Root cause**: `skipDeactivationWithoutCreate` умова спрацьовувала при будь-якій кількості SKU що не в `store_mirror` (`matchedMissingInMirrorInput > 0` = `true`). Але проект має 106K+ нерелевантних SKU від постачальників (які ніколи не були в CS-Cart) → це значення завжди було `> 0` → `skipDeactivationWithoutCreate` завжди = `true` → механізм приховування товарів ніколи не запускався.
- **Виправлення**: додана пропорційна перевірка `matchedMissingInMirrorInput < matchedManagedInput` (строка 192 `createApplication.ts`). Тепер деактивація пропускається тільки якщо "пропущені" SKU менше ніж "керовані" → це сценарій переіменування; якщо "пропущених" більше → це нерелевантні SKU → деактивація запускається.

## Ще не закрито
- E2E cutover-прогін на production-like даних (`import_supplier → finalize → store_import`) з фіксацією метрик.
- Staging tuning baseline для rate-limit параметрів CS-Cart.
- Джерела 229, 243, 249 — "Mapping validation failed", потребують ремаппінгу колонок.
