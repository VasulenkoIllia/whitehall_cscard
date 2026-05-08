import { Pool } from 'pg';

/**
 * Create a configured Postgres connection pool.
 *
 * Timeouts are explicit so a stuck query / busy pool surfaces as a clear error
 * instead of an indefinite hang (we previously observed silent stalls when the
 * default `pg.Pool` had no `connectionTimeoutMillis`).
 *
 *  - max=10                                — pg default; pin it to make the limit explicit.
 *  - connectionTimeoutMillis=30s           — cap how long acquiring a connection waits.
 *  - statement_timeout=30min               — server-side cap; finalize on a large catalog
 *                                            takes minutes, so this leaves a generous margin
 *                                            but ensures a runaway query can't run forever.
 *  - idle_in_transaction_session_timeout=5min — kill forgotten transactions holding locks.
 *  - idleTimeoutMillis=60s                 — keep healthy connections warm a bit longer to
 *                                            cut reconnect overhead under bursty workloads.
 *
 * All values are conservative — none of our existing queries should hit them under
 * normal operation. They only fire on real failure modes.
 */
export function createPgPool(connectionString: string): Pool {
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set');
  }
  return new Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 30_000,
    idleTimeoutMillis: 60_000,
    statement_timeout: 1_800_000,
    idle_in_transaction_session_timeout: 300_000
  });
}
