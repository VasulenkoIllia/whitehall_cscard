-- Migration 037: master_offers — постачальницькі пропозиції, привʼязані до master_products.
--
-- Один рядок на кожну products_final пропозицію, яку вдалося звʼязати з master через одну з варіацій
-- (exact_sku via compute_sku_article, collection_code, або variation_group_code). Зберігає повний
-- row_data з products_raw — це і є "усі дані від усіх постачальників", які зведе master.
--
-- Поле row_data — це JSONB точно як зберігається у products_raw (всі колонки з Google Sheet,
-- ключами є original headers, без втрат). UI зможе показати їх у drill-in panel як key/value
-- таблицю; AI у наступній фазі читатиме row_data для нормалізації/збагачення master.

CREATE TABLE IF NOT EXISTS master_offers (
  id                    BIGSERIAL PRIMARY KEY,
  master_id             BIGINT NOT NULL REFERENCES master_products(id) ON DELETE CASCADE,
  variation_id          BIGINT REFERENCES master_variations(id) ON DELETE SET NULL,
  supplier_id           BIGINT NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  source_id             BIGINT REFERENCES sources(id) ON DELETE SET NULL,
  article               TEXT NOT NULL,
  size                  TEXT,
  quantity              INT,
  price_base            NUMERIC(12, 2),
  price_final           NUMERIC(12, 2),
  extra                 TEXT,
  comment_text          TEXT,
  row_data              JSONB NOT NULL DEFAULT '{}'::jsonb,
  final_id              BIGINT REFERENCES products_final(id) ON DELETE SET NULL,
  raw_id                BIGINT,                              -- products_raw.id (інформаційно; партиціоновано)
  match_signal          TEXT NOT NULL,                       -- exact_sku|collection_code|variation_group_code
  matched_store_article TEXT NOT NULL,
  assembled_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- UNIQUE INDEX через COALESCE — PG не дозволяє вираз у table-level UNIQUE constraint.
-- NULL size трактуємо як '' для дедуплікації, бо для постачальника "без розміру" і
-- "розмір не вказаний" — це одне і те саме.
CREATE UNIQUE INDEX IF NOT EXISTS master_offers_master_supplier_article_size_uq
  ON master_offers (master_id, supplier_id, article, COALESCE(size, ''));

CREATE INDEX IF NOT EXISTS master_offers_master_id_idx
  ON master_offers (master_id);

CREATE INDEX IF NOT EXISTS master_offers_supplier_article_idx
  ON master_offers (supplier_id, article);

CREATE INDEX IF NOT EXISTS master_offers_variation_id_idx
  ON master_offers (variation_id);

CREATE INDEX IF NOT EXISTS master_offers_row_data_gin_idx
  ON master_offers USING GIN (row_data jsonb_path_ops);
