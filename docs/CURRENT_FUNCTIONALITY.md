# Поточний функціонал (CS-Cart scope)

## Поточний фокус
- Активний сценарій міграції: тільки `CS-Cart`.
- `Horoshop` тимчасово винесено за межі поточного етапу.

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
  - `markup rule sets` (list/create/update/apply to suppliers)
  - `price overrides` (list/upsert/update)
- Доступні операційні read API:
  - `logs` (global/by job/by level)
  - `stats` (counts + last pipeline/import jobs)
- Доступні Google Sheets helper API для джерел:
  - `source-sheets` (лист аркушів + selected)
  - `source-preview` (headers + sampleRows для mapping UI)
- Доступні review/export API для операторського контролю:
  - `merged-preview`, `final-preview`, `compare-preview`
  - `merged-export`, `final-export`, `compare-export` (CSV)
- `GET /admin/api/suppliers` підтримує:
  - `search=<рядок>` (пошук по `supplier.name`, case-insensitive)
  - `sort=name_asc|name_desc|id_asc` (A-Я / Я-А / дефолт по id)
- `POST /admin/api/mappings/:supplierId` підтримує поле:
  - `comment` — операторський коментар до mapping-конфігурації
- Ендпоїнти винесені в `admin/api/*` і захищені ролями `viewer/admin`.

## Finalize і preview
- Finalize формує `products_final` через staged merge path.
- Застосовується поточна бізнес-логіка пріоритетів/цін/дедупу без зміни правил.
- Preview для магазину формується з `products_final` з optional supplier-фільтром.

## CS-Cart import
- Імпорт у CS-Cart працює через конектор і gateway.
- Перед імпортом збирається mirror-index каталогу (`product_code -> product_id/state/price/parent`).
- Незаплановані/незмінені SKU пропускаються (оптимізація без зміни бізнес-логіки).
- Доступні progress-checkpoints у `jobs.meta.storeImportProgress`.
- Доступний resume після failed/canceled `store_import`.

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
- Є scripted backend load-audit контур:
  - `npm run audit:load`
  - runbook: `docs/RUNBOOK_LOAD_AUDIT_2026_03.md`
- Є scripted перенос supplier config з legacy:
  - `npm run export:legacy-config`
  - `npm run import:legacy-config`
  - runbook: `docs/RUNBOOK_SUPPLIER_CONFIG_MIGRATION_2026_03.md`

## Ще не закрито до повного parity
- Інтеграційні тести на критичні інваріанти бізнес-логіки.
- Staging load-test baseline 100k/300k/500k.
- Legacy-семантика global default markup rule (`markup_settings` / `markup-rule-sets/default`) для 1:1 parity.
