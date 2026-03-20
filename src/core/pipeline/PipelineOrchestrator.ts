import type { StoreConnector } from '../connectors/StoreConnector';
import type {
  MirrorSnapshot,
  SourceImporter,
  Finalizer,
  ExportPreviewProvider,
  StoreExportResult,
  StoreImportExecution,
  UpdatePipelineSummary
} from './contracts';
import type { MirrorRow } from '../domain/store';

export interface PipelineDependencies<MappedRow = unknown> {
  sourceImporter: SourceImporter;
  finalizer: Finalizer;
  previewProvider: ExportPreviewProvider;
  connector: StoreConnector<MappedRow>;
}

export class PipelineOrchestrator<MappedRow = unknown> {
  private readonly sourceImporter: SourceImporter;

  private readonly finalizer: Finalizer;

  private readonly previewProvider: ExportPreviewProvider;

  private readonly connector: StoreConnector<MappedRow>;

  constructor(dependencies: PipelineDependencies<MappedRow>) {
    this.sourceImporter = dependencies.sourceImporter;
    this.finalizer = dependencies.finalizer;
    this.previewProvider = dependencies.previewProvider;
    this.connector = dependencies.connector;
  }

  async runStoreExport(jobId: number, supplier: string | null = null): Promise<StoreExportResult<MappedRow>> {
    const preview = await this.previewProvider.buildNeutralPreview(jobId, { supplier });
    const batch = await this.connector.createImportBatch(preview.rows);
    return { preview, batch };
  }

  async runStoreImport(
    jobId: number,
    supplier: string | null = null
  ): Promise<StoreImportExecution<MappedRow>> {
    const exportResult = await this.runStoreExport(jobId, supplier);
    const importResult = await this.connector.importBatch(exportResult.batch);
    return {
      preview: exportResult.preview,
      batch: exportResult.batch,
      importResult
    };
  }

  async runUpdatePipeline(
    jobId: number,
    supplier: string | null = null
  ): Promise<UpdatePipelineSummary<MappedRow>> {
    const importSummary = await this.sourceImporter.importAll(jobId);
    const finalizeSummary = await this.finalizer.buildFinalDataset(jobId);
    const storeExecution = await this.runStoreImport(jobId, supplier);

    return {
      importSummary,
      finalizeSummary,
      storeExecution
    };
  }

  async snapshotStoreMirror(): Promise<MirrorSnapshot> {
    const items: MirrorRow[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;

    while (true) {
      const page = await this.connector.fetchMirrorPage(cursor);
      pages += 1;

      for (let index = 0; index < page.items.length; index += 1) {
        items.push(page.items[index]);
      }

      if (!page.nextCursor) {
        break;
      }

      if (seenCursors.has(page.nextCursor)) {
        throw new Error(`Connector ${this.connector.store} returned a repeated cursor: ${page.nextCursor}`);
      }

      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }

    return {
      items,
      fetched: items.length,
      pages
    };
  }
}
