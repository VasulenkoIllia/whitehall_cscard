-- ─────────────────────────────────────────────────────────────────────────────
-- scripts/seed_test_suppliers.sql
--
-- Створює 5 ТЕСТОВИХ постачальників (id 9001-9005) з реалістичними даними:
-- різні мови заголовків, різна структура колонок, overlapping SKU для демо
-- merge-логіки і color/category mappings нормалізації.
--
-- Безпечно для повторного запуску — старі test_* записи (id 9001-9099)
-- видаляються через DELETE+CASCADE перед інсертом.
--
-- Запуск:
--   docker exec -i whitehall-cscard-db-local psql -U whitehall_store -d whitehall_store \
--     < scripts/seed_test_suppliers.sql
--
-- Очищення (без re-insert):
--   docker exec whitehall-cscard-db-local psql -U whitehall_store -d whitehall_store \
--     -c "DELETE FROM suppliers WHERE id BETWEEN 9001 AND 9099;
--         DELETE FROM color_mappings WHERE notes LIKE 'test:%';
--         DELETE FROM category_mappings WHERE notes LIKE 'test:%';"
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- 1. Cleanup попередніх test-даних (CASCADE прибере sources, mappings, raw, final, offers).
DELETE FROM color_mappings    WHERE notes LIKE 'test:%';
DELETE FROM category_mappings WHERE notes LIKE 'test:%';
DELETE FROM suppliers         WHERE id BETWEEN 9001 AND 9099;

-- 2. 5 тестових постачальників. Priority різний — щоб видно було хто переможе у merge.
-- sku_prefix=NULL — щоб усі видавали той самий article "TEST-001", "TEST-002" → один master на SKU.
INSERT INTO suppliers (id, name, markup_percent, priority, is_active, sku_prefix)
VALUES
  (9001, 'TestUA — Ukrainian sample',   30,  50, true, NULL),
  (9002, 'TestRU — Russian legacy',     30, 100, true, NULL),
  (9003, 'TestEN — English source',     30, 100, true, NULL),
  (9004, 'TestBasic — minimal 5 fields', 30, 200, true, NULL),
  (9005, 'TestPremium — full 21 fields', 30,  30, true, NULL);

-- 3. Sources. is_active=false — щоб ImporterDb їх не чіпав (fake URL впаде).
-- CatalogAssembler читає тільки products_raw + products_final, тому це не блокує його.
INSERT INTO sources (id, supplier_id, source_type, source_url, sheet_name, is_active)
VALUES
  (9001, 9001, 'google_sheet', 'test://ua',      'TestUA',      false),
  (9002, 9002, 'google_sheet', 'test://ru',      'TestRU',      false),
  (9003, 9003, 'google_sheet', 'test://en',      'TestEN',      false),
  (9004, 9004, 'google_sheet', 'test://basic',   'TestBasic',   false),
  (9005, 9005, 'google_sheet', 'test://premium', 'TestPremium', false);

-- 4. Column mappings — різні layouts.
-- TestUA: 12 колонок (basic + brand/color/category/material/gender/season/photo).
INSERT INTO column_mappings (supplier_id, source_id, mapping, mapping_meta, header_row) VALUES
(9001, 9001,
  '{"article":1,"extra":2,"brand":3,"price":4,"size":5,"quantity":6,"color_uk":7,"category_uk":8,"material":9,"gender":10,"season":11,"photo":12}'::jsonb,
  '{"headers":{"article":"Артикул","extra":"Назва","brand":"Бренд","price":"Ціна","size":"Розмір","quantity":"К-сть","color_uk":"Колір","category_uk":"Категорія","material":"Матеріал","gender":"Стать","season":"Сезон","photo":"Фото"}}'::jsonb,
  1),
-- TestRU: 8 columns, russian headers.
(9002, 9002,
  '{"article":1,"price":2,"size":3,"quantity":4,"brand":5,"color_uk":6,"description_full_uk":7,"country":8}'::jsonb,
  '{"headers":{"article":"Артикул","price":"Цена","size":"Размер","quantity":"Количество","brand":"Бренд","color_uk":"Цвет","description_full_uk":"Описание","country":"Страна"}}'::jsonb,
  1),
-- TestEN: 9 columns, english headers.
(9003, 9003,
  '{"article":1,"extra":2,"brand":3,"price":4,"size":5,"quantity":6,"color_uk":7,"gender":8,"photo":9}'::jsonb,
  '{"headers":{"article":"sku","extra":"name","brand":"brand","price":"price","size":"size","quantity":"qty","color_uk":"color","gender":"gender","photo":"photo_url"}}'::jsonb,
  1),
-- TestBasic: тільки 5 базових — нагадає "бідного" постачальника.
(9004, 9004,
  '{"article":1,"extra":2,"size":3,"price":4,"quantity":5}'::jsonb,
  '{"headers":{"article":"Артикул","extra":"Назва","size":"Розмір","price":"Ціна","quantity":"К-сть"}}'::jsonb,
  1),
-- TestPremium: 21 колонка — "ідеальний" розширений Excel зі всіма полями.
(9005, 9005,
  '{"article":1,"name_uk":2,"brand":3,"price":4,"size":5,"quantity":6,"old_price":7,"category_uk":8,"product_kind":9,"product_type":10,"color_uk":11,"model_name":12,"gender":13,"style":14,"material":15,"material_top":16,"material_sole":17,"fastening":18,"season":19,"country":20,"photo":21}'::jsonb,
  '{"headers":{"article":"Артикул","name_uk":"Назва UA","brand":"Бренд","price":"Ціна","size":"Розмір","quantity":"К-сть","old_price":"Стара ціна","category_uk":"Категорія","product_kind":"Вид товару","product_type":"Тип","color_uk":"Колір","model_name":"Модель","gender":"Стать","style":"Стиль","material":"Матеріал","material_top":"Матеріал верху","material_sole":"Підошва","fastening":"Застібка","season":"Сезон","country":"Країна","photo":"Фото"}}'::jsonb,
  1);

-- 5. Job для FK з products_raw.
INSERT INTO jobs (id, type, status, started_at, finished_at)
VALUES (9000, 'import_all', 'success', NOW(), NOW())
ON CONFLICT (id) DO NOTHING;

-- 6. products_raw — реалістичні дані, overlapping SKU.
--
-- Покриття SKU постачальниками:
--   TEST-001 (Nike AF1)         : UA + RU + EN + Basic    — 4 постачальники, демо merge
--   TEST-002 (Adidas Stan Smith): UA + Premium            — порівняти бідний vs повний
--   TEST-003 (Puma Beanie)      : RU + EN + Premium       — мульти-мовність
--   TEST-004 (Шкарпетки)        : Basic                   — single supplier mini case
--   TEST-005 (NF Куртка)        : Premium                 — повний набір полів від 1 постач.
--
-- row_data — JSON array з НА СТІЛЬКИ колонок, скільки у відповідного мапінгу.

-- TEST-001 (Nike Air Force 1) — TestUA, sizes S/M/L
INSERT INTO products_raw (job_id, supplier_id, source_id, article, size, quantity, price, extra, row_data) VALUES
(9000, 9001, 9001, 'TEST-001', 'S', 5, 1200, 'Кросівки Nike Air Force 1',
 '["TEST-001","Кросівки Nike Air Force 1","Nike","1200","S","5","Білий","Чоловікам/Взуття","Шкіра","Чоловіча","Універсальний","https://test.cdn/af1_white_1.jpg;https://test.cdn/af1_white_2.jpg"]'::jsonb),
(9000, 9001, 9001, 'TEST-001', 'M', 3, 1200, 'Кросівки Nike Air Force 1',
 '["TEST-001","Кросівки Nike Air Force 1","Nike","1200","M","3","Білий","Чоловікам/Взуття","Шкіра","Чоловіча","Універсальний","https://test.cdn/af1_white_1.jpg;https://test.cdn/af1_white_2.jpg"]'::jsonb),
(9000, 9001, 9001, 'TEST-001', 'L', 7, 1200, 'Кросівки Nike Air Force 1',
 '["TEST-001","Кросівки Nike Air Force 1","Nike","1200","L","7","Білий","Чоловікам/Взуття","Шкіра","Чоловіча","Універсальний","https://test.cdn/af1_white_1.jpg;https://test.cdn/af1_white_2.jpg"]'::jsonb),
-- TestRU — М/L, цвет "белый", описание Russian (норм-правилом перейде в "Білий" після assemble)
(9000, 9002, 9002, 'TEST-001', 'M', 2, 1150, 'Кросівки',
 '["TEST-001","1150","M","2","Nike","белый","Оригінальні чоловічі кросівки Nike AF1 для повсякденного носіння","США"]'::jsonb),
(9000, 9002, 9002, 'TEST-001', 'L', 4, 1150, 'Кросівки',
 '["TEST-001","1150","L","4","Nike","белый","Оригінальні чоловічі кросівки Nike AF1 для повсякденного носіння","США"]'::jsonb),
-- TestEN — М/L, "White" → "Білий" через color_mappings
(9000, 9003, 9003, 'TEST-001', 'M', 6, 1230, 'Air Force 1',
 '["TEST-001","Nike Air Force 1","Nike","1230","M","6","White","Men","https://nike.com/img/af1.jpg"]'::jsonb),
(9000, 9003, 9003, 'TEST-001', 'L', 1, 1230, 'Air Force 1',
 '["TEST-001","Nike Air Force 1","Nike","1230","L","1","White","Men","https://nike.com/img/af1.jpg"]'::jsonb),
-- TestBasic — мінімум, без brand/color/photo (показати "бідного" постачальника)
(9000, 9004, 9004, 'TEST-001', 'L', 2, 1100, 'Кросівки',
 '["TEST-001","Кросівки","L","1100","2"]'::jsonb),
(9000, 9004, 9004, 'TEST-001', 'XL', 3, 1100, 'Кросівки',
 '["TEST-001","Кросівки","XL","1100","3"]'::jsonb);

-- TEST-002 (Adidas Stan Smith) — TestUA + TestPremium (порівняти "звичайного" і "ідеального")
INSERT INTO products_raw (job_id, supplier_id, source_id, article, size, quantity, price, extra, row_data) VALUES
(9000, 9001, 9001, 'TEST-002', 'M', 4, 850, 'Футболка Adidas',
 '["TEST-002","Футболка Adidas Stan Smith","Adidas","850","M","4","Зелений","Чоловікам/Одяг","Бавовна","Чоловіча","Літо","https://test.cdn/adidas_ss_1.jpg"]'::jsonb),
(9000, 9001, 9001, 'TEST-002', 'L', 6, 850, 'Футболка Adidas',
 '["TEST-002","Футболка Adidas Stan Smith","Adidas","850","L","6","Зелений","Чоловікам/Одяг","Бавовна","Чоловіча","Літо","https://test.cdn/adidas_ss_1.jpg"]'::jsonb),
-- TestPremium: 21 колонка, всі поля заповнені (вищий priority=30 → переможе у merged_field_values)
(9000, 9005, 9005, 'TEST-002', 'S', 2, 920, '',
 '["TEST-002","Футболка Adidas Stan Smith Premium Edition","Adidas","920","S","2","700","Чоловікам/Одяг","Одяг","Футболки","Зелений","Stan Smith","Чоловіча","Спортивний","Бавовна 100%","","","","Літо","Вʼєтнам","https://premium.cdn/adidas_ss_1.jpg;https://premium.cdn/adidas_ss_2.jpg"]'::jsonb),
(9000, 9005, 9005, 'TEST-002', 'M', 3, 920, '',
 '["TEST-002","Футболка Adidas Stan Smith Premium Edition","Adidas","920","M","3","700","Чоловікам/Одяг","Одяг","Футболки","Зелений","Stan Smith","Чоловіча","Спортивний","Бавовна 100%","","","","Літо","Вʼєтнам","https://premium.cdn/adidas_ss_1.jpg;https://premium.cdn/adidas_ss_2.jpg"]'::jsonb),
(9000, 9005, 9005, 'TEST-002', 'L', 1, 920, '',
 '["TEST-002","Футболка Adidas Stan Smith Premium Edition","Adidas","920","L","1","700","Чоловікам/Одяг","Одяг","Футболки","Зелений","Stan Smith","Чоловіча","Спортивний","Бавовна 100%","","","","Літо","Вʼєтнам","https://premium.cdn/adidas_ss_1.jpg;https://premium.cdn/adidas_ss_2.jpg"]'::jsonb);

-- TEST-003 (Puma Beanie) — RU + EN + Premium, multi-language (color_mappings перетворить navy/Navy → Темно-синій)
INSERT INTO products_raw (job_id, supplier_id, source_id, article, size, quantity, price, extra, row_data) VALUES
(9000, 9002, 9002, 'TEST-003', 'M', 3, 600, 'Шапка Puma',
 '["TEST-003","600","M","3","Puma","navy","Зимова шапка Puma з вишитим логотипом","Туреччина"]'::jsonb),
(9000, 9003, 9003, 'TEST-003', 'M', 5, 620, 'Beanie',
 '["TEST-003","Puma Beanie","Puma","620","M","5","Navy","Unisex","https://puma.com/img/beanie.jpg"]'::jsonb),
(9000, 9005, 9005, 'TEST-003', 'M', 2, 580, '',
 '["TEST-003","Шапка Puma зимова","Puma","580","M","2","","Аксесуари","Аксесуари","Шапки","Темно-синій","Beanie","Унісекс","Кежуал","Акрил","","","","Зима","Туреччина","https://premium.cdn/puma_beanie.jpg"]'::jsonb);

-- TEST-004 (Шкарпетки) — тільки TestBasic, мінімальна картка
INSERT INTO products_raw (job_id, supplier_id, source_id, article, size, quantity, price, extra, row_data) VALUES
(9000, 9004, 9004, 'TEST-004', 'M', 10, 350, 'Шкарпетки',
 '["TEST-004","Шкарпетки спортивні","M","350","10"]'::jsonb),
(9000, 9004, 9004, 'TEST-004', 'L',  8, 350, 'Шкарпетки',
 '["TEST-004","Шкарпетки спортивні","L","350","8"]'::jsonb);

-- TEST-005 (NF Куртка) — тільки TestPremium, повний набір
INSERT INTO products_raw (job_id, supplier_id, source_id, article, size, quantity, price, extra, row_data) VALUES
(9000, 9005, 9005, 'TEST-005', 'M', 5, 2400, '',
 '["TEST-005","Куртка зимова North Face","North Face","2400","M","5","3200","Чоловікам/Одяг","Одяг","Куртки","Чорний","Mountain","Чоловіча","Спортивний","Поліестер","Нейлон","","Блискавка","Зима","Китай","https://premium.cdn/nf_jacket_1.jpg;https://premium.cdn/nf_jacket_2.jpg;https://premium.cdn/nf_jacket_3.jpg"]'::jsonb),
(9000, 9005, 9005, 'TEST-005', 'L', 3, 2400, '',
 '["TEST-005","Куртка зимова North Face","North Face","2400","L","3","3200","Чоловікам/Одяг","Одяг","Куртки","Чорний","Mountain","Чоловіча","Спортивний","Поліестер","Нейлон","","Блискавка","Зима","Китай","https://premium.cdn/nf_jacket_1.jpg;https://premium.cdn/nf_jacket_2.jpg;https://premium.cdn/nf_jacket_3.jpg"]'::jsonb);

-- 7. products_final — дзеркало products_raw з 30% markup (відповідає supplier.markup_percent).
INSERT INTO products_final (job_id, article, size, quantity, price_base, price_final, extra, supplier_id)
SELECT job_id, article, size, quantity, price, ROUND(price * 1.30, 2), extra, supplier_id
  FROM products_raw
 WHERE supplier_id BETWEEN 9001 AND 9099;

-- 8. Normalization rules — color. UNIQUE index = case-insensitive, тому одного запису
-- на логічний колір достатньо (нормалізація у CatalogAssembler теж case-insensitive).
INSERT INTO color_mappings (color_from, color_to, notes, is_active) VALUES
  ('navy',   'Темно-синій', 'test:normalize navy/Navy',  true),
  ('white',  'Білий',       'test:normalize White EN',   true),
  ('белый',  'Білий',       'test:normalize RU белый',   true),
  ('black',  'Чорний',      'test:normalize black EN',   true),
  ('чёрный', 'Чорний',      'test:normalize RU чёрный',  true)
ON CONFLICT (LOWER(TRIM(color_from)))
  DO UPDATE SET color_to = EXCLUDED.color_to, is_active = true, notes = EXCLUDED.notes;

-- 9. Normalization rules — category.
INSERT INTO category_mappings (category_from, category_to, notes, is_active) VALUES
  ('Чоловікам/Взуття', 'Чоловіки/Кросівки', 'test:short path UA',  true),
  ('Чоловікам/Одяг',   'Чоловіки/Одяг',     'test:short path UA',  true),
  ('Men',              'Чоловіки',          'test:EN→UA',          true)
ON CONFLICT (LOWER(TRIM(category_from)))
  DO UPDATE SET category_to = EXCLUDED.category_to, is_active = true, notes = EXCLUDED.notes;

COMMIT;

-- Підсумок
SELECT 'suppliers (test)' AS what, COUNT(*) FROM suppliers WHERE id BETWEEN 9001 AND 9099
UNION ALL SELECT 'sources (test)',           COUNT(*) FROM sources         WHERE supplier_id BETWEEN 9001 AND 9099
UNION ALL SELECT 'column_mappings (test)',   COUNT(*) FROM column_mappings WHERE supplier_id BETWEEN 9001 AND 9099
UNION ALL SELECT 'products_raw (test)',      COUNT(*) FROM products_raw    WHERE supplier_id BETWEEN 9001 AND 9099
UNION ALL SELECT 'products_final (test)',    COUNT(*) FROM products_final  WHERE supplier_id BETWEEN 9001 AND 9099
UNION ALL SELECT 'color_mappings (test:)',   COUNT(*) FROM color_mappings    WHERE notes LIKE 'test:%'
UNION ALL SELECT 'category_mappings (test:)',COUNT(*) FROM category_mappings WHERE notes LIKE 'test:%';
