import type { Pool } from 'pg';

/**
 * AiUsageService — облік витрат на Anthropic API.
 *
 * Pricing per million tokens (станом на 2026-05):
 *   claude-haiku-4-5  : $1.00 input,  $5.00 output
 *   claude-sonnet-4-5 : $3.00 input, $15.00 output
 *   claude-opus-4     : $15.00 input, $75.00 output
 *   Batch API: -50% on both.
 *
 * Цей service сам розраховує cost_usd та записує в ai_usage_log.
 */

interface ModelPricing {
  /** USD per million input tokens */
  inputPerMtok: number;
  /** USD per million output tokens */
  outputPerMtok: number;
  /**
   * USD per million cached-read input tokens. Якщо задано — використовується
   * напряму (DeepSeek cache-hit значно дешевший за inputPerMtok×0.1). Якщо ні —
   * рахуємо inputPerMtok × CACHE_READ_MULT (Anthropic ephemeral 0.1×).
   */
  cacheReadPerMtok?: number;
}

const PRICING_TABLE: Record<string, ModelPricing> = {
  'claude-haiku-4-5': { inputPerMtok: 1.0, outputPerMtok: 5.0 },
  'claude-sonnet-4-6': { inputPerMtok: 3.0, outputPerMtok: 15.0 },
  'claude-sonnet-4-5': { inputPerMtok: 3.0, outputPerMtok: 15.0 },
  'claude-opus-4': { inputPerMtok: 15.0, outputPerMtok: 75.0 },
  // Старі моделі (для сумісності якщо хтось ще їх використовує):
  'claude-haiku-3-5': { inputPerMtok: 0.8, outputPerMtok: 4.0 },
  'claude-sonnet-3-7': { inputPerMtok: 3.0, outputPerMtok: 15.0 },
  // DeepSeek (автокешування — cache-hit тарифікується окремою низькою ставкою).
  // deepseek-chat/reasoner → v4-flash (non-thinking/thinking), однакова ставка.
  'deepseek-chat': { inputPerMtok: 0.14, outputPerMtok: 0.28, cacheReadPerMtok: 0.0028 },
  'deepseek-reasoner': { inputPerMtok: 0.14, outputPerMtok: 0.28, cacheReadPerMtok: 0.0028 },
  'deepseek-v4-flash': { inputPerMtok: 0.14, outputPerMtok: 0.28, cacheReadPerMtok: 0.0028 },
  'deepseek-v4-pro': { inputPerMtok: 0.435, outputPerMtok: 0.87, cacheReadPerMtok: 0.003625 }
};

// Prompt caching множники до ціни input.
const CACHE_WRITE_MULT = 1.25; // 5-хв ephemeral write
const CACHE_READ_MULT = 0.1; // read

function resolveModelPricing(modelVersion: string): ModelPricing {
  // modelVersion типу 'claude-haiku-4-5-20251001' — обріжемо timestamp suffix.
  for (const key of Object.keys(PRICING_TABLE)) {
    if (modelVersion.startsWith(key)) return PRICING_TABLE[key];
  }
  // Невідома deepseek-модель → ставка deepseek-chat (а не дорогий Claude).
  if (modelVersion.startsWith('deepseek')) return PRICING_TABLE['deepseek-chat'];
  // Default — найдорожче (краще overestimate ніж underestimate).
  return PRICING_TABLE['claude-sonnet-4-6'];
}

/**
 * Точна вартість з урахуванням prompt caching.
 *   inputTokens         — некешований input (повна ціна).
 *   cacheCreationTokens — записані в кеш (1.25× input).
 *   cacheReadTokens     — прочитані з кешу (0.1× input).
 * Batch API: -50% на все.
 */
export function calculateCostUsd(
  modelVersion: string,
  inputTokens: number,
  outputTokens: number,
  isBatchApi = false,
  cacheCreationTokens = 0,
  cacheReadTokens = 0
): number {
  const pricing = resolveModelPricing(modelVersion);
  const discount = isBatchApi ? 0.5 : 1.0;
  const m = 1_000_000;
  const cacheReadRate =
    typeof pricing.cacheReadPerMtok === 'number'
      ? pricing.cacheReadPerMtok
      : pricing.inputPerMtok * CACHE_READ_MULT;
  const inputCost = (inputTokens / m) * pricing.inputPerMtok;
  const cacheWriteCost = (cacheCreationTokens / m) * pricing.inputPerMtok * CACHE_WRITE_MULT;
  const cacheReadCost = (cacheReadTokens / m) * cacheReadRate;
  const outputCost = (outputTokens / m) * pricing.outputPerMtok;
  return Number(((inputCost + cacheWriteCost + cacheReadCost + outputCost) * discount).toFixed(6));
}

export interface LogUsageInput {
  operation: string;
  modelVersion: string;
  masterIds: number[];
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  isBatchApi?: boolean;
  fieldsWritten?: number | null;
  userId?: string | null;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

export class AiUsageService {
  constructor(private readonly pool: Pool) {}

  async log(input: LogUsageInput): Promise<{ id: number; costUsd: number }> {
    const cacheCreation = input.cacheCreationInputTokens ?? 0;
    const cacheRead = input.cacheReadInputTokens ?? 0;
    const costUsd = calculateCostUsd(
      input.modelVersion,
      input.inputTokens,
      input.outputTokens,
      input.isBatchApi ?? false,
      cacheCreation,
      cacheRead
    );
    const res = await this.pool.query<{ id: number }>(
      `INSERT INTO ai_usage_log
         (operation, model_version, master_ids, items_count,
          input_tokens, output_tokens, cost_usd, duration_ms,
          is_batch_api, fields_written, user_id,
          cache_creation_input_tokens, cache_read_input_tokens)
       VALUES ($1, $2, $3::bigint[], $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING id::int AS id`,
      [
        input.operation,
        input.modelVersion,
        input.masterIds,
        input.masterIds.length,
        input.inputTokens,
        input.outputTokens,
        costUsd,
        input.durationMs,
        input.isBatchApi ?? false,
        input.fieldsWritten ?? null,
        input.userId ?? null,
        cacheCreation,
        cacheRead
      ]
    );
    return { id: Number(res.rows[0].id), costUsd };
  }

  /** Summary за період (default — всі часи). */
  async summary(periodDays?: number): Promise<{
    totalCalls: number;
    totalItems: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCostUsd: number;
    byModel: Array<{ model: string; calls: number; items: number; costUsd: number }>;
    byOperation: Array<{ operation: string; calls: number; items: number; costUsd: number }>;
    last24h: { calls: number; costUsd: number };
  }> {
    const whereClause = periodDays
      ? `WHERE created_at >= NOW() - $1::interval`
      : '';
    const intervalArg = periodDays ? [`${periodDays} days`] : [];

    const totals = await this.pool.query(
      `SELECT
         COUNT(*)::int AS total_calls,
         COALESCE(SUM(items_count), 0)::int AS total_items,
         COALESCE(SUM(input_tokens), 0)::bigint AS total_input,
         COALESCE(SUM(output_tokens), 0)::bigint AS total_output,
         COALESCE(SUM(cost_usd), 0)::numeric AS total_cost
       FROM ai_usage_log
       ${whereClause}`,
      intervalArg
    );

    const byModel = await this.pool.query(
      `SELECT
         model_version AS model,
         COUNT(*)::int AS calls,
         COALESCE(SUM(items_count), 0)::int AS items,
         COALESCE(SUM(cost_usd), 0)::numeric AS cost_usd
       FROM ai_usage_log
       ${whereClause}
       GROUP BY model_version
       ORDER BY cost_usd DESC`,
      intervalArg
    );

    const byOperation = await this.pool.query(
      `SELECT
         operation,
         COUNT(*)::int AS calls,
         COALESCE(SUM(items_count), 0)::int AS items,
         COALESCE(SUM(cost_usd), 0)::numeric AS cost_usd
       FROM ai_usage_log
       ${whereClause}
       GROUP BY operation
       ORDER BY cost_usd DESC`,
      intervalArg
    );

    const last24h = await this.pool.query(
      `SELECT COUNT(*)::int AS calls, COALESCE(SUM(cost_usd), 0)::numeric AS cost_usd
       FROM ai_usage_log
       WHERE created_at >= NOW() - INTERVAL '24 hours'`
    );

    const t = totals.rows[0];
    return {
      totalCalls: Number(t.total_calls || 0),
      totalItems: Number(t.total_items || 0),
      totalInputTokens: Number(t.total_input || 0),
      totalOutputTokens: Number(t.total_output || 0),
      totalCostUsd: Number(t.total_cost || 0),
      byModel: byModel.rows.map((r) => ({
        model: r.model,
        calls: Number(r.calls),
        items: Number(r.items),
        costUsd: Number(r.cost_usd)
      })),
      byOperation: byOperation.rows.map((r) => ({
        operation: r.operation,
        calls: Number(r.calls),
        items: Number(r.items),
        costUsd: Number(r.cost_usd)
      })),
      last24h: {
        calls: Number(last24h.rows[0]?.calls || 0),
        costUsd: Number(last24h.rows[0]?.cost_usd || 0)
      }
    };
  }

  /** Recent log entries для UI таблиці. */
  async recent(limit = 20): Promise<Array<{
    id: number;
    operation: string;
    modelVersion: string;
    itemsCount: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    durationMs: number;
    isBatchApi: boolean;
    fieldsWritten: number | null;
    createdAt: string;
  }>> {
    const res = await this.pool.query(
      `SELECT id, operation, model_version, items_count,
              input_tokens, output_tokens, cost_usd, duration_ms,
              is_batch_api, fields_written, created_at
         FROM ai_usage_log
        ORDER BY id DESC
        LIMIT $1`,
      [Math.max(1, Math.min(200, limit))]
    );
    return res.rows.map((r) => ({
      id: Number(r.id),
      operation: r.operation,
      modelVersion: r.model_version,
      itemsCount: Number(r.items_count),
      inputTokens: Number(r.input_tokens),
      outputTokens: Number(r.output_tokens),
      costUsd: Number(r.cost_usd),
      durationMs: Number(r.duration_ms),
      isBatchApi: Boolean(r.is_batch_api),
      fieldsWritten: r.fields_written !== null ? Number(r.fields_written) : null,
      createdAt: r.created_at
    }));
  }
}
