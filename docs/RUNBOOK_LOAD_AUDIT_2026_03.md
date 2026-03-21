# Runbook: Backend Load Audit (100k / 300k / 500k)

Для multi-iteration stress з dry-run store batch див.
`docs/RUNBOOK_BACKEND_STRESS_AUDIT_2026_03.md` (`npm run audit:stress`).

## Goal
- Провести відтворюваний backend-only аудит продуктивності без зміни бізнес-логіки.
- Зафіксувати метрики для етапів:
  - finalize
  - preview
  - compare preview

## Script
- `npm run audit:load`
- Реалізація: `src/scripts/runLoadAudit.ts`

## Safety gates
- Скрипт не стартує без явного підтвердження:
  - `LOAD_AUDIT_CONFIRM=YES`
- За замовчуванням скрипт вимагає порожню БД (safety):
  - `LOAD_AUDIT_ALLOW_NONEMPTY_DB=false` (default)
- Якщо БД непорожня, потрібен додатковий explicit gate:
  - `LOAD_AUDIT_ALLOW_DESTRUCTIVE=true`
- Cleanup synthetic даних ввімкнений за замовчуванням:
  - `LOAD_AUDIT_CLEANUP=true`

## Main env options
- `DATABASE_URL` (required)
- `LOAD_AUDIT_COUNTS` (default: `100000,300000,500000`)
- `LOAD_AUDIT_SUPPLIERS` (default: `24`)
- `LOAD_AUDIT_MIRROR_SEED_LIMIT` (default: `20000`)
- `LOAD_AUDIT_OUTPUT` (default: `output/load-audit-<timestamp>.json`)
- `LOAD_AUDIT_ALLOW_DESTRUCTIVE` (default: `false`; required for non-empty DB runs)
- `FINALIZE_DELETE_ENABLED` (default: `true`)
- `PRICE_AT_IMPORT` (default: `false`)

## Example run (isolated DB)

```bash
LOAD_AUDIT_CONFIRM=YES \
LOAD_AUDIT_ALLOW_NONEMPTY_DB=false \
LOAD_AUDIT_ALLOW_DESTRUCTIVE=false \
LOAD_AUDIT_COUNTS=100000,300000,500000 \
LOAD_AUDIT_SUPPLIERS=24 \
LOAD_AUDIT_MIRROR_SEED_LIMIT=20000 \
LOAD_AUDIT_CLEANUP=true \
npm run audit:load
```

## Output
- JSON report with per-scenario metrics:
  - `finalizeDurationMs`
  - `finalizeSummary.rawCount`
  - `finalizeSummary.finalCount`
  - `previewDurationMs`
  - `previewTotal`
  - `compareDurationMs`
  - `compareTotal`
  - `compareMissingDurationMs`
  - `compareMissingTotal`
- Path printed in stdout and saved to `LOAD_AUDIT_OUTPUT`.

## Notes
- Скрипт використовує synthetic suppliers/rows (`load_audit_supplier_*`).
- Export/preview API тести у цьому runbook не гоняться через HTTP; перевіряється backend service path напряму.
- Для production-like staging (непорожня БД) вмикати `LOAD_AUDIT_ALLOW_NONEMPTY_DB=true` тільки у контрольованому вікні.
- Для production-like staging (непорожня БД) одночасно ставити `LOAD_AUDIT_ALLOW_DESTRUCTIVE=true` тільки на ізольованій staging БД.
