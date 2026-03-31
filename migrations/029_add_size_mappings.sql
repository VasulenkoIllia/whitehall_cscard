-- Migration 029: size_mappings table
-- Provides a global lookup table for normalising supplier size values during finalize.
-- Finalize applies: COALESCE(szm.size_to, UPPER(TRIM(pr.size))) AS size
-- so unmapped sizes are auto-uppercased as a safe fallback.

CREATE TABLE IF NOT EXISTS size_mappings (
  id            BIGSERIAL PRIMARY KEY,
  size_from     TEXT        NOT NULL,
  size_to       TEXT        NOT NULL,
  notes         TEXT,
  is_active     BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Case-insensitive unique index: "XL" and "xl" cannot coexist as separate entries.
CREATE UNIQUE INDEX IF NOT EXISTS size_mappings_from_ci_uq
  ON size_mappings (LOWER(TRIM(size_from)));

-- size_to must never be empty (whitespace-only is rejected).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'size_mappings_to_nonempty'
      AND conrelid = 'size_mappings'::regclass
  ) THEN
    ALTER TABLE size_mappings
      ADD CONSTRAINT size_mappings_to_nonempty
      CHECK (TRIM(size_to) <> '');
  END IF;
END$$;
