import type { Pool } from 'pg';

export type JobStatus = 'queued' | 'running' | 'success' | 'failed' | 'canceled';

export interface JobRecord {
  id: number;
  type: string;
  status: JobStatus;
  meta: Record<string, unknown> | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface JobLogRecord {
  id: number;
  level: 'info' | 'warning' | 'error';
  message: string;
  data: Record<string, unknown> | null;
  createdAt: string;
}

export interface BackendTerminationRecord {
  pid: number;
  terminated: boolean;
}

function normalizeJsonPayload(value: unknown): Record<string, unknown> | null {
  if (value === undefined || value === null) {
    return null;
  }

  if (value instanceof Error) {
    return {
      message: value.message,
      stack: value.stack || null
    };
  }

  if (typeof value === 'string') {
    return { message: value };
  }

  if (Array.isArray(value)) {
    return { items: value };
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return { value };
  }

  if (typeof value === 'object') {
    try {
      JSON.stringify(value);
      return value as Record<string, unknown>;
    } catch (_err) {
      return { message: String(value) };
    }
  }

  return { message: String(value) };
}

export class JobService {
  constructor(private readonly pool: Pool) {}

  async createJob(type: string, meta: unknown = null): Promise<JobRecord> {
    const payload = normalizeJsonPayload(meta);
    const result = await this.pool.query<JobRecord>(
      `INSERT INTO jobs (type, status, meta)
       VALUES ($1, $2, $3)
       RETURNING
         id::bigint::int AS id,
         type,
         status,
         meta,
         created_at::text AS "createdAt",
         started_at::text AS "startedAt",
         finished_at::text AS "finishedAt"`,
      [type, 'queued', payload]
    );
    return result.rows[0];
  }

  async startJob(jobId: number): Promise<void> {
    await this.pool.query(
      `UPDATE jobs
       SET status = $1,
           started_at = NOW()
       WHERE id = $2`,
      ['running', jobId]
    );
  }

  async finishJob(jobId: number): Promise<void> {
    await this.pool.query(
      `UPDATE jobs
       SET status = $1,
           finished_at = NOW()
       WHERE id = $2
         AND status = 'running'`,
      ['success', jobId]
    );
  }

  async failJob(jobId: number, error: unknown): Promise<void> {
    const payload = normalizeJsonPayload(error);
    await this.pool.query(
      `UPDATE jobs
       SET status = $1,
           finished_at = NOW(),
           meta = COALESCE(meta, '{}') || $2::jsonb
       WHERE id = $3
         AND status <> 'canceled'`,
      ['failed', JSON.stringify(payload), jobId]
    );
    await this.pool.query('DELETE FROM job_locks WHERE job_id = $1', [jobId]);
  }

  async cancelJob(jobId: number, reason: string): Promise<JobRecord | null> {
    const payload = normalizeJsonPayload({ error: reason || 'Canceled by user' });
    const result = await this.pool.query<JobRecord>(
      `UPDATE jobs
       SET status = $1,
           finished_at = NOW(),
           meta = COALESCE(meta, '{}') || $2::jsonb
       WHERE id = $3
       RETURNING
         id::bigint::int AS id,
         type,
         status,
         meta,
         created_at::text AS "createdAt",
         started_at::text AS "startedAt",
         finished_at::text AS "finishedAt"`,
      ['canceled', JSON.stringify(payload), jobId]
    );
    await this.pool.query('DELETE FROM job_locks WHERE job_id = $1', [jobId]);
    return result.rows[0] || null;
  }

  async getJob(jobId: number): Promise<JobRecord | null> {
    const result = await this.pool.query<JobRecord>(
      `SELECT
         id::bigint::int AS id,
         type,
         status,
         meta,
         created_at::text AS "createdAt",
         started_at::text AS "startedAt",
         finished_at::text AS "finishedAt"
       FROM jobs
       WHERE id = $1`,
      [jobId]
    );
    return result.rows[0] || null;
  }

  async listJobs(limit = 50): Promise<JobRecord[]> {
    const size = Number.isFinite(limit) ? Math.max(1, Math.min(200, Math.trunc(limit))) : 50;
    const result = await this.pool.query<JobRecord>(
      `SELECT
         id::bigint::int AS id,
         type,
         status,
         meta,
         created_at::text AS "createdAt",
         started_at::text AS "startedAt",
         finished_at::text AS "finishedAt"
       FROM jobs
       ORDER BY id DESC
       LIMIT $1`,
      [size]
    );
    return result.rows;
  }

  async listJobLogs(jobId: number, limit = 200): Promise<JobLogRecord[]> {
    const size = Number.isFinite(limit) ? Math.max(1, Math.min(1000, Math.trunc(limit))) : 200;
    const result = await this.pool.query<JobLogRecord>(
      `SELECT
         id::bigint::int AS id,
         level,
         message,
         data,
         created_at::text AS "createdAt"
       FROM logs
       WHERE job_id = $1
       ORDER BY id DESC
       LIMIT $2`,
      [jobId, size]
    );
    return result.rows;
  }

  async listChildJobs(pipelineJobId: number): Promise<JobRecord[]> {
    const result = await this.pool.query<JobRecord>(
      `SELECT
         id::bigint::int AS id,
         type,
         status,
         meta,
         created_at::text AS "createdAt",
         started_at::text AS "startedAt",
         finished_at::text AS "finishedAt"
       FROM jobs
       WHERE COALESCE(meta->>'pipeline_job_id', '') = $1
       ORDER BY id ASC`,
      [String(pipelineJobId)]
    );
    return result.rows;
  }

  async findRunningJobs(types: string[]): Promise<Array<{ id: number; type: string }>> {
    if (!types.length) {
      return [];
    }
    const result = await this.pool.query<{ id: number; type: string }>(
      `SELECT
         id::bigint::int AS id,
         type
       FROM jobs
       WHERE status = 'running'
         AND type = ANY($1::text[])
       ORDER BY id DESC`,
      [types]
    );
    return result.rows;
  }

  async acquireJobLock(jobId: number, name = 'global'): Promise<boolean> {
    const tryAcquire = async (): Promise<boolean> => {
      const result = await this.pool.query(
        `INSERT INTO job_locks (name, job_id)
         VALUES ($1, $2)
         ON CONFLICT (name) DO NOTHING`,
        [name, jobId]
      );
      return (result.rowCount || 0) > 0;
    };

    if (await tryAcquire()) {
      return true;
    }

    await this.pool.query(
      `DELETE FROM job_locks jl
       WHERE jl.name = $1
         AND (
           jl.job_id IS NULL
           OR NOT EXISTS (
             SELECT 1
             FROM jobs j
             WHERE j.id = jl.job_id
               AND j.status = 'running'
           )
         )`,
      [name]
    );

    return tryAcquire();
  }

  async releaseJobLock(jobId: number, name = 'global'): Promise<void> {
    await this.pool.query(
      `DELETE FROM job_locks
       WHERE name = $1
         AND job_id = $2`,
      [name, jobId]
    );
  }

  async terminateJobBackend(jobId: number, type: string): Promise<BackendTerminationRecord[]> {
    if (!jobId || !type) {
      return [];
    }

    const appName = `whitehall:${type}:${jobId}`;
    const byAppName = await this.pool.query<BackendTerminationRecord>(
      `SELECT
         pid::int AS pid,
         pg_terminate_backend(pid) AS terminated
       FROM pg_stat_activity
       WHERE application_name = $1
         AND pid <> pg_backend_pid()`,
      [appName]
    );

    if (byAppName.rows.length > 0) {
      return byAppName.rows;
    }

    if (type !== 'finalize') {
      return [];
    }

    const finalizeFallback = await this.pool.query<BackendTerminationRecord>(
      `WITH candidate AS (
         SELECT pid
         FROM pg_stat_activity
         WHERE pid <> pg_backend_pid()
           AND state = 'active'
           AND query ILIKE '%finalize_stage%'
         ORDER BY query_start ASC
         LIMIT 1
       )
       SELECT
         pid::int AS pid,
         pg_terminate_backend(pid) AS terminated
       FROM candidate`
    );

    return finalizeFallback.rows;
  }
}
