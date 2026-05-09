-- 034_add_variation_group_code_to_store_mirror.sql
--
-- Denormalize CS-Cart top-level field `variation_group_code` (CS-Cart admin
-- field "Група варіацій") into a TEXT column on store_mirror. Used in
-- Compare-tab to display which CS-Cart variation group this SKU belongs to.
--
-- Coverage on prod (2026-05-09): 216 559 of 239 028 rows (90.6%); 76 407
-- distinct group codes. The 22 469 rows without value are single-SKU items
-- that are not part of CS-Cart variation grouping (the field is null in API).
--
-- This is unrelated to feature_id=558 (collection_code, migration 033) —
-- they answer different questions:
--   - collection_code: business code of the model/collection (admin-set).
--   - variation_group_code: CS-Cart-native code that ties variations
--     (different sizes/colors of the same product) into one group.
--
-- Performance notes:
-- 1. ADD COLUMN with no DEFAULT is metadata-only on Postgres 11+. Fast.
-- 2. UPDATE on ~239K rows takes 30-60s and creates dead tuples (MVCC).
--    VACUUM is NOT included — Postgres forbids it inside a transaction
--    (runMigrations.ts wraps each file in BEGIN/COMMIT). Run manually
--    after deploy:  VACUUM (ANALYZE) store_mirror;
-- 3. Recommended to pause mirror_sync during deploy to avoid lock
--    contention with the backfill UPDATE.
-- 4. CREATE INDEX last — built once over already-populated data.
--
-- Idempotency: IF NOT EXISTS on column and index; UPDATE filtered by
-- `variation_group_code IS NULL` so re-running is a no-op.

ALTER TABLE store_mirror
  ADD COLUMN IF NOT EXISTS variation_group_code TEXT;

UPDATE store_mirror
   SET variation_group_code = NULLIF(raw->>'variation_group_code', '')
 WHERE store = 'cscart'
   AND variation_group_code IS NULL
   AND raw->>'variation_group_code' IS NOT NULL;

CREATE INDEX IF NOT EXISTS store_mirror_store_variation_group_idx
  ON store_mirror (store, variation_group_code)
  WHERE variation_group_code IS NOT NULL;
