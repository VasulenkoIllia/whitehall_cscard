import * as XLSX from 'xlsx';
import type { Pool } from 'pg';
import type { LogService } from '../pipeline/log';
import type { AppSettingsService } from '../settings/AppSettingsService';
import { MASTER_CATALOG_FIELDS } from './MasterCatalogService';

/**
 * Дефолтні алиаси «поле каталогу → можливі назви колонок» для режиму прямого
 * мапінгу. Матчинг case-insensitive, exact по назві колонки. Порядок = пріоритет
 * (перше непорожнє виграє). Підлаштовано під реальні файли master_site +
 * enriched_final, але працює і для довільних колонок з однаковими назвами.
 */
const FIELD_COLUMN_ALIASES: Record<string, string[]> = {
  name_uk: ['name_uk', 'name', 'назва', 'найменування'],
  brand: ['brand', 'бренд', 'vendor', 'торгова марка'],
  category_uk: ['category_uk', 'category', 'категорія'],
  description_full_uk: ['description_full_uk', 'feed_description', 'description', 'опис'],
  color_uk: ['color_uk', 'feed_param:Колір', 'колір', 'цвет', 'color'],
  gender: ['gender', 'feed_param:Стать', 'стать', 'пол'],
  country: ['country', 'feed_param:Країна', 'feed_country', 'країна', 'страна'],
  model_name: ['model_name', 'feed_param:Модель', 'feed_param:Назва моделі', 'модель'],
  style: ['style', 'feed_param:Стиль', 'стиль'],
  material: ['material', 'feed_param:Матеріал', 'feed_param:Структура', 'feed_param:Склад', 'матеріал', 'склад'],
  material_top: ['material_top', 'feed_param:Матеріал верха', 'матеріал верху'],
  material_inner: ['material_inner', 'матеріал всередині', 'матеріал підкладки'],
  material_sole: ['material_sole', 'feed_param:Матеріал підошви', 'матеріал підошви'],
  fastening: ['fastening', 'feed_param:Застежка', 'застібка', 'застежка'],
  purpose: ['purpose', 'feed_param:Призначення', 'призначення'],
  season: ['season', 'feed_param:Сезонність', 'сезон', 'сезонність'],
  season_year: ['season_year', 'сезон за роками'],
  product_type: ['product_type', 'feed_param:Тип взуття', 'feed_param:Тип товару', 'feed_param:Тип', 'тип'],
  product_kind: ['product_kind', 'вид товару'],
  toe_shape: ['toe_shape', 'feed_param:Форма носка', 'вид носка'],
  old_price: ['old_price', 'стара ціна', 'old price'],
  gtin: ['gtin', 'feed_param:EAN', 'feed_barcode', 'barcode', 'ean', 'штрихкод']
};

const ALLOWED_FIELD_SET = new Set<string>(MASTER_CATALOG_FIELDS);
/** Числові поля master_catalog — потребують безпечного касту при записі. */
const NUMERIC_FIELDS = new Set<string>(['old_price']);

/**
 * ExcelImportService — імпорт товарів з Excel файлу у master_catalog.
 *
 * Відмінність від FeedService: фід тільки UPDATE-ить існуючі SKU, а Excel-імпорт
 * СТВОРЮЄ рядки (upsert по sku). Всі колонки крім SKU/фото йдуть у
 * feed_params.<sourceKey>.data — той самий shape, що у фідів, тому
 * EnrichmentService і промпт працюють без змін.
 *
 * Очистка значень (мінімізація токенів для AI):
 *   - HTML теги геть (<br>/</p>/</li> → новий рядок)
 *   - HTML entities декодуються
 *   - пробіли/порожні рядки колапсуються
 *   - порожні значення відкидаються (колонки розріджені — економія величезна)
 *   - виключені колонки (фото, лінки, технічні, SEO) відкидаються
 *   - колонка SKU не дублюється у data (sku передається в AI окремо)
 *
 * Фото НЕ йде в AI: photoColumn пишеться напряму у master_catalog.photo.
 */

export interface ExcelPreviewOptions {
  sheetName?: string;
  headerRow?: number;
}

/** Зіставлення «поле каталогу ← перше непорожнє з цих колонок». */
export interface FieldMappingEntry {
  field: string;
  columns: string[];
}

export interface ExcelPreviewResult {
  sheetNames: string[];
  sheetName: string;
  headers: Array<{ letter: string; label: string }>;
  /** Перші 10 непорожніх рядків ПІСЛЯ очистки — що реально піде в data. */
  rows: Array<Record<string, string>>;
  totalRows: number;
  suggestedSkuColumn: string | null;
  suggestedExcludedColumns: string[];
  /** Авто-зіставлення колонок на поля каталогу (для режиму «прямо в поля»). */
  suggestedFieldMapping: FieldMappingEntry[];
}

export interface ExcelImportOptions {
  skuColumn: string;
  excludedColumns: string[];
  photoColumn?: string | null;
  overwritePhoto?: boolean;
  sheetName?: string;
  headerRow?: number;
  /** Ключ у feed_params. Default 'excel_upload'. */
  sourceKey?: string;
}

export interface ExcelImportResult {
  sheetName: string;
  totalRows: number;
  created: number;
  updated: number;
  skippedNoSku: number;
  dedupedSkus: number;
  durationMs: number;
}

export interface ExcelDirectImportOptions {
  skuColumn: string;
  fieldMapping: FieldMappingEntry[];
  /** true — лише оновлювати наявні SKU (не створювати нові). Default false. */
  updateOnly?: boolean;
  /** true — перезаписувати заповнені поля. Default true (файл = джерело правди). */
  overwriteFilled?: boolean;
  sheetName?: string;
  headerRow?: number;
}

export interface ExcelDirectImportResult {
  sheetName: string;
  totalRows: number;
  created: number;
  updated: number;
  skippedNoSku: number;
  /** updateOnly: SKU яких нема в каталозі. */
  skippedNoMatch: number;
  dedupedSkus: number;
  fieldsWritten: number;
  mappedFields: string[];
  durationMs: number;
}

const PREVIEW_ROWS = 10;
const UPSERT_BATCH_SIZE = 500;

export class ExcelImportService {
  constructor(
    private readonly pool: Pool,
    private readonly logs: LogService,
    private readonly settings: AppSettingsService
  ) {}

  /** Прев'ю: аркуші, заголовки, перші рядки після очистки, підказки колонок. */
  async preview(buffer: Buffer, opts: ExcelPreviewOptions = {}): Promise<ExcelPreviewResult> {
    const { workbook, sheetName, matrix, headers } = this.parseSheet(buffer, opts);

    const excludedSetting = await this.settings.getExcelExcludedColumns();
    const suggestedExcluded = headers
      .filter((h) => matchesExcluded(h.label, excludedSetting.columns))
      .map((h) => h.label);

    // Колонки, де перше непорожнє значення схоже на URL картинки — теж у підказку.
    const headerRowNum = Math.max(1, Math.trunc(Number(opts.headerRow) || 1));
    for (let j = 0; j < headers.length; j++) {
      if (suggestedExcluded.includes(headers[j].label)) continue;
      for (let i = headerRowNum, seen = 0; i < matrix.length && seen < 20; i++) {
        const v = matrix[i]?.[j];
        if (v === null || v === '' || typeof v === 'undefined') continue;
        seen++;
        if (/^https?:\/\/\S+\.(jpe?g|png|webp|gif)(\?|$)/i.test(String(v).trim())) {
          suggestedExcluded.push(headers[j].label);
        }
        break; // дивимось тільки перше непорожнє значення
      }
    }

    const suggestedSkuColumn =
      headers.find((h) => /^(sku|артикул|article|vendor ?code|код|code)$/i.test(h.label.trim()))?.label ||
      headers.find((h) => /(sku|артикул|article)/i.test(h.label))?.label ||
      null;

    // Перші 10 непорожніх рядків — очищені, без виключених колонок (як піде в data).
    const excludedForPreview = new Set(suggestedExcluded);
    const rows: Array<Record<string, string>> = [];
    let totalRows = 0;
    for (let i = headerRowNum; i < matrix.length; i++) {
      const row = matrix[i];
      if (!row || row.every((c) => c === null || c === '' || typeof c === 'undefined')) continue;
      totalRows++;
      if (rows.length < PREVIEW_ROWS) {
        const obj: Record<string, string> = {};
        for (let j = 0; j < headers.length; j++) {
          if (excludedForPreview.has(headers[j].label)) continue;
          const cleaned = cleanValue(row[j]);
          if (cleaned !== null) obj[headers[j].label] = cleaned;
        }
        rows.push(obj);
      }
    }

    return {
      sheetNames: workbook.SheetNames,
      sheetName,
      headers,
      rows,
      totalRows,
      suggestedSkuColumn,
      suggestedExcludedColumns: suggestedExcluded,
      suggestedFieldMapping: suggestFieldMapping(headers)
    };
  }

  /**
   * Імпорт у режимі «прямо в поля каталогу»: значення колонок копіюються у поля
   * master_catalog за зіставленням (без AI, без feed_params). Для кожного поля —
   * перше непорожнє з його списку колонок (coalesce). Числові поля кастяться
   * безпечно. Невалідні/невідомі поля ігноруються.
   */
  async importDirectFields(
    buffer: Buffer,
    opts: ExcelDirectImportOptions
  ): Promise<ExcelDirectImportResult> {
    const startedAt = Date.now();
    const { sheetName, matrix, headers } = this.parseSheet(buffer, opts);
    const headerRowNum = Math.max(1, Math.trunc(Number(opts.headerRow) || 1));
    const updateOnly = opts.updateOnly === true;
    const overwriteFilled = opts.overwriteFilled !== false; // default true

    const skuIdx = resolveColumnIndex(headers, opts.skuColumn);
    if (skuIdx < 0) {
      const err = new Error(`Колонку SKU "${opts.skuColumn}" не знайдено у заголовках`);
      (err as { status?: number }).status = 400;
      throw err;
    }

    // Резолвимо зіставлення: лише дозволені поля + наявні колонки.
    const mapping: Array<{ field: string; isNumeric: boolean; indices: number[] }> = [];
    for (const entry of opts.fieldMapping || []) {
      const field = String(entry.field || '').trim();
      if (!ALLOWED_FIELD_SET.has(field)) continue;
      const indices = (entry.columns || [])
        .map((c) => resolveColumnIndex(headers, c))
        .filter((idx) => idx >= 0 && idx !== skuIdx);
      if (indices.length === 0) continue;
      mapping.push({ field, isNumeric: NUMERIC_FIELDS.has(field), indices });
    }
    if (mapping.length === 0) {
      const err = new Error('Жодне поле не зіставлено з колонками');
      (err as { status?: number }).status = 400;
      throw err;
    }
    const mappedFields = mapping.map((m) => m.field);

    // Дедуп по SKU (перший виграє). fields = {field: значення} після coalesce+очистки.
    let totalRows = 0;
    let skippedNoSku = 0;
    const dedupedMap = new Map<string, Record<string, string>>();
    for (let i = headerRowNum; i < matrix.length; i++) {
      const row = matrix[i];
      if (!row || row.every((c) => c === null || c === '' || typeof c === 'undefined')) continue;
      totalRows++;
      const skuRaw = row[skuIdx];
      const sku = skuRaw === null || typeof skuRaw === 'undefined' ? '' : String(skuRaw).trim();
      if (!sku) {
        skippedNoSku++;
        continue;
      }
      if (dedupedMap.has(sku)) continue;

      const fields: Record<string, string> = {};
      for (const m of mapping) {
        for (const idx of m.indices) {
          let cleaned = cleanValue(row[idx]);
          if (cleaned === null) continue;
          if (m.isNumeric) {
            const num = cleaned.replace(/[^0-9.,]/g, '').replace(',', '.');
            if (!num || !Number.isFinite(Number(num))) continue;
            cleaned = num;
          }
          fields[m.field] = cleaned;
          break; // перше непорожнє виграє
        }
      }
      dedupedMap.set(sku, fields);
    }

    const entries = Array.from(dedupedMap.entries());
    const dedupedSkus = totalRows - skippedNoSku - entries.length;

    // SET clause: для кожного поля — перезапис або fill-empty.
    //   targetAlias — таблиця-ціль (mc для UPDATE, master_catalog для ON CONFLICT).
    //   srcExpr(field) — звідки беремо нове значення:
    //     UPDATE ... FROM b → з b.fields; ON CONFLICT → з EXCLUDED (b недоступний).
    const buildSetClause = (targetAlias: string, srcExpr: (m: { field: string; isNumeric: boolean }) => string) =>
      mapping
        .map((m) => {
          const src = srcExpr(m);
          if (overwriteFilled) {
            return `${m.field} = COALESCE(${src}, ${targetAlias}.${m.field})`;
          }
          const isEmpty = m.isNumeric
            ? `${targetAlias}.${m.field} IS NULL`
            : `(${targetAlias}.${m.field} IS NULL OR btrim(${targetAlias}.${m.field}::text) = '')`;
          return `${m.field} = CASE WHEN ${isEmpty} THEN COALESCE(${src}, ${targetAlias}.${m.field}) ELSE ${targetAlias}.${m.field} END`;
        })
        .join(', ');

    const fromBexpr = (m: { field: string; isNumeric: boolean }) =>
      m.isNumeric ? `NULLIF(b.fields->>'${m.field}','')::numeric` : `NULLIF(b.fields->>'${m.field}','')`;
    const fromExcluded = (m: { field: string }) => `EXCLUDED.${m.field}`;

    let created = 0;
    let updated = 0;
    let fieldsWritten = 0;

    for (let i = 0; i < entries.length; i += UPSERT_BATCH_SIZE) {
      const batch = entries.slice(i, i + UPSERT_BATCH_SIZE);
      for (const [, f] of batch) fieldsWritten += Object.keys(f).length;
      const skus = batch.map(([sku]) => sku);
      const fieldJsons = batch.map(([, f]) => JSON.stringify(f));

      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `CREATE TEMP TABLE _excel_fields (sku TEXT PRIMARY KEY, fields JSONB) ON COMMIT DROP`
        );
        await client.query(
          `INSERT INTO _excel_fields (sku, fields)
             SELECT * FROM UNNEST($1::text[], $2::jsonb[])`,
          [skus, fieldJsons]
        );

        if (updateOnly) {
          const res = await client.query(
            `UPDATE master_catalog mc
                SET ${buildSetClause('mc', fromBexpr)}, updated_at = NOW()
               FROM _excel_fields b
              WHERE mc.sku = b.sku`
          );
          updated += res.rowCount || 0;
        } else {
          const insertExprs = mapping.map(fromBexpr).join(', ');
          const res = await client.query<{ inserted: boolean }>(
            `INSERT INTO master_catalog (sku, ${mappedFields.join(', ')}, created_at, updated_at)
               SELECT b.sku, ${insertExprs}, NOW(), NOW()
                 FROM _excel_fields b
               ON CONFLICT (sku) DO UPDATE SET ${buildSetClause('master_catalog', fromExcluded)}, updated_at = NOW()
               RETURNING (xmax = 0) AS inserted`
          );
          for (const r of res.rows) {
            if (r.inserted) created++;
            else updated++;
          }
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    }

    const skippedNoMatch = updateOnly ? entries.length - updated : 0;
    const durationMs = Date.now() - startedAt;
    this.logs
      .log(null, 'info', 'excel_import_direct: finished', {
        sheetName, totalRows, created, updated, skippedNoSku, skippedNoMatch,
        dedupedSkus, fieldsWritten, mappedFields, updateOnly, durationMs
      })
      .catch(() => undefined);

    return {
      sheetName, totalRows, created, updated, skippedNoSku, skippedNoMatch,
      dedupedSkus, fieldsWritten, mappedFields, durationMs
    };
  }

  /** Імпорт: очистка + дедуп по SKU + upsert у master_catalog батчами по 500. */
  async importFile(buffer: Buffer, opts: ExcelImportOptions): Promise<ExcelImportResult> {
    const startedAt = Date.now();
    const { sheetName, matrix, headers } = this.parseSheet(buffer, opts);
    const sourceKey = (opts.sourceKey || 'excel_upload').trim() || 'excel_upload';
    const headerRowNum = Math.max(1, Math.trunc(Number(opts.headerRow) || 1));

    const skuIdx = resolveColumnIndex(headers, opts.skuColumn);
    if (skuIdx < 0) {
      const err = new Error(`Колонку SKU "${opts.skuColumn}" не знайдено у заголовках`);
      (err as { status?: number }).status = 400;
      throw err;
    }
    const photoIdx = opts.photoColumn ? resolveColumnIndex(headers, opts.photoColumn) : -1;
    const excluded = new Set(
      (opts.excludedColumns || []).map((c) => c.trim().toLowerCase()).filter(Boolean)
    );

    // Побудова items: {sku, item, photo}. Дедуп по SKU — перший виграє.
    let totalRows = 0;
    let skippedNoSku = 0;
    const dedupedMap = new Map<string, { item: Record<string, string>; photo: string | null }>();
    for (let i = headerRowNum; i < matrix.length; i++) {
      const row = matrix[i];
      if (!row || row.every((c) => c === null || c === '' || typeof c === 'undefined')) continue;
      totalRows++;

      const skuRaw = row[skuIdx];
      const sku = skuRaw === null || typeof skuRaw === 'undefined' ? '' : String(skuRaw).trim();
      if (!sku) {
        skippedNoSku++;
        continue;
      }
      if (dedupedMap.has(sku)) continue;

      const item: Record<string, string> = {};
      for (let j = 0; j < headers.length; j++) {
        if (j === skuIdx || j === photoIdx) continue; // sku йде окремо, фото — у колонку photo
        if (excluded.has(headers[j].label.trim().toLowerCase())) continue;
        const cleaned = cleanValue(row[j]);
        if (cleaned !== null) item[headers[j].label] = cleaned;
      }
      const photoRaw = photoIdx >= 0 ? row[photoIdx] : null;
      const photo = photoRaw === null || typeof photoRaw === 'undefined' ? null : String(photoRaw).trim() || null;
      dedupedMap.set(sku, { item, photo });
    }

    const entries = Array.from(dedupedMap.entries());
    const dedupedSkus = totalRows - skippedNoSku - entries.length;

    let created = 0;
    let updated = 0;

    for (let i = 0; i < entries.length; i += UPSERT_BATCH_SIZE) {
      const batch = entries.slice(i, i + UPSERT_BATCH_SIZE);
      const skus = batch.map(([sku]) => sku);
      const itemJsons = batch.map(([, v]) => JSON.stringify(v.item));
      const photos = batch.map(([, v]) => v.photo);

      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `CREATE TEMP TABLE _excel_batch (sku TEXT PRIMARY KEY, item JSONB, photo TEXT) ON COMMIT DROP`
        );
        await client.query(
          `INSERT INTO _excel_batch (sku, item, photo)
             SELECT * FROM UNNEST($1::text[], $2::jsonb[], $3::text[])`,
          [skus, itemJsons, photos]
        );
        const res = await client.query<{ inserted: boolean }>(
          `INSERT INTO master_catalog (sku, feed_params, feed_matched_at, feed_source, photo, created_at, updated_at)
             SELECT b.sku,
                    jsonb_build_object(
                      $1::text,
                      jsonb_build_object('imported_at', to_jsonb(NOW()), 'data', b.item)
                    ),
                    NOW(), $1::text, b.photo, NOW(), NOW()
               FROM _excel_batch b
             ON CONFLICT (sku) DO UPDATE SET
               feed_params = jsonb_set(
                 COALESCE(master_catalog.feed_params, '{}'::jsonb),
                 ARRAY[$1::text],
                 EXCLUDED.feed_params -> $1::text,
                 true
               ),
               feed_matched_at = NOW(),
               feed_source = $1::text,
               photo = CASE
                 WHEN $2::boolean OR master_catalog.photo IS NULL OR btrim(master_catalog.photo) = ''
                   THEN COALESCE(EXCLUDED.photo, master_catalog.photo)
                 ELSE master_catalog.photo
               END,
               updated_at = NOW()
             RETURNING (xmax = 0) AS inserted`,
          [sourceKey, opts.overwritePhoto === true]
        );
        for (const r of res.rows) {
          if (r.inserted) created++;
          else updated++;
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    }

    const durationMs = Date.now() - startedAt;
    this.logs
      .log(null, 'info', 'excel_import: finished', {
        sheetName, totalRows, created, updated, skippedNoSku, dedupedSkus, durationMs, sourceKey
      })
      .catch(() => undefined);

    return { sheetName, totalRows, created, updated, skippedNoSku, dedupedSkus, durationMs };
  }

  /** Спільний парсинг: workbook → matrix + headers з літерами колонок. */
  private parseSheet(
    buffer: Buffer,
    opts: { sheetName?: string; headerRow?: number }
  ): {
    workbook: XLSX.WorkBook;
    sheetName: string;
    matrix: unknown[][];
    headers: Array<{ letter: string; label: string }>;
  } {
    const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false, cellNF: false, dense: true });
    const sheetName = opts.sheetName || workbook.SheetNames[0];
    if (!sheetName || !workbook.Sheets[sheetName]) {
      const err = new Error(`Аркуш "${opts.sheetName || '<перший>'}" не знайдено. Доступні: ${workbook.SheetNames.join(', ')}`);
      (err as { status?: number }).status = 400;
      throw err;
    }
    const matrix = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
      header: 1,
      raw: false,
      defval: null
    }) as unknown[][];

    const headerRowNum = Math.max(1, Math.trunc(Number(opts.headerRow) || 1));
    if (matrix.length < headerRowNum) {
      const err = new Error(`Аркуш "${sheetName}" порожній або header_row=${headerRowNum} за межами`);
      (err as { status?: number }).status = 400;
      throw err;
    }

    const seen = new Map<string, number>();
    const headers = (matrix[headerRowNum - 1] || []).map((h, idx) => {
      let label = h === null || typeof h === 'undefined' ? '' : String(h).trim();
      if (!label) label = `col_${XLSX.utils.encode_col(idx)}`;
      // Дублікати заголовків → суфікс _2, _3 (інакше значення перезапишуться).
      const count = (seen.get(label) || 0) + 1;
      seen.set(label, count);
      if (count > 1) label = `${label}_${count}`;
      return { letter: XLSX.utils.encode_col(idx), label };
    });

    return { workbook, sheetName, matrix, headers };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Колонка задається літерою ('A', 'AB') або точною назвою заголовка. */
function resolveColumnIndex(headers: Array<{ letter: string; label: string }>, column: string): number {
  const c = (column || '').trim();
  if (!c) return -1;
  const byLabel = headers.findIndex((h) => h.label === c);
  if (byLabel >= 0) return byLabel;
  if (/^[A-Z]+$/.test(c)) {
    const byLetter = headers.findIndex((h) => h.letter === c);
    if (byLetter >= 0) return byLetter;
  }
  return headers.findIndex((h) => h.label.toLowerCase() === c.toLowerCase());
}

/**
 * Авто-зіставлення колонок Excel на поля master_catalog за алиасами.
 * Для кожного поля — колонки в порядку пріоритету (перше непорожнє виграє).
 * Повертає лише поля, для яких знайшлась хоч одна колонка.
 */
function suggestFieldMapping(headers: Array<{ letter: string; label: string }>): FieldMappingEntry[] {
  const byLower = new Map<string, string>();
  for (const h of headers) {
    const k = h.label.trim().toLowerCase();
    if (!byLower.has(k)) byLower.set(k, h.label); // перша колонка з такою назвою
  }
  const out: FieldMappingEntry[] = [];
  for (const field of MASTER_CATALOG_FIELDS) {
    const aliases = FIELD_COLUMN_ALIASES[field] || [field];
    const columns: string[] = [];
    for (const alias of aliases) {
      const found = byLower.get(alias.trim().toLowerCase());
      if (found && !columns.includes(found)) columns.push(found);
    }
    if (columns.length > 0) out.push({ field, columns });
  }
  return out;
}

/** Case-insensitive substring матчинг назви колонки проти списку виключень. */
function matchesExcluded(label: string, excludedTokens: string[]): boolean {
  const l = label.trim().toLowerCase();
  return excludedTokens.some((t) => {
    const token = t.trim().toLowerCase();
    return token.length > 0 && l.includes(token);
  });
}

/**
 * Очистка значення клітинки: HTML геть, entities декодовані, пробіли колапсовані.
 * null = значення порожнє і не повинно потрапити у data.
 */
export function cleanValue(value: unknown): string | null {
  if (value === null || typeof value === 'undefined') return null;
  let s = String(value);
  if (!s.trim()) return null;

  // Блочні теги → новий рядок, щоб текст не злипався.
  s = s.replace(/<\s*(br|\/p|\/li|\/div|\/tr|\/h[1-6])\s*\/?\s*>/gi, '\n');
  // Решта тегів геть.
  s = s.replace(/<[^>]*>/g, ' ');
  // Зіпсовані entities з бекслешем (експорт екранував ';' як '\;'):
  // "Jack &amp\; Jones" → "&amp;" → нижче decode → "Jack & Jones".
  s = s.replace(/&([a-z]+|#\d+)\\+;/gi, '&$1;');
  // Базові entities.
  s = s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&laquo;/gi, '«')
    .replace(/&raquo;/gi, '»')
    .replace(/&mdash;/gi, '—')
    .replace(/&ndash;/gi, '–');
  // Пробіли: табуляція/множинні пробіли → один; 3+ переноси → подвійний; trim рядків.
  s = s
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return s.length > 0 ? s : null;
}
