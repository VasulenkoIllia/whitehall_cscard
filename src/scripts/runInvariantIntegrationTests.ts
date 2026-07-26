import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { JobService } from '../core/jobs/JobService';
import { PipelineJobRunner } from '../core/jobs/PipelineJobRunner';
import { StoreMirrorService } from '../core/jobs/StoreMirrorService';
import { FinalizerDb } from '../core/pipeline/finalizerDb';
import { ExportPreviewDb } from '../core/pipeline/exportPreviewDb';
import { detectMappingFromRow, hasRequiredFields } from '../core/pipeline/mapping';
import type { MirrorRow } from '../core/domain/store';

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
      sku_prefix TEXT,
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
      comment_text TEXT,
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
      comment_text TEXT,
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

    CREATE TABLE size_mappings (
      id BIGSERIAL PRIMARY KEY,
      size_from TEXT NOT NULL,
      size_to TEXT NOT NULL,
      notes TEXT,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE UNIQUE INDEX size_mappings_from_ci_uq
      ON size_mappings (LOWER(TRIM(size_from)));

    CREATE TABLE store_mirror (
      store TEXT NOT NULL,
      article TEXT NOT NULL,
      supplier TEXT,
      parent_article TEXT,
      visibility BOOLEAN NOT NULL,
      price NUMERIC(12, 2),
      amount INTEGER NOT NULL DEFAULT 0,
      raw JSONB,
      synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      seen_at TIMESTAMPTZ,
      collection_code TEXT,
      variation_group_code TEXT,
      PRIMARY KEY (store, article)
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

async function testSupplierPrefixIsolationInvariant(
  pool: Pool,
  context: {
    supplierA: number;
    supplierB: number;
    supplierC: number;
  }
): Promise<void> {
  await pool.query(`UPDATE suppliers SET sku_prefix = 'SUPA' WHERE id = $1`, [context.supplierA]);
  await pool.query(`UPDATE suppliers SET sku_prefix = 'SUPB' WHERE id = $1`, [context.supplierB]);
  await pool.query(`UPDATE suppliers SET sku_prefix = NULL WHERE id = $1`, [context.supplierC]);

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

  await pool.query(
    `INSERT INTO products_raw
       (job_id, supplier_id, source_id, article, size, quantity, price, price_with_markup, extra)
     VALUES
       ($1, $2, 1, '123123', NULL, 4, 100, NULL, 'supplier a'),
       ($1, $3, 1, '123123', NULL, 2, 90, NULL, 'supplier b'),
       ($1, $4, 1, '123123', NULL, 1, 80, NULL, 'supplier c')`,
    [importJob.rows[0].id, context.supplierA, context.supplierB, context.supplierC]
  );

  const finalizer = new FinalizerDb(pool, {
    finalizeDeleteEnabled: true,
    priceAtImportEnabled: false
  });
  const summary = await finalizer.buildFinalDataset(finalizeJob.rows[0].id);
  assert.equal(summary.finalCount, 3, 'same article must be isolated by supplier sku prefixes');

  const rows = await pool.query<{ article: string }>(
    `SELECT article
     FROM products_final
     ORDER BY article ASC`
  );
  const articles = rows.rows.map((row) => row.article);
  assert.deepEqual(
    articles,
    ['123123', 'SUPA-123123', 'SUPB-123123'],
    'products_final must contain prefixed and plain sku variants'
  );

  await pool.query(`UPDATE jobs SET status = 'success', finished_at = NOW() WHERE id = $1`, [
    finalizeJob.rows[0].id
  ]);

  const previewProvider = new ExportPreviewDb(pool);
  const preview = await previewProvider.buildNeutralPreview(0, { supplier: null });
  const previewArticles = preview.rows.map((item) => item.article).sort();
  assert.deepEqual(
    previewArticles,
    ['123123', 'SUPA-123123', 'SUPB-123123'],
    'export preview must use effective prefixed sku values'
  );
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
      createSyncMarker: async () => new Date().toISOString(),
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

/**
 * Regression for the lock hole behind the 2026-07-22 incident.
 *
 * Every caller creates its job (status 'queued') and only then starts it
 * (status 'running'). The reclaim branch of acquireJobLock treated anything
 * that was not 'running' as a dead holder, so a second job arriving inside that
 * window simply took the lock away. The scheduler fires all due tasks in one
 * tick, so update_pipeline and the standalone store_mirror_sync hit it 3 ms
 * apart and both proceeded.
 */
async function testJobLockQueuedGraceInvariant(pool: Pool): Promise<void> {
  const jobs = new JobService(pool);
  await pool.query(`DELETE FROM job_locks`);

  const holder = await jobs.createJob('update_pipeline', {});
  assert.equal(await jobs.acquireJobLock(holder.id), true, 'first job must take the lock');

  const rival = await jobs.createJob('store_mirror_sync', {});
  assert.equal(
    await jobs.acquireJobLock(rival.id),
    false,
    'a queued lock holder must not be mistaken for a dead one'
  );

  await jobs.startJob(holder.id);
  assert.equal(
    await jobs.acquireJobLock(rival.id),
    false,
    'a running lock holder must keep the lock'
  );

  await jobs.failJob(holder.id, new Error('process crashed'));
  assert.equal(
    await jobs.acquireJobLock(rival.id),
    true,
    'a dead lock holder must release the lock'
  );
}

function mirrorRow(article: string): MirrorRow {
  return {
    article,
    supplier: null,
    parentArticle: null,
    visibility: true,
    price: 100,
    collectionCode: null,
    variationGroupCode: null,
    raw: { product_id: article, amount: '1', status: 'A' }
  };
}

function mirrorRows(articles: string[]): MirrorRow[] {
  return articles.map((article) => mirrorRow(article));
}

async function readMirrorArticles(pool: Pool): Promise<string[]> {
  const result = await pool.query<{ article: string }>(
    `SELECT article FROM store_mirror WHERE store = 'cscart' ORDER BY article ASC`
  );
  return result.rows.map((row) => row.article);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Regression for the 2026-07-22 production incident.
 *
 * The scheduler fired the standalone store_mirror_sync task and the
 * update_pipeline mirror step in the same tick (3 ms apart) and the job lock
 * let both through. Each run pruned with
 * `seen_at IS DISTINCT FROM <its own marker>`, so whichever finished last
 * deleted every row the other had written. The mirror collapsed from 242 613
 * rows to 613 — literally the last catalog page — and the store_import that
 * followed dropped 153 233 SKUs as "missing in mirror" and pushed nothing,
 * while every job still reported success.
 *
 * The sequence below reproduces that interleaving deterministically: A walks
 * the whole catalog, B rewrites part of it, A prunes, B finishes and prunes.
 * No row that either run wrote may disappear.
 */
async function testConcurrentMirrorSnapshotsInvariant(pool: Pool): Promise<void> {
  const mirror = new StoreMirrorService(pool);
  const catalog = ['SKU-1', 'SKU-2', 'SKU-3'];

  await pool.query(`DELETE FROM store_mirror`);

  const markerA = await mirror.createSyncMarker();
  await sleep(5);
  const markerB = await mirror.createSyncMarker();
  assert.ok(markerA < markerB, 'sync markers must be strictly increasing');

  await mirror.upsertSnapshotChunk('cscart', mirrorRows(catalog), markerA);
  await mirror.upsertSnapshotChunk('cscart', mirrorRows(catalog.slice(0, 2)), markerB);
  await mirror.pruneSnapshot('cscart', markerA);
  await mirror.upsertSnapshotChunk('cscart', mirrorRows(catalog.slice(2)), markerB);
  await mirror.pruneSnapshot('cscart', markerB);

  assert.deepEqual(
    await readMirrorArticles(pool),
    catalog,
    'overlapping mirror snapshots must not delete each other rows'
  );
}

/**
 * The prune must still do its actual job: drop rows for products that really
 * vanished from the store. Guards against "fixing" the race by never deleting.
 */
async function testMirrorPrunesVanishedRowsInvariant(pool: Pool): Promise<void> {
  const mirror = new StoreMirrorService(pool);
  const kept = ['K-01', 'K-02', 'K-03', 'K-04', 'K-05', 'K-06', 'K-07', 'K-08', 'K-09', 'K-10'];

  await pool.query(`DELETE FROM store_mirror`);

  // First sync ever: the mirror is empty and the ratio guard must not divide by zero.
  assert.equal(
    await mirror.pruneSnapshot('cscart', await mirror.createSyncMarker()),
    0,
    'pruning an empty mirror must be a no-op'
  );

  const previous = await mirror.createSyncMarker();
  await mirror.upsertSnapshotChunk('cscart', mirrorRows([...kept, 'GONE-1']), previous);
  await sleep(5);

  const current = await mirror.createSyncMarker();
  await mirror.upsertSnapshotChunk('cscart', mirrorRows(kept), current);
  const deleted = await mirror.pruneSnapshot('cscart', current);

  assert.equal(deleted, 1, 'prune must delete products that disappeared from the store');
  assert.deepEqual(
    await readMirrorArticles(pool),
    kept,
    'prune must keep every product the current snapshot saw'
  );
}

/**
 * Last line of defence. Even if two runs somehow overlap again (a manual
 * "Знімок магазину" fired at the wrong moment), a prune that would wipe most
 * of the mirror must fail loudly instead of silently emptying the table —
 * a silent empty mirror is exactly what made the incident invisible for days.
 */
async function testMirrorPruneSafetyValveInvariant(pool: Pool): Promise<void> {
  const mirror = new StoreMirrorService(pool);
  const catalog = ['S-01', 'S-02', 'S-03', 'S-04', 'S-05', 'S-06', 'S-07', 'S-08', 'S-09', 'S-10'];

  await pool.query(`DELETE FROM store_mirror`);

  const previous = await mirror.createSyncMarker();
  await mirror.upsertSnapshotChunk('cscart', mirrorRows(catalog), previous);
  await sleep(5);

  const current = await mirror.createSyncMarker();
  await mirror.upsertSnapshotChunk('cscart', mirrorRows(catalog.slice(0, 1)), current);

  await assert.rejects(
    () => mirror.pruneSnapshot('cscart', current),
    (error: any) => String(error?.message || '').includes('store_mirror prune'),
    'prune must refuse to delete an implausible share of the mirror'
  );

  assert.deepEqual(
    await readMirrorArticles(pool),
    catalog,
    'a refused prune must leave the mirror untouched'
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

    // Optional argv filter: `node runInvariantIntegrationTests.js <check> [...]`
    // runs only the named checks. No arguments keeps the previous behaviour and
    // runs the whole suite.
    const requested = process.argv.slice(2).map((value) => value.trim()).filter(Boolean);
    const wanted = (check: string): boolean => requested.length === 0 || requested.includes(check);
    const executed: string[] = [];
    const run = async (check: string, action: () => Promise<void>): Promise<void> => {
      if (!wanted(check)) {
        return;
      }
      await action();
      executed.push(check);
    };

    await run('mapping', () => testMappingInvariant());

    const seedDependent = ['dedup-winner', 'override-precedence', 'supplier-sku-prefix-isolation'];
    if (seedDependent.some(wanted)) {
      const seeded = await seedCoreData(pool);
      await run('dedup-winner', () => testFinalizeDedupInvariant(pool, seeded));
      await run('override-precedence', () => testOverridePrecedenceInvariant(pool, seeded));
      await run('supplier-sku-prefix-isolation', () =>
        testSupplierPrefixIsolationInvariant(pool, seeded)
      );
    }

    await run('resume-guards', () => testResumeMismatchGuards(pool));
    await run('job-lock-queued-grace', () => testJobLockQueuedGraceInvariant(pool));
    await run('concurrent-mirror-snapshots', () => testConcurrentMirrorSnapshotsInvariant(pool));
    await run('mirror-prunes-vanished-rows', () => testMirrorPrunesVanishedRowsInvariant(pool));
    await run('mirror-prune-safety-valve', () => testMirrorPruneSafetyValveInvariant(pool));

    // eslint-disable-next-line no-console
    console.log(
      json({
        ok: true,
        suite: 'invariant-integration',
        schema,
        checks: executed
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
