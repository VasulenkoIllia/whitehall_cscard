-- Migration 043: catalog_* — офлайн каталог товарів, незалежний від CS-Cart store_mirror.
--
-- Архітектурний поворот: майстер-каталог тепер будується ТІЛЬКИ з даних постачальників
-- (products_final + products_raw + column_mappings). CS-Cart store_mirror більше не бере
-- участі у формуванні master-каталогу — це задача import_pipeline (магазин). Тут — окрема,
-- "товарна" база.
--
-- Ключ master = normalize_article(article) (lowercase + trim). Один артикул, який зустрічається
-- у різних постачальників (наприклад Nike MPN "FZ5765-010") — це ОДИН master. Розміри — variants.
--
-- Старі master_* таблиці (collections / products / variations / offers) лишаються у БД
-- як deprecated, нічого не пишуть. Дропати їх — окремою міграцією після підтвердження.

CREATE OR REPLACE FUNCTION normalize_article(p_article TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  -- Канонічна форма артикулу: lowercase + trim. Може посилитись пізніше
  -- (видалення пробілів усередині, normalize_dash тощо) — змінювати ТУТ.
  SELECT lower(btrim(p_article));
$$;

-- ─── catalog_masters: 1 рядок = 1 унікальний article ───────────────────────────
CREATE TABLE IF NOT EXISTS catalog_masters (
  id                     BIGSERIAL PRIMARY KEY,
  article_key            TEXT NOT NULL,                       -- normalize_article(article)
  display_article        TEXT NOT NULL,                       -- original case for UI
  variant_count          INT NOT NULL DEFAULT 0,
  offer_count            INT NOT NULL DEFAULT 0,
  supplier_count         INT NOT NULL DEFAULT 0,
  best_price             NUMERIC(12, 2),
  worst_price            NUMERIC(12, 2),
  total_qty              INT,
  -- merged_attributes — union усіх postачальницьких row_data ключів (header → value).
  merged_attributes      JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- merged_field_values — денорм master_field_key → value (з offers.field_values за priority).
  -- Використовується UI картки для preview "що б ми побачили" до ручного редагування.
  merged_field_values    JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_assembled_at      TIMESTAMPTZ,
  last_assembled_job_id  BIGINT REFERENCES jobs(id) ON DELETE SET NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT catalog_masters_article_uq UNIQUE (article_key)
);

CREATE INDEX IF NOT EXISTS catalog_masters_display_article_idx
  ON catalog_masters (display_article);

CREATE INDEX IF NOT EXISTS catalog_masters_offer_price_idx
  ON catalog_masters (offer_count, best_price);

CREATE INDEX IF NOT EXISTS catalog_masters_merged_attrs_gin_idx
  ON catalog_masters USING GIN (merged_attributes jsonb_path_ops);

CREATE INDEX IF NOT EXISTS catalog_masters_merged_field_values_gin_idx
  ON catalog_masters USING GIN (merged_field_values jsonb_path_ops);

-- ─── catalog_variants: розміри одного master ──────────────────────────────────
CREATE TABLE IF NOT EXISTS catalog_variants (
  id              BIGSERIAL PRIMARY KEY,
  master_id       BIGINT NOT NULL REFERENCES catalog_masters(id) ON DELETE CASCADE,
  size_raw        TEXT,                                       -- як прислав постачальник (для діагностики)
  size            TEXT,                                       -- нормалізований через size_mappings
  offer_count     INT NOT NULL DEFAULT 0,
  supplier_count  INT NOT NULL DEFAULT 0,
  best_price      NUMERIC(12, 2),
  worst_price     NUMERIC(12, 2),
  total_qty       INT NOT NULL DEFAULT 0,
  attached_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- UNIQUE по (master, size) з NULL→'' через COALESCE.
CREATE UNIQUE INDEX IF NOT EXISTS catalog_variants_master_size_uq
  ON catalog_variants (master_id, COALESCE(size, ''));

CREATE INDEX IF NOT EXISTS catalog_variants_master_idx
  ON catalog_variants (master_id);

-- ─── catalog_offers: пропозиції постачальників ─────────────────────────────────
CREATE TABLE IF NOT EXISTS catalog_offers (
  id              BIGSERIAL PRIMARY KEY,
  master_id       BIGINT NOT NULL REFERENCES catalog_masters(id) ON DELETE CASCADE,
  variant_id      BIGINT REFERENCES catalog_variants(id) ON DELETE SET NULL,
  supplier_id     BIGINT NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  source_id       BIGINT REFERENCES sources(id) ON DELETE SET NULL,
  article         TEXT NOT NULL,
  size            TEXT,
  quantity        INT,
  price_base      NUMERIC(12, 2),
  price_final     NUMERIC(12, 2),
  extra           TEXT,
  comment_text    TEXT,
  -- row_data — header-keyed object (UA-заголовки з mapping_meta.headers + col_N для немапленних).
  row_data        JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- field_values — master_field_key → value, витягнуті через column_mappings.
  field_values    JSONB NOT NULL DEFAULT '{}'::jsonb,
  final_id        BIGINT REFERENCES products_final(id) ON DELETE SET NULL,
  raw_id          BIGINT,                                     -- products_raw.id (інформаційно; партиц.)
  assembled_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS catalog_offers_master_supplier_uq
  ON catalog_offers (master_id, supplier_id, article, COALESCE(size, ''));

CREATE INDEX IF NOT EXISTS catalog_offers_master_idx
  ON catalog_offers (master_id);

CREATE INDEX IF NOT EXISTS catalog_offers_supplier_article_idx
  ON catalog_offers (supplier_id, article);

CREATE INDEX IF NOT EXISTS catalog_offers_row_data_gin_idx
  ON catalog_offers USING GIN (row_data jsonb_path_ops);

CREATE INDEX IF NOT EXISTS catalog_offers_field_values_gin_idx
  ON catalog_offers USING GIN (field_values jsonb_path_ops);

-- ─── catalog_master_field_values: збережені (ручні/AI) значення картки ───────
CREATE TABLE IF NOT EXISTS catalog_master_field_values (
  id                    BIGSERIAL PRIMARY KEY,
  master_id             BIGINT NOT NULL REFERENCES catalog_masters(id) ON DELETE CASCADE,
  field_id              BIGINT NOT NULL REFERENCES master_fields(id) ON DELETE CASCADE,
  value                 TEXT,
  source                TEXT NOT NULL DEFAULT 'manual',
  source_supplier_id    BIGINT REFERENCES suppliers(id) ON DELETE SET NULL,
  source_attribute_key  TEXT,
  updated_by            UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT catalog_master_field_values_uq UNIQUE (master_id, field_id)
);

CREATE INDEX IF NOT EXISTS catalog_master_field_values_field_idx
  ON catalog_master_field_values (field_id);

-- ─── extract_field_values: витягнути master_field-ключеві значення з row_data array ──
--
-- Дзеркало build_row_object_from_array, але повертає {master_field_key: value} замість
-- {header_name: value}. Використовується CatalogAssembler при INSERT INTO catalog_offers
-- для денормалізації field_values з positional products_raw.row_data array.
--
-- Аргументи:
--   arr        — products_raw.row_data (JSONB array)
--   mapping    — column_mappings.mapping (наприклад {"article": 4, "brand": 7, "color_uk": 5})
--   field_keys — TEXT[] список master_fields.key, що мають бути в результаті
CREATE OR REPLACE FUNCTION extract_field_values(
  arr jsonb,
  mapping jsonb,
  field_keys text[]
) RETURNS jsonb
LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE
    WHEN arr IS NULL OR jsonb_typeof(arr) <> 'array' OR jsonb_array_length(arr) = 0
      OR mapping IS NULL OR field_keys IS NULL
      THEN '{}'::jsonb
    ELSE COALESCE((
      SELECT jsonb_object_agg(k, arr->>((mapping->>k)::int - 1))
      FROM unnest(field_keys) AS k
      WHERE mapping->>k IS NOT NULL
        AND jsonb_typeof(mapping->k) = 'number'
        AND (mapping->>k)::int > 0
        AND (mapping->>k)::int <= jsonb_array_length(arr)
        AND COALESCE(btrim(arr->>((mapping->>k)::int - 1)), '') <> ''
    ), '{}'::jsonb)
  END;
$$;

-- ─── catalog_assembly_runs (опційно, але корисно для UI) ────────────────────
CREATE TABLE IF NOT EXISTS catalog_assembly_runs (
  id                     BIGSERIAL PRIMARY KEY,
  job_id                 BIGINT REFERENCES jobs(id) ON DELETE SET NULL,
  status                 TEXT NOT NULL DEFAULT 'running',     -- running|finished|failed
  source_articles        INT,
  masters_upserted       INT NOT NULL DEFAULT 0,
  variants_inserted      INT NOT NULL DEFAULT 0,
  offers_inserted        INT NOT NULL DEFAULT 0,
  duration_ms            BIGINT,
  error                  TEXT,
  started_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at            TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS catalog_assembly_runs_started_idx
  ON catalog_assembly_runs (started_at DESC);
