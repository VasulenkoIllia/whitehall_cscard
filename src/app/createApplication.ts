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
import { CsCartConnector } from '../connectors/cscart/CsCartConnector';
import { CsCartGateway as DefaultCsCartGateway } from '../connectors/cscart/CsCartGateway';
import { AuthService } from './auth/authService';
import { EnvUserStore } from './auth/envUserStore';
import { DbUserStore } from './auth/dbUserStore';
import { createPgPool } from '../core/db/pgClient';
import { FinalizerDb } from '../core/pipeline/finalizerDb';
import { ImporterDb } from '../core/pipeline/importerDb';
import { LogService } from '../core/pipeline/log';
import { ExportPreviewDb } from '../core/pipeline/exportPreviewDb';
import { JobService } from '../core/jobs/JobService';
import { PipelineJobRunner } from '../core/jobs/PipelineJobRunner';
import { CleanupService } from '../core/jobs/CleanupService';

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
    allowCreate: config.connectors.cscart.allowCreate
  });

  return new CsCartConnector(csGateway);
}

export interface Application {
  config: AppConfig;
  connector: StoreConnector<unknown>;
  pipeline: PipelineOrchestrator<unknown>;
  logService: LogService;
  jobService: JobService;
  jobRunner: PipelineJobRunner<unknown>;
  cleanupService: CleanupService;
  migrationTargets: string[];
  auth: AuthService;
}

export function createApplication(env: Record<string, string | undefined>): Application {
  const config = loadConfig(env);
  const pool = createPgPoolOrThrow(config.base.databaseUrl);
  const logService = new LogService(pool);
  const connector = createConnector(config);
  const pipeline = new PipelineOrchestrator({
    sourceImporter: createSourceImporter(pool, logService, env.PRICE_AT_IMPORT === 'true'),
    finalizer: createFinalizer(
      pool,
      config.base.finalizeDeleteEnabled,
      env.PRICE_AT_IMPORT === 'true'
    ),
    previewProvider: createPreviewProvider(pool),
    connector
  });
  const jobService = new JobService(pool);
  const cleanupService = new CleanupService(pool);
  const jobRunner = new PipelineJobRunner(pipeline, jobService, logService, cleanupService);

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
    cleanupService,
    auth,
    migrationTargets: [
      `${LEGACY_ROOT}/src/services/importService.js -> src/core/pipeline`,
      `${LEGACY_ROOT}/src/services/finalizeService.js -> src/core/pipeline`,
      `${LEGACY_ROOT}/src/services/exportService.js -> src/core/pipeline + connector mapping`,
      `${LEGACY_ROOT}/src/services/horoshopService.js -> src/connectors/horoshop`
    ]
  };
}
