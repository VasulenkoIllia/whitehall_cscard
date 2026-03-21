import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { JobService } from '../core/jobs/JobService';
import { PipelineJobRunner } from '../core/jobs/PipelineJobRunner';
import { FinalizerDb } from '../core/pipeline/finalizerDb';
import { ExportPreviewDb } from '../core/pipeline/exportPreviewDb';
import { detectMappingFromRow, hasRequiredFields } from '../core/pipeline/mapping';

function readRequiredEnv(name: string): string {
  const value = String(process.env[name] || '').trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function createSchemaName(): string {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 12).toLowerCase();
  const schema = `it_${suffix}`;
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) {
    throw new Error('Failed to build safe schema name');
  }
  return schema;
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

async function createTables(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE jobs (
      id BIGSERIAL PRIMARY KEY,
      type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      meta JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      started_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ
    );

    CREATE TABLE job_locks (
      name TEXT PRIMARY KEY,
      job_id BIGINT REFERENCES jobs(id) ON DELETE CASCADE
    );

    CREATE TABLE suppliers (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      markup_percent NUMERIC(6,2) DEFAULT 0,
      min_profit_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      min_profit_amount NUMERIC(10,2) DEFAULT 0,
      priority INT DEFAULT 100,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      markup_rule_set_id BIGINT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE markup_rule_sets (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE markup_rule_conditions (
      id BIGSERIAL PRIMARY KEY,
      rule_set_id BIGINT REFERENCES markup_rule_sets(id) ON DELETE CASCADE,
      action_type TEXT NOT NULL,
      action_value NUMERIC(10,2) NOT NULL,
      price_from NUMERIC(12,2) NOT NULL DEFAULT 0,
      price_to NUMERIC(12,2),
      priority INT NOT NULL DEFAULT 100,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE products_raw (
      id BIGSERIAL PRIMARY KEY,
      job_id BIGINT REFERENCES jobs(id) ON DELETE SET NULL,
      supplier_id BIGINT REFERENCES suppliers(id) ON DELETE CASCADE,
      source_id BIGINT,
      article TEXT NOT NULL,
      size TEXT,
      quantity INT,
      price NUMERIC(12,2),
      price_with_markup NUMERIC(12,2),
      extra TEXT,
      row_data JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE products_final (
      id BIGSERIAL PRIMARY KEY,
      job_id BIGINT REFERENCES jobs(id) ON DELETE SET NULL,
      article TEXT NOT NULL,
      size TEXT,
      quantity INT,
      price_base NUMERIC(12,2),
      price_final NUMERIC(12,2),
      extra TEXT,
      supplier_id BIGINT REFERENCES suppliers(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE price_overrides (
      id BIGSERIAL PRIMARY KEY,
      article TEXT NOT NULL,
      size TEXT,
      price_final NUMERIC(12,2) NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function seedCoreData(pool: Pool): Promise<{
  supplierA: number;
  supplierB: number;
  supplierC: number;
  importJobId: number;
  finalizeJobId: number;
}> {
  const supplierA = await pool.query<{ id: number }>(
    `INSERT INTO suppliers (name, priority, markup_percent, min_profit_enabled, min_profit_amount, is_active)
     VALUES ('S_A', 1, 0, FALSE, 0, TRUE)
     RETURNING id::int AS id`
  );
  const supplierB = await pool.query<{ id: number }>(
    `INSERT INTO suppliers (name, priority, markup_percent, min_profit_enabled, min_profit_amount, is_active)
     VALUES ('S_B', 10, 0, FALSE, 0, TRUE)
     RETURNING id::int AS id`
  );
  const supplierC = await pool.query<{ id: number }>(
    `INSERT INTO suppliers (name, priority, markup_percent, min_profit_enabled, min_profit_amount, is_active)
     VALUES ('S_C', 1, 0, FALSE, 0, TRUE)
     RETURNING id::int AS id`
  );

  const importJob = await pool.query<{ id: number }>(
    `INSERT INTO jobs (type, status, meta, started_at, finished_at)
     VALUES ('import_all', 'success', '{}'::jsonb, NOW(), NOW())
     RETURNING id::int AS id`
  );
  const finalizeJob = await pool.query<{ id: number }>(
    `INSERT INTO jobs (type, status, meta, started_at)
     VALUES ('finalize', 'running', '{}'::jsonb, NOW())
     RETURNING id::int AS id`
  );

  return {
    supplierA: supplierA.rows[0].id,
    supplierB: supplierB.rows[0].id,
    supplierC: supplierC.rows[0].id,
    importJobId: importJob.rows[0].id,
    finalizeJobId: finalizeJob.rows[0].id
  };
}

async function testMappingInvariant(): Promise<void> {
  const mapping = detectMappingFromRow(['Артикул', 'Назва', 'Ціна', 'Кількість']);
  assert.equal(mapping.article, 1, 'mapping.article must be detected');
  assert.equal(mapping.extra, 2, 'mapping.extra must be detected');
  assert.equal(mapping.price, 3, 'mapping.price must be detected');
  assert.equal(mapping.quantity, 4, 'mapping.quantity must be detected');
  assert.equal(hasRequiredFields(mapping), true, 'required mapping fields must be present');
  assert.equal(
    hasRequiredFields({ article: 1, price: 3, quantity: { type: 'static', value: '' } }),
    false,
    'empty static quantity is invalid'
  );
}

async function testFinalizeDedupInvariant(
  pool: Pool,
  context: {
    supplierA: number;
    supplierB: number;
    supplierC: number;
    importJobId: number;
    finalizeJobId: number;
  }
): Promise<void> {
  await pool.query(
    `INSERT INTO products_raw
       (job_id, supplier_id, source_id, article, size, quantity, price, price_with_markup, extra)
     VALUES
       ($1, $2, 1, 'A1', NULL, 1, 120, NULL, 'priority wins'),
       ($1, $3, 1, 'A1', NULL, 1, 100, NULL, 'lower price but worse priority'),
       ($1, $2, 1, 'A2', 'M', 1, 130, NULL, 'same priority, higher price'),
       ($1, $4, 1, 'A2', 'M', 1, 90, NULL, 'same priority, lower price wins'),
       ($1, $2, 1, 'A3', 'L', 1, 100, NULL, 'tie supplier_id low'),
       ($1, $4, 1, 'A3', 'L', 1, 100, NULL, 'tie supplier_id high')`,
    [context.importJobId, context.supplierA, context.supplierB, context.supplierC]
  );

  const finalizer = new FinalizerDb(pool, {
    finalizeDeleteEnabled: true,
    priceAtImportEnabled: false
  });
  const summary = await finalizer.buildFinalDataset(context.finalizeJobId);
  assert.equal(summary.finalCount, 3, 'finalize must produce 3 deduped rows');

  const rows = await pool.query<{
    article: string;
    size: string | null;
    supplier_id: number;
    price_final: string;
  }>(
    `SELECT article, size, supplier_id::int AS supplier_id, price_final::text AS price_final
     FROM products_final
     ORDER BY article ASC, size ASC NULLS FIRST`
  );
  const byArticle = new Map<string, (typeof rows.rows)[number]>();
  rows.rows.forEach((row) => byArticle.set(`${row.article}:${row.size || ''}`, row));

  assert.equal(
    byArticle.get('A1:')?.supplier_id,
    context.supplierA,
    'priority must win over lower price'
  );
  assert.equal(
    byArticle.get('A2:M')?.supplier_id,
    context.supplierC,
    'lower price must win when priority equal'
  );
  assert.equal(
    byArticle.get('A3:L')?.supplier_id,
    context.supplierA,
    'supplier_id asc must break full ties'
  );
}

async function testOverridePrecedenceInvariant(
  pool: Pool,
  context: { finalizeJobId: number }
): Promise<void> {
  await pool.query(
    `INSERT INTO price_overrides (article, size, price_final, is_active, notes)
     VALUES ('A2', 'M', 777, TRUE, 'manual override')`
  );
  await pool.query(`UPDATE jobs SET status = 'success', finished_at = NOW() WHERE id = $1`, [
    context.finalizeJobId
  ]);

  const previewProvider = new ExportPreviewDb(pool);
  const preview = await previewProvider.buildNeutralPreview(0, { supplier: null });
  const row = preview.rows.find((item) => item.article === 'A2' && String(item.size || '') === 'M');
  assert.ok(row, 'A2-M row must exist in preview');
  assert.equal(row?.priceFinal, 777, 'active override must replace final price in preview');
}

async function testResumeMismatchGuards(pool: Pool): Promise<void> {
  const failedStoreImport = await pool.query<{ id: number }>(
    `INSERT INTO jobs (type, status, meta, started_at, finished_at)
     VALUES (
       'store_import',
       'failed',
       '{"supplier":"alpha","storeImportProgress":{"processed":15,"total":20}}'::jsonb,
       NOW(),
       NOW()
     )
     RETURNING id::int AS id`
  );
  const noProgressStoreImport = await pool.query<{ id: number }>(
    `INSERT INTO jobs (type, status, meta, started_at, finished_at)
     VALUES (
       'store_import',
       'failed',
       '{"supplier":"alpha"}'::jsonb,
       NOW(),
       NOW()
     )
     RETURNING id::int AS id`
  );

  const pipelineStub = {
    store: 'cscart',
    runImportAll: async () => ({ importedSources: 0, importedRows: 0, skippedRows: 0, warnings: [] }),
    runImportSource: async () => ({ importedSources: 0, importedRows: 0, skippedRows: 0, warnings: [], sources: [] }),
    runImportSupplier: async () => ({ importedSources: 0, importedRows: 0, skippedRows: 0, warnings: [], sources: [] }),
    runFinalize: async () => ({ rawCount: 0, finalCount: 0, durationMs: 0 }),
    runStoreImport: async () => {
      throw new Error('runStoreImport should not be called in guard tests');
    },
    forEachStoreMirrorPage: async () => ({ fetched: 0, pages: 0 })
  } as unknown;

  const jobService = new JobService(pool);
  const runner = new PipelineJobRunner(
    pipelineStub as any,
    jobService,
    { log: async () => undefined } as any,
    { run: async () => ({ retentionDays: 1, deletedRows: 0 }) } as any,
    {
      createSyncMarker: () => new Date().toISOString(),
      upsertSnapshotChunk: async () => 0,
      pruneSnapshot: async () => 0
    } as any
  );

  await assert.rejects(
    () => runner.runStoreImport('beta', { resumeFromJobId: failedStoreImport.rows[0].id }),
    (error: any) =>
      Number(error?.status) === 400 &&
      String(error?.message || '').includes('different supplier filter')
  );

  await assert.rejects(
    () => runner.runStoreImport('alpha', { resumeFromJobId: noProgressStoreImport.rows[0].id }),
    (error: any) =>
      Number(error?.status) === 400 &&
      String(error?.message || '').includes('no progress checkpoint')
  );
}

async function main(): Promise<void> {
  const databaseUrl = readRequiredEnv('DATABASE_URL');
  const schema = createSchemaName();
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });

  try {
    await pool.query(`CREATE SCHEMA ${schema}`);
    await pool.query(`SET search_path TO ${schema}, public`);
    await createTables(pool);

    await testMappingInvariant();

    const seeded = await seedCoreData(pool);
    await testFinalizeDedupInvariant(pool, seeded);
    await testOverridePrecedenceInvariant(pool, seeded);
    await testResumeMismatchGuards(pool);

    // eslint-disable-next-line no-console
    console.log(
      json({
        ok: true,
        suite: 'invariant-integration',
        schema,
        checks: ['mapping', 'dedup-winner', 'override-precedence', 'resume-guards']
      })
    );
  } finally {
    try {
      await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } catch (dropError) {
      // eslint-disable-next-line no-console
      console.error(dropError instanceof Error ? dropError.message : dropError);
    }
    await pool.end();
  }
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
