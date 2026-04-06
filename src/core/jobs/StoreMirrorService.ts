import type { Pool } from 'pg';
import type { ActiveStore } from '../config/types';
import type { MirrorRow } from '../domain/store';

export interface StoreMirrorSyncSummary {
  store: ActiveStore;
  upserted: number;
  deleted: number;
}

export interface CsCartDeltaInputRow {
  productCode: string;
  parentProductCode: string | null;
  visibility: boolean;
  price: number | null;
  amount: number;
  // Pre-resolved from store_mirror by filterCsCartDelta (undefined = not enriched / mirror was stale)
  productId?: string | null;
  resolvedParentProductId?: string | null;
}

export interface CsCartDeltaSummary {
  enabled: boolean;
  reason: 'ok' | 'mirror_empty' | 'mirror_stale';
  maxMirrorAgeMinutes: number;
  mirrorAgeMinutes: number | null;
  total: number;
  changed: number;
  skippedUnchanged: number;
  missingInMirror: number;
  unresolvedParent: number;
}

export interface CsCartMissingDeactivationSummary {
  enabled: boolean;
  reason: 'ok' | 'mirror_empty' | 'mirror_stale';
  maxMirrorAgeMinutes: number;
  mirrorAgeMinutes: number | null;
  inputTotal: number;
  mirrorTotal: number;
  activeInMirror: number;
  missingInFinal: number;
  appended: number;
}

export interface CsCartFeatureScopeSummary {
  enabled: boolean;
  reason: 'ok' | 'mirror_empty' | 'mirror_stale';
  featureId: string;
  expectedValue: string;
  maxMirrorAgeMinutes: number;
  mirrorAgeMinutes: number | null;
  inputTotal: number;
  mirrorTotal: number;
  managedInMirror: number;
  matchedInput: number;
  matchedManagedInput: number;
  matchedMissingInMirrorInput: number;
  droppedInput: number;
}

interface StoreMirrorRow {
  store: ActiveStore;
  article: string;
  supplier: string | null;
  parentArticle: string | null;
  visibility: boolean;
  price: number | null;
  amount: number;
  raw: unknown;
  seenAt: string;
}

const UPSERT_CHUNK_SIZE = 500;

interface CsCartMirrorStateRow {
  article: string;
  visibility: boolean;
  price: string | number | null;
  amount: string | number | null;
  parentProductId: string | null;
  productId: string | null;
}

interface CsCartMirrorFreshnessRow {
  ageMinutes: string | null;
  totalRows: string;
}

function normalizeArticle(value: unknown): string {
  return String(value || '').trim();
}

function normalizePrice(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return parsed;
}

function normalizeParentProductId(value: unknown): string | null {
  const normalized = String(value || '').trim();
  if (!normalized || normalized === '0') {
    return null;
  }
  return normalized;
}

function normalizeAmount(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : 0;
}

function toPersistRow(store: ActiveStore, row: MirrorRow, seenAt: string): StoreMirrorRow | null {
  const article = normalizeArticle(row.article);
  if (!article) {
    return null;
  }
  const rawObj = row.raw as Record<string, unknown> | null;
  const amount =
    rawObj && typeof rawObj === 'object' && !Array.isArray(rawObj)
      ? normalizeAmount(rawObj.amount)
      : 0;
  return {
    store,
    article,
    supplier: row.supplier || null,
    parentArticle: row.parentArticle || null,
    visibility: row.visibility === true,
    price: normalizePrice(row.price),
    amount,
    raw: row.raw ?? null,
    seenAt
  };
}

function dedupeMirrorRows(rows: StoreMirrorRow[]): StoreMirrorRow[] {
  if (!rows.length) {
    return rows;
  }
  const byArticle = new Map<string, StoreMirrorRow>();
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    byArticle.set(row.article, row);
  }
  return Array.from(byArticle.values());
}

export class StoreMirrorService {
  constructor(private readonly pool: Pool) {}

  createSyncMarker(now: Date = new Date()): string {
    return now.toISOString();
  }

  private async getCsCartMirrorFreshness(): Promise<{ ageMinutes: number | null; totalRows: number }> {
    const freshnessResult = await this.pool.query<CsCartMirrorFreshnessRow>(
      `SELECT
         EXTRACT(EPOCH FROM (NOW() - MAX(seen_at))) / 60 AS "ageMinutes",
         COUNT(*)::text AS "totalRows"
       FROM store_mirror
       WHERE store = 'cscart'`
    );

    const ageRaw = freshnessResult.rows[0]?.ageMinutes;
    return {
      ageMinutes: ageRaw === null ? null : Number(ageRaw),
      totalRows: Number(freshnessResult.rows[0]?.totalRows || '0')
    };
  }

  async filterCsCartDelta(
    rows: CsCartDeltaInputRow[],
    maxMirrorAgeMinutes: number
  ): Promise<{ rows: CsCartDeltaInputRow[]; summary: CsCartDeltaSummary }> {
    const safeMaxAge = Number.isFinite(maxMirrorAgeMinutes)
      ? Math.max(1, Math.trunc(maxMirrorAgeMinutes))
      : 120;
    const total = rows.length;
    const freshness = await this.getCsCartMirrorFreshness();
    const ageMinutes = freshness.ageMinutes;
    const mirrorRowsCount = freshness.totalRows;

    if (!mirrorRowsCount) {
      return {
        rows,
        summary: {
          enabled: false,
          reason: 'mirror_empty',
          maxMirrorAgeMinutes: safeMaxAge,
          mirrorAgeMinutes: ageMinutes,
          total,
          changed: total,
          skippedUnchanged: 0,
          missingInMirror: total,
          unresolvedParent: 0
        }
      };
    }

    if (ageMinutes !== null && ageMinutes > safeMaxAge) {
      return {
        rows,
        summary: {
          enabled: false,
          reason: 'mirror_stale',
          maxMirrorAgeMinutes: safeMaxAge,
          mirrorAgeMinutes: ageMinutes,
          total,
          changed: total,
          skippedUnchanged: 0,
          missingInMirror: 0,
          unresolvedParent: 0
        }
      };
    }

    const mirrorResult = await this.pool.query<CsCartMirrorStateRow>(
      `SELECT
         article,
         visibility,
         price,
         amount,
         COALESCE(NULLIF(raw->>'parent_product_id', ''), NULLIF(parent_article, '')) AS "parentProductId",
         NULLIF(raw->>'product_id', '') AS "productId"
       FROM store_mirror
       WHERE store = 'cscart'`
    );

    const stateByCode = new Map<
      string,
      {
        visibility: boolean;
        price: number;
        amount: number;
        parentProductId: string | null;
        productId: string | null;
      }
    >();
    for (let index = 0; index < mirrorResult.rows.length; index += 1) {
      const row = mirrorResult.rows[index];
      const code = normalizeArticle(row.article);
      if (!code) {
        continue;
      }
      stateByCode.set(code, {
        visibility: row.visibility === true,
        price: Number(row.price || 0) || 0,
        amount: normalizeAmount(row.amount),
        parentProductId: normalizeParentProductId(row.parentProductId),
        productId: normalizeParentProductId(row.productId)
      });
    }

    const changedRows: CsCartDeltaInputRow[] = [];
    let skippedUnchanged = 0;
    let missingInMirror = 0;
    let unresolvedParent = 0;

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const code = normalizeArticle(row.productCode);
      if (!code) {
        changedRows.push({ ...row, productId: null, resolvedParentProductId: null });
        continue;
      }

      const current = stateByCode.get(code);
      if (!current) {
        missingInMirror += 1;
        changedRows.push({ ...row, productId: null, resolvedParentProductId: null });
        continue;
      }

      const desiredVisibility = row.visibility === true;
      const desiredPrice = Number(row.price || 0) || 0;
      // Use the actual stock quantity from products_final.
      // If the product is hidden (visibility=false) the amount is always 0.
      const desiredAmount = desiredVisibility ? Math.max(0, Math.trunc(Number(row.amount) || 0)) : 0;
      const parentCode = normalizeArticle(row.parentProductCode);

      let parentComparable = true;
      let desiredParentProductId: string | null = null;
      if (parentCode) {
        const parentState = stateByCode.get(parentCode);
        if (!parentState?.productId) {
          parentComparable = false;
          unresolvedParent += 1;
        } else {
          desiredParentProductId = parentState.productId;
        }
      }

      const priceSame = Math.abs(current.price - desiredPrice) <= 0.01;
      const visibilitySame = current.visibility === desiredVisibility;
      const amountSame = current.amount === desiredAmount;
      // If parentCode is empty we have no desired parent — skip the comparison entirely.
      // We do not manage parent-child relationships; sending parent_product_id: 0
      // for CS-Cart variant products breaks the PUT request.
      const parentSame = !parentComparable || !parentCode || current.parentProductId === desiredParentProductId;

      if (visibilitySame && priceSame && amountSame && parentComparable && parentSame) {
        skippedUnchanged += 1;
        continue;
      }

      changedRows.push({
        ...row,
        productId: current.productId,
        resolvedParentProductId: desiredParentProductId
      });
    }

    return {
      rows: changedRows,
      summary: {
        enabled: true,
        reason: 'ok',
        maxMirrorAgeMinutes: safeMaxAge,
        mirrorAgeMinutes: ageMinutes,
        total,
        changed: changedRows.length,
        skippedUnchanged,
        missingInMirror,
        unresolvedParent
      }
    };
  }

  async filterCsCartRowsByFeature(
    rows: CsCartDeltaInputRow[],
    maxMirrorAgeMinutes: number,
    featureId: string,
    expectedValue: string
  ): Promise<{
    rows: CsCartDeltaInputRow[];
    managedCodes: Set<string>;
    summary: CsCartFeatureScopeSummary;
  }> {
    const safeMaxAge = Number.isFinite(maxMirrorAgeMinutes)
      ? Math.max(1, Math.trunc(maxMirrorAgeMinutes))
      : 120;
    const normalizedFeatureId = String(featureId || '').trim();
    const normalizedExpected = String(expectedValue || '').trim().toLowerCase();
    const inputTotal = rows.length;
    const freshness = await this.getCsCartMirrorFreshness();
    const ageMinutes = freshness.ageMinutes;
    const mirrorRowsCount = freshness.totalRows;

    if (!mirrorRowsCount) {
      return {
        rows: [],
        managedCodes: new Set<string>(),
        summary: {
          enabled: false,
          reason: 'mirror_empty',
          featureId: normalizedFeatureId,
          expectedValue,
          maxMirrorAgeMinutes: safeMaxAge,
          mirrorAgeMinutes: ageMinutes,
          inputTotal,
          mirrorTotal: mirrorRowsCount,
          managedInMirror: 0,
          matchedInput: 0,
          matchedManagedInput: 0,
          matchedMissingInMirrorInput: 0,
          droppedInput: inputTotal
        }
      };
    }

    if (ageMinutes !== null && ageMinutes > safeMaxAge) {
      return {
        rows: [],
        managedCodes: new Set<string>(),
        summary: {
          enabled: false,
          reason: 'mirror_stale',
          featureId: normalizedFeatureId,
          expectedValue,
          maxMirrorAgeMinutes: safeMaxAge,
          mirrorAgeMinutes: ageMinutes,
          inputTotal,
          mirrorTotal: mirrorRowsCount,
          managedInMirror: 0,
          matchedInput: 0,
          matchedManagedInput: 0,
          matchedMissingInMirrorInput: 0,
          droppedInput: inputTotal
        }
      };
    }

    const managedCodes = new Set<string>();
    const mirrorCodes = new Set<string>();
    if (normalizedFeatureId) {
      // Push feature filter and article enumeration to PostgreSQL.
      // Avoids loading all raw JSONB (~5 KB/row) into Node.js memory
      // which caused OOM at 177 K+ products and would not scale to 500 K+.
      const [managedResult, allArticlesResult] = await Promise.all([
        this.pool.query<{ article: string }>(
          `SELECT article
           FROM store_mirror
           WHERE store = 'cscart'
             AND LOWER((raw->'product_features'->($1::text))->>'value') = $2`,
          [normalizedFeatureId, normalizedExpected]
        ),
        this.pool.query<{ article: string }>(
          `SELECT article FROM store_mirror WHERE store = 'cscart'`
        )
      ]);

      for (let index = 0; index < managedResult.rows.length; index += 1) {
        const article = normalizeArticle(managedResult.rows[index].article);
        if (article) {
          managedCodes.add(article);
        }
      }
      for (let index = 0; index < allArticlesResult.rows.length; index += 1) {
        const article = normalizeArticle(allArticlesResult.rows[index].article);
        if (article) {
          mirrorCodes.add(article);
        }
      }
    }
    const filteredRows: CsCartDeltaInputRow[] = [];
    let matchedManagedInput = 0;
    let matchedMissingInMirrorInput = 0;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const code = normalizeArticle(row.productCode);
      if (!code) {
        continue;
      }
      if (managedCodes.has(code)) {
        matchedManagedInput += 1;
        filteredRows.push(row);
        continue;
      }
      if (!mirrorCodes.has(code)) {
        matchedMissingInMirrorInput += 1;
        filteredRows.push(row);
      }
    }
    return {
      rows: filteredRows,
      managedCodes,
      summary: {
        enabled: true,
        reason: 'ok',
        featureId: normalizedFeatureId,
        expectedValue,
        maxMirrorAgeMinutes: safeMaxAge,
        mirrorAgeMinutes: ageMinutes,
        inputTotal,
        mirrorTotal: mirrorRowsCount,
        managedInMirror: managedCodes.size,
        matchedInput: filteredRows.length,
        matchedManagedInput,
        matchedMissingInMirrorInput,
        droppedInput: Math.max(0, inputTotal - filteredRows.length)
      }
    };
  }

  async appendCsCartMissingAsHidden(
    rows: CsCartDeltaInputRow[],
    maxMirrorAgeMinutes: number,
    options?: { managedCodes?: Set<string> | null }
  ): Promise<{ rows: CsCartDeltaInputRow[]; summary: CsCartMissingDeactivationSummary }> {
    const safeMaxAge = Number.isFinite(maxMirrorAgeMinutes)
      ? Math.max(1, Math.trunc(maxMirrorAgeMinutes))
      : 120;
    const inputTotal = rows.length;
    const freshness = await this.getCsCartMirrorFreshness();
    const ageMinutes = freshness.ageMinutes;
    const mirrorRowsCount = freshness.totalRows;

    if (!mirrorRowsCount) {
      return {
        rows,
        summary: {
          enabled: false,
          reason: 'mirror_empty',
          maxMirrorAgeMinutes: safeMaxAge,
          mirrorAgeMinutes: ageMinutes,
          inputTotal,
          mirrorTotal: mirrorRowsCount,
          activeInMirror: 0,
          missingInFinal: 0,
          appended: 0
        }
      };
    }

    if (ageMinutes !== null && ageMinutes > safeMaxAge) {
      return {
        rows,
        summary: {
          enabled: false,
          reason: 'mirror_stale',
          maxMirrorAgeMinutes: safeMaxAge,
          mirrorAgeMinutes: ageMinutes,
          inputTotal,
          mirrorTotal: mirrorRowsCount,
          activeInMirror: 0,
          missingInFinal: 0,
          appended: 0
        }
      };
    }

    const sourceCodes = new Set<string>();
    for (let index = 0; index < rows.length; index += 1) {
      const code = normalizeArticle(rows[index].productCode);
      if (code) {
        sourceCodes.add(code);
      }
    }

    const mirrorResult = await this.pool.query<CsCartMirrorStateRow>(
      `SELECT
         article,
         visibility,
         price,
         COALESCE(NULLIF(raw->>'parent_product_id', ''), NULLIF(parent_article, '')) AS "parentProductId",
         NULLIF(raw->>'product_id', '') AS "productId"
       FROM store_mirror
       WHERE store = 'cscart'`
    );

    const idToCode = new Map<string, string>();
    const mirrorRows: Array<{
      article: string;
      visibility: boolean;
      price: number | null;
      parentProductId: string | null;
      productId: string | null;
    }> = [];

    for (let index = 0; index < mirrorResult.rows.length; index += 1) {
      const row = mirrorResult.rows[index];
      const article = normalizeArticle(row.article);
      if (!article) {
        continue;
      }
      const productId = normalizeParentProductId(row.productId);
      if (productId) {
        idToCode.set(productId, article);
      }
      mirrorRows.push({
        article,
        visibility: row.visibility === true,
        price: normalizePrice(row.price),
        parentProductId: normalizeParentProductId(row.parentProductId),
        productId
      });
    }

    let activeInMirror = 0;
    let missingInFinal = 0;
    const appendedRows: CsCartDeltaInputRow[] = [];
    const managedCodes = options?.managedCodes || null;

    for (let index = 0; index < mirrorRows.length; index += 1) {
      const row = mirrorRows[index];
      if (managedCodes && !managedCodes.has(row.article)) {
        continue;
      }
      if (!row.visibility) {
        continue;
      }
      activeInMirror += 1;
      if (sourceCodes.has(row.article)) {
        continue;
      }

      missingInFinal += 1;
      const parentProductCode = row.parentProductId ? idToCode.get(row.parentProductId) || null : null;
      appendedRows.push({
        productCode: row.article,
        parentProductCode,
        visibility: false,
        price: row.price,
        amount: 0,
        productId: row.productId,
        resolvedParentProductId: row.parentProductId
      });
    }

    const mergedRows = appendedRows.length ? [...rows, ...appendedRows] : rows;
    return {
      rows: mergedRows,
      summary: {
        enabled: true,
        reason: 'ok',
        maxMirrorAgeMinutes: safeMaxAge,
        mirrorAgeMinutes: ageMinutes,
        inputTotal,
        mirrorTotal: mirrorRowsCount,
        activeInMirror,
        missingInFinal,
        appended: appendedRows.length
      }
    };
  }

  private async upsertBatch(rows: StoreMirrorRow[]): Promise<void> {
    if (!rows.length) {
      return;
    }
    const dedupedRows = dedupeMirrorRows(rows);
    if (!dedupedRows.length) {
      return;
    }

    const values: Array<string | number | boolean | null> = [];
    const placeholders = dedupedRows.map((row, index) => {
      const base = index * 9;
      values.push(
        row.store,
        row.article,
        row.supplier,
        row.parentArticle,
        row.visibility,
        row.price,
        row.amount,
        JSON.stringify(row.raw),
        row.seenAt
      );
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9})`;
    });

    await this.pool.query(
      `INSERT INTO store_mirror
         (store, article, supplier, parent_article, visibility, price, amount, raw, seen_at)
       VALUES ${placeholders.join(', ')}
       ON CONFLICT (store, article) DO UPDATE
         SET supplier = EXCLUDED.supplier,
             parent_article = EXCLUDED.parent_article,
             visibility = EXCLUDED.visibility,
             price = EXCLUDED.price,
             amount = EXCLUDED.amount,
             raw = EXCLUDED.raw,
             synced_at = NOW(),
             seen_at = EXCLUDED.seen_at`,
      values
    );
  }

  async upsertSnapshotChunk(store: ActiveStore, items: MirrorRow[], seenAt: string): Promise<number> {
    const prepared = items
      .map((row) => toPersistRow(store, row, seenAt))
      .filter((row): row is StoreMirrorRow => Boolean(row));

    for (let start = 0; start < prepared.length; start += UPSERT_CHUNK_SIZE) {
      const chunk = prepared.slice(start, start + UPSERT_CHUNK_SIZE);
      // eslint-disable-next-line no-await-in-loop
      await this.upsertBatch(chunk);
    }

    return prepared.length;
  }

  async pruneSnapshot(store: ActiveStore, seenAt: string): Promise<number> {
    const deleteResult = await this.pool.query(
      `DELETE FROM store_mirror
       WHERE store = $1
         AND seen_at IS DISTINCT FROM $2`,
      [store, seenAt]
    );
    return deleteResult.rowCount || 0;
  }

  async syncSnapshot(store: ActiveStore, items: MirrorRow[]): Promise<StoreMirrorSyncSummary> {
    const seenAt = this.createSyncMarker();
    const upserted = await this.upsertSnapshotChunk(store, items, seenAt);
    const deleted = await this.pruneSnapshot(store, seenAt);

    return {
      store,
      upserted,
      deleted
    };
  }
}
