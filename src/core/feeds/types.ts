/**
 * Generic типи для feed parser-ів.
 */

export type FeedFormat = 'yml' | 'xml' | 'xlsx';

export interface FeedConfig {
  id: number;
  name: string;
  url: string;
  format: FeedFormat;
  /** Назва поля що містить SKU. Конфігурується per-feed. */
  skuField: string;
  /** Довільні опції парсера. Див. конкретний парсер. */
  options: Record<string, unknown>;
}

/** Розпарсений запис з фіда — generic key/value мапа. */
export type FeedItem = Record<string, unknown>;

export interface FeedParseResult {
  items: FeedItem[];
  parseMs: number;
}

export interface FeedParser {
  /**
   * Тип формату який цей парсер підтримує.
   */
  readonly format: FeedFormat;

  /**
   * Парсить контент (Buffer для xlsx, string для xml/yml) у масив items.
   * Кожен item — flat record з полями. Для YML/XML параметри `<param name="X">Y</param>`
   * мап-ляться у `param_X: Y`.
   */
  parse(content: Buffer, config: FeedConfig): Promise<FeedParseResult>;
}

/**
 * Витяг SKU з item за config.sku_field. Підтримує:
 *   - простий ключ: 'vendorCode' → item['vendorCode']
 *   - dot-notation: 'product.code' → item.product.code
 *   - спец для XLSX: 'A', 'B', 'C'... літера колонки (handled у XlsxParser).
 *   - спец для YML: 'id' → витягується з offer attribute (handled у YmlParser).
 */
export function extractSku(item: FeedItem, skuField: string): string | null {
  if (!skuField) return null;
  const parts = skuField.split('.');
  let current: unknown = item;
  for (const p of parts) {
    if (current === null || typeof current !== 'object') return null;
    current = (current as Record<string, unknown>)[p];
  }
  if (current === null || typeof current === 'undefined') return null;
  const str = String(current).trim();
  return str.length > 0 ? str : null;
}
