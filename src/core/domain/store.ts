import type { ActiveStore } from '../config/types';

export interface ExportPreviewRow {
  article: string;
  size: string | null;
  quantity: number;
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
  /**
   * Denormalized CS-Cart "Колекція + Модель" feature value (default feature_id=558).
   * Lets Compare-tab and other queries match by collection without JSONB lookups.
   * NULL when the feature is missing or empty in the source product.
   */
  collectionCode?: string | null;
  /**
   * Denormalized CS-Cart top-level field `variation_group_code` (admin field
   * "Група варіацій"). Set when product belongs to a CS-Cart variation group.
   * NULL for single-SKU products that are not part of a variation group.
   */
  variationGroupCode?: string | null;
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
