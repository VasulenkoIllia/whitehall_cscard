-- Partitioning for products_raw by day
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'products_raw_p'
      AND n.nspname = 'public'
  ) THEN
    ALTER TABLE products_raw RENAME TO products_raw_p;
    ALTER TABLE products_raw_p SET LOGGED;
    ALTER TABLE products_raw_p DROP CONSTRAINT IF EXISTS products_raw_p_pkey;
    ALTER TABLE products_raw_p DROP CONSTRAINT IF EXISTS products_raw_pkey;
    -- parent table with composite PK (id, created_at) to satisfy partitioning rule
    CREATE TABLE products_raw (
      LIKE products_raw_p INCLUDING DEFAULTS INCLUDING IDENTITY INCLUDING GENERATED INCLUDING STORAGE INCLUDING COMMENTS,
      PRIMARY KEY (id, created_at)
    ) PARTITION BY RANGE (created_at);
    ALTER TABLE products_raw_p ADD PRIMARY KEY (id, created_at);
    -- Attach existing data as one default partition
    ALTER TABLE products_raw ATTACH PARTITION products_raw_p DEFAULT;
  END IF;
END$$;

-- Helper function to create daily partitions
CREATE OR REPLACE FUNCTION ensure_products_raw_partition(p_date date)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  start_ts timestamptz := p_date;
  end_ts timestamptz := p_date + INTERVAL '1 day';
  partition_name text := 'products_raw_' || to_char(p_date, 'YYYYMMDD');
BEGIN
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF products_raw FOR VALUES FROM (%L) TO (%L)',
    partition_name,
    start_ts,
    end_ts
  );
  EXECUTE format(
    'CREATE INDEX IF NOT EXISTS %I_idx ON %I (job_id, article, size)',
    partition_name || '_job_article_size',
    partition_name
  );
END;
$$;
