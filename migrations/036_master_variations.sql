-- Migration 036: master_variations — звʼязок один-до-багатьох master_products → CS-Cart SKU.
--
-- Один рядок на кожен CS-Cart SKU (root + дочки), що належать майстру. Використовується для:
--   * матчингу постачальницьких offers через store_article (compute_sku_article);
--   * відображення в UI: усі варіації товару з цінами/залишками магазину;
--   * визначення variation_id у master_offers — щоб бачити, через яку варіацію зматчили offer.

CREATE TABLE IF NOT EXISTS master_variations (
  id              BIGSERIAL PRIMARY KEY,
  master_id       BIGINT NOT NULL REFERENCES master_products(id) ON DELETE CASCADE,
  store_article   TEXT NOT NULL,
  is_root         BOOLEAN NOT NULL DEFAULT FALSE,
  store_price     NUMERIC(12, 2),
  store_amount    INT,
  store_status    TEXT,
  attached_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT master_variations_master_article_uq UNIQUE (master_id, store_article)
);

CREATE INDEX IF NOT EXISTS master_variations_store_article_idx
  ON master_variations (store_article);

CREATE INDEX IF NOT EXISTS master_variations_master_id_idx
  ON master_variations (master_id);
