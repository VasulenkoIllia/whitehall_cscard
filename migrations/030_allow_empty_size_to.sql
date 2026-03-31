-- Migration 030: allow empty size_to in size_mappings
-- Removes the CHECK constraint that prevented mapping a size to an empty string.
-- Use case: mapping a supplier size (e.g. "OS", "One Size") to empty string so
-- the size suffix is dropped from the effective SKU during finalize.
-- The finalize pipeline already handles empty size correctly:
--   CASE WHEN pf.size IS NULL OR btrim(pf.size) = '' THEN pf.article ...
-- Backend validation still requires explicit allow_empty_size_to=true flag to
-- prevent accidental empty mappings.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'size_mappings_to_nonempty'
      AND conrelid = 'size_mappings'::regclass
  ) THEN
    ALTER TABLE size_mappings DROP CONSTRAINT size_mappings_to_nonempty;
  END IF;
END$$;
