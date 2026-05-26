import type { Pool } from 'pg';
import type { LogService } from '../pipeline/log';
import type { AnthropicClient } from './AnthropicClient';
import {
  ENRICHMENT_SYSTEM_PROMPT,
  buildEnrichmentUserMessage,
  buildBatchEnrichmentUserMessage,
  type MasterEnrichmentResult,
  type BatchEnrichmentResult,
  type EnrichedField
} from './EnrichmentPrompt';
import type { AiUsageService } from './AiUsageService';
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

export interface BatchEnrichResult {
  itemsRequested: number;
  itemsEnriched: number;
  itemsFailed: number;
  totalFieldsWritten: number;
  modelVersion: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  perItem: Array<{
    masterId: number;
    sku: string;
    fieldsWritten: number;
    fieldsSkipped: number;
    error?: string;
  }>;
}

export interface BatchEnrichOptions extends EnrichOptions {
  /** Скільки SKU за один API call. Default 10. Max 25. */
  batchSize?: number;
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
    private readonly env: Record<string, string | undefined>,
    private readonly usage?: AiUsageService | null
  ) {}

  isEnabled(): boolean {
    return this.anthropic.isEnabled();
  }

  /**
   * Повертає сирий promptq без відправки в AI — для UI preview / дебагу.
   * Враховує feeds.options.excluded_fields так само як справжній виклик.
   */
  async previewPrompt(masterId: number): Promise<{
    systemPrompt: string;
    userMessage: string;
    estimatedTokens: number;
    feedParams: Record<string, unknown> | null;
  }> {
    const masterRes = await this.pool.query<{ id: number; sku: string; feed_params: Record<string, unknown> | null }>(
      `SELECT id, sku, feed_params FROM master_catalog WHERE id = $1`,
      [masterId]
    );
    if (masterRes.rowCount === 0) {
      const err = new Error(`Master #${masterId} не знайдено`);
      (err as { status?: number }).status = 404;
      throw err;
    }
    const master = masterRes.rows[0];

    // Завантажимо excluded fields per feed.
    const feedsRes = await this.pool.query<{ name: string; options: { excluded_fields?: unknown } | null }>(
      `SELECT name, options FROM feeds`
    );
    const excludedByFeed: Record<string, Set<string>> = {};
    for (const r of feedsRes.rows) {
      const ex = Array.isArray(r.options?.excluded_fields)
        ? (r.options!.excluded_fields as unknown[]).filter((x): x is string => typeof x === 'string')
        : [];
      excludedByFeed[r.name] = new Set(ex);
    }
    const filtered = master.feed_params
      ? filterFeedParams(master.feed_params, excludedByFeed)
      : null;

    const userMessage = buildEnrichmentUserMessage({
      sku: master.sku,
      feedParams: filtered || {}
    });

    // Дуже груба оцінка: ~4 символи на токен для UA/EN тексту.
    const estimatedTokens = Math.ceil((ENRICHMENT_SYSTEM_PROMPT.length + userMessage.length) / 4);

    return {
      systemPrompt: ENRICHMENT_SYSTEM_PROMPT,
      userMessage,
      estimatedTokens,
      feedParams: filtered
    };
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

    // Log usage (non-blocking).
    if (this.usage) {
      this.usage
        .log({
          operation: 'enrich_master',
          modelVersion: response.modelVersion,
          masterIds: [masterId],
          inputTokens: response.inputTokens,
          outputTokens: response.outputTokens,
          durationMs: response.durationMs,
          fieldsWritten
        })
        .catch(() => undefined);
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

  /**
   * BATCH enrich — багато SKU за один Anthropic call.
   *
   * Ефективність:
   *   System prompt (~3K tokens) відсилається 1 раз для N items, не N окремих викликів.
   *   На batch=10 економимо ~50% input tokens + значно швидше (1 виклик замість 10).
   *
   * Обмеження:
   *   Sonnet 4.5 max output 64k tokens. 1 SKU ≈ 2k output. → max batch ~25-30 SKU.
   *   Default 10 — золота середина між швидкістю і ризиком (AI плутати SKU при > 15).
   */
  async enrichBatch(
    masterIds: number[],
    options: BatchEnrichOptions = {}
  ): Promise<BatchEnrichResult> {
    if (!this.anthropic.isEnabled()) {
      const err = new Error('Anthropic AI не сконфігурований');
      (err as { status?: number }).status = 501;
      throw err;
    }
    if (!masterIds || masterIds.length === 0) {
      const err = new Error('masterIds порожній — нема чого enrich-ити');
      (err as { status?: number }).status = 400;
      throw err;
    }

    const batchSize = Math.min(25, Math.max(1, Math.trunc(options.batchSize || 10)));
    const threshold = options.confidenceThreshold ?? 0.4;
    const overwrite = options.overwriteExisting ?? false;
    const model = options.model || this.env.ANTHROPIC_MODEL_ENRICHMENT || 'claude-sonnet-4-5';

    // Load all masters at once.
    const mastersRes = await this.pool.query<{
      id: number;
      sku: string;
      feed_params: Record<string, unknown> | null;
      [k: string]: unknown;
    }>(
      `SELECT * FROM master_catalog WHERE id = ANY($1::bigint[])`,
      [masterIds]
    );
    const mastersById = new Map<number, typeof mastersRes.rows[number]>();
    for (const row of mastersRes.rows) mastersById.set(Number(row.id), row);

    // Load feeds.options.excluded_fields once.
    const feedsRes = await this.pool.query<{ name: string; options: { excluded_fields?: unknown } | null }>(
      `SELECT name, options FROM feeds`
    );
    const excludedByFeed: Record<string, Set<string>> = {};
    for (const r of feedsRes.rows) {
      const ex = Array.isArray(r.options?.excluded_fields)
        ? (r.options!.excluded_fields as unknown[])
            .filter((x): x is string => typeof x === 'string')
        : [];
      excludedByFeed[r.name] = new Set(ex);
    }

    const startedAt = Date.now();
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalFieldsWritten = 0;
    let modelVersion = model;
    const perItem: BatchEnrichResult['perItem'] = [];

    // Split into chunks.
    for (let i = 0; i < masterIds.length; i += batchSize) {
      const chunk = masterIds.slice(i, i + batchSize);
      const items = chunk
        .map((id) => mastersById.get(Number(id)))
        .filter((m): m is typeof mastersRes.rows[number] => Boolean(m))
        .filter((m) => m.feed_params && Object.keys(m.feed_params).length > 0);

      if (items.length === 0) {
        // All skipped (no feed_params).
        for (const id of chunk) {
          perItem.push({
            masterId: Number(id),
            sku: mastersById.get(Number(id))?.sku || '?',
            fieldsWritten: 0,
            fieldsSkipped: 0,
            error: 'no feed_params'
          });
        }
        continue;
      }

      const batchPayload = items.map((m) => ({
        sku: m.sku,
        feedParams: filterFeedParams(m.feed_params!, excludedByFeed)
      }));

      // Call AI for the chunk.
      let response;
      try {
        response = await this.anthropic.send<BatchEnrichmentResult>({
          model,
          systemPrompt: ENRICHMENT_SYSTEM_PROMPT,
          userMessage: buildBatchEnrichmentUserMessage(batchPayload),
          jsonOutput: true,
          // Більше output tokens бо багато SKU.
          maxTokens: Math.min(64_000, 4096 * items.length),
          temperature: 0
        });
      } catch (err) {
        // Якщо весь chunk впав — записуємо error для кожного.
        for (const item of items) {
          perItem.push({
            masterId: Number(item.id),
            sku: item.sku,
            fieldsWritten: 0,
            fieldsSkipped: 0,
            error: err instanceof Error ? err.message : String(err)
          });
        }
        continue;
      }

      totalInputTokens += response.inputTokens;
      totalOutputTokens += response.outputTokens;
      modelVersion = response.modelVersion;

      const results = response.content?.results || [];
      if (!Array.isArray(results)) {
        for (const item of items) {
          perItem.push({
            masterId: Number(item.id),
            sku: item.sku,
            fieldsWritten: 0,
            fieldsSkipped: 0,
            error: 'AI повернув не-масив'
          });
        }
        continue;
      }

      // Map results by sku → write each.
      const resultBySku = new Map<string, MasterEnrichmentResult>();
      for (const r of results) {
        if (r && typeof r === 'object' && typeof r.sku === 'string') {
          resultBySku.set(r.sku, r);
        }
      }

      for (const item of items) {
        const result = resultBySku.get(item.sku);
        if (!result || !result.fields) {
          perItem.push({
            masterId: Number(item.id),
            sku: item.sku,
            fieldsWritten: 0,
            fieldsSkipped: 0,
            error: 'AI не повернув enrichment для цього SKU'
          });
          continue;
        }
        const { fieldsWritten, fieldsSkipped } = await this.writeMasterFields(
          Number(item.id),
          item,
          result,
          threshold,
          overwrite,
          modelVersion
        );
        totalFieldsWritten += fieldsWritten;
        perItem.push({
          masterId: Number(item.id),
          sku: item.sku,
          fieldsWritten,
          fieldsSkipped
        });
      }
    }

    const itemsRequested = masterIds.length;
    const itemsEnriched = perItem.filter((x) => !x.error && x.fieldsWritten > 0).length;
    const itemsFailed = perItem.filter((x) => Boolean(x.error)).length;
    const durationMs = Date.now() - startedAt;

    // Log usage (non-blocking).
    if (this.usage && (totalInputTokens > 0 || totalOutputTokens > 0)) {
      this.usage
        .log({
          operation: 'enrich_batch',
          modelVersion,
          masterIds,
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          durationMs,
          fieldsWritten: totalFieldsWritten
        })
        .catch(() => undefined);
    }

    return {
      itemsRequested,
      itemsEnriched,
      itemsFailed,
      totalFieldsWritten,
      modelVersion,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      durationMs,
      perItem
    };
  }

  /**
   * Спільна логіка write-back в master_catalog. Викликається з enrichMaster + enrichBatch.
   */
  private async writeMasterFields(
    masterId: number,
    master: { [k: string]: unknown },
    result: MasterEnrichmentResult,
    threshold: number,
    overwrite: boolean,
    modelVersion: string
  ): Promise<{ fieldsWritten: number; fieldsSkipped: number }> {
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
      params.push(modelVersion);
      params.push('v1');
      await this.pool.query(
        `UPDATE master_catalog
            SET ${setParts.join(', ')},
                ai_enriched_at = NOW(),
                ai_model = $${idx},
                ai_prompt_version = $${idx + 1},
                updated_at = NOW()
          WHERE id = $1`,
        params
      );
    } else {
      await this.pool.query(
        `UPDATE master_catalog
            SET ai_enriched_at = NOW(),
                ai_model = $2,
                ai_prompt_version = $3,
                updated_at = NOW()
          WHERE id = $1`,
        [masterId, modelVersion, 'v1']
      );
    }

    return { fieldsWritten, fieldsSkipped };
  }
}
