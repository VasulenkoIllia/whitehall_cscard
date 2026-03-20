import { loadConfig } from '../core/config/loadConfig';
import type { AppConfig } from '../core/config/types';
import type { StoreConnector } from '../core/connectors/StoreConnector';
import type { CursorPage, MirrorRow, StoreImportResult } from '../core/domain/store';
import type {
  ExportPreviewProvider,
  ExportPreviewSummary,
  FinalizeSummary,
  Finalizer,
  ImportSummary,
  SourceImporter
} from '../core/pipeline/contracts';
import { PipelineOrchestrator } from '../core/pipeline/PipelineOrchestrator';
import {
  HoroshopConnector,
  type HoroshopGateway,
  type HoroshopProductInput
} from '../connectors/horoshop/HoroshopConnector';
import {
  CsCartConnector,
  type CsCartGateway,
  type CsCartImportRow
} from '../connectors/cscart/CsCartConnector';

const LEGACY_ROOT = '/Users/monstermac/WebstormProjects/whitehall.store_integration';

function createMigrationError(target: string, legacyPath: string): Error {
  return new Error(`${target} is not implemented yet. Port logic from ${legacyPath}`);
}

function createSourceImporter(): SourceImporter {
  return {
    async importAll(): Promise<ImportSummary> {
      throw createMigrationError(
        'Source importer',
        `${LEGACY_ROOT}/src/services/importService.js`
      );
    }
  };
}

function createFinalizer(): Finalizer {
  return {
    async buildFinalDataset(): Promise<FinalizeSummary> {
      throw createMigrationError(
        'Finalize service',
        `${LEGACY_ROOT}/src/services/finalizeService.js`
      );
    }
  };
}

function createPreviewProvider(): ExportPreviewProvider {
  return {
    async buildNeutralPreview(
      _jobId: number,
      _options: { supplier: string | null }
    ): Promise<ExportPreviewSummary> {
      throw createMigrationError(
        'Neutral export preview provider',
        `${LEGACY_ROOT}/src/services/exportService.js`
      );
    }
  };
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

function createCsCartGateway(): CsCartGateway {
  return {
    async fetchCatalogPage(): Promise<CursorPage<MirrorRow>> {
      throw new Error('CS-Cart mirror gateway is not implemented yet');
    },
    async importProducts(_rows: CsCartImportRow[]): Promise<StoreImportResult> {
      throw new Error('CS-Cart import gateway is not implemented yet');
    }
  };
}

function createConnector(config: AppConfig): StoreConnector<unknown> {
  if (config.base.activeStore === 'horoshop') {
    return new HoroshopConnector({
      visibilityYes: config.base.visibilityYes,
      exportLimit: config.connectors.horoshop.exportLimit,
      gateway: createHoroshopGateway()
    });
  }

  return new CsCartConnector(createCsCartGateway());
}

export interface Application {
  config: AppConfig;
  connector: StoreConnector<unknown>;
  pipeline: PipelineOrchestrator<unknown>;
  migrationTargets: string[];
}

export function createApplication(env: Record<string, string | undefined>): Application {
  const config = loadConfig(env);
  const connector = createConnector(config);
  const pipeline = new PipelineOrchestrator({
    sourceImporter: createSourceImporter(),
    finalizer: createFinalizer(),
    previewProvider: createPreviewProvider(),
    connector
  });

  return {
    config,
    connector,
    pipeline,
    migrationTargets: [
      `${LEGACY_ROOT}/src/services/importService.js -> src/core/pipeline`,
      `${LEGACY_ROOT}/src/services/finalizeService.js -> src/core/pipeline`,
      `${LEGACY_ROOT}/src/services/exportService.js -> src/core/pipeline + connector mapping`,
      `${LEGACY_ROOT}/src/services/horoshopService.js -> src/connectors/horoshop`
    ]
  };
}
