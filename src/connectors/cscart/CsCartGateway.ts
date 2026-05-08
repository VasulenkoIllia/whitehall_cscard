import fetch, { Response } from 'node-fetch';
import type { RequestInit } from 'node-fetch';
import { URL } from 'url';
import type {
  StoreImportContext,
  StoreImportProgress
} from '../../core/connectors/StoreConnector';
import type { CursorPage, MirrorRow } from '../../core/domain/store';
import type { CsCartImportRow } from './CsCartConnector';

export interface CsCartGatewayOptions {
  baseUrl: string;
  apiUser: string;
  apiKey: string;
  itemsPerPage: number;
  rateLimitRps: number;
  rateLimitBurst: number;
  retryLimit?: number;
  allowCreate?: boolean;
  importConcurrency?: number;
  /**
   * Bulk endpoint to use for status/amount/price updates.
   * - 'products_update' (default): POST /api/products_update — supports status, amount, price in one call.
   * - 'stock_update' (legacy): POST /api/stock_update — supports only status/amount; price still goes via PUT.
   * Acts as a canary kill-switch: flip via ENV CSCART_BULK_ENDPOINT to revert without redeploy.
   */
  bulkEndpoint?: 'products_update' | 'stock_update';
  productsUpdateEnabled?: boolean;
  productsUpdateBatchSize?: number;
  productsUpdateRetryLimit?: number;
  productsUpdateAuthMode?: 'basic' | 'bearer' | 'auto';
}

interface CsCartProduct {
  product_id: string;
  product_code: string;
  status: string;
  price: string;
  amount: string;
  parent_product_id?: string;
  updated_timestamp?: string;
}

type CsCartAuthMode = 'basic' | 'bearer';

/**
 * Whitelist of fields accepted by POST /api/products_update.
 * Sending any other field causes the endpoint to reject the entire batch with HTTP 400
 * and an `errors[]` array. Keep this type strict — adding a field requires
 * verifying CS-Cart accepts it (see docs/CSCART_CONNECTOR_NOTES.md).
 */
interface CsCartProductsUpdatePayloadRow {
  sku: string;
  status: 'A' | 'H' | 'D';
  amount: number;
  price: number;
}

interface CsCartProductsUpdateErrorEntry {
  sku?: string;
  field?: string;
  row?: string;
  message?: string;
}

interface CsCartProductsUpdateResponse {
  /** HTTP-style status echoed in the body (200 on success, 400 on validation error). */
  status?: number;
  /** Count of SKUs accepted by the store (includes noop). Present on success. */
  updated_products?: number;
  /** Count of SKUs that were not found in the store. */
  not_found_count?: number;
  /** Concrete SKUs not found in the store — used to mark per-SKU failures. */
  not_found_skus?: string[];
  /** Server-side processing time in seconds. */
  time?: number;
  /** Top-level human-readable message (mostly for HTTP 400). */
  message?: string;
  /** Per-SKU/per-field validation errors when HTTP 400. */
  errors?: CsCartProductsUpdateErrorEntry[];
  /** Legacy compatibility: when nothing matched, older builds returned `updated:0`. */
  updated?: number;
}

interface ResolvedProductState {
  productCode: string;
  productId: string;
  parentProductId: string | null;
  desiredStatus: 'A' | 'D';
  desiredAmount: number;
  desiredPrice: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class CsCartGateway {
  private readonly baseUrl: string;

  private readonly authHeader: string;

  private readonly itemsPerPage: number;

  private readonly rateLimitInterval: number;

  private tokens: number;

  private lastRefill: number;

  private readonly rateLimitBurst: number;

  private readonly retryLimit: number;

  private readonly allowCreate: boolean;

  private readonly importConcurrency: number;

  private readonly bulkEndpoint: 'products_update' | 'stock_update';

  private readonly productsUpdateEnabled: boolean;

  private readonly productsUpdateBatchSize: number;

  private readonly productsUpdateRetryLimit: number;

  private readonly productsUpdateAuthMode: 'basic' | 'bearer' | 'auto';

  private resolvedProductsUpdateAuthMode: CsCartAuthMode | null = null;

  constructor(private readonly options: CsCartGatewayOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.authHeader =
      'Basic ' + Buffer.from(`${options.apiUser}:${options.apiKey}`, 'utf8').toString('base64');
    this.itemsPerPage = options.itemsPerPage;
    this.rateLimitInterval = 1000 / Math.max(1, options.rateLimitRps);
    this.tokens = options.rateLimitBurst;
    this.rateLimitBurst = options.rateLimitBurst;
    this.lastRefill = Date.now();
    this.retryLimit = options.retryLimit && options.retryLimit > 0 ? options.retryLimit : 5;
    this.allowCreate = options.allowCreate === true;
    this.importConcurrency =
      options.importConcurrency && options.importConcurrency > 0
        ? Math.max(1, Math.min(20, Math.trunc(options.importConcurrency)))
        : 4;
    this.bulkEndpoint =
      options.bulkEndpoint === 'stock_update' ? 'stock_update' : 'products_update';
    this.productsUpdateEnabled = options.productsUpdateEnabled !== false;
    this.productsUpdateBatchSize =
      options.productsUpdateBatchSize && options.productsUpdateBatchSize > 0
        ? Math.max(1, Math.min(5000, Math.trunc(options.productsUpdateBatchSize)))
        : 1000;
    this.productsUpdateRetryLimit =
      options.productsUpdateRetryLimit && options.productsUpdateRetryLimit > 0
        ? Math.max(1, Math.min(20, Math.trunc(options.productsUpdateRetryLimit)))
        : this.retryLimit;
    this.productsUpdateAuthMode = this.normalizeProductsUpdateAuthMode(
      options.productsUpdateAuthMode
    );
  }

  private normalizeProductCode(value: unknown): string {
    return String(value || '').trim();
  }

  private normalizeStatus(value: unknown): 'A' | 'D' {
    const normalized = String(value || '').toUpperCase();
    return normalized === 'A' ? 'A' : 'D';
  }

  private normalizePrice(value: unknown): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      return 0;
    }
    return parsed;
  }

  private normalizeParentProductId(value: unknown): string | null {
    if (value === null || typeof value === 'undefined') {
      return null;
    }
    const raw = String(value).trim();
    if (!raw || raw === '0') {
      return null;
    }
    return raw;
  }

  private appendWarning(warnings: string[], message: string): void {
    if (warnings.length < 200) {
      warnings.push(message);
      return;
    }
    if (warnings.length === 200) {
      warnings.push('warnings truncated');
    }
  }

  private normalizeAmount(value: unknown): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : 0;
  }

  private normalizeProductsUpdateAuthMode(value: unknown): 'basic' | 'bearer' | 'auto' {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'basic' || normalized === 'bearer') {
      return normalized;
    }
    return 'auto';
  }

  private buildAuthorizationHeader(authMode: CsCartAuthMode): string {
    if (authMode === 'bearer') {
      // NOTE: CS-Cart on this storefront accepts `Bearer <base64(email:apiKey)>`,
      // i.e. the same token as Basic with a different prefix.
      // Sending raw apiKey here returns 401 — this branch is currently a known dead
      // code-path (see docs/CSCART_CONNECTOR_NOTES.md "Bearer auth note"). We keep
      // it untouched in this PR to avoid changing auth behavior on stable endpoints.
      return `Bearer ${this.options.apiKey}`;
    }
    return this.authHeader;
  }

  /**
   * Auth order for /api/products_update.
   * Default = ['basic'] — Basic is the only auth mode CS-Cart documents and the only one
   * we have proven to work consistently on this storefront. Bearer is opt-in via env.
   */
  private resolveProductsUpdateAuthOrder(): CsCartAuthMode[] {
    if (this.productsUpdateAuthMode === 'basic') {
      return ['basic'];
    }
    if (this.productsUpdateAuthMode === 'bearer') {
      return ['bearer'];
    }
    if (this.resolvedProductsUpdateAuthMode) {
      return [this.resolvedProductsUpdateAuthMode];
    }
    return ['basic'];
  }

  private normalizeNotFoundSku(value: unknown): string {
    if (typeof value === 'string' || typeof value === 'number') {
      return this.normalizeProductCode(value);
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return '';
    }
    const asObj = value as Record<string, unknown>;
    return this.normalizeProductCode(asObj.sku || asObj.product_code || asObj.code);
  }

  private async fetchProductIndexByCode(): Promise<
    Map<
      string,
      {
        productId: string;
        status: 'A' | 'D';
        amount: number;
        price: number;
        parentProductId: string | null;
      }
    >
  > {
    const byCode = new Map<
      string,
      {
        productId: string;
        status: 'A' | 'D';
        amount: number;
        price: number;
        parentProductId: string | null;
      }
    >();

    let page = 1;
    while (true) {
      const data = await this.request(
        `/api/products?items_per_page=${this.itemsPerPage}&page=${page}`
      );
      const products: CsCartProduct[] = Array.isArray(data.products) ? data.products : [];
      for (let index = 0; index < products.length; index += 1) {
        const product = products[index];
        const code = this.normalizeProductCode(product.product_code);
        if (!code || !product.product_id) {
          continue;
        }
        byCode.set(code, {
          productId: String(product.product_id),
          status: this.normalizeStatus(product.status),
          amount: this.normalizeAmount(product.amount),
          price: this.normalizePrice(product.price),
          parentProductId: this.normalizeParentProductId(product.parent_product_id)
        });
      }

      const totalItems = Number(data.params?.total_items || products.length);
      const totalPages = Math.max(1, Math.ceil(totalItems / this.itemsPerPage));
      if (products.length === 0 || page >= totalPages) {
        break;
      }
      page += 1;
    }

    return byCode;
  }

  private isSameProductState(
    current: { status: 'A' | 'D'; amount: number; price: number; parentProductId: string | null },
    next: { status: 'A' | 'D'; amount: number; price: number; parentProductId: string | null }
  ): boolean {
    if (current.status !== next.status) {
      return false;
    }
    if (current.amount !== next.amount) {
      return false;
    }
    if (Math.abs(current.price - next.price) > 0.01) {
      return false;
    }
    return current.parentProductId === next.parentProductId;
  }

  private refillTokens(): void {
    const now = Date.now();
    const delta = now - this.lastRefill;
    if (delta <= 0) {
      return;
    }
    const add = Math.floor(delta / this.rateLimitInterval);
    if (add > 0) {
      this.tokens = Math.min(this.rateLimitBurst, this.tokens + add);
      this.lastRefill = now;
    }
  }

  private async acquireToken(): Promise<void> {
    while (true) {
      this.refillTokens();
      if (this.tokens > 0) {
        this.tokens -= 1;
        return;
      }
      await sleep(this.rateLimitInterval);
    }
  }

  private async request(
    path: string,
    init: RequestInit & { retry?: number; authMode?: CsCartAuthMode; retryLimit?: number } = {}
  ): Promise<any> {
    const authMode: CsCartAuthMode = init.authMode === 'bearer' ? 'bearer' : 'basic';
    const retryLimitRaw = Number(init.retryLimit);
    const retryLimit = Number.isFinite(retryLimitRaw)
      ? Math.max(0, Math.trunc(retryLimitRaw))
      : this.retryLimit;
    await this.acquireToken();
    const url = new URL(path, this.baseUrl).toString();

    // Hard timeout on the network call. Without it, a stalled CS-Cart connection
    // (TCP open but no response) blocks the whole import loop indefinitely —
    // we observed this in prod with bulk products_update batches.
    // Treat timeout the same as a 5xx — eligible for retry/backoff.
    const REQUEST_TIMEOUT_MS = 60000;
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let resp: Response;
    try {
      resp = await fetch(url, {
        ...init,
        signal: controller.signal as unknown as RequestInit['signal'],
        headers: {
          'Content-Type': 'application/json',
          ...(init.headers || {}),
          Authorization: this.buildAuthorizationHeader(authMode)
        }
      });
    } catch (err) {
      const aborted =
        (err as { name?: string } | null)?.name === 'AbortError' ||
        (err as { type?: string } | null)?.type === 'aborted';
      if (aborted) {
        const retry = (init.retry || 0) + 1;
        if (retry <= retryLimit) {
          await sleep(15000 * retry);
          return this.request(path, { ...init, retry });
        }
        throw new Error(
          `CS-Cart request timed out after ${REQUEST_TIMEOUT_MS}ms (path=${path}, retries=${retry - 1})`
        );
      }
      throw err;
    } finally {
      clearTimeout(timeoutHandle);
    }

    if (resp.status === 429 || resp.status >= 500) {
      const retry = (init.retry || 0) + 1;
      if (retry <= retryLimit) {
        const retryAfter = Number(resp.headers.get('Retry-After')) * 1000 || 15000 * retry;
        await sleep(retryAfter);
        return this.request(path, { ...init, retry });
      }
    }

    const text = await resp.text();
    if (!resp.ok) {
      // Truncate error body before bubbling up: errors land in job logs (jobs.logs.data)
      // and warnings tail. CS-Cart can echo arbitrary user-controlled data here, so
      // we cap it to keep payloads bounded and reduce blast-radius for accidental leaks.
      const ERROR_BODY_MAX_CHARS = 500;
      const truncated =
        text.length > ERROR_BODY_MAX_CHARS
          ? `${text.slice(0, ERROR_BODY_MAX_CHARS)}...[truncated ${text.length - ERROR_BODY_MAX_CHARS} chars]`
          : text;
      throw new Error(`CS-Cart API error ${resp.status}: ${truncated}`);
    }

    if (!text) {
      return {};
    }
    try {
      return JSON.parse(text);
    } catch (_err) {
      return { raw: text };
    }
  }

  /**
   * Bulk endpoint dispatcher.
   * - 'products_update' (default): full payload {sku,status,amount,price}
   * - 'stock_update'   (legacy):    payload stripped to {sku,amount,status}; price changes go via PUT
   */
  private bulkEndpointPath(): string {
    return this.bulkEndpoint === 'stock_update' ? '/api/stock_update' : '/api/products_update';
  }

  private async requestProductsUpdateBatch(
    batchRows: CsCartProductsUpdatePayloadRow[]
  ): Promise<CsCartProductsUpdateResponse> {
    const authOrder = this.resolveProductsUpdateAuthOrder();
    let lastError: unknown = null;
    const path = this.bulkEndpointPath();

    // For the legacy stock_update endpoint, drop `price` from each row — it doesn't
    // accept that field. Without this, every batch would silently ignore the price.
    const wirePayload =
      this.bulkEndpoint === 'stock_update'
        ? batchRows.map((row) => ({ sku: row.sku, status: row.status, amount: row.amount }))
        : batchRows;

    for (let index = 0; index < authOrder.length; index += 1) {
      const authMode = authOrder[index];
      try {
        const response = await this.request(path, {
          method: 'POST',
          body: JSON.stringify(wirePayload),
          authMode,
          retryLimit: this.productsUpdateRetryLimit
        });
        this.resolvedProductsUpdateAuthMode = authMode;
        if (!response || typeof response !== 'object') {
          return {};
        }
        return response as CsCartProductsUpdateResponse;
      } catch (err) {
        lastError = err;
        const message = err instanceof Error ? err.message : String(err);
        const unauthorized = message.includes('CS-Cart API error 401');
        if (!unauthorized || authMode !== 'bearer') {
          break;
        }
      }
    }

    if (lastError instanceof Error) {
      throw lastError;
    }
    throw new Error(`CS-Cart ${this.bulkEndpoint} request failed`);
  }

  async fetchProductsPage(page: number): Promise<CursorPage<MirrorRow>> {
    const data = await this.request(
      `/api/products?items_per_page=${this.itemsPerPage}&page=${page}`
    );
    const products: CsCartProduct[] = Array.isArray(data.products) ? data.products : [];
    const items: MirrorRow[] = products.map((p) => ({
      article: p.product_code || '',
      supplier: null,
      parentArticle: p.parent_product_id && p.parent_product_id !== '0' ? p.parent_product_id : null,
      visibility: (p.status || '').toUpperCase() === 'A',
      price: Number(p.price || 0) || null,
      raw: p
    }));
    const totalItems = Number(data.params?.total_items || products.length);
    const totalPages = Math.ceil(totalItems / this.itemsPerPage);
    const nextCursor = page < totalPages ? String(page + 1) : null;
    return {
      items,
      nextCursor
    };
  }

  async importProducts(
    rows: CsCartImportRow[],
    context?: StoreImportContext
  ): Promise<{ imported: number; failed: number; skipped: number; warnings: string[] }> {
    let imported = 0;
    let failed = 0;
    let skipped = 0;
    const warnings: string[] = [];

    // Build fallback index only when rows were NOT enriched by filterCsCartDelta
    // (i.e. mirror was stale/empty and productId was not pre-resolved).
    // In the normal update_pipeline flow (fresh mirror), all rows have productId set
    // and this expensive API fetch is skipped entirely.
    const needsFallback = rows.some(
      (r) => this.normalizeProductCode(r.productCode) && r.productId === undefined
    );
    const indexByCode = needsFallback ? await this.fetchProductIndexByCode() : null;

    let cursor = 0;
    const totalRows = rows.length;
    const totalValidRows = rows.reduce(
      (count, row) => count + (this.normalizeProductCode(row.productCode) ? 1 : 0),
      0
    );
    const requestedResumeProcessed = Number(context?.resumeProcessed || 0);
    const effectiveResumeProcessed = Number.isFinite(requestedResumeProcessed)
      ? Math.min(totalValidRows, Math.max(0, Math.trunc(requestedResumeProcessed)))
      : 0;
    let resumeRemaining = effectiveResumeProcessed;
    let runProcessed = 0;
    let canceled = false;
    let cancelCheckCounter = 0;
    const progressReportEvery = 250;
    let nextProgressMark = progressReportEvery;
    const pendingProductsUpdate: ResolvedProductState[] = [];
    let productsUpdateBatchSeq = 0;
    // Counters for the operational summary that lands in run logs (see PipelineJobRunner).
    let bulkBatches = 0;
    let bulkAcceptedTotal = 0;
    let bulkNotFoundTotal = 0;
    let bulkServerTimeSec = 0;
    let bulkFallbackBatches = 0;

    const takeNextRow = (): CsCartImportRow | null => {
      while (cursor < totalRows) {
        const row = rows[cursor];
        cursor += 1;
        if (this.normalizeProductCode(row.productCode)) {
          if (resumeRemaining > 0) {
            resumeRemaining -= 1;
            continue;
          }
          return row;
        }
      }
      return null;
    };

    const checkCanceled = async (): Promise<void> => {
      if (canceled || !context?.isCanceled) {
        return;
      }
      cancelCheckCounter += 1;
      if (cancelCheckCounter % 25 !== 0) {
        return;
      }
      const isCanceled = await context.isCanceled();
      if (!isCanceled) {
        return;
      }
      canceled = true;
      const cancelError = new Error('Job canceled');
      (cancelError as any).code = 'JOB_CANCELED';
      throw cancelError;
    };

    const reportProgress = async (force = false, finished = false): Promise<void> => {
      if (!context?.onProgress) {
        return;
      }
      const processed = effectiveResumeProcessed + runProcessed;
      if (!force && processed < nextProgressMark) {
        return;
      }
      if (!force) {
        nextProgressMark = processed + progressReportEvery;
      }
      const progress: StoreImportProgress = {
        total: totalValidRows,
        processed,
        imported,
        failed,
        skipped,
        finished,
        canceled
      };
      await context.onProgress(progress);
    };

    const markProcessed = async (count: number): Promise<void> => {
      if (count <= 0) {
        return;
      }
      runProcessed += count;
      await reportProgress(false, false);
    };

    const buildLegacyPayload = (state: ResolvedProductState): Record<string, unknown> => {
      const payload: Record<string, unknown> = {
        product_code: state.productCode,
        status: state.desiredStatus,
        amount: state.desiredAmount,
        price: state.desiredPrice
      };
      if (state.parentProductId !== null) {
        payload.parent_product_id = state.parentProductId;
      }
      return payload;
    };

    const runLegacyPut = async (state: ResolvedProductState): Promise<void> => {
      const payload = buildLegacyPayload(state);
      try {
        await this.request(`/api/products/${state.productId}`, {
          method: 'PUT',
          body: JSON.stringify(payload)
        });
        imported += 1;
      } catch (err) {
        if ((err as any)?.code === 'JOB_CANCELED') {
          throw err;
        }
        failed += 1;
        if (err instanceof Error) {
          this.appendWarning(warnings, `product_code=${state.productCode}: ${err.message}`);
        } else {
          this.appendWarning(warnings, `product_code=${state.productCode}: import failed`);
        }
      }
    };

    const runCreate = async (state: ResolvedProductState): Promise<void> => {
      const payload = buildLegacyPayload(state);
      try {
        const created = await this.request('/api/products', {
          method: 'POST',
          body: JSON.stringify(payload)
        });
        const createdProductId = String(
          created?.product_id || created?.response?.product_id || ''
        ).trim();
        if (createdProductId && indexByCode) {
          indexByCode.set(state.productCode, {
            productId: createdProductId,
            status: state.desiredStatus,
            amount: state.desiredAmount,
            price: state.desiredPrice,
            parentProductId: state.parentProductId
          });
        }
        imported += 1;
      } catch (err) {
        if ((err as any)?.code === 'JOB_CANCELED') {
          throw err;
        }
        failed += 1;
        if (err instanceof Error) {
          this.appendWarning(warnings, `product_code=${state.productCode}: ${err.message}`);
        } else {
          this.appendWarning(warnings, `product_code=${state.productCode}: import failed`);
        }
      }
    };

    /**
     * Build a single payload row for /api/products_update.
     * IMPORTANT: only the four whitelisted fields below are accepted by the endpoint.
     * Adding any extra field causes HTTP 400 and rejects the WHOLE batch.
     */
    const buildBulkRow = (state: ResolvedProductState): CsCartProductsUpdatePayloadRow => ({
      sku: state.productCode,
      status: state.desiredStatus,
      amount: state.desiredAmount,
      price: state.desiredPrice
    });

    const flushProductsUpdate = async (): Promise<void> => {
      if (!pendingProductsUpdate.length) {
        return;
      }
      await checkCanceled();
      const batchRows = pendingProductsUpdate.splice(0, pendingProductsUpdate.length);
      productsUpdateBatchSeq += 1;
      bulkBatches += 1;
      const wirePayload: CsCartProductsUpdatePayloadRow[] = batchRows.map(buildBulkRow);

      try {
        const response = await this.requestProductsUpdateBatch(wirePayload);
        // not_found_skus is the v2 contract; keep tolerant fallback for older shape.
        const notFoundList: string[] = Array.isArray(response.not_found_skus)
          ? (response.not_found_skus as unknown[]).map((v) => this.normalizeNotFoundSku(v))
          : [];
        const notFoundSet = new Set<string>(notFoundList.filter(Boolean));

        for (let index = 0; index < batchRows.length; index += 1) {
          const item = batchRows[index];
          if (notFoundSet.has(item.productCode)) {
            failed += 1;
            this.appendWarning(
              warnings,
              `product_code=${item.productCode}: ${this.bulkEndpoint} not_found`
            );
            continue;
          }
          imported += 1;
        }

        const updatedProducts = Number.isFinite(Number(response.updated_products))
          ? Number(response.updated_products)
          : Number.isFinite(Number(response.updated))
            ? Number(response.updated)
            : null;
        const notFoundCount = Number.isFinite(Number(response.not_found_count))
          ? Number(response.not_found_count)
          : notFoundSet.size;
        const serverTime = Number.isFinite(Number(response.time)) ? Number(response.time) : null;
        if (serverTime !== null) {
          bulkServerTimeSec += serverTime;
        }
        bulkAcceptedTotal += updatedProducts ?? 0;
        bulkNotFoundTotal += notFoundCount;

        const summary = {
          batch: productsUpdateBatchSeq,
          endpoint: this.bulkEndpoint,
          size: batchRows.length,
          updatedProducts,
          notFound: notFoundCount,
          time: serverTime
        };
        this.appendWarning(
          warnings,
          `products_update batch response: ${JSON.stringify(summary)}`
        );
      } catch (err) {
        bulkFallbackBatches += 1;
        const message = err instanceof Error ? err.message : 'products_update failed';
        this.appendWarning(
          warnings,
          `products_update batch ${productsUpdateBatchSeq} failed, fallback=PUT: ${message}`
        );
        for (let index = 0; index < batchRows.length; index += 1) {
          await runLegacyPut(batchRows[index]);
        }
      } finally {
        await markProcessed(batchRows.length);
      }
    };

    await reportProgress(true, false);

    try {
      while (true) {
        await checkCanceled();
        if (canceled) {
          break;
        }

        const row = takeNextRow();
        if (!row) {
          break;
        }

        const productCode = this.normalizeProductCode(row.productCode);
        const desiredAmount = row.visibility ? this.normalizeAmount(row.amount) : 0;
        const desiredStatus = row.visibility ? ('A' as const) : ('D' as const);
        const desiredPrice = this.normalizePrice(row.price);

        let productId: string | null = null;
        let parentProductId: string | null = null;
        let hasCurrentState = false;
        let currentStatus: 'A' | 'D' | null = null;
        let currentAmount: number | null = null;
        let currentPrice: number | null = null;
        let currentParentProductId: string | null = null;

        if (row.productId !== undefined) {
          productId = row.productId || null;
          parentProductId = row.resolvedParentProductId ?? null;

          if (
            typeof row.storeVisibility !== 'undefined' &&
            typeof row.storeAmount !== 'undefined' &&
            typeof row.storePrice !== 'undefined' &&
            typeof row.storeParentProductId !== 'undefined'
          ) {
            hasCurrentState = true;
            currentStatus = row.storeVisibility === true ? 'A' : 'D';
            currentAmount = this.normalizeAmount(row.storeAmount);
            currentPrice = this.normalizePrice(row.storePrice);
            currentParentProductId = row.storeParentProductId || null;
          }
        } else {
          const fromIndex = indexByCode?.get(productCode) || null;
          const parentCode = this.normalizeProductCode(row.parentProductCode);
          const parentFromIndex = parentCode && indexByCode ? indexByCode.get(parentCode) || null : null;

          productId = fromIndex?.productId || null;
          parentProductId = parentFromIndex?.productId || null;

          if (fromIndex) {
            hasCurrentState = true;
            currentStatus = fromIndex.status;
            currentAmount = fromIndex.amount;
            currentPrice = fromIndex.price;
            currentParentProductId = fromIndex.parentProductId;

            const desiredState = {
              status: desiredStatus,
              amount: desiredAmount,
              price: desiredPrice,
              parentProductId
            };
            if (this.isSameProductState(fromIndex, desiredState)) {
              skipped += 1;
              await markProcessed(1);
              continue;
            }
          }
        }

        const state: ResolvedProductState = {
          productCode,
          productId: productId || '',
          parentProductId,
          desiredStatus,
          desiredAmount,
          desiredPrice
        };

        if (!productId) {
          await flushProductsUpdate();
          if (!this.allowCreate) {
            skipped += 1;
            this.appendWarning(
              warnings,
              `product_code=${productCode}: missing in store, skipped (update-only mode)`
            );
            await markProcessed(1);
            continue;
          }

          await runCreate(state);
          await markProcessed(1);
          continue;
        }

        state.productId = productId;

        // Decision tree:
        // - parent_product_id is NOT supported by /api/products_update (HTTP 400),
        //   so any parent diff goes via the legacy PUT path.
        // - When the bulk endpoint is the legacy stock_update, price diffs also need PUT.
        // - When the bulk endpoint is products_update (default), price diffs go in the bulk batch.
        // - Truncate guard: products_update truncates fractional kopiyky (1090.50 -> 1090).
        //   Our pipeline emits CEIL(...,10) so prices are always integers, but if a
        //   non-integer slips through we route it to PUT to preserve exact value.
        const parentDiffers = currentParentProductId !== parentProductId;
        const priceDiffers =
          currentPrice === null || Math.abs(currentPrice - desiredPrice) > 0.01;
        const fractionalPrice = !Number.isInteger(desiredPrice);
        const useLegacyForPrice =
          this.bulkEndpoint === 'stock_update' || fractionalPrice;
        const needsLegacyPut =
          !this.productsUpdateEnabled ||
          !hasCurrentState ||
          parentDiffers ||
          (priceDiffers && useLegacyForPrice);
        const needsBulk =
          !hasCurrentState ||
          currentStatus !== desiredStatus ||
          currentAmount !== desiredAmount ||
          (priceDiffers && !useLegacyForPrice);

        if (needsLegacyPut) {
          await flushProductsUpdate();
          await runLegacyPut(state);
          await markProcessed(1);
          continue;
        }

        if (!needsBulk) {
          skipped += 1;
          await markProcessed(1);
          continue;
        }

        pendingProductsUpdate.push(state);
        if (pendingProductsUpdate.length >= this.productsUpdateBatchSize) {
          await flushProductsUpdate();
        }
      }

      await flushProductsUpdate();
    } catch (err) {
      if ((err as any)?.code === 'JOB_CANCELED') {
        canceled = true;
        pendingProductsUpdate.length = 0;
        await reportProgress(true, false);
      }
      throw err;
    }

    await reportProgress(true, true);

    // Operational summary across the whole run — surfaces in warnings tail and helps
    // operators spot mirror drift / fallback storms at a glance.
    if (bulkBatches > 0 || bulkFallbackBatches > 0) {
      const runSummary = {
        endpoint: this.bulkEndpoint,
        bulkBatches,
        bulkAccepted: bulkAcceptedTotal,
        bulkNotFound: bulkNotFoundTotal,
        bulkServerTimeSec: Number(bulkServerTimeSec.toFixed(3)),
        bulkFallbackBatches
      };
      this.appendWarning(warnings, `bulk run summary: ${JSON.stringify(runSummary)}`);
    }

    return { imported, failed, skipped, warnings };
  }
}
