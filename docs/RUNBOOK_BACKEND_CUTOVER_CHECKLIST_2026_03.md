# Runbook: Backend cutover checklist (CS-Cart)

## Goal
- Дати один повторюваний preflight перед production `store_import`.
- Не змінювати бізнес-логіку, тільки перевірити готовність backend-інфраструктури.

## 0) Invariant integration suite
```bash
cd /Users/monstermac/WebstormProjects/whitehall_cscard
set -a; source .env; set +a
npm run test:invariants
```

Очікування:
- JSON результат із `"ok": true`.

## 1) SKU duplicate audit (read-only)
```bash
cd /Users/monstermac/WebstormProjects/whitehall_cscard
set -a; source .env; set +a
npm run store:sku-audit
```

Очікування:
- `duplicate_sku_count = 0`

## 2) Mirror snapshot (read-only)
```bash
cd /Users/monstermac/WebstormProjects/whitehall_cscard
set -a; source .env; set +a
npm run mirror:sync
```

## 3) Readiness snapshot (CLI)
```bash
cd /Users/monstermac/WebstormProjects/whitehall_cscard
set -a; source .env; set +a
BACKEND_READINESS_MAX_MIRROR_AGE_MINUTES=120 npm run backend:readiness
```

## 4) Readiness snapshot (API)
```bash
curl -sS -b /tmp/wh_safe.cookies \
  "http://127.0.0.1:3000/admin/api/backend-readiness?store=cscart&maxMirrorAgeMinutes=120"
```

## Мінімальні гейти перед store import
- `gates.has_import_all_success = true`
- `gates.has_finalize_success = true`
- `gates.has_mirror_snapshot = true`
- `gates.mirror_is_fresh = true`
- `gates.no_blocking_jobs = true`
- `gates.ready_for_store_import = true`
- `gates.ready_for_continuous_runs = true` (вимагає ввімкнений cleanup)

## Що дивитися додатково
- `coverage.matched_percent` — покриття фінальних SKU у mirror-магазині.
- `data_volume.products_raw_rows` + `products_raw_oldest_created_at` — контроль росту raw.
- `scheduler.cleanup_enabled` — чи увімкнений auto-retention.
- Для безпечного тестового контуру тримати `update_pipeline` scheduler вимкненим, щоб уникнути автоматичного `store_import`.

## Latest local snapshot (2026-03-21)
- `store:sku-audit`: `duplicate_sku_count = 0`
- `mirror:sync`: `upserted = 660`, `deleted = 0`
- `backend:readiness`: `gates.ready_for_store_import = true`, `gates.ready_for_continuous_runs = true`
