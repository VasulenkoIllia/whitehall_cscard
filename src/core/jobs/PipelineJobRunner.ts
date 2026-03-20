import { PipelineOrchestrator } from '../pipeline/PipelineOrchestrator';
import { LogService } from '../pipeline/log';
import type {
  FinalizeSummary,
  ImportSummary,
  StoreImportExecution,
  UpdatePipelineSummary
} from '../pipeline/contracts';
import { JobService, type JobRecord } from './JobService';

const BLOCKING_JOB_TYPES = ['update_pipeline', 'import_all', 'finalize', 'store_import'];

interface JobRunnerResult<T> {
  jobId: number;
  result: T;
}

interface ChildStepResult<T> {
  job: JobRecord;
  result: T;
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
    private readonly logs: LogService
  ) {}

  private async ensureNoRunningJobs(): Promise<void> {
    const running = await this.jobs.findRunningJobs(BLOCKING_JOB_TYPES);
    if (running.length > 0) {
      throw new JobConflictError(
        `Another job is running: #${running[0].id} (${running[0].type})`
      );
    }
  }

  private async runStandaloneStep<T>(
    type: 'import_all' | 'finalize' | 'store_import',
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
      await this.logs.log(job.id, 'info', `${type} finished`, result);
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
      await this.logs.log(job.id, 'info', `${type} finished`, result);
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
      this.pipeline.runStoreImport(jobId, supplier)
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
        (jobId) => this.pipeline.runStoreImport(jobId, supplier)
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
        summary: result
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
