ALTER TABLE products_raw
  ADD COLUMN IF NOT EXISTS comment_text TEXT;

ALTER TABLE products_final
  ADD COLUMN IF NOT EXISTS comment_text TEXT;
