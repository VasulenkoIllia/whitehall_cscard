# CS-Cart connector parity (REST API)

Основні ендпоїнти (CS-Cart REST) citeturn0search3:
- GET `/api/products?items_per_page=100&page=1` — дзеркало каталогу (поля: `product_id`, `product_code`, `status`, `price`, `amount`, `updated_timestamp`, `parent_product_id`).
- PUT `/api/products/{id}` — оновлення існуючого товару (наприклад, ціна/статус).
- POST `/api/products` — створення нового товару (мінімум: `product_code`, `price`, `status`).
- POST `/api/products_update` — bulk оновлення `sku/status/amount/price` (batch payload, **поточний шлях**).
- POST `/api/stock_update` — старіший bulk-endpoint лише для `sku/amount/status`. Використовується тільки якщо ENV `CSCART_BULK_ENDPOINT=stock_update` (canary kill-switch).
- Статус: `A` (active/visible), `H` (hidden), `D` (disabled).
- Режим за замовчуванням: **update-only** (PUT по існуючому product_id з mirror). POST створення вмикається лише якщо `CSCART_ALLOW_CREATE=true`.

Пропонований мапінг з нейтрального preview:
- `article` + `size` → `product_code` (повний артикул: `article-size` коли size не порожній, або тільки `article` коли size=null)
- `parent_article` → `parent_product_id` (для варіантів; якщо немає — null)
- `visibility` → `status` (`A` коли true, `D` коли false)
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
