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

interface StoreMirrorRow {
  store: ActiveStore;
  article: string;
  supplier: string | null;
  parentArticle: string | null;
  visibility: boolean;
  price: number | null;
  raw: unknown;
  seenAt: string;
}

const UPSERT_CHUNK_SIZE = 500;

interface CsCartMirrorStateRow {
  article: string;
  visibility: boolean;
  price: string | number | null;
  parentProductId: string | null;
  productId: string | null;
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

function toPersistRow(store: ActiveStore, row: MirrorRow, seenAt: string): StoreMirrorRow | null {
  const article = normalizeArticle(row.article);
  if (!article) {
    return null;
  }
  return {
    store,
    article,
    supplier: row.supplier || null,
    parentArticle: row.parentArticle || null,
    visibility: row.visibility === true,
    price: normalizePrice(row.price),
    raw: row.raw ?? null,
    seenAt
  };
}

export class StoreMirrorService {
  constructor(private readonly pool: Pool) {}

  createSyncMarker(now: Date = new Date()): string {
    return now.toISOString();
  }

  async filterCsCartDelta(
    rows: CsCartDeltaInputRow[],
    maxMirrorAgeMinutes: number
  ): Promise<{ rows: CsCartDeltaInputRow[]; summary: CsCartDeltaSummary }> {
    const safeMaxAge = Number.isFinite(maxMirrorAgeMinutes)
      ? Math.max(1, Math.trunc(maxMirrorAgeMinutes))
      : 120;
    const total = rows.length;

    const freshnessResult = await this.pool.query<{ ageMinutes: string | null; totalRows: string }>(
      `SELECT
         EXTRACT(EPOCH FROM (NOW() - MAX(seen_at))) / 60 AS "ageMinutes",
         COUNT(*)::text AS "totalRows"
       FROM store_mirror
       WHERE store = 'cscart'`
    );
    const ageRaw = freshnessResult.rows[0]?.ageMinutes;
    const ageMinutes = ageRaw === null ? null : Number(ageRaw);
    const mirrorRowsCount = Number(freshnessResult.rows[0]?.totalRows || '0');

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
        changedRows.push(row);
        continue;
      }

      const current = stateByCode.get(code);
      if (!current) {
        missingInMirror += 1;
        changedRows.push(row);
        continue;
      }

      const desiredVisibility = row.visibility === true;
      const desiredPrice = Number(row.price || 0) || 0;
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
      const parentSame = !parentComparable || current.parentProductId === desiredParentProductId;

      if (visibilitySame && priceSame && parentComparable && parentSame) {
        skippedUnchanged += 1;
        continue;
      }

      changedRows.push(row);
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

  private async upsertBatch(rows: StoreMirrorRow[]): Promise<void> {
    if (!rows.length) {
      return;
    }

    const values: Array<string | number | boolean | null> = [];
    const placeholders = rows.map((row, index) => {
      const base = index * 8;
      values.push(
        row.store,
        row.article,
        row.supplier,
        row.parentArticle,
        row.visibility,
        row.price,
        JSON.stringify(row.raw),
        row.seenAt
      );
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8})`;
    });

    await this.pool.query(
      `INSERT INTO store_mirror
         (store, article, supplier, parent_article, visibility, price, raw, seen_at)
       VALUES ${placeholders.join(', ')}
       ON CONFLICT (store, article) DO UPDATE
         SET supplier = EXCLUDED.supplier,
             parent_article = EXCLUDED.parent_article,
             visibility = EXCLUDED.visibility,
             price = EXCLUDED.price,
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
