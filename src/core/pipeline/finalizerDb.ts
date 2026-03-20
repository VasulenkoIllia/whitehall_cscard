import type { Pool } from 'pg';
import type { FinalizeSummary, Finalizer } from './contracts';

const insertFromPrecomputedSql = `
  WITH rounded AS (
    SELECT
      pr.article,
      pr.size,
      pr.quantity,
      pr.price AS price_base,
      CEIL(pr.price_with_markup / 10) * 10 AS price_final,
      pr.extra,
      pr.supplier_id,
      s.priority AS supplier_priority
    FROM products_raw pr
    JOIN suppliers s ON s.id = pr.supplier_id
    WHERE s.is_active = TRUE
      AND pr.job_id = $2
  ),
  filtered AS (
    SELECT DISTINCT ON (r.article, r.size)
      r.article,
      r.size,
      r.quantity,
      r.price_base,
      r.price_final,
      r.extra,
      r.supplier_id
    FROM rounded r
    ORDER BY
      r.article,
      r.size,
      r.supplier_priority ASC,
      r.price_final ASC,
      r.supplier_id ASC
  )
  INSERT INTO products_final (
    job_id,
    article,
    size,
    quantity,
    price_base,
    price_final,
    extra,
    supplier_id
  )
  SELECT
    $1,
    article,
    size,
    quantity,
    price_base,
    price_final,
    extra,
    supplier_id
  FROM filtered
  ON CONFLICT (article, size) DO UPDATE
    SET job_id = EXCLUDED.job_id,
        quantity = EXCLUDED.quantity,
        price_base = EXCLUDED.price_base,
        price_final = EXCLUDED.price_final,
        extra = EXCLUDED.extra,
        supplier_id = EXCLUDED.supplier_id;
`;

const insertWithFinalizePricingSql = `
  WITH base AS (
    SELECT
      pr.article,
      pr.size,
      pr.quantity,
      pr.price AS price_base,
      pr.extra,
      pr.supplier_id,
      s.priority AS supplier_priority,
      CASE
        WHEN s.min_profit_enabled = TRUE
          AND (pr.price * (1 + s.markup_percent / 100)) - pr.price < s.min_profit_amount
          THEN pr.price + s.min_profit_amount
        ELSE pr.price * (1 + s.markup_percent / 100)
      END AS legacy_price,
      active_rs.id AS effective_rule_set_id
    FROM products_raw pr
    JOIN suppliers s ON s.id = pr.supplier_id
    LEFT JOIN markup_rule_sets active_rs
      ON active_rs.id = s.markup_rule_set_id
     AND active_rs.is_active = TRUE
    WHERE s.is_active = TRUE
      AND pr.job_id = $2
  ),
  computed AS (
    SELECT
      b.article,
      b.size,
      b.quantity,
      b.price_base,
      CASE
        WHEN b.effective_rule_set_id IS NULL THEN b.legacy_price
        WHEN selected_rule.action_type = 'fixed_add' THEN b.price_base + selected_rule.action_value
        WHEN selected_rule.action_type = 'percent' THEN b.price_base * (1 + selected_rule.action_value / 100)
        ELSE b.legacy_price
      END AS price_with_markup,
      b.extra,
      b.supplier_id,
      b.supplier_priority
    FROM base b
    LEFT JOIN LATERAL (
      SELECT
        c.action_type,
        c.action_value
      FROM markup_rule_conditions c
      WHERE c.rule_set_id = b.effective_rule_set_id
        AND c.is_active = TRUE
        AND b.price_base >= c.price_from
        AND (c.price_to IS NULL OR b.price_base < c.price_to)
      ORDER BY c.priority ASC, c.id ASC
      LIMIT 1
    ) selected_rule ON TRUE
  ),
  rounded AS (
    SELECT
      article,
      size,
      quantity,
      price_base,
      CEIL(price_with_markup / 10) * 10 AS price_final,
      extra,
      supplier_id,
      supplier_priority
    FROM computed
  ),
  filtered AS (
    SELECT DISTINCT ON (r.article, r.size)
      r.article,
      r.size,
      r.quantity,
      r.price_base,
      r.price_final,
      r.extra,
      r.supplier_id
    FROM rounded r
    ORDER BY
      r.article,
      r.size,
      r.supplier_priority ASC,
      r.price_final ASC,
      r.supplier_id ASC
  )
  INSERT INTO products_final (
    job_id,
    article,
    size,
    quantity,
    price_base,
    price_final,
    extra,
    supplier_id
  )
  SELECT
    $1,
    article,
    size,
    quantity,
    price_base,
    price_final,
    extra,
    supplier_id
  FROM filtered
  ON CONFLICT (article, size) DO UPDATE
    SET job_id = EXCLUDED.job_id,
        quantity = EXCLUDED.quantity,
        price_base = EXCLUDED.price_base,
        price_final = EXCLUDED.price_final,
        extra = EXCLUDED.extra,
        supplier_id = EXCLUDED.supplier_id;
`;

export class FinalizerDb implements Finalizer {
  constructor(
    private readonly pool: Pool,
    private readonly options: { finalizeDeleteEnabled: boolean; priceAtImportEnabled: boolean }
  ) {}

  async buildFinalDataset(jobId: number): Promise<FinalizeSummary> {
    const client = await this.pool.connect();
    const startedAt = Date.now();
    let importJobId: number | null = null;
    let finalCount = 0;
    try {
      await client.query('BEGIN');
      const importJob = await client.query(
        `SELECT id FROM jobs WHERE type = 'import_all' AND status = 'success' ORDER BY id DESC LIMIT 1`
      );
      importJobId = Number(importJob.rows[0]?.id || 0);
      if (!importJobId) {
        throw new Error('No successful import_all job found');
      }

      if (this.options.finalizeDeleteEnabled) {
        await client.query('DELETE FROM products_final');
      }

      const rawCountResult = await client.query(
        `SELECT
           COUNT(*) AS raw_count,
           COUNT(*) FILTER (WHERE price_with_markup IS NULL) AS missing_precomputed_count
         FROM products_raw
         WHERE job_id = $1`,
        [importJobId]
      );
      const rawCount = Number(rawCountResult.rows[0].raw_count || 0);
      const missingPrecomputed = Number(rawCountResult.rows[0].missing_precomputed_count || 0);
      const usePrecomputed = this.options.priceAtImportEnabled && rawCount > 0 && missingPrecomputed === 0;

      await client.query(usePrecomputed ? insertFromPrecomputedSql : insertWithFinalizePricingSql, [
        jobId,
        importJobId
      ]);

      const finalCountResult = await client.query('SELECT COUNT(*) FROM products_final');
      finalCount = Number(finalCountResult.rows[0].count || 0);
      await client.query('COMMIT');

      return {
        rawCount,
        finalCount,
        durationMs: Date.now() - startedAt
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}
