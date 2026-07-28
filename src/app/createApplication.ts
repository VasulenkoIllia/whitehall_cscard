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
import { BuyerPriceExportService } from '../core/pipeline/BuyerPriceExportService';
import { JobService } from '../core/jobs/JobService';
import { PipelineJobRunner } from '../core/jobs/PipelineJobRunner';
import { CleanupService } from '../core/jobs/CleanupService';
import { StoreMirrorService } from '../core/jobs/StoreMirrorService';
import { JobScheduler } from '../core/jobs/JobScheduler';
import { SchedulerSettingsService } from '../core/jobs/SchedulerSettingsService';
import type { StoreImportBatch } from '../core/domain/store';
import { CatalogAdminService } from '../core/admin/CatalogAdminService';
import { MasterCatalogService } from '../core/master_catalog/MasterCatalogService';
import { ExcelImportService } from '../core/master_catalog/ExcelImportService';
import { createAnthropicClient } from '../core/ai/AnthropicClient';
import { createDeepseekClient } from '../core/ai/DeepseekClient';
import { createAiRouter } from '../core/ai/createAiRouter';
import { EnrichmentService } from '../core/ai/EnrichmentService';
import { AiUsageService } from '../core/ai/AiUsageService';
import { createAnthropicBatchClient } from '../core/ai/AnthropicBatchClient';
import { AnthropicBatchService } from '../core/ai/AnthropicBatchService';
import { EnrichmentJobService } from '../core/ai/EnrichmentJobService';
import { AppSettingsService } from '../core/settings/AppSettingsService';

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

function readEnvPositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.trunc(parsed);
}

/**
 * How old store_mirror may be before it stops being treated as the truth about
 * the store. Single source for both the delta filters and the readiness gate —
 * the UI badge used to hardcode 120 minutes of its own, which meant it reported
 * "not ready" for a third of every pipeline interval once the standalone mirror
 * sync was removed.
 */
function readMirrorMaxAgeMinutes(env: Record<string, string | undefined>): number {
  return readEnvPositiveInt(env.CSCART_DELTA_MAX_MIRROR_AGE_MINUTES, 120);
}

/** Reads a 0..1 share; anything outside that range falls back to the default. */
function readEnvRatio(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
    return fallback;
  }
  return parsed;
}

function readEnvBoolean(value: string | undefined, fallback: boolean): boolean {
  if (typeof value === 'undefined') {
    return fallback;
  }
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) {
    return false;
  }
  return fallback;
}

function readProductsUpdateAuthMode(value: string | undefined): 'basic' | 'bearer' | 'auto' {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'basic' || normalized === 'bearer') {
    return normalized;
  }
  return 'auto';
}

/**
 * Read a value preferring the new env var, falling back to the legacy one.
 * Used during the migration window from CSCART_STOCK_UPDATE_* to CSCART_PRODUCTS_UPDATE_*
 * so existing prod configs keep working without a redeploy.
 */
function pickEnv(primary: string | undefined, fallback: string | undefined): string | undefined {
  if (typeof primary === 'string' && primary.trim().length > 0) {
    return primary;
  }
  return fallback;
}

function readBulkEndpoint(value: string | undefined): 'products_update' | 'stock_update' {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'stock_update' ? 'stock_update' : 'products_update';
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
    importConcurrency: Number(process.env.CSCART_IMPORT_CONCURRENCY || 4),
    bulkEndpoint: readBulkEndpoint(process.env.CSCART_BULK_ENDPOINT),
    productsUpdateEnabled: readEnvBoolean(
      pickEnv(process.env.CSCART_PRODUCTS_UPDATE_ENABLED, process.env.CSCART_STOCK_UPDATE_ENABLED),
      true
    ),
    productsUpdateBatchSize: readEnvPositiveInt(
      pickEnv(
        process.env.CSCART_PRODUCTS_UPDATE_BATCH_SIZE,
        process.env.CSCART_STOCK_UPDATE_BATCH_SIZE
      ),
      1000
    ),
    productsUpdateRetryLimit: readEnvPositiveInt(
      pickEnv(
        process.env.CSCART_PRODUCTS_UPDATE_RETRY_LIMIT,
        process.env.CSCART_STOCK_UPDATE_RETRY_LIMIT
      ),
      5
    ),
    productsUpdateAuthMode: readProductsUpdateAuthMode(
      pickEnv(
        process.env.CSCART_PRODUCTS_UPDATE_AUTH_MODE,
        process.env.CSCART_STOCK_UPDATE_AUTH_MODE
      )
    ),
    collectionFeatureId: String(readEnvPositiveInt(process.env.CSCART_COLLECTION_FEATURE_ID, 558))
  });

  return new CsCartConnector(csGateway);
}

function createImportBatchOptimizer(
  config: AppConfig,
  storeMirrorService: StoreMirrorService,
  env: Record<string, string | undefined>
): ((batch: StoreImportBatch<unknown>) => Promise<StoreImportBatch<unknown>>) | undefined {
  if (config.base.activeStore !== 'cscart') {
    return undefined;
  }
  const maxMirrorAgeMinutes = readMirrorMaxAgeMinutes(env);
  const disableMissingOnFullImport =
    String(env.CSCART_DISABLE_MISSING_ON_FULL_IMPORT || 'true').toLowerCase() !== 'false';
  const featureScopeEnabled =
    String(env.CSCART_API_UPDATE_FEATURE_ENABLED || 'true').toLowerCase() !== 'false';
  const featureScopeId = String(readEnvPositiveInt(env.CSCART_API_UPDATE_FEATURE_ID, 564));
  const featureScopeValue = String(env.CSCART_API_UPDATE_FEATURE_VALUE || 'Y').trim() || 'Y';
  const allowCreateInStore = config.connectors.cscart.allowCreate;
  const maxMissingInMirrorRatio = readEnvRatio(env.CSCART_MAX_MISSING_IN_MIRROR_RATIO, 0.8);

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
        matchedManagedInput: rows.length,
        matchedMissingInMirrorInput: 0,
        droppedInput: 0
      };
    }

    let rowsForDelta: CsCartImportRow[] = scopedRows;
    let deactivateMissingSummary: unknown;

    // appendCsCartMissingAsHidden runs only on full imports (no supplier filter).
    // It hides mirror-active products that are absent from products_final — completely
    // independent of whether some products_final rows are new/missing in mirror.
    // New products absent from the mirror are protected by being present in sourceCodes,
    // so they are never incorrectly hidden.
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

    // Pass allowCreate so the delta filter can short-circuit missing-in-mirror
    // rows when the gateway would just skip them anyway (allowCreate=false).
    // Net effect on the store is identical; it just avoids dragging tens of
    // thousands of rows through the gateway loop for no work.
    const delta = await storeMirrorService.filterCsCartDelta(
      rowsForDelta,
      maxMirrorAgeMinutes,
      { allowCreate: allowCreateInStore }
    );

    // Refuse to push against a mirror we cannot trust.
    //
    // Every filter here decides what to send by comparing products_final with
    // store_mirror, and every "unknown" verdict resolves to "skip silently".
    // When the mirror was broken on 2026-07-22 that produced a perfectly green
    // run that sent nothing: 153 233 of 153 311 SKUs dropped as missing, zero
    // rows imported, no warning anywhere. Four days passed before anyone
    // noticed. A failed job is cheap; a silent no-op is not.
    //
    // The threshold is deliberately far above the normal figure — on this
    // catalogue ~37% of final SKUs legitimately do not exist in the store and
    // are skipped every single run (allowCreate=false). A broken mirror shows
    // ~99%, so 80% separates the two cleanly with room to spare.
    const featureScopeReason = String(
      (featureScopeSummary as { reason?: unknown } | null)?.reason || ''
    );
    if (featureScopeReason === 'mirror_empty' || featureScopeReason === 'mirror_stale') {
      throw new Error(
        `store_import refused: store_mirror is ${featureScopeReason.replace('mirror_', '')} ` +
          `(age limit ${maxMirrorAgeMinutes} min). Nothing can be compared, so nothing would be ` +
          'sent. Run a store mirror snapshot first.'
      );
    }
    const deltaTotal = Number(delta.summary.total || 0);
    const deltaMissing = Number(delta.summary.missingInMirror || 0);
    const missingRatio = deltaTotal > 0 ? deltaMissing / deltaTotal : 0;
    if (missingRatio > maxMissingInMirrorRatio) {
      const percent = (missingRatio * 100).toFixed(1);
      const limit = (maxMissingInMirrorRatio * 100).toFixed(0);
      throw new Error(
        `store_import refused: ${deltaMissing} of ${deltaTotal} products (${percent}%) are absent ` +
          `from store_mirror, limit ${limit}%. The mirror holds ${
            (featureScopeSummary as { mirrorTotal?: unknown } | null)?.mirrorTotal ?? 'unknown'
          } rows and is almost certainly incomplete — pushing now would silently skip most of the ` +
          'catalogue. Re-run the store mirror snapshot and check for overlapping syncs.'
      );
    }

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
  buyerPriceExportService: BuyerPriceExportService;
  scheduler: JobScheduler;
  schedulerSettingsService: SchedulerSettingsService;
  catalogAdminService: CatalogAdminService;
  masterCatalogService: MasterCatalogService;
  excelImportService: ExcelImportService;
  enrichmentService: EnrichmentService;
  aiUsageService: AiUsageService;
  anthropicBatchService: AnthropicBatchService;
  enrichmentJobService: EnrichmentJobService;
  appSettingsService: AppSettingsService;
  cleanupService: CleanupService;
  storeMirrorService: StoreMirrorService;
  /** Age limit that makes store_mirror stop counting as the truth about the store. */
  mirrorMaxAgeMinutes: number;
  migrationTargets: string[];
  auth: AuthService;
  /** Resolves when orphaned-job cleanup has completed. Await before starting the scheduler. */
  startupCleanup: Promise<void>;
  close: () => Promise<void>;
}

export function createApplication(env: Record<string, string | undefined>): Application {
  const config = loadConfig(env);
  const pool = createPgPoolOrThrow(config.base.databaseUrl);

  // Cleanup orphaned running jobs from a previous crash or SIGKILL.
  // Stored as a promise so index.ts can await it before starting the scheduler,
  // preventing a race where the scheduler sees stale 'running' jobs and throws 409.
  const startupCleanup: Promise<void> = pool
    .query(`
      UPDATE jobs
      SET status      = 'failed',
          finished_at = NOW(),
          meta        = COALESCE(meta, '{}'::jsonb) || '{"error":"Process crashed or was killed"}'::jsonb
      WHERE status = 'running'
    `)
    .then(() => pool.query(`DELETE FROM job_locks`))
    .then(() => undefined)
    .catch((err) => {
      // Surface the failure to stdout so it's visible in container logs. The promise
      // still resolves (we don't want startup to hard-fail on cleanup error — the
      // scheduler can self-heal on the next tick). LogService isn't usable here
      // because it'd just go through the same DB pool that just failed.
      // eslint-disable-next-line no-console
      console.error(
        JSON.stringify({
          startup_cleanup: 'rejected',
          error: err instanceof Error ? err.message : String(err)
        })
      );
    });

  const telegramAlertService = createTelegramAlertServiceFromEnv(env);
  const logService = new LogService(pool, {
    errorAlertSink: telegramAlertService
  });
  const connector = createConnector(config);
  // Undefined keeps the service default; the service validates the range itself.
  const storeMirrorService = new StoreMirrorService(pool, {
    maxPruneRatio: Number(env.STORE_MIRROR_MAX_PRUNE_RATIO) || undefined
  });
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
  const masterCatalogService = new MasterCatalogService(pool, logService);
  const appSettingsService = new AppSettingsService(pool);
  const excelImportService = new ExcelImportService(pool, logService, appSettingsService);
  // Ключ з app_settings (введений з фронта) має пріоритет над env.
  const anthropicKeyProvider = () => appSettingsService.getAnthropicApiKey();
  const anthropic = createAnthropicClient(env, anthropicKeyProvider);
  // DeepSeek — другий провайдер (OpenAI-сумісний). Роутер обирає клієнта за
  // назвою моделі: claude-* → Anthropic, deepseek-* → DeepSeek.
  const deepseekKeyProvider = () => appSettingsService.getDeepseekApiKey();
  const deepseek = createDeepseekClient(env, deepseekKeyProvider);
  const aiClient = createAiRouter({ anthropic, deepseek });
  const aiUsageService = new AiUsageService(pool);
  const enrichmentService = new EnrichmentService(
    pool,
    aiClient,
    logService,
    env,
    aiUsageService,
    appSettingsService
  );
  const anthropicBatchClient = createAnthropicBatchClient(env, anthropicKeyProvider);
  const anthropicBatchService = new AnthropicBatchService(
    pool,
    anthropicBatchClient,
    aiUsageService,
    logService,
    env,
    appSettingsService
  );
  // Фонові enrichment-завдання (server-side, переживають закриття браузера).
  const enrichmentJobService = new EnrichmentJobService(
    pool,
    enrichmentService,
    jobService,
    logService
  );
  const buyerPriceExportService = new BuyerPriceExportService(pool, jobService, logService, {
    enabled: env.BUYER_PRICE_EXPORT_ENABLED === 'true',
    sheetId: env.BUYER_PRICE_SHEET_ID || '',
    sheetTab: env.BUYER_PRICE_SHEET_TAB || 'Прайс',
    statusTab: env.BUYER_PRICE_STATUS_TAB || 'Оновлено',
    batchRows: Math.max(500, Number(env.BUYER_PRICE_BATCH_ROWS || 10000)),
    timeoutMs: Math.max(30000, Number(env.BUYER_PRICE_TIMEOUT_MS || 180000))
  });
  const jobRunner = new PipelineJobRunner(
    pipeline,
    jobService,
    logService,
    cleanupService,
    storeMirrorService,
    masterCatalogService,
    buyerPriceExportService
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
      // store_mirror_sync is deliberately NOT a scheduled task. The snapshot is
      // step ① of update_pipeline (see 9517dbc, "add mirror sync to update
      // pipeline"), and running it standalone as well only creates collisions:
      // whenever both fell on the same tick the run either wiped store_mirror or
      // took the lock and cancelled the whole pipeline. Manual runs stay
      // available via POST /admin/api/jobs/store-mirror-sync.
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
    buyerPriceExportService,
    scheduler,
    schedulerSettingsService,
    catalogAdminService,
    masterCatalogService,
    excelImportService,
    enrichmentService,
    aiUsageService,
    anthropicBatchService,
    enrichmentJobService,
    appSettingsService,
    cleanupService,
    storeMirrorService,
    auth,
    startupCleanup,
    close: async (): Promise<void> => {
      scheduler.stop();
      // Mark any still-running jobs as failed so they don't appear stuck after restart.
      try {
        await pool.query(`
          UPDATE jobs
          SET status      = 'failed',
              finished_at = NOW(),
              meta        = COALESCE(meta, '{}'::jsonb) || '{"error":"Server shutdown"}'::jsonb
          WHERE status = 'running'
        `);
        await pool.query(`DELETE FROM job_locks`);
      } catch (_err) {
        // best-effort — pool may already be draining
      }
      await pool.end();
    },
    mirrorMaxAgeMinutes: readMirrorMaxAgeMinutes(env),
    migrationTargets: [
      `${LEGACY_ROOT}/src/services/importService.js -> src/core/pipeline`,
      `${LEGACY_ROOT}/src/services/finalizeService.js -> src/core/pipeline`,
      `${LEGACY_ROOT}/src/services/exportService.js -> src/core/pipeline + connector mapping`,
      `${LEGACY_ROOT}/src/services/horoshopService.js -> src/connectors/horoshop`
    ]
  };
}
