import type { Pool } from 'pg';

/**
 * Read + write API для нового catalog-каталогу (catalog_masters / catalog_variants /
 * catalog_offers / catalog_master_field_values).
 *
 * Окремо від існуючого core/admin/CatalogAdminService (який обслуговує постачальницький
 * pipeline). Тут — суто catalog (товари).
 */

export interface CatalogMasterListItem {
  id: number;
  articleKey: string;
  displayArticle: string;
  variantCount: number;
  offerCount: number;
  supplierCount: number;
  bestPrice: string | null;
  worstPrice: string | null;
  totalQty: number | null;
  lastAssembledAt: string | null;
  updatedAt: string;
}

export interface CatalogMasterListResult {
  rows: CatalogMasterListItem[];
  total: number;
  limit: number;
  offset: number;
}

export interface CatalogMasterListFilters {
  search?: string;
  hasOffers?: boolean | null;
  supplierId?: number | null;
  minOffers?: number | null;
  sort?: string;
  limit?: number;
  offset?: number;
}

export interface CatalogVariantRow {
  id: number;
  sizeRaw: string | null;
  size: string | null;
  offerCount: number;
  supplierCount: number;
  bestPrice: string | null;
  worstPrice: string | null;
  totalQty: number;
}

export interface CatalogOfferRow {
  id: number;
  variantId: number | null;
  supplierId: number;
  supplierName: string | null;
  supplierPriority: number | null;
  sourceId: number | null;
  article: string;
  size: string | null;
  quantity: number | null;
  priceBase: string | null;
  priceFinal: string | null;
  extra: string | null;
  commentText: string | null;
  rowData: Record<string, unknown>;
  fieldValues: Record<string, unknown>;
  finalId: number | null;
  rawId: number | null;
  assembledAt: string;
}

export interface CatalogMasterDetail {
  master: CatalogMasterListItem;
  mergedAttributes: Record<string, unknown>;
  mergedFieldValues: Record<string, unknown>;
  variants: CatalogVariantRow[];
  offers: CatalogOfferRow[];
}

export interface MasterFieldDefinition {
  id: number;
  key: string;
  labelUk: string;
  descriptionUk: string | null;
  dataType: string;
  isRequired: boolean;
  sortOrder: number;
  candidateHintKeys: string[];
  candidateCsFields: string[];
  isActive: boolean;
}

export interface CatalogMasterFieldValue {
  fieldId: number;
  value: string | null;
  source: string;
  sourceSupplierId: number | null;
  sourceSupplierName: string | null;
  sourceAttributeKey: string | null;
  updatedBy: string | null;
  updatedAt: string;
}

export interface CatalogFieldVariation {
  value: string;
  supplierNames: string[];
  supplierIds: number[];
  offerCount: number;
  bestPriority: number | null;     // min suppliers.priority серед джерел, що дали це значення
}

export interface CatalogMasterCard {
  master: CatalogMasterListItem;
  fields: MasterFieldDefinition[];
  fieldValues: Record<number, CatalogMasterFieldValue>;
  /** Варіації значень з мапінгу: для кожного master_field.key — distinct values з offers.field_values. */
  fieldVariations: Record<string, CatalogFieldVariation[]>;
  /** Best auto-suggestion з пріоритетного постачальника (1 значення на key). */
  mergedFieldValues: Record<string, string>;
}

export interface CatalogFieldValueInput {
  fieldId: number;
  value: string | null;
  source?: string;
  sourceSupplierId?: number | null;
  sourceAttributeKey?: string | null;
}

export interface CatalogAssemblyRunRecord {
  id: number;
  jobId: number | null;
  status: string;
  sourceArticles: number | null;
  mastersUpserted: number;
  variantsInserted: number;
  offersInserted: number;
  durationMs: number | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

const MASTER_LIST_SELECT = `
  SELECT
    cm.id::bigint::int           AS id,
    cm.article_key                AS "articleKey",
    cm.display_article            AS "displayArticle",
    cm.variant_count              AS "variantCount",
    cm.offer_count                AS "offerCount",
    cm.supplier_count             AS "supplierCount",
    cm.best_price::text           AS "bestPrice",
    cm.worst_price::text          AS "worstPrice",
    cm.total_qty                  AS "totalQty",
    cm.last_assembled_at::text    AS "lastAssembledAt",
    cm.updated_at::text           AS "updatedAt"
  FROM catalog_masters cm
`;

function clampLimit(v: number | undefined): number {
  const raw = Number.isFinite(v) ? Math.trunc(Number(v)) : 50;
  return Math.max(1, Math.min(200, raw));
}

function clampOffset(v: number | undefined): number {
  const raw = Number.isFinite(v) ? Math.trunc(Number(v)) : 0;
  return Math.max(0, raw);
}

function resolveSortClause(sortRaw: string | undefined): string {
  const sort = String(sortRaw || '').trim().toLowerCase();
  switch (sort) {
    case 'offer_count_asc':
      return 'cm.offer_count ASC NULLS LAST, cm.id ASC';
    case 'best_price_asc':
    case 'best_price':
      return 'cm.best_price ASC NULLS LAST, cm.id DESC';
    case 'best_price_desc':
      return 'cm.best_price DESC NULLS LAST, cm.id DESC';
    case 'variant_count_desc':
    case 'variant_count':
      return 'cm.variant_count DESC NULLS LAST, cm.id DESC';
    case 'article_asc':
      return 'cm.display_article ASC, cm.id ASC';
    case 'article_desc':
      return 'cm.display_article DESC, cm.id DESC';
    case 'updated_at_desc':
    case 'updated_at':
      return 'cm.updated_at DESC, cm.id DESC';
    default:
      return 'cm.offer_count DESC NULLS LAST, cm.id DESC';
  }
}

export class CatalogService {
  constructor(private readonly pool: Pool) {}

  async listMasters(filters: CatalogMasterListFilters): Promise<CatalogMasterListResult> {
    const limit = clampLimit(filters.limit);
    const offset = clampOffset(filters.offset);
    const sortClause = resolveSortClause(filters.sort);

    const where: string[] = [];
    const params: unknown[] = [];

    const search = String(filters.search || '').trim();
    if (search) {
      params.push(`%${search}%`);
      const idx = params.length;
      where.push(`(
        cm.display_article ILIKE $${idx}
        OR cm.article_key ILIKE $${idx}
        OR cm.merged_attributes::text ILIKE $${idx}
        OR cm.merged_field_values::text ILIKE $${idx}
      )`);
    }

    if (filters.hasOffers === true) where.push('cm.offer_count > 0');
    else if (filters.hasOffers === false) where.push('cm.offer_count = 0');

    const minOffers = Number(filters.minOffers);
    if (Number.isFinite(minOffers) && minOffers > 0) {
      params.push(Math.trunc(minOffers));
      where.push(`cm.offer_count >= $${params.length}`);
    }

    const supplierId = Number(filters.supplierId);
    if (Number.isFinite(supplierId) && supplierId > 0) {
      params.push(Math.trunc(supplierId));
      where.push(`EXISTS (
        SELECT 1 FROM catalog_offers co
        WHERE co.master_id = cm.id AND co.supplier_id = $${params.length}
      )`);
    }

    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const totalResult = await this.pool.query<{ cnt: string }>(
      `SELECT COUNT(*)::bigint AS cnt FROM catalog_masters cm ${whereClause}`,
      params
    );
    const total = Number(totalResult.rows[0]?.cnt || 0);

    params.push(limit);
    const limitIdx = params.length;
    params.push(offset);
    const offsetIdx = params.length;

    const rowsResult = await this.pool.query<CatalogMasterListItem>(
      `${MASTER_LIST_SELECT}
       ${whereClause}
       ORDER BY ${sortClause}
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params
    );

    return { rows: rowsResult.rows, total, limit, offset };
  }

  async getMaster(masterId: number): Promise<CatalogMasterDetail | null> {
    const masterRes = await this.pool.query<
      CatalogMasterListItem & { mergedAttributes: unknown; mergedFieldValues: unknown }
    >(
      `SELECT
         cm.id::bigint::int           AS id,
         cm.article_key                AS "articleKey",
         cm.display_article            AS "displayArticle",
         cm.variant_count              AS "variantCount",
         cm.offer_count                AS "offerCount",
         cm.supplier_count             AS "supplierCount",
         cm.best_price::text           AS "bestPrice",
         cm.worst_price::text          AS "worstPrice",
         cm.total_qty                  AS "totalQty",
         cm.last_assembled_at::text    AS "lastAssembledAt",
         cm.updated_at::text           AS "updatedAt",
         cm.merged_attributes          AS "mergedAttributes",
         cm.merged_field_values        AS "mergedFieldValues"
       FROM catalog_masters cm
       WHERE cm.id = $1
       LIMIT 1`,
      [masterId]
    );
    if (masterRes.rows.length === 0) return null;
    const m = masterRes.rows[0];

    const [variants, offers] = await Promise.all([
      this.listVariants(masterId),
      this.listOffers(masterId)
    ]);

    const master: CatalogMasterListItem = {
      id: m.id,
      articleKey: m.articleKey,
      displayArticle: m.displayArticle,
      variantCount: m.variantCount,
      offerCount: m.offerCount,
      supplierCount: m.supplierCount,
      bestPrice: m.bestPrice,
      worstPrice: m.worstPrice,
      totalQty: m.totalQty,
      lastAssembledAt: m.lastAssembledAt,
      updatedAt: m.updatedAt
    };

    return {
      master,
      mergedAttributes: (m.mergedAttributes as Record<string, unknown>) || {},
      mergedFieldValues: (m.mergedFieldValues as Record<string, unknown>) || {},
      variants,
      offers
    };
  }

  async listVariants(masterId: number): Promise<CatalogVariantRow[]> {
    const r = await this.pool.query<CatalogVariantRow>(
      `SELECT
         cv.id::bigint::int    AS id,
         cv.size_raw            AS "sizeRaw",
         cv.size                AS size,
         cv.offer_count         AS "offerCount",
         cv.supplier_count      AS "supplierCount",
         cv.best_price::text    AS "bestPrice",
         cv.worst_price::text   AS "worstPrice",
         cv.total_qty           AS "totalQty"
       FROM catalog_variants cv
       WHERE cv.master_id = $1
       ORDER BY cv.size NULLS LAST, cv.id`,
      [masterId]
    );
    return r.rows;
  }

  async listOffers(masterId: number): Promise<CatalogOfferRow[]> {
    const r = await this.pool.query<CatalogOfferRow>(
      `SELECT
         co.id::bigint::int           AS id,
         co.variant_id::bigint::int   AS "variantId",
         co.supplier_id::bigint::int  AS "supplierId",
         s.name                        AS "supplierName",
         s.priority                    AS "supplierPriority",
         co.source_id::bigint::int    AS "sourceId",
         co.article                    AS article,
         co.size                       AS size,
         co.quantity                   AS quantity,
         co.price_base::text           AS "priceBase",
         co.price_final::text          AS "priceFinal",
         co.extra                      AS extra,
         co.comment_text               AS "commentText",
         co.row_data                   AS "rowData",
         co.field_values               AS "fieldValues",
         co.final_id::bigint::int     AS "finalId",
         co.raw_id                     AS "rawId",
         co.assembled_at::text         AS "assembledAt"
       FROM catalog_offers co
       LEFT JOIN suppliers s ON s.id = co.supplier_id
       WHERE co.master_id = $1
       ORDER BY s.priority ASC NULLS LAST, co.supplier_id ASC, co.size NULLS FIRST`,
      [masterId]
    );
    return r.rows;
  }

  async listMasterFields(): Promise<MasterFieldDefinition[]> {
    const r = await this.pool.query<MasterFieldDefinition>(
      `SELECT
         id::bigint::int       AS id,
         key                    AS key,
         label_uk               AS "labelUk",
         description_uk         AS "descriptionUk",
         data_type              AS "dataType",
         is_required            AS "isRequired",
         sort_order             AS "sortOrder",
         candidate_hint_keys    AS "candidateHintKeys",
         candidate_cs_fields    AS "candidateCsFields",
         is_active              AS "isActive"
       FROM master_fields
       WHERE is_active = true
       ORDER BY sort_order ASC, id ASC`
    );
    return r.rows;
  }

  async getMasterCard(masterId: number): Promise<CatalogMasterCard | null> {
    const r = await this.pool.query<
      CatalogMasterListItem & {
        mergedAttributes: unknown;
        mergedFieldValues: unknown;
      }
    >(
      `SELECT
         cm.id::bigint::int           AS id,
         cm.article_key                AS "articleKey",
         cm.display_article            AS "displayArticle",
         cm.variant_count              AS "variantCount",
         cm.offer_count                AS "offerCount",
         cm.supplier_count             AS "supplierCount",
         cm.best_price::text           AS "bestPrice",
         cm.worst_price::text          AS "worstPrice",
         cm.total_qty                  AS "totalQty",
         cm.last_assembled_at::text    AS "lastAssembledAt",
         cm.updated_at::text           AS "updatedAt",
         cm.merged_attributes          AS "mergedAttributes",
         cm.merged_field_values        AS "mergedFieldValues"
       FROM catalog_masters cm
       WHERE cm.id = $1
       LIMIT 1`,
      [masterId]
    );
    if (r.rows.length === 0) return null;
    const cm = r.rows[0];

    const fields = await this.listMasterFields();

    const valuesRes = await this.pool.query<{
      fieldId: number;
      value: string | null;
      source: string;
      sourceSupplierId: number | null;
      sourceSupplierName: string | null;
      sourceAttributeKey: string | null;
      updatedBy: string | null;
      updatedAt: string;
    }>(
      `SELECT
         cmfv.field_id::bigint::int        AS "fieldId",
         cmfv.value                         AS value,
         cmfv.source                        AS source,
         cmfv.source_supplier_id::bigint::int AS "sourceSupplierId",
         s.name                             AS "sourceSupplierName",
         cmfv.source_attribute_key          AS "sourceAttributeKey",
         cmfv.updated_by::text             AS "updatedBy",
         cmfv.updated_at::text              AS "updatedAt"
       FROM catalog_master_field_values cmfv
       LEFT JOIN suppliers s ON s.id = cmfv.source_supplier_id
       WHERE cmfv.master_id = $1`,
      [masterId]
    );
    const fieldValues: Record<number, CatalogMasterFieldValue> = {};
    for (const row of valuesRes.rows) fieldValues[row.fieldId] = row;

    const flatten = (raw: unknown): Record<string, string> => {
      const out: Record<string, string> = {};
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
          if (v === null || typeof v === 'undefined') continue;
          const text = typeof v === 'object' ? JSON.stringify(v) : String(v);
          if (!text.trim()) continue;
          out[k] = text;
        }
      }
      return out;
    };

    // Варіації з мапінгу: distinct field_values по offers, групуємо за (field_key, value).
    // Це показує "якщо в кількох постачальників різні данні на одне поле" — для UI вибору.
    const variationsRes = await this.pool.query<{
      fieldKey: string;
      fieldValue: string;
      supplierIds: number[];
      supplierNames: string[];
      offerCount: number;
      bestPriority: number | null;
    }>(
      `
      WITH unpacked AS (
        SELECT
          j.key                 AS field_key,
          btrim(j.value)        AS field_value,
          co.supplier_id::bigint::int AS supplier_id,
          s.name                AS supplier_name,
          s.priority            AS supplier_priority,
          co.id                 AS offer_id
        FROM catalog_offers co
        JOIN suppliers s ON s.id = co.supplier_id
        CROSS JOIN LATERAL jsonb_each_text(co.field_values) AS j(key, value)
        WHERE co.master_id = $1
          AND jsonb_typeof(co.field_values) = 'object'
          AND NULLIF(btrim(j.value), '') IS NOT NULL
      )
      SELECT
        field_key                                                       AS "fieldKey",
        field_value                                                     AS "fieldValue",
        array_agg(DISTINCT supplier_id ORDER BY supplier_id)::int[]     AS "supplierIds",
        array_agg(DISTINCT supplier_name ORDER BY supplier_name)::text[] AS "supplierNames",
        COUNT(*)::int                                                   AS "offerCount",
        MIN(supplier_priority)::int                                     AS "bestPriority"
      FROM unpacked
      GROUP BY field_key, field_value
      ORDER BY field_key, MIN(supplier_priority) ASC, COUNT(*) DESC
      `,
      [masterId]
    );

    const fieldVariations: Record<string, CatalogFieldVariation[]> = {};
    for (const row of variationsRes.rows) {
      if (!fieldVariations[row.fieldKey]) fieldVariations[row.fieldKey] = [];
      fieldVariations[row.fieldKey].push({
        value: row.fieldValue,
        supplierNames: row.supplierNames || [],
        supplierIds: row.supplierIds || [],
        offerCount: row.offerCount,
        bestPriority: row.bestPriority
      });
    }

    const master: CatalogMasterListItem = {
      id: cm.id,
      articleKey: cm.articleKey,
      displayArticle: cm.displayArticle,
      variantCount: cm.variantCount,
      offerCount: cm.offerCount,
      supplierCount: cm.supplierCount,
      bestPrice: cm.bestPrice,
      worstPrice: cm.worstPrice,
      totalQty: cm.totalQty,
      lastAssembledAt: cm.lastAssembledAt,
      updatedAt: cm.updatedAt
    };

    return {
      master,
      fields,
      fieldValues,
      fieldVariations,
      mergedFieldValues: flatten(cm.mergedFieldValues)
    };
  }

  async saveMasterFieldValues(
    masterId: number,
    inputs: CatalogFieldValueInput[],
    updatedBy: string | null
  ): Promise<CatalogMasterCard | null> {
    if (!Array.isArray(inputs) || inputs.length === 0) {
      return this.getMasterCard(masterId);
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const input of inputs) {
        const fieldId = Math.trunc(Number(input.fieldId));
        if (!Number.isFinite(fieldId) || fieldId <= 0) continue;
        const value =
          input.value === null || typeof input.value === 'undefined' ? null : String(input.value);
        if (value === null || value.trim() === '') {
          await client.query(
            `DELETE FROM catalog_master_field_values
             WHERE master_id = $1 AND field_id = $2`,
            [masterId, fieldId]
          );
          continue;
        }
        const source = String(input.source || 'manual');
        const sourceSupplierId =
          input.sourceSupplierId === null || typeof input.sourceSupplierId === 'undefined'
            ? null
            : Math.trunc(Number(input.sourceSupplierId)) || null;
        const sourceAttributeKey = input.sourceAttributeKey
          ? String(input.sourceAttributeKey).slice(0, 200)
          : null;

        await client.query(
          `INSERT INTO catalog_master_field_values
             (master_id, field_id, value, source, source_supplier_id,
              source_attribute_key, updated_by, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
           ON CONFLICT (master_id, field_id) DO UPDATE SET
             value = EXCLUDED.value,
             source = EXCLUDED.source,
             source_supplier_id = EXCLUDED.source_supplier_id,
             source_attribute_key = EXCLUDED.source_attribute_key,
             updated_by = EXCLUDED.updated_by,
             updated_at = NOW()`,
          [masterId, fieldId, value, source, sourceSupplierId, sourceAttributeKey, updatedBy]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (_e) {
        // ignored
      }
      throw err;
    } finally {
      client.release();
    }
    return this.getMasterCard(masterId);
  }

  async listAssemblyRuns(limit = 20): Promise<CatalogAssemblyRunRecord[]> {
    const size = Math.max(1, Math.min(200, Math.trunc(Number(limit) || 20)));
    const r = await this.pool.query<CatalogAssemblyRunRecord>(
      `SELECT
         id::bigint::int                AS id,
         job_id::bigint::int            AS "jobId",
         status                          AS status,
         source_articles                 AS "sourceArticles",
         masters_upserted                AS "mastersUpserted",
         variants_inserted               AS "variantsInserted",
         offers_inserted                 AS "offersInserted",
         duration_ms                     AS "durationMs",
         error                           AS error,
         started_at::text                AS "startedAt",
         finished_at::text               AS "finishedAt"
       FROM catalog_assembly_runs
       ORDER BY id DESC
       LIMIT $1`,
      [size]
    );
    return r.rows;
  }

  async getLatestAssemblyRun(): Promise<CatalogAssemblyRunRecord | null> {
    const runs = await this.listAssemblyRuns(1);
    return runs[0] || null;
  }

  async listColorMappings(): Promise<
    Array<{ id: number; colorFrom: string; colorTo: string; notes: string | null; isActive: boolean; createdAt: string }>
  > {
    const r = await this.pool.query<{
      id: number; colorFrom: string; colorTo: string; notes: string | null; isActive: boolean; createdAt: string;
    }>(
      `SELECT id::bigint::int     AS id,
              color_from           AS "colorFrom",
              color_to             AS "colorTo",
              notes                AS notes,
              is_active            AS "isActive",
              created_at::text     AS "createdAt"
         FROM color_mappings
        ORDER BY LOWER(color_from) ASC`
    );
    return r.rows;
  }

  async listCategoryMappings(): Promise<
    Array<{ id: number; categoryFrom: string; categoryTo: string; notes: string | null; isActive: boolean; createdAt: string }>
  > {
    const r = await this.pool.query<{
      id: number; categoryFrom: string; categoryTo: string; notes: string | null; isActive: boolean; createdAt: string;
    }>(
      `SELECT id::bigint::int     AS id,
              category_from        AS "categoryFrom",
              category_to          AS "categoryTo",
              notes                AS notes,
              is_active            AS "isActive",
              created_at::text     AS "createdAt"
         FROM category_mappings
        ORDER BY LOWER(category_from) ASC`
    );
    return r.rows;
  }

  // ─── CRUD: color_mappings ────────────────────────────────────────────────
  async createColorMapping(input: {
    colorFrom: string; colorTo: string; notes?: string | null; isActive?: boolean;
  }): Promise<{ id: number }> {
    const colorFrom = String(input.colorFrom || '').trim();
    const colorTo = String(input.colorTo || '').trim();
    if (!colorFrom) throw badRequest('colorFrom is required');
    if (!colorTo) throw badRequest('colorTo is required');
    const r = await this.pool.query<{ id: number }>(
      `INSERT INTO color_mappings (color_from, color_to, notes, is_active)
       VALUES ($1, $2, $3, COALESCE($4, true))
       ON CONFLICT (LOWER(TRIM(color_from))) DO UPDATE SET
         color_to = EXCLUDED.color_to,
         notes    = EXCLUDED.notes,
         is_active = EXCLUDED.is_active
       RETURNING id::bigint::int AS id`,
      [colorFrom, colorTo, input.notes ?? null, input.isActive ?? true]
    );
    return { id: r.rows[0].id };
  }

  async updateColorMapping(id: number, input: {
    colorFrom?: string; colorTo?: string; notes?: string | null; isActive?: boolean;
  }): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (typeof input.colorFrom === 'string') {
      sets.push(`color_from = $${params.length + 1}`); params.push(input.colorFrom.trim());
    }
    if (typeof input.colorTo === 'string') {
      sets.push(`color_to = $${params.length + 1}`); params.push(input.colorTo.trim());
    }
    if (input.notes !== undefined) {
      sets.push(`notes = $${params.length + 1}`); params.push(input.notes);
    }
    if (typeof input.isActive === 'boolean') {
      sets.push(`is_active = $${params.length + 1}`); params.push(input.isActive);
    }
    if (sets.length === 0) return;
    params.push(id);
    await this.pool.query(
      `UPDATE color_mappings SET ${sets.join(', ')} WHERE id = $${params.length}`,
      params
    );
  }

  async deleteColorMapping(id: number): Promise<void> {
    await this.pool.query(`DELETE FROM color_mappings WHERE id = $1`, [id]);
  }

  // ─── CRUD: category_mappings ────────────────────────────────────────────
  async createCategoryMapping(input: {
    categoryFrom: string; categoryTo: string; notes?: string | null; isActive?: boolean;
  }): Promise<{ id: number }> {
    const categoryFrom = String(input.categoryFrom || '').trim();
    const categoryTo = String(input.categoryTo || '').trim();
    if (!categoryFrom) throw badRequest('categoryFrom is required');
    if (!categoryTo) throw badRequest('categoryTo is required');
    const r = await this.pool.query<{ id: number }>(
      `INSERT INTO category_mappings (category_from, category_to, notes, is_active)
       VALUES ($1, $2, $3, COALESCE($4, true))
       ON CONFLICT (LOWER(TRIM(category_from))) DO UPDATE SET
         category_to = EXCLUDED.category_to,
         notes       = EXCLUDED.notes,
         is_active   = EXCLUDED.is_active
       RETURNING id::bigint::int AS id`,
      [categoryFrom, categoryTo, input.notes ?? null, input.isActive ?? true]
    );
    return { id: r.rows[0].id };
  }

  async updateCategoryMapping(id: number, input: {
    categoryFrom?: string; categoryTo?: string; notes?: string | null; isActive?: boolean;
  }): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (typeof input.categoryFrom === 'string') {
      sets.push(`category_from = $${params.length + 1}`); params.push(input.categoryFrom.trim());
    }
    if (typeof input.categoryTo === 'string') {
      sets.push(`category_to = $${params.length + 1}`); params.push(input.categoryTo.trim());
    }
    if (input.notes !== undefined) {
      sets.push(`notes = $${params.length + 1}`); params.push(input.notes);
    }
    if (typeof input.isActive === 'boolean') {
      sets.push(`is_active = $${params.length + 1}`); params.push(input.isActive);
    }
    if (sets.length === 0) return;
    params.push(id);
    await this.pool.query(
      `UPDATE category_mappings SET ${sets.join(', ')} WHERE id = $${params.length}`,
      params
    );
  }

  async deleteCategoryMapping(id: number): Promise<void> {
    await this.pool.query(`DELETE FROM category_mappings WHERE id = $1`, [id]);
  }
}

function badRequest(message: string): Error {
  const e = new Error(message);
  (e as any).status = 400;
  return e;
}
