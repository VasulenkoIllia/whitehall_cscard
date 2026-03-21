import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';
import { FinalizerDb } from '../core/pipeline/finalizerDb';
import { ExportPreviewDb } from '../core/pipeline/exportPreviewDb';
import { CatalogAdminService } from '../core/admin/CatalogAdminService';
import { StoreMirrorService } from '../core/jobs/StoreMirrorService';
import type { ExportPreviewSummary } from '../core/pipeline/contracts';
import { CsCartConnector, type CsCartImportRow } from '../connectors/cscart/CsCartConnector';

interface StressScenario {
  targetRows: number;
  iterations: number;
  supplierCount: number;
  articlePool: number;
}

interface StressOptions {
  counts: number[];
  iterations: number;
  supplierCount: number;
  articlePoolFactor: number;
  mutationPercent: number;
  priceShiftPercent: number;
  quantityZeroPercent: number;
  mirrorSeedLimit: number;
  mirrorExtraRows: number;
  mirrorArticleMode: 'plain' | 'derived';
  mirrorFeatureEnabled: boolean;
  mirrorFeatureId: string;
  mirrorFeatureValue: string;
  cleanup: boolean;
  allowNonEmptyDb: boolean;
  allowDestructive: boolean;
  priceAtImport: boolean;
  finalizeDeleteEnabled: boolean;
  dryStoreBatch: boolean;
  dryStoreMaxMirrorAgeMinutes: number;
  disableMissingOnFullImport: boolean;
  featureScopeEnabled: boolean;
  featureScopeId: string;
  featureScopeValue: string;
  outputPath: string;
}

interface DryBatchSummary {
  totalBeforeFeatureScope: number;
  totalAfterFeatureScope: number;
  totalBeforeDeactivateMissing: number;
  totalAfterDeactivateMissing: number;
  totalBeforeDelta: number;
  totalAfterDelta: number;
  featureScope: unknown;
  deactivateMissing: unknown;
  delta: unknown;
}

interface StressIterationResult {
  iteration: number;
  importJobId: number;
  finalizeJobId: number;
  rawRowsInserted: number;
  durationsMs: {
    seedRaw: number;
    finalize: number;
    preview: number;
    seedMirror: number;
    compare: number;
    compareMissing: number;
    dryStoreBatch: number | null;
  };
  counters: {
    previewTotal: number;
    finalCount: number;
    compareTotal: number;
    compareMissingTotal: number;
    mirrorSeeded: number;
    mirrorExtraSeeded: number;
  };
  dryStoreBatch: DryBatchSummary | null;
  dbSnapshot: {
    productsRawRows: number;
    productsFinalRows: number;
    storeMirrorRows: number;
    logsRows: number;
    jobsRows: number;
    tableBytes: {
      productsRaw: number;
      productsFinal: number;
      storeMirror: number;
      logs: number;
      jobs: number;
    };
  };
  assertions: Array<{ name: string; ok: boolean; details: string }>;
}

interface StressScenarioResult {
  targetRows: number;
  articlePool: number;
  iterations: StressIterationResult[];
}

interface StressReport {
  createdAt: string;
  database: string;
  options: StressOptions;
  scenarios: StressScenarioResult[];
}

function readBoolean(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (typeof value !== 'string') {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function readPositiveInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.trunc(value);
}

function readPercent(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw) || raw < 0) {
    return fallback;
  }
  return Math.min(100, Number(raw.toFixed(2)));
}

function readRatio(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw) || raw <= 0) {
    return fallback;
  }
  return Number(raw.toFixed(4));
}

function parseCounts(raw: string | undefined): number[] {
  const source = typeof raw === 'string' && raw.trim() ? raw : '100000,300000,500000';
  const parsed = source
    .split(',')
    .map((item) => Number(item.trim()))
    .filter((value) => Number.isFinite(value) && value > 0)
    .map((value) => Math.trunc(value));
  if (!parsed.length) {
    throw new Error('STRESS_AUDIT_COUNTS has no valid positive integers');
  }
  return parsed;
}

function toMs(startedAt: bigint): number {
  return Number((process.hrtime.bigint() - startedAt) / BigInt(1_000_000));
}

function parseDbHost(databaseUrl: string): string {
  try {
    const url = new URL(databaseUrl);
    return `${url.hostname}${url.pathname}`;
  } catch (_error) {
    return databaseUrl;
  }
}

function assertConfirmFlag(): void {
  if (process.env.STRESS_AUDIT_CONFIRM !== 'YES') {
    throw new Error('Set STRESS_AUDIT_CONFIRM=YES to run stress audit script.');
  }
}

async function assertSafeExecution(
  pool: Pool,
  allowNonEmptyDb: boolean,
  allowDestructive: boolean
): Promise<void> {
  const result = await pool.query<{
    suppliers: string;
    raw_rows: string;
    final_rows: string;
  }>(
    `SELECT
       (SELECT COUNT(*)::text FROM suppliers) AS suppliers,
       (SELECT COUNT(*)::text FROM products_raw) AS raw_rows,
       (SELECT COUNT(*)::text FROM products_final) AS final_rows`
  );
  const suppliers = Number(result.rows[0]?.suppliers || '0');
  const rawRows = Number(result.rows[0]?.raw_rows || '0');
  const finalRows = Number(result.rows[0]?.final_rows || '0');
  const isEmpty = suppliers <= 0 && rawRows <= 0 && finalRows <= 0;
  if (isEmpty) {
    return;
  }
  if (!allowNonEmptyDb) {
    throw new Error(
      'Database is not empty. Set STRESS_AUDIT_ALLOW_NONEMPTY_DB=true only for controlled staging runs.'
    );
  }
  if (!allowDestructive) {
    throw new Error(
      'Database is non-empty and stress-audit can overwrite products_final. Set STRESS_AUDIT_ALLOW_DESTRUCTIVE=true only on isolated staging DB.'
    );
  }
}

async function ensureStoreMirrorTable(pool: Pool): Promise<void> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS store_mirror (
       store TEXT NOT NULL,
       article TEXT NOT NULL,
       supplier TEXT,
       parent_article TEXT,
       visibility BOOLEAN NOT NULL,
       price NUMERIC(12, 2),
       raw JSONB,
       synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       seen_at TIMESTAMPTZ,
       PRIMARY KEY (store, article)
     )`
  );
}

async function ensureSyntheticSuppliers(
  pool: Pool,
  supplierCount: number
): Promise<{ insertedIds: number[] }> {
  const insertedIds: number[] = [];
  const existing = await pool.query<{ id: number }>(
    `SELECT id::bigint::int AS id
     FROM suppliers
     WHERE name LIKE 'stress_audit_supplier_%'
     ORDER BY id ASC`
  );
  let existingCount = existing.rows.length;

  while (existingCount < supplierCount) {
    const index = existingCount + 1;
    // eslint-disable-next-line no-await-in-loop
    const inserted = await pool.query<{ id: number }>(
      `INSERT INTO suppliers
         (name, markup_percent, min_profit_enabled, min_profit_amount, priority, is_active)
       VALUES ($1, $2, TRUE, 0, $3, TRUE)
       RETURNING id::bigint::int AS id`,
      [`stress_audit_supplier_${String(index).padStart(3, '0')}`, (index % 15) + 3, index]
    );
    insertedIds.push(inserted.rows[0].id);
    existingCount += 1;
  }

  await pool.query(
    `UPDATE suppliers
     SET is_active = TRUE
     WHERE name LIKE 'stress_audit_supplier_%'`
  );

  return { insertedIds };
}

async function createSuccessfulImportJob(
  pool: Pool,
  payload: { targetRows: number; iteration: number }
): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO jobs (type, status, meta, created_at, started_at, finished_at)
     VALUES ('import_all', 'success', $1::jsonb, NOW(), NOW(), NOW())
     RETURNING id::bigint::int AS id`,
    [JSON.stringify({ syntheticStressAudit: true, ...payload })]
  );
  return result.rows[0].id;
}

async function createFinalizeJob(
  pool: Pool,
  payload: { targetRows: number; iteration: number }
): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO jobs (type, status, meta, created_at, started_at)
     VALUES ('finalize', 'running', $1::jsonb, NOW(), NOW())
     RETURNING id::bigint::int AS id`,
    [JSON.stringify({ syntheticStressAudit: true, ...payload })]
  );
  return result.rows[0].id;
}

async function markJobFinished(
  pool: Pool,
  jobId: number,
  metaPatch: Record<string, unknown>
): Promise<void> {
  await pool.query(
    `UPDATE jobs
     SET status = 'success',
         finished_at = NOW(),
         meta = COALESCE(meta, '{}'::jsonb) || $2::jsonb
     WHERE id = $1`,
    [jobId, JSON.stringify(metaPatch)]
  );
}

async function markJobFailed(pool: Pool, jobId: number, error: Error): Promise<void> {
  await pool.query(
    `UPDATE jobs
     SET status = 'failed',
         finished_at = NOW(),
         meta = COALESCE(meta, '{}'::jsonb) || $2::jsonb
     WHERE id = $1`,
    [jobId, JSON.stringify({ error: error.message })]
  );
}

async function seedRawRows(
  pool: Pool,
  params: {
    jobId: number;
    targetRows: number;
    supplierCount: number;
    articlePool: number;
    priceAtImport: boolean;
    iteration: number;
    mutationPercent: number;
    priceShiftPercent: number;
    quantityZeroPercent: number;
  }
): Promise<number> {
  const {
    jobId,
    targetRows,
    supplierCount,
    articlePool,
    priceAtImport,
    iteration,
    mutationPercent,
    priceShiftPercent,
    quantityZeroPercent
  } = params;

  const result = await pool.query(
    `WITH suppliers_src AS (
       SELECT id, row_number() OVER (ORDER BY id ASC) - 1 AS idx
       FROM suppliers
       WHERE name LIKE 'stress_audit_supplier_%'
       ORDER BY id ASC
       LIMIT $3
     ),
     seq AS (
       SELECT generate_series(1, $2)::bigint AS n
     ),
     base AS (
       SELECT
         seq.n,
         s.id AS supplier_id,
         s.idx AS supplier_idx,
         ('SKU-' || LPAD((((seq.n - 1) % $4)::text), 10, '0')) AS article_base,
         CASE WHEN (seq.n % 6) = 0 THEN NULL ELSE ((seq.n % 5) + 1)::text END AS size_text,
         ROUND((20 + ((seq.n % 5000)::numeric / 10)), 2) AS price_base,
         (((seq.n + ($6::bigint * 37)) % 100) < $7::int) AS is_mutated
       FROM seq
       JOIN suppliers_src s
         ON s.idx = ((seq.n - 1) % $3)
     )
     INSERT INTO products_raw
       (job_id, supplier_id, source_id, article, size, quantity, price, price_with_markup, extra, row_data, created_at)
     SELECT
       $1,
       b.supplier_id,
       NULL,
       CASE
         WHEN b.size_text IS NULL OR b.size_text = '' THEN b.article_base
         ELSE b.article_base || '-' || b.size_text
       END AS article,
       b.size_text,
       CASE
         WHEN b.is_mutated AND (((b.n + ($6::bigint * 19)) % 100) < $9::int) THEN 0
         ELSE ((b.n % 40) + 1)::int
       END AS quantity,
       CASE
         WHEN b.is_mutated THEN
           ROUND(
             b.price_base * (
               1 + (
                 CASE
                   WHEN ($6 % 2) = 0 THEN $8::numeric
                   ELSE -$8::numeric
                 END / 100.0
               )
             ),
             2
           )
         ELSE b.price_base
       END AS price,
       CASE
         WHEN $5::boolean THEN
           ROUND(
             (
               CASE
                 WHEN b.is_mutated THEN
                   b.price_base * (
                     1 + (
                       CASE
                         WHEN ($6 % 2) = 0 THEN $8::numeric
                         ELSE -$8::numeric
                       END / 100.0
                     )
                   )
                 ELSE b.price_base
               END
             ) * (1 + ((b.supplier_idx % 12)::numeric / 100)),
             2
           )
         ELSE NULL
       END AS price_with_markup,
       'stress_audit',
       jsonb_build_object(
         'n', b.n,
         'iteration', $6,
         'is_mutated', b.is_mutated
       ),
       NOW()
     FROM base b`,
    [
      jobId,
      targetRows,
      supplierCount,
      articlePool,
      priceAtImport,
      iteration,
      Math.trunc(mutationPercent),
      Number(priceShiftPercent.toFixed(2)),
      Math.trunc(quantityZeroPercent)
    ]
  );
  return result.rowCount || targetRows;
}

async function seedStoreMirror(
  pool: Pool,
  params: {
    finalizeJobId: number;
    mirrorSeedLimit: number;
    mirrorArticleMode: 'plain' | 'derived';
    mirrorFeatureEnabled: boolean;
    mirrorFeatureId: string;
    mirrorFeatureValue: string;
  }
): Promise<number> {
  const {
    finalizeJobId,
    mirrorSeedLimit,
    mirrorArticleMode,
    mirrorFeatureEnabled,
    mirrorFeatureId,
    mirrorFeatureValue
  } = params;

  if (mirrorSeedLimit <= 0) {
    return 0;
  }

  await ensureStoreMirrorTable(pool);
  const result = await pool.query(
    `INSERT INTO store_mirror
       (store, article, supplier, parent_article, visibility, price, raw, synced_at, seen_at)
     SELECT
       'cscart',
       CASE
         WHEN $3::text = 'plain' THEN pf.article
         WHEN pf.size IS NULL OR btrim(pf.size) = '' THEN pf.article
         WHEN right(lower(pf.article), length(replace(btrim(pf.size), ',', '.'))) =
              lower(replace(btrim(pf.size), ',', '.'))
           THEN pf.article
         ELSE pf.article || '-' || replace(btrim(pf.size), ',', '.')
       END AS article,
       sp.name AS supplier,
       NULL,
       TRUE,
       COALESCE(po.price_final, pf.price_final),
       CASE
         WHEN $4::boolean THEN
           jsonb_build_object(
             'synthetic', TRUE,
             'source', 'stress_audit',
             'finalizeJobId', $1::bigint,
             'product_features', jsonb_build_object(
               $5::text, jsonb_build_object('value', $6::text)
             )
           )
         ELSE
           jsonb_build_object(
             'synthetic', TRUE,
             'source', 'stress_audit',
             'finalizeJobId', $1::bigint
           )
       END,
       NOW(),
       NOW()
     FROM products_final pf
     LEFT JOIN suppliers sp ON sp.id = pf.supplier_id
     LEFT JOIN price_overrides po
       ON po.article = pf.article
      AND NULLIF(po.size, '') IS NOT DISTINCT FROM NULLIF(pf.size, '')
      AND po.is_active = TRUE
     WHERE pf.job_id = $1::bigint
     ORDER BY pf.id ASC
     LIMIT $2::int
     ON CONFLICT (store, article)
       DO UPDATE SET
         supplier = EXCLUDED.supplier,
         parent_article = EXCLUDED.parent_article,
         visibility = EXCLUDED.visibility,
         price = EXCLUDED.price,
         raw = EXCLUDED.raw,
         synced_at = NOW(),
         seen_at = EXCLUDED.seen_at`,
    [
      finalizeJobId,
      mirrorSeedLimit,
      mirrorArticleMode,
      mirrorFeatureEnabled,
      mirrorFeatureId,
      mirrorFeatureValue
    ]
  );
  return result.rowCount || 0;
}

async function seedStoreMirrorExtraRows(
  pool: Pool,
  params: {
    mirrorExtraRows: number;
    mirrorFeatureEnabled: boolean;
    mirrorFeatureId: string;
    mirrorFeatureValue: string;
    iteration: number;
  }
): Promise<number> {
  const { mirrorExtraRows, mirrorFeatureEnabled, mirrorFeatureId, mirrorFeatureValue, iteration } = params;
  if (mirrorExtraRows <= 0) {
    return 0;
  }
  await ensureStoreMirrorTable(pool);
  const result = await pool.query(
    `INSERT INTO store_mirror
       (store, article, supplier, parent_article, visibility, price, raw, synced_at, seen_at)
     SELECT
       'cscart',
       'STORE-ONLY-' || LPAD((($1::bigint * 1000000) + seq.n)::text, 12, '0') AS article,
       'stress_audit_extra',
       NULL,
       TRUE,
       ROUND((100 + ((seq.n % 10000)::numeric / 10)), 2),
       CASE
         WHEN $2::boolean THEN
           jsonb_build_object(
             'synthetic', TRUE,
             'source', 'stress_audit_extra',
             'iteration', $1::int,
             'product_features', jsonb_build_object(
               $3::text, jsonb_build_object('value', $4::text)
             )
           )
         ELSE
           jsonb_build_object(
             'synthetic', TRUE,
             'source', 'stress_audit_extra',
             'iteration', $1::int
           )
       END,
       NOW(),
       NOW()
     FROM generate_series(1, $5::int) AS seq(n)
     ON CONFLICT (store, article)
       DO UPDATE SET
         visibility = EXCLUDED.visibility,
         price = EXCLUDED.price,
         raw = EXCLUDED.raw,
         synced_at = NOW(),
         seen_at = EXCLUDED.seen_at`,
    [iteration, mirrorFeatureEnabled, mirrorFeatureId, mirrorFeatureValue, mirrorExtraRows]
  );
  return result.rowCount || 0;
}

async function collectDbSnapshot(pool: Pool): Promise<StressIterationResult['dbSnapshot']> {
  const [countResult, sizeResult] = await Promise.all([
    pool.query<{
      raw_rows: string;
      final_rows: string;
      mirror_rows: string;
      logs_rows: string;
      jobs_rows: string;
    }>(
      `SELECT
         (SELECT COUNT(*)::text FROM products_raw) AS raw_rows,
         (SELECT COUNT(*)::text FROM products_final) AS final_rows,
         (SELECT COUNT(*)::text FROM store_mirror WHERE store='cscart') AS mirror_rows,
         (SELECT COUNT(*)::text FROM logs) AS logs_rows,
         (SELECT COUNT(*)::text FROM jobs) AS jobs_rows`
    ),
    pool.query<{
      products_raw_bytes: string;
      products_final_bytes: string;
      store_mirror_bytes: string;
      logs_bytes: string;
      jobs_bytes: string;
    }>(
      `WITH RECURSIVE raw_tree AS (
         SELECT 'products_raw'::regclass AS oid
         UNION ALL
         SELECT i.inhrelid
         FROM pg_inherits i
         JOIN raw_tree r
           ON i.inhparent = r.oid
       )
       SELECT
         (
           SELECT COALESCE(SUM(pg_total_relation_size(oid)), 0)::bigint::text
           FROM raw_tree
         ) AS products_raw_bytes,
         COALESCE(pg_total_relation_size('products_final'), 0)::bigint::text AS products_final_bytes,
         COALESCE(pg_total_relation_size('store_mirror'), 0)::bigint::text AS store_mirror_bytes,
         COALESCE(pg_total_relation_size('logs'), 0)::bigint::text AS logs_bytes,
         COALESCE(pg_total_relation_size('jobs'), 0)::bigint::text AS jobs_bytes`
    )
  ]);

  return {
    productsRawRows: Number(countResult.rows[0]?.raw_rows || 0),
    productsFinalRows: Number(countResult.rows[0]?.final_rows || 0),
    storeMirrorRows: Number(countResult.rows[0]?.mirror_rows || 0),
    logsRows: Number(countResult.rows[0]?.logs_rows || 0),
    jobsRows: Number(countResult.rows[0]?.jobs_rows || 0),
    tableBytes: {
      productsRaw: Number(sizeResult.rows[0]?.products_raw_bytes || 0),
      productsFinal: Number(sizeResult.rows[0]?.products_final_bytes || 0),
      storeMirror: Number(sizeResult.rows[0]?.store_mirror_bytes || 0),
      logs: Number(sizeResult.rows[0]?.logs_bytes || 0),
      jobs: Number(sizeResult.rows[0]?.jobs_bytes || 0)
    }
  };
}

async function buildDryStoreBatchSummary(
  pool: Pool,
  preview: ExportPreviewSummary,
  options: {
    maxMirrorAgeMinutes: number;
    disableMissingOnFullImport: boolean;
    featureScopeEnabled: boolean;
    featureScopeId: string;
    featureScopeValue: string;
  }
): Promise<DryBatchSummary> {
  const connector = new CsCartConnector({
    fetchProductsPage: async () => {
      throw new Error('dry-run only');
    },
    importProducts: async () => {
      throw new Error('dry-run only');
    }
  });
  const batch = await connector.createImportBatch(preview.rows);
  const storeMirrorService = new StoreMirrorService(pool);

  let scopedRows = batch.rows as CsCartImportRow[];
  let managedCodes: Set<string> | null = null;
  let featureScope: unknown;
  if (options.featureScopeEnabled) {
    const scoped = await storeMirrorService.filterCsCartRowsByFeature(
      scopedRows,
      options.maxMirrorAgeMinutes,
      options.featureScopeId,
      options.featureScopeValue
    );
    scopedRows = scoped.rows as CsCartImportRow[];
    managedCodes = scoped.managedCodes;
    featureScope = scoped.summary;
  } else {
    featureScope = {
      enabled: false,
      reason: 'disabled_by_env',
      inputTotal: batch.rows.length,
      matchedInput: batch.rows.length,
      droppedInput: 0
    };
  }

  let rowsForDelta = scopedRows;
  let deactivateMissing: unknown;
  if (options.disableMissingOnFullImport) {
    const missing = await storeMirrorService.appendCsCartMissingAsHidden(
      scopedRows,
      options.maxMirrorAgeMinutes,
      { managedCodes }
    );
    rowsForDelta = missing.rows as CsCartImportRow[];
    deactivateMissing = missing.summary;
  } else {
    deactivateMissing = {
      enabled: false,
      reason: 'disabled_by_env',
      inputTotal: scopedRows.length,
      appended: 0
    };
  }

  const delta = await storeMirrorService.filterCsCartDelta(rowsForDelta, options.maxMirrorAgeMinutes);

  return {
    totalBeforeFeatureScope: batch.rows.length,
    totalAfterFeatureScope: scopedRows.length,
    totalBeforeDeactivateMissing: scopedRows.length,
    totalAfterDeactivateMissing: rowsForDelta.length,
    totalBeforeDelta: rowsForDelta.length,
    totalAfterDelta: delta.rows.length,
    featureScope,
    deactivateMissing,
    delta: delta.summary
  };
}

async function cleanupSyntheticData(
  pool: Pool,
  importJobIds: number[],
  finalizeJobIds: number[],
  createdSupplierIds: number[]
): Promise<void> {
  await pool.query(
    `DELETE FROM store_mirror
     WHERE (raw->>'source') IN ('stress_audit', 'stress_audit_extra')`
  );

  if (finalizeJobIds.length > 0) {
    await pool.query(
      `DELETE FROM products_final
       WHERE job_id = ANY($1::bigint[])`,
      [finalizeJobIds]
    );
  }
  if (importJobIds.length > 0) {
    await pool.query(
      `DELETE FROM products_raw
       WHERE job_id = ANY($1::bigint[])`,
      [importJobIds]
    );
  }
  const allJobIds = [...importJobIds, ...finalizeJobIds];
  if (allJobIds.length > 0) {
    await pool.query(
      `DELETE FROM logs
       WHERE job_id = ANY($1::bigint[])`,
      [allJobIds]
    );
    await pool.query(
      `DELETE FROM jobs
       WHERE id = ANY($1::bigint[])`,
      [allJobIds]
    );
  }
  if (createdSupplierIds.length > 0) {
    await pool.query(
      `DELETE FROM suppliers
       WHERE id = ANY($1::bigint[])`,
      [createdSupplierIds]
    );
  }
}

function buildAssertions(params: {
  targetRows: number;
  rawRowsInserted: number;
  finalizeRawCount: number;
  previewTotal: number;
  finalCount: number;
  compareTotal: number;
  dryStoreBatch: DryBatchSummary | null;
}): Array<{ name: string; ok: boolean; details: string }> {
  const checks: Array<{ name: string; ok: boolean; details: string }> = [];
  checks.push({
    name: 'raw_rows_inserted',
    ok: params.rawRowsInserted === params.targetRows,
    details: `${params.rawRowsInserted} vs target ${params.targetRows}`
  });
  checks.push({
    name: 'finalize_raw_count_matches_target',
    ok: params.finalizeRawCount === params.targetRows,
    details: `${params.finalizeRawCount} vs target ${params.targetRows}`
  });
  checks.push({
    name: 'preview_equals_final_count',
    ok: params.previewTotal === params.finalCount,
    details: `${params.previewTotal} vs final ${params.finalCount}`
  });
  checks.push({
    name: 'compare_total_not_less_than_final',
    ok: params.compareTotal >= params.finalCount,
    details: `${params.compareTotal} vs final ${params.finalCount}`
  });
  if (params.dryStoreBatch) {
    checks.push({
      name: 'dry_batch_not_more_than_delta_input',
      ok: params.dryStoreBatch.totalAfterDelta <= params.dryStoreBatch.totalBeforeDelta,
      details: `${params.dryStoreBatch.totalAfterDelta} <= ${params.dryStoreBatch.totalBeforeDelta}`
    });
  }
  return checks;
}

async function runIteration(
  pool: Pool,
  services: {
    finalizer: FinalizerDb;
    previewProvider: ExportPreviewDb;
    adminService: CatalogAdminService;
  },
  scenario: StressScenario,
  options: StressOptions,
  iteration: number
): Promise<StressIterationResult> {
  const runStage = async <T>(name: string, action: () => Promise<T>): Promise<T> => {
    try {
      return await action();
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      err.message = `[${name}] ${err.message}`;
      throw err;
    }
  };

  const importJobId = await createSuccessfulImportJob(pool, {
    targetRows: scenario.targetRows,
    iteration
  });

  const seedStartedAt = process.hrtime.bigint();
  const rawRowsInserted = await runStage('seed_raw_rows', async () =>
    seedRawRows(pool, {
      jobId: importJobId,
      targetRows: scenario.targetRows,
      supplierCount: scenario.supplierCount,
      articlePool: scenario.articlePool,
      priceAtImport: options.priceAtImport,
      iteration,
      mutationPercent: options.mutationPercent,
      priceShiftPercent: options.priceShiftPercent,
      quantityZeroPercent: options.quantityZeroPercent
    })
  );
  const seedRawDurationMs = toMs(seedStartedAt);

  const finalizeJobId = await createFinalizeJob(pool, {
    targetRows: scenario.targetRows,
    iteration
  });

  try {
    const finalizeStartedAt = process.hrtime.bigint();
    const finalizeSummary = await runStage('finalize', async () =>
      services.finalizer.buildFinalDataset(finalizeJobId)
    );
    const finalizeDurationMs = toMs(finalizeStartedAt);

    await runStage('mark_finalize_finished', async () =>
      markJobFinished(pool, finalizeJobId, {
        syntheticStressAudit: true,
        iteration,
        finalizeSummary
      })
    );

    const previewStartedAt = process.hrtime.bigint();
    const preview = await runStage('preview', async () =>
      services.previewProvider.buildNeutralPreview(0, { supplier: null })
    );
    const previewDurationMs = toMs(previewStartedAt);

    const seedMirrorStartedAt = process.hrtime.bigint();
    const mirrorSeeded = await runStage('seed_mirror_from_final', async () =>
      seedStoreMirror(pool, {
        finalizeJobId,
        mirrorSeedLimit: options.mirrorSeedLimit,
        mirrorArticleMode: options.mirrorArticleMode,
        mirrorFeatureEnabled: options.mirrorFeatureEnabled,
        mirrorFeatureId: options.mirrorFeatureId,
        mirrorFeatureValue: options.mirrorFeatureValue
      })
    );
    const mirrorExtraSeeded = await runStage('seed_mirror_extra_rows', async () =>
      seedStoreMirrorExtraRows(pool, {
        mirrorExtraRows: options.mirrorExtraRows,
        mirrorFeatureEnabled: options.mirrorFeatureEnabled,
        mirrorFeatureId: options.mirrorFeatureId,
        mirrorFeatureValue: options.mirrorFeatureValue,
        iteration
      })
    );
    const seedMirrorDurationMs = toMs(seedMirrorStartedAt);

    const compareStartedAt = process.hrtime.bigint();
    const compare = await runStage('compare_preview_all', async () =>
      services.adminService.listComparePreview({
        limit: 100,
        offset: 0,
        search: null,
        supplierId: null,
        missingOnly: false,
        store: 'cscart'
      })
    );
    const compareDurationMs = toMs(compareStartedAt);

    const compareMissingStartedAt = process.hrtime.bigint();
    const compareMissing = await runStage('compare_preview_missing', async () =>
      services.adminService.listComparePreview({
        limit: 100,
        offset: 0,
        search: null,
        supplierId: null,
        missingOnly: true,
        store: 'cscart'
      })
    );
    const compareMissingDurationMs = toMs(compareMissingStartedAt);

    let dryStoreBatch: DryBatchSummary | null = null;
    let dryStoreBatchDurationMs: number | null = null;
    if (options.dryStoreBatch) {
      const dryStartedAt = process.hrtime.bigint();
      dryStoreBatch = await runStage('dry_store_batch', async () =>
        buildDryStoreBatchSummary(pool, preview, {
          maxMirrorAgeMinutes: options.dryStoreMaxMirrorAgeMinutes,
          disableMissingOnFullImport: options.disableMissingOnFullImport,
          featureScopeEnabled: options.featureScopeEnabled,
          featureScopeId: options.featureScopeId,
          featureScopeValue: options.featureScopeValue
        })
      );
      dryStoreBatchDurationMs = toMs(dryStartedAt);
    }

    const dbSnapshot = await runStage('db_snapshot', async () => collectDbSnapshot(pool));

    const assertions = buildAssertions({
      targetRows: scenario.targetRows,
      rawRowsInserted,
      finalizeRawCount: finalizeSummary.rawCount,
      previewTotal: preview.total,
      finalCount: finalizeSummary.finalCount,
      compareTotal: compare.total,
      dryStoreBatch
    });

    return {
      iteration,
      importJobId,
      finalizeJobId,
      rawRowsInserted,
      durationsMs: {
        seedRaw: seedRawDurationMs,
        finalize: finalizeDurationMs,
        preview: previewDurationMs,
        seedMirror: seedMirrorDurationMs,
        compare: compareDurationMs,
        compareMissing: compareMissingDurationMs,
        dryStoreBatch: dryStoreBatchDurationMs
      },
      counters: {
        previewTotal: preview.total,
        finalCount: finalizeSummary.finalCount,
        compareTotal: compare.total,
        compareMissingTotal: compareMissing.total,
        mirrorSeeded,
        mirrorExtraSeeded
      },
      dryStoreBatch,
      dbSnapshot,
      assertions
    };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    await markJobFailed(pool, finalizeJobId, err);
    throw err;
  }
}

async function runScenario(
  pool: Pool,
  services: {
    finalizer: FinalizerDb;
    previewProvider: ExportPreviewDb;
    adminService: CatalogAdminService;
  },
  scenario: StressScenario,
  options: StressOptions
): Promise<{
  result: StressScenarioResult;
  importJobIds: number[];
  finalizeJobIds: number[];
}> {
  const iterations: StressIterationResult[] = [];
  const importJobIds: number[] = [];
  const finalizeJobIds: number[] = [];

  for (let iteration = 1; iteration <= scenario.iterations; iteration += 1) {
    // eslint-disable-next-line no-await-in-loop
    const result = await runIteration(pool, services, scenario, options, iteration);
    iterations.push(result);
    importJobIds.push(result.importJobId);
    finalizeJobIds.push(result.finalizeJobId);
  }

  return {
    result: {
      targetRows: scenario.targetRows,
      articlePool: scenario.articlePool,
      iterations
    },
    importJobIds,
    finalizeJobIds
  };
}

function readOptions(): StressOptions {
  const counts = parseCounts(process.env.STRESS_AUDIT_COUNTS);
  const iterations = readPositiveInt('STRESS_AUDIT_ITERATIONS', 3);
  const supplierCount = readPositiveInt('STRESS_AUDIT_SUPPLIERS', 24);
  const articlePoolFactor = readRatio('STRESS_AUDIT_ARTICLE_POOL_FACTOR', 0.4);
  const mutationPercent = readPercent('STRESS_AUDIT_MUTATION_PERCENT', 30);
  const priceShiftPercent = readPercent('STRESS_AUDIT_PRICE_SHIFT_PERCENT', 12);
  const quantityZeroPercent = readPercent('STRESS_AUDIT_QUANTITY_ZERO_PERCENT', 10);
  const mirrorSeedLimit = readPositiveInt('STRESS_AUDIT_MIRROR_SEED_LIMIT', 300000);
  const mirrorExtraRows = readPositiveInt('STRESS_AUDIT_MIRROR_EXTRA_ROWS', 20000);
  const mirrorArticleModeRaw = String(process.env.STRESS_AUDIT_MIRROR_ARTICLE_MODE || 'plain')
    .trim()
    .toLowerCase();
  const mirrorArticleMode = mirrorArticleModeRaw === 'derived' ? 'derived' : 'plain';
  const mirrorFeatureEnabled = readBoolean('STRESS_AUDIT_MIRROR_FEATURE_ENABLED', true);
  const mirrorFeatureId = String(process.env.STRESS_AUDIT_MIRROR_FEATURE_ID || '564').trim() || '564';
  const mirrorFeatureValue =
    String(process.env.STRESS_AUDIT_MIRROR_FEATURE_VALUE || 'Y').trim() || 'Y';
  const cleanup = readBoolean('STRESS_AUDIT_CLEANUP', true);
  const allowNonEmptyDb = readBoolean('STRESS_AUDIT_ALLOW_NONEMPTY_DB', false);
  const allowDestructive = readBoolean('STRESS_AUDIT_ALLOW_DESTRUCTIVE', false);
  const priceAtImport =
    process.env.STRESS_AUDIT_PRICE_AT_IMPORT === undefined
      ? readBoolean('PRICE_AT_IMPORT', false)
      : readBoolean('STRESS_AUDIT_PRICE_AT_IMPORT', false);
  const finalizeDeleteEnabled =
    process.env.STRESS_AUDIT_FINALIZE_DELETE_ENABLED === undefined
      ? readBoolean('FINALIZE_DELETE_ENABLED', true)
      : readBoolean('STRESS_AUDIT_FINALIZE_DELETE_ENABLED', true);
  const dryStoreBatch = readBoolean('STRESS_AUDIT_DRY_STORE_BATCH', true);
  const dryStoreMaxMirrorAgeMinutes = readPositiveInt('STRESS_AUDIT_MAX_MIRROR_AGE_MINUTES', 120);
  const disableMissingOnFullImport = readBoolean('STRESS_AUDIT_DISABLE_MISSING_ON_FULL_IMPORT', true);
  const featureScopeEnabled = readBoolean('STRESS_AUDIT_FEATURE_SCOPE_ENABLED', true);
  const featureScopeId = String(process.env.STRESS_AUDIT_FEATURE_SCOPE_ID || '564').trim() || '564';
  const featureScopeValue =
    String(process.env.STRESS_AUDIT_FEATURE_SCOPE_VALUE || 'Y').trim() || 'Y';
  const outputPath =
    process.env.STRESS_AUDIT_OUTPUT ||
    path.resolve(process.cwd(), 'output', `stress-audit-${Date.now()}.json`);

  return {
    counts,
    iterations,
    supplierCount,
    articlePoolFactor,
    mutationPercent,
    priceShiftPercent,
    quantityZeroPercent,
    mirrorSeedLimit,
    mirrorExtraRows,
    mirrorArticleMode,
    mirrorFeatureEnabled,
    mirrorFeatureId,
    mirrorFeatureValue,
    cleanup,
    allowNonEmptyDb,
    allowDestructive,
    priceAtImport,
    finalizeDeleteEnabled,
    dryStoreBatch,
    dryStoreMaxMirrorAgeMinutes,
    disableMissingOnFullImport,
    featureScopeEnabled,
    featureScopeId,
    featureScopeValue,
    outputPath
  };
}

async function main(): Promise<void> {
  assertConfirmFlag();
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set');
  }

  const options = readOptions();
  const pool = new Pool({ connectionString: databaseUrl });
  const finalizer = new FinalizerDb(pool, {
    finalizeDeleteEnabled: options.finalizeDeleteEnabled,
    priceAtImportEnabled: options.priceAtImport
  });
  const previewProvider = new ExportPreviewDb(pool);
  const adminService = new CatalogAdminService(pool);

  let createdSupplierIds: number[] = [];
  const importJobIds: number[] = [];
  const finalizeJobIds: number[] = [];

  try {
    await assertSafeExecution(pool, options.allowNonEmptyDb, options.allowDestructive);
    const ensured = await ensureSyntheticSuppliers(pool, options.supplierCount);
    createdSupplierIds = ensured.insertedIds;

    const scenarios: StressScenarioResult[] = [];
    for (let index = 0; index < options.counts.length; index += 1) {
      const targetRows = options.counts[index];
      const articlePool = Math.max(10000, Math.trunc(targetRows * options.articlePoolFactor));
      // eslint-disable-next-line no-await-in-loop
      const scenarioResult = await runScenario(
        pool,
        {
          finalizer,
          previewProvider,
          adminService
        },
        {
          targetRows,
          iterations: options.iterations,
          supplierCount: options.supplierCount,
          articlePool
        },
        options
      );
      scenarios.push(scenarioResult.result);
      importJobIds.push(...scenarioResult.importJobIds);
      finalizeJobIds.push(...scenarioResult.finalizeJobIds);
    }

    const report: StressReport = {
      createdAt: new Date().toISOString(),
      database: parseDbHost(databaseUrl),
      options,
      scenarios
    };

    fs.mkdirSync(path.dirname(options.outputPath), { recursive: true });
    fs.writeFileSync(options.outputPath, JSON.stringify(report, null, 2), 'utf8');

    const compact = scenarios.map((scenario) => ({
      targetRows: scenario.targetRows,
      iterations: scenario.iterations.map((item) => ({
        iteration: item.iteration,
        rawRowsInserted: item.rawRowsInserted,
        previewTotal: item.counters.previewTotal,
        finalCount: item.counters.finalCount,
        dryStoreBatchTotal: item.dryStoreBatch?.totalAfterDelta || null,
        finalizeMs: item.durationsMs.finalize,
        compareMs: item.durationsMs.compare
      }))
    }));

    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ ok: true, output: options.outputPath, scenarios: compact }, null, 2));
  } finally {
    if (options.cleanup) {
      try {
        await cleanupSyntheticData(pool, importJobIds, finalizeJobIds, createdSupplierIds);
      } catch (_error) {
        // ignore cleanup errors
      }
    }
    await pool.end();
  }
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
