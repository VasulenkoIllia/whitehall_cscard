/**
 * Export all configuration tables to a JSON snapshot file.
 * Includes: suppliers, sources, column_mappings,
 *           markup_rule_sets, markup_rule_conditions, markup_settings,
 *           size_mappings
 *
 * Usage:
 *   npm run export:config
 *   OUTPUT_PATH=./my_backup.json npm run export:config
 */
import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';

const TABLES = [
  'markup_rule_sets',
  'markup_rule_conditions',
  'markup_settings',
  'suppliers',
  'sources',
  'column_mappings',
  'size_mappings',
] as const;

function resolveOutputPath(): string {
  const raw = process.env.OUTPUT_PATH || 'output/prod_config_snapshot.json';
  return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');

  const pool = new Pool({ connectionString: databaseUrl });

  try {
    const snapshot: Record<string, unknown[]> = {};

    for (const table of TABLES) {
      const result = await pool.query(`SELECT * FROM ${table} ORDER BY id`);
      snapshot[table] = result.rows;
      console.log(`  ${table}: ${result.rowCount} rows`);
    }

    const outputPath = resolveOutputPath();
    const outputDir = path.dirname(outputPath);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const json = JSON.stringify({ exportedAt: new Date().toISOString(), tables: snapshot }, null, 2);
    fs.writeFileSync(outputPath, json, 'utf8');

    console.log(`\n✓ Snapshot saved to: ${outputPath}`);
    console.log(`  Total size: ${(Buffer.byteLength(json) / 1024).toFixed(1)} KB`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Export failed:', err.message);
  process.exit(1);
});
