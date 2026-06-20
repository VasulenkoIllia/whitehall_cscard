import type { Pool } from 'pg';
import type { LogService } from '../pipeline/log';
import type { AnthropicBatchClient, BatchRequest } from './AnthropicBatchClient';
import { ENRICHMENT_SYSTEM_PROMPT, buildEnrichmentUserMessage, type MasterEnrichmentResult, type EnrichedField } from './EnrichmentPrompt';
import { MASTER_CATALOG_FIELDS } from '../master_catalog/MasterCatalogService';
import { AiUsageService } from './AiUsageService';
import type { AppSettingsService } from '../settings/AppSettingsService';

/**
 * AnthropicBatchService — async масштабне enrichment через Anthropic Message Batches API.
 *
 * Workflow:
 *   submit(masterIds) → posts 1 request per SKU до Anthropic → DB row у anthropic_batches
 *   pollStatus(batchId) → check current state
 *   syncFromAnthropic(batchId) → коли ended, скачати results, парсити, писати у master_catalog
 *
 * Кожен SKU = 1 окремий request (не multi-item batch у нашому розумінні).
 * Anthropic API сам бере на себе грузу — повертає -50% ціни як discount.
 */

export interface SubmitOptions {
  model?: string;
  overwriteExisting?: boolean;
  confidenceThreshold?: number;
}

export interface BatchSubmitResult {
  /** Створені батчі (великий submit ділиться на чанки — ліміт Anthropic 256MB/батч). */
  batches: Array<{ batchId: number; externalId: string; itemsCount: number }>;
  /** Скільки SKU реально відправлено (сума по всіх чанках). */
  itemsCount: number;
  modelVersion: string;
  /** SKU відкинуті бо вже сидять в іншому активному batch (захист від подвійної оплати). */
  skippedPending: number;
  /** SKU відкинуті бо не мають feed_params. */
  skippedNoFeed: number;
}

export interface BatchRecord {
  id: number;
  external_id: string;
  operation: string;
  status: string;
  model_version: string;
  master_ids: number[];
  items_count: number;
  processed_count: number;
  succeeded_count: number;
  errored_count: number;
  canceled_count: number;
  expired_count: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  results_url: string | null;
  error: string | null;
  prompt_version: string | null;
  created_at: string;
  submitted_at: string | null;
  ended_at: string | null;
  results_fetched_at: string | null;
}

export class AnthropicBatchService {
  constructor(
    private readonly pool: Pool,
    private readonly client: AnthropicBatchClient,
    private readonly usage: AiUsageService,
    private readonly logs: LogService,
    private readonly env: Record<string, string | undefined>,
    private readonly settings?: AppSettingsService | null
  ) {}

  isEnabled(): boolean {
    return this.client.isEnabled();
  }

  /**
   * Submit batch: формує JSONL з 1 request per SKU, відправляє в Anthropic,
   * зберігає batch_id у anthropic_batches.
   */
  async submit(
    masterIds: number[],
    options: SubmitOptions = {}
  ): Promise<BatchSubmitResult> {
    if (!this.client.isEnabled()) {
      const err = new Error('ANTHROPIC_API_KEY не задано');
      (err as { status?: number }).status = 501;
      throw err;
    }
    if (masterIds.length === 0) throw new Error('masterIds порожній');

    const model = options.model || this.env.ANTHROPIC_MODEL_ENRICHMENT || 'claude-haiku-4-5';

    // Async Batch API є лише в Anthropic. Для DeepSeek-моделей цей шлях недоступний —
    // використовувати синхронний Enrich (він і так дешевий).
    if (model.trim().toLowerCase().startsWith('deepseek')) {
      const err = new Error('DeepSeek не має async Batch API — використовуй синхронний Enrich (✨/🔁)');
      (err as { status?: number }).status = 400;
      throw err;
    }

    const promptSetting = this.settings
      ? await this.settings.getEnrichmentPrompt()
      : { prompt: ENRICHMENT_SYSTEM_PROMPT, isCustom: false, version: 'v1' };

    // ЗАПОБІЖНИК: SKU що вже сидять в активному batch (submitted, результати
    // ще не записані) відкидаємо — інакше при повторному submit платимо двічі.
    const pendingRes = await this.pool.query<{ id: number }>(
      `SELECT DISTINCT unnest(master_ids) AS id
         FROM anthropic_batches
        WHERE results_fetched_at IS NULL
          AND status IN ('in_progress', 'canceling', 'ended')`
    );
    const pendingIds = new Set(pendingRes.rows.map((r) => Number(r.id)));
    const freshIds = masterIds.filter((id) => !pendingIds.has(Number(id)));
    const skippedPending = masterIds.length - freshIds.length;
    if (freshIds.length === 0) {
      const err = new Error(
        `Всі ${masterIds.length} SKU вже у черзі в активних batch-ах — повторний submit коштував би подвійно. Дочекайся завершення або натисни Poll.`
      );
      (err as { status?: number }).status = 409;
      throw err;
    }

    // Завантажуємо masters. Зайві колонки вже відкинуто на Excel-імпорті.
    const mastersRes = await this.pool.query<{
      id: number;
      sku: string;
      feed_params: Record<string, unknown> | null;
    }>(`SELECT id, sku, feed_params FROM master_catalog WHERE id = ANY($1::bigint[])`, [freshIds]);

    // Статичний system — однаковий для всіх запитів батча, з cache_control:
    // перший запит пише кеш, решта читають (~0.1× ціни).
    const systemBlocks = [
      { type: 'text' as const, text: buildJsonOnlySystem(promptSetting.prompt), cache_control: { type: 'ephemeral' as const } }
    ];

    // Будуємо BatchRequest[] — 1 на SKU.
    const requests: BatchRequest[] = [];
    const validIds: number[] = [];
    for (const m of mastersRes.rows) {
      if (!m.feed_params || Object.keys(m.feed_params).length === 0) continue;
      requests.push({
        custom_id: `master_${m.id}`,
        params: {
          model,
          max_tokens: 4096,
          temperature: 0,
          system: systemBlocks,
          messages: [
            {
              role: 'user',
              content: buildEnrichmentUserMessage({ sku: m.sku, feedParams: m.feed_params })
            }
          ]
        }
      });
      validIds.push(Number(m.id));
    }

    const skippedNoFeed = freshIds.length - requests.length;
    if (requests.length === 0) {
      throw new Error('Жоден з SKU не має feed_params — нічого відправляти');
    }

    // Anthropic batch limit — 256MB / 100k requests. Кожен запит несе повний
    // system-промпт (~19KB), тож ділимо великий submit на чанки по CHUNK,
    // створюючи окремий batch на кожен.
    const CHUNK = 5000;
    const batches: Array<{ batchId: number; externalId: string; itemsCount: number }> = [];
    for (let i = 0; i < requests.length; i += CHUNK) {
      const chunkReqs = requests.slice(i, i + CHUNK);
      const chunkIds = validIds.slice(i, i + CHUNK);
      const batchResponse = await this.client.submitBatch(chunkReqs);
      const insertRes = await this.pool.query<{ id: number }>(
        `INSERT INTO anthropic_batches
           (external_id, operation, status, model_version, master_ids,
            items_count, last_anthropic_response, submitted_at, prompt_version)
         VALUES ($1, 'enrich_batch', $2, $3, $4::bigint[], $5, $6::jsonb, NOW(), $7)
         RETURNING id::int AS id`,
        [
          batchResponse.id,
          batchResponse.processing_status,
          model,
          chunkIds,
          chunkReqs.length,
          JSON.stringify(batchResponse),
          promptSetting.version
        ]
      );
      batches.push({
        batchId: Number(insertRes.rows[0].id),
        externalId: batchResponse.id,
        itemsCount: chunkReqs.length
      });
    }

    return {
      batches,
      itemsCount: requests.length,
      modelVersion: model,
      skippedPending,
      skippedNoFeed
    };
  }

  /** Poll Anthropic для поточного status. Updates DB row + повертає актуальний. */
  async pollStatus(localBatchId: number): Promise<BatchRecord> {
    const rec = await this.getById(localBatchId);
    if (!rec) {
      const err = new Error(`Batch #${localBatchId} не знайдено`);
      (err as { status?: number }).status = 404;
      throw err;
    }
    if (rec.status === 'ended' && rec.results_fetched_at) {
      return rec; // Вже все скачали.
    }

    const remote = await this.client.fetchStatus(rec.external_id);
    const counts = remote.request_counts;
    const processed =
      counts.succeeded + counts.errored + counts.canceled + counts.expired;

    await this.pool.query(
      `UPDATE anthropic_batches SET
         status = $2,
         processed_count = $3,
         succeeded_count = $4,
         errored_count = $5,
         canceled_count = $6,
         expired_count = $7,
         results_url = $8,
         ended_at = $9,
         last_anthropic_response = $10::jsonb
       WHERE id = $1`,
      [
        localBatchId,
        remote.processing_status,
        processed,
        counts.succeeded,
        counts.errored,
        counts.canceled,
        counts.expired,
        remote.results_url,
        remote.ended_at,
        JSON.stringify(remote)
      ]
    );

    return (await this.getById(localBatchId))!;
  }

  /**
   * Якщо batch ended → скачати results → запустити write до master_catalog →
   * залогувати usage.
   *
   * Ідемпотентно: не записує двічі через `results_fetched_at IS NOT NULL`.
   */
  async syncFromAnthropic(
    localBatchId: number,
    options: { overwriteExisting?: boolean; confidenceThreshold?: number } = {}
  ): Promise<BatchRecord> {
    // Спершу оновити поточний status.
    let rec = await this.pollStatus(localBatchId);

    if (rec.status !== 'ended') {
      return rec;
    }
    if (rec.results_fetched_at) {
      return rec; // Уже скачали раніше.
    }
    if (!rec.results_url) {
      throw new Error(`Batch ${rec.external_id} ended але без results_url`);
    }

    const entries = await this.client.fetchResults(rec.results_url);

    let totalInput = 0;
    let totalOutput = 0;
    let totalCacheCreation = 0;
    let totalCacheRead = 0;
    let totalFieldsWritten = 0;
    const threshold = options.confidenceThreshold ?? 0.4;
    const overwrite = options.overwriteExisting ?? false;

    // Завантажуємо існуючі master_catalog рядки одним запитом.
    const mastersRes = await this.pool.query<{ id: number; [k: string]: unknown }>(
      `SELECT * FROM master_catalog WHERE id = ANY($1::bigint[])`,
      [rec.master_ids]
    );
    const mastersById = new Map<number, { [k: string]: unknown }>();
    for (const m of mastersRes.rows) mastersById.set(Number(m.id), m);

    for (const entry of entries) {
      if (entry.result.type !== 'succeeded') {
        continue;
      }
      const msg = entry.result.message;
      const usage = msg.usage || { input_tokens: 0, output_tokens: 0 };
      totalInput += usage.input_tokens || 0;
      totalOutput += usage.output_tokens || 0;
      totalCacheCreation += usage.cache_creation_input_tokens || 0;
      totalCacheRead += usage.cache_read_input_tokens || 0;

      const text = (msg.content || [])
        .filter((c) => c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text!)
        .join('\n')
        .trim();

      let parsed: MasterEnrichmentResult | null = null;
      try {
        let body = text;
        if (body.startsWith('```')) {
          body = body.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
        }
        const first = body.indexOf('{');
        const last = body.lastIndexOf('}');
        if (first > 0 && last > first) body = body.slice(first, last + 1);
        parsed = JSON.parse(body) as MasterEnrichmentResult;
      } catch (err) {
        continue;
      }

      const masterId = Number(entry.custom_id.replace(/^master_/, ''));
      const master = mastersById.get(masterId);
      if (!master || !parsed || !parsed.fields) continue;

      const written = await this.writeMasterFields(
        masterId,
        master,
        parsed,
        threshold,
        overwrite,
        rec.model_version,
        rec.prompt_version || 'v1'
      );
      totalFieldsWritten += written;
    }

    // Розрахунок cost (з -50% Batch API discount + кеш-токени).
    const { calculateCostUsd } = await import('./AiUsageService');
    const cost = calculateCostUsd(
      rec.model_version, totalInput, totalOutput, true, totalCacheCreation, totalCacheRead
    );

    await this.pool.query(
      `UPDATE anthropic_batches SET
         input_tokens = $2, output_tokens = $3, cost_usd = $4,
         results_fetched_at = NOW()
       WHERE id = $1`,
      [localBatchId, totalInput, totalOutput, cost]
    );

    // Лог у ai_usage_log.
    await this.usage.log({
      operation: 'enrich_batch_async',
      modelVersion: rec.model_version,
      masterIds: rec.master_ids,
      inputTokens: totalInput,
      outputTokens: totalOutput,
      cacheCreationInputTokens: totalCacheCreation,
      cacheReadInputTokens: totalCacheRead,
      durationMs: 0, // async — не вимірюємо.
      isBatchApi: true,
      fieldsWritten: totalFieldsWritten
    });

    return (await this.getById(localBatchId))!;
  }

  async getById(id: number): Promise<BatchRecord | null> {
    const res = await this.pool.query<BatchRecord>(
      `SELECT id, external_id, operation, status, model_version, master_ids,
              items_count, processed_count, succeeded_count, errored_count,
              canceled_count, expired_count, input_tokens, output_tokens,
              cost_usd, results_url, error, prompt_version, created_at,
              submitted_at, ended_at, results_fetched_at
         FROM anthropic_batches WHERE id = $1`,
      [id]
    );
    return res.rowCount === 0 ? null : res.rows[0];
  }

  async list(limit = 20): Promise<BatchRecord[]> {
    const res = await this.pool.query<BatchRecord>(
      `SELECT id, external_id, operation, status, model_version, master_ids,
              items_count, processed_count, succeeded_count, errored_count,
              canceled_count, expired_count, input_tokens, output_tokens,
              cost_usd, results_url, error, prompt_version, created_at,
              submitted_at, ended_at, results_fetched_at
         FROM anthropic_batches
        ORDER BY id DESC
        LIMIT $1`,
      [Math.max(1, Math.min(100, limit))]
    );
    return res.rows;
  }

  private async writeMasterFields(
    masterId: number,
    master: { [k: string]: unknown },
    result: MasterEnrichmentResult,
    threshold: number,
    overwrite: boolean,
    modelVersion: string,
    promptVersion: string
  ): Promise<number> {
    const updates: Record<string, string | number | null> = {};
    let fieldsWritten = 0;

    for (const field of MASTER_CATALOG_FIELDS) {
      const entry = result.fields[field] as EnrichedField | undefined;
      if (!entry || entry.value === null || typeof entry.value === 'undefined') continue;
      const conf = typeof entry.confidence === 'number' ? entry.confidence : 0;
      if (conf < threshold) continue;
      if (!overwrite && master[field] !== null && master[field] !== '' && master[field] !== undefined) continue;
      updates[field] = entry.value;
      fieldsWritten++;
    }

    if (fieldsWritten === 0) {
      await this.pool.query(
        `UPDATE master_catalog SET ai_enriched_at = NOW(), ai_model = $2, ai_prompt_version = $3, updated_at = NOW() WHERE id = $1`,
        [masterId, modelVersion, promptVersion]
      );
      return 0;
    }

    const setParts: string[] = [];
    const params: unknown[] = [masterId];
    let idx = 2;
    for (const [k, v] of Object.entries(updates)) {
      setParts.push(`${k} = $${idx}`);
      params.push(v);
      idx++;
    }
    params.push(modelVersion);
    params.push(promptVersion);
    await this.pool.query(
      `UPDATE master_catalog SET ${setParts.join(', ')}, ai_enriched_at = NOW(), ai_model = $${idx}, ai_prompt_version = $${idx + 1}, updated_at = NOW() WHERE id = $1`,
      params
    );

    return fieldsWritten;
  }
}

function buildJsonOnlySystem(base: string): string {
  return [
    base.trim(),
    '',
    'CRITICAL OUTPUT RULES:',
    '1. Your entire response MUST be a single valid JSON object.',
    '2. No prose before or after the JSON.',
    '3. No markdown code fences (no ```json wrappers).',
    '4. Use double quotes for all strings.',
    '5. If you are uncertain about a field, return null + a "reasoning" explaining why.'
  ].join('\n');
}
