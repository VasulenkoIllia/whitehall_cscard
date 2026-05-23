/**
 * Завантажує `master_fields` у форматі для AI prompts.
 */
import type { Pool } from 'pg';
import type { MasterFieldMeta } from './types';

export class MasterFieldRepository {
  constructor(private readonly pool: Pool) {}

  async listForAi(): Promise<MasterFieldMeta[]> {
    const res = await this.pool.query<{
      id: string;
      key: string;
      label_uk: string;
      data_type: string;
      is_required: boolean;
      sort_order: number;
      candidate_hint_keys: unknown;
      description_ai: string | null;
      example_values: unknown;
      applies_to: unknown;
      cardinality: string;
      anti_examples: unknown;
      format_hint: string | null;
    }>(
      `SELECT id, key, label_uk, data_type, is_required, sort_order,
              candidate_hint_keys, description_ai, example_values, applies_to,
              cardinality, anti_examples, format_hint
         FROM master_fields
        WHERE is_active = TRUE
        ORDER BY sort_order, id`
    );

    return res.rows.map((row) => ({
      id: Number(row.id),
      key: row.key,
      labelUk: row.label_uk,
      dataType: row.data_type,
      isRequired: row.is_required,
      sortOrder: row.sort_order,
      hintKeys: toStringArray(row.candidate_hint_keys),
      descriptionAi: row.description_ai,
      exampleValues: toStringArray(row.example_values),
      appliesTo: toStringArray(row.applies_to),
      cardinality: row.cardinality,
      antiExamples: toAntiExamples(row.anti_examples),
      formatHint: row.format_hint
    }));
  }
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((v) => typeof v === 'string') as string[];
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.filter((v) => typeof v === 'string') as string[];
    } catch {
      // ignore
    }
  }
  return [];
}

function toAntiExamples(value: unknown): Array<{ value: string; reason: string }> {
  let arr: unknown[] = [];
  if (Array.isArray(value)) arr = value;
  else if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) arr = parsed;
    } catch {
      // ignore
    }
  }
  return arr
    .filter((entry): entry is { value: string; reason?: string } =>
      typeof entry === 'object' && entry !== null && typeof (entry as { value: unknown }).value === 'string'
    )
    .map((entry) => ({
      value: entry.value,
      reason: typeof entry.reason === 'string' ? entry.reason : ''
    }));
}
