-- Migration 042: master_fields + master_collection_field_values.
--
-- "Майстер-поля" — це канонічні атрибути, які ми хочемо мати у фінальній картці товару.
-- Наприклад: brand, color_uk, material, name_uk, description_full, meta_title.
--
-- Workflow:
--   1. Адмін заводить master_fields у БД (зараз — seed; UI для редагування — TODO).
--   2. Для кожної master_collections (моделі) UI пропонує кандидатів-значень
--      з різних джерел (merged_attributes постачальників + store_mirror.raw).
--   3. Користувач обирає (manual) або в майбутньому AI пропонує (ai/auto source).
--   4. Збережене значення йде у master_collection_field_values і потім використовується
--      для пушу у CS-Cart, SEO, експорту тощо.

CREATE TABLE IF NOT EXISTS master_fields (
  id                   BIGSERIAL PRIMARY KEY,
  key                  TEXT UNIQUE NOT NULL,             -- machine key: 'brand', 'name_uk', 'meta_title'
  label_uk             TEXT NOT NULL,                    -- UI label, наприклад "Бренд"
  description_uk       TEXT,                             -- help text для адміна/копірайтера
  data_type            TEXT NOT NULL DEFAULT 'text',     -- text | long_text | number | enum
  is_required          BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order           INT NOT NULL DEFAULT 100,
  -- Підказки для автопідбору кандидатів:
  candidate_hint_keys  JSONB NOT NULL DEFAULT '[]'::jsonb,  -- ['бренд', 'brand', 'col_3'] — ключі row_data, що часто містять цю цінність
  candidate_cs_fields  JSONB NOT NULL DEFAULT '[]'::jsonb,  -- ['product', 'seo_name'] — поля з store_mirror.raw
  is_active            BOOLEAN NOT NULL DEFAULT TRUE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS master_fields_sort_idx ON master_fields (sort_order, id) WHERE is_active;

CREATE TABLE IF NOT EXISTS master_collection_field_values (
  id                    BIGSERIAL PRIMARY KEY,
  collection_id         BIGINT NOT NULL REFERENCES master_collections(id) ON DELETE CASCADE,
  field_id              BIGINT NOT NULL REFERENCES master_fields(id) ON DELETE CASCADE,
  value                 TEXT,                              -- може бути NULL/"" якщо ще не заповнено
  source                TEXT NOT NULL DEFAULT 'manual',    -- manual | auto | ai
  source_supplier_id    BIGINT REFERENCES suppliers(id) ON DELETE SET NULL,
  source_attribute_key  TEXT,                              -- з якого ключа row_data було взято
  updated_by            UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT master_collection_field_values_uq UNIQUE (collection_id, field_id)
);

CREATE INDEX IF NOT EXISTS master_collection_field_values_field_idx
  ON master_collection_field_values (field_id);

-- ─── Seed: базові master_fields ────────────────────────────────────────────────
-- Заводимо ~12 ключових полів. candidate_hint_keys — це найпоширеніші заголовки
-- з products_raw row_data (UA/RU/EN), які зустрічаються у постачальницьких файлах.
-- Адмін зможе пізніше додати свої через UI.

INSERT INTO master_fields (key, label_uk, description_uk, data_type, is_required, sort_order, candidate_hint_keys, candidate_cs_fields)
VALUES
  ('name_uk', 'Назва (UA)', 'Назва товару українською — основна назва для каталогу і SEO', 'text', true, 10,
    '["Назва","назва","Назва Футболки","Найменування","Название (UA)","Название","Назва товару"]'::jsonb,
    '["product"]'::jsonb),
  ('name_en', 'Назва (EN)', 'English name — для англомовної локалі магазину', 'text', false, 20,
    '["name","Name","extra"]'::jsonb,
    '[]'::jsonb),
  ('brand', 'Бренд', 'Бренд / виробник (Nike, Adidas, тощо)', 'text', true, 30,
    '["бренд","Бренд","brand","Brand","виробник","Виробник","Производитель","Manufacturer"]'::jsonb,
    '[]'::jsonb),
  ('mpn', 'Код виробника (MPN)', 'Manufacturer Part Number — як FZ5765-010', 'text', false, 40,
    '["MPN","mpn","Код виробника","Код производителя","Артикул"]'::jsonb,
    '[]'::jsonb),
  ('category_uk', 'Категорія', 'Тип товару — Штани / Кросівки / Куртка / тощо', 'text', false, 50,
    '["категорія","Категорія","категория","Тип","тип","Type","Group","group","Розділ"]'::jsonb,
    '[]'::jsonb),
  ('gender', 'Стать', 'Чоловіча / Жіноча / Унісекс / Дитячий', 'enum', false, 60,
    '["стать","Стать","пол","gender","Gender","Sex"]'::jsonb,
    '[]'::jsonb),
  ('color_uk', 'Колір (UA)', 'Основний колір товару українською', 'text', false, 70,
    '["колір","Колір","цвет","Цвет","color","Color","Colour"]'::jsonb,
    '[]'::jsonb),
  ('material', 'Матеріал', 'Основний матеріал (бавовна / шкіра / поліестер)', 'text', false, 80,
    '["матеріал","Матеріал","материал","Материал","material","Material","Склад","Composition","Tkanina"]'::jsonb,
    '[]'::jsonb),
  ('season', 'Сезон', 'Літо / Зима / Демісезон / Універсальний', 'text', false, 90,
    '["сезон","Сезон","season","Season"]'::jsonb,
    '[]'::jsonb),
  ('country', 'Країна виробництва', 'Country of origin', 'text', false, 100,
    '["країна","Країна","страна","country","Country","made_in"]'::jsonb,
    '[]'::jsonb),
  ('description_short_uk', 'Короткий опис (UA)', 'Короткий опис для лістингу і preview карток', 'long_text', false, 200,
    '[]'::jsonb,
    '["short_description"]'::jsonb),
  ('description_full_uk', 'Повний опис (UA)', 'Розгорнутий опис для картки товару — AI заповнить у Phase 2', 'long_text', false, 210,
    '[]'::jsonb,
    '["full_description"]'::jsonb),
  ('meta_title', 'SEO Title', 'Заголовок для пошуковиків (≤60 символів)', 'text', false, 300,
    '[]'::jsonb,
    '["meta_keywords","page_title"]'::jsonb),
  ('meta_description', 'SEO Description', 'Мета-опис для пошуковиків (≤160 символів)', 'long_text', false, 310,
    '[]'::jsonb,
    '["meta_description"]'::jsonb),
  ('slug', 'SEO slug', 'URL-сегмент для сторінки товару', 'text', false, 320,
    '[]'::jsonb,
    '["seo_name"]'::jsonb)
ON CONFLICT (key) DO NOTHING;
