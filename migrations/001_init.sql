CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS jobs (
  id BIGSERIAL PRIMARY KEY,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  meta JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS job_locks (
  name TEXT PRIMARY KEY,
  job_id BIGINT REFERENCES jobs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS suppliers (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  markup_percent NUMERIC(6,2) DEFAULT 0,
  min_profit_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  min_profit_amount NUMERIC(10,2) DEFAULT 0,
  priority INT DEFAULT 100,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  markup_rule_set_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sources (
  id BIGSERIAL PRIMARY KEY,
  supplier_id BIGINT REFERENCES suppliers(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  source_url TEXT NOT NULL,
  sheet_name TEXT,
  name TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS column_mappings (
  id BIGSERIAL PRIMARY KEY,
  supplier_id BIGINT REFERENCES suppliers(id) ON DELETE CASCADE,
  source_id BIGINT REFERENCES sources(id) ON DELETE CASCADE,
  mapping JSONB NOT NULL,
  mapping_meta JSONB,
  header_row INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS markup_rule_sets (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS markup_rule_conditions (
  id BIGSERIAL PRIMARY KEY,
  rule_set_id BIGINT REFERENCES markup_rule_sets(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL,
  action_value NUMERIC(10,2) NOT NULL,
  price_from NUMERIC(12,2) NOT NULL DEFAULT 0,
  price_to NUMERIC(12,2),
  priority INT NOT NULL DEFAULT 100,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS logs (
  id BIGSERIAL PRIMARY KEY,
  job_id BIGINT REFERENCES jobs(id) ON DELETE SET NULL,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  data JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS products_raw (
  id BIGSERIAL PRIMARY KEY,
  job_id BIGINT REFERENCES jobs(id) ON DELETE SET NULL,
  supplier_id BIGINT REFERENCES suppliers(id) ON DELETE CASCADE,
  source_id BIGINT REFERENCES sources(id) ON DELETE SET NULL,
  article TEXT NOT NULL,
  size TEXT,
  quantity INT,
  price NUMERIC(12, 2),
  price_with_markup NUMERIC(12,2),
  extra TEXT,
  row_data JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS products_final (
  id BIGSERIAL PRIMARY KEY,
  job_id BIGINT REFERENCES jobs(id) ON DELETE SET NULL,
  article TEXT NOT NULL,
  size TEXT,
  quantity INT,
  price_base NUMERIC(12, 2),
  price_final NUMERIC(12, 2),
  extra TEXT,
  supplier_id BIGINT REFERENCES suppliers(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS price_overrides (
  id BIGSERIAL PRIMARY KEY,
  article TEXT NOT NULL,
  size TEXT,
  price_final NUMERIC(12, 2) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_products_raw_article_size ON products_raw (article, size);
CREATE INDEX IF NOT EXISTS idx_products_raw_supplier ON products_raw (supplier_id);
CREATE INDEX IF NOT EXISTS idx_products_final_article_size ON products_final (article, size);
CREATE INDEX IF NOT EXISTS idx_products_final_job ON products_final (job_id);
CREATE INDEX IF NOT EXISTS idx_logs_job_created ON logs (job_id, created_at);
