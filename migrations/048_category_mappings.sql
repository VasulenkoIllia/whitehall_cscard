-- Migration 048: category_mappings — нормалізація категорій постачальників на категорії магазину.
--
-- Структура — аналогічна size_mappings (migration 029) і color_mappings (migration 046).
-- У наступній ітерації CatalogAssembler застосовуватиме category_to до field_values для
-- майстер-поля `category_uk` (так само як size_to застосовується для variant.size).
--
-- Приклад правил:
--   category_from: "Спортивний одяг"     → category_to: "Чоловікам/Футболки"
--   category_from: "Sportwear"           → category_to: "Чоловікам/Футболки"
--   category_from: "Одежда мужская"      → category_to: "Чоловікам"
--
-- Зараз — лише таблиця для зберігання правил, без сервісної інтеграції.

CREATE TABLE IF NOT EXISTS category_mappings (
  id              BIGSERIAL PRIMARY KEY,
  category_from   TEXT        NOT NULL,
  category_to     TEXT        NOT NULL,
  notes           TEXT,
  is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS category_mappings_from_ci_uq
  ON category_mappings (LOWER(TRIM(category_from)));

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'category_mappings_to_nonempty'
      AND conrelid = 'category_mappings'::regclass
  ) THEN
    ALTER TABLE category_mappings
      ADD CONSTRAINT category_mappings_to_nonempty
      CHECK (TRIM(category_to) <> '');
  END IF;
END$$;
