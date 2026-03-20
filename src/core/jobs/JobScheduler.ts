import { LogService, type LogLevel } from '../pipeline/log';

export type SchedulerTaskName = 'update_pipeline' | 'store_mirror_sync' | 'cleanup';

export interface SchedulerTask {
  name: SchedulerTaskName;
  enabled: boolean;
  intervalMs: number;
  runOnStartup: boolean;
  action: () => Promise<{ jobId?: number } | void>;
}

export interface JobSchedulerOptions {
  enabled: boolean;
  tickIntervalMs: number;
  logService: LogService;
  tasks: SchedulerTask[];
}

function readErrorStatus(error: unknown): number | null {
  if (typeof error === 'object' && error !== null && Number.isFinite((error as any).status)) {
    return Number((error as any).status);
  }
  return null;
}

function readErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error);
}

export class JobScheduler {
  private readonly enabled: boolean;

  private readonly tickIntervalMs: number;

  private readonly tasks: SchedulerTask[];

  private readonly logService: LogService;

  private readonly nextRunByTask = new Map<SchedulerTaskName, number>();

  private readonly runningTasks = new Set<SchedulerTaskName>();

  private timer: NodeJS.Timeout | null = null;

  private started = false;

  private tickInFlight = false;

  constructor(options: JobSchedulerOptions) {
    this.enabled = options.enabled;
    this.tickIntervalMs = Math.max(1000, Math.trunc(options.tickIntervalMs));
    this.tasks = options.tasks.map((task) => ({
      ...task,
      intervalMs: Math.max(60000, Math.trunc(task.intervalMs))
    }));
    this.logService = options.logService;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  start(): void {
    if (!this.enabled || this.started) {
      return;
    }

    this.started = true;
    const now = Date.now();
    for (let index = 0; index < this.tasks.length; index += 1) {
      const task = this.tasks[index];
      if (!task.enabled) {
        continue;
      }
      const nextRunAt = task.runOnStartup ? now : now + task.intervalMs;
      this.nextRunByTask.set(task.name, nextRunAt);
    }

    this.timer = setInterval(() => {
      void this.tick();
    }, this.tickIntervalMs);

    void this.safeLog('info', 'Scheduler started', {
      tickIntervalMs: this.tickIntervalMs,
      tasks: this.tasks
        .filter((task) => task.enabled)
        .map((task) => ({
          name: task.name,
          intervalMs: task.intervalMs,
          runOnStartup: task.runOnStartup
        }))
    });

    void this.tick();
  }

  stop(): void {
    if (!this.started) {
      return;
    }
    this.started = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    void this.safeLog('info', 'Scheduler stopped');
  }

  private async tick(): Promise<void> {
    if (!this.started || this.tickInFlight) {
      return;
    }

    this.tickInFlight = true;
    try {
      const now = Date.now();
      for (let index = 0; index < this.tasks.length; index += 1) {
        const task = this.tasks[index];
        if (!task.enabled) {
          continue;
        }
        const nextRunAt = this.nextRunByTask.get(task.name);
        if (typeof nextRunAt !== 'number' || now < nextRunAt) {
          continue;
        }
        // eslint-disable-next-line no-await-in-loop
        await this.runTask(task);
      }
    } finally {
      this.tickInFlight = false;
    }
  }

  private async runTask(task: SchedulerTask): Promise<void> {
    if (this.runningTasks.has(task.name)) {
      return;
    }

    this.runningTasks.add(task.name);
    const startedAt = Date.now();
    await this.safeLog('info', 'Scheduler task started', { task: task.name });

    try {
      const result = await task.action();
      await this.safeLog('info', 'Scheduler task finished', {
        task: task.name,
        durationMs: Date.now() - startedAt,
        jobId:
          result && typeof result === 'object' && Number.isFinite((result as any).jobId)
            ? Number((result as any).jobId)
            : null
      });
    } catch (error) {
      const status = readErrorStatus(error);
      if (status === 409) {
        await this.safeLog('warning', 'Scheduler task skipped by active lock', {
          task: task.name,
          status,
          error: readErrorMessage(error)
        });
      } else {
        await this.safeLog('error', 'Scheduler task failed', {
          task: task.name,
          status,
          error: readErrorMessage(error)
        });
      }
    } finally {
      this.runningTasks.delete(task.name);
      this.nextRunByTask.set(task.name, Date.now() + task.intervalMs);
    }
  }

  private async safeLog(level: LogLevel, message: string, data?: unknown): Promise<void> {
    try {
      await this.logService.log(null, level, message, data);
    } catch (_error) {
      // ignore scheduler log errors, scheduler itself must stay alive
    }
  }
}
