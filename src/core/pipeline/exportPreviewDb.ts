import type { Pool } from 'pg';
import type { ExportPreviewProvider, ExportPreviewSummary } from './contracts';

function deriveParentArticle(article: string, size: string | null): string | null {
  const baseArticle = String(article || '').trim();
  const sizeValue = String(size || '').trim();
  if (!baseArticle || !sizeValue) {
    return null;
  }
  const escapedSize = sizeValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`([\\s\\-_/]+)?${escapedSize}$`, 'i');
  if (!pattern.test(baseArticle)) {
    return null;
  }
  const stripped = baseArticle.replace(pattern, '').trim();
  return stripped || null;
}

export class ExportPreviewDb implements ExportPreviewProvider {
  constructor(private readonly pool: Pool) {}

  async buildNeutralPreview(
    jobId: number,
    options: { supplier: string | null }
  ): Promise<ExportPreviewSummary> {
    const supplierFilter = options.supplier ? options.supplier.toLowerCase() : null;

    const finalizeJobResult = await this.pool.query(
      `SELECT id FROM jobs
       WHERE type = 'finalize'
         AND status = 'success'
       ORDER BY id DESC
       LIMIT 1`
    );
    const finalizeJobId = finalizeJobResult.rows[0]?.id || null;
    if (!finalizeJobId) {
      throw new Error('No finalize job found');
    }

    const values: Array<string | number> = [finalizeJobId];
    let where = 'WHERE pf.job_id = $1';
    if (supplierFilter) {
      values.push(supplierFilter);
      where += ` AND LOWER(sp.name) = LOWER($${values.length})`;
    }

    const result = await this.pool.query(
      `SELECT
         pf.article,
         pf.size,
         pf.quantity,
         pf.price_final,
         pf.supplier_id,
         sp.name AS supplier_name,
         sp.sku_prefix AS supplier_sku_prefix
       FROM products_final pf
       LEFT JOIN suppliers sp ON sp.id = pf.supplier_id
       ${where}
       ORDER BY pf.article ASC, pf.size ASC`,
      values
    );

    const rows = result.rows.map((row) => {
      // If products_final stores article ("GY6433") and size ("37.5") separately,
      // combine them into the full SKU that CS-Cart knows ("GY6433-37.5").
      // Products where the article already contains the size (e.g. "NK1234-37")
      // have size=null and are kept as-is.
      const sizeValue = String(row.size || '').trim();
      // Guard against double-size: if the article already ends with "-{size}"
      // (e.g. article="010282-700-105", size="105"), do not append the size again.
      // This happens when a supplier embeds the size in the article field AND also
      // populates the size column — appending would produce "010282-700-105-105"
      // which never matches any CS-Cart product code.
      const articleAlreadyHasSize = sizeValue
        ? String(row.article || '').endsWith(`-${sizeValue}`)
        : false;
      const fullArticle = (sizeValue && !articleAlreadyHasSize)
        ? `${row.article}-${sizeValue}`
        : row.article;
      // Do not attempt to derive a parent article from a size-suffixed full article —
      // CS-Cart parent-child relationships are read from store_mirror, not products_final.
      const parentArticle = (sizeValue && !articleAlreadyHasSize) ? null : deriveParentArticle(row.article, row.size);
      const quantity = Number(row.quantity || 0);
      return {
        article: fullArticle,
        size: row.size,
        quantity,
        priceFinal: row.price_final === null ? null : Number(row.price_final),
        visibility: quantity > 0,
        parentArticle,
        supplier: row.supplier_name || null,
        supplierSkuPrefix: row.supplier_sku_prefix || null
      };
    });

    return {
      supplier: options.supplier,
      total: rows.length,
      rows
    };
  }
}
