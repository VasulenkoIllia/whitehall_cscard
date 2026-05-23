-- Migration 046: color_mappings — нормалізація кольорів (за зразком size_mappings).
--
-- Структура — точно як size_mappings (migration 029). У наступній ітерації CatalogAssembler
-- застосовуватиме color_to до field_values для майстер-поля `color_uk` (аналогічно як
-- size_to застосовується для variant.size). Зараз — тільки таблиця, без сервісної інтеграції.

CREATE TABLE IF NOT EXISTS color_mappings (
  id           BIGSERIAL PRIMARY KEY,
  color_from   TEXT        NOT NULL,
  color_to     TEXT        NOT NULL,
  notes        TEXT,
  is_active    BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS color_mappings_from_ci_uq
  ON color_mappings (LOWER(TRIM(color_from)));

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'color_mappings_to_nonempty'
      AND conrelid = 'color_mappings'::regclass
  ) THEN
    ALTER TABLE color_mappings
      ADD CONSTRAINT color_mappings_to_nonempty
      CHECK (TRIM(color_to) <> '');
  END IF;
END$$;
