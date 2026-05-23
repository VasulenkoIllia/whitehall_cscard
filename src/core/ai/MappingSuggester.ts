/**
 * MappingSuggester — фаза 2 AI workflow.
 *
 * Дано: sheet URL + tab name + supplier + source (опційно).
 * Робить:
 *   1. Підтягує перші 20 рядків tab'у через googleSheetsService.
 *   2. Завантажує master_fields catalog з БД.
 *   3. Передає в Anthropic AI (Sonnet 4.5 за замовч) з повним contextом:
 *      base 6 + 23 master fields + 20 sample rows + few-shot examples.
 *   4. Валідує відповідь (header_row число, mapping обов'язково має article+price).
 *   5. Зберігає column_mapping_suggestions з status='pending'.
 *
 * Few-shot examples беруться з env.MAPPING_FEW_SHOT (JSON) або з готових мапінгів
 * (FUTURE — fetch з column_mappings де status='approved').
 */

import type { Pool } from 'pg';
import {
  getSheetInfo,
  getSheetRowChunk,
  parseSheetId
} from '../pipeline/googleSheetsService';
import type { AnthropicClient } from './AnthropicClient';
import { MasterFieldRepository } from './MasterFieldRepository';
import {
  MAPPING_SUGGESTER_SYSTEM_PROMPT,
  buildMappingSuggesterUserMessage,
  type FewShotExample
} from './MappingPrompts';
import type { MappingSuggestionResult } from './types';

export interface MappingSuggesterOptions {
  model?: string;
  previewRows?: number;
  fewShotExamples?: FewShotExample[];
}

export interface MappingSuggesterInput {
  supplierId: number;
  supplierName: string;
  sheetUrl: string;
  tabName: string;
  /** Якщо source вже створений у БД (для повторного suggest) — id. */
  sourceId?: number | null;
  options?: MappingSuggesterOptions;
}

export interface MappingSuggesterOutput {
  suggestionId: number;
  modelVersion: string;
  result: MappingSuggestionResult;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  warnings: MappingSuggestionResult['warnings'];
}

export class MappingSuggester {
  private readonly masterFieldRepo: MasterFieldRepository;

  constructor(
    private readonly pool: Pool,
    private readonly anthropic: AnthropicClient,
    private readonly env: Record<string, string | undefined>
  ) {
    this.masterFieldRepo = new MasterFieldRepository(pool);
  }

  async suggest(input: MappingSuggesterInput): Promise<MappingSuggesterOutput> {
    if (!this.anthropic.isEnabled()) {
      throw new Error('Anthropic AI не сконфігурований (ANTHROPIC_API_KEY відсутній)');
    }

    const spreadsheetId = parseSheetId(input.sheetUrl);
    if (!spreadsheetId) throw new Error('Невірний Google Sheet URL');

    const previewRows = input.options?.previewRows ?? 20;
    const model =
      input.options?.model ||
      this.env.ANTHROPIC_MODEL_MAPPING ||
      'claude-sonnet-4-5';

    // 1. Підтягуємо перші 20 рядків tab.
    const info = await getSheetInfo(input.sheetUrl, input.tabName);
    const endRow = Math.min(previewRows, info.rowCount ?? previewRows);
    const preview =
      endRow > 0
        ? await getSheetRowChunk(info.sheets, info.spreadsheetId, input.tabName, 1, endRow)
        : [];

    if (preview.length === 0) {
      throw new Error(`Tab "${input.tabName}" порожній`);
    }

    // 2. Завантажуємо master_fields catalog.
    const masterFields = await this.masterFieldRepo.listForAi();

    // 3. Few-shot examples з env (опційно).
    const fewShot =
      input.options?.fewShotExamples || this.loadFewShotFromEnv() || [];

    // 4. Виклик AI.
    const userMessage = buildMappingSuggesterUserMessage({
      supplierName: input.supplierName,
      spreadsheetTitle: null,
      tabName: input.tabName,
      preview,
      masterFields,
      fewShotExamples: fewShot
    });

    const response = await this.anthropic.send<MappingSuggestionResult>({
      model,
      systemPrompt: MAPPING_SUGGESTER_SYSTEM_PROMPT,
      userMessage,
      jsonOutput: true,
      maxTokens: 6144,
      temperature: 0
    });

    const validated = validateSuggestion(response.content);

    // 5. Зберігаємо як pending.
    const insertRes = await this.pool.query<{ id: number }>(
      `INSERT INTO column_mapping_suggestions
         (supplier_id, source_id, sheet_url, tab_name, model_version,
          header_row, first_data_row, header_row_confidence, header_row_reasoning,
          proposed_mapping, warnings, unmapped_cols,
          raw_response, input_tokens, output_tokens, duration_ms, status)
       VALUES ($1, $2, $3, $4, $5,
               $6, $7, $8, $9,
               $10::jsonb, $11::jsonb, $12::jsonb,
               $13::jsonb, $14, $15, $16, 'pending')
       RETURNING id`,
      [
        input.supplierId,
        input.sourceId ?? null,
        input.sheetUrl,
        input.tabName,
        response.modelVersion,
        validated.header_row,
        validated.first_data_row,
        validated.header_row_confidence,
        validated.header_row_reasoning,
        JSON.stringify(validated.mapping),
        JSON.stringify(validated.warnings),
        JSON.stringify(validated.unmapped_cols),
        JSON.stringify(response.rawResponse),
        response.inputTokens,
        response.outputTokens,
        response.durationMs
      ]
    );

    return {
      suggestionId: Number(insertRes.rows[0].id),
      modelVersion: response.modelVersion,
      result: validated,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      durationMs: response.durationMs,
      warnings: validated.warnings
    };
  }

  private loadFewShotFromEnv(): FewShotExample[] | null {
    const raw = this.env.MAPPING_FEW_SHOT;
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed as FewShotExample[];
    } catch {
      // ignore — invalid env config shouldn't crash
    }
    return null;
  }
}

function validateSuggestion(value: unknown): MappingSuggestionResult {
  if (typeof value !== 'object' || value === null) {
    throw new Error('AI mapping suggester повернув не-обʼєкт');
  }
  const obj = value as Partial<MappingSuggestionResult>;
  const headerRow = typeof obj.header_row === 'number' ? obj.header_row : null;
  const firstDataRow = typeof obj.first_data_row === 'number' ? obj.first_data_row : null;
  const confidence =
    typeof obj.header_row_confidence === 'number' ? obj.header_row_confidence : 0;
  const reasoning = typeof obj.header_row_reasoning === 'string' ? obj.header_row_reasoning : '';

  const mapping =
    obj.mapping && typeof obj.mapping === 'object' ? (obj.mapping as MappingSuggestionResult['mapping']) : {};

  const warnings = Array.isArray(obj.warnings)
    ? (obj.warnings as MappingSuggestionResult['warnings'])
    : [];

  const unmapped = Array.isArray(obj.unmapped_cols)
    ? (obj.unmapped_cols as MappingSuggestionResult['unmapped_cols'])
    : [];

  // Sanity: article + price бажано бути замаплені. Якщо ні — warning.
  const synthWarnings: MappingSuggestionResult['warnings'] = [];
  if (!mapping.article) {
    synthWarnings.push({
      type: 'missing_required',
      field: 'article',
      message: 'AI не зміг знайти колонку article — обов\'язково треба замапити вручну'
    });
  }
  if (!mapping.price) {
    synthWarnings.push({
      type: 'missing_required',
      field: 'price',
      message: 'AI не зміг знайти колонку price — обов\'язково треба замапити вручну'
    });
  }

  return {
    header_row: headerRow,
    first_data_row: firstDataRow,
    header_row_confidence: confidence,
    header_row_reasoning: reasoning,
    mapping,
    warnings: [...warnings, ...synthWarnings],
    unmapped_cols: unmapped
  };
}
