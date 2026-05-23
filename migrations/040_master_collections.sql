-- Migration 040: master_collections — Level-1 (модельний) шар над master_products.
--
-- Один master_collections рядок = всі master_products з однаковим collection_code
-- (CS-Cart feature 558 "Колекція + Модель"). Це об'єднує різні кольори / варіаційні
-- групи одного модельного товару у єдиний майстер-вище.
--
-- Приклад FZ5765 (Nike Cargo Pants):
--   FZ5765-010-28×30 (черн.) [варіаційна група, ~45 SKU]  ┐
--   FZ5765-247-36-32 (пісоч.) [варіаційна група, 3 SKU]  ├─→ master_collections.collection_code='FZ5765-010'
--   FZ5765-297-30/30          [варіаційна група, 2 SKU]  │       (1 model-level master замість 4)
--   FZ5765-386-32-34          [варіаційна група, 8 SKU]  ┘
--
-- Використання:
--   * Level-1 (master_collections) — для SEO-копірайтингу (1 модель = 1 опис).
--   * Level-2 (master_products) — поточне; для кольоро/варіаційно-специфічних даних
--     (наприклад різні фото на колір) і коли AI повинен бачити окремий колір.

CREATE TABLE IF NOT EXISTS master_collections (
  id                     BIGSERIAL PRIMARY KEY,
  store                  TEXT NOT NULL DEFAULT 'cscart',
  collection_code        TEXT NOT NULL,
  display_name           TEXT,                                 -- з першого sub-master.store_name
  variation_group_count  INT NOT NULL DEFAULT 0,               -- скільки master_products всередині
  variation_count        INT NOT NULL DEFAULT 0,               -- сума SKU у всіх sub-master_products
  offer_count            INT NOT NULL DEFAULT 0,
  supplier_count         INT NOT NULL DEFAULT 0,
  best_supplier_price    NUMERIC(12, 2),
  worst_supplier_price   NUMERIC(12, 2),
  total_supplier_qty     INT,
  merged_attributes      JSONB NOT NULL DEFAULT '{}'::jsonb,   -- union ключів з усіх sub-master_products.merged_attributes
  last_assembled_at      TIMESTAMPTZ,
  last_assembled_job_id  BIGINT REFERENCES jobs(id) ON DELETE SET NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT master_collections_store_code_uq UNIQUE (store, collection_code)
);

CREATE INDEX IF NOT EXISTS master_collections_code_idx
  ON master_collections (collection_code);

CREATE INDEX IF NOT EXISTS master_collections_offers_price_idx
  ON master_collections (offer_count, best_supplier_price);

CREATE INDEX IF NOT EXISTS master_collections_merged_attrs_gin_idx
  ON master_collections USING GIN (merged_attributes jsonb_path_ops);

-- Linking master_products → master_collections (один-до-багатьох).
ALTER TABLE master_products
  ADD COLUMN IF NOT EXISTS collection_id BIGINT REFERENCES master_collections(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS master_products_collection_id_idx
  ON master_products (collection_id) WHERE collection_id IS NOT NULL;
