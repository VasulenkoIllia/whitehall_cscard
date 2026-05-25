-- =============================================================================
-- Rollback скрипт — дропає всі обʼєкти створені міграціями 035-052
-- та видаляє відповідні рядки з migration_history.
--
-- Використання:
--   docker exec -i whitehall-cscard-test-db psql -U whitehall_store -d whitehall_store < scripts/rollback_ai_catalog.sql
--
-- Після цього стан БД = такий, як перед AI Wizard / offline catalog feature
-- (тобто на comm�t d774250).
--
-- БЕЗПЕЧНО до виконання — обгортка у транзакцію, IF EXISTS скрізь.
-- =============================================================================

BEGIN;

-- ── AI Wizard (міграція 052) ─────────────────────────────────────────────────
DROP TABLE IF EXISTS column_mapping_suggestions CASCADE;
DROP TABLE IF EXISTS sheet_tab_analyses CASCADE;

-- ── Master fields AI enrichment (міграція 051) ────────────────────────────────
ALTER TABLE IF EXISTS master_fields
  DROP COLUMN IF EXISTS description_ai,
  DROP COLUMN IF EXISTS example_values,
  DROP COLUMN IF EXISTS applies_to,
  DROP COLUMN IF EXISTS cardinality,
  DROP COLUMN IF EXISTS anti_examples,
  DROP COLUMN IF EXISTS format_hint;

-- ── column_mappings UNIQUE constraint (міграція 050) ─────────────────────────
DROP INDEX IF EXISTS column_mappings_supplier_source_uq;
DROP INDEX IF EXISTS column_mappings_supplier_null_source_uq;

-- ── compute_sku_article (міграція 049 — DROP function) ───────────────────────
-- Функція не існує (її видалили у 049), пропускаємо.

-- ── category_mappings (міграція 048) ─────────────────────────────────────────
DROP TABLE IF EXISTS category_mappings CASCADE;

-- ── parent_code field (міграція 047 — DROP master_fields seed) ───────────────
-- Видалила лише seed-row, схема не змінилась. Пропускаємо.

-- ── color_mappings (міграція 046) ────────────────────────────────────────────
DROP TABLE IF EXISTS color_mappings CASCADE;

-- ── master_fields rebalance (міграція 045) — seed-only, нічого дропати ───────
-- ── drop_legacy_master_tables (міграція 044) — drop-міграція, нічого створювала
-- ── catalog_schema (міграція 043) ────────────────────────────────────────────
DROP TABLE IF EXISTS catalog_master_field_values CASCADE;
DROP TABLE IF EXISTS catalog_offers CASCADE;
DROP TABLE IF EXISTS catalog_variants CASCADE;
DROP TABLE IF EXISTS catalog_masters CASCADE;
DROP TABLE IF EXISTS catalog_assembly_runs CASCADE;
DROP FUNCTION IF EXISTS normalize_article(TEXT);
DROP FUNCTION IF EXISTS extract_field_values(JSONB, TEXT[]);
DROP FUNCTION IF EXISTS build_row_object_from_array(JSONB, TEXT[]);

-- ── master_fields (міграція 042) ─────────────────────────────────────────────
DROP TABLE IF EXISTS master_collection_field_values CASCADE;
DROP TABLE IF EXISTS master_fields CASCADE;

-- ── master_assembly_runs add collections (міграція 041) ──────────────────────
ALTER TABLE IF EXISTS master_assembly_runs
  DROP COLUMN IF EXISTS collections_upserted;

-- ── master_collections (міграція 040) ────────────────────────────────────────
DROP TABLE IF EXISTS master_collections CASCADE;

-- ── row_data array to object (міграція 039) ──────────────────────────────────
-- Це міграція даних, не структури. Не треба відкочувати.

-- ── master_assembly_runs (міграція 038) ──────────────────────────────────────
DROP TABLE IF EXISTS master_assembly_runs CASCADE;

-- ── master_offers (міграція 037) ─────────────────────────────────────────────
DROP TABLE IF EXISTS master_offers CASCADE;

-- ── master_variations (міграція 036) ─────────────────────────────────────────
DROP TABLE IF EXISTS master_variations CASCADE;

-- ── master_products (міграція 035) ───────────────────────────────────────────
DROP TABLE IF EXISTS master_products CASCADE;
DROP FUNCTION IF EXISTS compute_sku_article(TEXT, TEXT);

-- ── Видалити рядки з migration_history щоб міграції можна було ────────────────
-- застосувати знову при потребі (або щоб не плутали наступних розробників).
DELETE FROM migration_history
 WHERE name IN (
   '035_master_products',
   '036_master_variations',
   '037_master_offers',
   '038_master_assembly_runs',
   '039_row_data_array_to_object',
   '040_master_collections',
   '041_master_assembly_runs_add_collections',
   '042_master_fields',
   '043_catalog_schema',
   '044_drop_legacy_master_tables',
   '045_master_fields_rebalance',
   '046_color_mappings',
   '047_drop_parent_code_field',
   '048_category_mappings',
   '049_drop_compute_sku_article',
   '050_column_mappings_unique',
   '051_master_fields_ai_enrichment',
   '052_ai_mapping_suggestions'
 );

-- ── Sanity check ─────────────────────────────────────────────────────────────
SELECT 'Залишились таблиці що не повинні існувати:' AS warning, tablename
  FROM pg_tables
 WHERE tablename IN (
   'master_products', 'master_variations', 'master_offers', 'master_assembly_runs',
   'master_collections', 'master_fields', 'master_collection_field_values',
   'catalog_masters', 'catalog_variants', 'catalog_offers',
   'catalog_master_field_values', 'catalog_assembly_runs',
   'color_mappings', 'category_mappings',
   'sheet_tab_analyses', 'column_mapping_suggestions'
 );

SELECT 'Залишились записи у migration_history що не повинні бути:' AS warning, name
  FROM migration_history
 WHERE name LIKE '035_%' OR name LIKE '036_%' OR name LIKE '037_%' OR name LIKE '038_%'
    OR name LIKE '039_%' OR name LIKE '040_%' OR name LIKE '041_%' OR name LIKE '042_%'
    OR name LIKE '043_%' OR name LIKE '044_%' OR name LIKE '045_%' OR name LIKE '046_%'
    OR name LIKE '047_%' OR name LIKE '048_%' OR name LIKE '049_%' OR name LIKE '050_%'
    OR name LIKE '051_%' OR name LIKE '052_%';

COMMIT;

-- Останній стейт (для verify):
SELECT 'OK: rollback виконано. Поточні master/catalog таблиці лишились тільки legacy:' AS status;
SELECT tablename FROM pg_tables
 WHERE schemaname = 'public' AND (tablename LIKE 'master_%' OR tablename LIKE 'catalog_%')
 ORDER BY tablename;
