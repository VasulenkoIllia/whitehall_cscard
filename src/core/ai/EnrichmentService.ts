import type { Pool } from 'pg';
import type { LogService } from '../pipeline/log';
import type { AnthropicClient } from './AnthropicClient';
import {
  ENRICHMENT_SYSTEM_PROMPT,
  buildEnrichmentUserMessage,
  type MasterEnrichmentResult,
  type EnrichedField
} from './EnrichmentPrompt';
import { MASTER_CATALOG_FIELDS } from '../master_catalog/MasterCatalogService';

/**
 * EnrichmentService — отримує SKU + feed_params з master_catalog →
 * відправляє в Anthropic → пише 23 поля назад у master_catalog.
 *
 * Усього 1 виклик на 1 SKU. Confidence threshold: пишемо тільки поля з value !== null.
 * Поля з confidence < threshold (default 0.4) пропускаємо.
 */

export interface EnrichOptions {
  /** Мінімальна впевненість щоб писати у БД. Default 0.4. */
  confidenceThreshold?: number;
  /** Якщо true — переписуємо існуючі значення. Default false (лишаємо те що було). */
  overwriteExisting?: boolean;
  /** Модель. Default з env ANTHROPIC_MODEL_ENRICHMENT або 'claude-sonnet-4-5'. */
  model?: string;
}

export interface EnrichResult {
  sku: string;
  masterId: number;
  fieldsWritten: number;
  fieldsSkipped: number;
  modelVersion: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  warnings: string[];
  rawResponse: MasterEnrichmentResult;
}

/**
 * Фільтрує feed_params, видаляючи з .data ключі що у excludedByFeed[feed_name].
 * Структура feed_params: { feed_name: { imported_at, feed_id, data: {...} } }
 */
function filterFeedParams(
  feedParams: Record<string, unknown>,
  excludedByFeed: Record<string, Set<string>>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [feedName, feedEntry] of Object.entries(feedParams)) {
    const excluded = excludedByFeed[feedName] || new Set<string>();
    if (excluded.size === 0 || !feedEntry || typeof feedEntry !== 'object') {
      out[feedName] = feedEntry;
      continue;
    }
    const entry = feedEntry as Record<string, unknown>;
    const data = entry.data;
    if (!data || typeof data !== 'object') {
      out[feedName] = entry;
      continue;
    }
    const filteredData: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      if (!excluded.has(k)) filteredData[k] = v;
    }
    out[feedName] = { ...entry, data: filteredData };
  }
  return out;
}

export class EnrichmentService {
  constructor(
    private readonly pool: Pool,
    private readonly anthropic: AnthropicClient,
    private readonly logs: LogService,
    private readonly env: Record<string, string | undefined>
  ) {}

  isEnabled(): boolean {
    return this.anthropic.isEnabled();
  }

  async enrichMaster(masterId: number, options: EnrichOptions = {}): Promise<EnrichResult> {
    if (!this.anthropic.isEnabled()) {
      const err = new Error('Anthropic AI не сконфігурований (ANTHROPIC_API_KEY відсутній)');
      (err as { status?: number }).status = 501;
      throw err;
    }

    // 1. Read master_catalog row.
    const masterRes = await this.pool.query<{
      id: number;
      sku: string;
      feed_params: Record<string, unknown> | null;
      [k: string]: unknown;
    }>(`SELECT * FROM master_catalog WHERE id = $1`, [masterId]);
    if (masterRes.rowCount === 0) {
      const err = new Error(`Master #${masterId} не знайдено`);
      (err as { status?: number }).status = 404;
      throw err;
    }
    const master = masterRes.rows[0];

    if (!master.feed_params || Object.keys(master.feed_params).length === 0) {
      const err = new Error(
        `Master #${masterId} (sku=${master.sku}) не має feed_params — імпортуй фіди спершу`
      );
      (err as { status?: number }).status = 422;
      throw err;
    }

    const threshold = options.confidenceThreshold ?? 0.4;
    const overwrite = options.overwriteExisting ?? false;
    const model = options.model || this.env.ANTHROPIC_MODEL_ENRICHMENT || 'claude-sonnet-4-5';

    // 1.5. Загрузити налаштування фідів — нам треба знати які поля виключити
    //      з кожного feed_params.<feed_name>.data перед відправкою в AI.
    //      Зменшує токени значно (наприклад description у shopua = ~1-3K tokens).
    const feedsRes = await this.pool.query<{ name: string; options: { excluded_fields?: unknown } | null }>(
      `SELECT name, options FROM feeds`
    );
    const excludedByFeed: Record<string, Set<string>> = {};
    for (const row of feedsRes.rows) {
      const excluded = Array.isArray(row.options?.excluded_fields)
        ? (row.options!.excluded_fields as unknown[])
            .filter((x): x is string => typeof x === 'string')
            .map((x) => x.trim())
            .filter((x) => x.length > 0)
        : [];
      excludedByFeed[row.name] = new Set(excluded);
    }
    const filteredFeedParams = filterFeedParams(master.feed_params, excludedByFeed);

    // 2. Call AI.
    const response = await this.anthropic.send<MasterEnrichmentResult>({
      model,
      systemPrompt: ENRICHMENT_SYSTEM_PROMPT,
      userMessage: buildEnrichmentUserMessage({
        sku: master.sku,
        feedParams: filteredFeedParams
      }),
      jsonOutput: true,
      maxTokens: 4096,
      temperature: 0
    });

    const result = response.content;
    if (!result || typeof result !== 'object' || !result.fields) {
      throw new Error('AI повернув невалідну структуру (немає fields)');
    }

    // 3. Build UPDATE — пишемо тільки поля що пройшли threshold + не порожні.
    const updates: Record<string, string | number | null> = {};
    let fieldsWritten = 0;
    let fieldsSkipped = 0;

    for (const field of MASTER_CATALOG_FIELDS) {
      const entry = result.fields[field] as EnrichedField | undefined;
      if (!entry || entry.value === null || typeof entry.value === 'undefined') {
        fieldsSkipped++;
        continue;
      }
      const conf = typeof entry.confidence === 'number' ? entry.confidence : 0;
      if (conf < threshold) {
        fieldsSkipped++;
        continue;
      }
      // Перевірити чи overwrite.
      if (!overwrite && master[field] !== null && master[field] !== '' && master[field] !== undefined) {
        fieldsSkipped++;
        continue;
      }
      updates[field] = entry.value;
      fieldsWritten++;
    }

    if (fieldsWritten > 0) {
      const setParts: string[] = [];
      const params: unknown[] = [masterId];
      let idx = 2;
      for (const [key, value] of Object.entries(updates)) {
        setParts.push(`${key} = $${idx}`);
        params.push(value);
        idx++;
      }
      const sql = `
        UPDATE master_catalog
           SET ${setParts.join(', ')},
               ai_enriched_at = NOW(),
               ai_model = $${idx},
               ai_prompt_version = $${idx + 1},
               updated_at = NOW()
         WHERE id = $1
      `;
      params.push(response.modelVersion);
      params.push('v1');
      await this.pool.query(sql, params);
    } else {
      // Все одно позначити що пробували AI (щоб не крутити повторно).
      await this.pool.query(
        `UPDATE master_catalog
            SET ai_enriched_at = NOW(),
                ai_model = $2,
                ai_prompt_version = $3,
                updated_at = NOW()
          WHERE id = $1`,
        [masterId, response.modelVersion, 'v1']
      );
    }

    return {
      sku: master.sku,
      masterId,
      fieldsWritten,
      fieldsSkipped,
      modelVersion: response.modelVersion,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      durationMs: response.durationMs,
      warnings: Array.isArray(result.warnings) ? result.warnings : [],
      rawResponse: result
    };
  }
}
