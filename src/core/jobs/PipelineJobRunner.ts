import { PipelineOrchestrator } from '../pipeline/PipelineOrchestrator';
import { LogService } from '../pipeline/log';
import type {
  FinalizeSummary,
  ImportSummary,
  SourceImportSummary,
  StoreImportExecution,
  UpdatePipelineSummary
} from '../pipeline/contracts';
import { JobService, type JobRecord } from './JobService';
import type { CleanupService, CleanupSummary } from './CleanupService';
import type { StoreMirrorService, StoreMirrorSyncSummary } from './StoreMirrorService';
import type { StoreImportProgress } from '../connectors/StoreConnector';

const BLOCKING_JOB_TYPES = [
  'update_pipeline',
  'import_all',
  'import_source',
  'import_supplier',
  'finalize',
  'store_import',
  'cleanup',
  'store_mirror_sync'
];

interface JobRunnerResult<T> {
  jobId: number;
  result: T;
}

interface ChildStepResult<T> {
  job: JobRecord;
  result: T;
}

export interface StoreImportRunOptions {
  resumeFromJobId?: number | null;
  resumeLatest?: boolean;
}

interface ResolvedStoreImportResume {
  resumeFromJobId: number;
  resumeProcessed: number;
}

function summarizeStoreImportResult(value: unknown): unknown {
  const execution = value as StoreImportExecution<unknown> | null;
  if (
    !execution ||
    typeof execution !== 'object' ||
    !execution.preview ||
    !execution.batch ||
    !execution.importResult
  ) {
    return value;
  }
  const batchRows = Array.isArray((execution.batch as any).rows)
    ? (execution.batch as any).rows.length
    : null;
  return {
    previewTotal: execution.preview.total,
    batchStore: execution.batch.store,
    batchRows,
    batchMeta: execution.batch.meta,
    importResult: execution.importResult
  };
}

function summarizeStepResult(
  type:
    | 'import_all'
    | 'import_source'
    | 'import_supplier'
    | 'finalize'
    | 'store_import'
    | 'cleanup'
    | 'store_mirror_sync',
  value: unknown
): unknown {
  if (type === 'store_import') {
    return summarizeStoreImportResult(value);
  }
  return value;
}

export class JobConflictError extends Error {
  readonly status = 409;

  constructor(message: string) {
    super(message);
    this.name = 'JobConflictError';
  }
}

export class PipelineJobRunner<MappedRow = unknown> {
  constructor(
    private readonly pipeline: PipelineOrchestrator<MappedRow>,
    private readonly jobs: JobService,
    private readonly logs: LogService,
    private readonly cleanupService: CleanupService,
    private readonly storeMirrorService: StoreMirrorService
  ) {}

  private async ensureNoRunningJobs(): Promise<void> {
    const running = await this.jobs.findRunningJobs(BLOCKING_JOB_TYPES);
    if (running.length > 0) {
      throw new JobConflictError(
        `Another job is running: #${running[0].id} (${running[0].type})`
      );
    }
  }

  private async isJobCanceled(jobId: number): Promise<boolean> {
    const job = await this.jobs.getJob(jobId);
    return job?.status === 'canceled';
  }

  private normalizeSupplier(value: string | null): string | null {
    const normalized = String(value || '').trim().toLowerCase();
    return normalized || null;
  }

  private createBadRequest(message: string): Error {
    const error = new Error(message);
    (error as any).status = 400;
    return error;
  }

  private readResumeProcessed(meta: Record<string, unknown> | null): number {
    const snapshot =
      meta && typeof meta.storeImportProgress === 'object' && meta.storeImportProgress
        ? (meta.storeImportProgress as Record<string, unknown>)
        : null;
    if (!snapshot) {
      return 0;
    }
    const processedRaw = Number(snapshot.processed || 0);
    if (!Number.isFinite(processedRaw) || processedRaw <= 0) {
      return 0;
    }
    const totalRaw = Number(snapshot.total || 0);
    const processed = Math.max(0, Math.trunc(processedRaw));
    if (!Number.isFinite(totalRaw) || totalRaw <= 0) {
      return processed;
    }
    return Math.min(Math.max(0, Math.trunc(totalRaw)), processed);
  }

  private async resolveStoreImportResume(
    supplier: string | null,
    options?: StoreImportRunOptions
  ): Promise<ResolvedStoreImportResume | null> {
    const normalizedSupplier = this.normalizeSupplier(supplier);
    const explicitResumeFrom = Number(options?.resumeFromJobId);

    if (Number.isFinite(explicitResumeFrom) && explicitResumeFrom > 0) {
      const sourceJob = await this.jobs.getJob(Math.trunc(explicitResumeFrom));
      if (!sourceJob || sourceJob.type !== 'store_import') {
        throw this.createBadRequest(`store_import job #${explicitResumeFrom} not found`);
      }
      if (sourceJob.status !== 'failed' && sourceJob.status !== 'canceled') {
        throw this.createBadRequest(
          `store_import job #${explicitResumeFrom} must be failed/canceled to resume`
        );
      }
      const sourceSupplier = this.normalizeSupplier(
        typeof sourceJob.meta?.supplier === 'string' ? sourceJob.meta.supplier : null
      );
      if (sourceSupplier !== normalizedSupplier) {
        throw this.createBadRequest(
          `store_import job #${explicitResumeFrom} has different supplier filter`
        );
      }
      const resumeProcessed = this.readResumeProcessed(sourceJob.meta);
      if (resumeProcessed <= 0) {
        throw this.createBadRequest(
          `store_import job #${explicitResumeFrom} has no progress checkpoint`
        );
      }
      return {
        resumeFromJobId: sourceJob.id,
        resumeProcessed
      };
    }

    if (options?.resumeLatest !== true) {
      return null;
    }

    const latest = await this.jobs.findLatestStoreImportJob(supplier, ['failed', 'canceled']);
    if (!latest) {
      const error = new Error('No failed/canceled store_import job found for resume');
      (error as any).status = 404;
      throw error;
    }

    const resumeProcessed = this.readResumeProcessed(latest.meta);
    if (resumeProcessed <= 0) {
      throw this.createBadRequest(
        `store_import job #${latest.id} has no progress checkpoint`
      );
    }

    return {
      resumeFromJobId: latest.id,
      resumeProcessed
    };
  }

  private createStoreImportProgressReporter(
    jobId: number
  ): (progress: StoreImportProgress) => Promise<void> {
    const startedAt = Date.now();
    let lastMetaPersistAt = 0;
    let lastLoggedProcessed = 0;
    let baselineProcessed: number | null = null;
    let baselineImported = 0;
    let baselineFailed = 0;
    let baselineSkipped = 0;
    let lastBatchAt = startedAt;
    let lastBatchProcessed = 0;
    let lastBatchImported = 0;
    let lastBatchFailed = 0;
    let lastBatchSkipped = 0;
    let batchSequence = 0;
    const metaPersistIntervalMs = 5000;
    const logStepRows = 5000;

    return async (progress: StoreImportProgress): Promise<void> => {
      const now = Date.now();
      const elapsedMs = Math.max(1, now - startedAt);
      const processed = Math.max(0, Math.trunc(progress.processed));
      const imported = Math.max(0, Math.trunc(progress.imported));
      const failed = Math.max(0, Math.trunc(progress.failed));
      const skipped = Math.max(0, Math.trunc(progress.skipped));
      if (baselineProcessed === null) {
        baselineProcessed = processed;
        baselineImported = imported;
        baselineFailed = failed;
        baselineSkipped = skipped;
        lastBatchProcessed = processed;
        lastBatchImported = imported;
        lastBatchFailed = failed;
        lastBatchSkipped = skipped;
      }
      const runProcessed = Math.max(0, processed - baselineProcessed);
      const ratePerSecond =
        runProcessed > 0 ? Number((runProcessed / (elapsedMs / 1000)).toFixed(2)) : null;
      const remaining = Math.max(0, Math.trunc(progress.total) - processed);
      const etaSeconds = ratePerSecond && ratePerSecond > 0 ? Math.ceil(remaining / ratePerSecond) : null;

      const runImported = Math.max(0, imported - baselineImported);
      const runFailed = Math.max(0, failed - baselineFailed);
      const runSkipped = Math.max(0, skipped - baselineSkipped);

      const snapshot = {
        ...progress,
        runProcessed,
        runImported,
        runFailed,
        runSkipped,
        updatedAt: new Date(now).toISOString(),
        ratePerSecond,
        etaSeconds
      };

      const shouldLogBatch =
        progress.finished || progress.canceled || processed - lastLoggedProcessed >= logStepRows;
      let batchSummary: Record<string, unknown> | null = null;
      if (shouldLogBatch) {
        const batchDurationMs = Math.max(1, now - lastBatchAt);
        const batchProcessed = Math.max(0, processed - lastBatchProcessed);
        const batchImported = Math.max(0, imported - lastBatchImported);
        const batchFailed = Math.max(0, failed - lastBatchFailed);
        const batchSkipped = Math.max(0, skipped - lastBatchSkipped);
        const batchRatePerSecond =
          batchProcessed > 0 ? Number((batchProcessed / (batchDurationMs / 1000)).toFixed(2)) : null;

        batchSequence += 1;
        batchSummary = {
          seq: batchSequence,
          processedFrom: lastBatchProcessed,
          processedTo: processed,
          batchProcessed,
          batchImported,
          batchFailed,
          batchSkipped,
          batchDurationMs,
          batchRatePerSecond,
          totalRatePerSecond: ratePerSecond,
          etaSeconds,
          finished: progress.finished,
          canceled: progress.canceled
        };

        await this.logs.log(jobId, 'info', 'store_import batch metrics', batchSummary);
        lastLoggedProcessed = processed;
        lastBatchAt = now;
        lastBatchProcessed = processed;
        lastBatchImported = imported;
        lastBatchFailed = failed;
        lastBatchSkipped = skipped;
      }

      if (progress.finished || progress.canceled || now - lastMetaPersistAt >= metaPersistIntervalMs) {
        await this.jobs.mergeJobMeta(jobId, {
          storeImportProgress: snapshot,
          storeImportMetrics: {
            updatedAt: snapshot.updatedAt,
            elapsedMs,
            ratePerSecond,
            etaSeconds,
            runProcessed,
            runImported,
            runFailed,
            runSkipped,
            totalProcessed: processed,
            totalImported: imported,
            totalFailed: failed,
            totalSkipped: skipped,
            lastBatch: batchSummary
          }
        });
        lastMetaPersistAt = now;
      }
    };
  }

  private async runStandaloneStep<T>(
    type:
      | 'import_all'
      | 'import_source'
      | 'import_supplier'
      | 'finalize'
      | 'store_import'
      | 'cleanup'
      | 'store_mirror_sync',
    meta: Record<string, unknown>,
    action: (jobId: number) => Promise<T>
  ): Promise<JobRunnerResult<T>> {
    await this.ensureNoRunningJobs();
    const job = await this.jobs.createJob(type, meta);
    let lockAcquired = false;
    try {
      lockAcquired = await this.jobs.acquireJobLock(job.id);
      if (!lockAcquired) {
        throw new JobConflictError('Another job is running');
      }
      await this.jobs.startJob(job.id);
      await this.logs.log(job.id, 'info', `${type} started`, meta);
      const result = await action(job.id);
      await this.jobs.finishJob(job.id);
      await this.logs.log(job.id, 'info', `${type} finished`, summarizeStepResult(type, result));
      return {
        jobId: job.id,
        result
      };
    } catch (err) {
      await this.jobs.failJob(job.id, err);
      await this.logs.log(job.id, 'error', `${type} failed`, {
        error: err instanceof Error ? err.message : String(err)
      });
      throw err;
    } finally {
      if (lockAcquired) {
        await this.jobs.releaseJobLock(job.id);
      }
    }
  }

  private async runChildStep<T>(
    pipelineJobId: number,
    type: 'store_mirror_sync' | 'import_all' | 'finalize' | 'store_import',
    meta: Record<string, unknown>,
    action: (jobId: number) => Promise<T>
  ): Promise<ChildStepResult<T>> {
    const childMeta: Record<string, unknown> = {
      ...meta,
      pipeline_job_id: pipelineJobId
    };
    const job = await this.jobs.createJob(type, childMeta);
    try {
      await this.jobs.startJob(job.id);
      await this.logs.log(job.id, 'info', `${type} started`, childMeta);
      const result = await action(job.id);
      await this.jobs.finishJob(job.id);
      await this.logs.log(job.id, 'info', `${type} finished`, summarizeStepResult(type, result));
      return { job, result };
    } catch (err) {
      await this.jobs.failJob(job.id, err);
      await this.logs.log(job.id, 'error', `${type} failed`, {
        error: err instanceof Error ? err.message : String(err),
        pipelineJobId
      });
      throw err;
    }
  }

  runImportAll(): Promise<JobRunnerResult<ImportSummary>> {
    return this.runStandaloneStep('import_all', {}, (jobId) => this.pipeline.runImportAll(jobId));
  }

  /**
   * Fire-and-forget variant: creates + starts the job, returns jobId immediately.
   * The import runs in the background; progress is persisted via mergeJobMeta every source.
   * The caller must attach .catch(() => undefined) to bgPromise (belt-and-suspenders).
   */
  async startImportAllAsync(): Promise<{ jobId: number; bgPromise: Promise<void> }> {
    await this.ensureNoRunningJobs();
    const job = await this.jobs.createJob('import_all', {});
    let lockAcquired = false;
    try {
      lockAcquired = await this.jobs.acquireJobLock(job.id);
      if (!lockAcquired) {
        throw new JobConflictError('Another job is running');
      }
      await this.jobs.startJob(job.id);
      await this.logs.log(job.id, 'info', 'import_all started', {});
    } catch (err) {
      await this.jobs.failJob(job.id, err);
      if (lockAcquired) {
        await this.jobs.releaseJobLock(job.id);
      }
      throw err;
    }

    const onProgress = async (progress: { completed: number; total: number }): Promise<void> => {
      await this.jobs.mergeJobMeta(job.id, { progress });
    };

    const bgPromise: Promise<void> = this.pipeline
      .runImportAll(job.id, { onProgress })
      .then(async (result) => {
        await this.jobs.finishJob(job.id);
        await this.logs.log(job.id, 'info', 'import_all finished', result);
      })
      .catch(async (err) => {
        await this.jobs.failJob(job.id, err);
        await this.logs.log(job.id, 'error', 'import_all failed', {
          error: err instanceof Error ? err.message : String(err)
        });
      })
      .finally(async () => {
        await this.jobs.releaseJobLock(job.id).catch(() => undefined);
      });

    return { jobId: job.id, bgPromise };
  }

  /**
   * Fire-and-forget variant for finalize: returns jobId immediately.
   */
  async startFinalizeAsync(): Promise<{ jobId: number; bgPromise: Promise<void> }> {
    await this.ensureNoRunningJobs();
    const job = await this.jobs.createJob('finalize', {});
    let lockAcquired = false;
    try {
      lockAcquired = await this.jobs.acquireJobLock(job.id);
      if (!lockAcquired) {
        throw new JobConflictError('Another job is running');
      }
      await this.jobs.startJob(job.id);
      await this.logs.log(job.id, 'info', 'finalize started', {});
    } catch (err) {
      await this.jobs.failJob(job.id, err);
      if (lockAcquired) {
        await this.jobs.releaseJobLock(job.id);
      }
      throw err;
    }

    const bgPromise: Promise<void> = this.pipeline
      .runFinalize(job.id)
      .then(async (result) => {
        await this.jobs.finishJob(job.id);
        await this.logs.log(job.id, 'info', 'finalize finished', result);
      })
      .catch(async (err) => {
        await this.jobs.failJob(job.id, err);
        await this.logs.log(job.id, 'error', 'finalize failed', {
          error: err instanceof Error ? err.message : String(err)
        });
      })
      .finally(async () => {
        await this.jobs.releaseJobLock(job.id).catch(() => undefined);
      });

    return { jobId: job.id, bgPromise };
  }

  runImportSource(sourceId: number): Promise<JobRunnerResult<SourceImportSummary>> {
    const normalizedSourceId = Math.trunc(Number(sourceId));
    if (!Number.isFinite(normalizedSourceId) || normalizedSourceId <= 0) {
      throw this.createBadRequest('sourceId must be a positive number');
    }
    return this.runStandaloneStep('import_source', { sourceId: normalizedSourceId }, (jobId) =>
      this.pipeline.runImportSource(jobId, normalizedSourceId)
    );
  }

  runImportSupplier(supplierId: number): Promise<JobRunnerResult<SourceImportSummary>> {
    const normalizedSupplierId = Math.trunc(Number(supplierId));
    if (!Number.isFinite(normalizedSupplierId) || normalizedSupplierId <= 0) {
      throw this.createBadRequest('supplierId must be a positive number');
    }
    return this.runStandaloneStep(
      'import_supplier',
      { supplierId: normalizedSupplierId },
      (jobId) => this.pipeline.runImportSupplier(jobId, normalizedSupplierId)
    );
  }

  runFinalize(): Promise<JobRunnerResult<FinalizeSummary>> {
    return this.runStandaloneStep('finalize', {}, (jobId) => this.pipeline.runFinalize(jobId));
  }

  async runStoreImport(
    supplier: string | null,
    options?: StoreImportRunOptions
  ): Promise<JobRunnerResult<StoreImportExecution<MappedRow>>> {
    const resume = await this.resolveStoreImportResume(supplier, options);
    const meta: Record<string, unknown> = supplier ? { supplier } : {};
    if (resume) {
      meta.resumeFromJobId = resume.resumeFromJobId;
      meta.resumeProcessed = resume.resumeProcessed;
    }
    return this.runStandaloneStep('store_import', meta, async (jobId) => {
      const onProgress = this.createStoreImportProgressReporter(jobId);
      return this.pipeline.runStoreImport(jobId, supplier, {
        jobId,
        isCanceled: () => this.isJobCanceled(jobId),
        resumeProcessed: resume?.resumeProcessed || 0,
        onProgress
      });
    });
  }

  runCleanup(retentionDays: number): Promise<JobRunnerResult<CleanupSummary>> {
    const safeRetention = Number.isFinite(retentionDays)
      ? Math.max(1, Math.trunc(retentionDays))
      : 10;
    return this.runStandaloneStep(
      'cleanup',
      { retentionDays: safeRetention },
      async (_jobId) => this.cleanupService.run(safeRetention)
    );
  }

  runStoreMirrorSync(): Promise<JobRunnerResult<StoreMirrorSyncSummary & { fetched: number; pages: number }>> {
    const store = this.pipeline.store;
    return this.runStandaloneStep(
      'store_mirror_sync',
      { store },
      async (_jobId) => {
        const seenAt = this.storeMirrorService.createSyncMarker();
        let upserted = 0;
        const snapshot = await this.pipeline.forEachStoreMirrorPage(async (items) => {
          upserted += await this.storeMirrorService.upsertSnapshotChunk(store, items, seenAt);
        });
        const deleted = await this.storeMirrorService.pruneSnapshot(store, seenAt);
        return {
          store,
          upserted,
          deleted,
          fetched: snapshot.fetched,
          pages: snapshot.pages
        };
      }
    );
  }

  async runUpdatePipeline(
    supplier: string | null
  ): Promise<JobRunnerResult<UpdatePipelineSummary<MappedRow>>> {
    await this.ensureNoRunningJobs();
    const meta = supplier ? { supplier } : {};
    const parent = await this.jobs.createJob('update_pipeline', meta);
    let lockAcquired = false;
    try {
      lockAcquired = await this.jobs.acquireJobLock(parent.id);
      if (!lockAcquired) {
        throw new JobConflictError('Another job is running');
      }

      await this.jobs.startJob(parent.id);
      await this.logs.log(parent.id, 'info', 'update_pipeline started', meta);

      const store = this.pipeline.store;
      const mirrorStep = await this.runChildStep(
        parent.id,
        'store_mirror_sync',
        { store },
        async (_jobId) => {
          const seenAt = this.storeMirrorService.createSyncMarker();
          let upserted = 0;
          const snapshot = await this.pipeline.forEachStoreMirrorPage(async (items) => {
            upserted += await this.storeMirrorService.upsertSnapshotChunk(store, items, seenAt);
          });
          const deleted = await this.storeMirrorService.pruneSnapshot(store, seenAt);
          return { store, upserted, deleted, fetched: snapshot.fetched, pages: snapshot.pages };
        }
      );

      const importStep = await this.runChildStep(parent.id, 'import_all', {}, (jobId) =>
        this.pipeline.runImportAll(jobId)
      );
      const finalizeStep = await this.runChildStep(parent.id, 'finalize', {}, (jobId) =>
        this.pipeline.runFinalize(jobId)
      );
      const storeStep = await this.runChildStep(
        parent.id,
        'store_import',
        supplier ? { supplier } : {},
        (jobId) => {
          const onProgress = this.createStoreImportProgressReporter(jobId);
          return this.pipeline.runStoreImport(jobId, supplier, {
            jobId,
            isCanceled: () => this.isJobCanceled(jobId),
            onProgress
          });
        }
      );

      const result: UpdatePipelineSummary<MappedRow> = {
        mirrorSyncSummary: mirrorStep.result,
        importSummary: importStep.result,
        finalizeSummary: finalizeStep.result,
        storeExecution: storeStep.result
      };
      await this.jobs.finishJob(parent.id);
      await this.logs.log(parent.id, 'info', 'update_pipeline finished', {
        mirrorSyncJobId: mirrorStep.job.id,
        importJobId: importStep.job.id,
        finalizeJobId: finalizeStep.job.id,
        storeImportJobId: storeStep.job.id,
        supplier,
        summary: {
          mirrorSyncSummary: result.mirrorSyncSummary,
          importSummary: result.importSummary,
          finalizeSummary: result.finalizeSummary,
          storeExecution: summarizeStoreImportResult(result.storeExecution)
        }
      });

      return {
        jobId: parent.id,
        result
      };
    } catch (err) {
      await this.jobs.failJob(parent.id, err);
      await this.logs.log(parent.id, 'error', 'update_pipeline failed', {
        error: err instanceof Error ? err.message : String(err),
        supplier
      });
      throw err;
    } finally {
      if (lockAcquired) {
        await this.jobs.releaseJobLock(parent.id);
      }
    }
  }
}
