CREATE TABLE IF NOT EXISTS markup_settings (
  id INT PRIMARY KEY,
  global_rule_set_id BIGINT REFERENCES markup_rule_sets(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT markup_settings_single_row CHECK (id = 1)
);

ALTER TABLE markup_settings
  ADD COLUMN IF NOT EXISTS global_rule_set_id BIGINT REFERENCES markup_rule_sets(id) ON DELETE SET NULL;

ALTER TABLE markup_settings
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

WITH first_active_rule_set AS (
  SELECT id
  FROM markup_rule_sets
  WHERE is_active = TRUE
  ORDER BY id ASC
  LIMIT 1
)
INSERT INTO markup_settings (id, global_rule_set_id, updated_at)
SELECT 1, first_active_rule_set.id, NOW()
FROM first_active_rule_set
ON CONFLICT (id) DO UPDATE
SET global_rule_set_id = COALESCE(markup_settings.global_rule_set_id, EXCLUDED.global_rule_set_id),
    updated_at = NOW();
