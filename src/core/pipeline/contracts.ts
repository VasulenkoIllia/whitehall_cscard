import type { ExportPreviewRow, MirrorRow, StoreImportBatch, StoreImportResult } from '../domain/store';

export interface ImportSummary {
  importedSources: number;
  importedRows: number;
  skippedRows: number;
  warnings: string[];
}

export interface SourceImportItem {
  sourceId: number;
  sourceName: string | null;
  supplierId: number;
  supplierName: string | null;
  imported: number;
  skipped: number;
  error: string | null;
}

export interface SourceImportSummary extends ImportSummary {
  sources: SourceImportItem[];
}

export interface FinalizeSummary {
  rawCount: number;
  finalCount: number;
  durationMs: number;
}

export interface ExportPreviewSummary {
  supplier: string | null;
  total: number;
  rows: ExportPreviewRow[];
}

export interface StoreExportResult<MappedRow = unknown> {
  preview: ExportPreviewSummary;
  batch: StoreImportBatch<MappedRow>;
}

export interface StoreImportExecution<MappedRow = unknown> extends StoreExportResult<MappedRow> {
  importResult: StoreImportResult;
}

export interface UpdatePipelineSummary<MappedRow = unknown> {
  mirrorSyncSummary?: { store: string; upserted: number; deleted: number; fetched: number; pages: number };
  importSummary: ImportSummary;
  finalizeSummary: FinalizeSummary;
  storeExecution: StoreImportExecution<MappedRow>;
}

export interface MirrorSnapshot {
  items: MirrorRow[];
  fetched: number;
  pages: number;
}

export interface ImportAllProgress {
  completed: number;
  total: number;
}

export type ImportProgressCallback = (progress: ImportAllProgress) => Promise<void>;

export interface ImportAllOptions {
  onProgress?: ImportProgressCallback;
}

export interface SourceImporter {
  importAll(jobId: number, options?: ImportAllOptions): Promise<ImportSummary>;
  importSource(jobId: number, sourceId: number): Promise<SourceImportSummary>;
  importSupplier(jobId: number, supplierId: number): Promise<SourceImportSummary>;
}

export interface Finalizer {
  buildFinalDataset(jobId: number): Promise<FinalizeSummary>;
}

export interface ExportPreviewProvider {
  buildNeutralPreview(
    jobId: number,
    options: { supplier: string | null }
  ): Promise<ExportPreviewSummary>;
}
