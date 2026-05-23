-- Migration 039: build_row_object_from_array() — допоміжна функція для master_assemble.
--
-- products_raw.row_data зберігається імпортером як positional JSON array (значення по колонкам
-- оригінального Google Sheet). Заголовки колонок ЗБЕРІГАЮТЬСЯ ОКРЕМО у
-- column_mappings.mapping_meta.headers — але тільки для мапленних полів (article, size, price...).
--
-- master_offers.row_data має бути header-keyed object (для GIN-індексу, JSONB-запитів і
-- зведеного merged_attributes у master_products). Ця функція робить трансляцію:
--   1. Будує реверс-мапу idx → header_name з (mapping, mapping_meta.headers).
--   2. Для кожної непорожньої позиції array — записує {header_name або 'col_N' : value}.
--   3. Унмаплені позиції отримують ключ "col_N" (зберігаємо всі дані, навіть якщо ім'я невідоме).
--
-- IMMUTABLE — можна викликати з функціональних індексів і JOIN-умов.

CREATE OR REPLACE FUNCTION build_row_object_from_array(
  arr jsonb,
  mapping jsonb,
  headers jsonb
) RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    -- Захист від NULL / не-array / порожнього array
    WHEN arr IS NULL
      OR jsonb_typeof(arr) <> 'array'
      OR jsonb_array_length(arr) = 0
      THEN '{}'::jsonb
    -- Якщо це вже object (старий формат або вручну вставлене) — повертаємо як є
    -- (хоча умова "<> 'array'" вище вже відловила б object — це гілка-no-op)
    ELSE COALESCE((
      SELECT jsonb_object_agg(
        COALESCE(rev.header_name, 'col_' || (s.idx + 1)::text),
        arr->>s.idx
      )
      FROM generate_series(0, jsonb_array_length(arr) - 1) AS s(idx)
      LEFT JOIN (
        SELECT
          ((mapping->>k)::int - 1) AS idx,
          -- Перевага — оригінальний UA-заголовок із mapping_meta.headers; fallback —
          -- machine key ('article', 'size', тощо).
          COALESCE(NULLIF(btrim(headers->>k), ''), k) AS header_name
        FROM jsonb_object_keys(COALESCE(mapping, '{}'::jsonb)) AS k
        WHERE jsonb_typeof(mapping->k) = 'number'
          AND (mapping->>k)::int > 0
      ) rev ON rev.idx = s.idx
      WHERE COALESCE(btrim(arr->>s.idx), '') <> ''
    ), '{}'::jsonb)
  END;
$$;
