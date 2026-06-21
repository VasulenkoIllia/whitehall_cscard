import type { Pool } from 'pg';
import type { EnrichmentService } from './EnrichmentService';
import type { JobService } from '../jobs/JobService';
import type { LogService } from '../pipeline/log';

/**
 * EnrichmentJobService — фонова обробка вибірки SKU на сервері.
 *
 * Навіщо: синхронний enrich (навіть порціями з браузера) обривається, коли
 * користувач закриває ноут/вкладку. Тут обробка йде у Node-процесі сервера
 * (detached promise) — переживає закриття клієнта. submit() повертає одразу,
 * UI поллить прогрес. Це дає DeepSeek (у якого немає async Batch) той самий
 * «submit & walk away», що й Claude async batch.
 *
 * Стан тримаємо у наявній таблиці jobs (type='enrich_batch_bg'), прогрес — у
 * jobs.meta. Один enrichment-job за раз (job_lock 'enrichment_batch'), щоб не
 * перевантажувати провайдера і не дублювати роботу. Рестарт процесу →
 * startup-cleanup позначить job 'failed' і звільнить lock (оброблені SKU вже
 * збережені по-чанково; решту користувач до-запустить фільтром «Не опрацьовані»).
 */

export const ENRICH_JOB_TYPE = 'enrich_batch_bg';
const LOCK_NAME = 'enrichment_batch';

export interface EnrichJobOptions {
  model?: string;
  batchSize?: number;
  overwrite?: boolean;
}

export interface EnrichJobMeta {
  model: string;
  batchSize: number;
  overwrite: boolean;
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  fieldsWritten: number;
  inputTokens: number;
  outputTokens: number;
  phase: 'running' | 'done';
  cancelRequested?: boolean;
}

export interface EnrichJobRow {
  id: number;
  status: string;
  meta: Record<string, unknown> | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export class EnrichmentJobService {
  constructor(
    private readonly pool: Pool,
    private readonly enrichment: EnrichmentService,
    private readonly jobs: JobService,
    private readonly logs: LogService
  ) {}

  /**
   * Створює фонове завдання і ОДРАЗУ повертає {jobId}. Реальна обробка йде
   * detached у runInBackground — не чекаємо її тут.
   */
  async submit(masterIds: number[], options: EnrichJobOptions = {}): Promise<{ jobId: number; total: number; model: string }> {
    if (!Array.isArray(masterIds) || masterIds.length === 0) {
      throw new Error('masterIds порожній');
    }
    const ids = [...new Set(masterIds.map((x) => Number(x)).filter((x) => Number.isFinite(x)))];
    const model = options.model || 'claude-haiku-4-5';
    const batchSize = Math.min(25, Math.max(1, Math.trunc(options.batchSize || 10)));
    const overwrite = options.overwrite === true;

    // Один enrichment-job за раз — чистий 409 ще до створення запису.
    const running = await this.jobs.findRunningJobs([ENRICH_JOB_TYPE]);
    if (running.length > 0) {
      const err = new Error('Уже виконується фонове завдання enrichment — дочекайтесь або скасуйте його');
      (err as { status?: number }).status = 409;
      throw err;
    }

    const meta: EnrichJobMeta = {
      model, batchSize, overwrite,
      total: ids.length, processed: 0, succeeded: 0, failed: 0,
      fieldsWritten: 0, inputTokens: 0, outputTokens: 0, phase: 'running'
    };
    const job = await this.jobs.createJob(ENRICH_JOB_TYPE, meta);

    // Атомарний lock (захист від гонки одночасних submit).
    const locked = await this.jobs.acquireJobLock(job.id, LOCK_NAME);
    if (!locked) {
      await this.jobs.failJob(job.id, { error: 'Не вдалося отримати lock — інше завдання вже виконується' });
      const err = new Error('Уже виконується фонове завдання enrichment');
      (err as { status?: number }).status = 409;
      throw err;
    }
    await this.jobs.startJob(job.id);
    await this.logs.log(job.id, 'info', `enrich_batch_bg старт: ${ids.length} SKU, модель ${model}`, { batchSize, overwrite });

    // Detached — НЕ await. Живе в event-loop сервера, переживає закриття клієнта.
    void this.runInBackground(job.id, ids, { model, batchSize, overwrite }).catch(() => undefined);

    return { jobId: job.id, total: ids.length, model };
  }

  private async runInBackground(
    jobId: number,
    masterIds: number[],
    opts: { model: string; batchSize: number; overwrite: boolean }
  ): Promise<void> {
    // Порція = batchSize: кожен виклик enrichBatch = один AI-виклик, тож прогрес
    // оновлюється після кожного запиту до провайдера (дрібно й наочно).
    const page = opts.batchSize;
    const agg = { processed: 0, succeeded: 0, failed: 0, fieldsWritten: 0, inputTokens: 0, outputTokens: 0 };
    let canceled = false;
    try {
      for (let i = 0; i < masterIds.length; i += page) {
        const cur = await this.jobs.getJob(jobId);
        if (!cur || cur.status === 'canceled' || (cur.meta && cur.meta.cancelRequested === true)) {
          canceled = true;
          break;
        }
        const chunk = masterIds.slice(i, i + page);
        try {
          const r = await this.enrichment.enrichBatch(chunk, {
            model: opts.model,
            batchSize: opts.batchSize,
            overwriteExisting: opts.overwrite
          });
          agg.processed += r.itemsRequested || chunk.length;
          agg.succeeded += r.itemsEnriched || 0;
          agg.failed += r.itemsFailed || 0;
          agg.fieldsWritten += r.totalFieldsWritten || 0;
          agg.inputTokens += r.inputTokens || 0;
          agg.outputTokens += r.outputTokens || 0;
        } catch (err) {
          // Ціла порція впала (напр. провайдер недоступний) — рахуємо failed і йдемо далі.
          agg.processed += chunk.length;
          agg.failed += chunk.length;
          await this.logs.log(jobId, 'warning', 'enrich порція впала', {
            from: i, size: chunk.length, error: err instanceof Error ? err.message : String(err)
          });
        }
        await this.jobs.mergeJobMeta(jobId, { ...agg, phase: 'running' });
      }

      if (canceled) {
        await this.jobs.mergeJobMeta(jobId, { ...agg, phase: 'done' });
        await this.jobs.cancelJob(jobId, 'Скасовано користувачем');
        await this.logs.log(jobId, 'info', 'enrich_batch_bg скасовано', agg);
      } else {
        await this.jobs.mergeJobMeta(jobId, { ...agg, phase: 'done' });
        await this.jobs.finishJob(jobId);
        await this.logs.log(jobId, 'info', 'enrich_batch_bg завершено', agg);
      }
    } catch (err) {
      await this.jobs.failJob(jobId, { error: err instanceof Error ? err.message : String(err), ...agg });
    } finally {
      await this.jobs.releaseJobLock(jobId, LOCK_NAME).catch(() => undefined);
    }
  }

  /** Останні фонові завдання для UI. */
  async recent(limit = 20): Promise<EnrichJobRow[]> {
    const size = Math.max(1, Math.min(100, Math.trunc(limit || 20)));
    const res = await this.pool.query(
      `SELECT id::int AS id, status, meta,
              created_at::text AS "createdAt",
              started_at::text AS "startedAt",
              finished_at::text AS "finishedAt"
         FROM jobs
        WHERE type = $1
        ORDER BY id DESC
        LIMIT $2`,
      [ENRICH_JOB_TYPE, size]
    );
    return res.rows;
  }

  async get(jobId: number): Promise<EnrichJobRow | null> {
    const res = await this.pool.query(
      `SELECT id::int AS id, status, meta,
              created_at::text AS "createdAt",
              started_at::text AS "startedAt",
              finished_at::text AS "finishedAt"
         FROM jobs
        WHERE id = $1 AND type = $2`,
      [jobId, ENRICH_JOB_TYPE]
    );
    return res.rows[0] || null;
  }

  /** Прапорець скасування — фоновий цикл зупиниться між порціями. */
  async cancel(jobId: number): Promise<{ ok: boolean }> {
    const job = await this.get(jobId);
    if (!job) {
      const err = new Error('Завдання не знайдено');
      (err as { status?: number }).status = 404;
      throw err;
    }
    if (job.status !== 'running') return { ok: true };
    await this.jobs.mergeJobMeta(jobId, { cancelRequested: true });
    return { ok: true };
  }
}
