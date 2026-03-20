import { PipelineOrchestrator } from '../pipeline/PipelineOrchestrator';
import { LogService } from '../pipeline/log';
import type {
  FinalizeSummary,
  ImportSummary,
  StoreImportExecution,
  UpdatePipelineSummary
} from '../pipeline/contracts';
import { JobService, type JobRecord } from './JobService';
import type { CleanupService, CleanupSummary } from './CleanupService';
import type { StoreMirrorService, StoreMirrorSyncSummary } from './StoreMirrorService';

const BLOCKING_JOB_TYPES = [
  'update_pipeline',
  'import_all',
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
  type: 'import_all' | 'finalize' | 'store_import' | 'cleanup' | 'store_mirror_sync',
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

  private async runStandaloneStep<T>(
    type: 'import_all' | 'finalize' | 'store_import' | 'cleanup' | 'store_mirror_sync',
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
    type: 'import_all' | 'finalize' | 'store_import',
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

  runFinalize(): Promise<JobRunnerResult<FinalizeSummary>> {
    return this.runStandaloneStep('finalize', {}, (jobId) => this.pipeline.runFinalize(jobId));
  }

  runStoreImport(
    supplier: string | null
  ): Promise<JobRunnerResult<StoreImportExecution<MappedRow>>> {
    const meta = supplier ? { supplier } : {};
    return this.runStandaloneStep('store_import', meta, (jobId) =>
      this.pipeline.runStoreImport(jobId, supplier, {
        jobId,
        isCanceled: () => this.isJobCanceled(jobId)
      })
    );
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
        (jobId) =>
          this.pipeline.runStoreImport(jobId, supplier, {
            jobId,
            isCanceled: () => this.isJobCanceled(jobId)
          })
      );

      const result: UpdatePipelineSummary<MappedRow> = {
        importSummary: importStep.result,
        finalizeSummary: finalizeStep.result,
        storeExecution: storeStep.result
      };
      await this.jobs.finishJob(parent.id);
      await this.logs.log(parent.id, 'info', 'update_pipeline finished', {
        importJobId: importStep.job.id,
        finalizeJobId: finalizeStep.job.id,
        storeImportJobId: storeStep.job.id,
        supplier,
        summary: {
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
