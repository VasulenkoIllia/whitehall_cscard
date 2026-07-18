import { google } from 'googleapis';

// Google Sheets WRITER — deliberately a separate module from googleSheetsService
// (the read-only importer). Two hard isolation rules live here:
//   1. Its own JWT client requests the read/WRITE scope 'spreadsheets'.
//   2. Its own leaky-bucket slot (`writeNextRequestAt`), NOT the read-side
//      `nextRequestAt`. A write-quota backoff must never stall scheduled supplier
//      imports (and vice-versa). Sheets read and write quotas are separate buckets,
//      so coupling their limiters would be a self-inflicted stall.

const minIntervalMs = Number(
  process.env.GOOGLE_SHEETS_WRITE_MIN_INTERVAL_MS ||
    process.env.GOOGLE_SHEETS_MIN_INTERVAL_MS ||
    1200
);
const quotaBackoffMs = Number(process.env.GOOGLE_SHEETS_QUOTA_BACKOFF_MS || 60000);
const maxRetriesRaw = Number(process.env.GOOGLE_SHEETS_MAX_RETRIES ?? 0);
const defaultBatchRows = Math.max(
  500,
  Number(process.env.GOOGLE_SHEETS_WRITE_BATCH_ROWS || 10000)
);

// Idempotent global; also set by the read module. 60s hard timeout per HTTP call.
google.options({ timeout: 60_000 });

// Dedicated WRITE-side leaky bucket (see isolation rule #2 above).
let writeNextRequestAt = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isQuotaError(err: any): boolean {
  const message = err?.response?.data?.error?.message || err?.message || '';
  const reason = err?.response?.data?.error?.errors?.[0]?.reason || '';
  const status = err?.response?.status || err?.code || null;
  return (
    status === 429 ||
    reason === 'rateLimitExceeded' ||
    reason === 'userRateLimitExceeded' ||
    /quota exceeded|rate limit|requests per minute per user/i.test(message)
  );
}

function isTransientNetworkError(err: any): boolean {
  const code = err?.code;
  if (code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ECONNABORTED') return true;
  if (err?.name === 'AbortError') return true;
  const message = String(err?.message || '');
  return /timeout|timed out|socket hang up|ECONN(RESET|ABORTED|REFUSED)/i.test(message);
}

async function writeWithRetry<T>(fn: () => Promise<T>): Promise<T> {
  let attempt = 0;
  const maxRetries = Number.isFinite(maxRetriesRaw) ? maxRetriesRaw : 0;
  const maxAttempts = maxRetries <= 0 ? 3 : maxRetries;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const now = Date.now();
      const mySlot = Math.max(now, writeNextRequestAt);
      writeNextRequestAt = mySlot + minIntervalMs;
      const waitMs = mySlot - now;
      if (waitMs > 0) {
        await sleep(waitMs);
      }
      return await fn();
    } catch (err) {
      const retryable = isQuotaError(err) || isTransientNetworkError(err);
      if (!retryable || attempt >= maxAttempts) {
        throw err;
      }
      attempt += 1;
      const backoffMs = isQuotaError(err) ? quotaBackoffMs * attempt : 5000 * attempt;
      writeNextRequestAt = Math.max(writeNextRequestAt, Date.now() + backoffMs);
      await sleep(backoffMs);
    }
  }
}

function parseSheetId(value: string | undefined | null): string | null {
  if (!value) {
    return null;
  }
  const raw = String(value).trim();
  const match = raw.match(/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (match) {
    return match[1];
  }
  const idMatch = raw.match(/[?&]id=([a-zA-Z0-9-_]+)/);
  if (idMatch) {
    return idMatch[1];
  }
  if (/^[a-zA-Z0-9-_]{15,}$/.test(raw)) {
    return raw;
  }
  return null;
}

function buildWriteJwtClient() {
  const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');
  if (!clientEmail || !privateKey) {
    throw new Error('Google credentials are not set (GOOGLE_CLIENT_EMAIL / GOOGLE_PRIVATE_KEY)');
  }
  return new google.auth.JWT(clientEmail, undefined, privateKey, [
    'https://www.googleapis.com/auth/spreadsheets'
  ]);
}

function normalizeWriteError(err: any): Error {
  const message = err?.response?.data?.error?.message || err?.message || '';
  const status = err?.response?.status || err?.code || null;
  if (status === 403 || /permission/i.test(message)) {
    return new Error(
      `Немає доступу на запис у Google Sheets. Додайте сервіс-акаунт ${
        process.env.GOOGLE_CLIENT_EMAIL || '(GOOGLE_CLIENT_EMAIL)'
      } як Редактора (Editor) до таблиці.`
    );
  }
  if (status === 404 || /not found/i.test(message)) {
    return new Error('Google Sheets не знайдено або доступ закритий.');
  }
  return err instanceof Error ? err : new Error(String(err));
}

// 1 -> A, 26 -> Z, 27 -> AA
function columnLetter(index1: number): string {
  let n = index1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out || 'A';
}

export type CellValue = string | number | null;

export interface WriteSheetTableOptions {
  spreadsheetIdOrUrl: string;
  sheetName: string;
  header: string[];
  rows: CellValue[][];
  batchRows?: number;
  onProgress?: (writtenDataRows: number, totalDataRows: number) => void;
}

export interface WriteSheetTableResult {
  spreadsheetId: string;
  sheetName: string;
  dataRows: number;
  totalRowsWritten: number;
  batches: number;
  apiCalls: number;
}

// Ensure the target tab exists and its grid is at least neededRows x neededCols.
// Creates the tab if missing; grows the grid if too small. Never shrinks (extra
// blank rows below the data are harmless and avoid a race with a shorter run).
async function ensureSheetGrid(
  sheets: any,
  spreadsheetId: string,
  sheetName: string,
  neededRows: number,
  neededCols: number
): Promise<void> {
  const meta = await writeWithRetry<any>(() => sheets.spreadsheets.get({ spreadsheetId }));
  const existing = (meta.data.sheets || []).find(
    (s: any) => s.properties?.title === sheetName
  );

  if (!existing) {
    await writeWithRetry<any>(() =>
      sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [
            {
              addSheet: {
                properties: {
                  title: sheetName,
                  gridProperties: { rowCount: neededRows, columnCount: neededCols }
                }
              }
            }
          ]
        }
      })
    );
    return;
  }

  const sheetId = existing.properties?.sheetId ?? 0;
  const curRows = existing.properties?.gridProperties?.rowCount || 0;
  const curCols = existing.properties?.gridProperties?.columnCount || 0;
  if (curRows >= neededRows && curCols >= neededCols) {
    return;
  }
  await writeWithRetry<any>(() =>
    sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            updateSheetProperties: {
              properties: {
                sheetId,
                gridProperties: {
                  rowCount: Math.max(curRows, neededRows),
                  columnCount: Math.max(curCols, neededCols)
                }
              },
              fields: 'gridProperties.rowCount,gridProperties.columnCount'
            }
          }
        ]
      }
    })
  );
}

/**
 * Full-overwrite a tab with a header + data table, batching the data writes so a
 * 130k-row table costs a handful of API calls instead of thousands. Steps:
 *   1. ensure tab + grid size (header + all rows)
 *   2. clear previous contents (idempotent overwrite)
 *   3. write header, then data in `batchRows`-sized values.update calls
 */
export async function writeSheetTable(
  options: WriteSheetTableOptions
): Promise<WriteSheetTableResult> {
  try {
    const spreadsheetId = parseSheetId(options.spreadsheetIdOrUrl);
    if (!spreadsheetId) {
      throw new Error('Invalid Google Sheets URL or ID');
    }
    const { sheetName, header, rows } = options;
    const cols = header.length;
    if (cols === 0) {
      throw new Error('Header is empty');
    }
    const batchRows = Math.max(1, options.batchRows || defaultBatchRows);
    const lastCol = columnLetter(cols);
    const totalRows = rows.length + 1; // + header

    const auth = buildWriteJwtClient();
    const sheets = google.sheets({ version: 'v4', auth });

    let apiCalls = 0;

    await ensureSheetGrid(sheets, spreadsheetId, sheetName, totalRows, cols);
    apiCalls += 1;

    await writeWithRetry<any>(() =>
      sheets.spreadsheets.values.clear({ spreadsheetId, range: sheetName })
    );
    apiCalls += 1;

    await writeWithRetry<any>(() =>
      sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${sheetName}!A1:${lastCol}1`,
        valueInputOption: 'RAW',
        requestBody: { values: [header] }
      })
    );
    apiCalls += 1;

    let batches = 0;
    let written = 0;
    for (let start = 0; start < rows.length; start += batchRows) {
      const slice = rows.slice(start, start + batchRows);
      const startRow = 2 + start; // 1-based, after header
      const endRow = startRow + slice.length - 1;
      // eslint-disable-next-line no-await-in-loop
      await writeWithRetry<any>(() =>
        sheets.spreadsheets.values.update({
          spreadsheetId,
          range: `${sheetName}!A${startRow}:${lastCol}${endRow}`,
          valueInputOption: 'RAW',
          requestBody: { values: slice }
        })
      );
      apiCalls += 1;
      batches += 1;
      written += slice.length;
      if (options.onProgress) {
        options.onProgress(written, rows.length);
      }
    }

    return {
      spreadsheetId,
      sheetName,
      dataRows: rows.length,
      totalRowsWritten: totalRows,
      batches,
      apiCalls
    };
  } catch (err) {
    throw normalizeWriteError(err);
  }
}
