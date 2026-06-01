/**
 * One-time migration: REVERSE — переводить всі товари у CS-Cart зі status='D' (Disabled)
 * назад на status='H' (Hidden, повернення до старої бізнес-конвенції).
 *
 * Контекст:
 *   2026-05-08 ми зробили H → D (commit 923c7af). Тепер бізнес вирішив повернути H.
 *   Цей скрипт — інверсна версія старого migrateHiddenToDisabled.ts.
 *
 * Чому окремий скрипт, а не звичайний update_pipeline:
 *   Внутрішня нормалізація `normalizeStatus` трактує H і D як "не active"
 *   однаково. delta-filter порівнює `currentVisibility (false) === desiredVisibility (false)`
 *   і скіпає такі SKU. Тому regular pipeline не може примусити магазин з D на H —
 *   він "не бачить" diff. Цей скрипт обходить pipeline і шле bulk products_update
 *   напряму з payload `[{sku, status:'H'}]` для кожного знайденого D-SKU.
 *
 * Безпека:
 *   - Перед запуском вимкніть scheduler або заблокуйте ручні store_import,
 *     щоб mirror не сінкався під час write-фази.
 *   - DRY_RUN=true — лише сканує і друкує count, нічого не пише в магазин.
 *   - Snapshot SKU зберігається у /tmp/d_to_h_<timestamp>.json для rollback.
 *   - Idempotent: повторний запуск після часткової міграції підхопить лише
 *     ті SKU що залишилися у D.
 *
 * Налаштування через ENV:
 *   DRY_RUN=true                   — pre-flight без запису.
 *   MIGRATE_PAGE_SIZE=1000         — розмір GET-сторінки CS-Cart.
 *   MIGRATE_BATCH_SIZE=1000        — розмір bulk POST batch.
 *   MIGRATE_MAX_PAGES=1000         — захист від нескінченного циклу.
 *
 * Запуск:
 *   docker compose exec app node dist/scripts/migrateDisabledToHidden.js
 *
 * Перевірка результату:
 *   після завершення треба mirror_sync, щоб store_mirror підхопив нові H.
 *
 * Rollback (якщо щось пішло не так):
 *   До цього є commit-парою migrateHiddenToDisabled.ts (видалений 2026-05-27,
 *   можна відновити з git history commit 923c7af).
 */
import { writeFileSync } from 'fs';
import fetch from 'node-fetch';
import type { RequestInit } from 'node-fetch';
import { loadConfig } from '../core/config/loadConfig';

interface ProductRow {
  product_id: string;
  product_code: string;
  status: string;
}

interface ProductsResponse {
  products?: ProductRow[];
  params?: { total_items?: number | string };
}

interface ProductsUpdateResponse {
  status?: number;
  updated_products?: number;
  updated?: number;
  not_found_count?: number;
  not_found_skus?: string[];
  time?: number;
  message?: string;
  errors?: Array<{ sku?: string; field?: string; message?: string }>;
}

function readPositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.trunc(parsed);
}

async function csCartRequest(
  baseUrl: string,
  authHeader: string,
  path: string,
  init: RequestInit = {}
): Promise<unknown> {
  const url = new URL(path, baseUrl).toString();
  const resp = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers || {}),
      Authorization: authHeader
    }
  });
  const text = await resp.text();
  if (!resp.ok) {
    const truncated = text.length > 500 ? `${text.slice(0, 500)}...` : text;
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

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const baseUrl = config.connectors.cscart.baseUrl.replace(/\/+$/, '');
  const authHeader =
    'Basic ' +
    Buffer.from(
      `${config.connectors.cscart.apiUser}:${config.connectors.cscart.apiKey}`,
      'utf8'
    ).toString('base64');
  const pageSize = readPositiveInt(process.env.MIGRATE_PAGE_SIZE, 1000);
  const batchSize = readPositiveInt(process.env.MIGRATE_BATCH_SIZE, 1000);
  const maxPages = readPositiveInt(process.env.MIGRATE_MAX_PAGES, 1000);
  const dryRun = String(process.env.DRY_RUN || '').toLowerCase() === 'true';
  const rateLimitMs = Math.max(1, Math.floor(1000 / config.connectors.cscart.rateLimitRps));

  console.log(
    JSON.stringify(
      {
        baseUrl,
        pageSize,
        batchSize,
        maxPages,
        dryRun,
        rateLimitMs
      },
      null,
      2
    )
  );

  // ───── 1. SCAN ─────
  console.log('\n[1/3] Scanning catalog for status=D SKUs (to be converted to H)...');
  const disabled: Array<{ sku: string; product_id: string }> = [];
  let totalSeen = 0;
  let totalActive = 0;
  let totalHidden = 0;
  const scanStartedAt = Date.now();
  for (let page = 1; page <= maxPages; page += 1) {
    const data = (await csCartRequest(
      baseUrl,
      authHeader,
      `/api/products?items_per_page=${pageSize}&page=${page}`
    )) as ProductsResponse;
    const products = Array.isArray(data.products) ? data.products : [];
    if (!products.length) {
      break;
    }
    for (let i = 0; i < products.length; i += 1) {
      const p = products[i];
      const status = String(p.status || '').toUpperCase();
      const sku = String(p.product_code || '').trim();
      const pid = String(p.product_id || '').trim();
      if (!sku || !pid) continue;
      totalSeen += 1;
      if (status === 'A') totalActive += 1;
      else if (status === 'H') totalHidden += 1;
      else if (status === 'D') disabled.push({ sku, product_id: pid });
    }
    const totalItems = Number(data.params?.total_items || 0);
    const totalPages = totalItems > 0 ? Math.ceil(totalItems / pageSize) : page;
    if (page % 10 === 0 || page >= totalPages) {
      console.log(
        `  page ${page}/${totalPages} seen=${totalSeen} disabled=${disabled.length} active=${totalActive} hidden=${totalHidden}`
      );
    }
    if (page >= totalPages) {
      break;
    }
    await sleep(rateLimitMs);
  }
  const scanDurationSec = Math.round((Date.now() - scanStartedAt) / 1000);
  console.log(
    `  scan done: total=${totalSeen} active=${totalActive} disabled=${disabled.length} hidden=${totalHidden} (${scanDurationSec}s)`
  );

  if (disabled.length === 0) {
    console.log('\n✅ No D-status SKUs found. Nothing to migrate.');
    return;
  }

  const snapshotPath = `/tmp/d_to_h_${Date.now()}.json`;
  writeFileSync(snapshotPath, JSON.stringify(disabled, null, 2), 'utf8');
  console.log(`  snapshot saved: ${snapshotPath}  (use it for rollback if needed)`);

  if (dryRun) {
    console.log('\n[DRY_RUN] would migrate', disabled.length, 'SKUs from D to H. Exiting without writes.');
    return;
  }

  // ───── 2. BULK UPDATE ─────
  console.log(`\n[2/3] Updating ${disabled.length} SKUs to status=H via bulk products_update...`);
  let updated = 0;
  let notFound = 0;
  let serverTimeSec = 0;
  let batchSeq = 0;
  const writeStartedAt = Date.now();
  for (let offset = 0; offset < disabled.length; offset += batchSize) {
    const chunk = disabled.slice(offset, offset + batchSize);
    const payload = chunk.map((d) => ({ sku: d.sku, status: 'H' }));
    batchSeq += 1;
    try {
      const resp = (await csCartRequest(baseUrl, authHeader, '/api/products_update', {
        method: 'POST',
        body: JSON.stringify(payload)
      })) as ProductsUpdateResponse;
      const upd = Number.isFinite(Number(resp.updated_products))
        ? Number(resp.updated_products)
        : Number(resp.updated || 0);
      const nf = Number.isFinite(Number(resp.not_found_count))
        ? Number(resp.not_found_count)
        : 0;
      const t = Number.isFinite(Number(resp.time)) ? Number(resp.time) : 0;
      updated += upd;
      notFound += nf;
      serverTimeSec += t;
      console.log(
        `  batch ${batchSeq} size=${chunk.length} updated=${upd} not_found=${nf} time=${t}s`
      );
      if (Array.isArray(resp.not_found_skus) && resp.not_found_skus.length > 0) {
        console.log(`    not_found sample:`, resp.not_found_skus.slice(0, 5));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  batch ${batchSeq} FAILED:`, message);
      throw err;
    }
    await sleep(rateLimitMs);
  }
  const writeDurationSec = Math.round((Date.now() - writeStartedAt) / 1000);

  // ───── 3. VERIFY ─────
  console.log(
    `\n[3/3] Done. updated=${updated} not_found=${notFound} server=${serverTimeSec.toFixed(2)}s wall=${writeDurationSec}s`
  );

  // Sample 3 SKU for sanity check
  console.log('\nSanity sample (first 3 SKUs):');
  for (let i = 0; i < Math.min(3, disabled.length); i += 1) {
    const { sku, product_id } = disabled[i];
    try {
      const data = (await csCartRequest(
        baseUrl,
        authHeader,
        `/api/products/${product_id}`
      )) as { status?: string; product_code?: string };
      console.log(`  ${sku} (id=${product_id}): status=${data.status}`);
    } catch (err) {
      console.error(`  ${sku}: GET failed:`, err instanceof Error ? err.message : err);
    }
  }

  console.log(
    '\n✅ Migration complete. Run store_mirror_sync to refresh local mirror with new H statuses.'
  );
  console.log(`   Snapshot: ${snapshotPath}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : err);
  process.exit(1);
});
