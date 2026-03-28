ALTER TABLE suppliers
  ADD COLUMN IF NOT EXISTS sku_prefix TEXT;

UPDATE suppliers
SET sku_prefix = NULL
WHERE sku_prefix IS NOT NULL
  AND btrim(sku_prefix) = '';

UPDATE suppliers
SET sku_prefix = UPPER(btrim(sku_prefix))
WHERE sku_prefix IS NOT NULL
  AND btrim(sku_prefix) <> '';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'suppliers_sku_prefix_format_chk'
      AND conrelid = 'suppliers'::regclass
  ) THEN
    ALTER TABLE suppliers
      ADD CONSTRAINT suppliers_sku_prefix_format_chk
      CHECK (
        sku_prefix IS NULL
        OR sku_prefix ~ '^[A-Z0-9][A-Z0-9_-]{0,23}$'
      );
  END IF;
END$$;

CREATE UNIQUE INDEX IF NOT EXISTS suppliers_sku_prefix_uq
  ON suppliers (sku_prefix)
  WHERE sku_prefix IS NOT NULL;
