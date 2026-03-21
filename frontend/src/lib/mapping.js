const MAPPING_KEYS = ['article', 'size', 'quantity', 'price', 'extra'];

export function columnLetter(index) {
  let result = '';
  let value = Number(index);
  while (value > 0) {
    const mod = (value - 1) % 26;
    result = String.fromCharCode(65 + mod) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

export function normalizeMappingEntry(entry) {
  if (entry && typeof entry === 'object') {
    if (entry.type === 'static') {
      const value = entry.value ?? '';
      return { mode: 'static', value: String(value), allowEmpty: value === '' };
    }
    if (entry.type === 'column') {
      const index = Number(entry.index ?? entry.value);
      return { mode: 'column', value: Number.isFinite(index) ? index : null, allowEmpty: false };
    }
    if (Number.isFinite(Number(entry.index))) {
      return { mode: 'column', value: Number(entry.index), allowEmpty: false };
    }
    if (typeof entry.value !== 'undefined') {
      const value = entry.value ?? '';
      return { mode: 'static', value: String(value), allowEmpty: value === '' };
    }
  }
  if (typeof entry === 'number' && Number.isFinite(entry)) {
    return { mode: 'column', value: entry, allowEmpty: false };
  }
  if (typeof entry === 'string') {
    const trimmed = entry.trim();
    if (/^\d+$/.test(trimmed)) {
      return { mode: 'column', value: Number(trimmed), allowEmpty: false };
    }
    return { mode: 'static', value: trimmed, allowEmpty: trimmed === '' };
  }
  return { mode: 'column', value: null, allowEmpty: false };
}

export function createEmptyMappingFields() {
  return {
    article: { mode: 'column', value: null, allowEmpty: false },
    size: { mode: 'column', value: null, allowEmpty: false },
    quantity: { mode: 'column', value: null, allowEmpty: false },
    price: { mode: 'column', value: null, allowEmpty: false },
    extra: { mode: 'column', value: null, allowEmpty: false }
  };
}

function isMappingFieldSet(entry, options = {}) {
  if (!entry) {
    return false;
  }
  const allowEmpty = options.allowEmpty !== false;
  if (entry.mode === 'static') {
    if (entry.allowEmpty && allowEmpty) {
      return true;
    }
    return entry.value !== null && entry.value !== undefined && String(entry.value).trim() !== '';
  }
  return Number.isFinite(Number(entry.value)) && Number(entry.value) > 0;
}

export function parseMappingToFields(mapping) {
  const result = createEmptyMappingFields();
  if (!mapping || typeof mapping !== 'object') {
    return result;
  }
  for (let index = 0; index < MAPPING_KEYS.length; index += 1) {
    const key = MAPPING_KEYS[index];
    result[key] = normalizeMappingEntry(mapping[key]);
  }
  return result;
}

export function buildMappingFromFields(fields) {
  const payload = {};
  for (let index = 0; index < MAPPING_KEYS.length; index += 1) {
    const key = MAPPING_KEYS[index];
    const entry = fields?.[key];
    const allowEmpty = key === 'size';
    if (!isMappingFieldSet(entry, { allowEmpty })) {
      continue;
    }
    if (entry.mode === 'static') {
      payload[key] = { type: 'static', value: String(entry.value ?? '') };
      continue;
    }
    payload[key] = Number(entry.value);
  }
  return payload;
}
