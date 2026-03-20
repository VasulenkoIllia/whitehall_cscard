import type { ExportPreviewRow, MirrorRow, StoreImportBatch, StoreImportResult } from '../domain/store';

export interface ImportSummary {
  importedSources: number;
  importedRows: number;
  skippedRows: number;
  warnings: string[];
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
  importSummary: ImportSummary;
  finalizeSummary: FinalizeSummary;
  storeExecution: StoreImportExecution<MappedRow>;
}

export interface MirrorSnapshot {
  items: MirrorRow[];
  fetched: number;
  pages: number;
}

export interface SourceImporter {
  importAll(jobId: number): Promise<ImportSummary>;
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
