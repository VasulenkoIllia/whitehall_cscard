/**
 * SheetTabAnalyzer — фаза 1 AI workflow.
 *
 * Дано: Google Sheet URL постачальника.
 * Робить:
 *   1. Listing всіх tabs у файлі через googleSheetsService.listSheetNames.
 *   2. Для кожного tab — тягне sample 10 рядків з top.
 *   3. Передає в Anthropic AI (Haiku 4.5 за замовч): для кожного tab — is_catalog? + product_type.
 *   4. Зберігає sheet_tab_analyses + повертає результат.
 */

import type { Pool } from 'pg';
import {
  getSheetInfo,
  getSheetRowChunk,
  listSheetNames,
  parseSheetId
} from '../pipeline/googleSheetsService';
import type { AnthropicClient } from './AnthropicClient';
import {
  TAB_ANALYZER_SYSTEM_PROMPT,
  buildTabAnalyzerUserMessage
} from './MappingPrompts';
import type { TabAnalysisResult } from './types';

export interface SheetTabAnalyzerOptions {
  /** Model для Anthropic. За замовч — env ANTHROPIC_MODEL_TAB_ANALYZER або 'claude-haiku-4-5'. */
  model?: string;
  /** Скільки рядків з кожного tab показати AI (за замовч 10). */
  previewRows?: number;
  /** Skip tabs з більше ніж N рядків від початку (для performance — за замовч без ліміту). */
  skipTabsLargerThan?: number | null;
}

export interface SheetTabAnalyzerInput {
  supplierId: number;
  supplierName: string;
  sheetUrl: string;
  options?: SheetTabAnalyzerOptions;
}

export interface SheetTabAnalyzerOutput {
  analysisId: number;
  spreadsheetId: string;
  spreadsheetTitle: string | null;
  modelVersion: string;
  result: TabAnalysisResult;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

export class SheetTabAnalyzer {
  constructor(
    private readonly pool: Pool,
    private readonly anthropic: AnthropicClient,
    private readonly env: Record<string, string | undefined>
  ) {}

  async analyze(input: SheetTabAnalyzerInput): Promise<SheetTabAnalyzerOutput> {
    if (!this.anthropic.isEnabled()) {
      throw new Error('Anthropic AI не сконфігурований (ANTHROPIC_API_KEY відсутній)');
    }

    const previewRows = input.options?.previewRows ?? 10;
    const model =
      input.options?.model ||
      this.env.ANTHROPIC_MODEL_TAB_ANALYZER ||
      'claude-haiku-4-5';

    const spreadsheetId = parseSheetId(input.sheetUrl);
    if (!spreadsheetId) throw new Error('Невірний Google Sheet URL');

    // 1. Listing tabs з metadata API.
    const tabNames = await listSheetNames(input.sheetUrl);
    if (tabNames.length === 0) {
      throw new Error('Файл не містить жодного tab');
    }

    // 2. Для кожного tab підтягуємо sample + row/col count.
    const tabsForPrompt: Array<{
      name: string;
      rowCount: number | null;
      columnCount: number | null;
      preview: string[][];
    }> = [];

    let spreadsheetTitle: string | null = null;

    for (const name of tabNames) {
      try {
        const info = await getSheetInfo(input.sheetUrl, name);
        if (!spreadsheetTitle && (info.sheets?.data as any)?.properties?.title) {
          // googleapis sheet object doesn't always have spreadsheet title easily
          spreadsheetTitle = null;
        }
        const sampleEnd = Math.min(previewRows, info.rowCount ?? previewRows);
        const preview =
          sampleEnd > 0
            ? await getSheetRowChunk(info.sheets, info.spreadsheetId, name, 1, sampleEnd)
            : [];
        tabsForPrompt.push({
          name,
          rowCount: info.rowCount,
          columnCount: info.columnCount,
          preview
        });
      } catch (err) {
        // Якщо конкретний tab недоступний (rare) — додаємо як empty, AI відмітить.
        tabsForPrompt.push({
          name,
          rowCount: null,
          columnCount: null,
          preview: []
        });
      }
    }

    // 3. Виклик AI.
    const userMessage = buildTabAnalyzerUserMessage({
      supplierName: input.supplierName,
      spreadsheetTitle,
      tabs: tabsForPrompt
    });

    const response = await this.anthropic.send<TabAnalysisResult>({
      model,
      systemPrompt: TAB_ANALYZER_SYSTEM_PROMPT,
      userMessage,
      jsonOutput: true,
      maxTokens: 2048,
      temperature: 0
    });

    // Light validation.
    if (!response.content || !Array.isArray(response.content.tabs)) {
      throw new Error('AI tab-analyzer повернув невалідну структуру (відсутнє tabs[])');
    }

    // 4. Збереження.
    const insertRes = await this.pool.query<{ id: number }>(
      `INSERT INTO sheet_tab_analyses
         (supplier_id, spreadsheet_id, sheet_url, model_version, tabs,
          raw_response, input_tokens, output_tokens, duration_ms)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9)
       RETURNING id`,
      [
        input.supplierId,
        spreadsheetId,
        input.sheetUrl,
        response.modelVersion,
        JSON.stringify(response.content.tabs),
        JSON.stringify(response.rawResponse),
        response.inputTokens,
        response.outputTokens,
        response.durationMs
      ]
    );

    return {
      analysisId: Number(insertRes.rows[0].id),
      spreadsheetId,
      spreadsheetTitle,
      modelVersion: response.modelVersion,
      result: response.content,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      durationMs: response.durationMs
    };
  }
}
