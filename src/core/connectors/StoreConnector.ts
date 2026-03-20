import type { ActiveStore } from '../config/types';
import type {
  CursorPage,
  ExportPreviewRow,
  MirrorRow,
  StoreImportBatch,
  StoreImportResult
} from '../domain/store';

export interface StoreConnectorCapabilities {
  mirrorSync: boolean;
  importPreview: boolean;
}

export interface StoreImportProgress {
  total: number;
  processed: number;
  imported: number;
  failed: number;
  skipped: number;
  finished: boolean;
  canceled: boolean;
}

export interface StoreImportContext {
  jobId?: number;
  isCanceled?: () => Promise<boolean>;
  onProgress?: (progress: StoreImportProgress) => Promise<void> | void;
}

export interface StoreConnector<MappedRow = unknown> {
  readonly store: ActiveStore;
  readonly capabilities: StoreConnectorCapabilities;

  fetchMirrorPage(cursor?: string | null): Promise<CursorPage<MirrorRow>>;

  createImportBatch(rows: ExportPreviewRow[]): Promise<StoreImportBatch<MappedRow>>;

  importBatch(
    batch: StoreImportBatch<MappedRow>,
    context?: StoreImportContext
  ): Promise<StoreImportResult>;
}
