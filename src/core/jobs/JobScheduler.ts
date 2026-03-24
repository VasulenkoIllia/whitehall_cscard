import { LogService, type LogLevel } from '../pipeline/log';

export type SchedulerTaskName = 'update_pipeline' | 'store_mirror_sync' | 'cleanup';

export interface SchedulerTask {
  name: SchedulerTaskName;
  enabled: boolean;
  intervalMs: number;
  cron: string | null;
  runOnStartup: boolean;
  action: () => Promise<{ jobId?: number } | void>;
}

export interface SchedulerTaskSnapshot {
  name: SchedulerTaskName;
  enabled: boolean;
  intervalMinutes: number;
  cron: string | null;
  runOnStartup: boolean;
}

export interface SchedulerTaskUpdate {
  name: SchedulerTaskName;
  enabled?: boolean;
  intervalMinutes?: number;
  cron?: string | null;
  runOnStartup?: boolean;
}

export interface JobSchedulerOptions {
  enabled: boolean;
  tickIntervalMs: number;
  logService: LogService;
  tasks: SchedulerTask[];
}

interface ParsedCron {
  minute: Set<number> | null;
  hour: Set<number> | null;
  dayOfMonth: Set<number> | null;
  month: Set<number> | null;
  dayOfWeek: Set<number> | null;
}

function parseInteger(value: string): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Math.trunc(parsed);
}

function normalizeDayOfWeek(value: number): number {
  if (value === 7) {
    return 0;
  }
  return value;
}

function parseCronField(
  tokenRaw: string,
  min: number,
  max: number,
  normalize?: (value: number) => number
): Set<number> | null {
  const token = String(tokenRaw || '').trim();
  if (!token || token === '*') {
    return null;
  }
  const set = new Set<number>();
  const parts = token.split(',');
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index].trim();
    if (!part) {
      return null;
    }
    const applyValue = (valueRaw: number) => {
      const value = typeof normalize === 'function' ? normalize(valueRaw) : valueRaw;
      if (value < min || value > max) {
        return false;
      }
      set.add(value);
      return true;
    };

    if (part.includes('/')) {
      const [baseRaw, stepRaw] = part.split('/');
      const step = parseInteger(stepRaw);
      if (!step || step <= 0) {
        return null;
      }

      let rangeStart = min;
      let rangeEnd = max;
      const base = String(baseRaw || '').trim();
      if (base && base !== '*') {
        if (base.includes('-')) {
          const [startRaw, endRaw] = base.split('-');
          const start = parseInteger(startRaw);
          const end = parseInteger(endRaw);
          if (start === null || end === null || start > end) {
            return null;
          }
          rangeStart = start;
          rangeEnd = end;
        } else {
          const start = parseInteger(base);
          if (start === null) {
            return null;
          }
          rangeStart = start;
          rangeEnd = max;
        }
      }

      for (let value = rangeStart; value <= rangeEnd; value += step) {
        if (!applyValue(value)) {
          return null;
        }
      }
      continue;
    }

    if (part.includes('-')) {
      const [startRaw, endRaw] = part.split('-');
      const start = parseInteger(startRaw);
      const end = parseInteger(endRaw);
      if (start === null || end === null || start > end) {
        return null;
      }
      for (let value = start; value <= end; value += 1) {
        if (!applyValue(value)) {
          return null;
        }
      }
      continue;
    }

    const value = parseInteger(part);
    if (value === null || !applyValue(value)) {
      return null;
    }
  }

  return set.size > 0 ? set : null;
}

function parseCronExpression(cronRaw: string): ParsedCron | null {
  const cron = String(cronRaw || '').trim();
  if (!cron) {
    return null;
  }
  const parts = cron.split(/\s+/);
  if (parts.length !== 5) {
    return null;
  }

  const minute = parseCronField(parts[0], 0, 59);
  const hour = parseCronField(parts[1], 0, 23);
  const dayOfMonth = parseCronField(parts[2], 1, 31);
  const month = parseCronField(parts[3], 1, 12);
  const dayOfWeek = parseCronField(parts[4], 0, 6, normalizeDayOfWeek);

  if (
    parts[0] !== '*' && minute === null ||
    parts[1] !== '*' && hour === null ||
    parts[2] !== '*' && dayOfMonth === null ||
    parts[3] !== '*' && month === null ||
    parts[4] !== '*' && dayOfWeek === null
  ) {
    return null;
  }

  return {
    minute,
    hour,
    dayOfMonth,
    month,
    dayOfWeek
  };
}

function matchesCronAt(parsed: ParsedCron, date: Date): boolean {
  const minute = date.getMinutes();
  const hour = date.getHours();
  const dayOfMonth = date.getDate();
  const month = date.getMonth() + 1;
  const dayOfWeek = date.getDay();

  if (parsed.minute && !parsed.minute.has(minute)) {
    return false;
  }
  if (parsed.hour && !parsed.hour.has(hour)) {
    return false;
  }
  if (parsed.month && !parsed.month.has(month)) {
    return false;
  }

  const hasDom = !!parsed.dayOfMonth;
  const hasDow = !!parsed.dayOfWeek;
  if (hasDom && hasDow) {
    if (!parsed.dayOfMonth!.has(dayOfMonth) && !parsed.dayOfWeek!.has(dayOfWeek)) {
      return false;
    }
  } else {
    if (hasDom && !parsed.dayOfMonth!.has(dayOfMonth)) {
      return false;
    }
    if (hasDow && !parsed.dayOfWeek!.has(dayOfWeek)) {
      return false;
    }
  }

  return true;
}

function findNextRunByCron(parsed: ParsedCron, afterTimestampMs: number): number | null {
  const MAX_MINUTES_LOOKAHEAD = 60 * 24 * 370;
  const rounded = Math.trunc(afterTimestampMs / 60000) * 60000;
  let timestamp = rounded <= afterTimestampMs ? rounded + 60000 : rounded;
  for (let index = 0; index < MAX_MINUTES_LOOKAHEAD; index += 1) {
    const date = new Date(timestamp);
    if (matchesCronAt(parsed, date)) {
      return timestamp;
    }
    timestamp += 60000;
  }
  return null;
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

  private readonly parsedCronByTask = new Map<SchedulerTaskName, ParsedCron | null>();

  private timer: NodeJS.Timeout | null = null;

  private started = false;

  private tickInFlight = false;

  constructor(options: JobSchedulerOptions) {
    this.enabled = options.enabled;
    this.tickIntervalMs = Math.max(1000, Math.trunc(options.tickIntervalMs));
    this.tasks = options.tasks.map((task) => ({
      ...task,
      intervalMs: Math.max(60000, Math.trunc(task.intervalMs)),
      cron: String(task.cron || '').trim() || null
    }));
    this.logService = options.logService;
    for (let index = 0; index < this.tasks.length; index += 1) {
      const task = this.tasks[index];
      this.parsedCronByTask.set(task.name, parseCronExpression(String(task.cron || '')));
    }
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
      const nextRunAt = task.runOnStartup ? now : this.resolveNextRunAt(task, now);
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
          cron: task.cron,
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
      this.nextRunByTask.set(task.name, this.resolveNextRunAt(task, Date.now()));
    }
  }

  private resolveNextRunAt(task: SchedulerTask, afterTimestampMs: number): number {
    const parsedCron = this.parsedCronByTask.get(task.name) || null;
    if (parsedCron) {
      const nextByCron = findNextRunByCron(parsedCron, afterTimestampMs);
      if (typeof nextByCron === 'number' && Number.isFinite(nextByCron)) {
        return nextByCron;
      }
    }
    return afterTimestampMs + task.intervalMs;
  }

  getTaskSnapshots(): SchedulerTaskSnapshot[] {
    return this.tasks.map((task) => ({
      name: task.name,
      enabled: task.enabled,
      intervalMinutes: Math.max(1, Math.trunc(task.intervalMs / 60000)),
      cron: task.cron,
      runOnStartup: task.runOnStartup
    }));
  }

  async updateTasks(updates: SchedulerTaskUpdate[]): Promise<SchedulerTaskSnapshot[]> {
    if (!Array.isArray(updates) || updates.length === 0) {
      return this.getTaskSnapshots();
    }

    const byName = new Map<SchedulerTaskName, SchedulerTask>();
    for (let index = 0; index < this.tasks.length; index += 1) {
      const task = this.tasks[index];
      byName.set(task.name, task);
    }

    const changed: string[] = [];
    for (let index = 0; index < updates.length; index += 1) {
      const update = updates[index];
      const task = byName.get(update.name);
      if (!task) {
        continue;
      }

      if (typeof update.enabled === 'boolean') {
        task.enabled = update.enabled;
      }
      if (
        Number.isFinite(update.intervalMinutes) &&
        Number(update.intervalMinutes) > 0
      ) {
        task.intervalMs = Math.max(60000, Math.trunc(Number(update.intervalMinutes) * 60000));
      }
      if (Object.prototype.hasOwnProperty.call(update, 'cron')) {
        const cron = String(update.cron || '').trim();
        task.cron = cron || null;
        this.parsedCronByTask.set(task.name, parseCronExpression(cron));
      }
      if (typeof update.runOnStartup === 'boolean') {
        task.runOnStartup = update.runOnStartup;
      }

      changed.push(task.name);
    }

    if (this.started) {
      const now = Date.now();
      for (let index = 0; index < this.tasks.length; index += 1) {
        const task = this.tasks[index];
        if (!task.enabled) {
          this.nextRunByTask.delete(task.name);
          continue;
        }
        this.nextRunByTask.set(task.name, this.resolveNextRunAt(task, now));
      }
    }

    if (changed.length > 0) {
      await this.safeLog('info', 'Scheduler tasks updated', {
        changed,
        snapshots: this.getTaskSnapshots()
      });
    }

    return this.getTaskSnapshots();
  }

  private async safeLog(level: LogLevel, message: string, data?: unknown): Promise<void> {
    try {
      await this.logService.log(null, level, message, data);
    } catch (_error) {
      // ignore scheduler log errors, scheduler itself must stay alive
    }
  }
}
