import type { Pool } from 'pg';
import type { ImportSummary, SourceImporter } from './contracts';
import { detectMappingFromRow, hasRequiredFields, normalizeHeader } from './mapping';
import {
  toFiniteNumber,
  parsePrice,
  parseQuantity,
  hasMappedColumnValues,
  normalizeSize,
  resolveMappingValue
} from './importerUtils';

interface MappingMeta {
  header_row?: number | null;
  headers?: Record<string, string>;
  sheet_name?: string;
  source_id?: number | null;
}

interface ImportContext {
  jobId: number;
  supplierId: number;
  sourceId: number | null;
  mapping: Record<string, unknown> | null;
  mappingMeta: MappingMeta | null;
}

export class ImporterDb implements SourceImporter {
  constructor(private readonly pool: Pool) {}

  async importAll(jobId: number): Promise<ImportSummary> {
    // TODO: orchestrate sources (requires sources/suppliers tables + mapping meta).
    return {
      importedSources: 0,
      importedRows: 0,
      skippedRows: 0,
      warnings: ['Import pipeline not yet ported']
    };
  }

  async insertRawBatch(rows: ImportBatchRow[]): Promise<InsertResult> {
    return insertRawBatch(this.pool, rows);
  }
}

export interface ImportBatchRow {
  jobId: number;
  supplierId: number;
  sourceId: number | null;
  article: string;
  size: string | null;
  quantity: number | null;
  price: number | null;
  priceWithMarkup: number | null;
  extra: string | null;
}

export interface InsertResult {
  imported: number;
  skipped: number;
}

export async function insertRawBatch(pool: Pool, rows: ImportBatchRow[]): Promise<InsertResult> {
  if (!rows.length) {
    return { imported: 0, skipped: 0 };
  }
  const values: (string | number | null)[] = [];
  const placeholders = rows.map((row, idx) => {
    const base = idx * 9;
    values.push(
      row.jobId,
      row.supplierId,
      row.sourceId,
      row.article,
      row.size,
      row.quantity,
      row.price,
      row.priceWithMarkup,
      row.extra
    );
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9})`;
  });

  await pool.query(
    `INSERT INTO products_raw
       (job_id, supplier_id, source_id, article, size, quantity, price, price_with_markup, extra)
     VALUES ${placeholders.join(',')}
     ON CONFLICT DO NOTHING`,
    values
  );
  return { imported: rows.length, skipped: 0 };
}
