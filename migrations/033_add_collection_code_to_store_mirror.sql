-- 033_add_collection_code_to_store_mirror.sql
--
-- Denormalize CS-Cart "Колекція + Модель" feature (feature_id=558 in production)
-- into a TEXT column on store_mirror. Lets Compare-tab and any future
-- collection-based queries skip JSONB lookups in the hot path.
--
-- The runtime code reads CSCART_COLLECTION_FEATURE_ID from ENV (default 558).
-- This migration hardcodes 558 only for the one-time backfill — once data is
-- in the column, the upsert path keeps it fresh on every mirror sync.
--
-- Performance notes:
-- 1. ADD COLUMN with no DEFAULT is metadata-only on Postgres 11+. Fast.
-- 2. UPDATE on ~239K rows takes 30-60s and creates dead tuples (MVCC).
--    VACUUM is NOT included — Postgres forbids it inside a transaction
--    (runMigrations.ts wraps each file in BEGIN/COMMIT). If bloat is
--    observed, run manually after deploy:
--      VACUUM (ANALYZE) store_mirror;
-- 3. The UPDATE briefly blocks concurrent store_mirror upserts. Recommend
--    pausing mirror_sync during deploy.
-- 4. CREATE INDEX last — built once over already-populated data.
--
-- Idempotency: IF NOT EXISTS on column and index; UPDATE filtered by
-- `collection_code IS NULL` so re-running is a no-op.

ALTER TABLE store_mirror
  ADD COLUMN IF NOT EXISTS collection_code TEXT;

UPDATE store_mirror
   SET collection_code = NULLIF(raw->'product_features'->'558'->>'value', '')
 WHERE store = 'cscart'
   AND collection_code IS NULL
   AND raw->'product_features'->'558' IS NOT NULL;

CREATE INDEX IF NOT EXISTS store_mirror_store_collection_idx
  ON store_mirror (store, collection_code)
  WHERE collection_code IS NOT NULL;
