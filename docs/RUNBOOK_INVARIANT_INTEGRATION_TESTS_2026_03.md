# Runbook: invariant integration tests (CS-Cart)

## Goal
- Перевіряти критичні інваріанти без зміни бізнес-логіки перед cutover/релізом.
- Покривати:
  - mapping validation,
  - dedup winner selection,
  - price override precedence,
  - store_import resume mismatch guards.

## Prerequisites
- Доступний PostgreSQL за `DATABASE_URL`.
- Виконані міграції основної БД.

## Run
```bash
cd /Users/monstermac/WebstormProjects/whitehall_cscard
set -a; source .env; set +a
npm run build
npm run test:invariants
```

## Expected result
- Скрипт повертає `exit code 0`.
- У stdout є JSON:
  - `"ok": true`
  - `"suite": "invariant-integration"`
  - `"checks"` містить `mapping`, `dedup-winner`, `override-precedence`, `resume-guards`.

## Implementation notes
- Тести запускаються в окремій тимчасовій schema і видаляють її після завершення.
- Основні production-таблиці не змінюються.
