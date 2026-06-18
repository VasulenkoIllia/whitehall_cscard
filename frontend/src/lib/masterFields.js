// 23 атрибутні поля master_catalog у порядку каталогу. Спільні для таблиці,
// drill-in і будь-яких інших місць, що показують картку товару.
export const MASTER_FIELDS = [
  { key: 'name_uk', label: 'Назва (UA)', dataType: 'text' },
  { key: 'brand', label: 'Бренд', dataType: 'text' },
  { key: 'category_uk', label: 'Категорія', dataType: 'text' },
  { key: 'photo', label: 'Фото', dataType: 'long_text' },
  { key: 'description_full_uk', label: 'Опис', dataType: 'long_text' },
  { key: 'old_price', label: 'Стара ціна', dataType: 'number' },
  { key: 'product_kind', label: 'Вид товару', dataType: 'text' },
  { key: 'product_type', label: 'Тип', dataType: 'text' },
  { key: 'color_uk', label: 'Колір (UA)', dataType: 'text' },
  { key: 'model_name', label: 'Модель', dataType: 'text' },
  { key: 'gender', label: 'Стать', dataType: 'text' },
  { key: 'style', label: 'Стиль', dataType: 'text' },
  { key: 'material', label: 'Матеріал', dataType: 'text' },
  { key: 'material_top', label: 'Матеріал верху', dataType: 'text' },
  { key: 'material_inner', label: 'Матеріал всередині', dataType: 'text' },
  { key: 'material_sole', label: 'Матеріал підошви', dataType: 'text' },
  { key: 'toe_shape', label: 'Вид носка', dataType: 'text' },
  { key: 'fastening', label: 'Застібка', dataType: 'text' },
  { key: 'purpose', label: 'Призначення', dataType: 'text' },
  { key: 'season', label: 'Сезон', dataType: 'text' },
  { key: 'season_year', label: 'Сезон за роками', dataType: 'text' },
  { key: 'country', label: 'Країна', dataType: 'text' },
  { key: 'gtin', label: 'GTIN barcode', dataType: 'text' }
];

export const TOTAL_FIELDS = MASTER_FIELDS.length;
