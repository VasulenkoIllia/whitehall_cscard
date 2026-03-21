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
  - `suppliers` (включно з bulk update)
  - `sources`
  - `mappings` (latest get/save per supplier/source)
- Доступні API для pricing-керування:
  - `markup rule sets` (list/create/update/apply to suppliers)
  - `price overrides` (list/upsert/update)
- Доступні операційні read API:
  - `logs` (global/by job/by level)
  - `stats` (counts + last pipeline/import jobs)
- Доступні Google Sheets helper API для джерел:
  - `source-sheets` (лист аркушів + selected)
  - `source-preview` (headers + sampleRows для mapping UI)
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

## Стабільність і контроль об’єму
- Runtime-активація daily partition для `products_raw`.
- Cleanup job чистить старі partition/рядки/логи/завершені jobs.
- Логи мають payload truncation (`LOG_PAYLOAD_MAX_BYTES`) для контролю росту таблиці `logs`.

## Ще не закрито до повного parity
- Admin CRUD parity (`suppliers`, `sources`, `mappings`, `markup rules`, `price overrides`).
- Read parity для legacy аналітичних endpoint-ів (`stats`, `final/compare export`).
- Інтеграційні тести на критичні інваріанти бізнес-логіки.
- Staging load-test baseline 100k/300k/500k.
