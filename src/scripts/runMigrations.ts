import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';

async function ensureTable(pool: Pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS migration_history (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function hasMigration(pool: Pool, id: string): Promise<boolean> {
  const res = await pool.query('SELECT 1 FROM migration_history WHERE id = $1', [id]);
  return (res.rowCount || 0) > 0;
}

async function applyMigration(pool: Pool, id: string, sql: string) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('INSERT INTO migration_history (id) VALUES ($1)', [id]);
    await client.query('COMMIT');
    // eslint-disable-next-line no-console
    console.log(`Applied migration ${id}`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set');
  }
  const pool = new Pool({ connectionString: databaseUrl });
  const migrationsDir = path.resolve(__dirname, '..', '..', 'migrations');
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort((a, b) => {
      const idA = a.split('_')[0];
      const idB = b.split('_')[0];
      return Number(idA) - Number(idB);
    });

  await ensureTable(pool);

  for (const file of files) {
    const id = file.replace('.sql', '');
    // eslint-disable-next-line no-await-in-loop
    if (await hasMigration(pool, id)) {
      // eslint-disable-next-line no-console
      console.log(`Skip migration ${id} (already applied)`);
      continue;
    }
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    // eslint-disable-next-line no-await-in-loop
    await applyMigration(pool, id, sql);
  }

  await pool.end();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
