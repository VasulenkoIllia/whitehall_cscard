import { Pool } from 'pg';

function parseUsers(): { email: string; password_hash: string; role: string }[] {
  const raw = process.env.AUTH_USERS_JSON || '[]';
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter((u) => u && u.email && u.password_hash && u.role)
      .map((u) => ({
        email: String(u.email).toLowerCase(),
        password_hash: String(u.password_hash),
        role: String(u.role) === 'admin' ? 'admin' : 'viewer'
      }));
  } catch (err) {
    console.error('Failed to parse AUTH_USERS_JSON', err);
    return [];
  }
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set');
  }
  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    const users = parseUsers();
    if (!users.length) {
      console.log('No users to seed');
      return;
    }
    for (const user of users) {
      await client.query(
        `INSERT INTO users (email, password_hash, role, is_active)
         VALUES ($1, $2, $3, TRUE)
         ON CONFLICT (email) DO UPDATE
         SET password_hash = EXCLUDED.password_hash,
             role = EXCLUDED.role,
             is_active = TRUE`,
        [user.email, user.password_hash, user.role]
      );
    }
    console.log(`Seeded ${users.length} user(s)`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
