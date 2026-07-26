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
  /** Current visibility in store_mirror (undefined = not enriched) */
  storeVisibility?: boolean | null;
  /** Current price in store_mirror (undefined = not enriched) */
  storePrice?: number | null;
  /** Current amount in store_mirror (set by filterCsCartDelta; null = missing in mirror) */
  storeAmount?: number | null;
  /** Current parent_product_id in store_mirror (undefined = not enriched) */
  storeParentProductId?: string | null;
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
  collectionCode: string | null;
  variationGroupCode: string | null;
}

const UPSERT_CHUNK_SIZE = 500;

/**
 * A snapshot that fails to see more than this share of the mirror is treated as
 * broken rather than authoritative. See pruneSnapshot for the reasoning.
 */
const DEFAULT_MAX_PRUNE_RATIO = 0.2;

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
  const collectionRaw = row.collectionCode;
  const collectionCode =
    typeof collectionRaw === 'string' && collectionRaw.trim().length > 0
      ? collectionRaw.trim()
      : null;
  const variationGroupRaw = row.variationGroupCode;
  const variationGroupCode =
    typeof variationGroupRaw === 'string' && variationGroupRaw.trim().length > 0
      ? variationGroupRaw.trim()
      : null;
  return {
    store,
    article,
    supplier: row.supplier || null,
    parentArticle: row.parentArticle || null,
    visibility: row.visibility === true,
    price: normalizePrice(row.price),
    amount,
    raw: row.raw ?? null,
    seenAt,
    collectionCode,
    variationGroupCode
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
  private readonly maxPruneRatio: number;

  constructor(
    private readonly pool: Pool,
    options: { maxPruneRatio?: number } = {}
  ) {
    const ratio = Number(options.maxPruneRatio);
    this.maxPruneRatio =
      Number.isFinite(ratio) && ratio > 0 && ratio <= 1 ? ratio : DEFAULT_MAX_PRUNE_RATIO;
  }

  /**
   * Marker identifying one snapshot run. Read from Postgres rather than the
   * Node clock so every seen_at in store_mirror is comparable against a single
   * authoritative clock even when several app instances write to the mirror.
   */
  async createSyncMarker(): Promise<string> {
    const result = await this.pool.query<{ now: Date }>(`SELECT NOW() AS now`);
    const marker = result.rows[0]?.now;
    if (!marker) {
      throw new Error('Failed to read sync marker from database');
    }
    return new Date(marker).toISOString();
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
    maxMirrorAgeMinutes: number,
    options?: { allowCreate?: boolean }
  ): Promise<{ rows: CsCartDeltaInputRow[]; summary: CsCartDeltaSummary }> {
    const safeMaxAge = Number.isFinite(maxMirrorAgeMinutes)
      ? Math.max(1, Math.trunc(maxMirrorAgeMinutes))
      : 120;
    // When allowCreate=false the gateway will skip every SKU it cannot find in
    // the mirror. Pre-filtering them here avoids dragging 100K+ unused rows
    // through the gateway loop just to skip them at the very end. Net result
    // for the store is identical (those SKUs were never going to be touched).
    const allowCreate = options?.allowCreate === true;
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
        changedRows.push({
          ...row,
          productId: null,
          resolvedParentProductId: null,
          storeVisibility: null,
          storePrice: null,
          storeAmount: null,
          storeParentProductId: null
        });
        continue;
      }

      const current = stateByCode.get(code);
      if (!current) {
        missingInMirror += 1;
        // When allowCreate=false the gateway can't do anything with these rows
        // (it will just skip them). Don't push — saves the gateway loop from
        // iterating through tens of thousands of rows it would skip anyway.
        // Counter still increments so the operator sees the real number.
        if (!allowCreate) {
          continue;
        }
        changedRows.push({
          ...row,
          productId: null,
          resolvedParentProductId: null,
          storeVisibility: null,
          storePrice: null,
          storeAmount: null,
          storeParentProductId: null
        });
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
      // parentSame returns true when:
      //   - parent cannot be resolved in mirror (parentComparable=false) — we won't
      //     send parent_product_id in the PUT payload anyway, so it's a noop for parent.
      //   - row has no parent (top-level product).
      //   - both current and desired parents match.
      const parentSame = !parentComparable || !parentCode || current.parentProductId === desiredParentProductId;

      // Skip when nothing observable would change in the store.
      // NOTE: parentComparable is deliberately NOT in the skip predicate — when parent is
      // unresolvable, the gateway also does not modify parent (buildLegacyPayload omits
      // parent_product_id when null). Forcing such rows through the gateway just produces
      // a no-op PUT (or a no-op bulk slot), wasting an HTTP round-trip per variant.
      // unresolvedParent counter still tracks the diagnostic signal for operators.
      if (visibilitySame && priceSame && amountSame && parentSame) {
        skippedUnchanged += 1;
        continue;
      }

      changedRows.push({
        ...row,
        productId: current.productId,
        resolvedParentProductId: desiredParentProductId,
        storeVisibility: current.visibility,
        storePrice: current.price,
        storeAmount: current.amount,
        storeParentProductId: current.parentProductId
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
         amount,
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
      amount: number;
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
        amount: normalizeAmount(row.amount),
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
        resolvedParentProductId: row.parentProductId,
        storeVisibility: row.visibility,
        storePrice: row.price,
        storeAmount: row.amount,
        storeParentProductId: row.parentProductId
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
      const base = index * 11;
      values.push(
        row.store,
        row.article,
        row.supplier,
        row.parentArticle,
        row.visibility,
        row.price,
        row.amount,
        JSON.stringify(row.raw),
        row.seenAt,
        row.collectionCode ?? null,
        row.variationGroupCode ?? null
      );
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11})`;
    });

    await this.pool.query(
      `INSERT INTO store_mirror
         (store, article, supplier, parent_article, visibility, price, amount, raw, seen_at, collection_code, variation_group_code)
       VALUES ${placeholders.join(', ')}
       ON CONFLICT (store, article) DO UPDATE
         SET supplier = EXCLUDED.supplier,
             parent_article = EXCLUDED.parent_article,
             visibility = EXCLUDED.visibility,
             price = EXCLUDED.price,
             amount = EXCLUDED.amount,
             raw = EXCLUDED.raw,
             synced_at = NOW(),
             seen_at = EXCLUDED.seen_at,
             collection_code = EXCLUDED.collection_code,
             variation_group_code = EXCLUDED.variation_group_code`,
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

  /**
   * Drop rows this snapshot did not see, i.e. products that disappeared from
   * the store.
   *
   * The condition is `seen_at < marker`, NOT `seen_at IS DISTINCT FROM marker`.
   * The old form deleted rows written by any *other* run, including one still
   * in flight, so two overlapping snapshots destroyed each other's work: on
   * 2026-07-22 the mirror went from 242 613 rows to 613 and the store import
   * that followed pushed nothing. Rows carrying a newer marker belong to a run
   * that started after this one and are none of our business.
   *
   * The ratio guard is the second line of defence. A snapshot that misses most
   * of the catalog is a broken snapshot — a concurrent sync, an interrupted
   * walk, a store API returning short pages — and must never be treated as the
   * authority on what to delete. Failing loudly keeps a stale mirror, which is
   * recoverable; an emptied mirror silently stops every update to the store.
   */
  async pruneSnapshot(store: ActiveStore, seenAt: string): Promise<number> {
    // Single statement so the count and the delete observe the same snapshot —
    // a concurrent sync cannot slip rows in between the guard and the delete.
    const result = await this.pool.query<{ total: string; stale: string; deleted: string }>(
      `WITH stats AS (
         SELECT
           COUNT(*) AS total,
           COUNT(*) FILTER (WHERE seen_at IS NULL OR seen_at < $2) AS stale
         FROM store_mirror
         WHERE store = $1
       ),
       removed AS (
         DELETE FROM store_mirror
         WHERE store = $1
           AND (seen_at IS NULL OR seen_at < $2)
           -- NULLIF guards the very first sync on an empty mirror: Postgres does
           -- not promise to short-circuit OR, so total=0 must not reach a division.
           AND (SELECT total = 0 OR stale::numeric / NULLIF(total, 0) <= $3::numeric FROM stats)
         RETURNING 1
       )
       SELECT
         (SELECT total FROM stats)::text   AS total,
         (SELECT stale FROM stats)::text   AS stale,
         (SELECT COUNT(*) FROM removed)::text AS deleted`,
      [store, seenAt, this.maxPruneRatio]
    );

    const total = Number(result.rows[0]?.total || '0');
    const stale = Number(result.rows[0]?.stale || '0');
    const deleted = Number(result.rows[0]?.deleted || '0');

    if (total > 0 && stale / total > this.maxPruneRatio) {
      const percent = ((stale / total) * 100).toFixed(1);
      const limit = (this.maxPruneRatio * 100).toFixed(0);
      throw new Error(
        `store_mirror prune refused for store "${store}": snapshot saw only ${total - stale} of ` +
          `${total} rows, pruning would delete ${stale} (${percent}%, limit ${limit}%). ` +
          'Most likely a concurrent snapshot or an interrupted catalog walk. Mirror left untouched.'
      );
    }

    return deleted;
  }

  async syncSnapshot(store: ActiveStore, items: MirrorRow[]): Promise<StoreMirrorSyncSummary> {
    const seenAt = await this.createSyncMarker();
    const upserted = await this.upsertSnapshotChunk(store, items, seenAt);
    const deleted = await this.pruneSnapshot(store, seenAt);

    return {
      store,
      upserted,
      deleted
    };
  }
}
