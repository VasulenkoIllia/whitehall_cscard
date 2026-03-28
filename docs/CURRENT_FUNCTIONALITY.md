# Поточний функціонал (CS-Cart scope)

## Поточний фокус
- Активний сценарій міграції: тільки `CS-Cart`.
- `Horoshop` тимчасово винесено за межі поточного етапу.
- Frontend перенесення на React закрито по плану (див. `docs/PLAN_FRONTEND_REACT_MIGRATION_2026_03.md`, Phase 5).
- У React-адмінці вже реалізовано ключові операторські екрани:
  - `Огляд` (системні KPI/readiness + технічний JSON snapshot без операторських дій),
  - `Ручне керування` (покроковий pipeline-run + розширені операторські дії),
  - `Постачальники` (search/sort + select-all + CRUD + модалка мапінгу в межах 1 постачальника + масове призначення rule set для вибраних),
  - `Націнки` (markup rule sets: list/create/update/default + conditions editor),
  - `Override ціни` (price overrides: list/upsert/update),
  - `Дані` (merged/final/compare preview + `зараз в магазині` (store mirror) + `відправка в магазин` (store preview) + server filters/sort/paging controls),
  - `Крон` (runtime-настройки scheduler: `update_pipeline`, `store_mirror_sync`, `cleanup`; режими `кожні N годин`, `щодня у вибрані години`, `по днях тижня і годинах`),
  - `Моніторинг` (jobs/logs + 5 останніх `error` з датою + modal-деталі помилки + details panel `/admin/api/jobs/:jobId` + logs filter by `level/jobId`).
  - Активна вкладка зберігається між перезавантаженнями (URL `?tab=` + localStorage).
  - Дані на ключових екранах підтягуються автоматично (polling + автопідвантаження при зміні фільтрів), без обовʼязкового ручного refresh.
  - додано form-level валідації і inline помилки для операторських форм.
  - додано preflight-підтвердження для destructive дій (`cleanup`, `delete supplier/source`, `apply all_suppliers`).
  - додано retry UX для критичних mutating API дій (збереження/апдейти/джоби).
  - додано глобальну toast/notification систему для операторських дій і помилок.
  - фронтенд-структура модульна: вкладки винесені у `frontend/src/tabs/*`, `App.jsx` виконує роль контейнера стану.

## Імпорт даних
- Імпорт Google Sheets у `products_raw` з перевіркою mapping і skip-логікою.
- У поточному runtime підтримується тільки `source_type=google_sheet`; інші типи не входять у активний імпортний пайплайн.
- Підтримані керовані сценарії:
  - `import_all`
  - `import_source`
  - `import_supplier`
- Всі сценарії виконуються через jobs-layer з lock-контролем.

## Catalog admin API (backend)
- Доступні CRUD-операції для:
  - `suppliers` (search і sort)
  - `sources`
  - `mappings` (latest get/save per supplier/source, поле `comment`)
- Доступні API для pricing-керування:
  - `markup rule sets` (list/create/update/default/apply to suppliers)
  - `price overrides` (list/upsert/update)
  - Правила націнки працюють з інтервалами у форматі `[price_from; price_to)`:
    - нижня межа включена, верхня межа не включена;
    - `price_to = null` означає відкритий інтервал `до +∞`.
  - Для активних умов rule set діють guardrails (frontend + backend):
    - заборонено перетин активних діапазонів;
    - заборонено дублювання `priority` між активними умовами.
  - Валідація блокує збереження неоднозначної конфігурації і повертає помилку з номером умови (`condition #N ...`).
- Доступні операційні read API:
  - `logs` (global/by job/by level)
  - `stats` (counts + last pipeline/import jobs)
  - `backend-readiness` (gates for cutover: mirror freshness, coverage, scheduler/cleanup, blocking jobs)
- Доступні Google Sheets helper API для джерел:
  - `source-sheets` (лист аркушів + selected)
  - `source-preview` (headers + sampleRows для mapping UI)
- Доступні review/export API для операторського контролю:
  - `merged-preview`, `final-preview`, `compare-preview`
  - `store-mirror-preview`, `store-preview`
  - `merged-export`, `final-export`, `compare-export` (CSV)
- `GET /admin/api/store-preview` підтримує режими:
  - `mode=candidates` — всі кандидати з `products_final` (+ `price_overrides`) перед optimizer.
  - `mode=delta` — фактичний список рядків, які реально підуть у `store_import` після optimizer (`feature scope` + auto-hide missing для full import + delta against `store_mirror`).
  - у `mode=delta` повертаються також `previewTotal` (кандидати до optimizer) і `batchTotal` (фактично оновиться).
- `GET /admin/api/preview` і `POST /admin/api/store-import` повертають:
  - `previewTotal` (до optimizer),
  - `batchTotal` (після feature-scope + missing-hide + delta),
  - `batchMeta` (деталі оптимізації).
- `GET /admin/api/suppliers` підтримує:
  - `search=<рядок>` (пошук по `supplier.name`, case-insensitive)
  - `sort=name_asc|name_desc|id_asc` (A-Я / Я-А / дефолт по id)
- `POST /admin/api/mappings/:supplierId` підтримує поле:
  - `comment` — технічна примітка до mapping-конфігурації
- У mapping JSON підтримується окреме поле `comment` (як бізнес-дані товару):
  - зберігається у `products_raw.comment_text` / `products_final.comment_text`
  - відображається у `merged/final/compare preview` та CSV export
- `POST /admin/api/markup-rule-sets/default` підтримує глобальний default rule set
  - персистенс у `markup_settings`
  - створення нового supplier без explicit `markup_rule_set_id` бере global default (або first active fallback)
- Ендпоїнти винесені в `admin/api/*` і захищені ролями `viewer/admin`.

## Finalize і preview
- Finalize формує `products_final` через staged merge path.
- Застосовується поточна бізнес-логіка пріоритетів/цін/дедупу без зміни правил.
- Preview для магазину формується з `products_final` з optional supplier-фільтром.

## CS-Cart import
- Імпорт у CS-Cart працює через конектор і gateway.
- Перед імпортом збирається mirror-index каталогу (`product_code -> product_id/state/price/parent`).
- Scope оновлення керується product feature `Оновлення товару API` (`feature_id=564`):
  - у sync потрапляють тільки SKU з `product_features["564"].value = "Y"`.
  - це замінює legacy-підхід оновлення “по одному постачальнику”.
- Незаплановані/незмінені SKU пропускаються (оптимізація без зміни бізнес-логіки).
- Для повного `store_import` (без supplier-фільтра) керовані SKU, яких немає у поточному `products_final`, автоматично переводяться у `status=H` (hidden) у CS-Cart.
- Якщо SKU знову з’являється у постачальників, він повертається в `status=A` при наступному імпорті.
- Для `store_import` з `supplier`-фільтром auto-hidden missing SKU не застосовується (щоб не ховати чужий асортимент).
- Доступні progress-checkpoints у `jobs.meta.storeImportProgress`.
- Доступний resume після failed/canceled `store_import`.
- `store_mirror_sync` дедуплікує однаковий `article` в межах чанка перед upsert у `store_mirror` (захист від SQL conflict на дублі в API-відповіді).
- `store_mirror` має унікальний ключ `(store, article)`, тому при дублях `product_code` у магазині зберігається один стан на SKU.
- Дублі `product_code` у CS-Cart трактуються як конфлікт даних (не як модифікація), доки не підтверджено зворотне через `parent_product_id/variation_code`.
- Перед production `store_import` обов’язковий preflight: перевірка дублювання SKU у магазині, після чого `mirror:sync`.

## Jobs / scheduler / операції
- Є API запуску для:
  - `import_all`
  - `import_source`
  - `import_supplier`
  - `finalize`
  - `store_import`
  - `update_pipeline`
  - `store_mirror_sync`
  - `cleanup`
- Є CLI запуск знімка магазину без UI:
  - `npm run mirror:sync`
- Є CLI preflight-аудит дублів SKU у CS-Cart (read-only):
  - `npm run store:sku-audit`
- Є скасування job (`cancel`) з terminate backend для довгих SQL-операцій.
- Є scheduler (env-driven) для `update_pipeline`, `store_mirror_sync`, `cleanup`.
- Є runtime API для scheduler settings:
  - `GET /admin/api/cron-settings`
  - `PUT /admin/api/cron-settings`
  - з персистенсом у таблиці `cron_settings` і застосуванням без рестарту процесу.

## Стабільність і контроль об’єму
- Runtime-активація daily partition для `products_raw`.
- Cleanup job чистить старі partition/рядки/логи/завершені jobs.
- Логи мають payload truncation (`LOG_PAYLOAD_MAX_BYTES`) для контролю росту таблиці `logs`.
- Error-рівень логів має окремий alert-sink у Telegram (`src/core/alerts/TelegramAlertService.ts`):
  - env: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, optional `TELEGRAM_APP_NAME`, `TELEGRAM_TIMEOUT_MS`.
  - помилка відправки в Telegram не зупиняє основний pipeline/job flow.
- Є scripted backend load-audit контур:
  - `npm run audit:load`
  - runbook: `docs/RUNBOOK_LOAD_AUDIT_2026_03.md`
- Є scripted backend stress-аудит контур:
  - `npm run audit:stress`
  - runbook: `docs/RUNBOOK_BACKEND_STRESS_AUDIT_2026_03.md`
- Є scripted integration-invariants контур:
  - `npm run test:invariants`
  - runbook: `docs/RUNBOOK_INVARIANT_INTEGRATION_TESTS_2026_03.md`
- Є scripted readiness-зріз перед cutover:
  - `npm run backend:readiness`
  - `GET /admin/api/backend-readiness`
- Є scripted SKU-audit перед cutover:
  - `npm run store:sku-audit`
- Є scripted live benchmark write-path для CS-Cart (масовий `+delta` по цінах + auto rollback):
  - `npm run benchmark:store-price`
  - `npm run rollback:store-file`
  - runbook: `docs/RUNBOOK_CSCART_STORE_WRITE_BENCHMARK_2026_03.md`
- Preflight sign-off контур (`store:sku-audit -> mirror:sync -> backend:readiness`) успішно прогнано на локальному середовищі 2026-03-21:
  - `duplicate_sku_count = 0`
  - `gates.ready_for_store_import = true`
  - `gates.ready_for_continuous_runs = true`
- Підтверджений live benchmark на тестовому CS-Cart (Kyiv time, 2026-03-25):
  - Контур: `+100` до `10 000` SKU (`apply_plus_delta`) + rollback до початкових цін.
  - Параметри: `CSCART_RATE_LIMIT_RPS=30`, `CSCART_RATE_LIMIT_BURST=90`, `CSCART_IMPORT_CONCURRENCY=12`.
  - `apply_plus_delta`: `452965 ms` (~7m33s), `imported=9999`, `failed=1`, `~22.08 SKU/s`.
  - `rollback`: `436300 ms` (~7m16s), `imported=9996`, `skipped=1`, `failed=3`, `~22.92 SKU/s`.
  - Після recovery-pass (`rollback:store-file`) отримано `remainingRows=0` (повний відкат).
- Є scripted перенос supplier config з legacy:
  - `npm run export:legacy-config`
  - `npm run import:legacy-config`
  - runbook: `docs/RUNBOOK_SUPPLIER_CONFIG_MIGRATION_2026_03.md`

## Ще не закрито до повного parity
- E2E cutover-прогін на staging/production-like даних по цільових постачальниках (`import_supplier -> finalize -> store_import`) з фіксацією метрик.
- Зафіксувати staging tuning baseline для `CSCART_RATE_LIMIT_RPS`, `CSCART_RATE_LIMIT_BURST`, `CSCART_IMPORT_CONCURRENCY`.
