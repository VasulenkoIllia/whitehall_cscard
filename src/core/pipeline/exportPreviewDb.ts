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
      const parentArticle = deriveParentArticle(row.article, row.size);
      return {
        article: row.article,
        size: row.size,
        priceFinal: row.price_final === null ? null : Number(row.price_final),
        visibility: true,
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
