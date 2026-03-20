export const DEFAULT_SYNONYMS = {
  article: ['артикул', 'sku', 'код', 'код товара', 'article'],
  size: ['розмір', 'размер', 'size'],
  quantity: ['кількість', 'количество', 'qty', 'quantity', 'остаток', 'залишок'],
  price: ['ціна', 'цена', 'price', 'дроп ціна', 'дроп цена', 'drop price'],
  extra: ['назва', 'name', 'title', 'товар']
};

export function normalizeHeader(value: unknown): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function detectMappingFromRow(headers: unknown[], synonyms = DEFAULT_SYNONYMS): Record<string, number> {
  const normalized = headers.map(normalizeHeader);
  const mapping: Record<string, number> = {};

  (Object.keys(synonyms) as Array<keyof typeof DEFAULT_SYNONYMS>).forEach((field) => {
    const candidates = synonyms[field].map(normalizeHeader);
    const index = normalized.findIndex((h) => candidates.includes(h));
    if (index !== -1) {
      mapping[field] = index + 1; // 1-based
    }
  });

  return mapping;
}

export function hasRequiredFields(mapping: Record<string, unknown>): boolean {
  const hasValue = (entry: unknown) => {
    if (!entry) return false;
    if (typeof entry === 'object' && (entry as any).type === 'static') {
      return (entry as any).value !== null && (entry as any).value !== undefined && String((entry as any).value).trim() !== '';
    }
    return Boolean(entry);
  };
  return Boolean(hasValue(mapping.article) && hasValue(mapping.price) && hasValue(mapping.quantity));
}
