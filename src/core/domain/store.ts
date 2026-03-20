import type { ActiveStore } from '../config/types';

export interface ExportPreviewRow {
  article: string;
  size: string | null;
  priceFinal: number | null;
  visibility: boolean;
  parentArticle: string | null;
  supplier: string | null;
}

export interface MirrorRow {
  article: string;
  supplier: string | null;
  parentArticle: string | null;
  visibility: boolean;
  price: number | null;
  raw?: unknown;
}

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}

export interface StoreImportBatch<Row = unknown> {
  store: ActiveStore;
  rows: Row[];
  meta: Record<string, unknown>;
}

export interface StoreImportResult {
  imported: number;
  skipped: number;
  warnings: string[];
}
