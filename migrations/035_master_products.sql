-- Migration 035: master_products — батьківські (CS-Cart parent) товари + утиліта sku_article.
--
-- Master = один CS-Cart товар у store_mirror, у якого parent_article IS NULL (або порожнє/'0').
-- До нього в master_variations збираються сам корінь + усі дочки (parent_article = root.cs_product_id),
-- а в master_offers — усі products_final пропозиції постачальників, які матчаться через будь-яку
-- з варіацій. Збагачення (denorm `merged_attributes`) — це union усіх row_data з усіх offers за
-- пріоритетом постачальника (без AI, без нормалізації — це робота наступних фаз).
--
-- Залежить тільки від наявних таблиць (store_mirror, products_final, suppliers, jobs).
-- Не змінює жодних існуючих таблиць — additive, zero-downtime, повний rollback через DROP.

CREATE TABLE IF NOT EXISTS master_products (
  id                    BIGSERIAL PRIMARY KEY,
  store                 TEXT NOT NULL DEFAULT 'cscart',
  -- ідентифікація батька з CS-Cart:
  root_article          TEXT NOT NULL,
  cs_product_id         TEXT NOT NULL,
  -- денорм з кореневого store_mirror рядка (для швидкого відображення в списку):
  store_name            TEXT,
  store_price           NUMERIC(12, 2),
  store_amount          INT,
  store_visibility      TEXT,
  collection_code       TEXT,
  variation_group_code  TEXT,
  -- агрегати по всіх варіаціях і всіх offers:
  variation_count       INT NOT NULL DEFAULT 0,
  offer_count           INT NOT NULL DEFAULT 0,
  supplier_count        INT NOT NULL DEFAULT 0,
  best_supplier_price   NUMERIC(12, 2),
  worst_supplier_price  NUMERIC(12, 2),
  total_supplier_qty    INT,
  merged_attributes     JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- метадані:
  last_assembled_at     TIMESTAMPTZ,
  last_assembled_job_id BIGINT REFERENCES jobs(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT master_products_store_cs_product_uq UNIQUE (store, cs_product_id)
);

CREATE INDEX IF NOT EXISTS master_products_root_article_idx
  ON master_products (root_article);

CREATE INDEX IF NOT EXISTS master_products_collection_code_idx
  ON master_products (collection_code)
  WHERE collection_code IS NOT NULL;

CREATE INDEX IF NOT EXISTS master_products_variation_group_code_idx
  ON master_products (variation_group_code)
  WHERE variation_group_code IS NOT NULL;

CREATE INDEX IF NOT EXISTS master_products_offer_count_price_idx
  ON master_products (offer_count, best_supplier_price);

CREATE INDEX IF NOT EXISTS master_products_merged_attrs_gin_idx
  ON master_products USING GIN (merged_attributes jsonb_path_ops);

-- compute_sku_article — інкапсулює існуючу логіку обчислення sku_article з
-- CatalogAdminService.listComparePreview (рядки ~1715-1721). Використовується
-- у master_offers assembly для точного матчингу постачальницького (article, size)
-- зі store_mirror.article.
--
-- Правила:
--   * size порожній/NULL — повертаємо article без змін.
--   * article вже закінчується size-суфіксом (case-insensitive) — повертаємо як є.
--   * Інакше — article || '-' || normalized_size (',' → '.').
--
-- IMMUTABLE — дозволяє використовувати у JOIN-умовах і функціональних індексах.
CREATE OR REPLACE FUNCTION compute_sku_article(p_article TEXT, p_size TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_size IS NULL OR btrim(p_size) = '' THEN p_article
    WHEN right(lower(p_article), length(replace(btrim(p_size), ',', '.'))) =
         lower(replace(btrim(p_size), ',', '.'))
      THEN p_article
    ELSE p_article || '-' || replace(btrim(p_size), ',', '.')
  END;
$$;
