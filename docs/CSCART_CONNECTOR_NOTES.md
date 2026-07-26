# CS-Cart connector parity (REST API)

Основні ендпоїнти (CS-Cart REST) citeturn0search3:
- GET `/api/products?items_per_page=100&page=1` — дзеркало каталогу (поля: `product_id`, `product_code`, `status`, `price`, `amount`, `updated_timestamp`, `parent_product_id`).
- PUT `/api/products/{id}` — оновлення існуючого товару (наприклад, ціна/статус).
- POST `/api/products` — створення нового товару (мінімум: `product_code`, `price`, `status`).
- POST `/api/products_update` — bulk оновлення `sku/status/amount/price` (batch payload, **поточний шлях**).
- POST `/api/stock_update` — старіший bulk-endpoint лише для `sku/amount/status`. Використовується тільки якщо ENV `CSCART_BULK_ENDPOINT=stock_update` (canary kill-switch).
- Статус: `A` (active/visible), `H` (hidden — поточна бізнес-конвенція, **єдиний** не-active статус що ставить pipeline станом на 2026-05-27). `D` (disabled) — короткий період 2026-05-08 ÷ 2026-05-27 був default; після reverse-міграції 2026-05-27 у магазині відсутній (див. секцію «D → H reverse-міграція» нижче).
- Режим за замовчуванням: **update-only** (PUT по існуючому product_id з mirror). POST створення вмикається лише якщо `CSCART_ALLOW_CREATE=true`.

Пропонований мапінг з нейтрального preview:
- `article` + `size` → `product_code` (повний артикул: `article-size` коли size не порожній, або тільки `article` коли size=null)
- `parent_article` → `parent_product_id` (для варіантів; якщо немає — null)
- `visibility` → `status` (`A` коли true, `H` коли false)
- `price_final` → `price`
- `quantity` → `amount` (реальна кількість товару; при visibility=false → amount=0)

Auth / env для CS-Cart:
- `CSCART_BASE_URL` — базовий URL магазину (без `/api` в кінці).
- `CSCART_API_USER` — email адміністратора (basic auth user).
- `CSCART_API_KEY` — API key (basic auth password).
- `CSCART_STOREFRONT_ID` — опціонально, якщо потрібно спрямовувати на конкретний storefront.
- `CSCART_BULK_ENDPOINT` (`products_update` (default) | `stock_update`) — який bulk-endpoint використовується. `stock_update` = canary fallback; не передає `price` (він ігнорується старим API).
- `CSCART_PRODUCTS_UPDATE_ENABLED` (default `true`) — увімкнути bulk-шлях. Якщо `false`, кожен SKU йде через `PUT /api/products/{id}` (повільно, тільки на дебаг). Аліас: `CSCART_STOCK_UPDATE_ENABLED`.
- `CSCART_PRODUCTS_UPDATE_BATCH_SIZE` (default `1000`, max `5000`) — розмір batch. Аліас: `CSCART_STOCK_UPDATE_BATCH_SIZE`.
- `CSCART_PRODUCTS_UPDATE_RETRY_LIMIT` (default `5`) — retry на 429/5xx для bulk-запиту. Аліас: `CSCART_STOCK_UPDATE_RETRY_LIMIT`.
- `CSCART_PRODUCTS_UPDATE_AUTH_MODE` (`auto`|`bearer`|`basic`, **default `basic` для нового endpoint у resolver-і коду**) — auth для bulk-запиту. Аліас: `CSCART_STOCK_UPDATE_AUTH_MODE`.
- `CSCART_DELTA_MAX_MIRROR_AGE_MINUTES` (default `120`, **на проді `480`**) — порог віку mirror'у. Використовується у двох місцях: delta/feature-фільтри `store_import` і бейдж готовності «Імпорт у магазин» в адмінці (раніше фронт зашивав власні 120 хв, що розходилося з реальним циклом). Пайплайн робить свій знімок кроком ① перед кожним `store_import`, тож у нормі вік дзеркала не перевищує тривалості одного циклу; 480 хв — запас на випадок збоїв. При перевищенні порогу `store_import` **падає з помилкою** (раніше тихо не відправляв нічого).
- `STORE_MIRROR_MAX_PRUNE_RATIO` (default `0.2`) — яку частку дзеркала знімок має право видалити за прогін. Знімок, що не побачив більшість каталогу, вважається зламаним: prune падає з помилкою і не чіпає таблицю. За спостереженнями нормальний `deleted` — 0-90 рядків із ~242 600 (0.04%), тож поріг можна звужувати.
- `CSCART_MAX_MISSING_IN_MIRROR_RATIO` (default `0.8`) — яка частка фінальних товарів може бути відсутня в дзеркалі, перш ніж `store_import` відмовиться відправляти. У нормі на цьому каталозі ~37% SKU справді не існує в магазині (`CSCART_ALLOW_CREATE=false`), при зламаному дзеркалі — ~99%.

### Production .env checklist (мінімальний набір)
```dotenv
CSCART_BASE_URL=https://your.shop
CSCART_API_USER=admin@your.shop
CSCART_API_KEY=<32-char-key>
CSCART_RATE_LIMIT_RPS=10
CSCART_RATE_LIMIT_BURST=20
CSCART_ITEMS_PER_PAGE=1000
CSCART_ALLOW_CREATE=false
CSCART_BULK_ENDPOINT=products_update
CSCART_DELTA_MAX_MIRROR_AGE_MINUTES=480
CSCART_API_UPDATE_FEATURE_ENABLED=true
CSCART_API_UPDATE_FEATURE_ID=564
CSCART_API_UPDATE_FEATURE_VALUE=Y
CSCART_DISABLE_MISSING_ON_FULL_IMPORT=true
```

### Auth note (Bearer)
CS-Cart офіційно документує тільки **Basic auth** (`email:apiKey` base64-encoded). На цьому магазині додатково приймається `Authorization: Bearer <base64(email:apiKey)>` — той самий токен, тільки інший префікс. Raw API key у Bearer (`Bearer <api_key>`) — повертає 401 і **не** використовується. Поточний код містить старий рядок `Bearer ${apiKey}` (рядок 178) як dead branch — ENV-default `basic` робить його неактивним. Виправляти буде окремим PR коли буде підстава вмикати Bearer-шлях.

Паритет із Horoshop-гейтвеєм:
- Mirror: пагінація через `items_per_page` + `page`; зберігати `nextCursor = page+1` поки `page*items_per_page < total_items`.
- Import: батчувати 50–100 товарів, retry/backoff при 429/5xx, логувати статичні коди помилок.
- Visibility toggle: через `status` поле, без видалень.
- Повний resync mirror: опція cron раз/тиждень — truncate локального mirror і повне проходження GET `/api/products`.

Що реалізувати у `src/connectors/cscart`:
- Gateway з basic auth (email/API key), спільні HTTP helper-и, обмеження швидкості.
- Mapper, що будує payload: `{ product_code, status, price, parent_product_id }`.
- Контрактні тести: pagination, статуси `A/H`, створення/оновлення.

## Практичні вимірювання (whitehall.com.ua)
- GET `/api/products?items_per_page=1` → 1 товар, `total_items=663`.
- GET з `items_per_page=250` → 250 товарів.
- GET з `items_per_page=500` → 500 товарів.
- GET з `items_per_page=1000` → 663 товарів (увесь каталог). Отже сторінка приймає ≥1000 позицій, обмеження визначається налаштуванням “Elements per page” в адмінці.

## Оновлення 100–300k товарів
- Bulk-шлях за замовчуванням: `POST /api/products_update` батчами (default 1000 SKU). Підтримує `status` (`A`/`H`/`D`), `amount`, `price` в одному виклику.
- Для змін, які bulk endpoint **не приймає** (`parent_product_id` — кидає 400 «Unsupported field»), використовується legacy `PUT /api/products/{id}` поштучно.
- За замовчуванням створення вимкнене (`CSCART_ALLOW_CREATE=false`), SKU без match у mirror — skip + warning.
- Рекомендований throttle: `CSCART_RATE_LIMIT_RPS` 10 (burst 20), конфігуровано; експоненційний backoff на 429/5xx.
- При помилці bulk batch (мережа, 5xx, 400 з `errors[]`) виконується fallback на поштучний `PUT` для всіх SKU цього batch-а — pipeline run не ламається.
- По кожному bulk batch фіксується short summary `{batch, endpoint, size, updatedProducts, notFound, time}` у warnings run-а.
- В кінці run-а пишеться агрегат `bulk run summary: {endpoint, bulkBatches, bulkAccepted, bulkNotFound, bulkServerTimeSec, bulkFallbackBatches}` — швидкий health-check у адмінці.

### Контракт відповіді `/api/products_update`
- HTTP 200 success: `{"status":200,"updated_products":N,"not_found_count":K,"not_found_skus":["..."],"time":0.05}`.
- HTTP 200 успіх з нульовим попаданням (legacy shape): `{"updated":0}` — парсер читає обидва поля.
- HTTP 400 unsupported fields: `{"status":400,"message":"Request contains unsupported fields","errors":[{"sku":"...","field":"weight","message":"Unsupported field"}]}` — **відхиляє весь batch**. Захист на нашому боці: `CsCartProductsUpdatePayloadRow` whitelist у TS-типі (тільки `sku|status|amount|price`).
- HTTP 400 «No valid SKU» — порожній sku, `null`, або payload-обʼєкт замість array.

### Truncate guard
Endpoint truncate-ить дробову частину `price` (`1090.50 → 1090`). Наш pipeline видає `CEIL(price_with_markup / 10) * 10` → ціле, кратне 10, тож копійки не зʼявляються. Як safety net у gateway: якщо `Number.isInteger(desiredPrice) === false` → SKU йде через PUT (зберігає копійки точно).

### Реальні замірювання на проді (2026-05-08)
Прогон через робочий код на whitehall.com.ua, 10 000 активних SKU зчитані через `GET /api/products?items_per_page=1000` (11 сторінок, 19.4s) і відправлені у gateway через `importProducts()` із синтетичним storePrice-diff (для змушення bulk-шляху без реальної зміни даних):

- 10 000 SKU = 10 batch × 1000 SKU.
- Клієнтський wall time: **4.44 сек** (rate-limited 10 RPS + ~0.3 ms/batch на CS-Cart).
- Сумарний серверний час: **0.345 сек** по всіх batch-ах. Кожен batch CS-Cart обробляв ~31-41 ms.
- Throughput: **~2250 SKU/сек** end-to-end.
- `imported=10000, failed=0, skipped=0`.
- Drift на 5 випадково вибраних SKU (status/amount/price/list_price/parent_product_id) — `0` (магазин не зачеплений, бо в payload пішли точно поточні значення).

Окремо ghost-test на 100 невідомих SKU:
- `updated_products=0, not_found_count=100, not_found_skus=[всі 100]`.
- `imported=0, failed=100`, кожен SKU зафіксований у warning із конкретним `product_code`.
- 0.29 сек end-to-end.

Для контексту: на 100 000 SKU при 10 RPS і 1000-batch — повний bulk-цикл ~10 сек серверного + ~10 сек client-side rate-limit = `~20 сек`. Раніше при PUT поштучно для 50K price-змін — `~83 хв`.

### E2E-валідація на test-середовищі (2026-05-08)
Повний цикл: imitовано реальну ситуацію коли частина SKU у магазині розійшлась з preview.

**Setup**: через `products_update` напряму приховано 2000 active SKU (`status A → H`) у test-store.

**Run #84** (`store_mirror_sync`): підхопив 2000 нових `H` (mirror visible 26 822 → 24 822, hidden 31 158 → 33 158).

**Run #85** (`update_pipeline → store_import`): з 2000 наших hidden SKU — 1355 мали `feature_564='Y'` (керовані pipeline'ом) → визначені як diff (preview каже `visibility=true`, mirror каже `visibility=false`) → bulk-reactivated. 645 не managed SKU pipeline свідомо НЕ торкнувся.

Метрики run #85:
- `delta.changed=1355, delta.skippedUnchanged=24822` — лише real changes пройшли в gateway.
- `imported=1355, failed=0, skipped=0`.
- 2 bulk-batches (1000 + 355), `bulkServerTimeSec=0.056`, `bulkFallbackBatches=0`.
- Тривалість всього `store_import` step: ~10-15 сек.

Висновки: feature-scope filter, delta-filter, bulk-flush, mirror-pipeline coordination — все працює end-to-end на реальних даних, з нульовим drift'ом і нульовим fallback'ом.

### Архітектурні вдосконалення цього циклу
Окрім самої міграції на bulk endpoint, додано низку захисних механізмів:

**Resilience:**
- `pg.Pool` має explicit `connectionTimeoutMillis=30s, statement_timeout=30min, idle_in_transaction_session_timeout=5min` — раніше defaults дозволяли безмежне зависання.
- `googleapis` `gaxios timeout=60s` + retry на ECONNRESET/ETIMEDOUT/AbortError — раніше зависалі імпорт без таймауту.
- `node-fetch` (CS-Cart) має 60s `AbortController` — раніше без таймауту, спостерігалось зависання pipeline на проді.
- PUT-fallback storm у gateway отримав `await checkCanceled()` між row-PUT-ами — оператор може скасувати застряглий fallback за ≤60s замість ≤16h.

**Performance:**
- Time-based gating для `checkCanceled` і `reportProgress` (1s) замість count-based (25/250 rows) — на 200K-row run економить ~16s SQL ping-ping.
- `JobScheduler.tick` стартує tasks через `void runTask()` — повільний `update_pipeline` більше не starve'ить sibling tasks (`mirror_sync`, `cleanup`).
- `filterCsCartDelta` пропускає missing-in-mirror коли `allowCreate=false` — у gateway не потрапляють 100K+ rows які він би все одно скіпнув (прискорення скип-фази в ~3-5x на нашому prod-каталозі).
- Migration 032: GIN+partial index на `store_mirror.raw->'product_features'` — `filterCsCartRowsByFeature` тепер Index Only Scan (12ms на 57K rows замість Seq Scan).

**Observability:**
- `appendCriticalWarning` поряд з `appendWarning` — bulk-flush summaries і fallback warnings не truncate'яться cap'ом (5000) навіть коли pipeline шумно skip'ає 100K missing-in-mirror SKU.
- `onCriticalEvent` callback у `StoreImportContext` пише errors в `logs` table в real-time, не чекаючи завершення run-у. Bulk-flush-failure error message доступний оператору одразу.
- `logs` sanitizer (`log.ts`) маскує credential-keys (`authorization`, `api_key`, `password`, `session_token`, `cookie` тощо) — захист від accidental leak'у у meta payload.

**Коректність:**
- `parentDiffers` в delta-filter і gateway тепер враховує що у нашого pipeline `parentProductCode` завжди `null` (parent керується вручну в CS-Cart admin'і). Раніше це тригерило marно-PUT для всіх variant SKU. Нинішня логіка: skip коли preview не передає parent.
- `parent_product_id` прибрано з PUT payload (dead branch — `state.parentProductId` always null).
- Startup race: `await application.startupCleanup` тепер ВЕРХ HTTP listen — перші запити після redeploy більше не отримують 409 від stale running jobs.
- `CSCART_ITEMS_PER_PAGE` ставити 1000 для mirror, щоб мінімізувати кількість сторінок.
- Runtime optimization (implemented): перед імпортом збирається повний індекс каталогу `product_code -> product_id/status/price/amount/parent_product_id`, після чого:
  - не робляться lookup-запити для кожного SKU,
  - незмінені SKU пропускаються (порівнюється visibility, price, amount, parentProductId),
  - `amount` синхронізується з реальною кількістю з `products_final.quantity` через delta-фільтр,
  - `parent_product_id` резолвиться через індекс (по `parent_product_code`).
- Scope керування оновленням (implemented, заміна legacy supplier-scope):
  - у CS-Cart керований асортимент визначається product feature `Оновлення товару API` (`feature_id=564`).
  - у sync потрапляють тільки SKU, де `product_features["564"].value = "Y"` (case-insensitive).
  - SKU без цього прапорця ніколи не оновлюються з пайплайна.
- Missing товарів (implemented, покращено 2026-04-07): для повного `store_import` (без supplier-фільтра) перед delta-фільтром додаються рядки де:
  - SKU є в `store_mirror`, входить у керований scope (feature `564=Y`) і має `visibility=true`,
  - SKU відсутній у поточному `products_final` preview.
  - Такі SKU відправляються в CS-Cart зі `status=D` (disabled), без видалення.
  - Якщо SKU зʼявляється знову у постачальника, звичайний preview повертає `visibility=true` і товар оновлюється до `status=A`.
- Для supplier-scoped запусків (`store-import?supplier=...`) auto-hidden missing SKU не виконується, щоб не ховати товари поза поточним partial-run.
- **Додатковий захист від нерелевантних SKU** (2026-04-07): `skipDeactivationWithoutCreate` тепер робить пропорційну перевірку `matchedMissingInMirrorInput < matchedManagedInput`. Раніше деактивація вимикалась при будь-якій кількості SKU що не в store_mirror (106K+ нерелевантних SKU постачальників завжди це спричиняли). Тепер:
  - якщо "пропущених" < "керованих" → це сценарій переіменування → деактивація пропускається (захист от помилкового ховання нових варіантів)
  - якщо "пропущених" >= "керованих" → це нерелевантні SKU → деактивація запускається нормально
- Feature-flag: `CSCART_DISABLE_MISSING_ON_FULL_IMPORT` (default `true`), `false` вимикає цей крок.
- Feature-scope env:
  - `CSCART_API_UPDATE_FEATURE_ENABLED` (default `true`)
  - `CSCART_API_UPDATE_FEATURE_ID` (default `564`)
  - `CSCART_API_UPDATE_FEATURE_VALUE` (default `"Y"`)
- Додатковий env для throughput: `CSCART_IMPORT_CONCURRENCY` (default `4`), паралелізм worker-ів імпорту поверх rate-limit токен-бакета.
- Під час імпорту прибрано зайву копію масиву рядків (менше пікового RAM на великих партіях).
- `store_mirror_sync` працює потоково по сторінках у БД (без накопичення повного snapshot у памʼяті).
- Для важких запусків job API за замовчуванням повертає compact summary:
  - `POST /admin/api/jobs/store-import`
  - `POST /admin/api/jobs/update-pipeline`
  - повний payload можна отримати через `verbose=true`.
- Для операторського контролю ефективної дельти:
  - `GET /admin/api/preview` і `POST /admin/api/store-import` повертають одночасно
    `previewTotal` (до optimizer) і `batchTotal` (після feature-scope/missing-hide/delta),
    а також `batchMeta` з деталями фільтрації.

## Дублі `product_code` у CS-Cart (критичний контроль)
- Якщо у магазині кілька `product_id` з однаковим `product_code`, це конфлікт даних для update-only синку.
- Для `store_mirror` це не може бути представлено як кілька рядків, бо ключ у таблиці: `(store, article)`.
- Поточна політика:
  - `store_mirror_sync` дедуплікує дублікати одного `article` в межах batch upsert (стабільність SQL).
  - Подальший `store_import` опирається на єдиний mirror-state на SKU.
- Це не вважається модифікацією автоматично. Для модифікацій очікується зв’язок через `parent_product_id`/варіативну модель, а не дублювання одного `product_code` у кількох товарах верхнього рівня.
- Операційна вимога перед cutover:
  - запустити `npm run store:sku-audit` і переконатися, що `duplicate_sku_count = 0`,
  - спочатку очистити дублікати SKU в адмінці CS-Cart (залишити один canonical товар або розвести коди),
  - потім виконати `npm run mirror:sync`,
  - лише після цього запускати `store_import`.

## Операційна стабільність логів
- Логи проходять санітизацію і обрізання payload (`LOG_PAYLOAD_MAX_BYTES`, default `32768`).
- Це обмежує зростання таблиці `logs` при великих результатах або помилках з великим stack/data.

## Progress checkpoints (runtime)
- Під час `store_import` CS-Cart gateway передає прогрес (`total/processed/imported/failed/skipped`) через `StoreImportContext.onProgress`.
- Runner зберігає checkpoint у `jobs.meta.storeImportProgress` (періодично та фінальним записом).
- У логи пишуться batch-метрики (`store_import batch metrics`): вікно обробки, delta counters, batch rate, total rate, ETA.
- У `jobs.meta.storeImportMetrics` зберігається останній агрегований snapshot + `lastBatch`.
- Це не змінює бізнес-результат імпорту, але дає операційний контроль і базу для resume після cancel/failure.

## Resume API для store_import
- `POST /admin/api/store-import` і `POST /admin/api/jobs/store-import` підтримують:
  - `resumeFromJobId` — явний failed/canceled `store_import` job id;
  - `resumeLatest=true` — знайти останній failed/canceled `store_import` для того ж supplier-фільтра.
- Resume виконується через `resumeProcessed`: gateway пропускає вже пройдений сегмент і продовжує з checkpoint.
- Валідація безпеки:
  - source job має бути `type=store_import`;
  - status тільки `failed` або `canceled`;
  - supplier-фільтр має збігатися;
  - checkpoint `processed > 0` обов'язковий.
- В адмін-сторінці `public/admin/index.html` додані поля для `resumeLatest` і `resumeFromJobId`.

## Import parity endpoints (legacy scope)
- Для керованих імпортів без повного прогону пайплайна доступні:
  - `POST /admin/api/jobs/import-source` (`sourceId`)
  - `POST /admin/api/jobs/import-supplier` (`supplierId`)
- Ці джоби використовують той самий імпортний код (`ImporterDb`) і ті самі бізнес-правила, що `import_all`.

## D → H reverse-міграція (2026-05-27, one-time)
2026-05-08 ми перевели pipeline з `H` на `D` (commit `923c7af`, історичний контекст нижче). 2026-05-27 бізнес вирішив **повернутися до `H`**:
- Pipeline переведено назад на `A + H` (тип `desiredStatus: 'A' | 'H'`, `normalizeStatus` → `'A' | 'H'`).
- Існуючі ~92 000 SKU зі `status=D` у магазині треба було повернути на `H`.

Зробили reverse one-time міграцію через окремий скрипт `src/scripts/migrateDisabledToHidden.ts` (npm: `migrate:d-to-h`):
- Сканує весь каталог через `GET /api/products?items_per_page=1000`.
- Збирає SKU зі `status='D'` у snapshot (`/tmp/d_to_h_<ts>.json`).
- Bulk-update через `POST /api/products_update` payload `[{sku, status:'H'}]` батчами по 1000.
- DRY_RUN режим (через ENV `DRY_RUN=true`) — лише сканує, без писань.

Скрипт **idempotent** — повторний запуск після часткової міграції підхопить лише ті SKU що залишилися у `D`. Звичайний pipeline далі підтримує `A`/`H` без додаткової роботи.

### Історична довідка: H → D (2026-05-08, скасовано 2026-05-27)
До 2026-05-08 у проді 91 993 SKU мали `status=H` (legacy hidden). Тоді бізнес перейшов на `A + D`. Зробили one-time `migrateHiddenToDisabled.ts` (commit `923c7af`):
- Scan: 239 091 products → 91 993 H, 147 074 A, 24 D (10 хв scan-фаза).
- Bulk update: **91 993 SKU за 1.93 сек серверного часу CS-Cart** (92 batches × ~20 ms), wall time 23 сек.
- Після `mirror_sync`: A=147 049, D=92 011, **H=0**.
- Snapshot: `/tmp/h_to_d_1778242362027.json` всередині container.

Цикл `H → D → H` зайняв 19 днів. Скрипт `migrateHiddenToDisabled.ts` видалено з кодової бази як `migrate:d-to-h` його замінює; історичний код доступний у git history (commit `923c7af`).

## Підсумкові prod-метрики циклу міграції (2026-05-08)
Усе наступне підтверджено реальними prod-runs на whitehall.com.ua:

| Сценарій | Run | Метрика |
|---|---|---|
| Перший cron-tick з новим кодом | `update_pipeline #494` | 27 хв (включно з `import_all` 9 хв + `finalize` 10 сек + перший store_import 5m35s з 38K real changes) |
| Звичайний дрібний run | `store_import #502` | 162 SKU за 0.116 сек server time, 43 сек wall (1 batch, fallback=0) |
| H → D міграція (2026-05-08, історія) | `migrateHiddenToDisabled` | 91 993 SKU за 1.93 сек server time, 23 сек wall (92 batches, fallback=0) |

| Аспект | Раніше | Тепер |
|---|---|---|
| Bulk endpoint для status/amount/price | відсутній (тільки PUT поштучно) | `POST /api/products_update` |
| Тривалість 38K real changes | ~83 хв (PUT × 38K при 10 RPS) | ~5-6 хв (38 batches) |
| Тривалість дрібних run'ів | (per-SKU PUT pace) | sub-second server time |
| Status convention | `A` + `H` + `D` mix → (2026-05-08) `A` + `D` → (2026-05-27) `A` + `H` | `A` + `H` |
| Захист від зависання fetch | відсутній | `AbortController` 60 сек + retry |
| Захист від pool exhaustion | defaults | explicit timeouts (30 хв statement, 5 хв idle-in-tx) |
| Live diagnostics для bulk-fail | прихована за warnings cap=200 | `logService.log('error')` через `onCriticalEvent` real-time |
| Missing-in-mirror у gateway | проходять весь loop і скіпаються | відсікаються в `filterCsCartDelta` коли `allowCreate=false` |
| Migration 032: indexes | відсутні | partial GIN на `store_mirror.raw->'product_features'` + functional partial для `feature_564='Y'` |
| Canary kill-switch | відсутній | `CSCART_BULK_ENDPOINT=stock_update` повертає до старого endpoint без redeploy |

## Колекція в магазині (feature 558, 2026-05-09)

В CS-Cart кожен товар має ручну характеристику **"Колекція + Модель"** (`feature_id=558`),
де адмін магазину виставляє базовий код моделі (наприклад `FD9919-001` для всіх розмірних
варіацій кросівок Nike Zoom Vomero 5). Це **не product_code батьківського товару**
(той часто має суфікс конкретного розміру), а окремий стабільний бізнес-код колекції.

### Покриття на проді (виміри 2026-05-09, 239 035 рядків `store_mirror`)
- `has_558_value`: 238 072 (99.6%) — активний асортимент.
- `empty_or_missing`: 963 (0.4%) — усі зі `status='D'` (deleted).
- Унікальних колекцій: 93 176 (≈2.5 SKU/колекція).
- Збіг наших `products_final.article` з колекціями магазину: 67 759 з 106 748 (63%) — для них фото/опис уже є в CS-Cart, треба лише додати варіацію.

### Денормалізація у `store_mirror.collection_code` (migration 033)
- `ALTER TABLE store_mirror ADD COLUMN collection_code TEXT`.
- Backfill з `raw->'product_features'->'558'->>'value'` (хардкод 558 у міграції — runtime читає ENV).
- Partial B-tree: `store_mirror_store_collection_idx ON (store, collection_code) WHERE collection_code IS NOT NULL`.
- Розмір: ~5 MB колонка + ~10 MB індекс на 239k рядків.
- Бекфіл-UPDATE: ~30-60 сек, створює мертві версії рядків (MVCC).
- ⚠️ **Після міграції виконати** `VACUUM (ANALYZE) store_mirror` — поза транзакцією, бо runMigrations обгортає кожен файл `BEGIN/COMMIT`.

### Runtime запис (CsCartGateway + StoreMirrorService)
- `MirrorRow.collectionCode: string | null` — нове опціональне поле в [`src/core/domain/store.ts`](../src/core/domain/store.ts).
- `CsCartGateway.fetchProductsPage` витягує `p.product_features?.[CSCART_COLLECTION_FEATURE_ID]?.value` під час mirror sync.
- `StoreMirrorService.upsertBatch` пише `collection_code` як 10-й параметр (раніше було 9). ON CONFLICT оновлює його разом із рештою.
- HoroshopConnector не зачеплено: поле опціональне, gateway не передає → null.

### Compare-tab (новий стовпець + фільтр + пошук)
- `listComparePreview` ([`CatalogAdminService.ts:1654`](../src/core/admin/CatalogAdminService.ts)) додає:
  ```sql
  LEFT JOIN LATERAL (
    SELECT sm.collection_code AS code
    FROM store_mirror sm
    WHERE sm.store = $store AND sm.collection_code = base.article
    LIMIT 1
  ) sm_col ON TRUE
  ```
- Новий SELECT-поле `store_collection_code`. Значення = колекція в магазині (= `base.article` коли матч), NULL інакше.
- Опційний фільтр `missingCollectionOnly=true` → додає `WHERE sm_col.code IS NULL`.
- Пошук розширено: `OR COALESCE(sm_col.code, '') ILIKE` (експліцитно, навіть якщо часто redundant з `base.article ILIKE`).
- Плейсхолдер пошуку у Compare на фронті: `артикул / SKU / колекція`.
- CSV-експорт `compare-export` додав останнє поле `store_collection_code`. Існуючі позиції 0..14 не зсунулись — backwards-compatible для зовнішніх споживачів.

### UI (frontend/src/tabs/DataTab.jsx)
Прибрано 4 колонки з Compare-вкладки (дублювали інформацію з Mirror-вкладки):
- `store_price` (Ціна в магазині), `store_visibility` (Видимість), `store_supplier` (Постачальник в магазині), `comment` (Коментар).

Додано:
- Колонку **«Колекція в магазині»** (`store_collection_code`).
- Чекбокс **«Лише без колекції»** поряд з «Лише missing». Обидва незалежні, можна комбінувати.
- CSS-клас `.wrap` для довгих текстових клітинок (`white-space: normal; word-break: break-word; max-width: 240px`) + tighter padding `6px 5px` для `.data-table` — прибирає горизонтальний скрол на стандартних екранах.

### Сегментація missing-кандидатів
Комбінації двох чекбоксів дають 4 практичні стани:

| Лише missing | Лише без колекції | Що оператор бачить | Дія |
|---|---|---|---|
| ☐ | ☐ | Усі рядки (~194 518 на проді) | Загальний перегляд |
| ☑ | ☐ | Варіація відсутня в магазині (~44 329) | Як працював фільтр і раніше |
| ☐ | ☑ | Колекція ще не створена в магазині | Треба робити нову картку |
| ☑ | ☑ | Перетин: ні варіації, ні колекції | "Створити з нуля" — кандидати на повне створення |

### ENV
```dotenv
CSCART_COLLECTION_FEATURE_ID=558    # default; прод whitehall.com.ua
```
Якщо в іншому магазині feature_id інший — підставити через ENV. Бекфіл-міграція хардкодить 558 (вимога runMigrations.ts: одна транзакція, без параметрів). Якщо потрібен інший id — окрема one-time UPDATE.

### Обмеження
- Якщо адмін CS-Cart не виставив feature 558 для конкретного товару — `collection_code = NULL` → у Compare колонка покаже `-` навіть якщо товар фізично є в магазині. Це не баг, а **сигнал про неконсистентність даних магазину** (data quality check).
- LATERAL JOIN дає O(log n) lookup завдяки partial index. На 5000-row Compare запиту додає ~30-50 ms.
- Backfill — one-time. Подальші зміни підхоплюються runtime upsert через mirror_sync (≤ cron interval лаг).

## Варіація-група (variation_group_code, 2026-05-09)

CS-Cart має built-in систему варіацій: товари однієї моделі з різними розмірами/кольорами
групуються у "variation group". Адмін задає **`variation_group_code`** (поле "Група варіацій"
у CS-Cart admin → Варіації) — це CS-Cart-нативний код групи, не пов'язаний з нашими SKU.

### Що це і як відрізняється від collection_code (feature 558)
- `collection_code` (feature 558) — **бізнес-код моделі**, заповнюється admin'ом руками,
  часто збігається з нашим `products_final.article` (формат однаковий).
- `variation_group_code` — **технічний код групи варіацій**, генерується CS-Cart variation-system.
  Може мати інший формат (наприклад `013_012_1504` з підкресленнями замість `013.012.1504` з крапками).

Один товар може мати **обидва** поля одночасно (як `FD9919-001-36` де обидва = `FD9919-001`),
тільки feature 558 (як `saint-laurent-condom-black` без variation group), або тільки
variation_group_code (рідкісно).

### Покриття на проді (виміри 2026-05-09, 239 028 рядків `store_mirror`)
- `with_vgc`: 216 559 (90.6%) — товари у variation-group.
- `without_vgc`: 22 469 (9.4%) — single-SKU без варіацій.
- Унікальних variation_group_code: 76 407.

### Денормалізація у `store_mirror.variation_group_code` (migration 034)
- `ALTER TABLE store_mirror ADD COLUMN variation_group_code TEXT`.
- Backfill з `raw->>'variation_group_code'` (top-level field, не feature).
- Partial B-tree: `store_mirror_store_variation_group_idx ON (store, variation_group_code) WHERE variation_group_code IS NOT NULL`.
- Розмір: ~5 MB колонка + ~10 MB індекс на 239k рядків.
- Бекфіл-UPDATE: ~30-60 сек, MVCC bloat.
- ⚠️ Після міграції виконати `VACUUM (ANALYZE) store_mirror`.
- ⚠️ Pause mirror_sync на час деплою — інакше backfill UPDATE може заблокувати/блокуватися concurrent upserts.

### Runtime запис
- `MirrorRow.variationGroupCode: string | null` ([`src/core/domain/store.ts`](../src/core/domain/store.ts)).
- `CsCartGateway.fetchProductsPage` витягує `p.variation_group_code` під час mirror sync.
- `StoreMirrorService.upsertBatch` пише `variation_group_code` як 11-й параметр (раніше було 10).

### Compare-tab UI/SQL зміни (2026-05-09)
Окрім додавання `variation_group_code`, цей цикл синхронізував Compare-вкладку зі своїм CSV-експортом і прибрав застарілі колонки:

**Прибрано з Compare** (UI + CSV):
- `Артикул в магазині` (`store_article` через `sm_base.article = base.article`) — давав фантомні `-` для товарів де парент-product_code має суфікс розміру (наприклад `FD9919-001-36` як парент). Замість нього використовувати `Колекція в магазині` або `SKU магазину`.
- `Ціна в магазині`, `Видимість в магазині`, `Постачальник в магазині`, `Коментар` — дублювали Mirror-вкладку.

**Додано**: колонка `Варіація-група` (`store_variation_group_code`). Показує CS-Cart variation_group_code **будь-якої** варіації цієї моделі в магазині (per-collection lookup, не per-SKU). Реалізовано через `LEFT JOIN LATERAL` що шукає в `store_mirror` рядок з `collection_code = base.article` AND `variation_group_code IS NOT NULL`, повертає його `variation_group_code`. Якщо в магазині нема жодної варіації цієї моделі з ненульовим `variation_group_code` → `-`. Симетрично з `Колекція в магазині` — обидві відповідають на питання "що ця модель має в магазині", не "що цей конкретний SKU має".

**SQL**: `listComparePreview` спрощено — прибрано `LEFT JOIN store_mirror sm_base`, прибрано з SELECT всі store_*-поля, що були видалені з UI/CSV. Зменшує bandwidth і простір плану.

**Search**: пошук тепер перевіряє `OR COALESCE(sm_sku.variation_group_code, '') ILIKE` поряд з article/SKU/collection.

**CSV**: рівно 12 полів = UI columns. Старі скрипти, що індексують CSV по позиції, **зламаються** (наприклад, `row[10]` тепер `store_sku`, не `store_article`). Backwards-incompat, але запит явний від оператора.
