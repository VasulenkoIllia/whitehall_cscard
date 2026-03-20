export function normalizeSize(value: unknown): string | null {
  const str = String(value || '').trim();
  if (!str) return null;
  return str.includes(',') ? str.replace(/,/g, '.') : str;
}

export function normalizeNumeric(value: unknown): string {
  if (value === null || typeof value === 'undefined') {
    return '';
  }
  let str = String(value).trim();
  if (!str) {
    return '';
  }
  str = str.replace(/\u00A0/g, '').replace(/\s+/g, '');
  if (str.includes(',') && str.includes('.')) {
    str = str.replace(/,/g, '');
  } else if (str.includes(',') && !str.includes('.')) {
    str = str.replace(/,/g, '.');
  }
  str = str.replace(/[^0-9.-]/g, '');
  return str;
}

export function parseQuantity(rawValue: unknown): { value: number | null; reason: 'zero' | 'defaulted' | 'invalid' | null } {
  if (rawValue === 0 || rawValue === '0') {
    return { value: null, reason: 'zero' };
  }
  if (rawValue === '' || rawValue === null || typeof rawValue === 'undefined') {
    return { value: 1, reason: 'defaulted' };
  }
  const normalized = normalizeNumeric(rawValue);
  if (!normalized) {
    return { value: null, reason: 'invalid' };
  }
  const parsed = parseInt(normalized, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return { value: null, reason: 'invalid' };
  }
  return { value: parsed, reason: null };
}

export function parsePrice(rawValue: unknown): { value: number | null; reason: 'missing' | 'invalid' | null } {
  const normalized = normalizeNumeric(rawValue);
  if (!normalized) {
    return { value: null, reason: 'missing' };
  }
  const parsed = parseFloat(normalized);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return { value: null, reason: 'invalid' };
  }
  return { value: parsed, reason: null };
}

export function toFiniteNumber(value: unknown, fallback = 0): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

export function hasMeaningfulValue(value: unknown): boolean {
  if (value === null || typeof value === 'undefined') {
    return false;
  }
  if (typeof value === 'string') {
    return value.trim() !== '';
  }
  return true;
}

export function hasMappedColumnValues(mapping: Record<string, unknown> | null, rowValues: unknown[]): boolean {
  if (!mapping) {
    return false;
  }
  const fields = ['article', 'size', 'quantity', 'price', 'extra'] as const;
  return fields.some((field) => {
    const info = parseMappingEntry(mapping[field]);
    if (info.mode !== 'column' || !info.index) {
      return false;
    }
    return hasMeaningfulValue((rowValues as any)[info.index]);
  });
}

export function parseMappingEntry(entry: unknown): { mode: 'static' | 'column' | null; value?: unknown; index?: number | null } {
  if (entry && typeof entry === 'object') {
    const obj: any = entry;
    if (obj.type === 'static') {
      return { mode: 'static', value: obj.value ?? '' };
    }
    if (obj.type === 'column') {
      const index = Number(obj.index ?? obj.value);
      return { mode: 'column', index: Number.isFinite(index) ? index : null };
    }
    if (Number.isFinite(Number(obj.index))) {
      return { mode: 'column', index: Number(obj.index) };
    }
    if (typeof obj.value !== 'undefined') {
      return { mode: 'static', value: obj.value ?? '' };
    }
  }
  if (typeof entry === 'number' && Number.isFinite(entry)) {
    return { mode: 'column', index: entry };
  }
  if (typeof entry === 'string') {
    const trimmed = entry.trim();
    if (/^\d+$/.test(trimmed)) {
      return { mode: 'column', index: Number(trimmed) };
    }
    return { mode: 'static', value: trimmed };
  }
  return { mode: null };
}

export function resolveMappingValue(entry: unknown, rowValues: unknown[]): unknown {
  const info = parseMappingEntry(entry);
  if (info.mode === 'static') {
    return info.value;
  }
  if (info.mode === 'column' && info.index) {
    return (rowValues as any)[info.index];
  }
  return undefined;
}
