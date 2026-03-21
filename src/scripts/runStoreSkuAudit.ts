import { createApplication } from '../app/createApplication';

interface SkuSample {
  product_id: string | null;
  status: string | null;
  price: string | number | null;
}

interface DuplicateSkuSummary {
  product_code: string;
  count: number;
  samples: SkuSample[];
}

async function main() {
  const application = createApplication(process.env);
  try {
    if (application.connector.store !== 'cscart') {
      throw new Error(
        `store:sku-audit supports only cscart active store, received ${application.connector.store}`
      );
    }

    const counters = new Map<
      string,
      {
        count: number;
        samples: SkuSample[];
      }
    >();

    let fetched = 0;
    let pages = 0;
    await application.pipeline.forEachStoreMirrorPage((items, page) => {
      pages = page;
      fetched += items.length;
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        const code = String(item.article || '').trim();
        if (!code) {
          continue;
        }
        const existing = counters.get(code) || { count: 0, samples: [] };
        existing.count += 1;
        const raw = item.raw as Record<string, unknown> | undefined;
        if (existing.samples.length < 5) {
          existing.samples.push({
            product_id: raw?.product_id ? String(raw.product_id) : null,
            status: raw?.status ? String(raw.status) : null,
            price: raw?.price === undefined || raw?.price === null ? null : (raw.price as string | number)
          });
        }
        counters.set(code, existing);
      }
    });

    const duplicates: DuplicateSkuSummary[] = [];
    let duplicateRows = 0;
    counters.forEach((entry, productCode) => {
      if (entry.count <= 1) {
        return;
      }
      duplicateRows += entry.count;
      duplicates.push({
        product_code: productCode,
        count: entry.count,
        samples: entry.samples
      });
    });

    duplicates.sort((left, right) => right.count - left.count || left.product_code.localeCompare(right.product_code));

    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify(
        {
          generated_at: new Date().toISOString(),
          store: application.connector.store,
          fetched,
          pages,
          unique_sku_count: counters.size,
          duplicate_sku_count: duplicates.length,
          duplicate_row_count: duplicateRows,
          duplicate_examples: duplicates.slice(0, 100)
        },
        null,
        2
      )
    );
  } finally {
    await application.close();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.stack || err.message : err);
  process.exit(1);
});
