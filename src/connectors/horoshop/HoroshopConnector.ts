import type { StoreConnector } from '../../core/connectors/StoreConnector';
import type {
  CursorPage,
  ExportPreviewRow,
  MirrorRow,
  StoreImportBatch,
  StoreImportResult
} from '../../core/domain/store';

export interface HoroshopProductInput {
  article: string;
  supplier: string | null;
  presenceUa: string;
  displayInShowcase: boolean;
  parentArticle: string | null;
  price: number | null;
}

export interface HoroshopGateway {
  fetchCatalogPage(cursor: string | null, limit: number): Promise<CursorPage<MirrorRow>>;
  importCatalog(rows: HoroshopProductInput[]): Promise<StoreImportResult>;
}

export interface HoroshopConnectorOptions {
  visibilityYes: string;
  hiddenPresenceLabel?: string;
  exportLimit: number;
  gateway: HoroshopGateway;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildSku(article: string, size: string | null): string {
  const baseArticle = String(article || '').trim();
  const sizeValue = String(size || '').trim();

  if (!baseArticle || !sizeValue) {
    return baseArticle;
  }

  const pattern = new RegExp(`([\\s\\-_/]+)?${escapeRegExp(sizeValue)}$`, 'i');
  if (pattern.test(baseArticle)) {
    return baseArticle;
  }

  return `${baseArticle}-${sizeValue}`;
}

export class HoroshopConnector implements StoreConnector<HoroshopProductInput> {
  readonly store = 'horoshop' as const;

  readonly capabilities = {
    mirrorSync: true,
    importPreview: true
  };

  private readonly visibilityYes: string;

  private readonly hiddenPresenceLabel: string;

  private readonly exportLimit: number;

  private readonly gateway: HoroshopGateway;

  constructor(options: HoroshopConnectorOptions) {
    this.visibilityYes = options.visibilityYes;
    this.hiddenPresenceLabel = options.hiddenPresenceLabel || 'Немає в наявності';
    this.exportLimit = options.exportLimit;
    this.gateway = options.gateway;
  }

  fetchMirrorPage(cursor: string | null = null): Promise<CursorPage<MirrorRow>> {
    return this.gateway.fetchCatalogPage(cursor, this.exportLimit);
  }

  async createImportBatch(rows: ExportPreviewRow[]): Promise<StoreImportBatch<HoroshopProductInput>> {
    const mappedRows: HoroshopProductInput[] = [];

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      mappedRows.push({
        article: buildSku(row.article, row.size),
        supplier: row.supplier,
        presenceUa: row.visibility ? this.visibilityYes : this.hiddenPresenceLabel,
        displayInShowcase: row.visibility,
        parentArticle: row.parentArticle,
        price: row.priceFinal
      });
    }

    return {
      store: this.store,
      rows: mappedRows,
      meta: {
        format: 'horoshop_api_preview',
        total: mappedRows.length
      }
    };
  }

  importBatch(batch: StoreImportBatch<HoroshopProductInput>): Promise<StoreImportResult> {
    if (batch.store !== this.store) {
      throw new Error(`Expected ${this.store} batch, received ${batch.store}`);
    }

    return this.gateway.importCatalog(batch.rows);
  }
}
