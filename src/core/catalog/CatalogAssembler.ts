import type { Pool, PoolClient } from 'pg';
import { LogService } from '../pipeline/log';

/**
 * CatalogAssembler — будує/оновлює офлайн каталог товарів з даних постачальників.
 * Незалежний від CS-Cart store_mirror.
 *
 * Два режими:
 *   * Full rebuild   — TRUNCATE catalog_offers + повна збірка для всіх 159 джерел.
 *   * Per-supplier   — DELETE catalog_offers для 1 постачальника + цільова збірка
 *                      його offers, re-aggregate тільки зачеплених master_id.
 *                      Швидко (секунди), не зачіпає інших постачальників.
 *
 * Skip detection (за замовчуванням):
 *   * Перед роботою — порівнюємо MAX(products_raw.created_at) з MAX(catalog_offers.assembled_at).
 *   * Якщо нових даних немає — повертаємо skipped=true, нічого не робимо.
 *   * force=true — пропустити перевірку (наприклад при зміні master_fields/mapping).
 *
 * Збереження:
 *   * catalog_master_field_values (ручні правки картки) — НЕ ЗАЧІПАЄМО ніколи.
 *     Це окрема таблиця з FK на catalog_masters(id); rebuild offers/variants
 *     до неї не доходить (немає CASCADE з offers).
 *   * catalog_masters — UPSERT (id зберігаються), display_article / агрегати оновлюються.
 *   * catalog_variants — full rebuild у Full mode; partial у per-supplier (нові sizes додаються).
 *   * catalog_offers — TRUNCATE+INSERT у Full; DELETE WHERE supplier=X + INSERT у per-supplier.
 *
 * Нормалізація:
 *   * size_mappings — застосовується через pf_norm (size_to).
 *   * color_mappings, category_mappings — пост-обробка field_values після INSERT.
 */

export interface CatalogAssembleOptions {
  /** Якщо задано — збираємо тільки цього постачальника. */
  supplierId?: number | null;
  /** Пропустити skip-detection (примусово зібрати). */
  force?: boolean;
}

export interface CatalogAssemblyRunSummary {
  runId: number;
  jobId: number;
  scope: 'full' | 'supplier';
  supplierId: number | null;
  skipped: boolean;
  skipReason?: string;
  sourceArticles: number;
  mastersUpserted: number;
  variantsInserted: number;
  offersInserted: number;
  affectedMasters: number;
  durationMs: number;
}

export class CatalogAssembler {
  constructor(
    private readonly pool: Pool,
    private readonly logs: LogService
  ) {}

  async run(jobId: number, opts: CatalogAssembleOptions = {}): Promise<CatalogAssemblyRunSummary> {
    const supplierId = opts.supplierId ?? null;
    const force = opts.force ?? false;
    const scope: 'full' | 'supplier' = supplierId ? 'supplier' : 'full';

    // 0. Skip-if-unchanged. Якщо немає нових products_raw з часу останнього зборки
    // (на рівні постачальника, або глобально) — повертаємо skipped.
    if (!force) {
      const skip = await this.shouldSkip(supplierId);
      if (skip.skip) {
        await this.logs.log(jobId, 'info', 'catalog_assemble skipped: no changes', {
          scope, supplierId, reason: skip.reason
        });
        return {
          runId: 0,
          jobId,
          scope,
          supplierId,
          skipped: true,
          skipReason: skip.reason,
          sourceArticles: 0,
          mastersUpserted: 0,
          variantsInserted: 0,
          offersInserted: 0,
          affectedMasters: 0,
          durationMs: 0
        };
      }
    }

    if (supplierId) {
      return this.runForSupplier(jobId, supplierId);
    }
    return this.runFull(jobId);
  }

  /**
   * Skip-detection: перевіряємо чи джерельні дані або конфіг змінились з часу
   * останнього catalog_assemble. Враховуємо:
   *   - products_raw — сирі дані постачальника (нові імпорти)
   *   - column_mappings — мапінг полів (новий мапінг = ре-витяг field_values)
   *   - master_fields — список master-полів (новий key = ре-витяг)
   *   - color_mappings / category_mappings — правила нормалізації (новий = ре-нормалізація)
   *   - size_mappings — нормалізація розмірів
   *
   * Якщо MAX(будь-яке з цих) > MAX(catalog_offers.assembled_at) → не skip.
   * Іначе → skip з reason='no_changes_since_last_assemble'.
   */
  private async shouldSkip(
    supplierId: number | null
  ): Promise<{ skip: boolean; reason?: string }> {
    const supplierFilter = supplierId ? 'WHERE supplier_id = $1' : '';
    const params = supplierId ? [supplierId] : [];

    const r = await this.pool.query<{ source_max: string | null; co_max: string | null }>(
      `SELECT
         (
           SELECT MAX(t)::text FROM (
             SELECT MAX(created_at) AS t FROM products_raw    ${supplierFilter}
             UNION ALL SELECT MAX(created_at)                 FROM column_mappings ${supplierFilter}
             UNION ALL SELECT MAX(updated_at)                 FROM master_fields
             UNION ALL SELECT MAX(created_at)                 FROM color_mappings
             UNION ALL SELECT MAX(created_at)                 FROM category_mappings
             UNION ALL SELECT MAX(created_at)                 FROM size_mappings
           ) src
         ) AS source_max,
         (SELECT MAX(assembled_at)::text FROM catalog_offers ${supplierFilter}) AS co_max`,
      params
    );
    const { source_max, co_max } = r.rows[0] || {};

    if (!source_max) {
      return {
        skip: true,
        reason: supplierId ? 'supplier_has_no_source_data' : 'no_source_data'
      };
    }
    if (!co_max) return { skip: false }; // ніколи не збирали — однозначно треба
    if (source_max <= co_max) {
      return { skip: true, reason: 'no_changes_since_last_assemble' };
    }
    return { skip: false };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // FULL REBUILD
  // ─────────────────────────────────────────────────────────────────────────
  private async runFull(jobId: number): Promise<CatalogAssemblyRunSummary> {
    const startedAt = Date.now();
    const client = await this.pool.connect();
    let runId = 0;

    try {
      await client.query('BEGIN');

      const runRes = await client.query<{ id: number }>(
        `INSERT INTO catalog_assembly_runs (job_id, status)
         VALUES ($1, 'running') RETURNING id::bigint::int AS id`,
        [jobId]
      );
      runId = runRes.rows[0].id;
      await this.logs.log(jobId, 'info', 'catalog_assemble FULL: start', { runId });

      const sourceArticlesRes = await client.query<{ cnt: number }>(
        `SELECT COUNT(DISTINCT normalize_article(article))::int AS cnt FROM products_final`
      );
      const sourceArticles = sourceArticlesRes.rows[0]?.cnt || 0;

      const fieldKeys = await this.loadFieldKeys(client);

      // UPSERT masters з усіх products_final.
      await client.query(`
        WITH src AS (
          SELECT DISTINCT ON (normalize_article(article))
                 normalize_article(article) AS article_key, article AS display_article
            FROM products_final
           WHERE article IS NOT NULL AND btrim(article) <> ''
           ORDER BY normalize_article(article), length(article), article
        )
        INSERT INTO catalog_masters (article_key, display_article, updated_at)
        SELECT article_key, display_article, NOW() FROM src
        ON CONFLICT (article_key) DO UPDATE SET
          display_article = EXCLUDED.display_article,
          updated_at = NOW()
      `);
      const mastersCount = await this.singleCount(
        client,
        `SELECT COUNT(*)::int AS cnt FROM catalog_masters`
      );

      // Wipe derived caches + setup temp tables.
      await client.query('DELETE FROM catalog_offers');
      await client.query('DELETE FROM catalog_variants');
      await this.buildTempPfNorm(client, /* supplierId */ null);
      await this.buildTempLatestRaw(client, null);
      await this.buildTempLatestMappings(client);

      // Insert variants.
      const variantsRes = await client.query(`
        INSERT INTO catalog_variants (master_id, size_raw, size)
        SELECT DISTINCT ON (cm.id, COALESCE(pn.size_norm, ''))
               cm.id, pn.size_raw, pn.size_norm
          FROM pf_norm pn
          JOIN catalog_masters cm ON cm.article_key = pn.article_key
         ORDER BY cm.id, COALESCE(pn.size_norm, ''), pn.size_raw
        ON CONFLICT (master_id, COALESCE(size, '')) DO NOTHING
      `);
      const variantsInserted = variantsRes.rowCount || 0;

      // Insert offers.
      const offersRes = await client.query(this.insertOffersSql(), [fieldKeys]);
      const offersInserted = offersRes.rowCount || 0;

      // Apply post-extract normalization (color/category mappings).
      await this.applyNormalizationFromMappings(client);

      // Aggregate всі masters/variants/merged-attrs (FULL).
      await this.aggregateVariants(client, /* affectedMasterIds */ null);
      await this.aggregateMasters(client, jobId, null);
      await this.rebuildMergedAttrs(client, null);
      await this.rebuildMergedFieldValues(client, null);

      const durationMs = Date.now() - startedAt;

      await client.query(
        `UPDATE catalog_assembly_runs SET
           status='finished', source_articles=$2,
           masters_upserted=$3, variants_inserted=$4, offers_inserted=$5,
           duration_ms=$6, finished_at=NOW()
         WHERE id=$1`,
        [runId, sourceArticles, mastersCount, variantsInserted, offersInserted, durationMs]
      );

      await client.query('COMMIT');

      return {
        runId, jobId,
        scope: 'full', supplierId: null, skipped: false,
        sourceArticles, mastersUpserted: mastersCount, variantsInserted, offersInserted,
        affectedMasters: mastersCount, durationMs
      };
    } catch (err) {
      await this.safeRollback(client);
      await this.markRunFailed(runId, err, Date.now() - startedAt);
      throw err;
    } finally {
      client.release();
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PER-SUPPLIER REBUILD
  // ─────────────────────────────────────────────────────────────────────────
  private async runForSupplier(
    jobId: number,
    supplierId: number
  ): Promise<CatalogAssemblyRunSummary> {
    const startedAt = Date.now();
    const client = await this.pool.connect();
    let runId = 0;

    try {
      await client.query('BEGIN');

      const runRes = await client.query<{ id: number }>(
        `INSERT INTO catalog_assembly_runs (job_id, status)
         VALUES ($1, 'running') RETURNING id::bigint::int AS id`,
        [jobId]
      );
      runId = runRes.rows[0].id;
      await this.logs.log(jobId, 'info', 'catalog_assemble SUPPLIER: start', {
        runId, supplierId
      });

      const sourceArticlesRes = await client.query<{ cnt: number }>(
        `SELECT COUNT(DISTINCT normalize_article(article))::int AS cnt
         FROM products_final WHERE supplier_id = $1`,
        [supplierId]
      );
      const sourceArticles = sourceArticlesRes.rows[0]?.cnt || 0;

      const fieldKeys = await this.loadFieldKeys(client);

      // 1. Запам'ятовуємо masters що ВЖЕ мали offers від цього supplier (для re-aggregate).
      const previousMastersRes = await client.query<{ id: number }>(
        `SELECT DISTINCT master_id::bigint::int AS id
           FROM catalog_offers WHERE supplier_id = $1`,
        [supplierId]
      );
      const previousMasterIds = new Set<number>(previousMastersRes.rows.map((r) => r.id));

      // 2. UPSERT masters з products_final цього постачальника (нові article = нові masters).
      await client.query(
        `WITH src AS (
           SELECT DISTINCT ON (normalize_article(article))
                  normalize_article(article) AS article_key, article AS display_article
             FROM products_final
            WHERE supplier_id = $1 AND article IS NOT NULL AND btrim(article) <> ''
            ORDER BY normalize_article(article), length(article), article
         )
         INSERT INTO catalog_masters (article_key, display_article, updated_at)
         SELECT article_key, display_article, NOW() FROM src
         ON CONFLICT (article_key) DO UPDATE SET
           display_article = EXCLUDED.display_article,
           updated_at = NOW()`,
        [supplierId]
      );

      // 3. DELETE catalog_offers тільки цього supplier.
      const deletedRes = await client.query(
        `DELETE FROM catalog_offers WHERE supplier_id = $1`,
        [supplierId]
      );
      await this.logs.log(jobId, 'info', 'catalog_assemble SUPPLIER: offers wiped', {
        deleted: deletedRes.rowCount || 0
      });

      // 4. Temp tables (filtered by supplier).
      await this.buildTempPfNorm(client, supplierId);
      await this.buildTempLatestRaw(client, supplierId);
      await this.buildTempLatestMappings(client);

      // 5. INSERT variants for new (master, size) — DO NOTHING якщо вже є.
      const variantsRes = await client.query(`
        INSERT INTO catalog_variants (master_id, size_raw, size)
        SELECT DISTINCT ON (cm.id, COALESCE(pn.size_norm, ''))
               cm.id, pn.size_raw, pn.size_norm
          FROM pf_norm pn
          JOIN catalog_masters cm ON cm.article_key = pn.article_key
         ORDER BY cm.id, COALESCE(pn.size_norm, ''), pn.size_raw
        ON CONFLICT (master_id, COALESCE(size, '')) DO NOTHING
      `);
      const variantsInserted = variantsRes.rowCount || 0;

      // 6. INSERT offers for this supplier.
      const offersRes = await client.query(this.insertOffersSql(), [fieldKeys]);
      const offersInserted = offersRes.rowCount || 0;

      // 7. Apply normalization (color/category) — тільки для нових offers цього supplier.
      await this.applyNormalizationFromMappings(client, supplierId);

      // 8. Зібрати ID зачеплених masters (старі + нові).
      const currentMastersRes = await client.query<{ id: number }>(
        `SELECT DISTINCT master_id::bigint::int AS id
           FROM catalog_offers WHERE supplier_id = $1`,
        [supplierId]
      );
      const affectedSet = new Set<number>(previousMasterIds);
      for (const r of currentMastersRes.rows) affectedSet.add(r.id);
      const affectedMasterIds = Array.from(affectedSet);
      await this.logs.log(jobId, 'info', 'catalog_assemble SUPPLIER: affected masters', {
        affected: affectedMasterIds.length
      });

      // 9. Re-aggregate ТІЛЬКИ зачеплені masters/variants/merged-attrs.
      await this.aggregateVariants(client, affectedMasterIds);
      await this.aggregateMasters(client, jobId, affectedMasterIds);
      await this.rebuildMergedAttrs(client, affectedMasterIds);
      await this.rebuildMergedFieldValues(client, affectedMasterIds);

      const durationMs = Date.now() - startedAt;

      // Підрахунок mastersUpserted (тільки cz цього прогону).
      const mastersUpsertedRes = await client.query<{ cnt: number }>(
        `SELECT COUNT(DISTINCT article_key)::int AS cnt
           FROM catalog_masters cm
          WHERE cm.id = ANY($1::bigint[])`,
        [affectedMasterIds]
      );
      const mastersUpserted = mastersUpsertedRes.rows[0]?.cnt || 0;

      await client.query(
        `UPDATE catalog_assembly_runs SET
           status='finished', source_articles=$2,
           masters_upserted=$3, variants_inserted=$4, offers_inserted=$5,
           duration_ms=$6, finished_at=NOW()
         WHERE id=$1`,
        [runId, sourceArticles, mastersUpserted, variantsInserted, offersInserted, durationMs]
      );

      await client.query('COMMIT');

      return {
        runId, jobId,
        scope: 'supplier', supplierId, skipped: false,
        sourceArticles, mastersUpserted, variantsInserted, offersInserted,
        affectedMasters: affectedMasterIds.length, durationMs
      };
    } catch (err) {
      await this.safeRollback(client);
      await this.markRunFailed(runId, err, Date.now() - startedAt);
      throw err;
    } finally {
      client.release();
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ПРИВАТНІ ПОМІЧНИКИ
  // ─────────────────────────────────────────────────────────────────────────

  private async loadFieldKeys(client: PoolClient): Promise<string[]> {
    const r = await client.query<{ key: string }>(
      `SELECT key FROM master_fields WHERE is_active = true ORDER BY sort_order ASC, id ASC`
    );
    return r.rows.map((x) => x.key);
  }

  /**
   * Temp pf_norm — products_final + нормалізований size через size_mappings.
   * Якщо supplierId — фільтрується по supplier_id.
   */
  private async buildTempPfNorm(client: PoolClient, supplierId: number | null): Promise<void> {
    const supplierFilter = supplierId ? 'WHERE pf.supplier_id = $1' : '';
    const params = supplierId ? [supplierId] : [];
    await client.query(
      `CREATE TEMP TABLE pf_norm ON COMMIT DROP AS
       SELECT
         pf.id              AS final_id,
         pf.article         AS article,
         normalize_article(pf.article) AS article_key,
         pf.size            AS size_raw,
         NULLIF(COALESCE(szm.size_to, UPPER(btrim(pf.size))), '') AS size_norm,
         pf.supplier_id     AS supplier_id,
         pf.quantity        AS quantity,
         pf.price_base      AS price_base,
         pf.price_final     AS price_final,
         pf.extra           AS extra,
         pf.comment_text    AS comment_text
       FROM products_final pf
       LEFT JOIN size_mappings szm
         ON LOWER(btrim(szm.size_from)) = LOWER(btrim(pf.size)) AND szm.is_active = true
       ${supplierFilter}`,
      params
    );
    await client.query(
      `CREATE INDEX pf_norm_lookup_idx ON pf_norm (article_key, COALESCE(size_norm, ''))`
    );
    await client.query(
      `CREATE INDEX pf_norm_supplier_idx ON pf_norm (supplier_id, article)`
    );
  }

  private async buildTempLatestRaw(client: PoolClient, supplierId: number | null): Promise<void> {
    const supplierFilter = supplierId ? 'WHERE supplier_id = $1' : '';
    const params = supplierId ? [supplierId] : [];
    await client.query(
      `CREATE TEMP TABLE latest_raw ON COMMIT DROP AS
       SELECT DISTINCT ON (supplier_id, article, COALESCE(size, ''))
              id AS raw_id, supplier_id, source_id, article, size, row_data
         FROM products_raw
         ${supplierFilter}
        ORDER BY supplier_id, article, COALESCE(size, ''), job_id DESC NULLS LAST, id DESC`,
      params
    );
    await client.query(
      `CREATE INDEX latest_raw_lookup_idx ON latest_raw (supplier_id, article, COALESCE(size, ''))`
    );
  }

  private async buildTempLatestMappings(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TEMP TABLE latest_mappings ON COMMIT DROP AS
      SELECT DISTINCT ON (supplier_id, source_id)
             supplier_id, source_id, mapping,
             COALESCE(mapping_meta->'headers', '{}'::jsonb) AS headers
        FROM column_mappings
       ORDER BY supplier_id, source_id, id DESC
    `);
    await client.query(
      `CREATE INDEX latest_mappings_idx ON latest_mappings (supplier_id, source_id)`
    );
  }

  /** Shared INSERT statement — приймає $1 = field_keys text[]. */
  private insertOffersSql(): string {
    return `
      INSERT INTO catalog_offers (
        master_id, variant_id, supplier_id, source_id,
        article, size, quantity, price_base, price_final, extra, comment_text,
        row_data, field_values, final_id, raw_id, assembled_at
      )
      SELECT
        cm.id,
        cv.id,
        pn.supplier_id,
        lr.source_id,
        pn.article,
        pn.size_raw,
        pn.quantity,
        pn.price_base,
        pn.price_final,
        pn.extra,
        pn.comment_text,
        build_row_object_from_array(lr.row_data, lm.mapping, lm.headers),
        extract_field_values(lr.row_data, lm.mapping, $1::text[]),
        pn.final_id,
        lr.raw_id,
        NOW()
      FROM pf_norm pn
      JOIN catalog_masters cm ON cm.article_key = pn.article_key
      LEFT JOIN catalog_variants cv
        ON cv.master_id = cm.id
       AND COALESCE(cv.size, '') = COALESCE(pn.size_norm, '')
      LEFT JOIN latest_raw lr
        ON lr.supplier_id = pn.supplier_id
       AND lr.article = pn.article
       AND COALESCE(lr.size, '') = COALESCE(pn.size_raw, '')
      LEFT JOIN latest_mappings lm
        ON lm.supplier_id = pn.supplier_id
       AND lm.source_id = lr.source_id
      ON CONFLICT (master_id, supplier_id, article, COALESCE(size, '')) DO NOTHING
    `;
  }

  /**
   * Пост-обробка: застосовуємо color_mappings + category_mappings до field_values.
   * Якщо supplierId — обмежуємо область одним постачальником.
   * Тільки is_active=true rules.
   */
  private async applyNormalizationFromMappings(
    client: PoolClient,
    supplierId: number | null = null
  ): Promise<void> {
    const supplierFilter = supplierId ? 'AND co.supplier_id = $1' : '';
    const params = supplierId ? [supplierId] : [];

    // Color: field_values[color_uk] (case-insensitive) → color_mappings.color_to.
    await client.query(
      `UPDATE catalog_offers co
          SET field_values = jsonb_set(co.field_values, '{color_uk}', to_jsonb(cm.color_to))
         FROM color_mappings cm
        WHERE jsonb_typeof(co.field_values) = 'object'
          AND co.field_values ? 'color_uk'
          AND LOWER(btrim(co.field_values->>'color_uk')) = LOWER(btrim(cm.color_from))
          AND cm.is_active = true
          ${supplierFilter}`,
      params
    );

    // Category: field_values[category_uk] → category_mappings.category_to.
    await client.query(
      `UPDATE catalog_offers co
          SET field_values = jsonb_set(co.field_values, '{category_uk}', to_jsonb(catm.category_to))
         FROM category_mappings catm
        WHERE jsonb_typeof(co.field_values) = 'object'
          AND co.field_values ? 'category_uk'
          AND LOWER(btrim(co.field_values->>'category_uk')) = LOWER(btrim(catm.category_from))
          AND catm.is_active = true
          ${supplierFilter}`,
      params
    );
  }

  /** Aggregate catalog_variants stats. Якщо affectedMasterIds — тільки ці. */
  private async aggregateVariants(
    client: PoolClient,
    affectedMasterIds: number[] | null
  ): Promise<void> {
    // У per-supplier режимі обмежуємо ПІДЗАПИТ агрегації лише offers зачеплених мастерів —
    // інакше сканує всі 170K+ offers навіть для невеликого supplier (perf regression).
    const innerFilter = affectedMasterIds
      ? 'AND co.variant_id IN (SELECT id FROM catalog_variants WHERE master_id = ANY($1::bigint[]))'
      : '';
    const outerFilter = affectedMasterIds ? 'AND cv.master_id = ANY($1::bigint[])' : '';
    const params = affectedMasterIds ? [affectedMasterIds] : [];
    await client.query(
      `UPDATE catalog_variants cv SET
         offer_count    = COALESCE(ag.cnt, 0),
         supplier_count = COALESCE(ag.suppliers, 0),
         best_price     = ag.min_price,
         worst_price    = ag.max_price,
         total_qty      = COALESCE(ag.sum_qty, 0)
       FROM (
         SELECT co.variant_id,
                COUNT(*)::int                       AS cnt,
                COUNT(DISTINCT co.supplier_id)::int AS suppliers,
                MIN(co.price_final)                  AS min_price,
                MAX(co.price_final)                  AS max_price,
                COALESCE(SUM(co.quantity), 0)::int   AS sum_qty
           FROM catalog_offers co
          WHERE co.variant_id IS NOT NULL
            ${innerFilter}
          GROUP BY co.variant_id
       ) ag
       WHERE cv.id = ag.variant_id
       ${outerFilter}`,
      params
    );
    // Обнулити variants, де offers зникли (тільки серед зачеплених мастерів).
    await client.query(
      `UPDATE catalog_variants cv SET offer_count=0, supplier_count=0,
                                       best_price=NULL, worst_price=NULL, total_qty=0
         WHERE NOT EXISTS (SELECT 1 FROM catalog_offers co WHERE co.variant_id = cv.id)
         ${outerFilter}`,
      params
    );
  }

  /** Aggregate catalog_masters stats. Якщо affectedMasterIds — тільки ці. */
  private async aggregateMasters(
    client: PoolClient,
    jobId: number,
    affectedMasterIds: number[] | null
  ): Promise<void> {
    const idsFilter = affectedMasterIds ? `WHERE id = ANY($2::bigint[])` : '';
    const params = affectedMasterIds ? [jobId, affectedMasterIds] : [jobId];
    await client.query(
      `UPDATE catalog_masters cm SET
         variant_count         = COALESCE(vc.cnt, 0),
         offer_count           = COALESCE(oc.cnt, 0),
         supplier_count        = COALESCE(oc.suppliers, 0),
         best_price            = oc.min_price,
         worst_price           = oc.max_price,
         total_qty             = COALESCE(oc.sum_qty, 0),
         last_assembled_at     = NOW(),
         last_assembled_job_id = $1
       FROM (SELECT id FROM catalog_masters ${idsFilter}) all_m
       LEFT JOIN (
         SELECT master_id, COUNT(*)::int AS cnt
           FROM catalog_variants GROUP BY master_id
       ) vc ON vc.master_id = all_m.id
       LEFT JOIN (
         SELECT co.master_id,
                COUNT(*)::int                       AS cnt,
                COUNT(DISTINCT co.supplier_id)::int AS suppliers,
                MIN(co.price_final)                  AS min_price,
                MAX(co.price_final)                  AS max_price,
                COALESCE(SUM(co.quantity), 0)::int   AS sum_qty
           FROM catalog_offers co
          GROUP BY co.master_id
       ) oc ON oc.master_id = all_m.id
       WHERE cm.id = all_m.id`,
      params
    );
  }

  /** Перебудувати catalog_masters.merged_attributes (з row_data union by priority). */
  private async rebuildMergedAttrs(
    client: PoolClient,
    affectedMasterIds: number[] | null
  ): Promise<void> {
    const inUnpacked = affectedMasterIds ? 'AND co.master_id = ANY($1::bigint[])' : '';
    const params = affectedMasterIds ? [affectedMasterIds] : [];
    await client.query(
      `WITH unpacked AS (
         SELECT co.master_id, j.key, j.value, s.priority, co.id AS offer_id
           FROM catalog_offers co
           JOIN suppliers s ON s.id = co.supplier_id
           CROSS JOIN LATERAL jsonb_each_text(co.row_data) AS j(key, value)
          WHERE jsonb_typeof(co.row_data) = 'object'
            AND NULLIF(btrim(j.value), '') IS NOT NULL
            ${inUnpacked}
       ),
       deduped AS (
         SELECT DISTINCT ON (master_id, key) master_id, key, value
           FROM unpacked
          ORDER BY master_id, key, priority ASC, offer_id DESC
       ),
       agg AS (
         SELECT master_id, jsonb_object_agg(key, value) AS merged
           FROM deduped GROUP BY master_id
       )
       UPDATE catalog_masters cm
          SET merged_attributes = COALESCE(agg.merged, '{}'::jsonb)
         FROM agg
        WHERE cm.id = agg.master_id`,
      params
    );
    // Якщо масштер залишився без offers — обнулити merged_attributes.
    const clearFilter1 = affectedMasterIds ? 'AND id = ANY($1::bigint[])' : '';
    await client.query(
      `UPDATE catalog_masters SET merged_attributes = '{}'::jsonb
        WHERE offer_count = 0 AND merged_attributes <> '{}'::jsonb ${clearFilter1}`,
      params
    );
  }

  /** Перебудувати catalog_masters.merged_field_values (з field_values union by priority). */
  private async rebuildMergedFieldValues(
    client: PoolClient,
    affectedMasterIds: number[] | null
  ): Promise<void> {
    const inUnpacked = affectedMasterIds ? 'AND co.master_id = ANY($1::bigint[])' : '';
    const params = affectedMasterIds ? [affectedMasterIds] : [];
    await client.query(
      `WITH unpacked AS (
         SELECT co.master_id, j.key, j.value, s.priority, co.id AS offer_id
           FROM catalog_offers co
           JOIN suppliers s ON s.id = co.supplier_id
           CROSS JOIN LATERAL jsonb_each_text(co.field_values) AS j(key, value)
          WHERE jsonb_typeof(co.field_values) = 'object'
            AND NULLIF(btrim(j.value), '') IS NOT NULL
            ${inUnpacked}
       ),
       deduped AS (
         SELECT DISTINCT ON (master_id, key) master_id, key, value
           FROM unpacked
          ORDER BY master_id, key, priority ASC, offer_id DESC
       ),
       agg AS (
         SELECT master_id, jsonb_object_agg(key, value) AS merged
           FROM deduped GROUP BY master_id
       )
       UPDATE catalog_masters cm
          SET merged_field_values = COALESCE(agg.merged, '{}'::jsonb)
         FROM agg
        WHERE cm.id = agg.master_id`,
      params
    );
    const clearFilter2 = affectedMasterIds ? 'AND id = ANY($1::bigint[])' : '';
    await client.query(
      `UPDATE catalog_masters SET merged_field_values = '{}'::jsonb
        WHERE offer_count = 0 AND merged_field_values <> '{}'::jsonb ${clearFilter2}`,
      params
    );
  }

  private async singleCount(client: PoolClient, sql: string): Promise<number> {
    const r = await client.query<{ cnt: number }>(sql);
    return r.rows[0]?.cnt || 0;
  }

  private async safeRollback(client: PoolClient): Promise<void> {
    try { await client.query('ROLLBACK'); } catch (_e) { /* ignore */ }
  }

  private async markRunFailed(
    runId: number, err: unknown, durationMs: number
  ): Promise<void> {
    if (runId <= 0) return;
    await this.pool
      .query(
        `UPDATE catalog_assembly_runs
            SET status='failed', error=$2, duration_ms=$3, finished_at=NOW()
          WHERE id=$1 AND status='running'`,
        [runId, err instanceof Error ? err.message : String(err), durationMs]
      )
      .catch(() => undefined);
  }
}
