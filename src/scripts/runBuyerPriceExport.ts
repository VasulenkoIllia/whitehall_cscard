/*
 CLI: вивантаження прайсу покупцям (дроп-ціни) у Google Sheet.

 Локальний smoke-тест синтетичним семплом — потрібні ЛИШЕ Google-креденшели
 (GOOGLE_CLIENT_EMAIL / GOOGLE_PRIVATE_KEY у .env) + права Редактора для
 сервіс-акаунта на цільову таблицю. БД не потрібна.

   # dry-run: побудувати й надрукувати рядки, у Google НЕ писати
   npm run build && node dist/scripts/runBuyerPriceExport.js --sample --dry-run

   # реальний запис синтетичного семплу в чернеткову вкладку "DRAFT"
   node dist/scripts/runBuyerPriceExport.js --sample --sheet <SHEET_ID> --tab DRAFT

 Реальний режим (читання products_final з БД) підключається у Фазі 2b.
*/
import { writeSheetTable } from '../core/pipeline/googleSheetsWriter';

// Колонки прайсу покупцям (узгоджено з користувачем).
const HEADER = ['Артикул', 'Назва', 'Розмір', 'Кількість', 'Ціна'];

interface Args {
  sample: boolean;
  dryRun: boolean;
  tab: string;
  sheet: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { sample: false, dryRun: false, tab: 'DRAFT', sheet: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--sample') args.sample = true;
    else if (a === '--dry-run' || a === '--dry') args.dryRun = true;
    else if (a === '--tab') {
      i += 1;
      args.tab = argv[i] || args.tab;
    } else if (a === '--sheet') {
      i += 1;
      args.sheet = argv[i] || '';
    }
  }
  return args;
}

// Та сама формула, що в SQL: середина база↔фінал, округлена вгору до 10.
function dropPrice(base: number, final: number): number {
  return Math.ceil((base + final) / 2 / 10) * 10;
}

// Штамп «прайс актуальний станом на …» у київському часі.
function buildBanner(now: Date): string {
  const stamp = new Intl.DateTimeFormat('uk-UA', {
    timeZone: 'Europe/Kyiv',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(now);
  return `Прайс актуальний станом на ${stamp} (Київ)`;
}

// Синтетичні, але реалістичні рядки (взяті зі звіреної прод-вибірки).
function buildSampleRows(): (string | number)[][] {
  const samples: Array<{
    article: string;
    name: string;
    size: string;
    qty: number;
    base: number;
    final: number;
  }> = [
    { article: '016.002.0896', name: 'Кросівки бігові', size: '43-46', qty: 3, base: 990, final: 990 },
    { article: 'M1000K', name: 'Кросівки New Balance 1000', size: '41.5', qty: 2, base: 4895, final: 6470 },
    { article: 'HJ5228-101', name: 'Куртка зимова', size: '41', qty: 5, base: 4400, final: 5810 },
    { article: 'C-0818-OR', name: 'Шкарпетки спортивні', size: '', qty: 40, base: 360, final: 660 },
    { article: 'IG7712', name: 'Футболка бавовна', size: '42', qty: 12, base: 1650, final: 2180 },
    { article: 'DV5457-002', name: 'Штани спортивні', size: '28.5', qty: 7, base: 1750, final: 2310 },
    { article: 'G27499', name: 'Худі з капюшоном', size: '36.5', qty: 4, base: 2081, final: 2750 },
    { article: '626502-70', name: 'Пуховик дитячий', size: '140', qty: 1, base: 3790, final: 5010 },
    { article: 'K8012', name: 'Ремінь шкіряний', size: '', qty: 25, base: 450, final: 750 },
    { article: '32509-LTPK', name: 'Топ жіночий', size: '37', qty: 9, base: 2420, final: 3200 },
    { article: '3021286-100', name: 'Лонгслів', size: '46', qty: 6, base: 1084, final: 1390 },
    { article: 'HM4400-001', name: 'Шорти пляжні', size: '30', qty: 15, base: 1520, final: 2010 }
  ];
  return samples.map((s) => [s.article, s.name, s.size, s.qty, dropPrice(s.base, s.final)]);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sheet = args.sheet || process.env.BUYER_PRICE_SHEET_ID || '';

  let rows: (string | number)[][];
  if (args.sample) {
    rows = buildSampleRows();
  } else {
    throw new Error(
      'Реальний режим (з products_final) підключається у Фазі 2b. Для локального тесту використай --sample.'
    );
  }

  if (args.dryRun) {
    console.log(JSON.stringify({ header: HEADER, rows, count: rows.length }, null, 2));
    console.log('DRY-RUN: у Google нічого не записано.');
    return;
  }

  if (!sheet) {
    throw new Error('Вкажи таблицю: --sheet <ID> (або BUYER_PRICE_SHEET_ID у .env)');
  }

  const startedAt = Date.now();
  const result = await writeSheetTable({
    spreadsheetIdOrUrl: sheet,
    sheetName: args.tab,
    header: HEADER,
    rows,
    bannerText: buildBanner(new Date()),
    onProgress: (written, total) => console.log(`  записано ${written}/${total}`)
  });

  console.log(
    JSON.stringify(
      { ok: true, durationMs: Math.max(0, Date.now() - startedAt), ...result },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
