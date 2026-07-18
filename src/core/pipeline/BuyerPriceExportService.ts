import { Pool } from 'pg';
import { JobService } from '../jobs/JobService';
import { LogService } from './log';
import { writeSheetTable } from './googleSheetsWriter';

// Колонки прайсу покупцям (узгоджено з користувачем).
export const BUYER_PRICE_HEADER = ['Артикул', 'Назва', 'Розмір', 'Кількість', 'Ціна'];

const LOCK_NAME = 'buyer_price_export';

export interface BuyerPriceExportConfig {
  enabled: boolean;
  sheetId: string;
  sheetTab: string;
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

function buildBanner(asOf: Date | null): string {
  const when = asOf || new Date();
  const stamp = new Intl.DateTimeFormat('uk-UA', {
    timeZone: 'Europe/Kyiv',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(when);
  return `Прайс актуальний станом на ${stamp} (Київ)`;
}

/**
 * Вивантаження прайсу покупцям (дроп-ціни) у Google Sheet.
 *
 * Джерело — products_final (quantity>0), один рядок на (article,size). Читаємо
 * keyset-порціями (без OFFSET), дедупів немає (finalize робить DISTINCT ON).
 * Запис — повне перезаписування вкладки (clear + write), тож дані завжди свіжі
 * без лишків/дублів. Дата актуальності банера = час завершення останнього
 * finalize. Захищено власним локом `buyer_price_export` (не блокує пайплайн — цей
 * тип НЕ в BLOCKING_JOB_TYPES) + хард-таймаутом.
 */
export class BuyerPriceExportService {
  constructor(
    private readonly pool: Pool,
    private readonly jobs: JobService,
    private readonly logs: LogService,
    private readonly config: BuyerPriceExportConfig
  ) {}

  isEnabled(): boolean {
    return this.config.enabled && Boolean(this.config.sheetId);
  }

  // Час завершення останнього finalize — "актуально станом на".
  private async getLastFinalizeAt(): Promise<Date | null> {
    const res = await this.pool.query(
      `SELECT finished_at
         FROM jobs
        WHERE type = 'finalize' AND finished_at IS NOT NULL
        ORDER BY finished_at DESC
        LIMIT 1`
    );
    const value = res.rows[0]?.finished_at;
    return value ? new Date(value) : null;
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
    if (!this.isEnabled()) {
      return { status: 'skipped', reason: 'disabled_or_no_sheet' };
    }

    const job = await this.jobs.createJob('buyer_price_export', { sheetId: this.config.sheetId });
    const startedAt = Date.now();
    let locked = false;
    try {
      locked = await this.jobs.acquireJobLock(job.id, LOCK_NAME);
      if (!locked) {
        await this.jobs.finishJob(job.id);
        await this.logs.log(job.id, 'warning', 'buyer_price_export skipped: locked', {});
        return { status: 'locked', reason: 'another_export_running', jobId: job.id };
      }

      await this.jobs.startJob(job.id);
      const asOf = options?.asOf ?? (await this.getLastFinalizeAt());
      const rows = await this.loadRows();

      const writeResult = await withTimeout(
        writeSheetTable({
          spreadsheetIdOrUrl: this.config.sheetId,
          sheetName: this.config.sheetTab,
          header: BUYER_PRICE_HEADER,
          rows,
          batchRows: this.config.batchRows,
          bannerText: buildBanner(asOf)
        }),
        this.config.timeoutMs,
        'buyer_price_export write'
      );

      await this.jobs.finishJob(job.id);
      const result: BuyerPriceExportResult = {
        status: 'ok',
        jobId: job.id,
        dataRows: writeResult.dataRows,
        apiCalls: writeResult.apiCalls,
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
