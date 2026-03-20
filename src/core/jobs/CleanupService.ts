import type { Pool } from 'pg';

export interface CleanupSummary {
  retentionDays: number;
  droppedPartitions: string[];
  deletedRawRows: number;
  deletedLogs: number;
  deletedJobs: number;
  deletedOrphanLocks: number;
}

interface PartitionRecord {
  relName: string;
}

function isDailyRawPartition(name: string): boolean {
  return /^products_raw_\d{8}$/.test(name);
}

function partitionDate(name: string): string {
  return name.replace('products_raw_', '');
}

function isOlderThanCutoff(name: string, cutoffYmd: string): boolean {
  return partitionDate(name) < cutoffYmd;
}

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export class CleanupService {
  constructor(private readonly pool: Pool) {}

  async run(retentionDays: number): Promise<CleanupSummary> {
    const safeRetention = Number.isFinite(retentionDays)
      ? Math.max(1, Math.trunc(retentionDays))
      : 10;
    const droppedPartitions: string[] = [];
    let deletedRawRows = 0;

    const cutoffResult = await this.pool.query<{ cutoffYmd: string }>(
      `SELECT TO_CHAR((CURRENT_DATE - ($1::int || ' days')::interval)::date, 'YYYYMMDD') AS "cutoffYmd"`,
      [safeRetention]
    );
    const cutoffYmd = cutoffResult.rows[0]?.cutoffYmd || '19700101';

    const partitionResult = await this.pool.query<PartitionRecord>(
      `SELECT child.relname AS "relName"
       FROM pg_inherits i
       JOIN pg_class parent ON parent.oid = i.inhparent
       JOIN pg_class child ON child.oid = i.inhrelid
       JOIN pg_namespace pns ON pns.oid = parent.relnamespace
       JOIN pg_namespace cns ON cns.oid = child.relnamespace
       WHERE pns.nspname = 'public'
         AND cns.nspname = 'public'
         AND parent.relname = 'products_raw'`
    );

    const partitionNames = partitionResult.rows
      .map((row) => row.relName)
      .filter((name) => isDailyRawPartition(name) && isOlderThanCutoff(name, cutoffYmd))
      .sort();

    for (let index = 0; index < partitionNames.length; index += 1) {
      const partitionName = partitionNames[index];
      await this.pool.query(`DROP TABLE IF EXISTS ${quoteIdentifier(partitionName)}`);
      droppedPartitions.push(partitionName);
    }

    const rawDeleteResult = await this.pool.query(
      `DELETE FROM products_raw
       WHERE created_at < NOW() - ($1::int || ' days')::interval`,
      [safeRetention]
    );
    deletedRawRows = rawDeleteResult.rowCount || 0;

    const logsDeleteResult = await this.pool.query(
      `DELETE FROM logs
       WHERE created_at < NOW() - ($1::int || ' days')::interval`,
      [safeRetention]
    );

    const jobsDeleteResult = await this.pool.query(
      `DELETE FROM jobs
       WHERE created_at < NOW() - ($1::int || ' days')::interval
         AND status IN ('success', 'failed', 'canceled')`,
      [safeRetention]
    );

    const lockDeleteResult = await this.pool.query(
      `DELETE FROM job_locks jl
       WHERE jl.job_id IS NULL
          OR NOT EXISTS (
            SELECT 1
            FROM jobs j
            WHERE j.id = jl.job_id
              AND j.status = 'running'
          )`
    );

    return {
      retentionDays: safeRetention,
      droppedPartitions,
      deletedRawRows,
      deletedLogs: logsDeleteResult.rowCount || 0,
      deletedJobs: jobsDeleteResult.rowCount || 0,
      deletedOrphanLocks: lockDeleteResult.rowCount || 0
    };
  }
}
