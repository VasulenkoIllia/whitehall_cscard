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
  resumeProcessed?: number;
  onProgress?: (progress: StoreImportProgress) => Promise<void> | void;
  /**
   * Optional sink for critical events that must reach the operator immediately,
   * regardless of any in-memory warnings cap. Use for things like bulk-flush
   * failures where the error message is needed live for diagnosis.
   */
  onCriticalEvent?: (
    level: 'info' | 'warning' | 'error',
    message: string,
    data?: unknown
  ) => Promise<void> | void;
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
