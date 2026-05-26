-- Migration 035: master_catalog — офлайн каталог унікальних SKU з products_final.
--
-- АРХІТЕКТУРА (3 фази):
--   Phase 1 (зараз) — sync SKU з фіналу. Усі 23 атрибутних поля = NULL.
--   Phase 2 (пізніше) — імпорт фіда → заповнення feed_params JSONB по SKU.
--   Phase 3 (пізніше) — AI отримує SKU + feed_params → пише у 23 атрибутні поля.
--
-- Один товар = один SKU (parent, без розміру).
-- SKU береться з products_final.article (це вже "ефективний SKU" без розміру —
-- розмір зберігається у products_final.size як окремий variant).
--
-- 24 поля: 1 SKU (PK) + 23 атрибутні (name, brand, photo, description, тощо).

CREATE TABLE IF NOT EXISTS master_catalog (
  id                    BIGSERIAL PRIMARY KEY,
  sku                   TEXT NOT NULL UNIQUE,

  -- ── 23 атрибутні поля картки товару (заповнюються AI у Phase 3) ────────────
  name_uk               TEXT,
  brand                 TEXT,
  category_uk           TEXT,
  photo                 TEXT,
  description_full_uk   TEXT,
  old_price             NUMERIC(12, 2),
  product_kind          TEXT,
  product_type          TEXT,
  color_uk              TEXT,
  model_name            TEXT,
  gender                TEXT,
  style                 TEXT,
  material              TEXT,
  material_top          TEXT,
  material_inner        TEXT,
  material_sole         TEXT,
  toe_shape             TEXT,
  fastening             TEXT,
  purpose               TEXT,
  season                TEXT,
  season_year           TEXT,
  country               TEXT,
  gtin                  TEXT,

  -- ── Phase 2: дані з фіда (структура generic під будь-який формат) ──────────
  feed_params           JSONB,
  feed_matched_at       TIMESTAMPTZ,
  feed_source           TEXT,            -- 'cscart' / 'csv_upload' / 'horoshop' / ...

  -- ── Phase 3: AI metadata ───────────────────────────────────────────────────
  ai_enriched_at        TIMESTAMPTZ,
  ai_model              TEXT,
  ai_prompt_version     TEXT,

  -- ── Metadata ───────────────────────────────────────────────────────────────
  source_job_id         BIGINT REFERENCES jobs(id) ON DELETE SET NULL,
  is_active             BOOLEAN NOT NULL DEFAULT TRUE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Sync швидко знаходить existing SKUs для ON CONFLICT.
CREATE INDEX IF NOT EXISTS master_catalog_sku_idx ON master_catalog (sku);

-- Запити "які SKU ще не отримали AI" / "не отримали feed match".
CREATE INDEX IF NOT EXISTS master_catalog_ai_pending_idx
  ON master_catalog (id) WHERE ai_enriched_at IS NULL;
CREATE INDEX IF NOT EXISTS master_catalog_feed_pending_idx
  ON master_catalog (id) WHERE feed_matched_at IS NULL;

-- Run-history для sync jobs (інформаційно).
CREATE TABLE IF NOT EXISTS master_catalog_sync_runs (
  id                BIGSERIAL PRIMARY KEY,
  job_id            BIGINT REFERENCES jobs(id) ON DELETE SET NULL,
  source_job_id     BIGINT REFERENCES jobs(id) ON DELETE SET NULL,
  status            TEXT NOT NULL DEFAULT 'running',
  source_sku_count  INT,
  inserted          INT DEFAULT 0,
  skipped           INT DEFAULT 0,
  duration_ms       BIGINT,
  error             TEXT,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at       TIMESTAMPTZ
);
