import type { StoreConnector, StoreImportContext } from '../../core/connectors/StoreConnector';
import type { CursorPage, ExportPreviewRow, MirrorRow, StoreImportBatch, StoreImportResult } from '../../core/domain/store';
export interface CsCartImportRow {
  productCode: string;
  size: string | null;
  supplier: string | null;
  parentProductCode: string | null;
  visibility: boolean;
  price: number | null;
  // Pre-resolved from store_mirror (undefined = mirror was stale, use fallback index)
  productId?: string | null;
  resolvedParentProductId?: string | null;
}

export interface CsCartGatewayClient {
  fetchProductsPage(page: number): Promise<CursorPage<MirrorRow>>;
  importProducts(rows: CsCartImportRow[], context?: StoreImportContext): Promise<StoreImportResult>;
}

export class CsCartConnector implements StoreConnector<CsCartImportRow> {
  readonly store = 'cscart' as const;

  readonly capabilities = {
    mirrorSync: true,
    importPreview: true
  };

  private readonly gateway: CsCartGatewayClient;

  constructor(gateway: CsCartGatewayClient) {
    this.gateway = gateway;
  }

  async fetchMirrorPage(cursor: string | null = null): Promise<CursorPage<MirrorRow>> {
    const page = cursor ? Number(cursor) || 1 : 1;
    const result = await this.gateway.fetchProductsPage(page);
    return {
      items: result.items,
      nextCursor: result.nextCursor
    };
  }

  async createImportBatch(rows: ExportPreviewRow[]): Promise<StoreImportBatch<CsCartImportRow>> {
    const mappedRows: CsCartImportRow[] = [];

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      mappedRows.push({
        productCode: row.article,
        size: row.size,
        supplier: row.supplier,
        parentProductCode: row.parentArticle,
        visibility: row.visibility,
        price: row.priceFinal
      });
    }

    return {
      store: this.store,
      rows: mappedRows,
      meta: {
        format: 'cscart_import_preview',
        total: mappedRows.length
      }
    };
  }

  importBatch(
    batch: StoreImportBatch<CsCartImportRow>,
    context?: StoreImportContext
  ): Promise<StoreImportResult> {
    if (batch.store !== this.store) {
      throw new Error(`Expected ${this.store} batch, received ${batch.store}`);
    }

    return this.gateway.importProducts(batch.rows, context);
  }
}
