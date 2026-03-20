# Runbook: Stabilize Finalize (March 2026)

## Context

In March 2026 `finalize` started taking 15-30+ minutes and often timed out or was canceled manually.
This caused pipeline instability and temporary API/front timeouts during rollback after cancel.

## Main reasons

1. Heavy price computation inside `finalize` on large `products_raw` volume (`~500k` rows).
2. Expensive SQL plan (window/group operations + rule matching during finalize).
3. Missing dedicated index path for active markup rule lookups.
4. Schedule overlap risk (`update_pipeline` vs `horoshop_sync`) increased contention risk.

## What was changed

### 1) Faster finalize selection logic

File: `src/services/finalizeService.js`

1. Replaced multi-pass winner selection with single-pass:
   - `DISTINCT ON (article, size)`
   - ordered by `supplier_priority`, `price_final`, `supplier_id`.
2. Added detailed stage timings in logs (`stageMs`, `durationMs`) for diagnostics.
3. Added `application_name` tagging (`whitehall:finalize:<jobId>`) for safe backend termination on cancel.
4. Finalize now always uses latest successful `import_all`.

### 2) Price precomputation during import (feature flag)

Files:
- `src/services/importService.js`
- `src/services/finalizeService.js`
- `src/config.js`
- `.env.example`
- `migrations/019_add_price_with_markup_to_products_raw.sql`

Behavior:
1. New env flag: `PRICE_AT_IMPORT=true|false`.
2. New column: `products_raw.price_with_markup`.
3. When `PRICE_AT_IMPORT=true`, import computes markup price once and stores it in `products_raw`.
4. Finalize uses fast precomputed branch when:
   - `PRICE_AT_IMPORT=true`
   - latest import has `missingPrecomputedCount=0`.
5. If precomputed values are missing, finalize automatically falls back to previous in-finalize pricing logic (no data loss).

### 3) DB indexes for stability

1. `017_add_products_raw_job_index.sql`:
   - index on `products_raw(job_id)`.
2. `018_add_markup_rule_conditions_active_lookup_index.sql`:
   - partial index for active rule lookup:
   - `(rule_set_id, priority, id, price_from, price_to) WHERE is_active = TRUE`.

### 4) Operational safety on cancel

Files:
- `src/services/jobService.js`
- `src/routes/jobs.js`

1. Cancel now terminates matching backend PID for running jobs.
2. Pipeline cancel also cancels/terminates child jobs.
3. Stale lock cleanup improved in lock acquisition.

## Required runtime configuration

Recommended:

1. `PRICE_AT_IMPORT=true`
2. `POST_IMPORT_ANALYZE=true`
3. `FINALIZE_WORK_MEM_MB=128` (or keep `0` and tune role/server `work_mem`)
4. Non-overlapping cron windows for:
   - `update_pipeline`
   - `horoshop_sync`

## Rollout procedure

1. Disable cron for `update_pipeline` and `horoshop_sync`.
2. Deploy code + run migrations.
3. Ensure migrations `018` and `019` were applied.
4. Run fresh `import_all` (required to fill `price_with_markup`).
5. Run `finalize`.
6. Check logs: `Final dataset built` must show:
   - `usePrecomputedPricing=true`
   - `missingPrecomputedCount=0`
7. Re-enable cron jobs.

## Verification queries

Check latest finalize duration:

```sql
SELECT id,type,status,started_at,finished_at,(finished_at-started_at) AS duration,meta->>'error' AS error
FROM jobs
WHERE type='finalize'
ORDER BY id DESC
LIMIT 5;
```

Check finalize branch and timings:

```sql
WITH lf AS (SELECT id FROM jobs WHERE type='finalize' ORDER BY id DESC LIMIT 1)
SELECT created_at, message,
       data->>'usePrecomputedPricing' AS use_precomputed,
       data->>'missingPrecomputedCount' AS missing_precomputed,
       data->'stageMs' AS stage_ms,
       data->>'durationMs' AS duration_ms
FROM logs
WHERE job_id=(SELECT id FROM lf)
  AND message IN ('Final dataset built','Final dataset build failed')
ORDER BY id DESC
LIMIT 1;
```

## Expected result after fix

Typical stable result:
1. `finalize` back to seconds/tens of seconds.
2. Pipeline completes without `finalize` timeout.
3. No long-running finalize rollback incidents after cancel.

## Notes

1. If `PRICE_AT_IMPORT` was enabled now, one successful fresh `import_all` is mandatory before evaluating finalize speed.
2. If any source/supplier mapping is broken, import quality can degrade, but this should not reintroduce finalize SQL bottleneck by itself.
