-- Migration 052: таблиці для зберігання AI-пропозицій.
--
-- 2 окремі таблиці:
--   sheet_tab_analyses        — результат "який з tabs у файлі є каталогом продуктів".
--                               1 рядок per (supplier_id, spreadsheet_id, model_version).
--   column_mapping_suggestions — пропозиція мапінгу для конкретного tab'у.
--                               1 рядок per (supplier_id, source_id, model_version).
--                               status: 'pending' → admin відкриває → 'approved'/'rejected'/'edited'.
--
-- Окремо від `column_mappings` тому що:
--   1. AI пропозиція ≠ реальний мапінг — до апруву нічого не йде в pipeline.
--   2. Зберігаємо raw response для дебагу і майбутнього few-shot training.
--   3. Можна перегенеровувати suggestion без впливу на робочий мапінг.

-- ─────────────────────────────────────────────────────────────────────────
-- sheet_tab_analyses: який tab у файлі є каталогом продуктів
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sheet_tab_analyses (
  id              BIGSERIAL PRIMARY KEY,
  supplier_id     BIGINT NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  spreadsheet_id  TEXT NOT NULL,                  -- Google sheet id (з URL)
  sheet_url       TEXT NOT NULL,                  -- повний URL для зручності
  model_version   TEXT NOT NULL,                  -- 'claude-sonnet-4-5-20250929' тощо
  tabs            JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- структура одного елемента tabs[]:
  --   { "name":"Кросівки чоловіки", "row_count":5200, "is_catalog":true,
  --     "product_type":"footwear", "confidence":0.99,
  --     "reasoning":"Headers match product schema, sample rows look like SKUs" }
  raw_response    JSONB,                          -- full Claude response для дебагу
  input_tokens    INT,
  output_tokens   INT,
  duration_ms     INT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS sheet_tab_analyses_supplier_idx
  ON sheet_tab_analyses (supplier_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────
-- column_mapping_suggestions: пропозиція mapping для конкретного tab/source
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS column_mapping_suggestions (
  id              BIGSERIAL PRIMARY KEY,
  supplier_id     BIGINT NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  source_id       BIGINT REFERENCES sources(id) ON DELETE CASCADE,
  -- source_id може бути NULL якщо source ще не створений (suggest перед creation)
  sheet_url       TEXT NOT NULL,
  tab_name        TEXT NOT NULL,
  model_version   TEXT NOT NULL,

  -- те що AI повернув:
  header_row              INT,
  first_data_row          INT,
  header_row_confidence   NUMERIC(4,3),
  header_row_reasoning    TEXT,
  proposed_mapping        JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- proposed_mapping format:
  --   {
  --     "article":  {"type":"column","col_index":2,"col_letter":"C","header":"Артикул","confidence":0.99,"reasoning":"..."},
  --     "name_uk":  {"type":"column","col_index":5,"col_letter":"F","header":"Назва","confidence":0.95,"reasoning":"...","sample_values":["Кросівки Adidas",...]},
  --     "quantity": {"type":"static","value":"1","confidence":0.7,"reasoning":"col 14 завжди 0 — це псевдо-статус, треба static"}
  --   }
  warnings        JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- warnings: [{"type":"collision","fields":["name_uk","model_name"],"col":5,"message":"..."}]
  unmapped_cols   JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- unmapped_cols: [{"col_index":0,"col_letter":"A","header":"№","reasoning":"row counter"}]
  raw_response    JSONB,
  input_tokens    INT,
  output_tokens   INT,
  duration_ms     INT,

  -- workflow:
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','approved','rejected','edited','superseded')),
  applied_mapping JSONB,                          -- фактично збережений мапінг після правок
  reviewed_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at     TIMESTAMPTZ,
  review_notes    TEXT,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS column_mapping_suggestions_supplier_idx
  ON column_mapping_suggestions (supplier_id, source_id, status);
CREATE INDEX IF NOT EXISTS column_mapping_suggestions_pending_idx
  ON column_mapping_suggestions (status, created_at DESC)
  WHERE status = 'pending';
