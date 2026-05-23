-- Migration 038: master_assembly_runs — історія прогонів збірки майстер-каталогу.
--
-- Кожен запуск master_assemble (через UI або scheduler) додає сюди рядок з лічильниками
-- і тривалістю. UI відображає останній прогон у топ-бар MasterCatalogTab та повну історію
-- у окремому списку. Використовується також для smoke-тестування ідемпотентності.

CREATE TABLE IF NOT EXISTS master_assembly_runs (
  id                     BIGSERIAL PRIMARY KEY,
  job_id                 BIGINT REFERENCES jobs(id) ON DELETE SET NULL,
  status                 TEXT NOT NULL DEFAULT 'running',  -- running|finished|failed
  store_mirror_roots     INT,
  masters_upserted       INT NOT NULL DEFAULT 0,
  variations_inserted    INT NOT NULL DEFAULT 0,
  offers_inserted        INT NOT NULL DEFAULT 0,
  offers_by_signal       JSONB NOT NULL DEFAULT '{}'::jsonb,  -- {exact_sku: N, collection_code: N, variation_group_code: N}
  masters_without_offers INT NOT NULL DEFAULT 0,
  duration_ms            BIGINT,
  error                  TEXT,
  started_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at            TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS master_assembly_runs_started_idx
  ON master_assembly_runs (started_at DESC);
