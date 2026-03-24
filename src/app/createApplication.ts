import { loadConfig } from '../core/config/loadConfig';
import type { AppConfig } from '../core/config/types';
import type { StoreConnector } from '../core/connectors/StoreConnector';
import type { CursorPage, MirrorRow, StoreImportResult } from '../core/domain/store';
import type {
  ExportPreviewProvider,
  Finalizer,
  SourceImporter
} from '../core/pipeline/contracts';
import { PipelineOrchestrator } from '../core/pipeline/PipelineOrchestrator';
import {
  HoroshopConnector,
  type HoroshopGateway,
  type HoroshopProductInput
} from '../connectors/horoshop/HoroshopConnector';
import { CsCartConnector, type CsCartImportRow } from '../connectors/cscart/CsCartConnector';
import { CsCartGateway as DefaultCsCartGateway } from '../connectors/cscart/CsCartGateway';
import { AuthService } from './auth/authService';
import { EnvUserStore } from './auth/envUserStore';
import { DbUserStore } from './auth/dbUserStore';
import { createPgPool } from '../core/db/pgClient';
import { FinalizerDb } from '../core/pipeline/finalizerDb';
import { ImporterDb } from '../core/pipeline/importerDb';
import { LogService } from '../core/pipeline/log';
import { createTelegramAlertServiceFromEnv } from '../core/alerts/TelegramAlertService';
import { ExportPreviewDb } from '../core/pipeline/exportPreviewDb';
import { JobService } from '../core/jobs/JobService';
import { PipelineJobRunner } from '../core/jobs/PipelineJobRunner';
import { CleanupService } from '../core/jobs/CleanupService';
import { StoreMirrorService } from '../core/jobs/StoreMirrorService';
import { JobScheduler } from '../core/jobs/JobScheduler';
import { SchedulerSettingsService } from '../core/jobs/SchedulerSettingsService';
import type { StoreImportBatch } from '../core/domain/store';
import { CatalogAdminService } from '../core/admin/CatalogAdminService';

const LEGACY_ROOT = '/Users/monstermac/WebstormProjects/whitehall.store_integration';

function createMigrationError(target: string, legacyPath: string): Error {
  return new Error(`${target} is not implemented yet. Port logic from ${legacyPath}`);
}

function createPgPoolOrThrow(databaseUrl: string) {
  return createPgPool(databaseUrl);
}

function createSourceImporter(
  pool: ReturnType<typeof createPgPoolOrThrow>,
  logService: LogService,
  priceAtImportEnabled: boolean
): SourceImporter {
  return new ImporterDb(pool, logService, priceAtImportEnabled);
}

function createFinalizer(pool: ReturnType<typeof createPgPoolOrThrow>, finalizeDeleteEnabled: boolean, priceAtImportEnabled: boolean): Finalizer {
  return new FinalizerDb(pool, {
    finalizeDeleteEnabled,
    priceAtImportEnabled
  });
}

function createPreviewProvider(pool: ReturnType<typeof createPgPoolOrThrow>): ExportPreviewProvider {
  return new ExportPreviewDb(pool);
}

function createHoroshopGateway(): HoroshopGateway {
  return {
    async fetchCatalogPage(): Promise<CursorPage<MirrorRow>> {
      throw createMigrationError(
        'Horoshop mirror gateway',
        `${LEGACY_ROOT}/src/services/horoshopService.js`
      );
    },
    async importCatalog(_rows: HoroshopProductInput[]): Promise<StoreImportResult> {
      throw createMigrationError(
        'Horoshop import gateway',
        `${LEGACY_ROOT}/src/services/horoshopService.js`
      );
    }
  };
}

function createConnector(config: AppConfig): StoreConnector<unknown> {
  if (config.base.activeStore === 'horoshop') {
    return new HoroshopConnector({
      visibilityYes: config.base.visibilityYes,
      exportLimit: config.connectors.horoshop.exportLimit,
      gateway: createHoroshopGateway(),
      rateLimitRps: Number(process.env.HOROSHOP_RATE_LIMIT_RPS || 5),
      rateLimitBurst: Number(process.env.HOROSHOP_RATE_LIMIT_BURST || 10)
    });
  }

  const csGateway = new DefaultCsCartGateway({
    baseUrl: config.connectors.cscart.baseUrl,
    apiUser: config.connectors.cscart.apiUser,
    apiKey: config.connectors.cscart.apiKey,
    itemsPerPage: config.connectors.cscart.itemsPerPage,
    rateLimitRps: config.connectors.cscart.rateLimitRps,
    rateLimitBurst: config.connectors.cscart.rateLimitBurst,
    allowCreate: config.connectors.cscart.allowCreate,
    importConcurrency: Number(process.env.CSCART_IMPORT_CONCURRENCY || 4)
  });

  return new CsCartConnector(csGateway);
}

function readEnvPositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.trunc(parsed);
}

function createImportBatchOptimizer(
  config: AppConfig,
  storeMirrorService: StoreMirrorService,
  env: Record<string, string | undefined>
): ((batch: StoreImportBatch<unknown>) => Promise<StoreImportBatch<unknown>>) | undefined {
  if (config.base.activeStore !== 'cscart') {
    return undefined;
  }
  const maxMirrorAgeMinutes = readEnvPositiveInt(
    env.CSCART_DELTA_MAX_MIRROR_AGE_MINUTES,
    120
  );
  const disableMissingOnFullImport =
    String(env.CSCART_DISABLE_MISSING_ON_FULL_IMPORT || 'true').toLowerCase() !== 'false';
  const featureScopeEnabled =
    String(env.CSCART_API_UPDATE_FEATURE_ENABLED || 'true').toLowerCase() !== 'false';
  const featureScopeId = String(readEnvPositiveInt(env.CSCART_API_UPDATE_FEATURE_ID, 564));
  const featureScopeValue = String(env.CSCART_API_UPDATE_FEATURE_VALUE || 'Y').trim() || 'Y';

  return async (batch: StoreImportBatch<unknown>): Promise<StoreImportBatch<unknown>> => {
    if (batch.store !== 'cscart') {
      return batch;
    }
    const rows = batch.rows as CsCartImportRow[];
    const supplierRaw = (batch.meta as Record<string, unknown>)?.supplier;
    const supplierFilter =
      typeof supplierRaw === 'string' && supplierRaw.trim().length > 0 ? supplierRaw.trim() : null;

    let scopedRows = rows;
    let managedCodes: Set<string> | null = null;
    let featureScopeSummary: unknown;

    if (featureScopeEnabled) {
      const scoped = await storeMirrorService.filterCsCartRowsByFeature(
        rows,
        maxMirrorAgeMinutes,
        featureScopeId,
        featureScopeValue
      );
      scopedRows = scoped.rows as CsCartImportRow[];
      managedCodes = scoped.managedCodes;
      featureScopeSummary = scoped.summary;
    } else {
      featureScopeSummary = {
        enabled: false,
        reason: 'disabled_by_env',
        featureId: featureScopeId,
        expectedValue: featureScopeValue,
        inputTotal: rows.length,
        matchedInput: rows.length,
        droppedInput: 0
      };
    }

    let rowsForDelta: CsCartImportRow[] = scopedRows;
    let deactivateMissingSummary: unknown;

    if (disableMissingOnFullImport && !supplierFilter) {
      const deactivateMissing = await storeMirrorService.appendCsCartMissingAsHidden(
        scopedRows,
        maxMirrorAgeMinutes,
        { managedCodes }
      );
      rowsForDelta = deactivateMissing.rows as CsCartImportRow[];
      deactivateMissingSummary = deactivateMissing.summary;
    } else {
      deactivateMissingSummary = {
        enabled: false,
        reason: disableMissingOnFullImport ? 'supplier_filtered' : 'disabled_by_env',
        supplier: supplierFilter,
        inputTotal: scopedRows.length,
        appended: 0
      };
    }

    const delta = await storeMirrorService.filterCsCartDelta(rowsForDelta, maxMirrorAgeMinutes);
    return {
      ...batch,
      rows: delta.rows as unknown[],
      meta: {
        ...batch.meta,
        featureScope: featureScopeSummary,
        deactivateMissing: deactivateMissingSummary,
        delta: delta.summary,
        totalBeforeFeatureScope: rows.length,
        totalAfterFeatureScope: scopedRows.length,
        totalBeforeDeactivateMissing: scopedRows.length,
        totalAfterDeactivateMissing: rowsForDelta.length,
        totalBeforeDelta: rowsForDelta.length,
        totalAfterDelta: delta.rows.length
      }
    };
  };
}

export interface Application {
  config: AppConfig;
  connector: StoreConnector<unknown>;
  pipeline: PipelineOrchestrator<unknown>;
  logService: LogService;
  jobService: JobService;
  jobRunner: PipelineJobRunner<unknown>;
  scheduler: JobScheduler;
  schedulerSettingsService: SchedulerSettingsService;
  catalogAdminService: CatalogAdminService;
  cleanupService: CleanupService;
  storeMirrorService: StoreMirrorService;
  migrationTargets: string[];
  auth: AuthService;
  close: () => Promise<void>;
}

export function createApplication(env: Record<string, string | undefined>): Application {
  const config = loadConfig(env);
  const pool = createPgPoolOrThrow(config.base.databaseUrl);
  const telegramAlertService = createTelegramAlertServiceFromEnv(env);
  const logService = new LogService(pool, {
    errorAlertSink: telegramAlertService
  });
  const connector = createConnector(config);
  const storeMirrorService = new StoreMirrorService(pool);
  const catalogAdminService = new CatalogAdminService(pool);
  const schedulerRuntimeState = {
    updatePipelineSupplier: config.scheduler.updatePipeline.supplier
  };
  const pipeline = new PipelineOrchestrator({
    sourceImporter: createSourceImporter(pool, logService, env.PRICE_AT_IMPORT === 'true'),
    finalizer: createFinalizer(
      pool,
      config.base.finalizeDeleteEnabled,
      env.PRICE_AT_IMPORT === 'true'
    ),
    previewProvider: createPreviewProvider(pool),
    connector,
    importBatchOptimizer: createImportBatchOptimizer(config, storeMirrorService, env)
  });
  const jobService = new JobService(pool);
  const cleanupService = new CleanupService(pool);
  const jobRunner = new PipelineJobRunner(
    pipeline,
    jobService,
    logService,
    cleanupService,
    storeMirrorService
  );
  const scheduler = new JobScheduler({
    enabled: config.scheduler.enabled,
    tickIntervalMs: config.scheduler.tickSeconds * 1000,
    logService,
    tasks: [
      {
        name: 'update_pipeline',
        enabled: config.scheduler.updatePipeline.enabled,
        intervalMs: config.scheduler.updatePipeline.intervalMinutes * 60 * 1000,
        cron: null,
        runOnStartup: config.scheduler.updatePipeline.runOnStartup,
        action: () => jobRunner.runUpdatePipeline(schedulerRuntimeState.updatePipelineSupplier)
      },
      {
        name: 'store_mirror_sync',
        enabled: config.scheduler.storeMirrorSync.enabled,
        intervalMs: config.scheduler.storeMirrorSync.intervalMinutes * 60 * 1000,
        cron: null,
        runOnStartup: config.scheduler.storeMirrorSync.runOnStartup,
        action: () => jobRunner.runStoreMirrorSync()
      },
      {
        name: 'cleanup',
        enabled: config.scheduler.cleanup.enabled,
        intervalMs: config.scheduler.cleanup.intervalMinutes * 60 * 1000,
        cron: null,
        runOnStartup: config.scheduler.cleanup.runOnStartup,
        action: () => jobRunner.runCleanup(config.base.cleanupRetentionDays)
      }
    ]
  });
  const schedulerSettingsService = new SchedulerSettingsService(
    pool,
    scheduler,
    schedulerRuntimeState
  );

  const authStore = config.auth.strategy === 'db' ? new DbUserStore(pool) : new EnvUserStore(env);
  const auth = new AuthService(authStore, {
    strategy: config.auth.strategy,
    sessionSecret: env.AUTH_SESSION_SECRET || 'changeme',
    sessionTtlMinutes: config.auth.sessionTtlMinutes
  });

  return {
    config,
    connector,
    pipeline,
    logService,
    jobService,
    jobRunner,
    scheduler,
    schedulerSettingsService,
    catalogAdminService,
    cleanupService,
    storeMirrorService,
    auth,
    close: async (): Promise<void> => {
      scheduler.stop();
      await pool.end();
    },
    migrationTargets: [
      `${LEGACY_ROOT}/src/services/importService.js -> src/core/pipeline`,
      `${LEGACY_ROOT}/src/services/finalizeService.js -> src/core/pipeline`,
      `${LEGACY_ROOT}/src/services/exportService.js -> src/core/pipeline + connector mapping`,
      `${LEGACY_ROOT}/src/services/horoshopService.js -> src/connectors/horoshop`
    ]
  };
}
