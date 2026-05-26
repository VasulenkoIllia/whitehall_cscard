-- Migration 038: anthropic_batches — Anthropic Message Batches API.
--
-- Концепція:
--   * Звичайний enrich = sync виклик (чекаєш відповідь, ~10-30 секунд).
--   * Batch API = async: завантажуєш до 10000 запитів → Anthropic обробляє
--     впродовж 1-24 годин → -50% ціна.
--
-- Workflow:
--   1. Користувач у UI обирає N SKU (наприклад всі 38421) → клік "Submit batch".
--   2. Сервер створює запис у anthropic_batches.
--   3. Сервер групує requests у JSONL і викликає POST /v1/messages/batches.
--   4. Anthropic повертає batch_id + status="in_progress".
--   5. Cron job (або manual refresh) поллить status кожні N хвилин.
--   6. Коли status="ended" → скачуємо results.jsonl → парсимо → пишемо у
--      master_catalog (так само як в EnrichmentService.writeMasterFields).

CREATE TABLE IF NOT EXISTS anthropic_batches (
  id                BIGSERIAL PRIMARY KEY,
  external_id       TEXT NOT NULL UNIQUE,        -- 'msgbatch_01abc...' від Anthropic
  operation         TEXT NOT NULL DEFAULT 'enrich_batch',
  status            TEXT NOT NULL DEFAULT 'in_progress',
                    -- in_progress / canceling / ended / errored / expired
  model_version     TEXT NOT NULL,
  master_ids        BIGINT[] NOT NULL DEFAULT '{}',
  items_count       INT NOT NULL DEFAULT 0,
  processed_count   INT NOT NULL DEFAULT 0,
  succeeded_count   INT NOT NULL DEFAULT 0,
  errored_count     INT NOT NULL DEFAULT 0,
  canceled_count    INT NOT NULL DEFAULT 0,
  expired_count     INT NOT NULL DEFAULT 0,
  -- Витрати/токени — заповнюємо коли batch завершився:
  input_tokens      INT,
  output_tokens     INT,
  cost_usd          NUMERIC(10, 6),
  -- URL для скачування results (Anthropic дає після ended):
  results_url       TEXT,
  -- Останнє повне response від /v1/messages/batches/:id (для дебагу):
  last_anthropic_response JSONB,
  error             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  submitted_at      TIMESTAMPTZ,
  ended_at          TIMESTAMPTZ,
  results_fetched_at TIMESTAMPTZ,
  user_id           UUID REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS anthropic_batches_status_idx
  ON anthropic_batches (status, created_at DESC);
CREATE INDEX IF NOT EXISTS anthropic_batches_in_progress_idx
  ON anthropic_batches (id) WHERE status = 'in_progress';
