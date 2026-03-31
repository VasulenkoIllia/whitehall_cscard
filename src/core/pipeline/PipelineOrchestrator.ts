import type { StoreConnector, StoreImportContext } from '../connectors/StoreConnector';
import type {
  MirrorSnapshot,
  SourceImporter,
  Finalizer,
  ExportPreviewProvider,
  ImportSummary,
  ImportAllOptions,
  SourceImportSummary,
  FinalizeSummary,
  StoreExportResult,
  StoreImportExecution,
  UpdatePipelineSummary
} from './contracts';
import type { MirrorRow } from '../domain/store';
import type { StoreImportBatch } from '../domain/store';

export interface PipelineDependencies<MappedRow = unknown> {
  sourceImporter: SourceImporter;
  finalizer: Finalizer;
  previewProvider: ExportPreviewProvider;
  connector: StoreConnector<MappedRow>;
  importBatchOptimizer?: (
    batch: StoreImportBatch<MappedRow>
  ) => Promise<StoreImportBatch<MappedRow>>;
}

export interface StoreMirrorWalkSummary {
  fetched: number;
  pages: number;
}

export class PipelineOrchestrator<MappedRow = unknown> {
  private readonly sourceImporter: SourceImporter;

  private readonly finalizer: Finalizer;

  private readonly previewProvider: ExportPreviewProvider;

  private readonly connector: StoreConnector<MappedRow>;

  private readonly importBatchOptimizer?: (
    batch: StoreImportBatch<MappedRow>
  ) => Promise<StoreImportBatch<MappedRow>>;

  constructor(dependencies: PipelineDependencies<MappedRow>) {
    this.sourceImporter = dependencies.sourceImporter;
    this.finalizer = dependencies.finalizer;
    this.previewProvider = dependencies.previewProvider;
    this.connector = dependencies.connector;
    this.importBatchOptimizer = dependencies.importBatchOptimizer;
  }

  get store() {
    return this.connector.store;
  }

  async forEachStoreMirrorPage(
    onPage: (items: MirrorRow[], page: number) => Promise<void> | void
  ): Promise<StoreMirrorWalkSummary> {
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    let fetched = 0;

    while (true) {
      const page = await this.connector.fetchMirrorPage(cursor);
      pages += 1;
      fetched += page.items.length;
      await onPage(page.items, pages);

      if (!page.nextCursor) {
        break;
      }

      if (seenCursors.has(page.nextCursor)) {
        throw new Error(`Connector ${this.connector.store} returned a repeated cursor: ${page.nextCursor}`);
      }

      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }

    return { fetched, pages };
  }

  runImportAll(jobId: number, options?: ImportAllOptions): Promise<ImportSummary> {
    return this.sourceImporter.importAll(jobId, options);
  }

  runImportSource(jobId: number, sourceId: number): Promise<SourceImportSummary> {
    return this.sourceImporter.importSource(jobId, sourceId);
  }

  runImportSupplier(jobId: number, supplierId: number): Promise<SourceImportSummary> {
    return this.sourceImporter.importSupplier(jobId, supplierId);
  }

  runFinalize(jobId: number): Promise<FinalizeSummary> {
    return this.finalizer.buildFinalDataset(jobId);
  }

  async runStoreExport(jobId: number, supplier: string | null = null): Promise<StoreExportResult<MappedRow>> {
    const preview = await this.previewProvider.buildNeutralPreview(jobId, { supplier });
    const preparedBatch = await this.connector.createImportBatch(preview.rows);
    const batchWithMeta: StoreImportBatch<MappedRow> = {
      ...preparedBatch,
      meta: {
        ...preparedBatch.meta,
        supplier
      }
    };
    const batch = this.importBatchOptimizer
      ? await this.importBatchOptimizer(batchWithMeta)
      : batchWithMeta;
    return { preview, batch };
  }

  async runStoreImport(
    jobId: number,
    supplier: string | null = null,
    context?: StoreImportContext
  ): Promise<StoreImportExecution<MappedRow>> {
    const exportResult = await this.runStoreExport(jobId, supplier);
    const importResult = await this.connector.importBatch(exportResult.batch, context);
    return {
      preview: exportResult.preview,
      batch: exportResult.batch,
      importResult
    };
  }

  async runUpdatePipeline(
    jobId: number,
    supplier: string | null = null,
    context?: StoreImportContext
  ): Promise<UpdatePipelineSummary<MappedRow>> {
    const importSummary = await this.sourceImporter.importAll(jobId);
    const finalizeSummary = await this.finalizer.buildFinalDataset(jobId);
    const storeExecution = await this.runStoreImport(jobId, supplier, context);

    return {
      importSummary,
      finalizeSummary,
      storeExecution
    };
  }

  async snapshotStoreMirror(): Promise<MirrorSnapshot> {
    const items: MirrorRow[] = [];
    const summary = await this.forEachStoreMirrorPage((pageItems) => {
      for (let index = 0; index < pageItems.length; index += 1) {
        items.push(pageItems[index]);
      }
    });

    return {
      items,
      fetched: summary.fetched,
      pages: summary.pages
    };
  }
}
