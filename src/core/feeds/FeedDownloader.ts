import fetch from 'node-fetch';

/**
 * FeedDownloader — тягне URL → повертає Buffer.
 *
 * Для shopua YML (56MB) робить streaming — не висить на дрібному timeout.
 * Для xlsx (3-10MB) звичайний buffer.
 */

export interface DownloadResult {
  buffer: Buffer;
  contentType: string | null;
  durationMs: number;
}

export interface DownloadOptions {
  timeoutMs?: number;     // default 120000 (2 хв — досить для 56MB)
  maxBytes?: number;      // default 500MB
  userAgent?: string;
}

export class FeedDownloader {
  async download(url: string, options: DownloadOptions = {}): Promise<DownloadResult> {
    const timeoutMs = options.timeoutMs ?? 120_000;
    const maxBytes = options.maxBytes ?? 500 * 1024 * 1024;
    const userAgent =
      options.userAgent || 'WhitehallShop/1.0 (+https://whitehallshop.workflo.space)';

    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        headers: { 'user-agent': userAgent, accept: '*/*' },
        redirect: 'follow',
        signal: controller.signal as unknown as AbortSignal
      });
      if (!res.ok) {
        throw new Error(`Feed download failed: HTTP ${res.status} ${res.statusText}`);
      }
      // node-fetch v2: res.buffer() повертає Buffer.
      const buffer = await (res as any).buffer();
      if (buffer.length > maxBytes) {
        throw new Error(
          `Feed too large: ${buffer.length} bytes (max ${maxBytes})`
        );
      }
      return {
        buffer,
        contentType: res.headers.get('content-type'),
        durationMs: Date.now() - startedAt
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
