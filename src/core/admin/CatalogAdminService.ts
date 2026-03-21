import type { Pool } from 'pg';

type SupplierUpdatePayload = {
  name?: string;
  markup_percent?: number;
  priority?: number;
  min_profit_enabled?: boolean;
  min_profit_amount?: number;
  is_active?: boolean;
  markup_rule_set_id?: number | null;
};

type SourceUpdatePayload = {
  supplier_id?: number;
  source_type?: string;
  source_url?: string;
  sheet_name?: string | null;
  name?: string | null;
  is_active?: boolean;
};

type MappingSavePayload = {
  mapping: Record<string, unknown>;
  header_row?: number | null;
  mapping_meta?: Record<string, unknown> | null;
  source_id?: number | null;
  comment?: string | null;
};

type MarkupConditionInput = {
  priority?: number;
  price_from?: number;
  price_to?: number | null;
  action_type?: string;
  action_value?: number;
  is_active?: boolean;
};

interface NormalizedMarkupCondition {
  priority: number;
  price_from: number;
  price_to: number | null;
  action_type: 'fixed_add' | 'percent';
  action_value: number;
  is_active: boolean;
}

type PriceOverrideListOptions = {
  limit: number;
  offset: number;
  search: string | null;
};

type SupplierListSort = 'id_asc' | 'name_asc' | 'name_desc';

type SupplierListOptions = {
  search: string | null;
  sort: SupplierListSort;
};

type LogListOptions = {
  jobId: number | null;
  level: string | null;
  limit: number;
};

type PriceOverrideUpdatePayload = {
  article?: string;
  size?: string | null;
  price_final?: number;
  notes?: string | null;
  is_active?: boolean;
};

type ListPreviewOptions = {
  limit: number;
  offset: number;
  search: string | null;
  sort: string | null;
};

type MergedPreviewOptions = ListPreviewOptions & {
  jobId: number | null;
};

type FinalPreviewOptions = ListPreviewOptions & {
  jobId: number | null;
  supplierId: number | null;
};

type ComparePreviewOptions = {
  limit: number;
  offset: number;
  search: string | null;
  supplierId: number | null;
  missingOnly: boolean;
  store: string;
};

function createBadRequest(message: string): Error {
  const error = new Error(message);
  (error as any).status = 400;
  return error;
}

function createNotFound(message: string): Error {
  const error = new Error(message);
  (error as any).status = 404;
  return error;
}

function toOptionalFiniteNumber(value: unknown): number | null {
  if (value === null || typeof value === 'undefined' || String(value).trim() === '') {
    return null;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return numeric;
}

function buildUpdateClause(
  fields: Record<string, unknown>,
  values: unknown[]
): string[] {
  const updates: string[] = [];
  const entries = Object.entries(fields);
  for (let index = 0; index < entries.length; index += 1) {
    const [field, value] = entries[index];
    if (typeof value === 'undefined') {
      continue;
    }
    values.push(value);
    updates.push(`${field} = $${values.length}`);
  }
  return updates;
}

function normalizeMarkupConditions(value: unknown): NormalizedMarkupCondition[] {
  if (!Array.isArray(value) || value.length === 0) {
    return [];
  }

  const items: NormalizedMarkupCondition[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const raw = value[index] as MarkupConditionInput;
    const actionType = String(raw.action_type || '').trim();
    if (actionType !== 'fixed_add' && actionType !== 'percent') {
      throw createBadRequest('condition action_type must be fixed_add or percent');
    }
    const actionValue = Number(raw.action_value);
    if (!Number.isFinite(actionValue)) {
      throw createBadRequest('condition action_value is invalid');
    }
    const priceFrom = Number(raw.price_from);
    if (!Number.isFinite(priceFrom) || priceFrom < 0) {
      throw createBadRequest('condition price_from is invalid');
    }
    const priceToRaw = toOptionalFiniteNumber(raw.price_to);
    const priceTo = priceToRaw !== null ? Number(priceToRaw) : null;
    if (priceTo !== null && priceTo < priceFrom) {
      throw createBadRequest('condition price_to must be greater or equal to price_from');
    }
    const priority = Number.isFinite(Number(raw.priority))
      ? Math.trunc(Number(raw.priority))
      : index + 1;

    items.push({
      priority,
      price_from: priceFrom,
      price_to: priceTo,
      action_type: actionType,
      action_value: actionValue,
      is_active: typeof raw.is_active === 'boolean' ? raw.is_active : true
    });
  }

  return items.sort((a, b) => {
    if (a.priority !== b.priority) {
      return a.priority - b.priority;
    }
    return a.price_from - b.price_from;
  });
}

function computeDurationMs(startedAt: unknown, finishedAt: unknown): number | null {
  if (!startedAt || !finishedAt) {
    return null;
  }
  const start = new Date(String(startedAt)).getTime();
  const end = new Date(String(finishedAt)).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return null;
  }
  return Math.max(0, end - start);
}

function normalizeSort(sort: string | null, fallback: string): string {
  const value = String(sort || '').trim().toLowerCase();
  return value || fallback;
}

function normalizePagination(limit: number, offset: number): { limit: number; offset: number } {
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(1000, Math.trunc(limit))) : 100;
  const safeOffset = Number.isFinite(offset) ? Math.max(0, Math.trunc(offset)) : 0;
  return {
    limit: safeLimit,
    offset: safeOffset
  };
}

export class CatalogAdminService {
  constructor(private readonly pool: Pool) {}

  private async getLatestJobId(type: string): Promise<number | null> {
    const result = await this.pool.query(
      `SELECT id
       FROM jobs
       WHERE type = $1
       ORDER BY id DESC
       LIMIT 1`,
      [type]
    );
    const jobId = Number(result.rows[0]?.id || 0);
    if (!Number.isFinite(jobId) || jobId <= 0) {
      return null;
    }
    return jobId;
  }

  async listSuppliers(options: SupplierListOptions): Promise<Record<string, unknown>[]> {
    const search = String(options.search || '').trim();
    const values: unknown[] = [];
    const whereParts: string[] = [];
    if (search) {
      values.push(`%${search}%`);
      whereParts.push(`s.name ILIKE $${values.length}`);
    }
    const whereClause = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';

    let orderClause = 's.id ASC';
    if (options.sort === 'name_asc') {
      orderClause = 'LOWER(s.name) ASC, s.id ASC';
    } else if (options.sort === 'name_desc') {
      orderClause = 'LOWER(s.name) DESC, s.id DESC';
    }

    const result = await this.pool.query(
      `SELECT
         s.id,
         s.name,
         s.markup_percent,
         s.priority,
         s.min_profit_enabled,
         s.min_profit_amount,
         s.is_active,
         s.created_at,
         s.markup_rule_set_id,
         rs.name AS markup_rule_set_name
       FROM suppliers s
       LEFT JOIN markup_rule_sets rs ON rs.id = s.markup_rule_set_id
       ${whereClause}
       ORDER BY ${orderClause}`,
      values
    );
    return result.rows;
  }

  async createSupplier(payload: SupplierUpdatePayload): Promise<Record<string, unknown>> {
    const name = String(payload.name || '').trim();
    if (!name) {
      throw createBadRequest('name is required');
    }

    const markupPercent = Number.isFinite(Number(payload.markup_percent))
      ? Number(payload.markup_percent)
      : 0;
    const priority = Number.isFinite(Number(payload.priority))
      ? Math.trunc(Number(payload.priority))
      : 100;
    const minProfitEnabled =
      typeof payload.min_profit_enabled === 'boolean' ? payload.min_profit_enabled : true;
    const minProfitAmount = minProfitEnabled
      ? Math.max(0, Number.isFinite(Number(payload.min_profit_amount)) ? Number(payload.min_profit_amount) : 0)
      : 0;

    let markupRuleSetId: number | null = null;
    if (Object.prototype.hasOwnProperty.call(payload, 'markup_rule_set_id')) {
      const parsed = toOptionalFiniteNumber(payload.markup_rule_set_id);
      if (parsed === null) {
        markupRuleSetId = null;
      } else {
        const normalized = Math.trunc(parsed);
        if (!Number.isFinite(normalized) || normalized <= 0) {
          throw createBadRequest('markup_rule_set_id is invalid');
        }
        const ruleSet = await this.pool.query('SELECT id FROM markup_rule_sets WHERE id = $1', [
          normalized
        ]);
        if (!ruleSet.rows[0]) {
          throw createBadRequest('markup rule set not found');
        }
        markupRuleSetId = normalized;
      }
    }

    const result = await this.pool.query(
      `INSERT INTO suppliers
         (name, markup_percent, priority, min_profit_enabled, min_profit_amount, markup_rule_set_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [name, markupPercent, priority, minProfitEnabled, minProfitAmount, markupRuleSetId]
    );
    return result.rows[0];
  }

  async bulkUpdateSuppliers(payload: {
    supplier_ids: Array<number | string>;
    markup_percent?: number;
    min_profit_enabled?: boolean;
    min_profit_amount?: number;
  }): Promise<{ updated: number }> {
    if (!Array.isArray(payload.supplier_ids) || payload.supplier_ids.length === 0) {
      throw createBadRequest('supplier_ids are required');
    }
    const ids = payload.supplier_ids
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value))
      .map((value) => Math.trunc(value))
      .filter((value) => value > 0);
    if (!ids.length) {
      throw createBadRequest('supplier_ids are invalid');
    }

    const hasMarkup = Object.prototype.hasOwnProperty.call(payload, 'markup_percent');
    const hasMinProfitEnabled = Object.prototype.hasOwnProperty.call(payload, 'min_profit_enabled');
    const hasMinProfitAmount = Object.prototype.hasOwnProperty.call(payload, 'min_profit_amount');

    const updates: Record<string, unknown> = {};
    if (hasMarkup) {
      if (!Number.isFinite(Number(payload.markup_percent))) {
        throw createBadRequest('markup_percent is required');
      }
      updates.markup_percent = Number(payload.markup_percent);
    }

    if (hasMinProfitEnabled && typeof payload.min_profit_enabled !== 'boolean') {
      throw createBadRequest('min_profit_enabled is invalid');
    }

    if (payload.min_profit_enabled === false) {
      updates.min_profit_enabled = false;
      updates.min_profit_amount = 0;
    } else {
      if (payload.min_profit_enabled === true) {
        updates.min_profit_enabled = true;
      }
      if (hasMinProfitAmount) {
        if (!Number.isFinite(Number(payload.min_profit_amount))) {
          throw createBadRequest('min_profit_amount is invalid');
        }
        updates.min_profit_amount = Math.max(0, Number(payload.min_profit_amount));
      }
    }

    const values: unknown[] = [];
    const updateClauses = buildUpdateClause(updates, values);
    if (!updateClauses.length) {
      throw createBadRequest('no fields to update');
    }
    values.push(ids);
    const result = await this.pool.query(
      `UPDATE suppliers
       SET ${updateClauses.join(', ')}
       WHERE id = ANY($${values.length}::bigint[])
       RETURNING id`,
      values
    );
    return {
      updated: result.rowCount || 0
    };
  }

  async updateSupplier(supplierId: number, payload: SupplierUpdatePayload): Promise<Record<string, unknown>> {
    const normalizedId = Math.trunc(Number(supplierId));
    if (!Number.isFinite(normalizedId) || normalizedId <= 0) {
      throw createBadRequest('supplier id is invalid');
    }
    const existing = await this.pool.query('SELECT id FROM suppliers WHERE id = $1', [normalizedId]);
    if (!existing.rows[0]) {
      throw createNotFound('supplier not found');
    }

    let markupRuleSetId: number | null | undefined = undefined;
    if (Object.prototype.hasOwnProperty.call(payload, 'markup_rule_set_id')) {
      const parsed = toOptionalFiniteNumber(payload.markup_rule_set_id);
      if (parsed === null) {
        markupRuleSetId = null;
      } else {
        const normalized = Math.trunc(parsed);
        if (!Number.isFinite(normalized) || normalized <= 0) {
          throw createBadRequest('markup_rule_set_id is invalid');
        }
        const ruleSet = await this.pool.query('SELECT id FROM markup_rule_sets WHERE id = $1', [
          normalized
        ]);
        if (!ruleSet.rows[0]) {
          throw createBadRequest('markup rule set not found');
        }
        markupRuleSetId = normalized;
      }
    }

    const minProfitEnabledIsFalse =
      typeof payload.min_profit_enabled === 'boolean' && payload.min_profit_enabled === false;
    const minProfitAmount =
      minProfitEnabledIsFalse
        ? 0
        : Number.isFinite(Number(payload.min_profit_amount))
          ? Math.max(0, Number(payload.min_profit_amount))
          : undefined;

    const values: unknown[] = [];
    const updates = buildUpdateClause(
      {
        name: typeof payload.name === 'string' ? payload.name.trim() || undefined : undefined,
        markup_percent:
          Number.isFinite(Number(payload.markup_percent)) ? Number(payload.markup_percent) : undefined,
        priority: Number.isFinite(Number(payload.priority)) ? Math.trunc(Number(payload.priority)) : undefined,
        min_profit_enabled:
          typeof payload.min_profit_enabled === 'boolean' ? payload.min_profit_enabled : undefined,
        min_profit_amount: minProfitAmount,
        is_active: typeof payload.is_active === 'boolean' ? payload.is_active : undefined,
        markup_rule_set_id: markupRuleSetId
      },
      values
    );
    if (!updates.length) {
      throw createBadRequest('no fields to update');
    }
    values.push(normalizedId);
    const result = await this.pool.query(
      `UPDATE suppliers
       SET ${updates.join(', ')}
       WHERE id = $${values.length}
       RETURNING *`,
      values
    );
    return result.rows[0];
  }

  async deleteSupplier(supplierId: number): Promise<Record<string, unknown> | null> {
    const normalizedId = Math.trunc(Number(supplierId));
    if (!Number.isFinite(normalizedId) || normalizedId <= 0) {
      throw createBadRequest('supplier id is invalid');
    }
    const result = await this.pool.query('DELETE FROM suppliers WHERE id = $1 RETURNING *', [
      normalizedId
    ]);
    return result.rows[0] || null;
  }

  async listSources(supplierId: number | null): Promise<Record<string, unknown>[]> {
    const values: unknown[] = [];
    let whereClause = '';
    if (supplierId && Number.isFinite(supplierId) && supplierId > 0) {
      values.push(Math.trunc(supplierId));
      whereClause = 'WHERE s.supplier_id = $1';
    }
    const result = await this.pool.query(
      `SELECT
         s.id,
         s.supplier_id,
         s.name,
         sp.name AS supplier_name,
         s.source_type,
         s.source_url,
         s.sheet_name,
         s.is_active,
         s.created_at
       FROM sources s
       JOIN suppliers sp ON sp.id = s.supplier_id
       ${whereClause}
       ORDER BY s.id ASC`,
      values
    );
    return result.rows;
  }

  async getSourceById(sourceId: number): Promise<Record<string, unknown> | null> {
    const normalizedId = Math.trunc(Number(sourceId));
    if (!Number.isFinite(normalizedId) || normalizedId <= 0) {
      throw createBadRequest('source id is invalid');
    }
    const result = await this.pool.query(
      `SELECT
         s.id,
         s.supplier_id,
         s.name,
         sp.name AS supplier_name,
         s.source_type,
         s.source_url,
         s.sheet_name,
         s.is_active,
         s.created_at
       FROM sources s
       JOIN suppliers sp ON sp.id = s.supplier_id
       WHERE s.id = $1
       LIMIT 1`,
      [normalizedId]
    );
    return result.rows[0] || null;
  }

  async getActiveImportSourceById(sourceId: number): Promise<Record<string, unknown> | null> {
    const normalizedId = Math.trunc(Number(sourceId));
    if (!Number.isFinite(normalizedId) || normalizedId <= 0) {
      throw createBadRequest('source id is invalid');
    }
    const result = await this.pool.query(
      `SELECT s.*, sp.id AS supplier_id, sp.name AS supplier_name
       FROM sources s
       JOIN suppliers sp ON sp.id = s.supplier_id
       WHERE s.id = $1
         AND s.is_active = TRUE
         AND sp.is_active = TRUE
       LIMIT 1`,
      [normalizedId]
    );
    return result.rows[0] || null;
  }

  async createSource(payload: {
    supplier_id?: number;
    source_type?: string;
    source_url?: string;
    sheet_name?: string | null;
    name?: string | null;
  }): Promise<Record<string, unknown>> {
    const supplierId = Number(payload.supplier_id);
    const sourceType = String(payload.source_type || '').trim();
    const sourceUrl = String(payload.source_url || '').trim();
    if (!Number.isFinite(supplierId) || supplierId <= 0 || !sourceType || !sourceUrl) {
      throw createBadRequest('supplier_id, source_type, source_url are required');
    }
    const sheetName =
      payload.sheet_name === null || typeof payload.sheet_name === 'undefined'
        ? null
        : String(payload.sheet_name).trim() || null;
    const name =
      payload.name === null || typeof payload.name === 'undefined'
        ? null
        : String(payload.name).trim() || null;

    const result = await this.pool.query(
      `INSERT INTO sources
         (supplier_id, source_type, source_url, sheet_name, name)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [Math.trunc(supplierId), sourceType, sourceUrl, sheetName, name || sheetName || 'Source']
    );
    return result.rows[0];
  }

  async updateSource(sourceId: number, payload: SourceUpdatePayload): Promise<Record<string, unknown>> {
    const normalizedId = Math.trunc(Number(sourceId));
    if (!Number.isFinite(normalizedId) || normalizedId <= 0) {
      throw createBadRequest('source id is invalid');
    }
    const values: unknown[] = [];
    const updates = buildUpdateClause(
      {
        supplier_id:
          Number.isFinite(Number(payload.supplier_id)) && Number(payload.supplier_id) > 0
            ? Math.trunc(Number(payload.supplier_id))
            : undefined,
        source_type: typeof payload.source_type === 'string' ? payload.source_type.trim() : undefined,
        source_url: typeof payload.source_url === 'string' ? payload.source_url.trim() : undefined,
        sheet_name:
          payload.sheet_name === null
            ? null
            : typeof payload.sheet_name === 'string'
              ? payload.sheet_name.trim()
              : undefined,
        name:
          payload.name === null
            ? null
            : typeof payload.name === 'string'
              ? payload.name.trim()
              : undefined,
        is_active: typeof payload.is_active === 'boolean' ? payload.is_active : undefined
      },
      values
    );
    if (!updates.length) {
      throw createBadRequest('no fields to update');
    }
    values.push(normalizedId);
    const result = await this.pool.query(
      `UPDATE sources
       SET ${updates.join(', ')}
       WHERE id = $${values.length}
       RETURNING *`,
      values
    );
    if (!result.rows[0]) {
      throw createNotFound('source not found');
    }
    return result.rows[0];
  }

  async deleteSource(sourceId: number): Promise<Record<string, unknown> | null> {
    const normalizedId = Math.trunc(Number(sourceId));
    if (!Number.isFinite(normalizedId) || normalizedId <= 0) {
      throw createBadRequest('source id is invalid');
    }
    const result = await this.pool.query('DELETE FROM sources WHERE id = $1 RETURNING *', [
      normalizedId
    ]);
    return result.rows[0] || null;
  }

  async getLatestMapping(
    supplierId: number,
    sourceId?: number | null
  ): Promise<Record<string, unknown> | null> {
    const normalizedSupplierId = Math.trunc(Number(supplierId));
    if (!Number.isFinite(normalizedSupplierId) || normalizedSupplierId <= 0) {
      throw createBadRequest('supplierId is invalid');
    }
    const normalizedSourceId = toOptionalFiniteNumber(sourceId);
    if (normalizedSourceId !== null && normalizedSourceId > 0) {
      const result = await this.pool.query(
        `SELECT id, supplier_id, source_id, mapping, header_row, mapping_meta, comment, created_at
         FROM column_mappings
         WHERE supplier_id = $1 AND (source_id = $2 OR source_id IS NULL)
         ORDER BY (source_id = $2) DESC, id DESC
         LIMIT 1`,
        [normalizedSupplierId, Math.trunc(normalizedSourceId)]
      );
      return result.rows[0] || null;
    }
    const result = await this.pool.query(
      `SELECT id, supplier_id, source_id, mapping, header_row, mapping_meta, comment, created_at
       FROM column_mappings
       WHERE supplier_id = $1
       ORDER BY id DESC
       LIMIT 1`,
      [normalizedSupplierId]
    );
    return result.rows[0] || null;
  }

  async saveMapping(supplierId: number, payload: MappingSavePayload): Promise<Record<string, unknown>> {
    const normalizedSupplierId = Math.trunc(Number(supplierId));
    if (!Number.isFinite(normalizedSupplierId) || normalizedSupplierId <= 0) {
      throw createBadRequest('supplierId is invalid');
    }
    if (!payload || !payload.mapping || typeof payload.mapping !== 'object') {
      throw createBadRequest('mapping is required');
    }

    const headerRow = Number.isFinite(Number(payload.header_row))
      ? Math.trunc(Number(payload.header_row))
      : null;
    const sourceFromBody = toOptionalFiniteNumber(payload.source_id);
    const sourceFromMeta = toOptionalFiniteNumber(payload.mapping_meta?.source_id);
    const resolvedSourceId = sourceFromBody !== null ? sourceFromBody : sourceFromMeta;
    const commentFromBody =
      payload.comment === null || typeof payload.comment === 'undefined'
        ? null
        : String(payload.comment).trim() || null;
    const commentFromMeta =
      commentFromBody === null && typeof payload.mapping_meta?.comment === 'string'
        ? payload.mapping_meta.comment.trim() || null
        : null;
    const resolvedComment = commentFromBody !== null ? commentFromBody : commentFromMeta;

    const result = await this.pool.query(
      `INSERT INTO column_mappings (supplier_id, source_id, mapping, header_row, mapping_meta, comment)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        normalizedSupplierId,
        resolvedSourceId !== null ? Math.trunc(resolvedSourceId) : null,
        payload.mapping,
        headerRow,
        payload.mapping_meta || null,
        resolvedComment
      ]
    );
    return result.rows[0];
  }

  async listMarkupRuleSets(): Promise<{ rule_sets: Record<string, unknown>[] }> {
    const [setsResult, conditionsResult] = await Promise.all([
      this.pool.query(
        `SELECT id, name, is_active, created_at
         FROM markup_rule_sets
         ORDER BY id ASC`
      ),
      this.pool.query(
        `SELECT id, rule_set_id, priority, price_from, price_to, action_type, action_value, is_active, created_at
         FROM markup_rule_conditions
         ORDER BY rule_set_id ASC, priority ASC, id ASC`
      )
    ]);

    const groupedConditions = new Map<number, Record<string, unknown>[]>();
    for (let index = 0; index < conditionsResult.rows.length; index += 1) {
      const row = conditionsResult.rows[index];
      const ruleSetId = Number(row.rule_set_id || 0);
      if (!groupedConditions.has(ruleSetId)) {
        groupedConditions.set(ruleSetId, []);
      }
      groupedConditions.get(ruleSetId)?.push(row);
    }

    return {
      rule_sets: setsResult.rows.map((set) => ({
        ...set,
        conditions: groupedConditions.get(Number(set.id || 0)) || []
      }))
    };
  }

  async createMarkupRuleSet(payload: {
    name?: string;
    is_active?: boolean;
    conditions?: MarkupConditionInput[];
  }): Promise<{ rule_set: Record<string, unknown> | null }> {
    const name = String(payload.name || '').trim();
    if (!name) {
      throw createBadRequest('name is required');
    }
    const isActive = typeof payload.is_active === 'boolean' ? payload.is_active : true;
    const conditions = normalizeMarkupConditions(payload.conditions);

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const created = await client.query(
        `INSERT INTO markup_rule_sets (name, is_active)
         VALUES ($1, $2)
         RETURNING id`,
        [name, isActive]
      );
      const ruleSetId = Number(created.rows[0]?.id || 0);

      for (let index = 0; index < conditions.length; index += 1) {
        const condition = conditions[index];
        await client.query(
          `INSERT INTO markup_rule_conditions
             (rule_set_id, priority, price_from, price_to, action_type, action_value, is_active)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            ruleSetId,
            condition.priority,
            condition.price_from,
            condition.price_to,
            condition.action_type,
            condition.action_value,
            condition.is_active
          ]
        );
      }
      await client.query('COMMIT');

      const payloadResult = await this.listMarkupRuleSets();
      const ruleSet =
        payloadResult.rule_sets.find((item) => Number(item.id || 0) === ruleSetId) || null;
      return { rule_set: ruleSet };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async updateMarkupRuleSet(
    ruleSetId: number,
    payload: {
      name?: string;
      is_active?: boolean;
      conditions?: MarkupConditionInput[];
    }
  ): Promise<{ rule_set: Record<string, unknown> | null }> {
    const normalizedRuleSetId = Math.trunc(Number(ruleSetId));
    if (!Number.isFinite(normalizedRuleSetId) || normalizedRuleSetId <= 0) {
      throw createBadRequest('rule set id is invalid');
    }

    const name = String(payload.name || '').trim();
    if (!name) {
      throw createBadRequest('name is required');
    }
    const isActive = typeof payload.is_active === 'boolean' ? payload.is_active : true;
    const conditions = normalizeMarkupConditions(payload.conditions);

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query('SELECT id FROM markup_rule_sets WHERE id = $1', [
        normalizedRuleSetId
      ]);
      if (!existing.rows[0]) {
        throw createNotFound('rule set not found');
      }

      await client.query(
        `UPDATE markup_rule_sets
         SET name = $1,
             is_active = $2
         WHERE id = $3`,
        [name, isActive, normalizedRuleSetId]
      );
      await client.query('DELETE FROM markup_rule_conditions WHERE rule_set_id = $1', [
        normalizedRuleSetId
      ]);
      for (let index = 0; index < conditions.length; index += 1) {
        const condition = conditions[index];
        await client.query(
          `INSERT INTO markup_rule_conditions
             (rule_set_id, priority, price_from, price_to, action_type, action_value, is_active)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            normalizedRuleSetId,
            condition.priority,
            condition.price_from,
            condition.price_to,
            condition.action_type,
            condition.action_value,
            condition.is_active
          ]
        );
      }
      await client.query('COMMIT');

      const payloadResult = await this.listMarkupRuleSets();
      const ruleSet =
        payloadResult.rule_sets.find((item) => Number(item.id || 0) === normalizedRuleSetId) ||
        null;
      return { rule_set: ruleSet };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async applyMarkupRuleSet(payload: {
    scope?: string;
    rule_set_id?: number;
    supplier_ids?: Array<number | string>;
  }): Promise<{ scope: string; updated_suppliers: number }> {
    const scope = String(payload.scope || '').trim();
    if (scope !== 'suppliers' && scope !== 'all_suppliers') {
      throw createBadRequest('scope is invalid');
    }
    const ruleSetId = Math.trunc(Number(payload.rule_set_id));
    if (!Number.isFinite(ruleSetId) || ruleSetId <= 0) {
      throw createBadRequest('rule_set_id is required');
    }
    const existingRuleSet = await this.pool.query(
      'SELECT id, is_active FROM markup_rule_sets WHERE id = $1',
      [ruleSetId]
    );
    if (!existingRuleSet.rows[0]) {
      throw createNotFound('rule set not found');
    }
    if (existingRuleSet.rows[0].is_active !== true) {
      throw createBadRequest('rule set is inactive');
    }

    if (scope === 'suppliers') {
      const supplierIds = Array.isArray(payload.supplier_ids)
        ? payload.supplier_ids
            .map((value) => Number(value))
            .filter((value) => Number.isFinite(value))
            .map((value) => Math.trunc(value))
            .filter((value) => value > 0)
        : [];
      if (!supplierIds.length) {
        throw createBadRequest('supplier_ids are required');
      }
      const updated = await this.pool.query(
        `UPDATE suppliers
         SET markup_rule_set_id = $1
         WHERE id = ANY($2::bigint[])
         RETURNING id`,
        [ruleSetId, supplierIds]
      );
      return {
        scope,
        updated_suppliers: updated.rowCount || 0
      };
    }

    const updated = await this.pool.query(
      `UPDATE suppliers
       SET markup_rule_set_id = $1
       RETURNING id`,
      [ruleSetId]
    );
    return {
      scope,
      updated_suppliers: updated.rowCount || 0
    };
  }

  async listPriceOverrides(
    options: PriceOverrideListOptions
  ): Promise<{ total: number; rows: Record<string, unknown>[] }> {
    const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(500, Math.trunc(options.limit))) : 100;
    const offset = Number.isFinite(options.offset) ? Math.max(0, Math.trunc(options.offset)) : 0;
    const search = String(options.search || '').trim();

    const whereParts: string[] = [];
    const values: unknown[] = [];
    if (search) {
      values.push(`%${search}%`);
      const searchIndex = values.length;
      whereParts.push(`(article ILIKE $${searchIndex} OR notes ILIKE $${searchIndex})`);
    }
    const whereClause = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';

    const result = await this.pool.query(
      `SELECT id, article, size, price_final, is_active, notes, created_at,
              COUNT(*) OVER() AS total
       FROM price_overrides
       ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, limit, offset]
    );

    const total = result.rows[0]?.total ? Number(result.rows[0].total) : 0;
    const rows = result.rows.map(({ total: ignored, ...row }) => row);
    return { total, rows };
  }

  private async recomputeFinalPriceFromRules(article: string, size: string | null): Promise<void> {
    await this.pool.query(
      `UPDATE products_final pf
       SET price_final = CEIL(
         (
           CASE
             WHEN rm.action_type = 'fixed_add' THEN pf.price_base + rm.action_value
             WHEN rm.action_type = 'percent' THEN pf.price_base * (1 + rm.action_value / 100)
             ELSE CASE
               WHEN s.min_profit_enabled = TRUE
                 AND (pf.price_base * (1 + s.markup_percent / 100)) - pf.price_base < s.min_profit_amount
                 THEN pf.price_base + s.min_profit_amount
               ELSE pf.price_base * (1 + s.markup_percent / 100)
             END
           END
         ) / 10
       ) * 10
       FROM suppliers s
       LEFT JOIN LATERAL (
         SELECT c.action_type, c.action_value
         FROM markup_rule_conditions c
         JOIN markup_rule_sets rs
           ON rs.id = c.rule_set_id
          AND rs.is_active = TRUE
         WHERE c.rule_set_id = s.markup_rule_set_id
           AND c.is_active = TRUE
           AND pf.price_base >= c.price_from
           AND (c.price_to IS NULL OR pf.price_base < c.price_to)
         ORDER BY c.priority ASC, c.id ASC
         LIMIT 1
       ) rm ON TRUE
       WHERE pf.supplier_id IS NOT NULL
         AND pf.supplier_id = s.id
         AND pf.article = $1
         AND NULLIF(pf.size, '') IS NOT DISTINCT FROM NULLIF($2, '')`,
      [article, size]
    );
  }

  async upsertPriceOverride(payload: PriceOverrideUpdatePayload): Promise<Record<string, unknown>> {
    const article = String(payload.article || '').trim();
    const priceFinal = Number(payload.price_final);
    if (!article || !Number.isFinite(priceFinal)) {
      throw createBadRequest('article and price_final are required');
    }
    const size =
      payload.size === null || typeof payload.size === 'undefined' || String(payload.size).trim() === ''
        ? null
        : String(payload.size).trim();
    const notes =
      payload.notes === null || typeof payload.notes === 'undefined'
        ? null
        : String(payload.notes).trim() || null;

    const existing = await this.pool.query(
      `SELECT id
       FROM price_overrides
       WHERE article = $1
         AND NULLIF(size, '') IS NOT DISTINCT FROM NULLIF($2, '')
       ORDER BY id DESC
       LIMIT 1`,
      [article, size]
    );

    let record: Record<string, unknown>;
    if (existing.rows[0]) {
      const updated = await this.pool.query(
        `UPDATE price_overrides
         SET price_final = $1, notes = $2, is_active = TRUE
         WHERE id = $3
         RETURNING *`,
        [priceFinal, notes, existing.rows[0].id]
      );
      record = updated.rows[0];
    } else {
      const inserted = await this.pool.query(
        `INSERT INTO price_overrides (article, size, price_final, notes)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [article, size, priceFinal, notes]
      );
      record = inserted.rows[0];
    }

    await this.pool.query(
      `UPDATE products_final
       SET price_final = $1
       WHERE article = $2
         AND NULLIF(size, '') IS NOT DISTINCT FROM NULLIF($3, '')`,
      [priceFinal, article, size]
    );

    return record;
  }

  async updatePriceOverride(
    overrideId: number,
    payload: PriceOverrideUpdatePayload
  ): Promise<Record<string, unknown>> {
    const normalizedId = Math.trunc(Number(overrideId));
    if (!Number.isFinite(normalizedId) || normalizedId <= 0) {
      throw createBadRequest('override id is invalid');
    }

    const currentResult = await this.pool.query('SELECT * FROM price_overrides WHERE id = $1', [
      normalizedId
    ]);
    const current = currentResult.rows[0];
    if (!current) {
      throw createNotFound('override not found');
    }

    const values: unknown[] = [];
    const updates = buildUpdateClause(
      {
        price_final:
          Number.isFinite(Number(payload.price_final)) ? Number(payload.price_final) : undefined,
        notes:
          payload.notes === null
            ? null
            : typeof payload.notes === 'string'
              ? payload.notes.trim()
              : undefined,
        is_active: typeof payload.is_active === 'boolean' ? payload.is_active : undefined
      },
      values
    );
    if (!updates.length) {
      throw createBadRequest('no fields to update');
    }
    values.push(normalizedId);
    const updateResult = await this.pool.query(
      `UPDATE price_overrides
       SET ${updates.join(', ')}
       WHERE id = $${values.length}
       RETURNING *`,
      values
    );
    const updated = updateResult.rows[0];

    if (typeof payload.is_active !== 'undefined') {
      if (payload.is_active === true) {
        await this.pool.query(
          `UPDATE products_final
           SET price_final = $1
           WHERE article = $2
             AND NULLIF(size, '') IS NOT DISTINCT FROM NULLIF($3, '')`,
          [updated.price_final, updated.article, updated.size]
        );
      } else {
        await this.recomputeFinalPriceFromRules(String(updated.article), updated.size || null);
      }
    } else if (typeof payload.price_final !== 'undefined') {
      await this.pool.query(
        `UPDATE products_final
         SET price_final = $1
         WHERE article = $2
           AND NULLIF(size, '') IS NOT DISTINCT FROM NULLIF($3, '')`,
        [updated.price_final, updated.article, updated.size]
      );
    }

    return updated;
  }

  async listLogs(options: LogListOptions): Promise<Record<string, unknown>[]> {
    const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(1000, Math.trunc(options.limit))) : 200;
    const jobId = options.jobId && Number.isFinite(options.jobId) ? Math.trunc(options.jobId) : null;
    const level = String(options.level || '').trim().toLowerCase() || null;

    if (jobId && jobId > 0) {
      const result = await this.pool.query(
        `SELECT id, job_id, level, message, data, created_at
         FROM logs
         WHERE job_id = $1
         ORDER BY id DESC
         LIMIT $2`,
        [jobId, limit]
      );
      return result.rows;
    }

    if (level) {
      const result = await this.pool.query(
        `SELECT id, job_id, level, message, data, created_at
         FROM logs
         WHERE level = $1
         ORDER BY id DESC
         LIMIT $2`,
        [level, limit]
      );
      return result.rows;
    }

    const result = await this.pool.query(
      `SELECT id, job_id, level, message, data, created_at
       FROM logs
       ORDER BY id DESC
       LIMIT $1`,
      [limit]
    );
    return result.rows;
  }

  async getStats(): Promise<Record<string, unknown>> {
    const [suppliers, sources, raw, final, lastJob, lastUpdatePipeline, lastStoreImport] =
      await Promise.all([
        this.pool.query('SELECT COUNT(*) AS count FROM suppliers'),
        this.pool.query('SELECT COUNT(*) AS count FROM sources'),
        this.pool.query('SELECT COUNT(*) AS count FROM products_raw'),
        this.pool.query('SELECT COUNT(*) AS count FROM products_final'),
        this.pool.query(
          `SELECT id, type, status, created_at, started_at, finished_at, meta
           FROM jobs
           ORDER BY id DESC
           LIMIT 1`
        ),
        this.pool.query(
          `SELECT id, type, status, created_at, started_at, finished_at, meta
           FROM jobs
           WHERE type = 'update_pipeline'
           ORDER BY id DESC
           LIMIT 1`
        ),
        this.pool.query(
          `SELECT id, type, status, created_at, started_at, finished_at, meta
           FROM jobs
           WHERE type = 'store_import'
           ORDER BY id DESC
           LIMIT 1`
        )
      ]);

    const lastUpdate = lastUpdatePipeline.rows[0] || null;
    const lastImport = lastStoreImport.rows[0] || null;

    return {
      suppliers: Number(suppliers.rows[0]?.count || 0),
      sources: Number(sources.rows[0]?.count || 0),
      products_raw: Number(raw.rows[0]?.count || 0),
      products_final: Number(final.rows[0]?.count || 0),
      lastJob: lastJob.rows[0] || null,
      lastUpdatePipeline: lastUpdate
        ? {
            ...lastUpdate,
            duration_ms: computeDurationMs(lastUpdate.started_at, lastUpdate.finished_at)
          }
        : null,
      lastStoreImport: lastImport
        ? {
            ...lastImport,
            duration_ms: computeDurationMs(lastImport.started_at, lastImport.finished_at)
          }
        : null
    };
  }

  async listMergedPreview(
    options: MergedPreviewOptions
  ): Promise<{ jobId: number | null; total: number; rows: Record<string, unknown>[] }> {
    const { limit, offset } = normalizePagination(options.limit, options.offset);
    const search = String(options.search || '').trim();
    let jobId = options.jobId && Number.isFinite(options.jobId) ? Math.trunc(options.jobId) : null;
    if (!jobId) {
      jobId = await this.getLatestJobId('import_all');
    }

    const whereParts: string[] = [];
    const values: unknown[] = [];
    if (jobId) {
      values.push(jobId);
      whereParts.push(`pr.job_id = $${values.length}`);
    }

    if (search) {
      values.push(`%${search}%`);
      const index = values.length;
      whereParts.push(`(pr.article ILIKE $${index} OR pr.extra ILIKE $${index})`);
    }

    const sort = normalizeSort(options.sort, 'article_asc');
    let orderBy = 'pr.article ASC, pr.id DESC';
    if (sort === 'article_desc') {
      orderBy = 'pr.article DESC, pr.id DESC';
    } else if (sort === 'created_desc') {
      orderBy = 'pr.id DESC';
    }

    const whereClause = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';
    const result = await this.pool.query(
      `SELECT pr.article, pr.size, pr.quantity, pr.price, pr.extra,
              sp.name AS supplier_name, pr.created_at, pr.job_id,
              COUNT(*) OVER() AS total
       FROM products_raw pr
       JOIN suppliers sp ON sp.id = pr.supplier_id
       ${whereClause}
       ORDER BY ${orderBy}
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, limit, offset]
    );

    const total = result.rows[0]?.total ? Number(result.rows[0].total) : 0;
    const rows = result.rows.map(({ total: ignored, ...row }) => row);
    return { jobId, total, rows };
  }

  async listFinalPreview(
    options: FinalPreviewOptions
  ): Promise<{ jobId: number | null; total: number; rows: Record<string, unknown>[] }> {
    const { limit, offset } = normalizePagination(options.limit, options.offset);
    const search = String(options.search || '').trim();
    let jobId = options.jobId && Number.isFinite(options.jobId) ? Math.trunc(options.jobId) : null;
    if (!jobId) {
      jobId = await this.getLatestJobId('finalize');
    }

    const supplierId =
      options.supplierId && Number.isFinite(options.supplierId) && options.supplierId > 0
        ? Math.trunc(options.supplierId)
        : null;

    const whereParts: string[] = [];
    const values: unknown[] = [];
    if (jobId) {
      values.push(jobId);
      whereParts.push(`pf.job_id = $${values.length}`);
    }
    if (search) {
      values.push(`%${search}%`);
      const index = values.length;
      whereParts.push(
        `(pf.article ILIKE $${index} OR pf.extra ILIKE $${index} OR sp.name ILIKE $${index})`
      );
    }
    if (supplierId) {
      values.push(supplierId);
      whereParts.push(`pf.supplier_id = $${values.length}`);
    }

    const sort = normalizeSort(options.sort, 'article_asc');
    let orderBy = 'pf.article ASC, pf.id DESC';
    if (sort === 'article_desc') {
      orderBy = 'pf.article DESC, pf.id DESC';
    } else if (sort === 'created_desc') {
      orderBy = 'pf.id DESC';
    }

    const whereClause = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';
    const result = await this.pool.query(
      `SELECT pf.article, pf.size, pf.quantity, pf.price_base,
              COALESCE(po.price_final, pf.price_final) AS price_final,
              pf.extra, sp.name AS supplier_name, pf.created_at, pf.job_id,
              po.id AS override_id, po.price_final AS override_price, po.notes AS override_notes,
              COUNT(*) OVER() AS total
       FROM products_final pf
       LEFT JOIN suppliers sp ON sp.id = pf.supplier_id
       LEFT JOIN price_overrides po
         ON po.article = pf.article
        AND NULLIF(po.size, '') IS NOT DISTINCT FROM NULLIF(pf.size, '')
        AND po.is_active = TRUE
       ${whereClause}
       ORDER BY ${orderBy}
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, limit, offset]
    );

    const total = result.rows[0]?.total ? Number(result.rows[0].total) : 0;
    const rows = result.rows.map(({ total: ignored, ...row }) => row);
    return { jobId, total, rows };
  }

  async listComparePreview(
    options: ComparePreviewOptions
  ): Promise<{ total: number; rows: Record<string, unknown>[] }> {
    const { limit, offset } = normalizePagination(options.limit, options.offset);
    const search = String(options.search || '').trim();
    const supplierId =
      options.supplierId && Number.isFinite(options.supplierId) && options.supplierId > 0
        ? Math.trunc(options.supplierId)
        : null;
    const missingOnly = options.missingOnly === true;
    const store = String(options.store || 'cscart').trim().toLowerCase() || 'cscart';

    const baseWhereParts: string[] = [];
    const baseValues: unknown[] = [];
    if (supplierId) {
      baseValues.push(supplierId);
      baseWhereParts.push(`pf.supplier_id = $${baseValues.length}`);
    }
    const baseWhereClause = baseWhereParts.length ? `WHERE ${baseWhereParts.join(' AND ')}` : '';

    const whereParts: string[] = [];
    const values: unknown[] = [...baseValues];
    if (search) {
      values.push(`%${search}%`);
      const index = values.length;
      whereParts.push(
        `(base.article ILIKE $${index}
          OR base.extra ILIKE $${index}
          OR base.supplier_name ILIKE $${index}
          OR base.sku_article ILIKE $${index})`
      );
    }
    if (missingOnly) {
      whereParts.push('sm_sku.article IS NULL');
    }
    const whereClause = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';
    values.push(store);

    const result = await this.pool.query(
      `WITH base AS (
         SELECT
           pf.id,
           pf.article,
           pf.size,
           pf.quantity,
           pf.price_base,
           COALESCE(po.price_final, pf.price_final) AS price_final,
           pf.extra,
           sp.name AS supplier_name,
           CASE
             WHEN pf.size IS NULL OR btrim(pf.size) = '' THEN pf.article
             WHEN right(lower(pf.article), length(replace(btrim(pf.size), ',', '.'))) =
                  lower(replace(btrim(pf.size), ',', '.'))
               THEN pf.article
             ELSE pf.article || '-' || replace(btrim(pf.size), ',', '.')
           END AS sku_article
         FROM products_final pf
         LEFT JOIN suppliers sp ON sp.id = pf.supplier_id
         LEFT JOIN price_overrides po
           ON po.article = pf.article
          AND NULLIF(po.size, '') IS NOT DISTINCT FROM NULLIF(pf.size, '')
          AND po.is_active = TRUE
         ${baseWhereClause}
       )
       SELECT
         base.article,
         base.size,
         base.quantity,
         base.price_base,
         base.price_final,
         base.extra,
         base.supplier_name,
         base.sku_article,
         sm_base.article AS store_article,
         sm_sku.article AS store_sku,
         sm_sku.visibility AS store_visibility,
         sm_sku.price AS store_price,
         sm_sku.supplier AS store_supplier,
         COUNT(*) OVER() AS total
       FROM base
       LEFT JOIN store_mirror sm_base
         ON sm_base.store = $${values.length}
        AND sm_base.article = base.article
       LEFT JOIN store_mirror sm_sku
         ON sm_sku.store = $${values.length}
        AND sm_sku.article = base.sku_article
       ${whereClause}
       ORDER BY base.id ASC
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, limit, offset]
    );

    const total = result.rows[0]?.total ? Number(result.rows[0].total) : 0;
    const rows = result.rows.map(({ total: ignored, ...row }) => row);
    return { total, rows };
  }
}
