-- Migration 036: feeds + feed_imports — Phase 2 master_catalog.
--
-- Concept:
--   * feeds — registry URL-ів які тягнемо вручну.
--   * feed_imports — історія імпортів (як sync_runs).
--   * При імпорті для кожного item фіда шукаємо master_catalog.sku === item[sku_field]
--     і пишемо raw_item у master_catalog.feed_params -> feed.name (jsonb).
--
-- Формати які підтримуються одразу (інші можна додати без міграції):
--   * 'yml'  — Yandex Market XML (через fast-xml-parser)
--   * 'xml'  — generic XML (custom формати CS-Cart-подібні)
--   * 'xlsx' — Excel (через sheetjs)
--
-- sku_field конфігурується per feed:
--   * для YML: 'vendorCode' / 'article' / 'id' (attribute) / будь-який tag/attr усередині offer
--   * для XLSX: A/B/C/... (буква колонки) АБО ім'я колонки з header row (наприклад "Артикул")
--   * для XML: XPath-like notation: 'item.sku', 'product.code' тощо.

CREATE TABLE IF NOT EXISTS feeds (
  id                     BIGSERIAL PRIMARY KEY,
  name                   TEXT NOT NULL UNIQUE,            -- 'shopua', 'europasport', 'markshop'
  url                    TEXT NOT NULL,
  format                 TEXT NOT NULL,                   -- 'yml' / 'xml' / 'xlsx'
  sku_field              TEXT NOT NULL,                   -- 'vendorCode' / 'A' / 'article' / ...
  options                JSONB NOT NULL DEFAULT '{}'::jsonb,
                         -- довільні налаштування парсера, наприклад:
                         --   YML/XML: { offers_path: 'yml_catalog.shop.offers.offer' }
                         --   XLSX:    { header_row: 1, sheet_name: 'Sheet1' }
  is_active              BOOLEAN NOT NULL DEFAULT TRUE,
  last_imported_at       TIMESTAMPTZ,
  last_items_count       INT,
  last_matched_count     INT,
  last_status            TEXT,                            -- 'success' / 'failed'
  last_error             TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS feeds_active_idx ON feeds (is_active) WHERE is_active;

CREATE TABLE IF NOT EXISTS feed_imports (
  id                BIGSERIAL PRIMARY KEY,
  feed_id           BIGINT NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
  job_id            BIGINT REFERENCES jobs(id) ON DELETE SET NULL,
  status            TEXT NOT NULL DEFAULT 'running',     -- 'running' / 'finished' / 'failed'
  items_count       INT,                                 -- скільки items у фіді
  matched_count     INT,                                 -- скільки match-нулись у master_catalog
  unmatched_count   INT,                                 -- items без матча (raw items не зберігаємо для Phase 2 MVP)
  download_ms       INT,
  parse_ms          INT,
  match_ms          INT,
  duration_ms       BIGINT,
  error             TEXT,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS feed_imports_feed_idx
  ON feed_imports (feed_id, id DESC);
