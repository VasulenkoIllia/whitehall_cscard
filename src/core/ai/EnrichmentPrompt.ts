/**
 * Universal prompt для AI enrichment master catalog запису.
 *
 * Inputs:
 *   - SKU
 *   - feed_params: {feed_name: {imported_at, feed_id, data: {...повний item з фіда...}}}
 *
 * Output (JSON):
 *   - 23 поля з reasoning + confidence per field
 *
 * Промпт описує:
 *   1. Контекст системи (e-comm каталог одягу/взуття).
 *   2. Які 23 поля треба заповнити з description + sample values + anti-examples.
 *   3. Як використовувати feed_params (1 або декілька фідів — обирати найкраще,
 *      preferring українську мову).
 *   4. Output schema.
 */

export interface MasterEnrichmentInput {
  sku: string;
  feedParams: Record<string, unknown> | null;
}

export interface EnrichedField {
  value: string | number | null;
  confidence: number; // 0..1
  source_feed?: string | null;
  source_field?: string | null;
  reasoning?: string;
}

export interface MasterEnrichmentResult {
  sku: string;
  fields: {
    name_uk?: EnrichedField;
    brand?: EnrichedField;
    category_uk?: EnrichedField;
    photo?: EnrichedField;
    description_full_uk?: EnrichedField;
    old_price?: EnrichedField;
    product_kind?: EnrichedField;
    product_type?: EnrichedField;
    color_uk?: EnrichedField;
    model_name?: EnrichedField;
    gender?: EnrichedField;
    style?: EnrichedField;
    material?: EnrichedField;
    material_top?: EnrichedField;
    material_inner?: EnrichedField;
    material_sole?: EnrichedField;
    toe_shape?: EnrichedField;
    fastening?: EnrichedField;
    purpose?: EnrichedField;
    season?: EnrichedField;
    season_year?: EnrichedField;
    country?: EnrichedField;
    gtin?: EnrichedField;
  };
  overall_confidence: number;
  warnings: string[];
}

export const ENRICHMENT_SYSTEM_PROMPT = `
Ти експерт-категоризатор товарів e-commerce магазину одягу/взуття/аксесуарів/спорттоварів.
Тобі дано SKU товару + сирі дані з 1 або декількох фідів магазинів (vendor data).
Твоя задача — заповнити канонічну картку товару (23 поля українською мовою) на основі цих даних.

КОНТЕКСТ:
* Це магазин в Україні. Усі тексти БАЖАНО українською.
* Якщо у фіді є дані російською — переклади/нормалізуй українською.
* Якщо у фіді є дані англійською (типу "Adidas Stan Smith") — лиши англійською для назви бренду
  + назви моделі, але опис українською.
* Якщо є кілька фідів з різними значеннями — обирай найбільш повне/якісне.
  Преферуй українську мову. У разі рівних даних — обирай довший/детальніший варіант.

23 ПОЛЯ КАТАЛОГУ:

1. name_uk (text) — Повна торгова назва українською. Має містити product_type + бренд + модель.
   ✓ "Кросівки Adidas Stan Smith White"
   ✓ "Куртка зимова Mountain Warehouse Seasons Padded"
   ✗ "Adidas" (тільки бренд)
   ✗ "10101" (артикул)

2. brand (text) — Бренд/виробник, 1-3 слова без додатків.
   ✓ "Adidas", "Nike", "Mountain Warehouse"
   ✗ "Adidas Originals Black Sneakers" (це name)

3. category_uk (text) — Шлях категорії через "/" або ">".
   ✓ "Чоловіки/Взуття/Кросівки", "Жінки > Одяг > Сукні"

4. photo (text) — URL фото. Якщо у фіді декілька — об'єднай через "; " (з пробілом після крапки з комою).
   ✓ "https://...jpg; https://...jpg"

5. description_full_uk (text) — Повний опис українською. Якщо у фіді є — нормалізуй українською,
   видали HTML-теги (можеш лишити <p>, <ul>, <li>, <strong> якщо вони були).

6. old_price (number) — Стара/закреслена ціна. Може бути null якщо немає.

7. product_kind (text) — Узагальнений вид одне слово.
   ✓ "Взуття", "Одяг", "Аксесуари", "Спортивний інвентар"

8. product_type (text) — Конкретний тип.
   ✓ "Кросівки", "Куртки", "Сумки", "Ракетки"

9. color_uk (text) — Основний колір українською.
   ✓ "Чорний", "Білий", "Чорно-білий"
   ✗ "Black" — нормалізуй українською

10. model_name (text) — Назва моделі без бренду.
    ✓ "Stan Smith", "Air Force 1"

11. gender (text) — "Чоловіча" / "Жіноча" / "Дитяча" / "Унісекс"

12. style (text) — "Спортивний" / "Casual" / "Класичний" / тощо

13. material (text) — Загальний матеріал (якщо немає розбивки на верх/підкладка/підошва).

14. material_top (text) — Матеріал ВЕРХУ (для взуття) або зовнішня тканина (для одягу).
    Релевантне для: Взуття, Одяг.

15. material_inner (text) — Матеріал підкладки (для взуття/одягу).
    Релевантне для: Взуття, Одяг.

16. material_sole (text) — Матеріал підошви. ТІЛЬКИ для взуття.

17. toe_shape (text) — Форма носка. ТІЛЬКИ для взуття.
    ✓ "Круглий", "Гострий", "Заокруглений"

18. fastening (text) — Тип застібки.
    ✓ "Шнурки", "Липучка", "Блискавка"

19. purpose (text) — Призначення.
    ✓ "Для бігу", "Повсякденне", "Для футболу"

20. season (text) — "Зима" / "Літо" / "Весна" / "Осінь" / "Демісезон" / "Всесезон"

21. season_year (text) — 4 цифри року. ✓ "2024", "2025"

22. country (text) — Країна виробництва українською. ✓ "Україна", "Китай", "Італія"

23. gtin (text) — GTIN/EAN/UPC barcode, 8-14 цифр. Може бути null якщо немає.

ПРАВИЛА:
* Якщо у feed_params НЕМАЄ даних для конкретного поля — поверни value: null + confidence: 0.
* НЕ ПРИДУМУЙ дані з повітря. Лише на основі того що у фідах.
* Якщо поле не релевантне для product_type (наприклад material_sole для куртки) — value: null.
* confidence калібруй чесно:
  - 0.95+ — точне copy з фіда + впевнений у нормалізації
  - 0.7-0.94 — є дані але треба інтерпретувати/перекласти
  - 0.4-0.7 — здогад на основі непрямих даних
  - <0.4 — невпевнений; краще null
* source_feed — назва фіда звідки взяв значення (один з ключів feed_params: "shopua", "europasport"...).
* source_field — назва поля у feed.data звідки взяв.
* reasoning — короткий коментар як ти вирішив (1-2 речення).
`;

export function buildEnrichmentUserMessage(input: MasterEnrichmentInput): string {
  const feedDataStr = input.feedParams
    ? JSON.stringify(input.feedParams, null, 2)
    : '(порожньо — у master_catalog ще немає feed_params)';

  return [
    `SKU: ${input.sku}`,
    '',
    '=== Дані з фідів (feed_params) ===',
    feedDataStr,
    '',
    '=== Очікуваний вихідний JSON ===',
    'Поверни ОДИН JSON виду:',
    JSON.stringify(buildExpectedOutputExample(input.sku), null, 2)
  ].join('\n');
}

// ─── Batch mode (multi-item у одному prompt) ─────────────────────────────────

export interface BatchEnrichmentItem {
  sku: string;
  feedParams: Record<string, unknown>;
}

export interface BatchEnrichmentResult {
  results: MasterEnrichmentResult[];
}

/**
 * Будує batch user message. Замість 1 SKU — масив SKU. AI має повернути results[]
 * у тій самій послідовності.
 *
 * Ефективність: system prompt відсилається 1 раз для N items, не N разів.
 * Економія ~50% input tokens на batch.
 */
export function buildBatchEnrichmentUserMessage(items: BatchEnrichmentItem[]): string {
  const itemsJson = items.map((it) => ({
    sku: it.sku,
    feed_params: it.feedParams
  }));

  return [
    `=== BATCH ENRICHMENT — ${items.length} товарів ===`,
    '',
    'Тобі дано масив товарів. Для КОЖНОГО поверни enrichment у тій самій послідовності.',
    '',
    '=== Items ===',
    JSON.stringify(itemsJson, null, 2),
    '',
    '=== Очікуваний вихідний JSON ===',
    'Поверни ОДИН JSON виду:',
    JSON.stringify(
      {
        results: [
          buildExpectedOutputExample('SKU_1'),
          buildExpectedOutputExample('SKU_2')
          // ... по одному обʼєкту на кожен item
        ]
      },
      null,
      2
    ),
    '',
    'ВАЖЛИВО: results.length має ТОЧНО дорівнювати кількості items вище. ',
    'Порядок results має співпадати з порядком items. sku у кожному result має співпадати з sku item.'
  ].join('\n');
}

function buildExpectedOutputExample(sku: string): unknown {
  return {
    sku,
    fields: {
      name_uk: {
        value: 'Кросівки Adidas Stan Smith White',
        confidence: 0.96,
        source_feed: 'shopua',
        source_field: 'name',
        reasoning: 'Назва нормалізована з shopua.data.name; містить product_type + brand + model.'
      },
      brand: {
        value: 'Adidas',
        confidence: 0.99,
        source_feed: 'shopua',
        source_field: 'vendor',
        reasoning: 'Точна копія з vendor field.'
      },
      material_sole: {
        value: null,
        confidence: 0,
        reasoning: 'Не релевантно — товар не взуття.'
      }
      // ... решта 20 полів аналогічно
    },
    overall_confidence: 0.85,
    warnings: ['old_price у фіді = 0 — підозра що це plug, лишаю null']
  };
}
