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
  }

  private normalizeProductCode(value: unknown): string {
    return String(value || '').trim();
  }

  private normalizeStatus(value: unknown): 'A' | 'H' {
    const normalized = String(value || '').toUpperCase();
    return normalized === 'A' ? 'A' : 'H';
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

  private async fetchProductIndexByCode(): Promise<
    Map<
      string,
      {
        productId: string;
        status: 'A' | 'H';
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
        status: 'A' | 'H';
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
    current: { status: 'A' | 'H'; amount: number; price: number; parentProductId: string | null },
    next: { status: 'A' | 'H'; amount: number; price: number; parentProductId: string | null }
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

  private async request(path: string, init: RequestInit & { retry?: number } = {}): Promise<any> {
    await this.acquireToken();
    const url = new URL(path, this.baseUrl).toString();
    const resp: Response = await fetch(url, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(init.headers || {}),
        Authorization: this.authHeader
      }
    });

    if (resp.status === 429 || resp.status >= 500) {
      const retry = (init.retry || 0) + 1;
      if (retry <= this.retryLimit) {
        const retryAfter = Number(resp.headers.get('Retry-After')) * 1000 || 15000 * retry;
        await sleep(retryAfter);
        return this.request(path, { ...init, retry });
      }
    }

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`CS-Cart API error ${resp.status}: ${text}`);
    }

    const data = await resp.json();
    return data;
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

    await reportProgress(true, false);

    const worker = async (): Promise<void> => {
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
        const desiredAmount = row.visibility ? 1 : 0;
        const desiredStatus = row.visibility ? 'A' as const : 'H' as const;
        const desiredPrice = this.normalizePrice(row.price);

        // Resolve productId and parentProductId.
        // Prefer pre-resolved values from store_mirror (row.productId !== undefined).
        // Fall back to the API index only when mirror was stale/empty.
        let productId: string | null;
        let parentProductId: string | null;

        if (row.productId !== undefined) {
          // Normal path: enriched by filterCsCartDelta (fresh mirror)
          productId = row.productId || null;
          parentProductId = row.resolvedParentProductId ?? null;
        } else {
          // Fallback path: mirror was stale, use API index
          const fromIndex = indexByCode?.get(productCode) || null;
          const parentCode = this.normalizeProductCode(row.parentProductCode);
          const parentFromIndex = parentCode && indexByCode ? indexByCode.get(parentCode) || null : null;
          productId = fromIndex?.productId || null;
          parentProductId = parentFromIndex?.productId || null;

          // Second-level delta check (filterCsCartDelta was bypassed in stale mirror case)
          if (fromIndex) {
            const desiredState = { status: desiredStatus, amount: desiredAmount, price: desiredPrice, parentProductId };
            if (this.isSameProductState(fromIndex, desiredState)) {
              skipped += 1;
              continue;
            }
          }
        }

        // Only include parent_product_id when we have an explicit value to set.
        // Sending parent_product_id: 0 for a CS-Cart variant product causes CS-Cart
        // to reject or silently ignore the entire PUT (including the amount update).
        const payload: Record<string, unknown> = {
          product_code: productCode,
          status: desiredStatus,
          amount: desiredAmount,
          price: desiredPrice,
        };
        if (parentProductId !== null) {
          payload.parent_product_id = parentProductId;
        }

        try {
          if (productId) {
            await this.request(`/api/products/${productId}`, {
              method: 'PUT',
              body: JSON.stringify(payload)
            });
            imported += 1;
            continue;
          }

          if (!this.allowCreate) {
            skipped += 1;
            this.appendWarning(
              warnings,
              `product_code=${productCode}: missing in store, skipped (update-only mode)`
            );
            continue;
          }

          const created = await this.request('/api/products', {
            method: 'POST',
            body: JSON.stringify(payload)
          });
          const createdProductId = String(
            created?.product_id || created?.response?.product_id || ''
          ).trim();
          if (createdProductId && indexByCode) {
            indexByCode.set(productCode, {
              productId: createdProductId,
              status: desiredStatus,
              amount: desiredAmount,
              price: desiredPrice,
              parentProductId
            });
          }
          imported += 1;
        } catch (err) {
          if ((err as any)?.code === 'JOB_CANCELED') {
            throw err;
          }
          failed += 1;
          if (err instanceof Error) {
            this.appendWarning(warnings, `product_code=${productCode}: ${err.message}`);
          } else {
            this.appendWarning(warnings, `product_code=${productCode}: import failed`);
          }
        } finally {
          runProcessed += 1;
          await reportProgress(false, false);
        }
      }
    };

    const workerCount = Math.max(1, Math.min(this.importConcurrency, totalRows || 1));
    const workers: Promise<void>[] = [];
    for (let index = 0; index < workerCount; index += 1) {
      workers.push(worker());
    }
    try {
      await Promise.all(workers);
    } catch (err) {
      if ((err as any)?.code === 'JOB_CANCELED') {
        canceled = true;
        await reportProgress(true, false);
      }
      throw err;
    }
    await reportProgress(true, true);

    return { imported, failed, skipped, warnings };
  }
}
