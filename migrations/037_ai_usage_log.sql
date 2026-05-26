-- Migration 037: лог витрат AI запитів.
--
-- Кожен виклик Anthropic API записується у ai_usage_log: модель, токени, час,
-- вартість (calculated server-side за поточними цінами).
--
-- Дозволяє:
--   * показати total $ витрачено на enrichment у UI
--   * аналіз дорогих SKU / batches
--   * планування budget
--
-- Ціни (per million tokens, on 2026-05):
--   claude-haiku-4-5  : $1 input,  $5 output
--   claude-sonnet-4-5 : $3 input, $15 output
--   claude-opus-4     : $15 input, $75 output
--   Batch API: -50% on both.

CREATE TABLE IF NOT EXISTS ai_usage_log (
  id                BIGSERIAL PRIMARY KEY,
  operation         TEXT NOT NULL,                    -- 'enrich_master' / 'enrich_batch' / 'mapping_suggest' / etc.
  model_version     TEXT NOT NULL,                    -- 'claude-haiku-4-5-20251001' тощо
  master_ids        BIGINT[] NOT NULL DEFAULT '{}',   -- які SKU брали участь (для batch)
  items_count       INT NOT NULL DEFAULT 0,           -- скільки SKU було (для batch)
  input_tokens      INT NOT NULL DEFAULT 0,
  output_tokens     INT NOT NULL DEFAULT 0,
  cost_usd          NUMERIC(10, 6) NOT NULL DEFAULT 0,
                    -- розрахунок: input * input_rate + output * output_rate
                    -- значення server-side, immutable після запису
  duration_ms       BIGINT NOT NULL DEFAULT 0,
  is_batch_api      BOOLEAN NOT NULL DEFAULT FALSE,   -- TRUE для Anthropic Batch API (-50% rates)
  fields_written    INT,                              -- скільки реально записали у master_catalog
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  user_id           UUID REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS ai_usage_log_created_idx ON ai_usage_log (created_at DESC);
CREATE INDEX IF NOT EXISTS ai_usage_log_operation_idx ON ai_usage_log (operation, created_at DESC);
