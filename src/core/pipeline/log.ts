import type { Pool } from 'pg';

export type LogLevel = 'info' | 'warning' | 'error';

export class LogService {
  constructor(private readonly pool: Pool) {}

  async log(jobId: number | null, level: LogLevel, message: string, data?: unknown): Promise<void> {
    await this.pool.query(
      'INSERT INTO logs (job_id, level, message, data) VALUES ($1, $2, $3, $4)',
      [jobId || null, level, message, data ?? null]
    );
  }
}
