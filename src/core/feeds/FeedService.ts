import type { Pool, PoolClient } from 'pg';
import type { LogService } from '../pipeline/log';
import { FeedDownloader } from './FeedDownloader';
import { YmlFeedParser } from './YmlFeedParser';
import { XlsxFeedParser } from './XlsxFeedParser';
import type { FeedConfig, FeedFormat, FeedItem, FeedParser } from './types';
import { extractSku } from './types';

/**
 * FeedService — CRUD для feeds + import workflow.
 *
 * Імпорт:
 *   1. Download URL → Buffer.
 *   2. Pick parser by config.format.
 *   3. Parse content → items[].
 *   4. Для кожного item:
 *      - sku = extractSku(item, config.skuField). Спец для XLSX — '__col_A' fallback.
 *      - UPDATE master_catalog SET feed_params = jsonb_set(..., '{<feed.name>}', item)
 *        WHERE sku = <item.sku>
 *   5. Запис у feed_imports + feeds.last_* fields.
 */

export interface FeedRecord {
  id: number;
  name: string;
  url: string;
  format: FeedFormat;
  sku_field: string;
  options: Record<string, unknown>;
  is_active: boolean;
  last_imported_at: string | null;
  last_items_count: number | null;
  last_matched_count: number | null;
  last_status: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface FeedCreatePayload {
  name: string;
  url: string;
  format: FeedFormat;
  sku_field: string;
  options?: Record<string, unknown> | null;
  is_active?: boolean;
}

export interface FeedUpdatePayload {
  name?: string;
  url?: string;
  format?: FeedFormat;
  sku_field?: string;
  options?: Record<string, unknown> | null;
  is_active?: boolean;
}

export interface FeedImportSummary {
  importId: number;
  jobId: number;
  feedId: number;
  feedName: string;
  itemsCount: number;
  matchedCount: number;
  unmatchedCount: number;
  downloadMs: number;
  parseMs: number;
  matchMs: number;
  durationMs: number;
}

export class FeedService {
  private readonly parsers = new Map<FeedFormat, FeedParser>();
  private readonly downloader = new FeedDownloader();

  constructor(
    private readonly pool: Pool,
    private readonly logs: LogService
  ) {
    const yml = new YmlFeedParser();
    this.parsers.set('yml', yml);
    this.parsers.set('xml', yml); // XML = той самий парсер, тільки структура може відрізнятись
    this.parsers.set('xlsx', new XlsxFeedParser());
  }

  // ─── CRUD ──────────────────────────────────────────────────────────────────

  async list(): Promise<FeedRecord[]> {
    const res = await this.pool.query<FeedRecord>(
      `SELECT id, name, url, format, sku_field, options, is_active,
              last_imported_at, last_items_count, last_matched_count,
              last_status, last_error, created_at, updated_at
         FROM feeds ORDER BY name`
    );
    return res.rows;
  }

  async getById(id: number): Promise<FeedRecord | null> {
    const res = await this.pool.query<FeedRecord>(
      `SELECT id, name, url, format, sku_field, options, is_active,
              last_imported_at, last_items_count, last_matched_count,
              last_status, last_error, created_at, updated_at
         FROM feeds WHERE id = $1`,
      [id]
    );
    return res.rowCount === 0 ? null : res.rows[0];
  }

  async create(payload: FeedCreatePayload): Promise<FeedRecord> {
    this.validatePayload(payload);
    const res = await this.pool.query<FeedRecord>(
      `INSERT INTO feeds (name, url, format, sku_field, options, is_active)
       VALUES ($1, $2, $3, $4, $5::jsonb, COALESCE($6, TRUE))
       RETURNING id, name, url, format, sku_field, options, is_active,
                 last_imported_at, last_items_count, last_matched_count,
                 last_status, last_error, created_at, updated_at`,
      [
        payload.name.trim(),
        payload.url.trim(),
        payload.format,
        payload.sku_field.trim(),
        JSON.stringify(payload.options || {}),
        payload.is_active ?? true
      ]
    );
    return res.rows[0];
  }

  async update(id: number, payload: FeedUpdatePayload): Promise<FeedRecord> {
    const existing = await this.getById(id);
    if (!existing) {
      const err = new Error(`Feed #${id} не знайдено`);
      (err as { status?: number }).status = 404;
      throw err;
    }
    const merged: FeedCreatePayload = {
      name: payload.name?.trim() || existing.name,
      url: payload.url?.trim() || existing.url,
      format: payload.format || existing.format,
      sku_field: payload.sku_field?.trim() || existing.sku_field,
      options:
        typeof payload.options !== 'undefined'
          ? payload.options
          : existing.options,
      is_active: typeof payload.is_active === 'boolean' ? payload.is_active : existing.is_active
    };
    this.validatePayload(merged);

    const res = await this.pool.query<FeedRecord>(
      `UPDATE feeds
          SET name = $2, url = $3, format = $4, sku_field = $5,
              options = $6::jsonb, is_active = $7, updated_at = NOW()
        WHERE id = $1
        RETURNING id, name, url, format, sku_field, options, is_active,
                  last_imported_at, last_items_count, last_matched_count,
                  last_status, last_error, created_at, updated_at`,
      [
        id,
        merged.name,
        merged.url,
        merged.format,
        merged.sku_field,
        JSON.stringify(merged.options || {}),
        merged.is_active
      ]
    );
    return res.rows[0];
  }

  async delete(id: number): Promise<void> {
    await this.pool.query(`DELETE FROM feeds WHERE id = $1`, [id]);
  }

  // ─── Import workflow ───────────────────────────────────────────────────────

  /**
   * Запускається з job runner. jobId — current feed_import job id.
   */
  async importFeed(jobId: number, feedId: number): Promise<FeedImportSummary> {
    const feed = await this.getById(feedId);
    if (!feed) {
      const err = new Error(`Feed #${feedId} не знайдено`);
      (err as { status?: number }).status = 404;
      throw err;
    }

    const startedAt = Date.now();
    let importId = 0;

    // Створюємо запис feed_imports.
    const runRes = await this.pool.query<{ id: number }>(
      `INSERT INTO feed_imports (feed_id, job_id, status)
       VALUES ($1, $2, 'running') RETURNING id::int AS id`,
      [feedId, jobId]
    );
    importId = runRes.rows[0].id;

    await this.logs.log(jobId, 'info', 'feed_import start', {
      feedId,
      feedName: feed.name,
      url: feed.url,
      format: feed.format
    });

    let downloadMs = 0;
    let parseMs = 0;
    let matchMs = 0;
    let itemsCount = 0;
    let matchedCount = 0;
    let unmatchedCount = 0;

    try {
      // 1. Download.
      const dl = await this.downloader.download(feed.url, { timeoutMs: 180_000 });
      downloadMs = dl.durationMs;
      await this.logs.log(jobId, 'info', 'feed downloaded', {
        bytes: dl.buffer.length,
        contentType: dl.contentType,
        downloadMs
      });

      // 2. Parse.
      const parser = this.parsers.get(feed.format);
      if (!parser) {
        throw new Error(`No parser for format "${feed.format}"`);
      }
      const config: FeedConfig = {
        id: feed.id,
        name: feed.name,
        url: feed.url,
        format: feed.format,
        skuField: feed.sku_field,
        options: feed.options || {}
      };
      const parsed = await parser.parse(dl.buffer, config);
      parseMs = parsed.parseMs;
      itemsCount = parsed.items.length;

      await this.logs.log(jobId, 'info', 'feed parsed', {
        itemsCount,
        parseMs
      });

      // 3. Match + write. Робимо batch update — групуємо items по 500 і pgsql robi UPSERT-style.
      const matchStartedAt = Date.now();
      const { matched, unmatched } = await this.matchAndStore(parsed.items, feed);
      matchedCount = matched;
      unmatchedCount = unmatched;
      matchMs = Date.now() - matchStartedAt;

      const durationMs = Date.now() - startedAt;

      // 4. Update feeds + feed_imports.
      await this.pool.query(
        `UPDATE feed_imports SET
           status = 'finished',
           items_count = $2, matched_count = $3, unmatched_count = $4,
           download_ms = $5, parse_ms = $6, match_ms = $7,
           duration_ms = $8, finished_at = NOW()
         WHERE id = $1`,
        [importId, itemsCount, matchedCount, unmatchedCount, downloadMs, parseMs, matchMs, durationMs]
      );
      await this.pool.query(
        `UPDATE feeds SET
           last_imported_at = NOW(),
           last_items_count = $2,
           last_matched_count = $3,
           last_status = 'success',
           last_error = NULL,
           updated_at = NOW()
         WHERE id = $1`,
        [feedId, itemsCount, matchedCount]
      );

      await this.logs.log(jobId, 'info', 'feed_import finished', {
        itemsCount, matchedCount, unmatchedCount, durationMs
      });

      return {
        importId, jobId, feedId, feedName: feed.name,
        itemsCount, matchedCount, unmatchedCount,
        downloadMs, parseMs, matchMs, durationMs
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const durationMs = Date.now() - startedAt;
      await this.pool
        .query(
          `UPDATE feed_imports
              SET status = 'failed', error = $2, duration_ms = $3, finished_at = NOW(),
                  items_count = $4, matched_count = $5, unmatched_count = $6,
                  download_ms = $7, parse_ms = $8, match_ms = $9
            WHERE id = $1`,
          [importId, errorMessage, durationMs, itemsCount, matchedCount, unmatchedCount,
           downloadMs, parseMs, matchMs]
        )
        .catch(() => undefined);
      await this.pool
        .query(
          `UPDATE feeds
              SET last_imported_at = NOW(),
                  last_status = 'failed',
                  last_error = $2,
                  updated_at = NOW()
            WHERE id = $1`,
          [feedId, errorMessage]
        )
        .catch(() => undefined);
      throw err;
    }
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  /**
   * Для кожного item:
   *   - витягуємо sku (з підтримкою __col_X для xlsx)
   *   - UPDATE master_catalog якщо знайдено
   *
   * Робимо batched — кожен batch як одна транзакція через temp table.
   */
  private async matchAndStore(
    items: FeedItem[],
    feed: FeedRecord
  ): Promise<{ matched: number; unmatched: number }> {
    const batchSize = 500;
    let matched = 0;
    let unmatched = 0;

    // Підготовка skuField для XLSX — додаткова логіка спрямувати "A"/"B" → "__col_A".
    const skuKey = feed.format === 'xlsx' && /^[A-Z]+$/.test(feed.sku_field)
      ? `__col_${feed.sku_field}`
      : feed.sku_field;

    // Спершу dedup по SKU — якщо один SKU зустрічається кілька разів у фіді
    // (різні розміри як окремі offers), беремо ПЕРШИЙ. Це уникає ON CONFLICT race
    // у batch INSERT нижче.
    const dedupedMap = new Map<string, FeedItem>();
    for (const item of items) {
      const sku = extractSku(item, skuKey);
      if (sku && !dedupedMap.has(sku)) {
        dedupedMap.set(sku, item);
      } else if (!sku) {
        unmatched += 1;
      }
    }
    const deduped: Array<{ sku: string; item: FeedItem }> = Array.from(dedupedMap.entries())
      .map(([sku, item]) => ({ sku, item }));

    for (let i = 0; i < deduped.length; i += batchSize) {
      const batch = deduped.slice(i, i + batchSize);
      const pairs = batch;

      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');

        // Створюємо temp table для batch update.
        await client.query(
          `CREATE TEMP TABLE _feed_batch (sku TEXT PRIMARY KEY, item JSONB) ON COMMIT DROP`
        );

        // Insert батч-ом через unnest. Дублі вже відфільтровані вище — без ON CONFLICT.
        const skus = pairs.map((p) => p.sku);
        const itemJsons = pairs.map((p) => JSON.stringify(p.item));
        await client.query(
          `INSERT INTO _feed_batch (sku, item)
             SELECT * FROM UNNEST($1::text[], $2::jsonb[])`,
          [skus, itemJsons]
        );

        // UPDATE master_catalog для тих хто є.
        const updateRes = await client.query<{ updated: number }>(
          `WITH upd AS (
             UPDATE master_catalog mc
                SET feed_params = jsonb_set(
                      COALESCE(mc.feed_params, '{}'::jsonb),
                      ARRAY[$1::text],
                      jsonb_build_object(
                        'imported_at', to_jsonb(NOW()),
                        'feed_id',     to_jsonb($2::bigint),
                        'data',        b.item
                      ),
                      true
                    ),
                    feed_matched_at = NOW(),
                    feed_source = $1,
                    updated_at = NOW()
               FROM _feed_batch b
              WHERE mc.sku = b.sku
              RETURNING mc.id
           )
           SELECT COUNT(*)::int AS updated FROM upd`,
          [feed.name, feed.id]
        );
        const updatedCount = updateRes.rows[0]?.updated || 0;
        matched += updatedCount;
        unmatched += batch.length - updatedCount;

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    }

    return { matched, unmatched };
  }

  async listImportRuns(feedId: number, limit = 10): Promise<Array<Record<string, unknown>>> {
    const res = await this.pool.query(
      `SELECT id, feed_id, job_id, status, items_count, matched_count, unmatched_count,
              download_ms, parse_ms, match_ms, duration_ms, error, started_at, finished_at
         FROM feed_imports
        WHERE feed_id = $1
        ORDER BY id DESC LIMIT $2`,
      [feedId, Math.min(50, Math.max(1, limit))]
    );
    return res.rows;
  }

  private validatePayload(p: { name: string; url: string; format: string; sku_field: string }): void {
    if (!p.name || !p.name.trim()) throw new Error('Поле name обовʼязкове');
    if (!p.url || !/^https?:\/\//i.test(p.url)) throw new Error('Поле url має бути http(s) URL');
    if (!['yml', 'xml', 'xlsx'].includes(p.format)) {
      throw new Error('Format має бути yml / xml / xlsx');
    }
    if (!p.sku_field || !p.sku_field.trim()) throw new Error('Поле sku_field обовʼязкове');
  }
}
