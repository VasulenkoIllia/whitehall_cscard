import { Pool } from 'pg';

export function createPgPool(connectionString: string): Pool {
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set');
  }
  return new Pool({ connectionString });
}
