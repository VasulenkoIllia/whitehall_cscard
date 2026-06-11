-- Migration 039: app_settings — runtime-редаговані налаштування (key-value).
--
-- Призначення:
--   * enrichment_system_prompt  — кастомний system prompt для AI enrichment
--                                 (редагується з фронта; порожньо = вбудований default).
--   * anthropic_api_key         — власний API ключ Claude, введений з фронта.
--                                 Має пріоритет над env ANTHROPIC_API_KEY.
--                                 У UI ніколи не повертається повністю — тільки маска.
--   * excel_import_excluded_columns — JSONB масив назв колонок, які відкидаються
--                                 при імпорті Excel (фото, лінки тощо).
--
-- value      — для простих текстових значень (промпт, ключ).
-- value_json — для структурованих (масиви/обʼєкти).

CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  value_json JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Версія промпта, з якою відправлявся async batch. Заповнюється при submit;
-- при sync результатів пишеться у master_catalog.ai_prompt_version.
ALTER TABLE anthropic_batches ADD COLUMN IF NOT EXISTS prompt_version TEXT;
