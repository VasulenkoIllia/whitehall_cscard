import fs from 'fs';
import { createApplication } from '../app/createApplication';
import type { StoreConnector } from '../core/connectors/StoreConnector';
import type { CsCartImportRow } from '../connectors/cscart/CsCartConnector';

interface RollbackFileRow {
  article: string;
  parentProductCode: string | null;
  originalPrice: number;
  originalVisibility: boolean;
}

interface RollbackFilePayload {
  rows?: RollbackFileRow[];
}

function readPositiveInt(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.trunc(parsed);
}

function parseImportWarningsCodes(warnings: string[]): Set<string> {
  const codes = new Set<string>();
  for (let index = 0; index < warnings.length; index += 1) {
    const warning = String(warnings[index] || '');
    const match = warning.match(/product_code=([^:]+):/i);
    if (match && match[1]) {
      codes.add(String(match[1]).trim());
    }
  }
  return codes;
}

function toRollbackRows(rows: RollbackFileRow[]): CsCartImportRow[] {
  return rows
    .map((row) => ({
      productCode: String(row.article || '').trim(),
      size: null,
      supplier: null,
      parentProductCode:
        row.parentProductCode === null || typeof row.parentProductCode === 'undefined'
          ? null
          : String(row.parentProductCode).trim() || null,
      visibility: row.originalVisibility === true,
      price: Number.isFinite(Number(row.originalPrice)) ? Number(row.originalPrice) : 0
    }))
    .filter((row) => row.productCode.length > 0);
}

async function main() {
  const rollbackFile = String(process.env.CSCART_ROLLBACK_FILE || '').trim();
  if (!rollbackFile) {
    throw new Error('CSCART_ROLLBACK_FILE is required');
  }
  if (process.env.CSCART_ROLLBACK_CONFIRM !== 'YES') {
    throw new Error('Set CSCART_ROLLBACK_CONFIRM=YES to execute rollback from file');
  }

  const retries = readPositiveInt('CSCART_ROLLBACK_RETRIES', 3);
  const fileRaw = fs.readFileSync(rollbackFile, 'utf8');
  const payload = JSON.parse(fileRaw) as RollbackFilePayload;
  const sourceRows = Array.isArray(payload.rows) ? payload.rows : [];
  if (!sourceRows.length) {
    throw new Error('Rollback file has no rows');
  }

  const application = createApplication(process.env);
  try {
    if (application.connector.store !== 'cscart') {
      throw new Error(`Active store must be cscart, received ${application.connector.store}`);
    }
    const connector = application.connector as StoreConnector<CsCartImportRow>;

    let pendingRows = toRollbackRows(sourceRows);
    const attempts: Array<{
      attempt: number;
      input: number;
      imported: number;
      skipped: number;
      failed: number;
      warningsCount: number;
    }> = [];

    for (let attempt = 1; attempt <= retries; attempt += 1) {
      if (!pendingRows.length) {
        break;
      }
      const resultRaw = await connector.importBatch({
        store: 'cscart',
        rows: pendingRows,
        meta: {
          rollbackFromFile: rollbackFile,
          attempt
        }
      });
      const result = (resultRaw || {}) as unknown as Record<string, unknown>;
      const warnings = Array.isArray(result.warnings)
        ? result.warnings.map((item) => String(item))
        : [];
      const failed = Number(result.failed || 0);
      attempts.push({
        attempt,
        input: pendingRows.length,
        imported: Number(result.imported || 0),
        skipped: Number(result.skipped || 0),
        failed,
        warningsCount: warnings.length
      });

      if (failed <= 0) {
        pendingRows = [];
        break;
      }

      const failedCodes = parseImportWarningsCodes(warnings);
      if (!failedCodes.size) {
        break;
      }
      pendingRows = pendingRows.filter((row) => failedCodes.has(row.productCode));
    }

    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify(
        {
          ok: pendingRows.length === 0,
          rollbackFile,
          attempts,
          remainingRows: pendingRows.length,
          remainingCodes: pendingRows.slice(0, 20).map((row) => row.productCode)
        },
        null,
        2
      )
    );
    if (pendingRows.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    await application.close();
  }
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
