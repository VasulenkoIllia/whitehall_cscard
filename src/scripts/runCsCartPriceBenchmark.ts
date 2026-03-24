import fs from 'fs';
import path from 'path';
import { createApplication } from '../app/createApplication';
import type { StoreConnector } from '../core/connectors/StoreConnector';
import type { MirrorRow } from '../core/domain/store';
import type { CsCartImportRow } from '../connectors/cscart/CsCartConnector';

interface RawProductPayload {
  product_id?: string;
  parent_product_id?: string;
  status?: string;
  price?: string | number | null;
}

interface BenchmarkRowState {
  article: string;
  productId: string;
  parentProductCode: string | null;
  originalPrice: number;
  newPrice: number;
  originalVisibility: boolean;
}

interface BenchmarkPhaseResult {
  phase: 'apply_plus_delta' | 'rollback';
  durationMs: number;
  imported: number;
  skipped: number;
  failed: number;
  warningsCount: number;
}

function readPositiveInt(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.trunc(parsed);
}

function readBoolean(name: string, fallback: boolean): boolean {
  const raw = String(process.env[name] || '').trim().toLowerCase();
  if (!raw) {
    return fallback;
  }
  return raw === '1' || raw === 'true' || raw === 'yes';
}

function normalizeArticle(value: unknown): string {
  return String(value || '').trim();
}

function normalizeProductId(value: unknown): string {
  return String(value || '').trim();
}

function normalizeParentProductId(value: unknown): string | null {
  const normalized = String(value || '').trim();
  if (!normalized || normalized === '0') {
    return null;
  }
  return normalized;
}

function normalizePrice(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return Number(parsed.toFixed(2));
}

function toMs(startedAt: bigint): number {
  return Number((process.hrtime.bigint() - startedAt) / BigInt(1_000_000));
}

function mapImportResult(payload: unknown): {
  imported: number;
  skipped: number;
  failed: number;
  warningsCount: number;
} {
  const data = (payload || {}) as Record<string, unknown>;
  const warningsRaw = Array.isArray(data.warnings) ? data.warnings : [];
  return {
    imported: Number(data.imported || 0),
    skipped: Number(data.skipped || 0),
    failed: Number(data.failed || 0),
    warningsCount: warningsRaw.length
  };
}

function ensureConfirmationFlag(): void {
  if (process.env.CSCART_PRICE_BENCHMARK_CONFIRM !== 'YES') {
    throw new Error(
      'Set CSCART_PRICE_BENCHMARK_CONFIRM=YES to run destructive benchmark (+delta update + rollback).'
    );
  }
}

function buildImportRows(
  states: BenchmarkRowState[],
  mode: 'apply_plus_delta' | 'rollback'
): CsCartImportRow[] {
  return states.map((item) => ({
    productCode: item.article,
    size: null,
    supplier: null,
    parentProductCode: item.parentProductCode,
    visibility: item.originalVisibility,
    price: mode === 'apply_plus_delta' ? item.newPrice : item.originalPrice
  }));
}

async function collectBenchmarkRows(
  items: MirrorRow[],
  limit: number,
  priceDelta: number,
  includeHidden: boolean
): Promise<BenchmarkRowState[]> {
  const idToCode = new Map<string, string>();
  const prepared: Array<{
    article: string;
    productId: string;
    parentProductId: string | null;
    price: number;
    visibility: boolean;
  }> = [];

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const article = normalizeArticle(item.article);
    if (!article) {
      continue;
    }
    const raw = (item.raw || {}) as RawProductPayload;
    const productId = normalizeProductId(raw.product_id);
    if (!productId) {
      continue;
    }
    const parentProductId = normalizeParentProductId(raw.parent_product_id);
    const visibility = String(raw.status || '').toUpperCase() === 'A';
    if (!includeHidden && !visibility) {
      continue;
    }
    idToCode.set(productId, article);
    prepared.push({
      article,
      productId,
      parentProductId,
      price: normalizePrice(raw.price ?? item.price),
      visibility
    });
  }

  prepared.sort((left, right) => left.article.localeCompare(right.article));
  const limited = prepared.slice(0, Math.min(limit, prepared.length));

  const states: BenchmarkRowState[] = limited.map((item) => ({
    article: item.article,
    productId: item.productId,
    parentProductCode: item.parentProductId ? idToCode.get(item.parentProductId) || null : null,
    originalPrice: item.price,
    newPrice: Number((item.price + priceDelta).toFixed(2)),
    originalVisibility: item.visibility
  }));

  return states;
}

async function runPhase(
  connector: StoreConnector<CsCartImportRow>,
  phase: 'apply_plus_delta' | 'rollback',
  rows: CsCartImportRow[]
): Promise<BenchmarkPhaseResult> {
  const startedAt = process.hrtime.bigint();
  const result = await connector.importBatch({
    store: 'cscart',
    rows,
    meta: {
      benchmark: true,
      phase
    }
  });
  const mapped = mapImportResult(result);
  return {
    phase,
    durationMs: toMs(startedAt),
    imported: mapped.imported,
    skipped: mapped.skipped,
    failed: mapped.failed,
    warningsCount: mapped.warningsCount
  };
}

async function main() {
  ensureConfirmationFlag();
  const targetRows = readPositiveInt('CSCART_PRICE_BENCHMARK_LIMIT', 10000);
  const priceDelta = Number(process.env.CSCART_PRICE_BENCHMARK_DELTA || 100);
  const includeHidden = readBoolean('CSCART_PRICE_BENCHMARK_INCLUDE_HIDDEN', true);
  if (!Number.isFinite(priceDelta)) {
    throw new Error('CSCART_PRICE_BENCHMARK_DELTA must be a finite number');
  }

  const application = createApplication(process.env);
  const startedAt = process.hrtime.bigint();
  let rollbackFile = '';
  try {
    if (application.connector.store !== 'cscart') {
      throw new Error(`Active store must be cscart, received ${application.connector.store}`);
    }

    const connector = application.connector as StoreConnector<CsCartImportRow>;
    const items: MirrorRow[] = [];
    let pages = 0;
    await application.pipeline.forEachStoreMirrorPage((pageItems, pageNo) => {
      pages = pageNo;
      for (let index = 0; index < pageItems.length; index += 1) {
        items.push(pageItems[index]);
      }
    });

    const states = await collectBenchmarkRows(items, targetRows, priceDelta, includeHidden);
    if (!states.length) {
      throw new Error('No eligible products found for benchmark');
    }

    rollbackFile = path.join(
      '/tmp',
      `cscart_price_benchmark_rollback_${new Date().toISOString().replace(/[:.]/g, '-')}.json`
    );
    fs.writeFileSync(
      rollbackFile,
      JSON.stringify(
        {
          createdAt: new Date().toISOString(),
          baseUrl: process.env.CSCART_BASE_URL || null,
          totalRows: states.length,
          priceDelta,
          rows: states.map((item) => ({
            article: item.article,
            productId: item.productId,
            parentProductCode: item.parentProductCode,
            originalPrice: item.originalPrice,
            originalVisibility: item.originalVisibility
          }))
        },
        null,
        2
      ),
      'utf8'
    );

    const applyRows = buildImportRows(states, 'apply_plus_delta');
    const rollbackRows = buildImportRows(states, 'rollback');

    const applyResult = await runPhase(connector, 'apply_plus_delta', applyRows);
    const rollbackResult = await runPhase(connector, 'rollback', rollbackRows);

    const applySeconds = applyResult.durationMs / 1000;
    const rollbackSeconds = rollbackResult.durationMs / 1000;
    const applyRate =
      applySeconds > 0
        ? Number(((applyResult.imported + applyResult.skipped + applyResult.failed) / applySeconds).toFixed(2))
        : null;
    const rollbackRate =
      rollbackSeconds > 0
        ? Number(
            ((rollbackResult.imported + rollbackResult.skipped + rollbackResult.failed) / rollbackSeconds).toFixed(
              2
            )
          )
        : null;

    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify(
        {
          ok: true,
          store: application.connector.store,
          baseUrl: process.env.CSCART_BASE_URL || null,
          fetchedFromStore: items.length,
          pagesFetched: pages,
          benchmarkRows: states.length,
          priceDelta,
          includeHidden,
          rollbackFile,
          phases: [applyResult, rollbackResult],
          ratesPerSecond: {
            apply: applyRate,
            rollback: rollbackRate
          },
          totalDurationMs: toMs(startedAt)
        },
        null,
        2
      )
    );
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(
      JSON.stringify(
        {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          rollbackFile: rollbackFile || null
        },
        null,
        2
      )
    );
    process.exitCode = 1;
  } finally {
    await application.close();
  }
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
