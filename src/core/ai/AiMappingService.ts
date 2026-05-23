/**
 * AiMappingService — high-level orchestrator.
 *
 * Об'єднує: SheetTabAnalyzer + MappingSuggester + read/approve workflow.
 * Викликається з HTTP routes.
 */

import type { Pool } from 'pg';
import type { SheetTabAnalyzerOutput } from './SheetTabAnalyzer';
import { SheetTabAnalyzer } from './SheetTabAnalyzer';
import type { MappingSuggesterOutput } from './MappingSuggester';
import { MappingSuggester } from './MappingSuggester';
import type { AnthropicClient } from './AnthropicClient';
import type { MappingSuggestionResult, MappingTarget } from './types';

export interface SupplierLite {
  id: number;
  name: string;
}

export interface ApprovePayload {
  /**
   * Фінальний (можливо відредагований людиною) mapping у форматі ідентичному до того,
   * що зберігається в column_mappings.mapping (key → { type, ... }).
   *
   * Цей формат уже існує в системі — див. parseMappingToFields / buildMappingFromFields.
   */
  finalMapping: Record<string, MappingTarget | { type: 'static'; value: string } | { type: 'column'; col_index: number }>;
  headerRow: number;
  /** Опційно — sourceId якщо створюється новий source */
  newSource?: {
    name: string;
    type: 'gsheet';
    config: Record<string, unknown>;
  };
  reviewNotes?: string;
}

export class AiMappingService {
  private readonly tabAnalyzer: SheetTabAnalyzer;
  private readonly mappingSuggester: MappingSuggester;

  constructor(
    private readonly pool: Pool,
    private readonly anthropic: AnthropicClient,
    env: Record<string, string | undefined>
  ) {
    this.tabAnalyzer = new SheetTabAnalyzer(pool, anthropic, env);
    this.mappingSuggester = new MappingSuggester(pool, anthropic, env);
  }

  isEnabled(): boolean {
    return this.anthropic.isEnabled();
  }

  /** Phase 1: який tab у файлі є каталогом. */
  async analyzeTabs(args: {
    supplierId: number;
    sheetUrl: string;
  }): Promise<SheetTabAnalyzerOutput> {
    const supplier = await this.getSupplier(args.supplierId);
    return this.tabAnalyzer.analyze({
      supplierId: supplier.id,
      supplierName: supplier.name,
      sheetUrl: args.sheetUrl
    });
  }

  /** Phase 2: запропонувати mapping для конкретного tab. */
  async suggestMapping(args: {
    supplierId: number;
    sheetUrl: string;
    tabName: string;
    sourceId?: number | null;
  }): Promise<MappingSuggesterOutput> {
    const supplier = await this.getSupplier(args.supplierId);
    return this.mappingSuggester.suggest({
      supplierId: supplier.id,
      supplierName: supplier.name,
      sheetUrl: args.sheetUrl,
      tabName: args.tabName,
      sourceId: args.sourceId ?? null
    });
  }

  /** Поточна pending пропозиція для (supplier_id, sourceId? OR tabName). */
  async getPendingSuggestion(args: {
    supplierId: number;
    sourceId?: number | null;
    tabName?: string;
  }): Promise<{
    id: number;
    headerRow: number | null;
    firstDataRow: number | null;
    headerRowConfidence: number;
    headerRowReasoning: string;
    mapping: Record<string, MappingTarget>;
    warnings: MappingSuggestionResult['warnings'];
    unmappedCols: MappingSuggestionResult['unmapped_cols'];
    modelVersion: string;
    createdAt: string;
  } | null> {
    const whereParts: string[] = [`supplier_id = $1`, `status = 'pending'`];
    const params: unknown[] = [args.supplierId];
    if (args.sourceId) {
      params.push(args.sourceId);
      whereParts.push(`source_id = $${params.length}`);
    } else if (args.tabName) {
      params.push(args.tabName);
      whereParts.push(`tab_name = $${params.length}`);
    }
    const res = await this.pool.query<{
      id: string;
      header_row: number | null;
      first_data_row: number | null;
      header_row_confidence: string | null;
      header_row_reasoning: string | null;
      proposed_mapping: unknown;
      warnings: unknown;
      unmapped_cols: unknown;
      model_version: string;
      created_at: string;
    }>(
      `SELECT id, header_row, first_data_row, header_row_confidence, header_row_reasoning,
              proposed_mapping, warnings, unmapped_cols, model_version, created_at
         FROM column_mapping_suggestions
        WHERE ${whereParts.join(' AND ')}
        ORDER BY id DESC LIMIT 1`,
      params
    );
    if (res.rowCount === 0) return null;
    const row = res.rows[0];
    return {
      id: Number(row.id),
      headerRow: row.header_row,
      firstDataRow: row.first_data_row,
      headerRowConfidence: row.header_row_confidence ? Number(row.header_row_confidence) : 0,
      headerRowReasoning: row.header_row_reasoning || '',
      mapping: parseJsonOrEmpty(row.proposed_mapping) as Record<string, MappingTarget>,
      warnings: parseJsonOrEmpty(row.warnings) as MappingSuggestionResult['warnings'],
      unmappedCols: parseJsonOrEmpty(row.unmapped_cols) as MappingSuggestionResult['unmapped_cols'],
      modelVersion: row.model_version,
      createdAt: row.created_at
    };
  }

  /**
   * Відмітити пропозицію статусом + опційно зберегти applied_mapping.
   * Фактичне записування у column_mappings — окремий шар (CatalogAdminService.saveMapping).
   */
  async markSuggestionReviewed(args: {
    suggestionId: number;
    status: 'approved' | 'rejected' | 'edited';
    appliedMapping?: Record<string, MappingTarget> | null;
    reviewerId?: string | null;
    notes?: string | null;
  }): Promise<void> {
    await this.pool.query(
      `UPDATE column_mapping_suggestions
          SET status         = $2,
              applied_mapping= $3::jsonb,
              reviewed_by    = $4,
              reviewed_at    = NOW(),
              review_notes   = $5
        WHERE id = $1`,
      [
        args.suggestionId,
        args.status,
        args.appliedMapping ? JSON.stringify(args.appliedMapping) : null,
        args.reviewerId ?? null,
        args.notes ?? null
      ]
    );
  }

  /** Список останніх AI-аналізів tabs для supplier (для UI). */
  async listTabAnalyses(args: {
    supplierId: number;
    limit?: number;
  }): Promise<
    Array<{
      id: number;
      spreadsheetId: string;
      sheetUrl: string;
      modelVersion: string;
      tabs: unknown;
      createdAt: string;
    }>
  > {
    const limit = Math.max(1, Math.min(args.limit || 5, 50));
    const res = await this.pool.query(
      `SELECT id, spreadsheet_id, sheet_url, model_version, tabs, created_at
         FROM sheet_tab_analyses
        WHERE supplier_id = $1
        ORDER BY id DESC LIMIT $2`,
      [args.supplierId, limit]
    );
    return res.rows.map((r) => ({
      id: Number(r.id),
      spreadsheetId: r.spreadsheet_id,
      sheetUrl: r.sheet_url,
      modelVersion: r.model_version,
      tabs: parseJsonOrEmpty(r.tabs),
      createdAt: r.created_at
    }));
  }

  private async getSupplier(supplierId: number): Promise<SupplierLite> {
    const res = await this.pool.query<{ id: number; name: string }>(
      `SELECT id, name FROM suppliers WHERE id = $1 LIMIT 1`,
      [supplierId]
    );
    if (res.rowCount === 0) {
      const err = new Error(`Постачальник #${supplierId} не знайдений`);
      (err as { status?: number }).status = 404;
      throw err;
    }
    return { id: Number(res.rows[0].id), name: res.rows[0].name };
  }
}

function parseJsonOrEmpty(value: unknown): unknown {
  if (value === null || typeof value === 'undefined') return null;
  if (typeof value === 'object') return value;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return null;
}
