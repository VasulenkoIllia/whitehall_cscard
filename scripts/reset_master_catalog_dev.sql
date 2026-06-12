-- reset_master_catalog_dev.sql — повна очистка даних AI-модуля (master catalog).
--
-- Стирає ВСЕ, що наповнив модуль master_catalog/AI:
--   * master_catalog            — всі SKU (підготовлені і опрацьовані AI)
--   * master_catalog_sync_runs  — історія sync-ів з finalize
--   * feed_imports              — історія імпортів фідів
--   * anthropic_batches         — async батчі
--   * ai_usage_log              — статистика витрат
--
-- НЕ чіпає: feeds (конфіг фідів), app_settings (промпт/ключ), решту схеми.
--
-- Запуск на TEST сервері (whitehallshoptest):
--   cd /var/www/projects/whitehall_cscard_test
--   docker exec -i whitehall-cscard-test-db psql -U whitehall_store -d whitehall_store < scripts/reset_master_catalog_dev.sql
--
-- Локально (порт за .env DATABASE_URL):
--   psql postgres://whitehall_store:whitehall_store@127.0.0.1:5434/whitehall_store < scripts/reset_master_catalog_dev.sql
--
-- УВАГА: на PROD не запускати — скрипт призначений для dev/test демо-циклів.

BEGIN;

TRUNCATE TABLE
  feed_imports,
  anthropic_batches,
  ai_usage_log,
  master_catalog_sync_runs
RESTART IDENTITY;

TRUNCATE TABLE master_catalog RESTART IDENTITY;

COMMIT;

-- Контроль: усі лічильники мають бути 0.
SELECT
  (SELECT COUNT(*) FROM master_catalog)           AS master_catalog,
  (SELECT COUNT(*) FROM master_catalog_sync_runs) AS sync_runs,
  (SELECT COUNT(*) FROM feed_imports)             AS feed_imports,
  (SELECT COUNT(*) FROM anthropic_batches)        AS anthropic_batches,
  (SELECT COUNT(*) FROM ai_usage_log)             AS ai_usage_log,
  (SELECT COUNT(*) FROM feeds)                    AS feeds_kept,
  (SELECT COUNT(*) FROM app_settings)             AS app_settings_kept;
