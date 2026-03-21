import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';
import { FinalizerDb } from '../core/pipeline/finalizerDb';
import { ExportPreviewDb } from '../core/pipeline/exportPreviewDb';
import { CatalogAdminService } from '../core/admin/CatalogAdminService';

interface AuditScenario {
  targetRows: number;
  supplierCount: number;
  articlePool: number;
  mirrorSeedLimit: number;
}

interface AuditScenarioResult {
  targetRows: number;
  rawRowsInserted: number;
  importJobId: number;
  finalizeJobId: number;
  finalizeDurationMs: number;
  finalizeSummary: {
    rawCount: number;
    finalCount: number;
    durationMs: number;
  };
  previewDurationMs: number;
  previewTotal: number;
  compareDurationMs: number;
  compareTotal: number;
  compareMissingDurationMs: number;
  compareMissingTotal: number;
  mirrorSeeded: number;
}

interface AuditReport {
  createdAt: string;
  database: string;
  options: {
    counts: number[];
    supplierCount: number;
    mirrorSeedLimit: number;
    cleanup: boolean;
    allowNonEmptyDb: boolean;
    allowDestructive: boolean;
    priceAtImport: boolean;
    finalizeDeleteEnabled: boolean;
  };
  scenarios: AuditScenarioResult[];
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

function parseCounts(raw: string | undefined): number[] {
  const source = typeof raw === 'string' && raw.trim() ? raw : '100000,300000,500000';
  const parsed = source
    .split(',')
    .map((item) => Number(item.trim()))
    .filter((value) => Number.isFinite(value) && value > 0)
    .map((value) => Math.trunc(value));

  if (!parsed.length) {
    throw new Error('LOAD_AUDIT_COUNTS has no valid positive integers');
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
      'Database is not empty. Set LOAD_AUDIT_ALLOW_NONEMPTY_DB=true only for controlled staging runs.'
    );
  }

  if (!allowDestructive) {
    throw new Error(
      'Database is non-empty and load-audit can overwrite products_final. Set LOAD_AUDIT_ALLOW_DESTRUCTIVE=true only in isolated staging DB.'
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
): Promise<{ activeSupplierCount: number; insertedIds: number[] }> {
  const insertedIds: number[] = [];
  const existing = await pool.query<{ id: number }>(
    `SELECT id::bigint::int AS id
     FROM suppliers
     WHERE name LIKE 'load_audit_supplier_%'
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
      [`load_audit_supplier_${String(index).padStart(3, '0')}`, (index % 10) + 5, index]
    );
    insertedIds.push(inserted.rows[0].id);
    existingCount += 1;
  }

  const activated = await pool.query(
    `UPDATE suppliers
     SET is_active = TRUE
     WHERE name LIKE 'load_audit_supplier_%'`
  );
  return {
    activeSupplierCount: Math.max(existingCount, activated.rowCount || 0),
    insertedIds
  };
}

async function createSuccessfulImportJob(pool: Pool, targetRows: number): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO jobs (type, status, meta, created_at, started_at, finished_at)
     VALUES ('import_all', 'success', $1::jsonb, NOW(), NOW(), NOW())
     RETURNING id::bigint::int AS id`,
    [JSON.stringify({ syntheticLoadAudit: true, targetRows })]
  );
  return result.rows[0].id;
}

async function createFinalizeJob(pool: Pool, targetRows: number): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO jobs (type, status, meta, created_at, started_at)
     VALUES ('finalize', 'running', $1::jsonb, NOW(), NOW())
     RETURNING id::bigint::int AS id`,
    [JSON.stringify({ syntheticLoadAudit: true, targetRows })]
  );
  return result.rows[0].id;
}

async function markJobFinished(pool: Pool, jobId: number, metaPatch: Record<string, unknown>): Promise<void> {
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
  }
): Promise<number> {
  const { jobId, targetRows, supplierCount, articlePool, priceAtImport } = params;
  const result = await pool.query(
    `WITH suppliers_src AS (
       SELECT id, row_number() OVER (ORDER BY id ASC) - 1 AS idx
       FROM suppliers
       WHERE name LIKE 'load_audit_supplier_%'
       ORDER BY id ASC
       LIMIT $3
     ),
     seq AS (
       SELECT generate_series(1, $2)::bigint AS n
     )
     INSERT INTO products_raw
       (job_id, supplier_id, source_id, article, size, quantity, price, price_with_markup, extra, row_data, created_at)
     SELECT
       $1,
       s.id,
       NULL,
       'SKU-' || LPAD((((seq.n - 1) % $4)::text), 10, '0'),
       CASE WHEN (seq.n % 6) = 0 THEN NULL ELSE ((seq.n % 5) + 1)::text END,
       ((seq.n % 40) + 1)::int,
       ROUND((20 + ((seq.n % 5000)::numeric / 10)), 2),
       CASE
         WHEN $5::boolean
           THEN ROUND((20 + ((seq.n % 5000)::numeric / 10)) * (1 + ((s.idx % 12)::numeric / 100)), 2)
         ELSE NULL
       END,
       'load_audit',
       jsonb_build_array(seq.n, s.id),
       NOW()
     FROM seq
     JOIN suppliers_src s
       ON s.idx = ((seq.n - 1) % $3)`,
    [jobId, targetRows, supplierCount, articlePool, priceAtImport]
  );
  return result.rowCount || targetRows;
}

async function seedStoreMirror(
  pool: Pool,
  finalizeJobId: number,
  mirrorSeedLimit: number
): Promise<number> {
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
       jsonb_build_object('synthetic', TRUE, 'source', 'load_audit', 'finalizeJobId', $1::bigint),
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
    [finalizeJobId, mirrorSeedLimit]
  );
  return result.rowCount || 0;
}

async function cleanupSyntheticData(
  pool: Pool,
  importJobIds: number[],
  finalizeJobIds: number[],
  createdSupplierIds: number[]
): Promise<void> {
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

async function runScenario(
  pool: Pool,
  services: {
    finalizer: FinalizerDb;
    previewProvider: ExportPreviewDb;
    adminService: CatalogAdminService;
  },
  scenario: AuditScenario,
  options: { priceAtImport: boolean }
): Promise<AuditScenarioResult> {
  const runStage = async <T>(name: string, action: () => Promise<T>): Promise<T> => {
    try {
      return await action();
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      err.message = `[${name}] ${err.message}`;
      throw err;
    }
  };

  const importJobId = await createSuccessfulImportJob(pool, scenario.targetRows);
  const rawRowsInserted = await runStage('seed_raw_rows', async () =>
    seedRawRows(pool, {
      jobId: importJobId,
      targetRows: scenario.targetRows,
      supplierCount: scenario.supplierCount,
      articlePool: scenario.articlePool,
      priceAtImport: options.priceAtImport
    })
  );

  const finalizeJobId = await createFinalizeJob(pool, scenario.targetRows);
  try {
    const finalizeStartedAt = process.hrtime.bigint();
    const finalizeSummary = await runStage('finalize', async () =>
      services.finalizer.buildFinalDataset(finalizeJobId)
    );
    const finalizeDurationMs = toMs(finalizeStartedAt);
    await runStage('mark_finalize_job_finished', async () =>
      markJobFinished(pool, finalizeJobId, {
        syntheticLoadAudit: true,
        finalizeSummary
      })
    );

    const previewStartedAt = process.hrtime.bigint();
    const preview = await runStage('preview', async () =>
      services.previewProvider.buildNeutralPreview(0, { supplier: null })
    );
    const previewDurationMs = toMs(previewStartedAt);

    const mirrorSeeded = await runStage('seed_store_mirror', async () =>
      seedStoreMirror(pool, finalizeJobId, scenario.mirrorSeedLimit)
    );

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
    const compareMissing = await runStage('compare_preview_missing_only', async () =>
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

    return {
      targetRows: scenario.targetRows,
      rawRowsInserted,
      importJobId,
      finalizeJobId,
      finalizeDurationMs,
      finalizeSummary,
      previewDurationMs,
      previewTotal: preview.total,
      compareDurationMs,
      compareTotal: compare.total,
      compareMissingDurationMs,
      compareMissingTotal: compareMissing.total,
      mirrorSeeded
    };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    await markJobFailed(pool, finalizeJobId, err);
    throw err;
  }
}

async function main(): Promise<void> {
  if (process.env.LOAD_AUDIT_CONFIRM !== 'YES') {
    throw new Error('Set LOAD_AUDIT_CONFIRM=YES to run load audit script.');
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set');
  }

  const counts = parseCounts(process.env.LOAD_AUDIT_COUNTS);
  const supplierCount = readPositiveInt('LOAD_AUDIT_SUPPLIERS', 24);
  const mirrorSeedLimit = readPositiveInt('LOAD_AUDIT_MIRROR_SEED_LIMIT', 20000);
  const cleanup = readBoolean('LOAD_AUDIT_CLEANUP', true);
  const allowNonEmptyDb = readBoolean('LOAD_AUDIT_ALLOW_NONEMPTY_DB', false);
  const allowDestructive = readBoolean('LOAD_AUDIT_ALLOW_DESTRUCTIVE', false);
  const priceAtImport = readBoolean('PRICE_AT_IMPORT', false);
  const finalizeDeleteEnabled = readBoolean('FINALIZE_DELETE_ENABLED', true);
  const outputPath =
    process.env.LOAD_AUDIT_OUTPUT ||
    path.resolve(process.cwd(), 'output', `load-audit-${Date.now()}.json`);

  const pool = new Pool({ connectionString: databaseUrl });
  const finalizer = new FinalizerDb(pool, {
    finalizeDeleteEnabled,
    priceAtImportEnabled: priceAtImport
  });
  const previewProvider = new ExportPreviewDb(pool);
  const adminService = new CatalogAdminService(pool);

  const importJobIds: number[] = [];
  const finalizeJobIds: number[] = [];
  let createdSupplierIds: number[] = [];

  try {
    await assertSafeExecution(pool, allowNonEmptyDb, allowDestructive);
    const ensured = await ensureSyntheticSuppliers(pool, supplierCount);
    createdSupplierIds = ensured.insertedIds;

    const scenarios: AuditScenarioResult[] = [];
    for (let index = 0; index < counts.length; index += 1) {
      const targetRows = counts[index];
      const articlePool = Math.max(10000, Math.trunc(targetRows * 0.4));
      // eslint-disable-next-line no-await-in-loop
      const result = await runScenario(
        pool,
        {
          finalizer,
          previewProvider,
          adminService
        },
        {
          targetRows,
          supplierCount,
          articlePool,
          mirrorSeedLimit
        },
        { priceAtImport }
      );
      importJobIds.push(result.importJobId);
      finalizeJobIds.push(result.finalizeJobId);
      scenarios.push(result);
    }

    const report: AuditReport = {
      createdAt: new Date().toISOString(),
      database: parseDbHost(databaseUrl),
      options: {
        counts,
        supplierCount,
        mirrorSeedLimit,
        cleanup,
        allowNonEmptyDb,
        allowDestructive,
        priceAtImport,
        finalizeDeleteEnabled
      },
      scenarios
    };

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(report, null, 2), 'utf8');

    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ ok: true, output: outputPath, scenarios: report.scenarios }, null, 2));
  } finally {
    if (cleanup) {
      try {
        await cleanupSyntheticData(pool, importJobIds, finalizeJobIds, createdSupplierIds);
      } catch (_error) {
        // ignore cleanup errors, report already generated
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
