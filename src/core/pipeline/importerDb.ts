import type { Pool } from 'pg';
import type {
  ImportSummary,
  SourceImportItem,
  SourceImportSummary,
  SourceImporter
} from './contracts';
import { detectMappingFromRow, hasRequiredFields, normalizeHeader } from './mapping';
import { getSheetInfo, getSheetRowChunk } from './googleSheetsService';
import { computePriceWithMarkup, type PricingContext } from './pricing';
import {
  toFiniteNumber,
  parsePrice,
  parseQuantity,
  hasMappedColumnValues,
  normalizeSize,
  resolveMappingValue,
  parseMappingEntry
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
  commentText: string | null;
  rowData: unknown[] | null;
}

export interface InsertResult {
  imported: number;
  skipped: number;
}

let ensuredProductsRawPartitionDate: string | null = null;

async function ensureProductsRawPartition(pool: Pool): Promise<void> {
  const functionResult = await pool.query<{ partitionDate: string | null; partitionFn: string | null }>(
    `SELECT
       CURRENT_DATE::text AS "partitionDate",
       to_regprocedure('ensure_products_raw_partition(date)')::text AS "partitionFn"`
  );
  const partitionDate = functionResult.rows[0]?.partitionDate || null;
  const partitionFn = functionResult.rows[0]?.partitionFn || null;

  if (!partitionFn) {
    return;
  }

  if (partitionDate && ensuredProductsRawPartitionDate === partitionDate) {
    return;
  }

  await pool.query('SELECT ensure_products_raw_partition(CURRENT_DATE)');
  ensuredProductsRawPartitionDate = partitionDate;
}

export async function insertRawBatch(pool: Pool, rows: ImportBatchRow[]): Promise<InsertResult> {
  if (!rows.length) {
    return { imported: 0, skipped: 0 };
  }

  await ensureProductsRawPartition(pool);

  const values: (string | number | null)[] = [];
  const placeholders = rows.map((row, idx) => {
    const base = idx * 11;
    values.push(
      row.jobId,
      row.supplierId,
      row.sourceId,
      row.article,
      row.size,
      row.quantity,
      row.price,
      row.priceWithMarkup,
      row.extra,
      row.commentText,
      JSON.stringify(row.rowData ?? null)
    );
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11})`;
  });

  await pool.query(
    `INSERT INTO products_raw
       (job_id, supplier_id, source_id, article, size, quantity, price, price_with_markup, extra, comment_text, row_data)
     VALUES ${placeholders.join(',')}
     ON CONFLICT DO NOTHING`,
    values
  );
  return { imported: rows.length, skipped: 0 };
}

async function ensureJobActive(pool: Pool, jobId: number): Promise<void> {
  if (!jobId) return;
  const result = await pool.query('SELECT status FROM jobs WHERE id = $1', [jobId]);
  const status = result.rows[0]?.status;
  if (status === 'canceled') {
    const err = new Error('Job canceled');
    (err as any).code = 'JOB_CANCELED';
    throw err;
  }
}

function buildMappingMeta(record: any): MappingMeta | null {
  if (!record) return null;
  const meta = record.mapping_meta ? { ...record.mapping_meta } : {};
  if (typeof record.source_id !== 'undefined') {
    meta.source_id = record.source_id;
  }
  if (typeof record.header_row !== 'undefined' && record.header_row !== null) {
    meta.header_row = record.header_row;
  }
  return Object.keys(meta).length ? meta : null;
}

async function loadSupplierPricingContext(pool: Pool, supplierId: number): Promise<PricingContext | null> {
  if (!supplierId) return null;
  const supplierResult = await pool.query(
    `SELECT
       s.id,
       s.markup_percent,
       s.min_profit_enabled,
       s.min_profit_amount,
       s.markup_rule_set_id,
       COALESCE(rs.is_active, FALSE) AS rule_set_active
     FROM suppliers s
     LEFT JOIN markup_rule_sets rs ON rs.id = s.markup_rule_set_id
     WHERE s.id = $1`,
    [supplierId]
  );

  const supplier = supplierResult.rows[0];
  if (!supplier) return null;

  const context: PricingContext = {
    markupPercent: toFiniteNumber(supplier.markup_percent, 0),
    minProfitEnabled: supplier.min_profit_enabled === true,
    minProfitAmount: toFiniteNumber(supplier.min_profit_amount, 0),
    ruleSetId: supplier.rule_set_active ? supplier.markup_rule_set_id : null,
    conditions: []
  };

  if (!context.ruleSetId) return context;

  const conditionsResult = await pool.query(
    `SELECT action_type, action_value, price_from, price_to
     FROM markup_rule_conditions
     WHERE rule_set_id = $1
       AND is_active = TRUE
     ORDER BY priority ASC, id ASC`,
    [context.ruleSetId]
  );

  context.conditions = conditionsResult.rows.map((row) => ({
    actionType: row.action_type,
    actionValue: toFiniteNumber(row.action_value, 0),
    priceFrom: toFiniteNumber(row.price_from, 0),
    priceTo:
      row.price_to === null || typeof row.price_to === 'undefined'
        ? null
        : toFiniteNumber(row.price_to, 0)
  }));

  return context;
}

type SkipReason =
  | 'empty_row'
  | 'missing_article'
  | 'zero_quantity'
  | 'invalid_quantity'
  | 'missing_price'
  | 'invalid_price';

interface SkipStats {
  [key: string]: number;
}

function recordSkip(stats: SkipStats, samples: Array<{ reason: string; row: number; meta?: any }>, reason: SkipReason, row: number, meta?: any) {
  stats[reason] = (stats[reason] || 0) + 1;
  if (samples.length < 20) {
    samples.push({ reason, row, meta });
  }
}

export interface ImportSourceParams {
  source: any;
  supplierId: number;
  jobId: number;
  mappingOverride: Record<string, unknown> | null;
  mappingMeta: MappingMeta | null;
}

export interface ImportResult {
  imported: number;
  skipped: number;
  mapping: Record<string, unknown> | null;
  error?: string | null;
}

interface SourceRowRecord {
  id: number;
  supplier_id: number;
  source_type: string | null;
  source_name?: string | null;
  name?: string | null;
  supplier_name?: string | null;
  [key: string]: unknown;
}

export class ImporterDb implements SourceImporter {
  constructor(
    private readonly pool: Pool,
    private readonly logService: { log: (jobId: number | null, level: 'info' | 'warning' | 'error', message: string, data?: unknown) => Promise<void> },
    private readonly priceAtImportEnabled: boolean
  ) {}

  private toSourceImportItem(
    source: SourceRowRecord,
    imported: number,
    skipped: number,
    error: string | null
  ): SourceImportItem {
    return {
      sourceId: Number(source.id || 0),
      sourceName: String(source.source_name || source.name || '').trim() || null,
      supplierId: Number(source.supplier_id || 0),
      supplierName: String(source.supplier_name || '').trim() || null,
      imported,
      skipped,
      error
    };
  }

  private toFlatImportSummary(summary: SourceImportSummary): ImportSummary {
    return {
      importedSources: summary.importedSources,
      importedRows: summary.importedRows,
      skippedRows: summary.skippedRows,
      warnings: summary.warnings
    };
  }

  private async loadLatestMapping(supplierId: number, sourceId: number): Promise<{
    mapping: Record<string, unknown> | null;
    mappingMeta: MappingMeta | null;
  }> {
    const mappingResult = await this.pool.query(
      `SELECT mapping, mapping_meta, header_row, source_id
       FROM column_mappings
       WHERE supplier_id = $1 AND source_id = $2
       ORDER BY id DESC LIMIT 1`,
      [supplierId, sourceId]
    );
    const record = mappingResult.rows[0];
    return {
      mapping: (record?.mapping || null) as Record<string, unknown> | null,
      mappingMeta: buildMappingMeta(record)
    };
  }

  private async importSourceWithSummary(
    jobId: number,
    source: SourceRowRecord
  ): Promise<{ item: SourceImportItem; warning: string | null }> {
    await ensureJobActive(this.pool, jobId);

    const sourceId = Number(source.id || 0);
    const supplierId = Number(source.supplier_id || 0);
    const sourceName = String(source.source_name || source.name || '').trim() || null;
    const supplierName = String(source.supplier_name || '').trim() || null;
    const sourceType = String(source.source_type || '').trim();

    const { mapping, mappingMeta } = await this.loadLatestMapping(supplierId, sourceId);

    if (sourceType !== 'google_sheet') {
      await this.logService.log(jobId, 'error', 'Unsupported source type', {
        sourceId,
        sourceType: source.source_type,
        sourceName,
        supplierName
      });
      return {
        item: this.toSourceImportItem(source, 0, 0, 'unsupported source type'),
        warning: `Source ${sourceId} unsupported type ${sourceType || 'unknown'}`
      };
    }

    try {
      const result = await this.importGoogleSheetSource({
        source,
        supplierId,
        jobId,
        mappingOverride: mapping,
        mappingMeta
      });

      const warning = result.error ? `Source ${sourceId} failed: ${result.error}` : null;
      return {
        item: this.toSourceImportItem(
          source,
          Number(result.imported || 0),
          Number(result.skipped || 0),
          result.error ? String(result.error) : null
        ),
        warning
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.logService.log(jobId, 'error', 'Import source failed', {
        sourceId,
        sourceName,
        supplierName,
        error: msg
      });
      return {
        item: this.toSourceImportItem(source, 0, 0, msg),
        warning: `Source ${sourceId} failed: ${msg}`
      };
    }
  }

  private async importSelectedSources(
    jobId: number,
    sources: SourceRowRecord[],
    messages: { started: string; finished: string },
    startData?: Record<string, unknown>
  ): Promise<SourceImportSummary> {
    await this.logService.log(jobId, 'info', messages.started, startData);

    let importedRows = 0;
    let skippedRows = 0;
    const warnings: string[] = [];
    const sourceItems: SourceImportItem[] = [];

    for (let index = 0; index < sources.length; index += 1) {
      const source = sources[index];
      const { item, warning } = await this.importSourceWithSummary(jobId, source);
      sourceItems.push(item);
      importedRows += item.imported;
      skippedRows += item.skipped;
      if (warning) {
        warnings.push(warning);
      }
    }

    const summary: SourceImportSummary = {
      importedSources: sources.length,
      importedRows,
      skippedRows,
      warnings,
      sources: sourceItems
    };

    await this.logService.log(jobId, 'info', messages.finished, summary);
    return summary;
  }

  async importAll(jobId: number): Promise<ImportSummary> {
    const sourcesResult = await this.pool.query<SourceRowRecord>(
      `SELECT s.*, sp.id AS supplier_id, sp.name AS supplier_name, s.name AS source_name
       FROM sources s
       JOIN suppliers sp ON sp.id = s.supplier_id
       WHERE s.is_active = TRUE AND sp.is_active = TRUE
       ORDER BY s.id ASC`
    );
    const summary = await this.importSelectedSources(jobId, sourcesResult.rows, {
      started: 'Import all sources started',
      finished: 'Import all sources finished'
    });
    return this.toFlatImportSummary(summary);
  }

  async importSource(jobId: number, sourceId: number): Promise<SourceImportSummary> {
    const normalizedSourceId = Math.trunc(Number(sourceId));
    if (!Number.isFinite(normalizedSourceId) || normalizedSourceId <= 0) {
      const error = new Error('sourceId must be a positive number');
      (error as any).status = 400;
      throw error;
    }

    const sourceResult = await this.pool.query<SourceRowRecord>(
      `SELECT s.*, sp.id AS supplier_id, sp.name AS supplier_name, s.name AS source_name
       FROM sources s
       JOIN suppliers sp ON sp.id = s.supplier_id
       WHERE s.id = $1
         AND s.is_active = TRUE
         AND sp.is_active = TRUE
       LIMIT 1`,
      [normalizedSourceId]
    );
    const source = sourceResult.rows[0];
    if (!source) {
      const error = new Error(`source ${normalizedSourceId} not found`);
      (error as any).status = 404;
      throw error;
    }

    return this.importSelectedSources(
      jobId,
      [source],
      {
        started: 'Import source started',
        finished: 'Import source finished'
      },
      {
        sourceId: normalizedSourceId,
        sourceName: String(source.source_name || source.name || '').trim() || null,
        supplierId: Number(source.supplier_id || 0),
        supplierName: String(source.supplier_name || '').trim() || null
      }
    );
  }

  async importSupplier(jobId: number, supplierId: number): Promise<SourceImportSummary> {
    const normalizedSupplierId = Math.trunc(Number(supplierId));
    if (!Number.isFinite(normalizedSupplierId) || normalizedSupplierId <= 0) {
      const error = new Error('supplierId must be a positive number');
      (error as any).status = 400;
      throw error;
    }

    const sourcesResult = await this.pool.query<SourceRowRecord>(
      `SELECT s.*, sp.id AS supplier_id, sp.name AS supplier_name, s.name AS source_name
       FROM sources s
       JOIN suppliers sp ON sp.id = s.supplier_id
       WHERE s.is_active = TRUE
         AND sp.is_active = TRUE
         AND sp.id = $1
       ORDER BY s.id ASC`,
      [normalizedSupplierId]
    );

    return this.importSelectedSources(
      jobId,
      sourcesResult.rows,
      {
        started: 'Import supplier started',
        finished: 'Import supplier finished'
      },
      { supplierId: normalizedSupplierId }
    );
  }

  async insertRawBatch(rows: ImportBatchRow[]): Promise<InsertResult> {
    return insertRawBatch(this.pool, rows);
  }

  private async importGoogleSheetSource(params: ImportSourceParams): Promise<ImportResult> {
    const { source, supplierId, jobId, mappingOverride, mappingMeta } = params;
    await ensureJobActive(this.pool, jobId);

    const logContext = {
      sourceId: source.id,
      sourceName: source.name || source.source_name || null,
      supplierName: source.supplier_name || null
    };

    const sheetName = mappingMeta?.sheet_name || source.sheet_name;
    let sheetInfo;
    try {
      sheetInfo = await getSheetInfo(source.source_url, sheetName);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.logService.log(jobId, 'error', 'Google sheet load failed', {
        ...logContext,
        sheetName,
        error: msg
      });
      return { imported: 0, skipped: 0, mapping: null, error: msg };
    }

    const { sheets, spreadsheetId, sheetName: targetSheetName, rowCount, columnCount } = sheetInfo;

    let mapping = mappingOverride || null;
    let headerRowIndex: number | null = null;
    let imported = 0;
    let skipped = 0;
    const batch: ImportBatchRow[] = [];
    const skipStats: SkipStats = {};
    const skipSamples: Array<{ reason: string; row: number; meta?: any }> = [];
    const pricingContext = this.priceAtImportEnabled
      ? await loadSupplierPricingContext(this.pool, supplierId)
      : null;

    const maxHeaderScan = 20;
    const chunkSizeRaw = Number(process.env.GOOGLE_SHEETS_CHUNK_SIZE || 10000);
    const chunkSize = Number.isFinite(chunkSizeRaw) ? Math.max(1000, chunkSizeRaw) : 10000;

    const rowValuesFromChunks = async (
      startRow: number,
      endRow: number
    ): Promise<string[][]> => getSheetRowChunk(sheets, spreadsheetId, targetSheetName, startRow, endRow);

    if (mapping) {
      if (mappingMeta?.source_id && Number(mappingMeta.source_id) !== Number(source.id)) {
        const error = 'Mapping source mismatch. Please remap columns.';
        await this.logService.log(jobId, 'error', 'Mapping source mismatch', {
          ...logContext,
          mappingSourceId: mappingMeta.source_id
        });
        return { imported: 0, skipped: 0, mapping, error };
      }

      const headerRowRaw = mappingMeta?.header_row;
      const headerRowValue =
        headerRowRaw === null || typeof headerRowRaw === 'undefined' ? 1 : Number(headerRowRaw);
      const hasHeader = Number.isFinite(headerRowValue) && headerRowValue > 0;
      const requiredFields = ['article', 'quantity', 'price'];
      const errors: string[] = [];

      if (hasHeader) {
        if (rowCount && headerRowValue > rowCount) {
          const error = 'Header row out of range. Please remap columns.';
          await this.logService.log(jobId, 'error', 'Header row out of range', {
            ...logContext,
            headerRow: headerRowValue
          });
          return { imported: 0, skipped: 0, mapping, error };
        }
        const headerRows = await rowValuesFromChunks(headerRowValue, headerRowValue);
        const headerRow = headerRows[0] || null;
        if (!headerRow) {
          const error = 'Header row not found. Please remap columns.';
          await this.logService.log(jobId, 'error', 'Header row not found', {
            ...logContext,
            headerRow: headerRowValue
          });
          return { imported: 0, skipped: 0, mapping, error };
        }

        const expectedHeaders = mappingMeta?.headers || {};
        const maxColumns =
          Number.isFinite(Number(columnCount)) && Number(columnCount) > 0
            ? Number(columnCount)
            : headerRow.length;
        requiredFields.forEach((field) => {
          const info = parseMappingEntry((mapping as any)[field]);
          if (info.mode === 'static') {
            if (!info.value && info.value !== 0) {
              errors.push(`Missing static value for ${field}`);
            }
            return;
          }
          const index = info.index;
          if (!index) {
            errors.push(`Missing mapping for ${field}`);
            return;
          }
          if (maxColumns && index > maxColumns) {
            errors.push(`Column index out of range for ${field}`);
            return;
          }
          const expected = (expectedHeaders as any)[field];
          const actual = headerRow[index - 1];
          if (expected && normalizeHeader(expected) !== normalizeHeader(actual)) {
            errors.push(`Header mismatch for ${field}: expected "${expected}" got "${actual ?? ''}"`);
          }
        });

        Object.keys(expectedHeaders || {}).forEach((field) => {
          if (requiredFields.includes(field)) return;
          const info = parseMappingEntry((mapping as any)[field]);
          if (info.mode === 'static') return;
          const index = info.index;
          if (!index || (maxColumns && index > maxColumns)) {
            errors.push(`Column index out of range for ${field}`);
            return;
          }
          const expected = (expectedHeaders as any)[field];
          const actual = headerRow[index - 1];
          if (expected && normalizeHeader(expected) !== normalizeHeader(actual)) {
            errors.push(`Header mismatch for ${field}: expected "${expected}" got "${actual ?? ''}"`);
          }
        });

        headerRowIndex = headerRowValue;
      }

      if (errors.length) {
        const error = 'Mapping validation failed. Please remap columns.';
        await this.logService.log(jobId, 'error', 'Mapping validation failed', {
          ...logContext,
          errors
        });
        return { imported: 0, skipped: 0, mapping, error };
      }
    }

    if (!mapping) {
      const scanEnd = rowCount ? Math.min(Math.max(maxHeaderScan, 1), rowCount) : maxHeaderScan;
      const scanRows = await rowValuesFromChunks(1, scanEnd);
      if (!scanRows.length) {
        await this.logService.log(jobId, 'error', 'Google sheet is empty', { ...logContext });
        return { imported: 0, skipped: 0, mapping: null, error: 'sheet is empty' };
      }
      for (let i = 0; i < scanRows.length; i += 1) {
        const candidateMapping = detectMappingFromRow(scanRows[i]);
        if (hasRequiredFields(candidateMapping)) {
          mapping = candidateMapping;
          headerRowIndex = i + 1;
          await this.logService.log(jobId, 'info', 'Header detected (Google Sheets)', {
            ...logContext,
            headerRow: headerRowIndex,
            mapping
          });
          break;
        }
      }
      if (!mapping) {
        await this.logService.log(jobId, 'error', 'Header not detected (Google Sheets)', {
          ...logContext
        });
        return { imported: 0, skipped: 0, mapping: null, error: 'header not detected' };
      }
    }

    if (rowCount === 0) {
      await this.logService.log(jobId, 'error', 'Google sheet is empty', { ...logContext });
      return { imported: 0, skipped: 0, mapping, error: 'sheet is empty' };
    }

    let startRow = 1;
    let hasData = false;
    let logLoaded = false;

    while (true) {
      await ensureJobActive(this.pool, jobId);
      if (rowCount && startRow > rowCount) break;
      const endRow = rowCount
        ? Math.min(startRow + chunkSize - 1, rowCount)
        : startRow + chunkSize - 1;
      const rows = await rowValuesFromChunks(startRow, endRow);
      if (!rows.length) break;
      hasData = true;
      if (!logLoaded) {
        logLoaded = true;
        await this.logService.log(jobId, 'info', 'Google sheet loaded', {
          ...logContext,
          sheetName: targetSheetName
        });
      }

      if (!mapping) {
        break;
      }
      const activeMapping = mapping as Record<string, unknown>;

      for (let i = 0; i < rows.length; i += 1) {
        const rowNumber = startRow + i;
        if (headerRowIndex && rowNumber === headerRowIndex) {
          continue;
        }
        const rowValues = [null, ...rows[i]];
        if (!hasMappedColumnValues(activeMapping as any, rowValues)) {
          recordSkip(skipStats, skipSamples, 'empty_row', rowNumber);
          skipped += 1;
          continue;
        }

        const articleValue = resolveMappingValue(activeMapping.article, rowValues);
        const article = String(articleValue || '').trim();
        if (!article) {
          recordSkip(skipStats, skipSamples, 'missing_article', rowNumber);
          skipped += 1;
          continue;
        }

        const rawQuantity = resolveMappingValue(activeMapping.quantity, rowValues);
        const quantityInfo = parseQuantity(rawQuantity);
        if (quantityInfo.value === null) {
          recordSkip(
            skipStats,
            skipSamples,
            quantityInfo.reason === 'zero' ? 'zero_quantity' : 'invalid_quantity',
            rowNumber,
            { article }
          );
          skipped += 1;
          continue;
        }

        const rawPrice = resolveMappingValue(activeMapping.price, rowValues);
        const priceInfo = parsePrice(rawPrice);
        if (!priceInfo.value) {
          recordSkip(
            skipStats,
            skipSamples,
            priceInfo.reason === 'missing' ? 'missing_price' : 'invalid_price',
            rowNumber,
            { article }
          );
          skipped += 1;
          continue;
        }

        const sizeValue = resolveMappingValue(activeMapping.size, rowValues);
        const extraValue = resolveMappingValue(activeMapping.extra, rowValues);
        const commentValue = resolveMappingValue(activeMapping.comment, rowValues);
        const size = sizeValue ? normalizeSize(sizeValue) : null;
        const extra = extraValue ? String(extraValue || '').trim() : '';
        const commentText = commentValue ? String(commentValue || '').trim() : '';

        batch.push({
          jobId,
          supplierId,
          sourceId: source.id || null,
          article,
          size,
          quantity: quantityInfo.value,
          price: priceInfo.value,
          priceWithMarkup: this.priceAtImportEnabled
            ? computePriceWithMarkup(priceInfo.value, pricingContext)
            : null,
          extra,
          commentText: commentText || null,
          rowData: rows[i]
        });

        if (batch.length >= 500) {
          const chunk = batch.splice(0, batch.length);
          await insertRawBatch(this.pool, chunk);
          imported += chunk.length;
        }
      }

      startRow += chunkSize;
    }

    if (!hasData) {
      await this.logService.log(jobId, 'error', 'Google sheet is empty', {
        sourceId: source.id
      });
      return { imported: 0, skipped, mapping, error: 'sheet is empty' };
    }

    if (batch.length) {
      const chunk = batch.splice(0, batch.length);
      await insertRawBatch(this.pool, chunk);
      imported += chunk.length;
    }

    if (skipped > 0) {
      await this.logService.log(jobId, 'warning', 'Import skipped rows', {
        sourceId: source.id,
        skippedTotal: skipped,
        skipStats,
        samples: skipSamples
      });
    }

    return { imported, skipped, mapping };
  }
}
