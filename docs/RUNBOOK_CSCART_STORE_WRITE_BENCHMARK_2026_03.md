# Runbook: CS-Cart live write benchmark (+delta + rollback)

## Мета
- Заміряти реальну пропускну здатність `store_import` write-path на тестовому магазині.
- Прогнати контрольований сценарій:
  - масова зміна ціни (`+N`) для вибраних SKU;
  - замір часу/throughput;
  - автоматичний rollback;
  - recovery rollback для помилкових SKU (якщо були transient API fail).

## Важливо
- Сценарій **робить реальні PUT-запити в магазин**.
- Запускати тільки на тестовому домені або в погоджене low-traffic вікно.

## Передумови
- `ACTIVE_STORE=cscart`
- валідні `CSCART_BASE_URL / CSCART_API_USER / CSCART_API_KEY`
- зібраний проект (`npm run build`)

## Базовий запуск (10 000 SKU, +100)
```bash
cd /Users/monstermac/WebstormProjects/whitehall_cscard
set -a; source .env; set +a

CSCART_RATE_LIMIT_RPS=30 \
CSCART_RATE_LIMIT_BURST=90 \
CSCART_IMPORT_CONCURRENCY=12 \
CSCART_PRICE_BENCHMARK_CONFIRM=YES \
CSCART_PRICE_BENCHMARK_LIMIT=10000 \
CSCART_PRICE_BENCHMARK_DELTA=100 \
npm run benchmark:store-price
```

Скрипт:
- бере товари з store mirror walk (`/api/products` через connector path),
- формує snapshot (`rollbackFile` у `/tmp`),
- застосовує `+delta`,
- виконує rollback до `originalPrice`,
- повертає JSON із метриками.

## Recovery rollback (якщо є failed > 0)
```bash
cd /Users/monstermac/WebstormProjects/whitehall_cscard
set -a; source .env; set +a

CSCART_RATE_LIMIT_RPS=30 \
CSCART_RATE_LIMIT_BURST=90 \
CSCART_IMPORT_CONCURRENCY=12 \
CSCART_ROLLBACK_FILE=/tmp/cscart_price_benchmark_rollback_<timestamp>.json \
CSCART_ROLLBACK_CONFIRM=YES \
CSCART_ROLLBACK_RETRIES=4 \
npm run rollback:store-file
```

## Зафіксований результат (test.whitehall.com.ua, 2026-03-25 Kyiv)
- Вхід:
  - `benchmarkRows=10000`
  - `priceDelta=100`
  - `fetchedFromStore=20577`
  - `pagesFetched=21`
- Phase `apply_plus_delta`:
  - `durationMs=452965` (~7m33s)
  - `imported=9999`
  - `failed=1`
  - `rate=22.08 SKU/s`
- Phase `rollback`:
  - `durationMs=436300` (~7m16s)
  - `imported=9996`
  - `skipped=1`
  - `failed=3`
  - `rate=22.92 SKU/s`
- Після recovery-pass:
  - `remainingRows=0`

## Додатковий прогін (test.whitehall.com.ua, 2026-03-26 Kyiv)
- Профіль: `RPS=40`, `BURST=120`, `CONCURRENCY=16`.
- Вхід:
  - `benchmarkRows=10000`
  - `priceDelta=100`
  - `fetchedFromStore=20577`
  - `pagesFetched=21`
- Phase `apply_plus_delta`:
  - `durationMs=440377` (~7m20s)
  - `imported=10000`
  - `failed=0`
  - `rate=22.71 SKU/s`
- Phase `rollback`:
  - `durationMs=434345` (~7m14s)
  - `imported=9999`
  - `failed=1`
  - `warningsCount=1`
  - `rate=23.02 SKU/s`
- Recovery rollback:
  - `rollbackFile=/tmp/cscart_price_benchmark_rollback_2026-03-26T15-27-34-096Z.json`
  - `attempt #1: imported=5, skipped=9995, failed=0`
  - `remainingRows=0`

## Тюнінг швидкості (покроково)
Рухатися тільки сходинками, з фіксацією `failed`/`warningsCount`:
1. `RPS=30, BURST=90, CONCURRENCY=12` (baseline)
2. `RPS=40, BURST=120, CONCURRENCY=16`
3. `RPS=50, BURST=150, CONCURRENCY=20`

Якщо ростуть `429/5xx`, відкотитись на попередній стабільний профіль.

Орієнтовний час для `10 000` SKU (оцінка, не SLA):
- профіль #2: ~`5-6` хв;
- профіль #3: ~`4-5` хв;
- фактичний результат залежить від поточного навантаження CS-Cart/PHP-FPM/MySQL.

## Ризики для сайту
- Високий RPS дає навантаження на:
  - PHP-FPM/Apache/Nginx воркери,
  - MySQL write path,
  - інші адмін-операції.
- Під час агресивного write benchmark можливі:
  - повільніші відповіді адмінки,
  - коливання latency storefront/checkout,
  - тимчасові API помилки (`429`, `5xx`).

Рекомендація:
- тестувати у вікно низького трафіку;
- тримати моніторинг `5xx`, `php-fpm busy`, `mysql slow queries`;
- використовувати delta-only updates у робочих ранах.
- для production тримати стабільний профіль на 1 щабель нижче максимального, який пройшов benchmark.
