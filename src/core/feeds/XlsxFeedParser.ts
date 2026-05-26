import * as XLSX from 'xlsx';
import type { FeedParser, FeedParseResult, FeedConfig, FeedItem } from './types';

/**
 * XlsxFeedParser — Excel 2007+ файли.
 *
 * Логіка:
 *   1. Відкриваємо книгу.
 *   2. Беремо sheet (опції: options.sheet_name; default — перший).
 *   3. Header row (опції: options.header_row, default 1) — це заголовки колонок.
 *   4. Для кожного наступного рядка створюємо обʼєкт { header: cellValue, ... }.
 *
 * SKU може бути:
 *   - Літера колонки: 'A', 'B', 'C', ... → беремо cell у тій колонці.
 *   - Ім'я колонки з header row: 'Артикул' → беремо cell у колонці що має такий header.
 *
 * Парсер повертає items з ключами = реальні header values.
 * Розпізнавання "по літері" робиться у FeedImportService під час витягу SKU.
 */
export class XlsxFeedParser implements FeedParser {
  readonly format = 'xlsx' as const;

  async parse(content: Buffer, config: FeedConfig): Promise<FeedParseResult> {
    const startedAt = Date.now();
    const opts = (config.options || {}) as { sheet_name?: string; header_row?: number };
    const headerRowNum = Math.max(1, Math.trunc(Number(opts.header_row) || 1));

    const workbook = XLSX.read(content, { type: 'buffer', cellDates: false, cellNF: false });
    const sheetName = opts.sheet_name || workbook.SheetNames[0];
    if (!sheetName || !workbook.Sheets[sheetName]) {
      throw new Error(`XLSX sheet "${opts.sheet_name || '<first>'}" not found`);
    }
    const sheet = workbook.Sheets[sheetName];

    // Конвертуємо у 2D array значень.
    const matrix: unknown[][] = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      raw: false,
      defval: null
    }) as unknown[][];

    if (matrix.length < headerRowNum + 1) {
      return { items: [], parseMs: Date.now() - startedAt };
    }

    const headers = matrix[headerRowNum - 1].map((h, idx) => {
      const s = h === null || typeof h === 'undefined' ? '' : String(h).trim();
      return s.length > 0 ? s : `col_${columnLetter(idx + 1)}`;
    });

    const items: FeedItem[] = [];
    for (let i = headerRowNum; i < matrix.length; i++) {
      const row = matrix[i];
      // Skip empty rows.
      if (!row || row.every((c) => c === null || c === '' || typeof c === 'undefined')) continue;

      const item: FeedItem = {};
      for (let j = 0; j < headers.length; j++) {
        const header = headers[j];
        const value = row[j];
        item[header] = value === null || typeof value === 'undefined' ? null : value;
        // Також додаємо доступ за літерою колонки — щоб sku_field міг бути "A", "B"...
        const letter = columnLetter(j + 1);
        item[`__col_${letter}`] = item[header];
      }
      items.push(item);
    }

    return { items, parseMs: Date.now() - startedAt };
  }
}

/** 1-based: 1 → 'A', 2 → 'B', 27 → 'AA' */
function columnLetter(index: number): string {
  let result = '';
  let value = Number(index);
  while (value > 0) {
    const mod = (value - 1) % 26;
    result = String.fromCharCode(65 + mod) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}
