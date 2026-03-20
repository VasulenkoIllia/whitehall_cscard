import fetch, { Response } from 'node-fetch';
import type { RequestInit } from 'node-fetch';
import { URL } from 'url';
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

  async importProducts(rows: CsCartImportRow[]): Promise<{ imported: number; failed: number; skipped: number; warnings: string[] }> {
    let imported = 0;
    let failed = 0;
    let skipped = 0;
    const warnings: string[] = [];
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      try {
        // Try to find existing product by code to decide PUT vs POST
        let productId: string | null = null;
        try {
          const lookup = await this.request(
            `/api/products?items_per_page=1&page=1&pcode_from_q=Y&q=${encodeURIComponent(row.productCode)}`
          );
          const found = Array.isArray(lookup.products) ? lookup.products[0] : null;
          if (found?.product_id) {
            productId = String(found.product_id);
          }
        } catch (lookupErr) {
          // ignore lookup errors, fallback to POST
        }

        const payload = {
          product_code: row.productCode,
          status: row.visibility ? 'A' : 'H',
          price: row.price ?? 0,
          parent_product_id: row.parentProductCode || 0
        };

        if (productId) {
          await this.request(`/api/products/${productId}`, {
            method: 'PUT',
            body: JSON.stringify(payload)
          });
        } else if (this.allowCreate) {
          await this.request('/api/products', {
            method: 'POST',
            body: JSON.stringify(payload)
          });
        } else {
          skipped += 1;
          warnings.push(`product_code=${row.productCode}: missing in store, skipped (update-only mode)`);
          continue;
        }

        imported += 1;
      } catch (err) {
        failed += 1;
        if (err instanceof Error) {
          warnings.push(`product_code=${row.productCode}: ${err.message}`);
        }
      }
    }
    return { imported, failed, skipped, warnings };
  }
}
