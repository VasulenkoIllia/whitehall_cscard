import { Pool } from 'pg';
import { JobService } from '../jobs/JobService';
import { LogService } from './log';
import { writeSheetKeyValue, writeSheetTable } from './googleSheetsWriter';

// Колонки прайсу покупцям (узгоджено з користувачем).
export const BUYER_PRICE_HEADER = ['Артикул', 'Назва', 'Розмір', 'Кількість', 'Ціна'];

// Підпис у вкладці зі службовою інформацією.
const STATUS_LABEL = 'Оновлено';

const LOCK_NAME = 'buyer_price_export';

export interface BuyerPriceExportConfig {
  enabled: boolean;
  sheetId: string;
  sheetTab: string;
  /** Вкладка зі службовою інформацією (дата оновлення прайсу). */
  statusTab: string;
  batchRows: number;
  timeoutMs: number;
}

export interface BuyerPriceExportResult {
  status: 'ok' | 'skipped' | 'locked';
  reason?: string;
  jobId?: number;
  dataRows?: number;
  apiCalls?: number;
  asOf?: string | null;
  durationMs?: number;
}

// Хард-таймаут через Promise.race — не залежить від AbortController/сокета.
// Таймаут кидає помилку, яку ловить export(): job→failed, лок звільняється у finally.
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} (timeout ${ms}ms)`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

// Дроп-ціна — та сама формула, що в SQL listFinalPreview: середина база↔фінал,
// округлена вгору до 10.
function dropPrice(base: number, final: number): number {
  return Math.ceil((base + final) / 2 / 10) * 10;
}

// Дата у вкладці «Оновлено». Київський час — покупці читають саме його.
function formatStamp(asOf: Date | null): string {
  const when = asOf || new Date();
  return new Intl.DateTimeFormat('uk-UA', {
    timeZone: 'Europe/Kyiv',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(when);
}

/**
 * Вивантаження прайсу покупцям (дроп-ціни) у Google Sheet.
 *
 * Джерело — products_final (quantity>0), один рядок на (article,size). Читаємо
 * keyset-порціями (без OFFSET), дедупів немає (finalize робить DISTINCT ON).
 * Запис — повне перезаписування вкладки (clear + write), тож дані завжди свіжі
 * без лишків/дублів. Дата генерації пишеться окремою вкладкою (`statusTab`), а не
 * банером над таблицею: аркуш прайсу починається одразу з шапки колонок.
 * Захищено власним локом `buyer_price_export` (не блокує пайплайн — цей тип НЕ в
 * BLOCKING_JOB_TYPES) + хард-таймаутом.
 */
export class BuyerPriceExportService {
  constructor(
    private readonly pool: Pool,
    private readonly jobs: JobService,
    private readonly logs: LogService,
    private readonly config: BuyerPriceExportConfig
  ) {}

  // Чи задано таблицю — цього достатньо для РУЧНОГО запуску (кнопка / CLI).
  isConfigured(): boolean {
    return Boolean(this.config.sheetId);
  }

  // Чи вмикати АВТО-крок після finalize (окремий прапорець + задана таблиця).
  // Ручна кнопка від цього прапорця НЕ залежить.
  isAutoEnabled(): boolean {
    return this.config.enabled && this.isConfigured();
  }

  // Keyset-читання всіх in-stock рядків у пам'ять (порціями, щоб не тримати
  // курсор і не робити OFFSET). ~148k рядків × 5 колонок ≈ десятки МБ — ок.
  private async loadRows(): Promise<(string | number)[][]> {
    const pageSize = 5000;
    const rows: (string | number)[][] = [];
    let lastId = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      // eslint-disable-next-line no-await-in-loop
      const res = await this.pool.query(
        `SELECT id, article, size, quantity, price_base, price_final, extra
           FROM products_final
          WHERE quantity > 0 AND id > $1
          ORDER BY id ASC
          LIMIT $2`,
        [lastId, pageSize]
      );
      if (res.rows.length === 0) {
        break;
      }
      for (const r of res.rows) {
        const base = Number(r.price_base);
        const final = Number(r.price_final);
        const drop = Number.isFinite(base) && Number.isFinite(final) ? dropPrice(base, final) : '';
        rows.push([
          String(r.article ?? ''),
          String(r.extra ?? ''),
          String(r.size ?? ''),
          Number(r.quantity) || 0,
          drop
        ]);
        lastId = Number(r.id);
      }
      if (res.rows.length < pageSize) {
        break;
      }
    }
    return rows;
  }

  /**
   * Виконати вивантаження. Ідемпотентне (повне перезаписування). Повертає статус:
   *  - 'skipped' — вимкнено або не задано таблицю;
   *  - 'locked'  — інше вивантаження вже виконується;
   *  - 'ok'      — записано.
   * Кидає лише на реальних помилках запису/таймауті (для толерантного кроку в
   * пайплайні — обгортай у try/catch).
   */
  async export(options?: { asOf?: Date | null }): Promise<BuyerPriceExportResult> {
    if (!this.isConfigured()) {
      return { status: 'skipped', reason: 'no_sheet' };
    }

    const job = await this.jobs.createJob('buyer_price_export', { sheetId: this.config.sheetId });
    const startedAt = Date.now();
    let locked = false;
    try {
      locked = await this.jobs.acquireJobLock(job.id, LOCK_NAME);
      if (!locked) {
        // Не finishJob: job ще 'queued', а finishJob оновлює лише 'running' → лишив
        // би вічний 'queued' (cleanup його не чистить). failJob → термінальний 'failed'.
        await this.jobs.failJob(job.id, new Error('another buyer_price_export is running'));
        await this.logs.log(job.id, 'warning', 'buyer_price_export skipped: locked', {});
        return { status: 'locked', reason: 'another_export_running', jobId: job.id };
      }

      await this.jobs.startJob(job.id);
      // Дата = час ГЕНЕРАЦІЇ прайсу (момент вивантаження) — оновлюється при
      // кожному прогоні. На авто-шляху це ≈ час finalize (експорт іде одразу після).
      const asOf = options?.asOf ?? new Date();
      const rows = await this.loadRows();

      // Guard: невалідний timeoutMs (NaN/0/від'ємний) → setTimeout(fn, NaN) спрацював
      // би миттєво і завжди таймаутив. Фолбек на 180с.
      const timeoutMs =
        Number.isFinite(this.config.timeoutMs) && this.config.timeoutMs > 0
          ? this.config.timeoutMs
          : 180000;
      // Аркуш прайсу — тільки шапка + дані, без банера. Дата оновлення живе в
      // окремій вкладці, щоб покупцю було зручно копіювати таблицю цілком і щоб
      // рядок 1 завжди був заголовками колонок.
      const writeResult = await withTimeout(
        writeSheetTable({
          spreadsheetIdOrUrl: this.config.sheetId,
          sheetName: this.config.sheetTab,
          header: BUYER_PRICE_HEADER,
          rows,
          batchRows: this.config.batchRows
        }),
        timeoutMs,
        'buyer_price_export write'
      );

      // Службова вкладка пишеться ПІСЛЯ прайсу: дата має з'явитись лише тоді,
      // коли дані справді лягли. Якщо основний запис упаде — стара дата
      // залишиться, і це чесніше, ніж свіжий штамп над старим прайсом.
      const statusResult = await withTimeout(
        writeSheetKeyValue({
          spreadsheetIdOrUrl: this.config.sheetId,
          sheetName: this.config.statusTab,
          entries: [[STATUS_LABEL, formatStamp(asOf)]]
        }),
        timeoutMs,
        'buyer_price_export status write'
      );

      await this.jobs.finishJob(job.id);
      const result: BuyerPriceExportResult = {
        status: 'ok',
        jobId: job.id,
        dataRows: writeResult.dataRows,
        apiCalls: writeResult.apiCalls + statusResult.apiCalls,
        asOf: asOf ? asOf.toISOString() : null,
        durationMs: Math.max(0, Date.now() - startedAt)
      };
      await this.logs.log(job.id, 'info', 'buyer_price_export finished', result);
      return result;
    } catch (err) {
      await this.jobs.failJob(job.id, err);
      await this.logs.log(job.id, 'error', 'buyer_price_export failed', {
        error: err instanceof Error ? err.message : String(err)
      });
      throw err;
    } finally {
      if (locked) {
        await this.jobs.releaseJobLock(job.id, LOCK_NAME);
      }
    }
  }
}
