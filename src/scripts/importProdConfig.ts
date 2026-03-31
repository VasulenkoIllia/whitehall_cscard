/**
 * Import configuration snapshot into a fresh database.
 * Imports: suppliers, sources, column_mappings,
 *          markup_rule_sets, markup_rule_conditions, markup_settings,
 *          size_mappings
 *
 * Safe to run multiple times (ON CONFLICT DO NOTHING).
 * After import, resets all sequences to avoid ID collisions on new records.
 *
 * Usage:
 *   INPUT_PATH=./output/prod_config_snapshot.json npm run import:config
 *   DRY_RUN=true INPUT_PATH=./output/prod_config_snapshot.json npm run import:config
 */
import fs from 'fs';
import path from 'path';
import { Pool, type PoolClient } from 'pg';

type Row = Record<string, unknown>;

function readRequiredEnv(name: string): string {
  const v = process.env[name];
  if (!v?.trim()) throw new Error(`${name} is not set`);
  return v.trim();
}

function resolveInputPath(): string {
  const raw = readRequiredEnv('INPUT_PATH');
  return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
}

function isDryRun(): boolean {
  const v = String(process.env.DRY_RUN || '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/** INSERT rows preserving original IDs. Skips conflicts (idempotent). */
async function insertRows(
  client: PoolClient,
  table: string,
  rows: Row[],
  dryRun: boolean
): Promise<{ inserted: number; skipped: number }> {
  if (rows.length === 0) return { inserted: 0, skipped: 0 };

  const columns = Object.keys(rows[0]);
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
  const sql = `
    INSERT INTO ${table} (${columns.map((c) => `"${c}"`).join(', ')})
    VALUES (${placeholders})
    ON CONFLICT (id) DO NOTHING
  `;

  let inserted = 0;
  let skipped = 0;

  for (const row of rows) {
    const values = columns.map((c) => row[c] ?? null);
    if (!dryRun) {
      const result = await client.query(sql, values);
      if ((result.rowCount ?? 0) > 0) inserted++;
      else skipped++;
    } else {
      inserted++; // dry-run counts as "would insert"
    }
  }

  return { inserted, skipped };
}

/**
 * Reset a sequence to MAX(id) + 1 so new inserts don't collide.
 * markup_settings uses a fixed id=1 (not a sequence), so we skip it.
 */
async function resetSequences(client: PoolClient, tables: string[]): Promise<void> {
  const tablesWithSeq = tables.filter((t) => t !== 'markup_settings');
  for (const table of tablesWithSeq) {
    await client.query(`
      SELECT setval(
        pg_get_serial_sequence('${table}', 'id'),
        COALESCE((SELECT MAX(id) FROM ${table}), 0) + 1,
        false
      )
    `);
  }
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');

  const inputPath = resolveInputPath();
  const dryRun = isDryRun();

  if (!fs.existsSync(inputPath)) {
    throw new Error(`Snapshot file not found: ${inputPath}`);
  }

  const raw = fs.readFileSync(inputPath, 'utf8');
  const snapshot = JSON.parse(raw) as { exportedAt: string; tables: Record<string, Row[]> };

  console.log(`Snapshot exported at: ${snapshot.exportedAt}`);
  if (dryRun) console.log('DRY RUN mode — no changes will be written\n');

  // Import order matters: referenced tables first
  const ORDER = [
    'markup_rule_sets',
    'markup_rule_conditions',
    'markup_settings',
    'suppliers',
    'sources',
    'column_mappings',
    'size_mappings',
  ];

  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();

  try {
    if (!dryRun) await client.query('BEGIN');

    for (const table of ORDER) {
      const rows = snapshot.tables[table];
      if (!rows) {
        console.log(`  ${table}: not found in snapshot, skipping`);
        continue;
      }

      const { inserted, skipped } = await insertRows(client, table, rows, dryRun);
      const label = dryRun ? 'would insert' : 'inserted';
      console.log(`  ${table}: ${label} ${inserted}, skipped ${skipped} (already exist)`);
    }

    if (!dryRun) {
      await resetSequences(client, ORDER);
      await client.query('COMMIT');
      console.log('\n✓ Import complete. Sequences reset.');
    } else {
      console.log('\n✓ Dry run complete. Run without DRY_RUN=true to apply.');
    }
  } catch (err) {
    if (!dryRun) await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Import failed:', err.message);
  process.exit(1);
});
