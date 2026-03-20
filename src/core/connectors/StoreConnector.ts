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

export interface StoreConnector<MappedRow = unknown> {
  readonly store: ActiveStore;
  readonly capabilities: StoreConnectorCapabilities;

  fetchMirrorPage(cursor?: string | null): Promise<CursorPage<MirrorRow>>;

  createImportBatch(rows: ExportPreviewRow[]): Promise<StoreImportBatch<MappedRow>>;

  importBatch(batch: StoreImportBatch<MappedRow>): Promise<StoreImportResult>;
}
