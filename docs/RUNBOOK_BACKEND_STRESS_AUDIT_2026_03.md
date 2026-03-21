# Runbook: Backend stress audit (no store writes)

## Мета
- Максимально навантажити backend/DB без запису в CS-Cart.
- Прогнати кілька ітерацій з мутацією цін/залишків.
- Оцінити, як система витримує великі обсяги (`500k raw`) і який dry-run обсяг оновлень піде в store-import батч.

## Що робить `audit:stress`
- Генерує synthetic `products_raw`.
- Запускає `finalize`.
- Будує `preview` + `compare`.
- Синтетично наповнює `store_mirror` (із feature `564=Y` за замовчуванням).
- Рахує dry-run store batch через той самий optimizer path (`feature-scope` + `missing-hide` + `delta`) без `PUT/POST` у магазин.
- Пише JSON-звіт у `output/stress-audit-<timestamp>.json`.

## Важливі прапорці безпеки
- Обов’язково:
  - `STRESS_AUDIT_CONFIRM=YES`
- Для непорожньої БД:
  - `STRESS_AUDIT_ALLOW_NONEMPTY_DB=true`
  - `STRESS_AUDIT_ALLOW_DESTRUCTIVE=true`

## Базовий запуск
```bash
cd /Users/monstermac/WebstormProjects/whitehall_cscard
set -a; source .env; set +a

STRESS_AUDIT_CONFIRM=YES \
STRESS_AUDIT_ALLOW_NONEMPTY_DB=true \
STRESS_AUDIT_ALLOW_DESTRUCTIVE=true \
STRESS_AUDIT_CLEANUP=true \
npm run audit:stress
```

## Цільовий сценарій (ваш кейс)
Симуляція:
- `500k` сирих рядків
- кілька ітерацій перерахунку з мутацією
- dry-run батч до магазину при `mirror seed limit = 300k`
- без реального завантаження в сайт

```bash
cd /Users/monstermac/WebstormProjects/whitehall_cscard
set -a; source .env; set +a

STRESS_AUDIT_CONFIRM=YES \
STRESS_AUDIT_ALLOW_NONEMPTY_DB=true \
STRESS_AUDIT_ALLOW_DESTRUCTIVE=true \
STRESS_AUDIT_COUNTS=500000 \
STRESS_AUDIT_ITERATIONS=3 \
STRESS_AUDIT_MIRROR_SEED_LIMIT=300000 \
STRESS_AUDIT_MIRROR_EXTRA_ROWS=20000 \
STRESS_AUDIT_DRY_STORE_BATCH=true \
STRESS_AUDIT_CLEANUP=true \
npm run audit:stress
```

## Корисні env-параметри
- Обсяг:
  - `STRESS_AUDIT_COUNTS` (default: `100000,300000,500000`)
  - `STRESS_AUDIT_ITERATIONS` (default: `3`)
  - `STRESS_AUDIT_SUPPLIERS` (default: `24`)
- Мутації:
  - `STRESS_AUDIT_MUTATION_PERCENT` (default: `30`)
  - `STRESS_AUDIT_PRICE_SHIFT_PERCENT` (default: `12`)
  - `STRESS_AUDIT_QUANTITY_ZERO_PERCENT` (default: `10`)
- Dry-run store batch:
  - `STRESS_AUDIT_DRY_STORE_BATCH` (default: `true`)
  - `STRESS_AUDIT_FEATURE_SCOPE_ENABLED` (default: `true`)
  - `STRESS_AUDIT_FEATURE_SCOPE_ID` (default: `564`)
  - `STRESS_AUDIT_FEATURE_SCOPE_VALUE` (default: `Y`)
  - `STRESS_AUDIT_DISABLE_MISSING_ON_FULL_IMPORT` (default: `true`)
- Mirror seed:
  - `STRESS_AUDIT_MIRROR_SEED_LIMIT` (default: `300000`)
  - `STRESS_AUDIT_MIRROR_EXTRA_ROWS` (default: `20000`)
  - `STRESS_AUDIT_MIRROR_ARTICLE_MODE=plain|derived` (default: `plain`)

## Що дивитися у звіті
- `durationsMs.finalize` — час finalize.
- `durationsMs.compare` / `compareMissing` — час compare path.
- `dryStoreBatch.totalAfterDelta` — очікуваний обсяг реальних update-операцій у store import.
- `dbSnapshot.tableBytes.*` — фактичний ріст таблиць.
- `assertions` — інваріантні перевірки сценарію.

## Важливо
- Це backend stress без HTTP store write path.
- Пропускну здатність реального CS-Cart API (PUT/POST) тестуємо окремо після наповнення реальними товарами.
