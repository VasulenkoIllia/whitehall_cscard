import type { Pool } from 'pg';
import { SUPPLIER_SKU_PREFIX_RE } from './supplierValidation';

type SizeMappingCreatePayload = {
  size_from: string;
  size_to: string;
  notes?: string | null;
  /** Set to true to explicitly allow empty size_to (maps size to nothing → removes size suffix from SKU) */
  allow_empty_size_to?: boolean;
};

type SizeMappingUpdatePayload = {
  size_from?: string;
  size_to?: string;
  notes?: string | null;
  is_active?: boolean;
  /** Set to true to explicitly allow empty size_to */
  allow_empty_size_to?: boolean;
};

type SizeMappingListOptions = {
  search?: string;
  limit?: number;
  offset?: number;
  maxLimit?: number;
};

type SupplierUpdatePayload = {
  name?: string;
  markup_percent?: number;
  priority?: number;
  min_profit_enabled?: boolean;
  min_profit_amount?: number;
  is_active?: boolean;
  markup_rule_set_id?: number | null;
  sku_prefix?: string | null;
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

type StoreMirrorPreviewOptions = {
  limit: number;
  offset: number;
  search: string | null;
  store: string;
};

type StoreImportPreviewOptions = {
  limit: number;
  offset: number;
  search: string | null;
  supplierId: number | null;
  store: string;
};

type BackendReadinessOptions = {
  store: string;
  maxMirrorAgeMinutes: number;
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

function normalizeSkuPrefix(value: unknown): string | null {
  if (value === null || typeof value === 'undefined') {
    return null;
  }
  const normalized = String(value).trim().toUpperCase();
  if (!normalized) {
    return null;
  }
  if (!SUPPLIER_SKU_PREFIX_RE.test(normalized)) {
    throw createBadRequest(
      'sku_prefix is invalid (allowed: A-Z, 0-9, "-", "_" and max length 24)'
    );
  }
  return normalized;
}

function isSupplierSkuPrefixConflict(err: unknown): boolean {
  return (
    (err as any)?.code === '23505' &&
    String((err as any)?.constraint || '') === 'suppliers_sku_prefix_uq'
  );
}

function isSupplierSkuPrefixFormatViolation(err: unknown): boolean {
  return (
    (err as any)?.code === '23514' &&
    String((err as any)?.constraint || '') === 'suppliers_sku_prefix_format_chk'
  );
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

  const activeItems = items
    .map((item, index) => ({
      ...item,
      source_index: index + 1
    }))
    .filter((item) => item.is_active === true);

  const priorityMap = new Map<number, number[]>();
  for (let index = 0; index < activeItems.length; index += 1) {
    const item = activeItems[index];
    if (!priorityMap.has(item.priority)) {
      priorityMap.set(item.priority, [item.source_index]);
    } else {
      priorityMap.get(item.priority)?.push(item.source_index);
    }
  }
  for (const [priority, sourceIndexes] of priorityMap.entries()) {
    if (sourceIndexes.length > 1) {
      throw createBadRequest(
        `condition #${sourceIndexes[0]}: duplicate priority ${priority} with condition #${sourceIndexes[1]}`
      );
    }
  }

  for (let leftIndex = 0; leftIndex < activeItems.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < activeItems.length; rightIndex += 1) {
      const left = activeItems[leftIndex];
      const right = activeItems[rightIndex];
      const leftTo = left.price_to === null ? Number.POSITIVE_INFINITY : left.price_to;
      const rightTo = right.price_to === null ? Number.POSITIVE_INFINITY : right.price_to;
      const intersects = left.price_from < rightTo && right.price_from < leftTo;
      if (!intersects) {
        continue;
      }
      throw createBadRequest(
        `condition #${left.source_index}: overlaps with condition #${right.source_index}`
      );
    }
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

function normalizePagination(limit: number, offset: number, maxLimit = 1000): { limit: number; offset: number } {
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(maxLimit, Math.trunc(limit))) : 100;
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

  private async getGlobalMarkupRuleSetId(): Promise<number | null> {
    try {
      const result = await this.pool.query(
        `SELECT global_rule_set_id
         FROM markup_settings
         WHERE id = 1
         LIMIT 1`
      );
      const parsed = Number(result.rows[0]?.global_rule_set_id || 0);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return null;
      }
      return Math.trunc(parsed);
    } catch (err) {
      if ((err as any)?.code === '42P01') {
        return null;
      }
      throw err;
    }
  }

  private async setGlobalMarkupRuleSetId(ruleSetId: number): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO markup_settings (id, global_rule_set_id, updated_at)
         VALUES (1, $1, NOW())
         ON CONFLICT (id) DO UPDATE
         SET global_rule_set_id = EXCLUDED.global_rule_set_id,
             updated_at = NOW()`,
        [ruleSetId]
      );
    } catch (err) {
      if ((err as any)?.code === '42P01') {
        throw createBadRequest('markup_settings is not initialized, run migrations');
      }
      throw err;
    }
  }

  private async resolveDefaultMarkupRuleSetId(): Promise<number | null> {
    const globalRuleSetId = await this.getGlobalMarkupRuleSetId();
    if (globalRuleSetId) {
      const globalRuleSet = await this.pool.query(
        `SELECT id
         FROM markup_rule_sets
         WHERE id = $1
           AND is_active = TRUE
         LIMIT 1`,
        [globalRuleSetId]
      );
      if (globalRuleSet.rows[0]) {
        return globalRuleSetId;
      }
    }

    const firstActiveRuleSet = await this.pool.query(
      `SELECT id
       FROM markup_rule_sets
       WHERE is_active = TRUE
       ORDER BY id ASC
       LIMIT 1`
    );
    const fallbackRuleSetId = Number(firstActiveRuleSet.rows[0]?.id || 0);
    if (!Number.isFinite(fallbackRuleSetId) || fallbackRuleSetId <= 0) {
      return null;
    }
    await this.setGlobalMarkupRuleSetId(Math.trunc(fallbackRuleSetId));
    return Math.trunc(fallbackRuleSetId);
  }

  async listSuppliers(options: SupplierListOptions): Promise<Record<string, unknown>[]> {
    const search = String(options.search || '').trim();
    const values: unknown[] = [];
    const whereParts: string[] = [];
    if (search) {
      values.push(`%${search}%`);
      whereParts.push(`(s.name ILIKE $${values.length} OR COALESCE(s.sku_prefix, '') ILIKE $${values.length})`);
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
         s.sku_prefix,
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
    // For CREATE: absent key and explicit null are both treated as "no prefix".
    // normalizeSkuPrefix(undefined) → null, so no hasOwnProperty guard needed here.
    const skuPrefix = normalizeSkuPrefix(payload.sku_prefix ?? null);

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
    } else {
      markupRuleSetId = await this.resolveDefaultMarkupRuleSetId();
    }

    try {
      const result = await this.pool.query(
        `INSERT INTO suppliers
           (name, markup_percent, priority, min_profit_enabled, min_profit_amount, markup_rule_set_id, sku_prefix)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [name, markupPercent, priority, minProfitEnabled, minProfitAmount, markupRuleSetId, skuPrefix]
      );
      return result.rows[0];
    } catch (err) {
      if (isSupplierSkuPrefixConflict(err)) {
        throw createBadRequest('sku_prefix must be unique');
      }
      if (isSupplierSkuPrefixFormatViolation(err)) {
        throw createBadRequest(
          'sku_prefix is invalid (allowed: A-Z, 0-9, "-", "_" and max length 24)'
        );
      }
      throw err;
    }
  }

  async getSupplierNameById(supplierId: number): Promise<string | null> {
    const normalizedId = Math.trunc(Number(supplierId));
    if (!Number.isFinite(normalizedId) || normalizedId <= 0) {
      throw createBadRequest('supplier id is invalid');
    }
    const result = await this.pool.query(
      `SELECT name
       FROM suppliers
       WHERE id = $1
       LIMIT 1`,
      [normalizedId]
    );
    const value = String(result.rows[0]?.name || '').trim();
    return value || null;
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
    const skuPrefix = Object.prototype.hasOwnProperty.call(payload, 'sku_prefix')
      ? normalizeSkuPrefix(payload.sku_prefix)
      : undefined;

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
        markup_rule_set_id: markupRuleSetId,
        sku_prefix: skuPrefix
      },
      values
    );
    if (!updates.length) {
      throw createBadRequest('no fields to update');
    }
    values.push(normalizedId);
    try {
      const result = await this.pool.query(
        `UPDATE suppliers
         SET ${updates.join(', ')}
         WHERE id = $${values.length}
         RETURNING *`,
        values
      );
      return result.rows[0];
    } catch (err) {
      if (isSupplierSkuPrefixConflict(err)) {
        throw createBadRequest('sku_prefix must be unique');
      }
      if (isSupplierSkuPrefixFormatViolation(err)) {
        throw createBadRequest(
          'sku_prefix is invalid (allowed: A-Z, 0-9, "-", "_" and max length 24)'
        );
      }
      throw err;
    }
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

  async listMappings(
    supplierId: number,
    sourceId?: number | null
  ): Promise<Record<string, unknown>[]> {
    const normalizedSupplierId = Math.trunc(Number(supplierId));
    if (!Number.isFinite(normalizedSupplierId) || normalizedSupplierId <= 0) {
      throw createBadRequest('supplierId is invalid');
    }
    const normalizedSourceId = toOptionalFiniteNumber(sourceId);
    if (normalizedSourceId !== null && normalizedSourceId > 0) {
      const result = await this.pool.query(
        `SELECT id, supplier_id, source_id, mapping, header_row, mapping_meta, comment, created_at
         FROM column_mappings
         WHERE supplier_id = $1 AND source_id = $2
         ORDER BY id DESC`,
        [normalizedSupplierId, Math.trunc(normalizedSourceId)]
      );
      return result.rows;
    }
    const result = await this.pool.query(
      `SELECT id, supplier_id, source_id, mapping, header_row, mapping_meta, comment, created_at
       FROM column_mappings
       WHERE supplier_id = $1
       ORDER BY id DESC`,
      [normalizedSupplierId]
    );
    return result.rows;
  }

  async deleteMapping(
    supplierId: number,
    mappingId: number
  ): Promise<Record<string, unknown> | null> {
    const normalizedSupplierId = Math.trunc(Number(supplierId));
    const normalizedMappingId = Math.trunc(Number(mappingId));
    if (!Number.isFinite(normalizedSupplierId) || normalizedSupplierId <= 0) {
      throw createBadRequest('supplierId is invalid');
    }
    if (!Number.isFinite(normalizedMappingId) || normalizedMappingId <= 0) {
      throw createBadRequest('mappingId is invalid');
    }
    const result = await this.pool.query(
      `DELETE FROM column_mappings
       WHERE id = $1 AND supplier_id = $2
       RETURNING id, supplier_id, source_id, mapping, header_row, mapping_meta, comment, created_at`,
      [normalizedMappingId, normalizedSupplierId]
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

  async listMarkupRuleSets(): Promise<{ rule_sets: Record<string, unknown>[]; global_rule_set_id: number | null }> {
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

    const globalRuleSetId = await this.getGlobalMarkupRuleSetId();
    return {
      rule_sets: setsResult.rows.map((set) => ({
        ...set,
        conditions: groupedConditions.get(Number(set.id || 0)) || []
      })),
      global_rule_set_id: globalRuleSetId
    };
  }

  async createMarkupRuleSet(payload: {
    name?: string;
    is_active?: boolean;
    conditions?: MarkupConditionInput[];
  }): Promise<{ rule_set: Record<string, unknown> | null; global_rule_set_id: number | null }> {
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
      return { rule_set: ruleSet, global_rule_set_id: payloadResult.global_rule_set_id };
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
  ): Promise<{ rule_set: Record<string, unknown> | null; global_rule_set_id: number | null }> {
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
      return { rule_set: ruleSet, global_rule_set_id: payloadResult.global_rule_set_id };
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
  }): Promise<{ scope: string; updated_suppliers: number; global_rule_set_id: number | null }> {
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
      const globalRuleSetId = await this.getGlobalMarkupRuleSetId();
      return {
        scope,
        updated_suppliers: updated.rowCount || 0,
        global_rule_set_id: globalRuleSetId
      };
    }

    const updated = await this.pool.query(
      `UPDATE suppliers
       SET markup_rule_set_id = $1
       RETURNING id`,
      [ruleSetId]
    );
    const globalRuleSetId = await this.getGlobalMarkupRuleSetId();
    return {
      scope,
      updated_suppliers: updated.rowCount || 0,
      global_rule_set_id: globalRuleSetId
    };
  }

  async setDefaultMarkupRuleSet(payload: { rule_set_id?: number }): Promise<{ global_rule_set_id: number }> {
    const normalizedRuleSetId = Math.trunc(Number(payload.rule_set_id));
    if (!Number.isFinite(normalizedRuleSetId) || normalizedRuleSetId <= 0) {
      throw createBadRequest('rule_set_id is required');
    }
    const existingRuleSet = await this.pool.query(
      `SELECT id, is_active
       FROM markup_rule_sets
       WHERE id = $1
       LIMIT 1`,
      [normalizedRuleSetId]
    );
    if (!existingRuleSet.rows[0]) {
      throw createNotFound('rule set not found');
    }
    if (existingRuleSet.rows[0].is_active !== true) {
      throw createBadRequest('rule set is inactive');
    }
    await this.setGlobalMarkupRuleSetId(normalizedRuleSetId);
    return {
      global_rule_set_id: normalizedRuleSetId
    };
  }

  async deleteMarkupRuleSet(id: number): Promise<{ deleted: boolean }> {
    // Block if it's the global default
    const globalResult = await this.pool.query(
      `SELECT global_rule_set_id FROM markup_settings WHERE id = 1 LIMIT 1`
    );
    const globalId = Number(globalResult.rows[0]?.global_rule_set_id || 0);
    if (globalId === id) {
      throw createBadRequest('Неможливо видалити основний тип націнки. Спочатку зробіть основним інший.');
    }
    // Block if any supplier uses it
    const usedBy = await this.pool.query(
      `SELECT COUNT(*)::int AS cnt FROM suppliers WHERE markup_rule_set_id = $1`,
      [id]
    );
    if ((usedBy.rows[0]?.cnt || 0) > 0) {
      throw createBadRequest(
        `Неможливо видалити: тип використовується у ${usedBy.rows[0].cnt} постачальника(ів). Спочатку змініть їм тип.`
      );
    }
    await this.pool.query(`DELETE FROM markup_rule_conditions WHERE rule_set_id = $1`, [id]);
    const result = await this.pool.query(
      `DELETE FROM markup_rule_sets WHERE id = $1 RETURNING id`,
      [id]
    );
    if (!result.rows[0]) {
      throw createNotFound('rule set not found');
    }
    return { deleted: true };
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

  async getBackendReadiness(
    options: BackendReadinessOptions
  ): Promise<Record<string, unknown>> {
    const store = String(options.store || 'cscart').trim().toLowerCase() || 'cscart';
    const maxMirrorAgeMinutes = Number.isFinite(options.maxMirrorAgeMinutes)
      ? Math.max(1, Math.trunc(options.maxMirrorAgeMinutes))
      : 120;

    const [
      rawRowsResult,
      rawJobsResult,
      rawOldestResult,
      finalRowsResult,
      logsRowsResult,
      jobsRowsResult,
      mirrorResult,
      coverageResult,
      importAllResult,
      finalizeResult,
      mirrorSyncResult,
      storeImportResult,
      runningResult
    ] = await Promise.all([
      this.pool.query(`SELECT COUNT(*)::bigint::text AS count FROM products_raw`),
      this.pool.query(`SELECT COUNT(DISTINCT job_id)::bigint::text AS count FROM products_raw`),
      this.pool.query(`SELECT MIN(created_at)::text AS oldest FROM products_raw`),
      this.pool.query(`SELECT COUNT(*)::bigint::text AS count FROM products_final`),
      this.pool.query(`SELECT COUNT(*)::bigint::text AS count FROM logs`),
      this.pool.query(`SELECT COUNT(*)::bigint::text AS count FROM jobs`),
      this.pool.query(
        `SELECT
           COUNT(*)::bigint::text AS rows,
           MAX(seen_at)::text AS max_seen_at,
           EXTRACT(EPOCH FROM (NOW() - MAX(seen_at))) / 60 AS age_minutes
         FROM store_mirror
         WHERE store = $1`,
        [store]
      ),
      // NOTE: coverage is computed from products_final, which stores the already-prefixed
      // article (e.g. "SUPA-123").  This is correct as long as products_final is current.
      // After changing a supplier's sku_prefix, coverage stats will be stale until the
      // next finalize run re-bakes the new prefix into products_final.
      this.pool.query(
        `WITH base AS (
           SELECT
             CASE
               WHEN pf.size IS NULL OR btrim(pf.size) = '' THEN pf.article
               WHEN right(lower(pf.article), length(replace(btrim(pf.size), ',', '.'))) =
                    lower(replace(btrim(pf.size), ',', '.'))
                 THEN pf.article
               ELSE pf.article || '-' || replace(btrim(pf.size), ',', '.')
             END AS sku_article
           FROM products_final pf
         )
         SELECT
           COUNT(*)::bigint::text AS total,
           COUNT(*) FILTER (WHERE sm.article IS NOT NULL)::bigint::text AS matched
         FROM base b
         LEFT JOIN store_mirror sm
           ON sm.store = $1
          AND sm.article = b.sku_article`,
        [store]
      ),
      this.pool.query(
        `SELECT id, status, created_at, started_at, finished_at, meta
         FROM jobs
         WHERE type = 'import_all'
           AND status = 'success'
         ORDER BY id DESC
         LIMIT 1`
      ),
      this.pool.query(
        `SELECT id, status, created_at, started_at, finished_at, meta
         FROM jobs
         WHERE type = 'finalize'
           AND status = 'success'
         ORDER BY id DESC
         LIMIT 1`
      ),
      this.pool.query(
        `SELECT id, status, created_at, started_at, finished_at, meta
         FROM jobs
         WHERE type = 'store_mirror_sync'
           AND status = 'success'
         ORDER BY id DESC
         LIMIT 1`
      ),
      this.pool.query(
        `SELECT id, status, created_at, started_at, finished_at, meta
         FROM jobs
         WHERE type = 'store_import'
         ORDER BY id DESC
         LIMIT 1`
      ),
      this.pool.query(
        `SELECT id, type, created_at
         FROM jobs
         WHERE status = 'running'
           AND type = ANY($1::text[])
         ORDER BY id DESC`,
        [['update_pipeline', 'import_all', 'import_source', 'import_supplier', 'finalize', 'store_import', 'cleanup', 'store_mirror_sync']]
      )
    ]);

    let schedulerKnown = true;
    let schedulerRows: Array<Record<string, unknown>> = [];
    try {
      const schedulerResult = await this.pool.query(
        `SELECT
           name,
           is_enabled,
           interval_minutes,
           run_on_startup,
           updated_at
         FROM cron_settings
         ORDER BY name ASC`
      );
      schedulerRows = schedulerResult.rows;
    } catch (err) {
      if ((err as any)?.code === '42P01') {
        schedulerKnown = false;
        schedulerRows = [];
      } else {
        throw err;
      }
    }

    const rawRows = Number(rawRowsResult.rows[0]?.count || 0);
    const rawJobs = Number(rawJobsResult.rows[0]?.count || 0);
    const finalRows = Number(finalRowsResult.rows[0]?.count || 0);
    const logsRows = Number(logsRowsResult.rows[0]?.count || 0);
    const jobsRows = Number(jobsRowsResult.rows[0]?.count || 0);
    const rawOldestCreatedAt = rawOldestResult.rows[0]?.oldest || null;

    const mirrorRows = Number(mirrorResult.rows[0]?.rows || 0);
    const mirrorMaxSeenAt = mirrorResult.rows[0]?.max_seen_at || null;
    const mirrorAgeRaw = mirrorResult.rows[0]?.age_minutes;
    const mirrorAgeMinutes =
      mirrorAgeRaw === null || typeof mirrorAgeRaw === 'undefined'
        ? null
        : Number(mirrorAgeRaw);
    const mirrorFresh =
      mirrorRows > 0 &&
      mirrorAgeMinutes !== null &&
      Number.isFinite(mirrorAgeMinutes) &&
      mirrorAgeMinutes <= maxMirrorAgeMinutes;

    const coverageTotal = Number(coverageResult.rows[0]?.total || 0);
    const coverageMatched = Number(coverageResult.rows[0]?.matched || 0);
    const coverageMissing = Math.max(0, coverageTotal - coverageMatched);
    const coverageMatchedPercent =
      coverageTotal > 0 ? Number(((coverageMatched * 100) / coverageTotal).toFixed(2)) : 0;

    const cleanupTask =
      schedulerRows.find((row) => String(row.name || '') === 'cleanup') || null;
    const cleanupEnabled = cleanupTask ? cleanupTask.is_enabled === true : false;

    const runningBlockingJobs = runningResult.rows.map((row) => ({
      id: Number(row.id || 0),
      type: String(row.type || ''),
      created_at: row.created_at
    }));

    const hasImportAll = Boolean(importAllResult.rows[0]);
    const hasFinalize = Boolean(finalizeResult.rows[0]);
    const hasMirror = mirrorRows > 0;
    const noBlockingJobs = runningBlockingJobs.length === 0;

    return {
      generated_at: new Date().toISOString(),
      store,
      mirror: {
        rows: mirrorRows,
        max_seen_at: mirrorMaxSeenAt,
        age_minutes: mirrorAgeMinutes,
        max_allowed_age_minutes: maxMirrorAgeMinutes,
        is_fresh: mirrorFresh
      },
      coverage: {
        total_final_rows: coverageTotal,
        matched_in_store: coverageMatched,
        missing_in_store: coverageMissing,
        matched_percent: coverageMatchedPercent
      },
      data_volume: {
        products_raw_rows: rawRows,
        products_raw_job_ids: rawJobs,
        products_raw_oldest_created_at: rawOldestCreatedAt,
        products_final_rows: finalRows,
        logs_rows: logsRows,
        jobs_rows: jobsRows
      },
      jobs: {
        last_import_all_success: importAllResult.rows[0] || null,
        last_finalize_success: finalizeResult.rows[0] || null,
        last_store_mirror_sync_success: mirrorSyncResult.rows[0] || null,
        last_store_import: storeImportResult.rows[0] || null,
        running_blocking_jobs: runningBlockingJobs
      },
      scheduler: {
        known: schedulerKnown,
        cleanup_enabled: cleanupEnabled,
        tasks: schedulerRows
      },
      gates: {
        has_import_all_success: hasImportAll,
        has_finalize_success: hasFinalize,
        has_mirror_snapshot: hasMirror,
        mirror_is_fresh: mirrorFresh,
        cleanup_enabled: cleanupEnabled,
        no_blocking_jobs: noBlockingJobs,
        ready_for_store_import:
          hasImportAll &&
          hasFinalize &&
          hasMirror &&
          mirrorFresh &&
          noBlockingJobs,
        ready_for_continuous_runs:
          hasImportAll &&
          hasFinalize &&
          hasMirror &&
          mirrorFresh &&
          noBlockingJobs &&
          cleanupEnabled
      }
    };
  }

  async listMergedPreview(
    options: MergedPreviewOptions
  ): Promise<{ jobId: number | null; total: number; rows: Record<string, unknown>[] }> {
    const { limit, offset } = normalizePagination(options.limit, options.offset, 5000);
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
      whereParts.push(
        `(pr.article ILIKE $${index} OR pr.extra ILIKE $${index} OR pr.comment_text ILIKE $${index})`
      );
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
      `SELECT pr.article, pr.size, pr.quantity, pr.price, pr.extra, pr.comment_text AS comment,
              sp.name AS supplier_name, sp.sku_prefix AS supplier_sku_prefix, pr.created_at, pr.job_id,
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
    const { limit, offset } = normalizePagination(options.limit, options.offset, 5000);
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
        `(pf.article ILIKE $${index}
          OR pf.extra ILIKE $${index}
          OR pf.comment_text ILIKE $${index}
          OR sp.name ILIKE $${index}
          OR COALESCE(sp.sku_prefix, '') ILIKE $${index})`
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
              pf.price_final,
              pf.extra, pf.comment_text AS comment, sp.name AS supplier_name, sp.sku_prefix AS supplier_sku_prefix,
              pf.created_at, pf.job_id,
              COUNT(*) OVER() AS total
       FROM products_final pf
       LEFT JOIN suppliers sp ON sp.id = pf.supplier_id
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
    const { limit, offset } = normalizePagination(options.limit, options.offset, 5000);
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
          OR base.comment ILIKE $${index}
          OR base.supplier_name ILIKE $${index}
          OR base.supplier_sku_prefix ILIKE $${index}
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
           pf.price_final,
           pf.extra,
           pf.comment_text AS comment,
           sp.name AS supplier_name,
           COALESCE(sp.sku_prefix, '') AS supplier_sku_prefix,
           (sp.sku_prefix IS NOT NULL) AS supplier_has_sku_prefix,
           CASE
             WHEN pf.size IS NULL OR btrim(pf.size) = '' THEN pf.article
             WHEN right(lower(pf.article), length(replace(btrim(pf.size), ',', '.'))) =
                  lower(replace(btrim(pf.size), ',', '.'))
               THEN pf.article
             ELSE pf.article || '-' || replace(btrim(pf.size), ',', '.')
           END AS sku_article
         FROM products_final pf
         LEFT JOIN suppliers sp ON sp.id = pf.supplier_id
         ${baseWhereClause}
       )
       SELECT
         base.article,
         base.size,
         base.quantity,
         base.price_base,
         base.price_final,
         base.extra,
         base.comment,
         base.supplier_name,
         NULLIF(base.supplier_sku_prefix, '') AS supplier_sku_prefix,
         base.supplier_has_sku_prefix,
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

  async listStoreMirrorPreview(
    options: StoreMirrorPreviewOptions
  ): Promise<{ total: number; rows: Record<string, unknown>[] }> {
    const { limit, offset } = normalizePagination(options.limit, options.offset);
    const search = String(options.search || '').trim();
    const store = String(options.store || 'cscart').trim().toLowerCase() || 'cscart';

    const values: unknown[] = [store];
    const whereParts: string[] = [`sm.store = $1`];
    if (search) {
      values.push(`%${search}%`);
      const index = values.length;
      whereParts.push(
        `(sm.article ILIKE $${index}
          OR COALESCE(sm.supplier, '') ILIKE $${index}
          OR COALESCE(sm.parent_article, '') ILIKE $${index})`
      );
    }
    const whereClause = `WHERE ${whereParts.join(' AND ')}`;

    const result = await this.pool.query(
      `SELECT
         sm.article,
         sm.supplier,
         sm.parent_article,
         sm.visibility,
         sm.price,
         sm.seen_at,
         sm.synced_at,
         COUNT(*) OVER() AS total
       FROM store_mirror sm
       ${whereClause}
       ORDER BY sm.article ASC
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, limit, offset]
    );

    const total = result.rows[0]?.total ? Number(result.rows[0].total) : 0;
    const rows = result.rows.map(({ total: ignored, ...row }) => row);
    return { total, rows };
  }

  async listStoreImportPreview(
    options: StoreImportPreviewOptions
  ): Promise<{ store: string; jobId: number | null; total: number; rows: Record<string, unknown>[] }> {
    const { limit, offset } = normalizePagination(options.limit, options.offset);
    const search = String(options.search || '').trim();
    const store = String(options.store || 'cscart').trim().toLowerCase() || 'cscart';
    let jobId = await this.getLatestJobId('finalize');
    if (!jobId) {
      return {
        store,
        jobId: null,
        total: 0,
        rows: []
      };
    }

    const supplierId =
      options.supplierId && Number.isFinite(options.supplierId) && options.supplierId > 0
        ? Math.trunc(options.supplierId)
        : null;

    const values: unknown[] = [jobId];
    const whereParts: string[] = [`pf.job_id = $1`];
    if (supplierId) {
      values.push(supplierId);
      whereParts.push(`pf.supplier_id = $${values.length}`);
    }
    if (search) {
      values.push(`%${search}%`);
      const index = values.length;
      whereParts.push(
        `(pf.article ILIKE $${index}
          OR pf.extra ILIKE $${index}
          OR pf.comment_text ILIKE $${index}
          OR sp.name ILIKE $${index}
          OR COALESCE(sp.sku_prefix, '') ILIKE $${index})`
      );
    }
    const whereClause = `WHERE ${whereParts.join(' AND ')}`;

    const result = await this.pool.query(
      `SELECT
         pf.article,
         pf.size,
         pf.quantity,
         pf.price_base,
         pf.price_final,
         TRUE AS visibility,
         CASE
           WHEN pf.size IS NULL OR btrim(pf.size) = '' THEN pf.article
           WHEN right(lower(pf.article), length(replace(btrim(pf.size), ',', '.'))) =
                lower(replace(btrim(pf.size), ',', '.'))
             THEN pf.article
           ELSE pf.article || '-' || replace(btrim(pf.size), ',', '.')
         END AS sku_article,
         CASE
           WHEN pf.size IS NULL OR btrim(pf.size) = '' THEN NULL
           WHEN right(lower(pf.article), length(replace(btrim(pf.size), ',', '.'))) =
                lower(replace(btrim(pf.size), ',', '.'))
             THEN NULLIF(
               btrim(
                 left(
                   pf.article,
                   char_length(pf.article) - char_length(replace(btrim(pf.size), ',', '.'))
                 ),
                 ' -_/'
               ),
               ''
             )
           ELSE pf.article
         END AS parent_article,
         pf.extra,
         pf.comment_text AS comment,
         sp.name AS supplier_name,
         sp.sku_prefix AS supplier_sku_prefix,
         pf.created_at,
         COUNT(*) OVER() AS total
       FROM products_final pf
       LEFT JOIN suppliers sp ON sp.id = pf.supplier_id
       ${whereClause}
       ORDER BY pf.id ASC
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, limit, offset]
    );

    const total = result.rows[0]?.total ? Number(result.rows[0].total) : 0;
    const rows = result.rows.map(({ total: ignored, ...row }) => row);
    return {
      store,
      jobId,
      total,
      rows
    };
  }

  // ─── Size Mappings ────────────────────────────────────────────────────────

  async listSizeMappings(options: SizeMappingListOptions = {}): Promise<{
    total: number;
    rows: Record<string, unknown>[];
  }> {
    const limit = Math.min(Math.max(1, Math.trunc(Number(options.limit) || 200)), options.maxLimit ?? 1000);
    const offset = Math.max(0, Math.trunc(Number(options.offset) || 0));
    const values: unknown[] = [];
    const whereParts: string[] = [];

    if (options.search) {
      values.push(`%${String(options.search).trim()}%`);
      whereParts.push(
        `(LOWER(sm.size_from) LIKE LOWER($${values.length}) OR LOWER(sm.size_to) LIKE LOWER($${values.length}))`
      );
    }

    const whereClause = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';
    const result = await this.pool.query(
      `SELECT id, size_from, size_to, notes, is_active, created_at,
              COUNT(*) OVER() AS total
       FROM size_mappings sm
       ${whereClause}
       ORDER BY sm.size_from ASC
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, limit, offset]
    );

    const totalCount = result.rows[0]?.total ? Number(result.rows[0].total) : 0;
    const rows = result.rows.map(({ total: _ignored, ...row }) => row);
    return { total: totalCount, rows };
  }

  async createSizeMapping(payload: SizeMappingCreatePayload): Promise<Record<string, unknown>> {
    const sizeFrom = String(payload.size_from || '').trim();
    if (!sizeFrom) {
      throw createBadRequest('size_from is required');
    }
    const sizeTo = String(payload.size_to ?? '').trim();
    if (!sizeTo && !payload.allow_empty_size_to) {
      throw createBadRequest('size_to is required (or set allow_empty_size_to=true to map to empty string)');
    }
    const notes = payload.notes ? String(payload.notes).trim() || null : null;

    try {
      const result = await this.pool.query(
        `INSERT INTO size_mappings (size_from, size_to, notes)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [sizeFrom, sizeTo, notes]
      );
      return result.rows[0];
    } catch (err) {
      if ((err as any)?.code === '23505') {
        throw createBadRequest(`size_from "${sizeFrom}" already has a mapping`);
      }
      throw err;
    }
  }

  async updateSizeMapping(
    mappingId: number,
    payload: SizeMappingUpdatePayload
  ): Promise<Record<string, unknown> | null> {
    const normalizedId = Math.trunc(Number(mappingId));
    if (!Number.isFinite(normalizedId) || normalizedId <= 0) {
      throw createBadRequest('invalid mapping id');
    }

    const values: unknown[] = [];
    const updates: string[] = [];

    if (Object.prototype.hasOwnProperty.call(payload, 'size_from')) {
      const sizeFrom = String(payload.size_from || '').trim();
      if (!sizeFrom) throw createBadRequest('size_from must not be empty');
      values.push(sizeFrom);
      updates.push(`size_from = $${values.length}`);
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'size_to')) {
      const sizeTo = String(payload.size_to ?? '').trim();
      if (!sizeTo && !payload.allow_empty_size_to) {
        throw createBadRequest('size_to must not be empty (or set allow_empty_size_to=true to map to empty string)');
      }
      values.push(sizeTo);
      updates.push(`size_to = $${values.length}`);
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'notes')) {
      const notes = payload.notes ? String(payload.notes).trim() || null : null;
      values.push(notes);
      updates.push(`notes = $${values.length}`);
    }
    if (typeof payload.is_active === 'boolean') {
      values.push(payload.is_active);
      updates.push(`is_active = $${values.length}`);
    }

    if (updates.length === 0) {
      throw createBadRequest('no fields to update');
    }

    values.push(normalizedId);
    try {
      const result = await this.pool.query(
        `UPDATE size_mappings SET ${updates.join(', ')} WHERE id = $${values.length} RETURNING *`,
        values
      );
      return result.rows[0] ?? null;
    } catch (err) {
      if ((err as any)?.code === '23505') {
        throw createBadRequest('size_from already used by another mapping');
      }
      if ((err as any)?.code === '23514') {
        throw createBadRequest('size_to must not be empty');
      }
      throw err;
    }
  }

  async deleteSizeMapping(mappingId: number): Promise<Record<string, unknown> | null> {
    const normalizedId = Math.trunc(Number(mappingId));
    if (!Number.isFinite(normalizedId) || normalizedId <= 0) {
      throw createBadRequest('invalid mapping id');
    }
    const result = await this.pool.query(
      `DELETE FROM size_mappings WHERE id = $1 RETURNING *`,
      [normalizedId]
    );
    return result.rows[0] ?? null;
  }

  async bulkImportSizeMappings(
    rows: Array<{ size_from: string; size_to: string; notes?: string | null }>
  ): Promise<{ imported: number; skipped: number }> {
    if (!rows || rows.length === 0) return { imported: 0, skipped: 0 };
    const sizeFromArr: string[] = [];
    const sizeToArr: string[]   = [];
    const notesArr: (string | null)[] = [];
    for (const row of rows) {
      const sf = String(row.size_from || '').trim();
      // size_to may be intentionally empty (maps size to nothing → removes size suffix from SKU)
      const st = String(row.size_to ?? '').trim();
      if (!sf) continue; // only size_from is required
      sizeFromArr.push(sf);
      sizeToArr.push(st);
      notesArr.push(row.notes ? String(row.notes).trim() || null : null);
    }
    if (sizeFromArr.length === 0) return { imported: 0, skipped: rows.length };
    const result = await this.pool.query(
      `INSERT INTO size_mappings (size_from, size_to, notes)
       SELECT trim(sf), trim(st), n
       FROM unnest($1::text[], $2::text[], $3::text[]) AS t(sf, st, n)
       WHERE trim(sf) <> ''
       ON CONFLICT (LOWER(TRIM(size_from))) DO UPDATE
         SET size_to = EXCLUDED.size_to,
             notes   = COALESCE(EXCLUDED.notes, size_mappings.notes),
             is_active = TRUE
       RETURNING id`,
      [sizeFromArr, sizeToArr, notesArr]
    );
    const imported = result.rowCount ?? 0;
    return { imported, skipped: sizeFromArr.length - imported };
  }

  async listUnmappedSizes(limit = 200, maxLimit = 2000): Promise<{
    total: number;
    fetchedCount: number;
    rows: { raw_size: string; will_become: string; product_count: number; supplier_count: number }[];
  }> {
    const safeLimit = Math.min(Math.max(1, Math.trunc(Number(limit) || 200)), maxLimit);
    const result = await this.pool.query(
      `WITH unmapped AS (
         SELECT
           pr.size                              AS raw_size,
           UPPER(TRIM(pr.size))                 AS will_become,
           COUNT(*)::int                        AS product_count,
           COUNT(DISTINCT pr.supplier_id)::int  AS supplier_count
         FROM products_raw pr
         LEFT JOIN size_mappings szm
           ON LOWER(TRIM(pr.size)) = LOWER(TRIM(szm.size_from))
         WHERE szm.id IS NULL
           AND pr.size IS NOT NULL
           AND TRIM(pr.size) <> ''
         GROUP BY pr.size
       )
       SELECT *, COUNT(*) OVER()::int AS total_count
       FROM unmapped
       ORDER BY product_count DESC
       LIMIT $1`,
      [safeLimit]
    );
    const realTotal = result.rows.length > 0 ? Number(result.rows[0].total_count) : 0;
    return {
      total: realTotal,
      fetchedCount: result.rows.length,
      rows: result.rows.map(({ total_count, ...r }) => r) as { raw_size: string; will_become: string; product_count: number; supplier_count: number }[]
    };
  }
}
