import type { Pool } from 'pg';
import type {
  SchedulerTaskName,
  SchedulerTaskSnapshot,
  SchedulerTaskUpdate
} from './JobScheduler';
import { JobScheduler } from './JobScheduler';

export interface SchedulerRuntimeState {
  updatePipelineSupplier: string | null;
}

interface CronSettingRow {
  name: SchedulerTaskName;
  cron: string | null;
  interval_minutes: number;
  is_enabled: boolean;
  run_on_startup: boolean;
  meta: Record<string, unknown> | null;
  updated_at: string;
}

const ALLOWED_TASK_NAMES: SchedulerTaskName[] = [
  'update_pipeline',
  'store_mirror_sync',
  'cleanup'
];

function normalizeMeta(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function parseSupplier(value: unknown): string | null {
  const normalized = String(value || '').trim();
  return normalized || null;
}

function intervalMinutesToCron(intervalMinutes: number): string {
  const minutes = Math.max(1, Math.trunc(intervalMinutes));
  if (minutes < 60) {
    return `*/${minutes} * * * *`;
  }
  if (minutes % 60 === 0) {
    const hours = Math.max(1, Math.trunc(minutes / 60));
    if (hours <= 23) {
      return `0 */${hours} * * *`;
    }
    return '0 0 * * *';
  }
  return `*/${minutes} * * * *`;
}

function cronToIntervalMinutes(cron: string): number | null {
  const normalized = String(cron || '').trim();
  if (!normalized) {
    return null;
  }

  const everyMinutes = normalized.match(/^\*\/(\d+)\s+\*\s+\*\s+\*\s+\*$/);
  if (everyMinutes) {
    const value = Number(everyMinutes[1]);
    if (Number.isFinite(value) && value > 0) {
      return Math.trunc(value);
    }
  }

  const everyHours = normalized.match(/^0\s+\*\/(\d+)\s+\*\s+\*\s+\*$/);
  if (everyHours) {
    const hours = Number(everyHours[1]);
    if (Number.isFinite(hours) && hours > 0) {
      return Math.trunc(hours * 60);
    }
  }

  const onceDaily = normalized.match(/^(\d+)\s+(\d+)\s+\*\s+\*\s+\*$/);
  if (onceDaily) {
    return 24 * 60;
  }

  const multiDaily = normalized.match(/^(\d+)\s+(\d+(?:,\d+)+)\s+\*\s+\*\s+\*$/);
  if (multiDaily) {
    return 24 * 60;
  }

  const weeklyHours = normalized.match(/^(\d+)\s+(\d+(?:,\d+)*)\s+\*\s+\*\s+(\d+(?:,\d+)*)$/);
  if (weeklyHours) {
    return 24 * 60;
  }

  return null;
}

function buildRowPayload(
  row: CronSettingRow
): Record<string, unknown> {
  return {
    name: row.name,
    cron: row.cron || intervalMinutesToCron(row.interval_minutes),
    interval_minutes: row.interval_minutes,
    is_enabled: row.is_enabled,
    run_on_startup: row.run_on_startup,
    meta: normalizeMeta(row.meta),
    updated_at: row.updated_at
  };
}

export class SchedulerSettingsService {
  constructor(
    private readonly pool: Pool,
    private readonly scheduler: JobScheduler,
    private readonly runtimeState: SchedulerRuntimeState
  ) {}

  private async ensureTable(): Promise<void> {
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS cron_settings (
         name TEXT PRIMARY KEY,
         cron TEXT,
         interval_minutes INT NOT NULL DEFAULT 60,
         is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
         run_on_startup BOOLEAN NOT NULL DEFAULT FALSE,
         meta JSONB NOT NULL DEFAULT '{}'::jsonb,
         updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )`
    );
    await this.pool.query(
      `ALTER TABLE cron_settings
       ADD COLUMN IF NOT EXISTS cron TEXT`
    );
    await this.pool.query(
      `ALTER TABLE cron_settings
       ADD COLUMN IF NOT EXISTS interval_minutes INT NOT NULL DEFAULT 60`
    );
    await this.pool.query(
      `ALTER TABLE cron_settings
       ADD COLUMN IF NOT EXISTS run_on_startup BOOLEAN NOT NULL DEFAULT FALSE`
    );
    await this.pool.query(
      `ALTER TABLE cron_settings
       ADD COLUMN IF NOT EXISTS meta JSONB NOT NULL DEFAULT '{}'::jsonb`
    );
    await this.pool.query(
      `ALTER TABLE cron_settings
       ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
    );
  }

  private async loadRows(): Promise<CronSettingRow[]> {
    const result = await this.pool.query<CronSettingRow>(
      `SELECT
         name,
         cron,
         interval_minutes,
         is_enabled,
         run_on_startup,
         meta,
         updated_at::text AS updated_at
       FROM cron_settings
       WHERE name = ANY($1::text[])
       ORDER BY name ASC`,
      [ALLOWED_TASK_NAMES]
    );
    return result.rows;
  }

  private async seedDefaultsIfMissing(): Promise<void> {
    const snapshots = this.scheduler.getTaskSnapshots();
    for (let index = 0; index < snapshots.length; index += 1) {
      const snapshot = snapshots[index];
      const meta: Record<string, unknown> = {};
      if (snapshot.name === 'update_pipeline' && this.runtimeState.updatePipelineSupplier) {
        meta.supplier = this.runtimeState.updatePipelineSupplier;
      }
      const cron = intervalMinutesToCron(snapshot.intervalMinutes);
      // eslint-disable-next-line no-await-in-loop
      await this.pool.query(
        `INSERT INTO cron_settings
           (name, cron, interval_minutes, is_enabled, run_on_startup, meta, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         ON CONFLICT (name) DO NOTHING`,
        [
          snapshot.name,
          cron,
          snapshot.intervalMinutes,
          snapshot.enabled,
          snapshot.runOnStartup,
          meta
        ]
      );
    }
  }

  private async applyRows(rows: CronSettingRow[]): Promise<void> {
    const updates: SchedulerTaskUpdate[] = rows.map((row) => ({
      name: row.name,
      enabled: row.is_enabled === true,
      intervalMinutes: Number.isFinite(Number(row.interval_minutes))
        ? Math.max(1, Math.trunc(Number(row.interval_minutes)))
        : 60,
      cron: String(row.cron || '').trim() || null,
      runOnStartup: row.run_on_startup === true
    }));
    await this.scheduler.updateTasks(updates);

    const updatePipeline = rows.find((row) => row.name === 'update_pipeline') || null;
    if (updatePipeline) {
      const meta = normalizeMeta(updatePipeline.meta);
      this.runtimeState.updatePipelineSupplier = parseSupplier(meta.supplier);
    }
  }

  async initialize(): Promise<void> {
    await this.ensureTable();
    await this.seedDefaultsIfMissing();
    const rows = await this.loadRows();
    await this.applyRows(rows);
  }

  async listSettings(): Promise<Record<string, unknown>[]> {
    await this.ensureTable();
    await this.seedDefaultsIfMissing();
    const rows = await this.loadRows();
    return rows.map((row) => buildRowPayload(row));
  }

  async updateSettings(settings: unknown): Promise<Record<string, unknown>[]> {
    if (!Array.isArray(settings)) {
      const error = new Error('settings array is required');
      (error as any).status = 400;
      throw error;
    }

    await this.ensureTable();
    await this.seedDefaultsIfMissing();
    const currentRows = await this.loadRows();
    const byName = new Map<SchedulerTaskName, CronSettingRow>();
    for (let index = 0; index < currentRows.length; index += 1) {
      const row = currentRows[index];
      byName.set(row.name, row);
    }

    for (let index = 0; index < settings.length; index += 1) {
      const raw = settings[index];
      if (!raw || typeof raw !== 'object') {
        continue;
      }
      const input = raw as Record<string, unknown>;
      const name = String(input.name || '').trim() as SchedulerTaskName;
      if (ALLOWED_TASK_NAMES.indexOf(name) === -1) {
        continue;
      }

      const existing = byName.get(name);
      if (!existing) {
        continue;
      }

      const cronInput = String(input.cron || '').trim();
      const intervalInput = Number(input.interval_minutes);
      const parsedFromCron = cronInput ? cronToIntervalMinutes(cronInput) : null;

      const intervalMinutes =
        Number.isFinite(intervalInput) && intervalInput > 0
          ? Math.trunc(intervalInput)
          : parsedFromCron && parsedFromCron > 0
            ? parsedFromCron
            : Math.max(1, Math.trunc(Number(existing.interval_minutes || 60)));

      const isEnabled =
        typeof input.is_enabled === 'boolean'
          ? input.is_enabled
          : existing.is_enabled === true;
      const runOnStartup =
        typeof input.run_on_startup === 'boolean'
          ? input.run_on_startup
          : existing.run_on_startup === true;

      const meta = normalizeMeta(
        Object.prototype.hasOwnProperty.call(input, 'meta') ? input.meta : existing.meta
      );
      if (name === 'update_pipeline') {
        const supplierFromInput = parseSupplier(
          Object.prototype.hasOwnProperty.call(input, 'supplier')
            ? input.supplier
            : meta.supplier
        );
        if (supplierFromInput) {
          meta.supplier = supplierFromInput;
        } else {
          delete meta.supplier;
        }
      }

      const cronValue = cronInput || intervalMinutesToCron(intervalMinutes);

      // eslint-disable-next-line no-await-in-loop
      await this.pool.query(
        `INSERT INTO cron_settings
           (name, cron, interval_minutes, is_enabled, run_on_startup, meta, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         ON CONFLICT (name)
         DO UPDATE SET
           cron = EXCLUDED.cron,
           interval_minutes = EXCLUDED.interval_minutes,
           is_enabled = EXCLUDED.is_enabled,
           run_on_startup = EXCLUDED.run_on_startup,
           meta = EXCLUDED.meta,
           updated_at = NOW()`,
        [name, cronValue, intervalMinutes, isEnabled, runOnStartup, meta]
      );
    }

    const rows = await this.loadRows();
    await this.applyRows(rows);
    return rows.map((row) => buildRowPayload(row));
  }

  getRuntimeState(): SchedulerRuntimeState {
    return {
      updatePipelineSupplier: this.runtimeState.updatePipelineSupplier
    };
  }

  getSchedulerTasks(): SchedulerTaskSnapshot[] {
    return this.scheduler.getTaskSnapshots();
  }
}
