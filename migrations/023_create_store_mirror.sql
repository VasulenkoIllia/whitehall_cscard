CREATE TABLE IF NOT EXISTS store_mirror (
  store TEXT NOT NULL,
  article TEXT NOT NULL,
  supplier TEXT,
  parent_article TEXT,
  visibility BOOLEAN NOT NULL,
  price NUMERIC(12, 2),
  raw JSONB,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  seen_at TIMESTAMPTZ,
  PRIMARY KEY (store, article)
);

CREATE INDEX IF NOT EXISTS store_mirror_store_seen_idx
  ON store_mirror (store, seen_at);

CREATE INDEX IF NOT EXISTS store_mirror_store_parent_idx
  ON store_mirror (store, parent_article);
