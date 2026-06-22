import type { Pool, PoolClient } from 'pg';
import type { LogService } from '../pipeline/log';

/**
 * MasterCatalogService — управління master_catalog (Phase 1 MVP).
 *
 * Phase 1 (зараз):
 *   - syncFromFinalize(): SELECT DISTINCT article з products_final → INSERT у master_catalog.
 *     Тільки додає нові SKU. Не видаляє автоматично нічого.
 *
 * Phase 2 (потім): import feed + match SKU + write feed_params.
 * Phase 3 (потім): AI enrichment → fill 23 attribute fields.
 */

export const MASTER_CATALOG_FIELDS = [
  'name_uk',
  'brand',
  'category_uk',
  'photo',
  'description_full_uk',
  'old_price',
  'product_kind',
  'product_type',
  'color_uk',
  'model_name',
  'gender',
  'style',
  'material',
  'material_top',
  'material_inner',
  'material_sole',
  'toe_shape',
  'fastening',
  'purpose',
  'season',
  'season_year',
  'country',
  'gtin'
] as const;

export type MasterCatalogField = (typeof MASTER_CATALOG_FIELDS)[number];

/** SQL-вираз: скільки з 23 атрибутних полів заповнені (для filled_count і фільтрів). */
export const FILLED_COUNT_EXPR = MASTER_CATALOG_FIELDS.map(
  (f) =>
    `(CASE WHEN ${f} IS NOT NULL${
      f === 'old_price' ? '' : ` AND btrim(${f}::text) <> ''`
    } THEN 1 ELSE 0 END)`
).join(' + ');

/** Поріг «неповних»: опрацьовано, але заповнено менше стількох полів із 23. */
export const INCOMPLETE_FILLED_THRESHOLD = 8;

export interface MasterCatalogSyncSummary {
  runId: number;
  jobId: number;
  sourceJobId: number | null;
  sourceSkuCount: number;
  inserted: number;
  skipped: number;
  durationMs: number;
}

export interface MasterCatalogListFilters {
  search?: string | null;
  hasName?: boolean | null;
  hasFeed?: boolean | null;
  hasAi?: boolean | null;
  /** true — тільки SKU в активному (незавершеному) async batch; false — без них. */
  pendingBatch?: boolean | null;
  /**
   * Повнота AI-результату (серед опрацьованих):
   *   'no_desc'    — без опису (description_full_uk порожній);
   *   'incomplete' — заповнено < INCOMPLETE_FILLED_THRESHOLD полів.
   */
  completeness?: 'no_desc' | 'incomplete' | null;
  isActive?: boolean | null;
  page?: number;
  pageSize?: number;
  sort?: string;
}

export interface MasterCatalogStats {
  total: number;
  withFeed: number;
  aiEnriched: number;
  /** У черзі: в активному batch (submitted, результати ще не записані). */
  pendingBatch: number;
  /** Готові до відправки: з фідом, без AI, не в черзі. */
  fresh: number;
  /** Опрацьовані, але без опису (description_full_uk порожній) — треба догенерувати. */
  noDescription: number;
  /** Опрацьовані, але неповні (< INCOMPLETE_FILLED_THRESHOLD полів). */
  incomplete: number;
}

/**
 * SKU що сидять в активних async батчах: submitted, але результати ще не
 * записані у master_catalog. Такі SKU виглядають як "не опрацьовані"
 * (ai_enriched_at IS NULL), тому без цього фільтра їх можна випадково
 * відправити вдруге і заплатити двічі.
 */
const PENDING_BATCH_IDS_SQL = `(
  SELECT DISTINCT unnest(master_ids)
    FROM anthropic_batches
   WHERE results_fetched_at IS NULL
     AND status IN ('in_progress', 'canceling', 'ended')
)`;

export interface MasterCatalogListResult {
  rows: Array<Record<string, unknown> & {
    id: number;
    sku: string;
    filled_count: number;
  }>;
  page: number;
  pageSize: number;
  total: number;
}

export class MasterCatalogService {
  constructor(
    private readonly pool: Pool,
    private readonly logs: LogService
  ) {}

  /**
   * Запускається через job runner. jobId — це id поточного master_catalog_sync job.
   * Знаходить latest успішний finalize → бере DISTINCT article з products_final
   * → INSERT нові SKU у master_catalog (ON CONFLICT DO NOTHING).
   */
  async syncFromFinalize(jobId: number): Promise<MasterCatalogSyncSummary> {
    const startedAt = Date.now();
    const client = await this.pool.connect();
    let runId = 0;

    try {
      await client.query('BEGIN');

      // 1. Знайти latest finalize job (як джерело останньої версії products_final).
      const finalizeRes = await client.query<{ id: number }>(
        `SELECT id FROM jobs WHERE type = 'finalize' AND status = 'success'
         ORDER BY id DESC LIMIT 1`
      );
      const sourceJobId = finalizeRes.rows[0]?.id || null;

      // 2. Створити run-запис у master_catalog_sync_runs.
      const runRes = await client.query<{ id: number }>(
        `INSERT INTO master_catalog_sync_runs (job_id, source_job_id, status)
         VALUES ($1, $2, 'running') RETURNING id::int AS id`,
        [jobId, sourceJobId]
      );
      runId = runRes.rows[0].id;

      await this.logs.log(jobId, 'info', 'master_catalog_sync start', {
        runId,
        sourceJobId
      });

      // 3. Кількість унікальних SKU у products_final.
      // Беремо ВСІ products_final (не лише з sourceJobId) — бо finalize де-дуплікує
      // тільки за article+size, а article може повторюватись між job-ами (різні
      // постачальники). За весь час колекції.
      const sourceCountRes = await client.query<{ cnt: number }>(
        `SELECT COUNT(DISTINCT article)::int AS cnt
           FROM products_final
          WHERE article IS NOT NULL AND btrim(article) <> ''`
      );
      const sourceSkuCount = sourceCountRes.rows[0]?.cnt || 0;

      // 4. Insert. ON CONFLICT DO NOTHING — старі SKU зберігаються незмінні
      //    (бо у них вже може бути AI/feed дані заповнені).
      const insertRes = await client.query<{ inserted: number }>(
        `WITH src AS (
           SELECT DISTINCT article AS sku
             FROM products_final
            WHERE article IS NOT NULL AND btrim(article) <> ''
         ),
         ins AS (
           INSERT INTO master_catalog (sku, source_job_id)
           SELECT sku, $1 FROM src
           ON CONFLICT (sku) DO NOTHING
           RETURNING id
         )
         SELECT COUNT(*)::int AS inserted FROM ins`,
        [sourceJobId]
      );
      const inserted = insertRes.rows[0]?.inserted || 0;
      const skipped = sourceSkuCount - inserted;
      const durationMs = Date.now() - startedAt;

      await client.query(
        `UPDATE master_catalog_sync_runs
            SET status = 'finished',
                source_sku_count = $2,
                inserted = $3,
                skipped = $4,
                duration_ms = $5,
                finished_at = NOW()
          WHERE id = $1`,
        [runId, sourceSkuCount, inserted, skipped, durationMs]
      );

      await client.query('COMMIT');

      await this.logs.log(jobId, 'info', 'master_catalog_sync finished', {
        runId,
        sourceJobId,
        sourceSkuCount,
        inserted,
        skipped,
        durationMs
      });

      return {
        runId,
        jobId,
        sourceJobId,
        sourceSkuCount,
        inserted,
        skipped,
        durationMs
      };
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      const durationMs = Date.now() - startedAt;
      if (runId > 0) {
        await this.pool
          .query(
            `UPDATE master_catalog_sync_runs
                SET status = 'failed', error = $2, duration_ms = $3, finished_at = NOW()
              WHERE id = $1`,
            [runId, err instanceof Error ? err.message : String(err), durationMs]
          )
          .catch(() => undefined);
      }
      throw err;
    } finally {
      client.release();
    }
  }

  /** Спільний WHERE-білдер для listMasters / listMasterIds. */
  private buildListWhere(filters: MasterCatalogListFilters): { whereSql: string; params: unknown[] } {
    const where: string[] = [];
    const params: unknown[] = [];

    if (filters.search) {
      params.push(`%${filters.search}%`);
      where.push(`sku ILIKE $${params.length}`);
    }
    if (filters.hasName === true) where.push(`name_uk IS NOT NULL AND btrim(name_uk) <> ''`);
    if (filters.hasName === false) where.push(`(name_uk IS NULL OR btrim(name_uk) = '')`);
    if (filters.hasFeed === true) where.push(`feed_matched_at IS NOT NULL`);
    if (filters.hasFeed === false) where.push(`feed_matched_at IS NULL`);
    if (filters.hasAi === true) where.push(`ai_enriched_at IS NOT NULL`);
    if (filters.hasAi === false) where.push(`ai_enriched_at IS NULL`);
    if (filters.pendingBatch === true) where.push(`id IN ${PENDING_BATCH_IDS_SQL}`);
    if (filters.pendingBatch === false) where.push(`id NOT IN ${PENDING_BATCH_IDS_SQL}`);
    // Повнота результату — лише серед уже опрацьованих (ai_enriched_at IS NOT NULL).
    if (filters.completeness === 'no_desc') {
      where.push(
        `ai_enriched_at IS NOT NULL AND (description_full_uk IS NULL OR btrim(description_full_uk) = '')`
      );
    }
    if (filters.completeness === 'incomplete') {
      where.push(`ai_enriched_at IS NOT NULL AND (${FILLED_COUNT_EXPR}) < ${INCOMPLETE_FILLED_THRESHOLD}`);
    }
    if (filters.isActive === true) where.push(`is_active = TRUE`);
    if (filters.isActive === false) where.push(`is_active = FALSE`);

    return { whereSql: where.length > 0 ? `WHERE ${where.join(' AND ')}` : '', params };
  }

  /** Сортування — whitelisted щоб не було SQL injection через raw value. */
  private resolveOrderBy(sort: string | undefined): string {
    const allowedSort: Record<string, string> = {
      sku_asc: 'sku ASC',
      sku_desc: 'sku DESC',
      newest: 'created_at DESC',
      oldest: 'created_at ASC',
      filled_desc: 'filled_count DESC, sku ASC',
      filled_asc: 'filled_count ASC, sku ASC'
    };
    return allowedSort[sort && allowedSort[sort] ? sort : 'newest'];
  }

  async listMasters(filters: MasterCatalogListFilters): Promise<MasterCatalogListResult> {
    const page = Math.max(1, Math.trunc(filters.page || 1));
    const pageSize = Math.min(200, Math.max(1, Math.trunc(filters.pageSize || 50)));
    const offset = (page - 1) * pageSize;

    const { whereSql, params } = this.buildListWhere(filters);
    const orderBy = this.resolveOrderBy(filters.sort);

    // filled_count — скільки з 23 атрибутних полів заповнені.
    const filledExpr = FILLED_COUNT_EXPR;

    params.push(pageSize, offset);
    const limitParamIdx = params.length - 1;
    const offsetParamIdx = params.length;

    const sql = `
      SELECT
        id, sku, name_uk, brand, category_uk, photo,
        feed_matched_at, ai_enriched_at, is_active,
        created_at, updated_at,
        (id IN ${PENDING_BATCH_IDS_SQL}) AS pending_batch,
        (${filledExpr})::int AS filled_count,
        COUNT(*) OVER()::int AS total
      FROM master_catalog
      ${whereSql}
      ORDER BY ${orderBy}
      LIMIT $${limitParamIdx} OFFSET $${offsetParamIdx}
    `;

    const res = await this.pool.query(sql, params);
    const total = Number(res.rows[0]?.total || 0);
    return {
      rows: res.rows.map((r) => {
        const { total: _t, ...rest } = r;
        return rest as never;
      }),
      page,
      pageSize,
      total
    };
  }

  /**
   * Глобальна статистика каталогу — щоб одним поглядом бачити прогрес
   * і не плутати, які SKU вже пройшли через AI, які в черзі, які лишились.
   */
  async stats(): Promise<MasterCatalogStats> {
    const res = await this.pool.query<{
      total: number;
      with_feed: number;
      ai_enriched: number;
      pending_batch: number;
      fresh: number;
      no_description: number;
      incomplete: number;
    }>(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE feed_matched_at IS NOT NULL)::int AS with_feed,
        COUNT(*) FILTER (WHERE ai_enriched_at IS NOT NULL)::int AS ai_enriched,
        COUNT(*) FILTER (WHERE id IN ${PENDING_BATCH_IDS_SQL})::int AS pending_batch,
        COUNT(*) FILTER (
          WHERE feed_matched_at IS NOT NULL
            AND ai_enriched_at IS NULL
            AND id NOT IN ${PENDING_BATCH_IDS_SQL}
        )::int AS fresh,
        COUNT(*) FILTER (
          WHERE ai_enriched_at IS NOT NULL
            AND (description_full_uk IS NULL OR btrim(description_full_uk) = '')
        )::int AS no_description,
        COUNT(*) FILTER (
          WHERE ai_enriched_at IS NOT NULL
            AND (${FILLED_COUNT_EXPR}) < ${INCOMPLETE_FILLED_THRESHOLD}
        )::int AS incomplete
      FROM master_catalog
    `);
    const r = res.rows[0];
    return {
      total: Number(r?.total || 0),
      withFeed: Number(r?.with_feed || 0),
      aiEnriched: Number(r?.ai_enriched || 0),
      pendingBatch: Number(r?.pending_batch || 0),
      fresh: Number(r?.fresh || 0),
      noDescription: Number(r?.no_description || 0),
      incomplete: Number(r?.incomplete || 0)
    };
  }

  /**
   * Перші N id за фільтрами (для "обрати перші 10/50/100" в UI).
   * Той самий WHERE/sort що у listMasters, але тільки id — швидко і без пагінації.
   */
  async listMasterIds(filters: MasterCatalogListFilters, limit: number): Promise<number[]> {
    // До 60k — щоб «обрати всі за фільтром» працювало на повному каталозі.
    const capped = Math.min(60000, Math.max(1, Math.trunc(limit || 10)));
    const { whereSql, params } = this.buildListWhere(filters);
    const orderBy = this.resolveOrderBy(filters.sort);

    // filled_count потрібен тільки якщо сортуємо за заповненістю.
    const needsFilled = orderBy.includes('filled_count');
    const filledExpr = needsFilled
      ? MASTER_CATALOG_FIELDS.map(
          (f) =>
            `(CASE WHEN ${f} IS NOT NULL${
              f === 'old_price' ? '' : ` AND btrim(${f}::text) <> ''`
            } THEN 1 ELSE 0 END)`
        ).join(' + ')
      : null;

    params.push(capped);
    const sql = `
      SELECT id${filledExpr ? `, (${filledExpr})::int AS filled_count` : ''}
      FROM master_catalog
      ${whereSql}
      ORDER BY ${orderBy}
      LIMIT $${params.length}
    `;
    const res = await this.pool.query<{ id: number }>(sql, params);
    return res.rows.map((r) => Number(r.id));
  }

  /**
   * Рядки для XLSX-експорту: sku + 23 поля + AI метадані.
   * In-memory expоrt, тому cap 50k рядків (поточний каталог ~27-40k — ок).
   */
  async listForExport(
    filters: MasterCatalogListFilters,
    limit = 50_000
  ): Promise<Array<Record<string, unknown>>> {
    const capped = Math.min(50_000, Math.max(1, Math.trunc(limit || 50_000)));
    const { whereSql, params } = this.buildListWhere(filters);
    const orderBy = this.resolveOrderBy(filters.sort);
    const needsFilled = orderBy.includes('filled_count');
    const filledExpr = FILLED_COUNT_EXPR;

    params.push(capped);
    const sql = `
      SELECT sku, ${MASTER_CATALOG_FIELDS.join(', ')},
             ${needsFilled ? `(${filledExpr})::int AS filled_count,` : ''}
             feed_source, ai_enriched_at, ai_model, ai_prompt_version
      FROM master_catalog
      ${whereSql}
      ORDER BY ${orderBy}
      LIMIT $${params.length}
    `;
    const res = await this.pool.query(sql, params);
    return res.rows as Array<Record<string, unknown>>;
  }

  async getMaster(idOrSku: string | number): Promise<Record<string, unknown> | null> {
    const isNumeric = typeof idOrSku === 'number' || /^\d+$/.test(String(idOrSku));
    const sql = isNumeric
      ? `SELECT * FROM master_catalog WHERE id = $1`
      : `SELECT * FROM master_catalog WHERE sku = $1`;
    const value = isNumeric ? Number(idOrSku) : String(idOrSku);
    const res = await this.pool.query(sql, [value]);
    return res.rowCount === 0 ? null : (res.rows[0] as Record<string, unknown>);
  }

  async listSyncRuns(limit = 10): Promise<Array<Record<string, unknown>>> {
    const res = await this.pool.query(
      `SELECT id, job_id, source_job_id, status, source_sku_count,
              inserted, skipped, duration_ms, error, started_at, finished_at
         FROM master_catalog_sync_runs
        ORDER BY id DESC LIMIT $1`,
      [Math.min(50, Math.max(1, limit))]
    );
    return res.rows as Array<Record<string, unknown>>;
  }
}
