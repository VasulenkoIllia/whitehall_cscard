import { google } from 'googleapis';

const minIntervalMs = Number(process.env.GOOGLE_SHEETS_MIN_INTERVAL_MS || 1200);
const quotaBackoffMs = Number(process.env.GOOGLE_SHEETS_QUOTA_BACKOFF_MS || 60000);
const maxRetriesRaw = Number(process.env.GOOGLE_SHEETS_MAX_RETRIES ?? 0);

// Leaky-bucket rate limiter — concurrent-safe in JS single-threaded event loop.
// Each caller atomically reserves the next available slot (no two callers share the same slot).
let nextRequestAt = 0;

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
    /quota exceeded|rate limit|Read requests per minute per user/i.test(message)
  );
}

async function requestWithRetry<T>(fn: () => Promise<T>): Promise<T> {
  let attempt = 0;
  const maxRetries = Number.isFinite(maxRetriesRaw) ? maxRetriesRaw : 0;
  const maxAttempts = maxRetries <= 0 ? 3 : maxRetries;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      // Atomically reserve the next rate-limit slot.
      // No await between read and write → no race condition even with parallel callers.
      const now = Date.now();
      const mySlot = Math.max(now, nextRequestAt);
      nextRequestAt = mySlot + minIntervalMs;
      const waitMs = mySlot - now;
      if (waitMs > 0) {
        await sleep(waitMs);
      }
      return await fn();
    } catch (err) {
      if (!isQuotaError(err) || attempt >= maxAttempts) {
        throw err;
      }
      attempt += 1;
      // On quota error: back off AND push the global slot forward so other workers
      // also slow down, not just this one.
      const backoffMs = quotaBackoffMs * attempt;
      nextRequestAt = Math.max(nextRequestAt, Date.now() + backoffMs);
      await sleep(backoffMs);
    }
  }
}

function parseSheetId(url: string | undefined | null): string | null {
  if (!url) {
    return null;
  }
  const value = String(url).trim();
  const match = value.match(/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (match) {
    return match[1];
  }
  const idMatch = value.match(/[?&]id=([a-zA-Z0-9-_]+)/);
  if (idMatch) {
    return idMatch[1];
  }
  if (/^[a-zA-Z0-9-_]{15,}$/.test(value)) {
    return value;
  }
  return null;
}

function buildJwtClient() {
  const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');
  if (!clientEmail || !privateKey) {
    throw new Error('Google credentials are not set');
  }
  return new google.auth.JWT(clientEmail, undefined, privateKey, [
    'https://www.googleapis.com/auth/spreadsheets.readonly'
  ]);
}

function extractGoogleErrorDetails(err: any) {
  const message = err?.response?.data?.error?.message || err?.message || '';
  const status = err?.response?.status || err?.code || null;
  const reason = err?.response?.data?.error?.errors?.[0]?.reason || '';
  return { message, status, reason };
}

function extractGridLimits(err: any) {
  const message = err?.response?.data?.error?.message || err?.message || '';
  const match = message.match(/Max rows:\s*(\d+),\s*max columns:\s*(\d+)/i);
  if (!match) {
    return null;
  }
  return {
    maxRows: Number(match[1]),
    maxColumns: Number(match[2])
  };
}

function normalizeGoogleSheetsError(err: any): Error {
  const { message, status, reason } = extractGoogleErrorDetails(err);
  if (status === 403 || /permission/i.test(message) || reason === 'forbidden') {
    return new Error(
      'Немає доступу до Google Sheets. Файл закритий або доступ відкликано. Поділіться таблицею з email сервіс-акаунта.'
    );
  }
  if (status === 404 || /not found/i.test(message) || reason === 'notFound') {
    return new Error('Google Sheets не знайдено або доступ закритий.');
  }
  if (/Unable to parse range/i.test(message)) {
    return new Error('Аркуш не знайдено або перейменовано. Оновіть назву аркуша.');
  }
  return err instanceof Error ? err : new Error(String(err));
}

export interface SheetInfo {
  sheets: any;
  spreadsheetId: string;
  sheetName: string;
  rowCount: number | null;
  columnCount: number | null;
}

export interface SheetPreviewResult {
  spreadsheetId: string;
  sheetName: string;
  headerRow: number;
  hasHeader: boolean;
  rows: string[][];
}

/**
 * Fast path: skips the spreadsheets.get metadata API call when sheetName is already known.
 * Falls back to a full metadata call only when sheetName is null/empty (rare — ~1 source).
 * rowCount/columnCount will be null on the fast path; all callers already handle null gracefully.
 */
export async function getSheetClient(url: string, sheetName?: string | null): Promise<SheetInfo> {
  const spreadsheetId = parseSheetId(url);
  if (!spreadsheetId) {
    throw new Error('Invalid Google Sheets URL or ID');
  }
  const auth = buildJwtClient();
  const sheets = google.sheets({ version: 'v4', auth });

  // Fast path — no API call needed
  if (sheetName) {
    return { sheets, spreadsheetId, sheetName, rowCount: null, columnCount: null };
  }

  // Slow path — resolve first sheet name via metadata (sheetName not configured)
  try {
    const meta = await requestWithRetry<any>(() => sheets.spreadsheets.get({ spreadsheetId }));
    const targetSheetName = meta.data.sheets?.[0]?.properties?.title;
    if (!targetSheetName) {
      throw new Error('Sheet name not found');
    }
    const targetSheet =
      (meta.data.sheets || []).find(
        (sheet: any) => sheet.properties?.title === targetSheetName
      ) || null;
    return {
      sheets,
      spreadsheetId,
      sheetName: targetSheetName,
      rowCount: targetSheet?.properties?.gridProperties?.rowCount || null,
      columnCount: targetSheet?.properties?.gridProperties?.columnCount || null
    };
  } catch (err) {
    throw normalizeGoogleSheetsError(err);
  }
}

export async function getSheetInfo(url: string, sheetName?: string | null): Promise<SheetInfo> {
  try {
    const spreadsheetId = parseSheetId(url);
    if (!spreadsheetId) {
      throw new Error('Invalid Google Sheets URL or ID');
    }

    const auth = buildJwtClient();
    const sheets = google.sheets({ version: 'v4', auth });

    const meta = await requestWithRetry<any>(() => sheets.spreadsheets.get({ spreadsheetId }));
    let targetSheetName = sheetName || meta.data.sheets?.[0]?.properties?.title || null;

    if (!targetSheetName) {
      throw new Error('Sheet name not found');
    }

    const targetSheet =
      (meta.data.sheets || []).find((sheet: any) => sheet.properties?.title === targetSheetName) ||
      null;
    if (!targetSheet) {
      throw new Error('Sheet name not found');
    }

    const rowCount = targetSheet.properties?.gridProperties?.rowCount || null;
    const columnCount = targetSheet.properties?.gridProperties?.columnCount || null;

    return {
      sheets,
      spreadsheetId,
      sheetName: targetSheetName,
      rowCount,
      columnCount
    };
  } catch (err) {
    throw normalizeGoogleSheetsError(err);
  }
}

export async function getSheetRowChunk(
  sheets: any,
  spreadsheetId: string,
  sheetName: string,
  startRow: number,
  endRow: number
): Promise<string[][]> {
  try {
    let currentEnd = endRow;
    while (true) {
      if (currentEnd < startRow) {
        return [];
      }
      const range = `${sheetName}!${startRow}:${currentEnd}`;
      try {
        const res = await requestWithRetry<any>(() =>
          sheets.spreadsheets.values.get({
            spreadsheetId,
            range,
            majorDimension: 'ROWS',
            valueRenderOption: 'FORMATTED_VALUE'
          })
        );
        return (res.data.values as string[][]) || [];
      } catch (err) {
        const limits = extractGridLimits(err);
        if (!limits?.maxRows) {
          throw err;
        }
        if (startRow > limits.maxRows) {
          return [];
        }
        if (currentEnd <= limits.maxRows) {
          throw err;
        }
        currentEnd = limits.maxRows;
      }
    }
  } catch (err) {
    throw normalizeGoogleSheetsError(err);
  }
}

export async function getSheetPreview(
  url: string,
  sheetName: string | null = null,
  headerRow = 1,
  sampleRows = 5
): Promise<SheetPreviewResult> {
  try {
    const { sheets, spreadsheetId, sheetName: targetSheetName, rowCount } = await getSheetInfo(
      url,
      sheetName
    );

    const rawHeaderRow = Number(headerRow);
    const hasHeader = Number.isFinite(rawHeaderRow) && rawHeaderRow > 0;
    const startRow = hasHeader ? rawHeaderRow : 1;
    const sampleCount = Math.max(Number(sampleRows) || 0, 0);
    let endRow = hasHeader ? startRow + sampleCount : startRow + Math.max(sampleCount - 1, 0);

    if (rowCount && startRow > rowCount) {
      throw new Error('Header row out of range');
    }

    if (rowCount) {
      endRow = Math.min(endRow, rowCount);
    }

    const rows = await getSheetRowChunk(sheets, spreadsheetId, targetSheetName, startRow, endRow);
    return {
      spreadsheetId,
      sheetName: targetSheetName,
      headerRow: hasHeader ? startRow : 0,
      hasHeader,
      rows
    };
  } catch (err) {
    throw normalizeGoogleSheetsError(err);
  }
}

export async function listSheetNames(url: string): Promise<string[]> {
  try {
    const auth = buildJwtClient();
    const sheets = google.sheets({ version: 'v4', auth });
    const spreadsheetId = parseSheetId(url);
    if (!spreadsheetId) {
      throw new Error('Invalid Google Sheets URL');
    }
    const meta = await requestWithRetry<any>(() => sheets.spreadsheets.get({ spreadsheetId }));
    return (meta.data.sheets || [])
      .map((sheet: any) => sheet.properties?.title)
      .filter((value: unknown) => Boolean(value))
      .map((value: string) => String(value));
  } catch (err) {
    throw normalizeGoogleSheetsError(err);
  }
}
