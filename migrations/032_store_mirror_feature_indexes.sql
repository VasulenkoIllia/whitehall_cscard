-- 032_store_mirror_feature_indexes.sql
--
-- Speed up filterCsCartRowsByFeature() — without indexes it does a full
-- Sequential Scan over store_mirror (~200K+ rows × ~5KB JSONB each = up to 1GB
-- of I/O per call). Two complementary partial indexes:
--
-- 1) Conditional partial on (article) for the common feature_564='Y' case.
--    Lets PostgreSQL go straight from "active managed SKUs" to article values
--    without touching raw JSONB. Used by the planner when bound parameters
--    match the literals (which happens under custom plans on bind, the typical
--    case for our query that runs once per update_pipeline).
--
-- 2) Generic GIN on (raw -> 'product_features') so containment / key-existence
--    queries on the feature map become fast. Cheap insurance for future
--    diagnostic queries; size is bounded by the partial WHERE.
--
-- Both indexes are partial on store='cscart' so they don't grow if/when other
-- stores get added to the same table.
--
-- IF NOT EXISTS makes the migration idempotent. CREATE INDEX (without
-- CONCURRENTLY) is required because runMigrations wraps each file in a
-- transaction. On a 200K row table this takes ~5-10s and briefly blocks
-- mirror_sync upserts; on a 500K row catalog ~30-60s. Acceptable for a
-- one-shot rollout during a quiet window.

CREATE INDEX IF NOT EXISTS store_mirror_feature_564_y_idx
  ON store_mirror (article)
  WHERE store = 'cscart'
    AND LOWER((raw -> 'product_features' -> '564') ->> 'value') = 'y';

CREATE INDEX IF NOT EXISTS store_mirror_features_gin_idx
  ON store_mirror USING GIN ((raw -> 'product_features'))
  WHERE store = 'cscart';
