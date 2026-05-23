-- Migration 045: rebalance master_fields seed під реальну Excel-схему користувача.
--
-- 24 канонічні поля у порядку колонок Excel (без supplier-level article/size/price/quantity,
-- які лишаються в окремому шарі column_mappings). Це поля КАРТКИ ТОВАРУ (master-level).
--
-- Стратегія:
--   1. DROP unused із попереднього seed (name_en, mpn, description_short_uk, meta_*, slug)
--      — їх немає у Excel-схемі.
--   2. UPSERT 24 master_fields у правильному sort_order.

DELETE FROM master_fields
 WHERE key IN ('name_en','mpn','description_short_uk','meta_title','meta_description','slug');

-- 1–24 поля у порядку Excel.
INSERT INTO master_fields (key, label_uk, description_uk, data_type, is_required, sort_order, candidate_hint_keys, candidate_cs_fields)
VALUES
  ('parent_code', 'Колекція+модель (батьківський)',
    'Внутрішній код моделі/колекції. Формується системою (або заповнюється вручну/AI). Не вмикайте в supplier mapping — це наш код, не постачальницький.',
    'text', false, 5, '[]'::jsonb, '[]'::jsonb),

  ('name_uk', 'Назва (UA)',
    'Назва товару українською — основна назва картки',
    'text', true, 10,
    '["Назва","назва","Назва Футболки","Найменування","Название (UA)","Название","Назва товару"]'::jsonb,
    '["product"]'::jsonb),

  ('brand', 'Бренд',
    'Бренд / виробник',
    'text', true, 20,
    '["бренд","Бренд","brand","Brand","виробник","Виробник","Производитель","Manufacturer"]'::jsonb,
    '[]'::jsonb),

  ('category_uk', 'Категорія',
    'Path-категорія типу "Чоловікам/Футболки", "Жінкам/Сукні"',
    'text', false, 30,
    '["категорія","Категорія","категория","Розділ","Section"]'::jsonb,
    '[]'::jsonb),

  ('photo', 'Фото',
    'URL фотографії товару (одна або через кому)',
    'long_text', false, 40,
    '["фото","Фото","photo","Photo","image","Image","зображення","img","picture","Картинка"]'::jsonb,
    '[]'::jsonb),

  ('description_full_uk', 'Опис',
    'Повний HTML/текст опису для картки товару',
    'long_text', false, 50,
    '["опис","Опис","description","Description","Full description","Текст"]'::jsonb,
    '["full_description"]'::jsonb),

  ('old_price', 'Стара ціна',
    'Закреслена/попередня ціна для відображення знижки',
    'number', false, 60,
    '["стара ціна","Стара ціна","old_price","old price","закреслена ціна","перекреслена ціна","RRP"]'::jsonb,
    '[]'::jsonb),

  ('product_kind', 'Вид товару',
    'Верхня категорія: Взуття / Одяг / Аксесуари тощо',
    'text', false, 70,
    '["вид товару","Вид товару","Тип товару","Категорія товару","Класифікація","Group","group"]'::jsonb,
    '[]'::jsonb),

  ('product_type', 'Тип',
    'Підтип у межах виду: Кросівки / Футболки / Куртки / Сукні',
    'text', false, 80,
    '["тип","Тип","subtype","Subtype","SubCategory","Підтип","Підкатегорія"]'::jsonb,
    '[]'::jsonb),

  ('color_uk', 'Колір (UA)',
    'Основний колір товару українською. Це master-level поле (1 значення на товар), а не variant axis.',
    'text', false, 90,
    '["колір","Колір","цвет","Цвет","color","Color","Colour"]'::jsonb,
    '[]'::jsonb),

  ('model_name', 'Модель',
    'Назва моделі: "Nike Air Force", "Adidas Stan Smith"',
    'text', false, 100,
    '["модель","Модель","model","Model","Назва моделі","Model name","Найменування моделі"]'::jsonb,
    '[]'::jsonb),

  ('gender', 'Стать',
    'Чоловіча / Жіноча / Унісекс / Дитяча',
    'text', false, 110,
    '["стать","Стать","пол","gender","Gender","Sex"]'::jsonb,
    '[]'::jsonb),

  ('style', 'Стиль',
    'Кежуал / Спортивний / Класичний / Вечірній',
    'text', false, 120,
    '["стиль","Стиль","style","Style","Fashion style"]'::jsonb,
    '[]'::jsonb),

  ('material', 'Матеріал',
    'Основний матеріал товару (для одягу — головна тканина)',
    'text', false, 130,
    '["матеріал","Матеріал","материал","Материал","material","Material","Склад","Composition"]'::jsonb,
    '[]'::jsonb),

  ('material_top', 'Матеріал верху',
    'Для взуття/одягу — основний верхній матеріал',
    'text', false, 140,
    '["матеріал верху","Матеріал верху","material top","upper material","Верх","material_upper","Upper"]'::jsonb,
    '[]'::jsonb),

  ('material_inner', 'Матеріал всередині',
    'Підкладка / внутрішня частина',
    'text', false, 145,
    '["матеріал всередині","Матеріал всередині","Підкладка","lining","inner material","material_inner"]'::jsonb,
    '[]'::jsonb),

  ('material_sole', 'Матеріал підошви',
    'Матеріал підошви взуття',
    'text', false, 150,
    '["матеріал підошви","Матеріал підошви","Підошва","sole","sole material","material_sole"]'::jsonb,
    '[]'::jsonb),

  ('toe_shape', 'Вид носка',
    'Круглий / Гострий / Квадратний (для взуття)',
    'text', false, 155,
    '["вид носка","Вид носка","toe","Носок","tip","Toe shape"]'::jsonb,
    '[]'::jsonb),

  ('fastening', 'Застібка',
    'Шнурівка / Липучка / Блискавка / Магніт / Кнопка',
    'text', false, 160,
    '["застібка","Застібка","fastening","fastener","Тип застібки","Lacing","Lace"]'::jsonb,
    '[]'::jsonb),

  ('purpose', 'Призначення',
    'Повсякденне / Спортивне / Святкове / Для роботи',
    'text', false, 165,
    '["призначення","Призначення","purpose","Use","Usage","Application"]'::jsonb,
    '[]'::jsonb),

  ('season', 'Сезон',
    'Літо / Зима / Демісезон / Універсальний',
    'text', false, 170,
    '["сезон","Сезон","season","Season"]'::jsonb,
    '[]'::jsonb),

  ('season_year', 'Сезон за роками',
    'Конкретний сезон/рік: 2025, FW24, SS25',
    'text', false, 175,
    '["сезон рік","Сезон за роками","season year","collection year","рік випуску","year","Год"]'::jsonb,
    '[]'::jsonb),

  ('country', 'Країна',
    'Країна виробництва',
    'text', false, 180,
    '["країна","Країна","страна","country","Country","made_in","Country of origin"]'::jsonb,
    '[]'::jsonb),

  ('gtin', 'GTIN barcode',
    'Штрихкод GTIN / EAN-13 / UPC',
    'text', false, 190,
    '["gtin","GTIN","barcode","штрихкод","Штрихкод","ean","EAN","EAN-13","UPC"]'::jsonb,
    '[]'::jsonb)

ON CONFLICT (key) DO UPDATE SET
  label_uk            = EXCLUDED.label_uk,
  description_uk      = EXCLUDED.description_uk,
  data_type           = EXCLUDED.data_type,
  is_required         = EXCLUDED.is_required,
  sort_order          = EXCLUDED.sort_order,
  candidate_hint_keys = EXCLUDED.candidate_hint_keys,
  candidate_cs_fields = EXCLUDED.candidate_cs_fields,
  is_active           = true,
  updated_at          = NOW();
