/**
 * Universal master prompts для AI-mapping постачальницьких Google Sheets.
 *
 * Дві фази (два окремі API calls):
 *   1. TAB ANALYZER — на вхід метадані всіх tabs у файлі + sample 5-10 рядків з кожного.
 *      На вихід: для кожного tab — is_catalog? + product_type + confidence.
 *      Дешевий call, Haiku справляється.
 *
 *   2. MAPPING SUGGESTER — на вхід ОДИН tab: header sample + 15-20 рядків зі значеннями
 *      + повний catalog master_fields з описами + base 6 (article/size/qty/price/extra/comment).
 *      На вихід: header_row + first_data_row + mapping[field_key → col_index | static value]
 *      + warnings + unmapped_cols.
 *      Потужніший call, Sonnet справляється стабільніше.
 *
 * Промпти спроектовані щоб:
 *   * Зрозуміло пояснити архітектуру (товар = master + variants; mapping = column index → field).
 *   * Дати AI повний контекст полів з description/example_values/anti_examples/applies_to.
 *   * Включати few-shot приклади з реально готових постачальників (без них точність нижча).
 *   * Output strictly JSON — для парсингу.
 *   * Confidence calibration ROUND до 2-х знаків: 0.95+ = майже впевнений; 0.7-0.94 = напевно; 0.4-0.7 = сумнівно; <0.4 = здогад.
 */

import type { MasterFieldMeta } from './types';

// ─────────────────────────────────────────────────────────────────────────
// BASE 6 FIELDS — pricing pipeline (КРИТИЧНІ — без цього імпорт не працює)
// ─────────────────────────────────────────────────────────────────────────
export const BASE_FIELDS_DESCRIPTION = `
BASE FIELDS (критичні — pricing pipeline, без них імпорт не працює):

  article  (text)  — Артикул / SKU постачальника. Унікальний код товару. Зазвичай alphanumeric.
                     Examples: "MK-001", "HS9756", "ABC-123", "10101", "K00012-RED"
                     Anti: full product name; barcode (це gtin); category path

  size     (text)  — Розмір. Може бути число (42, 38.5), літера (S, M, L, XL), розмір_литера (44L),
                     розмірна сітка (UK 8 / US 9 / EU 42), габарити (80x42x38 СМ).
                     IMPORTANT: якщо колонки розміру немає (товар без розмірів — кепка, сумка) — null.
                     Examples: "42", "M", "44L", "UK 8 / EU 42", "80 X 42 X 38 СМ"

  quantity (number) — Наявна кількість на складі. ЦІЛЕ число.
                      WARNING: іноді постачальники мають дві колонки — "Наличие" (статус, текст
                      "В наявності"/"Под заказ") і "Количество" (числова). Якщо колонка містить
                      ТІЛЬКИ значення "0"/"" — це підозра що це псевдо-статус. Тоді запропонувати
                      type:"static" value:"1" (з warning) — НЕ мапити нульову колонку.
                      Якщо є справжня колонка "Залишок"/"Stock"/"К-сть" з числами 0-9999 — її.

  price    (number) — Поточна ціна (закупочна або базова для націнки). Десяткове число.
                      Examples: "1290", "2899.00", "890,50"
                      IMPORTANT: якщо є 2 цінові колонки (стара + поточна) — поточна сюди.
                      Стара йде в master field "old_price".

  extra    (text)  — Опційно. Додаткова службова мітка постачальника (без бізнес-значення).
                     Може лишатись null.

  comment  (text)  — Опційно. Коментар постачальника до товару. Зазвичай null.
`;

// ─────────────────────────────────────────────────────────────────────────
// TAB ANALYZER — фаза 1: визначити які tabs є каталогом продуктів
// ─────────────────────────────────────────────────────────────────────────

export const TAB_ANALYZER_SYSTEM_PROMPT = `
Ти аналізуєш Google Spreadsheet постачальника інтернет-магазину (одяг/взуття/аксесуари/спорттовари).
Файл містить кілька tabs. Твоя задача — для КОЖНОГО tab визначити чи це КАТАЛОГ ТОВАРІВ
(який треба імпортувати в систему), чи це службова інформація (контакти, розмірна сітка,
пустий tab, summary тощо).

Каталог товарів виглядає так:
  - Має заголовки колонок: Артикул/Назва/Бренд/Ціна/Розмір/Кількість тощо.
  - Має багато рядків даних (зазвичай 100+ рядків).
  - Кожен рядок — окремий товар (або варіант розміру).

НЕ каталог:
  - Tabs з заголовками "Контакти", "Розмірна сітка", "Прайс-лист" (summary), "Інструкція".
  - Tabs з малою кількістю рядків (< 20) і ширше ніж число.
  - Tabs з 1-2 колонками тільки.
  - Tabs з назвами "Архів", "Stop list", "Не вивантажувати".

Product type визначай за headers/sample:
  - "footwear" (взуття) — є колонки розмірів типу 36-46, EU/UK розміри, материал верха/підошви
  - "clothing" (одяг) — розміри XS-XXL, S/M/L
  - "accessories" (сумки, кепки) — або без розмірів, або габарити "80x42 см"
  - "sport_equipment" (ракетки, м'ячі) — модель/жорсткість
  - "mixed" — кілька product types в одному tab
  - "unknown" — не вдалось визначити з sample
`;

export function buildTabAnalyzerUserMessage(input: TabAnalyzerInput): string {
  const tabs = input.tabs
    .map((tab) => {
      const preview = formatRows(tab.preview, 10);
      return [
        `--- TAB "${tab.name}" (rows: ${tab.rowCount ?? 'unknown'}, cols: ${tab.columnCount ?? 'unknown'}) ---`,
        preview || '(empty)'
      ].join('\n');
    })
    .join('\n\n');

  return [
    `Файл: ${input.spreadsheetTitle || 'unnamed'}`,
    `Постачальник: ${input.supplierName}`,
    '',
    `=== Tabs у файлі (${input.tabs.length}) ===`,
    tabs,
    '',
    '=== Output ===',
    'Поверни JSON виду:',
    JSON.stringify(
      {
        tabs: [
          {
            name: 'Кросівки чоловіки',
            is_catalog: true,
            product_type: 'footwear',
            confidence: 0.99,
            reasoning: 'Headers містять Артикул, Бренд, Розмір; sample має реальні SKU та ціни'
          },
          {
            name: 'Розмірна сітка',
            is_catalog: false,
            product_type: null,
            confidence: 0.99,
            reasoning: 'Це довідник розмірів, не каталог товарів'
          }
        ]
      },
      null,
      2
    )
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────────────────
// MAPPING SUGGESTER — фаза 2: header_row + column → field mapping
// ─────────────────────────────────────────────────────────────────────────

export const MAPPING_SUGGESTER_SYSTEM_PROMPT = `
Ти зіставляєш колонки Google Sheet постачальника (одяг/взуття/аксесуари) до канонічних полів
нашого каталогу. Файл — TAB одного постачальника, де КОЖЕН рядок = один товар або варіант.

Архітектура нашої системи:
  - Постачальник присилає прайс у вигляді таблиці.
  - Кожна колонка — це одна "характеристика" товару.
  - Ми маємо БАЗОВІ 6 полів (article, size, quantity, price, extra, comment) — це pricing pipeline.
  - Ми маємо MASTER FIELDS — характеристики картки товару (назва, бренд, фото, опис, колір,
    матеріал, сезон, GTIN тощо). Кожен master field має семантичний опис нижче.
  - Один товар = master + кілька variants (різні розміри одного артикулу). Більшість MASTER FIELDS
    мають cardinality "per_master" (значення спільне для всіх розмірів), деякі — "per_variant"
    (відрізняється між розмірами, як size).

ЩО ТИ МАЄШ ЗРОБИТИ:

1. Знайти header_row (1-based номер рядка в листі де знаходяться заголовки колонок).
   Часто це НЕ рядок 1 (бо постачальники мають заголовок-таблицю, контакти, дату оновлення
   на перших рядках). Шукай рядок з короткими текстовими labels.

2. Знайти first_data_row (зазвичай header_row + 1, але іноді є додатковий "приклад" рядок).

3. Для КОЖНОЇ колонки вирішити куди вона мапиться:
   - target_field = ім'я поля з нашого каталогу (або null якщо колонка сміття)
   - target_type = "column" (значення береться з клітинки) АБО "static" (всі рядки = одне значення)
   - confidence 0-1 (0.95+ майже впевнений, 0.7+ напевно, <0.5 — сумніви)
   - reasoning коротко чому

4. Виявити warnings:
   - "collision": дві колонки мапилися б на одне поле — обрати кращу, друга в unmapped.
   - "static_suspect": колонка має ОДНЕ значення на всі рядки (наприклад "0" в Количество)
     — пропонувати static value + warning "перевірити чи це не псевдо-статус".
   - "split_needed": клітинка містить кілька значень ("Чорний, розмір L") — flag для людини.
   - "low_confidence": якщо хоч одне з base fields (article/size/price) має confidence < 0.85.

5. Невикористані колонки (unmapped_cols) — список з reasoning чому пропускається.

ПРАВИЛА:
  - article ОБОВ'ЯЗКОВО має бути замаплено (без цього неможливий імпорт). Якщо невпевнений —
    confidence низький + warning.
  - price ОБОВ'ЯЗКОВО (інакше pricing pipeline зламається).
  - quantity бажано (можна static "1" якщо немає).
  - size — опційно (товари без розмірів існують — кепки, сумки → null OK).
  - Якщо постачальник має кілька photo колонок (photo1, photo2, ...) — ВСІ замапити на "photo"
    (бо field cardinality=per_master_multi, система склеює через ";").
  - НЕ мапити колонки типу: внутрішній row counter ("№", "id_row"), timestamps,
    статус ("В наявності"/"Закінчився" — це не quantity), окремі URL які не фото
    (категорія URL, сторінка продавця).
  - Якщо колонка ідентифікує product_kind / product_type / category / season константою
    (напр. tab "Літо 2025" — всі рядки літо, рік 2025) — пропонуй static.
`;

export interface MappingSuggesterInput {
  supplierName: string;
  spreadsheetTitle?: string | null;
  tabName: string;
  /** Перші 20 рядків листа повністю. Кожен рядок — масив рядків з клітинок. */
  preview: string[][];
  masterFields: MasterFieldMeta[];
  /** Few-shot examples з готових постачальників. Може бути порожнім. */
  fewShotExamples?: FewShotExample[];
}

export interface FewShotExample {
  supplierName: string;
  headers: string[];
  sampleRow: string[];
  expectedMapping: Record<string, { type: 'column' | 'static'; col_index?: number; value?: string }>;
  headerRow: number;
}

export function buildMappingSuggesterUserMessage(input: MappingSuggesterInput): string {
  const fieldCatalog = formatMasterFieldsCatalog(input.masterFields);
  const preview = formatPreview(input.preview, 20);
  const fewShot = formatFewShot(input.fewShotExamples || []);

  return [
    `Постачальник: ${input.supplierName}`,
    `Файл: ${input.spreadsheetTitle || 'unnamed'}`,
    `Tab: "${input.tabName}"`,
    '',
    '=== BASE 6 FIELDS ===',
    BASE_FIELDS_DESCRIPTION.trim(),
    '',
    '=== MASTER FIELDS CATALOG (23 поля картки товару) ===',
    fieldCatalog,
    '',
    fewShot,
    '=== ПЕРШІ 20 РЯДКІВ TAB ===',
    'Формат: "Row N: [col0, col1, col2, ...]". Порожні клітинки = "".',
    preview,
    '',
    '=== OUTPUT FORMAT ===',
    'Поверни ОДИН JSON виду:',
    JSON.stringify(buildExpectedOutputExample(), null, 2)
  ].join('\n');
}

function formatMasterFieldsCatalog(fields: MasterFieldMeta[]): string {
  return fields
    .map((f) => {
      const parts: string[] = [];
      parts.push(`* ${f.key} (${f.dataType}, ${f.cardinality})`);
      parts.push(`  label: ${f.labelUk}`);
      if (f.descriptionAi) parts.push(`  description: ${f.descriptionAi}`);
      if (f.exampleValues && f.exampleValues.length > 0) {
        parts.push(`  examples: ${JSON.stringify(f.exampleValues.slice(0, 5))}`);
      }
      if (f.appliesTo && f.appliesTo.length > 0) {
        parts.push(`  applies_to: ${JSON.stringify(f.appliesTo)}`);
      }
      if (f.hintKeys && f.hintKeys.length > 0) {
        parts.push(`  hint_keys (header synonyms): ${JSON.stringify(f.hintKeys.slice(0, 10))}`);
      }
      if (f.formatHint) parts.push(`  format: ${f.formatHint}`);
      if (f.antiExamples && f.antiExamples.length > 0) {
        const items = f.antiExamples
          .slice(0, 3)
          .map((a) => `${JSON.stringify(a.value)} (${a.reason})`)
          .join('; ');
        parts.push(`  anti_examples: ${items}`);
      }
      return parts.join('\n');
    })
    .join('\n\n');
}

function formatPreview(preview: string[][], maxRows: number): string {
  const slice = preview.slice(0, maxRows);
  if (slice.length === 0) return '(empty)';
  return slice
    .map((row, idx) => {
      const cells = row.map((c) => truncate(String(c ?? ''), 80));
      return `Row ${idx + 1}: ${JSON.stringify(cells)}`;
    })
    .join('\n');
}

function formatRows(preview: string[][], maxRows: number): string {
  return formatPreview(preview, maxRows);
}

function formatFewShot(examples: FewShotExample[]): string {
  if (examples.length === 0) return '';
  const blocks = examples.map((ex, idx) => {
    const headers = ex.headers.map((h, i) => `col${i}="${h}"`).join(', ');
    const sample = ex.sampleRow.map((s, i) => `col${i}="${truncate(s, 40)}"`).join(', ');
    const mapping = JSON.stringify(ex.expectedMapping, null, 2);
    return [
      `--- Few-shot #${idx + 1}: ${ex.supplierName} ---`,
      `header_row: ${ex.headerRow}`,
      `headers: ${headers}`,
      `sample_row: ${sample}`,
      `expected_mapping:`,
      mapping
    ].join('\n');
  });
  return ['=== FEW-SHOT EXAMPLES (як треба) ===', ...blocks, ''].join('\n');
}

function buildExpectedOutputExample(): unknown {
  return {
    header_row: 5,
    first_data_row: 6,
    header_row_confidence: 0.98,
    header_row_reasoning:
      'Row 5 contains 32 short labels matching product schema; rows 1-4 are title/metadata.',
    mapping: {
      article: {
        type: 'column',
        col_index: 1,
        col_letter: 'B',
        header: 'Артикул',
        confidence: 0.99,
        reasoning: 'exact hint_keys match + values look like SKU codes',
        sample_values: ['MK-001', 'MK-002', 'HS9756']
      },
      name_uk: {
        type: 'column',
        col_index: 3,
        col_letter: 'D',
        header: 'Назва',
        confidence: 0.95,
        reasoning: 'довгі текстові значення з product names',
        sample_values: ['Кросівки Adidas Stan Smith', 'Куртка зимова']
      },
      quantity: {
        type: 'static',
        value: '1',
        confidence: 0.7,
        reasoning:
          'Колонка "Количество" має значення "0" у всіх 20 рядках — підозра на псевдо-статус. Краще static=1.'
      },
      photo: {
        type: 'columns',
        col_indexes: [10, 11, 12],
        col_letters: ['K', 'L', 'M'],
        headers: ['Фото 1', 'Фото 2', 'Фото 3'],
        confidence: 0.96,
        reasoning: '3 колонки з URL — мапимо всі (cardinality=per_master_multi)'
      }
    },
    warnings: [
      {
        type: 'static_suspect',
        field: 'quantity',
        col_index: 14,
        message: 'Колонка "Количество" завжди "0" — перевір чи це не псевдо-статус.'
      }
    ],
    unmapped_cols: [
      {
        col_index: 0,
        col_letter: 'A',
        header: '№',
        reasoning: 'Це row counter, не product field'
      }
    ]
  };
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

// ─────────────────────────────────────────────────────────────────────────
// Type re-export для зручності викликаючих модулів
// ─────────────────────────────────────────────────────────────────────────

export interface TabAnalyzerInput {
  supplierName: string;
  spreadsheetTitle?: string | null;
  tabs: Array<{
    name: string;
    rowCount: number | null;
    columnCount: number | null;
    preview: string[][];
  }>;
}
