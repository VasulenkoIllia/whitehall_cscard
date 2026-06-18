-- Migration 040: cache-token колонки в ai_usage_log.
--
-- Prompt caching: статичний system-промпт пишеться в кеш (cache_creation,
-- ~1.25× ціни) один раз, далі читається (cache_read, ~0.1× ціни). Щоб cost_usd
-- був точним і було видно економію — зберігаємо ці токени окремо.

ALTER TABLE ai_usage_log
  ADD COLUMN IF NOT EXISTS cache_read_input_tokens     BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cache_creation_input_tokens BIGINT NOT NULL DEFAULT 0;
