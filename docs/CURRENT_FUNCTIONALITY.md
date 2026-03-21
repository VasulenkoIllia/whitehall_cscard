# Поточний функціонал (CS-Cart scope)

## Поточний фокус
- Активний сценарій міграції: тільки `CS-Cart`.
- `Horoshop` тимчасово винесено за межі поточного етапу.
- Frontend перенесення на React розпочато (див. `docs/PLAN_FRONTEND_REACT_MIGRATION_2026_03.md`).
- У React-адмінці вже реалізовано ключові операторські екрани:
  - `Огляд` (jobs/readiness/actions),
  - `Постачальники` (search/sort + CRUD + bulk update),
  - `Джерела та мапінг` (source CRUD + source sheets/preview + mapping builder + JSON),
  - `Націнки та override` (markup rule sets: list/create/update/default/apply + conditions editor, price overrides: list/upsert/update),
  - `Дані` (merged/final/compare preview + export + server filters/sort/paging controls),
  - `Джоби та логи` (list + cancel + details panel `/admin/api/jobs/:jobId`).

## Імпорт даних
- Імпорт Google Sheets у `products_raw` з перевіркою mapping і skip-логікою.
- Підтримані керовані сценарії:
  - `import_all`
  - `import_source`
  - `import_supplier`
- Всі сценарії виконуються через jobs-layer з lock-контролем.

## Catalog admin API (backend)
- Доступні CRUD-операції для:
  - `suppliers` (включно з bulk update, search і sort)
  - `sources`
  - `mappings` (latest get/save per supplier/source, поле `comment`)
- Доступні API для pricing-керування:
  - `markup rule sets` (list/create/update/default/apply to suppliers)
  - `price overrides` (list/upsert/update)
- Доступні операційні read API:
  - `logs` (global/by job/by level)
  - `stats` (counts + last pipeline/import jobs)
  - `backend-readiness` (gates for cutover: mirror freshness, coverage, scheduler/cleanup, blocking jobs)
- Доступні Google Sheets helper API для джерел:
  - `source-sheets` (лист аркушів + selected)
  - `source-preview` (headers + sampleRows для mapping UI)
- Доступні review/export API для операторського контролю:
  - `merged-preview`, `final-preview`, `compare-preview`
  - `merged-export`, `final-export`, `compare-export` (CSV)
- `GET /admin/api/preview` і `POST /admin/api/store-import` повертають:
  - `previewTotal` (до optimizer),
  - `batchTotal` (після feature-scope + missing-hide + delta),
  - `batchMeta` (деталі оптимізації).
- `GET /admin/api/suppliers` підтримує:
  - `search=<рядок>` (пошук по `supplier.name`, case-insensitive)
  - `sort=name_asc|name_desc|id_asc` (A-Я / Я-А / дефолт по id)
- `POST /admin/api/mappings/:supplierId` підтримує поле:
  - `comment` — операторський коментар до mapping-конфігурації
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
- Є scripted readiness-зріз перед cutover:
  - `npm run backend:readiness`
  - `GET /admin/api/backend-readiness`
- Є scripted SKU-audit перед cutover:
  - `npm run store:sku-audit`
- Є scripted перенос supplier config з legacy:
  - `npm run export:legacy-config`
  - `npm run import:legacy-config`
  - runbook: `docs/RUNBOOK_SUPPLIER_CONFIG_MIGRATION_2026_03.md`

## Ще не закрито до повного parity
- Інтеграційні тести на критичні інваріанти бізнес-логіки.
- E2E cutover-прогін на staging/production-like даних по цільових постачальниках (`import_supplier -> finalize -> store_import`) з фіксацією метрик.
- Дотиснути UX parity React адмінки до 100% legacy-флоу (детальний CRUD/редагування markup rule sets із conditions прямо у UI).
