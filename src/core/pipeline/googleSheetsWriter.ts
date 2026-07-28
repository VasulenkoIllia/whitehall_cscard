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
  // Optional highlighted banner written above the header (row 1), e.g. a
  // "прайс актуальний станом на …" timestamp. When set, the header moves to
  // row 2 and data starts at row 3; the banner is merged across all columns,
  // bold, with a yellow background, and the top two rows are frozen.
  bannerText?: string;
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
): Promise<{ sheetId: number; merges: any[] }> {
  const meta = await writeWithRetry<any>(() => sheets.spreadsheets.get({ spreadsheetId }));
  const existing = (meta.data.sheets || []).find(
    (s: any) => s.properties?.title === sheetName
  );

  if (!existing) {
    const addRes = await writeWithRetry<any>(() =>
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
    return { sheetId: addRes.data?.replies?.[0]?.addSheet?.properties?.sheetId ?? 0, merges: [] };
  }

  const sheetId = existing.properties?.sheetId ?? 0;
  const merges: any[] = Array.isArray(existing.merges) ? existing.merges : [];
  const curRows = existing.properties?.gridProperties?.rowCount || 0;
  const curCols = existing.properties?.gridProperties?.columnCount || 0;
  if (curRows >= neededRows && curCols >= neededCols) {
    return { sheetId, merges };
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
  return { sheetId, merges };
}

// Header/banner styling applied after the values are written. Merges + highlights
// the banner row, bolds the header, and freezes the top rows so buyers keep the
// "actual as of" stamp and column titles in view while scrolling. Re-run safe:
// unmerge precedes merge so a second run does not error on an existing merge.
async function applyTableFormatting(
  sheets: any,
  spreadsheetId: string,
  sheetId: number,
  cols: number,
  hasBanner: boolean,
  existingMerges: any[]
): Promise<void> {
  const headerRowIndex = hasBanner ? 1 : 0; // 0-based
  const requests: any[] = [];
  const firstRowRange = {
    sheetId,
    startRowIndex: 0,
    endRowIndex: 1,
    startColumnIndex: 0,
    endColumnIndex: cols
  };

  // Розліплюємо перший рядок ЗАВЖДИ, не лише коли малюємо банер: values.clear()
  // прибирає значення, але не об'єднання і не заливку, тож аркуш, який колись мав
  // банер, лишався б зі злитим A1:E1 — і шапка колонок опинилась би всередині
  // однієї клітинки (видно тільки перший заголовок на всю ширину).
  //
  // Розліплюємо ПОІМЕННО, за фактичними об'єднаннями, а не одним запитом на весь
  // рядок: unmergeCells падає, якщо діапазон ЧАСТКОВО перетинає merge. Об'єднання
  // ширше за таблицю (A1:F1, зроблене руками в таблиці) завалило б увесь
  // batchUpdate, а з ним і кожне наступне вивантаження прайсу.
  for (const merge of existingMerges) {
    const startRow = Number(merge?.startRowIndex ?? -1);
    const endRow = Number(merge?.endRowIndex ?? -1);
    // Беремо лише ті, що лежать РІВНО в межах першого рядка — їх можна зняти
    // їхнім же діапазоном, без ризику часткового перетину. Вертикальні
    // об'єднання (A1:A3) не чіпаємо: вони не наших рук справа.
    if (startRow === 0 && endRow === 1) {
      requests.push({
        unmergeCells: {
          range: {
            sheetId,
            startRowIndex: startRow,
            endRowIndex: endRow,
            startColumnIndex: Number(merge.startColumnIndex ?? 0),
            endColumnIndex: Number(merge.endColumnIndex ?? cols)
          }
        }
      });
    }
  }

  if (hasBanner) {
    requests.push({ mergeCells: { range: firstRowRange, mergeType: 'MERGE_ALL' } });
    requests.push({
      repeatCell: {
        range: firstRowRange,
        cell: {
          userEnteredFormat: {
            backgroundColor: { red: 0.99, green: 0.9, blue: 0.36 },
            horizontalAlignment: 'CENTER',
            verticalAlignment: 'MIDDLE',
            textFormat: { bold: true, fontSize: 12 }
          }
        },
        fields:
          'userEnteredFormat(backgroundColor,horizontalAlignment,verticalAlignment,textFormat)'
      }
    });
  } else {
    // Скидаємо жовту заливку/центрування, що лишились від колишнього банера,
    // інакше шапка колонок успадкує його вигляд.
    requests.push({
      repeatCell: {
        range: firstRowRange,
        cell: {
          userEnteredFormat: {
            backgroundColor: { red: 1, green: 1, blue: 1 },
            horizontalAlignment: 'LEFT',
            verticalAlignment: 'BOTTOM',
            textFormat: { bold: false, fontSize: 10 }
          }
        },
        fields:
          'userEnteredFormat(backgroundColor,horizontalAlignment,verticalAlignment,textFormat)'
      }
    });
  }

  requests.push({
    repeatCell: {
      range: {
        sheetId,
        startRowIndex: headerRowIndex,
        endRowIndex: headerRowIndex + 1,
        startColumnIndex: 0,
        endColumnIndex: cols
      },
      cell: {
        userEnteredFormat: {
          backgroundColor: { red: 0.9, green: 0.9, blue: 0.9 },
          textFormat: { bold: true }
        }
      },
      fields: 'userEnteredFormat(backgroundColor,textFormat)'
    }
  });

  requests.push({
    updateSheetProperties: {
      properties: { sheetId, gridProperties: { frozenRowCount: headerRowIndex + 1 } },
      fields: 'gridProperties.frozenRowCount'
    }
  });

  await writeWithRetry<any>(() =>
    sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } })
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
    const hasBanner = Boolean(options.bannerText && options.bannerText.trim());
    const headerRowNum = hasBanner ? 2 : 1; // 1-based
    const dataStartRow = headerRowNum + 1;
    const totalRows = rows.length + (hasBanner ? 2 : 1); // banner + header

    const auth = buildWriteJwtClient();
    const sheets = google.sheets({ version: 'v4', auth });

    let apiCalls = 0;

    const { sheetId, merges } = await ensureSheetGrid(
      sheets,
      spreadsheetId,
      sheetName,
      totalRows,
      cols
    );
    apiCalls += 1;

    await writeWithRetry<any>(() =>
      sheets.spreadsheets.values.clear({ spreadsheetId, range: sheetName })
    );
    apiCalls += 1;

    if (hasBanner) {
      await writeWithRetry<any>(() =>
        sheets.spreadsheets.values.update({
          spreadsheetId,
          range: `${sheetName}!A1`,
          valueInputOption: 'RAW',
          requestBody: { values: [[options.bannerText]] }
        })
      );
      apiCalls += 1;
    }

    await writeWithRetry<any>(() =>
      sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${sheetName}!A${headerRowNum}:${lastCol}${headerRowNum}`,
        valueInputOption: 'RAW',
        requestBody: { values: [header] }
      })
    );
    apiCalls += 1;

    let batches = 0;
    let written = 0;
    for (let start = 0; start < rows.length; start += batchRows) {
      const slice = rows.slice(start, start + batchRows);
      const startRow = dataStartRow + start; // 1-based, after header
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

    await applyTableFormatting(sheets, spreadsheetId, sheetId, cols, hasBanner, merges);
    apiCalls += 1;

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

export interface WriteSheetKeyValueOptions {
  spreadsheetIdOrUrl: string;
  sheetName: string;
  /** Рядки виду [підпис, значення] — пишуться в A/B згори вниз. */
  entries: [string, CellValue][];
}

export interface WriteSheetKeyValueResult {
  spreadsheetId: string;
  sheetName: string;
  rows: number;
  apiCalls: number;
}

/**
 * Повністю перезаписати невелику вкладку парами «підпис → значення».
 *
 * Для службової інформації поруч із основною таблицею — наприклад, вкладка
 * «Оновлено» з датою генерації прайсу. Вкладка створюється, якщо її немає.
 * Підписи (колонка A) виділяються жирним, ширина A підганяється під вміст.
 */
export async function writeSheetKeyValue(
  options: WriteSheetKeyValueOptions
): Promise<WriteSheetKeyValueResult> {
  try {
    const spreadsheetId = parseSheetId(options.spreadsheetIdOrUrl);
    if (!spreadsheetId) {
      throw new Error('Invalid Google Sheets URL or ID');
    }
    const { sheetName, entries } = options;
    if (!entries.length) {
      throw new Error('Entries are empty');
    }

    const auth = buildWriteJwtClient();
    const sheets = google.sheets({ version: 'v4', auth });
    let apiCalls = 0;

    // Сітка з запасом: аркуш 1x2 технічно валідний, але для людини виглядає як
    // зламаний — ані прокрутити, ані дописати.
    const { sheetId } = await ensureSheetGrid(
      sheets,
      spreadsheetId,
      sheetName,
      Math.max(entries.length, 20),
      4
    );
    apiCalls += 1;

    await writeWithRetry<any>(() =>
      sheets.spreadsheets.values.clear({ spreadsheetId, range: sheetName })
    );
    apiCalls += 1;

    await writeWithRetry<any>(() =>
      sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${sheetName}!A1:B${entries.length}`,
        valueInputOption: 'RAW',
        requestBody: { values: entries.map((entry) => [entry[0], entry[1]]) }
      })
    );
    apiCalls += 1;

    await writeWithRetry<any>(() =>
      sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [
            {
              repeatCell: {
                range: {
                  sheetId,
                  startRowIndex: 0,
                  endRowIndex: entries.length,
                  startColumnIndex: 0,
                  endColumnIndex: 1
                },
                cell: { userEnteredFormat: { textFormat: { bold: true } } },
                fields: 'userEnteredFormat(textFormat)'
              }
            },
            {
              autoResizeDimensions: {
                dimensions: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 2 }
              }
            }
          ]
        }
      })
    );
    apiCalls += 1;

    return { spreadsheetId, sheetName, rows: entries.length, apiCalls };
  } catch (err) {
    throw normalizeWriteError(err);
  }
}
