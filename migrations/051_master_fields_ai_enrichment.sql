-- Migration 051: розширюємо master_fields додатковими метаданими для AI-mapping.
--
-- Колонки `description_uk` та `data_type` уже є з міграції 042. Додаємо нові:
--   * description_ai     — детальний опис ЩО саме це поле, в чому семантика, для AI prompt.
--                          Може бути довшим за description_uk (який для UI).
--   * example_values     — JSONB[]: 3-7 типових значень. AI порівнює зі sample у листі.
--   * applies_to         — JSONB[]: для якого product_kind поле релевантне.
--                          Порожній масив = relevant для всього. Наприклад:
--                            material_sole  → ["взуття"]
--                            toe_shape      → ["взуття"]
--                            material_inner → ["взуття","одяг"]
--   * cardinality        — TEXT: 'per_master' (1 значення на товар),
--                          'per_variant' (відрізняється між size/color варіантами),
--                          'per_master_multi' (один товар → масив значень, як photo).
--   * anti_examples      — JSONB[]: типові плутанини. Наприклад name_uk anti=
--                          [{"value":"Adidas","reason":"bare brand, not full name"}].
--   * format_hint        — TEXT: regex / pattern hint. Наприклад gtin → "^[0-9]{8,14}$",
--                          season_year → "^(19|20)\\d{2}$", price → "^\\d+([.,]\\d+)?$".
--
-- Усе nullable і non-breaking — старі queries працюють як раніше.

ALTER TABLE master_fields
  ADD COLUMN IF NOT EXISTS description_ai  TEXT,
  ADD COLUMN IF NOT EXISTS example_values  JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS applies_to      JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS cardinality     TEXT  NOT NULL DEFAULT 'per_master',
  ADD COLUMN IF NOT EXISTS anti_examples   JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS format_hint     TEXT;

-- ─────────────────────────────────────────────────────────────────────────
-- Seed enrichments для всіх 23 поточних master_fields.
-- (Ці значення критичні для AI-точності. Пишу їх настільки детально як можу.)
-- ─────────────────────────────────────────────────────────────────────────

UPDATE master_fields SET
  description_ai = 'Повна торгова назва товару українською. Має містити модель/тип + бренд + ключові ознаки. НЕ просто бренд і НЕ просто артикул. Приклади: "Кросівки Adidas Stan Smith White", "Куртка зимова Mountain Warehouse Seasons Padded", "Сумка Adidas Tiro Trolley".',
  example_values = '["Кросівки Adidas Stan Smith","Куртка зимова Mountain Seasons Padded","Сумка Adidas Tiro Trolley","Футболка Nike Sportswear","Шапка Puma Essentials"]'::jsonb,
  cardinality = 'per_master',
  anti_examples = '[{"value":"Adidas","reason":"bare brand — це brand, не name_uk"},{"value":"10101","reason":"це article, не name"},{"value":"Кросівки","reason":"тільки product_type — занадто generic"}]'::jsonb
 WHERE key = 'name_uk';

UPDATE master_fields SET
  description_ai = 'Виробник або торгова марка товару. Одне слово (або 2-3) — назва бренду без додаткових ознак. Якщо колонка має "Виробник", "Manufacturer", "Бренд", "Марка" — це сюди.',
  example_values = '["Adidas","Nike","Puma","Mountain Warehouse","Head","Reebok","New Balance"]'::jsonb,
  cardinality = 'per_master',
  anti_examples = '[{"value":"Кросівки Adidas Stan Smith","reason":"це повна назва, не бренд"},{"value":"Originals","reason":"це підлінія бренду, не сам бренд"}]'::jsonb
 WHERE key = 'brand';

UPDATE master_fields SET
  description_ai = 'Шлях категорії від кореня. Як правило з роздільником "/" або ">". Може бути 2-4 рівнів: "Чоловіки/Взуття/Кросівки", "Аксесуари/Сумки", "Жінкам > Одяг > Сукні". Якщо колонка одна string з категорійним шляхом — це сюди.',
  example_values = '["Чоловіки/Взуття/Кросівки","Жінки/Одяг/Сукні","Аксесуари/Сумки","Дитяче/Куртки","Спорт > Тенісні ракетки"]'::jsonb,
  cardinality = 'per_master'
 WHERE key = 'category_uk';

UPDATE master_fields SET
  description_ai = 'URL фотографії товару. Може бути одна або кілька (через ; \\n кому). Розпізнавати за URL-паттерном (https://...jpg/.png/.webp). Якщо постачальник має кілька photo-колонок (photo1, photo2, ...) — всі вони мапляться сюди (cardinality=per_master_multi).',
  example_values = '["https://europasport.com.ua/content/images/12/abc.jpg","https://cdn.shop.ua/p/123_main.png","https://example.com/photo.webp"]'::jsonb,
  cardinality = 'per_master_multi',
  format_hint = 'https?://.+\.(jpg|jpeg|png|webp|gif)(\?.*)?$',
  anti_examples = '[{"value":"abc.jpg","reason":"без http(s):// — це локальний шлях"},{"value":"123","reason":"тільки id, не URL"}]'::jsonb
 WHERE key = 'photo';

UPDATE master_fields SET
  description_ai = 'Повний HTML або текстовий опис товару — як на product page. Може бути в кілька абзаців, з характеристиками, особливостями, перевагами. Зазвичай це найдовша текстова колонка постачальника. НЕ плутати з коротким описом-тізером або з категорією.',
  example_values = '["Стильні кросівки з натуральної шкіри. Підошва EVA для амортизації. Зручні для щоденного носіння.","Куртка з мембраною водовідштовхувачем. Капюшон знімний. Підкладка флісова."]'::jsonb,
  cardinality = 'per_master'
 WHERE key = 'description_full_uk';

UPDATE master_fields SET
  description_ai = 'Стара/закреслена ціна (RRP, MSRP, "Цена до знижки"). Десяткове число. Якщо постачальник має 2 цінові колонки (стара + поточна) — поточна йде в `price` (base pricing), а стара сюди.',
  example_values = '["2899","4500.00","1290","890"]'::jsonb,
  format_hint = '^\\d+([.,]\\d+)?$',
  cardinality = 'per_master'
 WHERE key = 'old_price';

UPDATE master_fields SET
  description_ai = 'Верхня категорія товару — узагальнений вид. Майже завжди одне слово. Найчастіші значення: "Взуття", "Одяг", "Аксесуари", "Дитяче", "Спортивний інвентар".',
  example_values = '["Взуття","Одяг","Аксесуари","Спортивний інвентар","Дитяче"]'::jsonb,
  cardinality = 'per_master',
  anti_examples = '[{"value":"Кросівки","reason":"це product_type, не product_kind"},{"value":"Чоловіки/Взуття/Кросівки","reason":"це category_uk (шлях), не kind"}]'::jsonb
 WHERE key = 'product_kind';

UPDATE master_fields SET
  description_ai = 'Підтип у межах product_kind. Більш конкретно: "Кросівки", "Чоботи", "Футболки", "Куртки", "Сумки", "Кепки". Зазвичай одне слово в множині або іменник.',
  example_values = '["Кросівки","Чоботи","Футболки","Куртки","Сумки","Кепки","Ракетки тенісні"]'::jsonb,
  cardinality = 'per_master',
  anti_examples = '[{"value":"Adidas Stan Smith","reason":"це name/модель, не тип"},{"value":"Взуття","reason":"занадто загально — це product_kind"}]'::jsonb
 WHERE key = 'product_type';

UPDATE master_fields SET
  description_ai = 'Основний колір товару українською. Це master-level: 1 значення на товар. Якщо постачальник має варіанти різних кольорів — то це окремі товари, не варіанти розміру. Може бути 1 слово ("Чорний") або 2 (через дефіс/слеш: "Чорно-білий", "Синій/жовтий").',
  example_values = '["Чорний","Білий","Синій","Червоний","Сірий","Зелений","Чорно-білий","Бежевий"]'::jsonb,
  cardinality = 'per_master',
  anti_examples = '[{"value":"Black","reason":"в нашій системі укр; англ варіанти → mapping через color_mappings"}]'::jsonb
 WHERE key = 'color_uk';

UPDATE master_fields SET
  description_ai = 'Назва моделі (без бренду). Часто частина name_uk. Приклади: "Stan Smith", "Air Force 1", "Sportswear Club". Якщо колонка постачальника окремо містить тільки модель — сюди.',
  example_values = '["Stan Smith","Air Force 1","Sportswear","Tiro","Essentials","Boom"]'::jsonb,
  cardinality = 'per_master'
 WHERE key = 'model_name';

UPDATE master_fields SET
  description_ai = 'Стать: для кого товар. Дискретні значення: "Чоловіча", "Жіноча", "Дитяча", "Унісекс". Може бути також "Хлопчики"/"Дівчатка" для дитячого.',
  example_values = '["Чоловіча","Жіноча","Дитяча","Унісекс","Хлопчики","Дівчатка"]'::jsonb,
  cardinality = 'per_master',
  anti_examples = '[{"value":"Adidas","reason":"це бренд"}]'::jsonb
 WHERE key = 'gender';

UPDATE master_fields SET
  description_ai = 'Стиль одягу/взуття. "Спортивний", "Casual", "Класичний", "Урбан". Іноді поле є тільки в постачальників fashion-сегменту.',
  example_values = '["Спортивний","Casual","Класичний","Urban","Streetwear","Outdoor"]'::jsonb,
  cardinality = 'per_master'
 WHERE key = 'style';

UPDATE master_fields SET
  description_ai = 'ЗАГАЛЬНИЙ матеріал товару. Use коли постачальник має ОДНУ колонку "Матеріал" без розбивки на верх/середина/підошва. Якщо постачальник детальніше — преферуй material_top/inner/sole.',
  example_values = '["Шкіра","Бавовна","Поліестер","Замша","Текстиль","Синтетика","Гума"]'::jsonb,
  cardinality = 'per_master'
 WHERE key = 'material';

UPDATE master_fields SET
  description_ai = 'Матеріал ВЕРХНЬОЇ частини. Для взуття — верх над підошвою. Для куртки — зовнішня тканина. Якщо постачальник має поле "Матеріал верха" / "Upper material" — сюди.',
  example_values = '["Шкіра","Замша","Текстиль","Нейлон","Сітка","Синтетика","Велюр"]'::jsonb,
  applies_to = '["Взуття","Одяг"]'::jsonb,
  cardinality = 'per_master'
 WHERE key = 'material_top';

UPDATE master_fields SET
  description_ai = 'Матеріал ВНУТРІШНЬОЇ підкладки. Для взуття — устілки/підкладки. Для куртки — підкладка. "Lining material".',
  example_values = '["Текстиль","Шкіра","Сітка","Хутро","Фліс","Бавовна"]'::jsonb,
  applies_to = '["Взуття","Одяг"]'::jsonb,
  cardinality = 'per_master'
 WHERE key = 'material_inner';

UPDATE master_fields SET
  description_ai = 'Матеріал ПІДОШВИ. Тільки для взуття. "Sole material". Типові: TPR, EVA, Гума, ПУ, Поліуретан.',
  example_values = '["Гума","TPR","EVA","ПУ","Поліуретан","Термопластична гума"]'::jsonb,
  applies_to = '["Взуття"]'::jsonb,
  cardinality = 'per_master'
 WHERE key = 'material_sole';

UPDATE master_fields SET
  description_ai = 'Форма носка взуття: "Круглий", "Гострий", "Квадратний", "Заокруглений". Тільки для взуття.',
  example_values = '["Круглий","Гострий","Квадратний","Заокруглений","Мигдалевидний"]'::jsonb,
  applies_to = '["Взуття"]'::jsonb,
  cardinality = 'per_master'
 WHERE key = 'toe_shape';

UPDATE master_fields SET
  description_ai = 'Тип застібки: "Шнурки", "Липучка", "Блискавка", "Гачки", "Резинка". Для одягу: "Кнопки", "Ґудзики", "Блискавка". Для сумок: "Магніт", "Замок".',
  example_values = '["Шнурки","Липучка","Блискавка","Ґудзики","Резинка","Магніт","Гачки"]'::jsonb,
  cardinality = 'per_master'
 WHERE key = 'fastening';

UPDATE master_fields SET
  description_ai = 'Призначення / умови використання. "Для бігу", "Для футболу", "Повсякденне", "Для походів", "Офіс". Може бути 1-3 значення через кому.',
  example_values = '["Для бігу","Для футболу","Повсякденне","Для походів","Офіс","Спорт","Туризм"]'::jsonb,
  cardinality = 'per_master'
 WHERE key = 'purpose';

UPDATE master_fields SET
  description_ai = 'Сезон: "Зима", "Літо", "Весна", "Осінь", "Демісезон", "Всесезон". Зазвичай одне слово.',
  example_values = '["Зима","Літо","Весна","Осінь","Демісезон","Всесезон"]'::jsonb,
  cardinality = 'per_master',
  anti_examples = '[{"value":"2024","reason":"це season_year, не season"}]'::jsonb
 WHERE key = 'season';

UPDATE master_fields SET
  description_ai = 'Рік сезону колекції — 4 цифри. "2024", "2025". Може бути формат "2024 рік" або "FW24" (Fall-Winter 2024) — extract 4 digits.',
  example_values = '["2024","2025","2023","2026"]'::jsonb,
  format_hint = '^(19|20)\\d{2}$',
  cardinality = 'per_master',
  anti_examples = '[{"value":"Зима","reason":"це season, не рік"}]'::jsonb
 WHERE key = 'season_year';

UPDATE master_fields SET
  description_ai = 'Країна виробництва. Назва українською. "Україна", "Китай", "Італія", "Австрія", "Туреччина", "В''єтнам".',
  example_values = '["Україна","Китай","Італія","Австрія","Туреччина","Вʼєтнам","Польща","Німеччина"]'::jsonb,
  cardinality = 'per_master'
 WHERE key = 'country';

UPDATE master_fields SET
  description_ai = 'GTIN / EAN / UPC barcode — 8 до 14 цифр. Глобальний код товару. Зазвичай поле зветься "GTIN", "EAN", "Штрихкод", "Barcode".',
  example_values = '["4061626814545","8717185232783","0192406148913"]'::jsonb,
  format_hint = '^[0-9]{8,14}$',
  cardinality = 'per_master',
  anti_examples = '[{"value":"ABC-123","reason":"це article (SKU), не GTIN — GTIN тільки цифри"}]'::jsonb
 WHERE key = 'gtin';
