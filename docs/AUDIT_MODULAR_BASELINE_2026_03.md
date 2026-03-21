# Audit: legacy parity and modular baseline (March 2026)

## Scope

- Legacy source of truth: `/Users/monstermac/WebstormProjects/whitehall.store_integration`
- New modular repo under migration: `/Users/monstermac/WebstormProjects/whitehall_cscard`
- Goal: keep business logic unchanged and harden the codebase for 500k items per run, 3-5 runs per day.

## What is actually implemented

### Legacy repo

Legacy contains the real production business flow:
- supplier/source import from Google Sheets
- markup and min-profit logic
- finalize and dedup winner selection
- Horoshop mirror sync and API preview generation
- jobs, cancel flow, cleanup, cron, admin routes

Primary code:
- `src/services/importService.js`
- `src/services/finalizeService.js`
- `src/services/exportService.js`
- `src/services/horoshopService.js`
- `src/jobs/runners.js`

### `whitehall_cscard`

What is already good:
- TypeScript modular split exists: `core`, `connectors`, `app`
- Google Sheets import logic is mostly ported into `src/core/pipeline/importerDb.ts`
- finalize and preview are extracted into separate DB services
- CS-Cart gateway/connector skeleton exists
- env validation and basic auth/session layer exist

What is still not at legacy parity:
- admin CRUD/data APIs are mostly covered (including supplier search/sort and mapping comment field)
- integration test coverage for critical business invariants is still missing
- no staged load-test baseline yet for 100k/300k/500k runs
- Horoshop is intentionally paused in current scope (separate future connector)

## Quality assessment

### Legacy repo

Strengths:
- business rules are explicit and battle-tested
- operational controls exist: cancel, timeout, cleanup, logs
- finalize performance was already improved with precomputed pricing and better SQL

Weak points:
- large monolithic services
- strong Horoshop coupling inside export flow
- duplicated orchestration logic between routes and runners
- cleanup still uses row deletes, not partition lifecycle

### `whitehall_cscard`

Strengths:
- correct architectural direction
- better module boundaries than legacy
- neutral store connector contract is the right foundation

Current rating:
- architecture direction: good
- production readiness: low
- legacy parity: partial
- large-volume readiness: partial after fixes in this audit, but still incomplete

## Critical findings

1. `finalize` in the new repo was not production-safe.
   - `src/core/pipeline/finalizerDb.ts` used `ON CONFLICT (article, size)` without any unique constraint in schema.
   - `migrations/001_init.sql` creates only a plain index on `(article, size)`, not a unique key.
   - Result: first real finalize run would fail at runtime.

2. `finalize` still used full-table delete semantics.
   - Even after modularization, `DELETE FROM products_final` remained in the new finalize path.
   - At the target volume this recreates exactly the instability we are trying to remove.

3. Declared `products_raw` partitioning was not actually used.
   - `migrations/021_partition_products_raw.sql` creates the helper function, but runtime import never called it.
   - New rows would keep landing in the default partition, so retention and write scaling would not improve.

4. Documentation overstated current readiness.
   - `docs/CURRENT_FUNCTIONALITY.md` describes legacy-level functionality, not the real current state of `whitehall_cscard`.
   - This is dangerous for migration planning because it hides what still has to be ported before production cutover.

5. CS-Cart is the active migration target, but config default still pointed to Horoshop.
   - This created a misleading boot path and pushed the app toward an unimplemented connector by default.

## Fixes completed in this audit

### 1. Finalize rewritten to safe staged merge

Changed file:
- `src/core/pipeline/finalizerDb.ts`

What changed:
- removed reliance on invalid `ON CONFLICT (article, size)`
- replaced full-table refresh with staged `UPDATE + INSERT`
- stale rows are pruned by `job_id` only after current rows are materialized
- current finalize count is now measured by current finalize `job_id`

Effect:
- same business result
- no schema-dependent runtime failure
- lower churn and lower risk under large datasets

### 2. Runtime activation of `products_raw` daily partitions

Changed file:
- `src/core/pipeline/importerDb.ts`

What changed:
- import now checks whether `ensure_products_raw_partition(date)` exists
- if yes, it creates the current-day partition before raw inserts

Effect:
- migration 021 becomes operational instead of cosmetic
- daily imports stop piling only into the default partition

### 3. Default active connector aligned to CS-Cart migration

Changed file:
- `src/core/config/loadConfig.ts`

What changed:
- default `ACTIVE_STORE` fallback switched from `horoshop` to `cscart`

Effect:
- startup/config semantics match the current migration priority

### 4. Job lifecycle and controlled pipeline execution for CS-Cart

Changed files:
- `src/core/jobs/JobService.ts`
- `src/core/jobs/PipelineJobRunner.ts`
- `src/core/pipeline/PipelineOrchestrator.ts`
- `src/app/createApplication.ts`
- `src/app/http/server.ts`

What changed:
- added dedicated job service with `create/start/finish/fail/cancel`, lock handling and job/log queries
- added runner for managed step jobs: `import_all`, `finalize`, `store_import`
- added controlled `update_pipeline` orchestration with child jobs linked via `meta.pipeline_job_id`
- added admin API endpoints for jobs list/details/start/cancel

Effect:
- pipeline execution is now controllable and traceable in DB
- step-by-step CS-Cart migration can run via explicit jobs instead of ad-hoc direct calls
- concurrency conflicts are blocked by lock and running-job checks

### 5. Retention cleanup job with partition lifecycle

Changed files:
- `src/core/jobs/CleanupService.ts`
- `src/core/jobs/PipelineJobRunner.ts`
- `src/app/http/server.ts`
- `src/core/config/loadConfig.ts`
- `src/core/config/types.ts`

What changed:
- added `cleanup` job type with retention-driven execution
- implemented drop of old `products_raw_YYYYMMDD` partitions by cutoff
- added fallback/raw delete for rows older than retention window
- added cleanup of old logs, completed jobs and orphaned locks
- added API endpoint `POST /admin/api/jobs/cleanup`
- added config `CLEANUP_RETENTION_DAYS` (default 10)

Effect:
- retention is now operational in the modular repo
- raw table growth is controlled by partition lifecycle + retention
- cleanup is visible and auditable through jobs/logs

### 6. Stronger cancel flow for long-running jobs

Changed files:
- `src/core/jobs/JobService.ts`
- `src/core/pipeline/finalizerDb.ts`
- `src/app/http/server.ts`

What changed:
- added backend termination by `application_name` (`whitehall:<type>:<jobId>`) using `pg_terminate_backend`
- finalize now tags DB session with `whitehall:finalize:<jobId>`
- cancel endpoint now attempts backend termination for parent and child running jobs before status cancel

Effect:
- cancel is no longer only metadata-level for heavy finalize operations
- lower risk of stuck running SQL after UI/API cancel request

### 7. Auth strategy wiring (`db` vs `env`)

Changed file:
- `src/app/createApplication.ts`

What changed:
- application now uses `DbUserStore` when `AUTH_STRATEGY=db`
- `EnvUserStore` remains for `AUTH_STRATEGY=env`

Effect:
- declared auth strategy now matches runtime behavior
- admin auth no longer silently falls back to env users when DB mode is selected

### 8. CS-Cart import performance pass (index + delta skip)

Changed files:
- `src/connectors/cscart/CsCartGateway.ts`
- `src/app/createApplication.ts`
- `docs/CSCART_CONNECTOR_NOTES.md`

What changed:
- removed per-SKU lookup requests during import
- added full catalog index load (`product_code -> product_id/state`) once per import run
- unchanged SKUs are now skipped instead of always sending PUT
- `parent_product_id` now resolves via catalog index by parent product code
- added import worker parallelism env (`CSCART_IMPORT_CONCURRENCY`, default `4`)

Effect:
- significant API call reduction on large runs
- lower CS-Cart API pressure
- better throughput while preserving rate-limit and update-only semantics

### 9. Store import cancel-awareness

Changed files:
- `src/core/connectors/StoreConnector.ts`
- `src/core/pipeline/PipelineOrchestrator.ts`
- `src/core/jobs/PipelineJobRunner.ts`
- `src/connectors/cscart/CsCartConnector.ts`
- `src/connectors/cscart/CsCartGateway.ts`
- `src/connectors/horoshop/HoroshopConnector.ts`

What changed:
- added optional store-import context (`jobId`, `isCanceled`) through pipeline -> connector -> gateway
- CS-Cart gateway periodically checks job cancel status during import worker loop
- on cancel, import loop exits with `JOB_CANCELED` instead of continuing full run

Effect:
- cancel behavior for long CS-Cart import runs is now practical, not only metadata-level
- less wasted API traffic/time after operator cancel action

### 10. Persisted store mirror sync job

Changed files:
- `migrations/023_create_store_mirror.sql`
- `src/core/jobs/StoreMirrorService.ts`
- `src/core/jobs/PipelineJobRunner.ts`
- `src/core/pipeline/PipelineOrchestrator.ts`
- `src/app/createApplication.ts`
- `src/app/http/server.ts`

What changed:
- added shared `store_mirror` table (`store + article` primary key)
- added `store_mirror_sync` job type
- added service to persist full mirror snapshot and prune stale rows by `seen_at`
- added API endpoint `POST /admin/api/jobs/store-mirror-sync`

Effect:
- mirror state is now persisted in DB for observability and future persisted-delta logic
- provides a stable base for upcoming optimization stage (DB-driven delta before connector import)

### 11. Memory-safe mirror sync + bounded operational payloads

Changed files:
- `src/core/pipeline/PipelineOrchestrator.ts`
- `src/core/jobs/StoreMirrorService.ts`
- `src/core/jobs/PipelineJobRunner.ts`
- `src/core/pipeline/log.ts`
- `src/app/http/server.ts`
- `src/connectors/cscart/CsCartGateway.ts`

What changed:
- added page iterator in orchestrator (`forEachStoreMirrorPage`) and switched mirror sync job to stream pages directly into DB
- mirror sync now uses a shared `seenAt` marker (`createSyncMarker`) + per-page upsert (`upsertSnapshotChunk`) + final stale-row prune (`pruneSnapshot`)
- child `update_pipeline` step logs now store summarized `store_import` payload instead of full batch bodies
- added payload sanitization/truncation in log service (`LOG_PAYLOAD_MAX_BYTES`, default `32768`)
- heavy job endpoints (`/admin/api/jobs/store-import`, `/admin/api/jobs/update-pipeline`) now return compact summaries by default; full payload available via `verbose=true`
- removed extra in-memory filtered copy in CS-Cart import worker path

Effect:
- lower peak RAM during mirror sync (no full catalog snapshot accumulation for sync job)
- lower risk of `logs` table growth and oversized API responses on large runs
- better operational stability for 100k–500k item iterations without business-rule changes

### 12. Built-in scheduler for pipeline automation

Changed files:
- `src/core/config/types.ts`
- `src/core/config/loadConfig.ts`
- `src/core/jobs/JobScheduler.ts`
- `src/app/createApplication.ts`
- `src/index.ts`
- `docs/ARCHITECTURE_BASELINE_2026_03.md`

What changed:
- added a modular background scheduler service with start/stop lifecycle
- scheduler tasks run through `PipelineJobRunner` (no duplicated business logic)
- added env-driven schedule config for:
  - `update_pipeline` (optional supplier filter)
  - `store_mirror_sync`
  - `cleanup`
- scheduler writes operational logs and handles job lock conflicts as non-fatal skip events
- application startup now initializes scheduler after HTTP server listen; graceful stop on `SIGINT`/`SIGTERM`

Effect:
- restores legacy-level automated orchestration in the new modular repo
- keeps lock/cancel semantics centralized in existing job runner
- allows safe staged automation without introducing external cron dependencies

### 13. Store import progress checkpoints in jobs metadata

Changed files:
- `src/core/connectors/StoreConnector.ts`
- `src/connectors/cscart/CsCartGateway.ts`
- `src/core/jobs/JobService.ts`
- `src/core/jobs/PipelineJobRunner.ts`
- `src/app/http/server.ts`
- `public/admin/index.html`
- `docs/CSCART_CONNECTOR_NOTES.md`

What changed:
- extended `StoreImportContext` with optional `onProgress` callback
- CS-Cart import now reports aggregated progress during execution (`total/processed/imported/failed/skipped`)
- added `JobService.mergeJobMeta(...)` helper for safe JSONB metadata merge into existing job meta
- runner persists progress snapshots to `jobs.meta.storeImportProgress` and writes periodic progress logs
- progress snapshot includes runtime throughput and ETA (`ratePerSecond`, `etaSeconds`)
- implemented store-import resume flow:
  - `resumeFromJobId` (explicit failed/canceled `store_import` job)
  - `resumeLatest` (auto-pick latest failed/canceled `store_import` for same supplier filter)
  - gateway skips already processed checkpoint segment via `resumeProcessed`
- added batch telemetry in runner:
  - `store_import batch metrics` log entries (delta counters, batch rate, total rate, ETA)
  - `jobs.meta.storeImportMetrics` aggregate snapshot with latest batch info
- added basic admin UI controls for resume (`resumeLatest`, `resumeFromJobId`)

Effect:
- operators can track long-running import state from DB/API without waiting for final job completion
- canceled/failed import can continue from checkpoint instead of always starting from zero
- batch-level observability is now available for throughput tuning and incident analysis
- no business logic or import decision rules were changed

### 14. Legacy import orchestration parity for source/supplier scopes

Changed files:
- `src/core/pipeline/contracts.ts`
- `src/core/pipeline/importerDb.ts`
- `src/core/pipeline/PipelineOrchestrator.ts`
- `src/core/jobs/PipelineJobRunner.ts`
- `src/app/http/server.ts`
- `public/admin/index.html`

What changed:
- extended source importer contract with:
  - `importSource(jobId, sourceId)`
  - `importSupplier(jobId, supplierId)`
- reused existing Google Sheets import logic for these scopes (no business-rule changes)
- added standalone job types and orchestration:
  - `import_source`
  - `import_supplier`
- added admin API endpoints:
  - `POST /admin/api/jobs/import-source`
  - `POST /admin/api/jobs/import-supplier`
- added basic admin UI controls for direct source/supplier import runs

Effect:
- restores key legacy operational scenarios for targeted import runs
- keeps single lock/runner model and same concurrency safety guarantees
- improves recoverability: operators can rerun smaller scopes instead of full import when needed

### 15. Catalog admin backend API parity (suppliers/sources/mappings)

Changed files:
- `src/core/admin/CatalogAdminService.ts`
- `src/app/createApplication.ts`
- `src/app/http/server.ts`
- `docs/CURRENT_FUNCTIONALITY.md`
- `docs/PLAN_MODULAR_SINGLE_REPO_2026_03.md`

What changed:
- introduced dedicated catalog admin service for DB operations (modularized backend path)
- added API parity for core catalog entities:
  - `GET/POST/PUT/DELETE /admin/api/suppliers`
  - `PUT /admin/api/suppliers/bulk`
  - `GET/POST/PUT/DELETE /admin/api/sources`
  - `GET/POST /admin/api/mappings/:supplierId`
- added server-level validations for numeric IDs and required payload fields
- retained existing auth role model (`viewer` for reads, `admin` for writes)

Effect:
- closes a major backend parity gap versus legacy admin routes
- moves data-management logic out of monolithic route handler into reusable service
- prepares next phase (`markup_rule_sets`, `price_overrides`, stats/read parity) without changing business logic

### 16. Pricing admin parity (markup rules + price overrides)

Changed files:
- `src/core/admin/CatalogAdminService.ts`
- `src/app/http/server.ts`
- `docs/CURRENT_FUNCTIONALITY.md`
- `docs/PLAN_MODULAR_SINGLE_REPO_2026_03.md`

What changed:
- added markup-rule-set backend APIs:
  - `GET /admin/api/markup-rule-sets`
  - `POST /admin/api/markup-rule-sets`
  - `PUT /admin/api/markup-rule-sets/:id`
  - `POST /admin/api/markup-rule-sets/apply`
- added price-override backend APIs:
  - `GET /admin/api/price-overrides`
  - `POST /admin/api/price-overrides`
  - `PUT /admin/api/price-overrides/:id`
- preserved legacy behavior for override impact:
  - active override writes `price_final` to matching `products_final`
  - override deactivation triggers recompute from supplier markup/rule conditions

Effect:
- closes another high-impact parity gap in pricing management backend
- keeps business rules centralized and auditable in service layer
- reduces risk of manual DB edits during operations

### 17. Operational read APIs parity (logs + stats)

Changed files:
- `src/core/admin/CatalogAdminService.ts`
- `src/app/http/server.ts`
- `docs/CURRENT_FUNCTIONALITY.md`
- `docs/PLAN_MODULAR_SINGLE_REPO_2026_03.md`

What changed:
- added `GET /admin/api/logs` with filters:
  - `jobId`
  - `level`
  - `limit`
- added `GET /admin/api/stats` with core counters and latest job summaries:
  - suppliers/sources/raw/final counts
  - latest job
  - latest `update_pipeline`
  - latest `store_import`

Effect:
- restores operational observability paths needed for backend-only rollout
- lets operators audit runtime health without direct DB access
- keeps analytics queries in backend service layer, not in route handlers

### 18. Source inspection parity for mapping flow (Google Sheets)

Changed files:
- `src/core/pipeline/googleSheetsService.ts`
- `src/core/admin/CatalogAdminService.ts`
- `src/app/http/server.ts`
- `docs/CURRENT_FUNCTIONALITY.md`
- `docs/PLAN_MODULAR_SINGLE_REPO_2026_03.md`

What changed:
- added Google Sheets utility methods:
  - `listSheetNames(url)`
  - `getSheetPreview(url, sheetName, headerRow, sampleRows)`
- added source lookup helpers in catalog admin service:
  - `getSourceById`
  - `getActiveImportSourceById`
- added API endpoints:
  - `GET /admin/api/source-sheets`
  - `GET /admin/api/source-preview`

Effect:
- restores legacy source-inspection backend capability needed before frontend mapping screens
- reduces operator risk when configuring mapping/header row
- keeps source-preview logic in backend, ready for future frontend integration

### 19. Data review/export parity for operator workflows

Changed files:
- `src/core/admin/CatalogAdminService.ts`
- `src/app/http/server.ts`
- `docs/CURRENT_FUNCTIONALITY.md`
- `docs/PLAN_MODULAR_SINGLE_REPO_2026_03.md`

What changed:
- added preview read APIs:
  - `GET /admin/api/merged-preview`
  - `GET /admin/api/final-preview`
  - `GET /admin/api/compare-preview`
- added export APIs:
  - `GET /admin/api/merged-export`
  - `GET /admin/api/final-export`
  - `GET /admin/api/compare-export`
- export format implemented as CSV stream (bounded chunk reads), not XLSX, to keep backend dependency-light and stable at large volume.

Effect:
- restores core operator backend capabilities for raw/final/compare dataset inspection
- enables backend-only validation flow before frontend migration
- avoids extra memory pressure by streaming export rows in chunks

### 20. Scheduler settings parity with DB persistence and runtime reload

Changed files:
- `src/core/jobs/JobScheduler.ts`
- `src/core/jobs/SchedulerSettingsService.ts`
- `src/app/createApplication.ts`
- `src/app/http/server.ts`
- `src/index.ts`
- `migrations/024_create_cron_settings.sql`
- `docs/CURRENT_FUNCTIONALITY.md`
- `docs/PLAN_MODULAR_SINGLE_REPO_2026_03.md`

What changed:
- extended scheduler with task snapshots and runtime task updates (enabled/interval/runOnStartup).
- added scheduler settings service with:
  - `cron_settings` table initialization/compat columns
  - default seeding from current scheduler config
  - settings apply to running scheduler without restart
  - update_pipeline supplier override via `meta.supplier`
- added API endpoints:
  - `GET /admin/api/cron-settings`
  - `PUT /admin/api/cron-settings`
- startup now initializes scheduler settings before scheduler start.

Effect:
- closes backend parity gap for cron/scheduler settings management
- enables operational tuning of schedule cadence in production without redeploy
- keeps scheduler behavior aligned with persisted admin settings

### 21. Backend load-audit harness for staged 100k/300k/500k runs

Changed files:
- `src/scripts/runLoadAudit.ts`
- `package.json`
- `docs/RUNBOOK_LOAD_AUDIT_2026_03.md`
- `docs/CURRENT_FUNCTIONALITY.md`
- `docs/PLAN_MODULAR_SINGLE_REPO_2026_03.md`

What changed:
- added reproducible load-audit script (`npm run audit:load`) with scenario counts from env.
- script measures:
  - finalize wall-time and summary (`rawCount/finalCount/durationMs`)
  - preview latency/total
  - compare latency/total + missing-only latency/total
- added safety gates:
  - requires `LOAD_AUDIT_CONFIRM=YES`
  - non-empty DB blocked unless explicitly allowed
  - cleanup of synthetic artifacts enabled by default
- writes structured JSON report to output path.

Effect:
- creates executable baseline for next performance tuning step on staging
- reduces manual/one-off benchmark noise with consistent scenario runner
- keeps load-audit logic outside production code paths (no business logic changes)

### 22. Supplier UX/API improvements + legacy config migration tooling

Changed files:
- `src/core/admin/CatalogAdminService.ts`
- `src/app/http/server.ts`
- `migrations/025_add_column_mappings_comment.sql`
- `src/scripts/exportLegacySupplierConfig.ts`
- `src/scripts/importSupplierConfigSnapshot.ts`
- `package.json`
- `docs/RUNBOOK_SUPPLIER_CONFIG_MIGRATION_2026_03.md`

What changed:
- `GET /admin/api/suppliers` now supports:
  - `search` by supplier name (`ILIKE`)
  - `sort=name_asc|name_desc|id_asc` (A-Я / Я-А / default by id).
- `column_mappings` now has explicit `comment` field (migration `025`).
- mapping API (`get/save latest`) now reads/writes `comment`.
- added controlled legacy config migration path:
  - export selected suppliers from old DB into snapshot JSON
  - import snapshot into new DB with upsert and `mapping_meta.source_id` remap.

Effect:
- closes requested operator features without changing business pricing/import logic
- improves readiness for parity testing on real suppliers (`WHITE HALL`, `sevrukov`)
- reduces manual risk during config transfer from legacy production data

### 23. Default markup parity (`markup_settings` + default rule endpoint)

Changed files:
- `src/core/admin/CatalogAdminService.ts`
- `src/app/http/server.ts`
- `migrations/026_create_markup_settings.sql`
- `docs/CURRENT_FUNCTIONALITY.md`
- `docs/PLAN_MODULAR_SINGLE_REPO_2026_03.md`

What changed:
- added persistence table `markup_settings` (single-row global default rule set).
- added admin API:
  - `POST /admin/api/markup-rule-sets/default`
- `list/create/update/apply` markup rule set responses now include `global_rule_set_id`.
- create supplier flow now resolves default rule set from `markup_settings` (with active fallback) if rule set is not explicitly provided.

Effect:
- closes remaining parity gap around legacy global default markup semantics
- keeps pricing behavior stable while making default assignment explicit and operational

### 24. Store mirror hardening for duplicate SKU responses

Changed files:
- `src/core/jobs/StoreMirrorService.ts`
- `src/scripts/runStoreMirrorSync.ts`
- `package.json`
- `src/app/createApplication.ts`
- `src/index.ts`
- `docs/CURRENT_FUNCTIONALITY.md`
- `docs/PLAN_MODULAR_SINGLE_REPO_2026_03.md`
- `docs/CSCART_CONNECTOR_NOTES.md`

What changed:
- added chunk-level dedupe by `article` before `store_mirror` upsert to avoid SQL error when API page contains repeated SKU.
- added explicit CLI mirror sync entrypoint:
  - `npm run mirror:sync`
- application lifecycle now exposes explicit `close()` to correctly stop scheduler and pool for CLI/background runs.
- documentation now fixes operational rule: duplicated `product_code` in CS-Cart is a data conflict for update-only import and must be cleaned before cutover tests.

Effect:
- eliminates `ON CONFLICT ... cannot affect row a second time` failure mode during mirror sync.
- provides repeatable backend-only snapshot refresh command for preflight checks.
- formalizes data-quality gate (unique SKU) without changing pricing/import business logic.

## Adjusted plan

### Phase 1. Stabilize core DB path

Status:
- finalize merge path fixed
- raw partition creation activated
- retention cleanup job implemented (partition drop + old rows/logs/jobs cleanup)
- `AUTH_STRATEGY=db|env` runtime wiring is now aligned

Still required:
- keep only required successful import/finalize history
- add DB metrics for import/finalize duration and row volumes

### Phase 2. Reach legacy parity for core pipeline

Required next:
- complete admin CRUD parity (`suppliers`, `sources`, `mappings`, `markup rules`, `price overrides`)
- add resume-focused integration tests (supplier mismatch, empty checkpoint, wrong source job type)

### Phase 3. Finish CS-Cart connector for large syncs

Required next:
- auto mirror refresh policy before delta import (scheduled `store_mirror_sync`)
- staging load tests for 100k / 300k / 500k items

### Phase 4. CS-Cart production hardening and cutover checklist

Rule:
- Horoshop remains out of active scope until CS-Cart parity and load stability are fully closed

## Non-negotiable requirements for target load

- no full-table delete refreshes on hot paths
- partition lifecycle must be operational, not only declared in migrations
- every long job must be cancelable and resumable
- preview/import steps must work from persisted job state, not from implicit "latest successful" assumptions alone
- docs must distinguish between legacy functionality and current modular parity

## Recommended next implementation order

1. Add integration tests around resume edge-cases + import -> finalize -> preview for null/empty size, overrides and dedup priority.
2. Implement admin CRUD parity for source/supplier/mapping/markup/override entities.
3. Run staged load tests (100k/300k/500k) and tune env (`CSCART_RATE_LIMIT_RPS`, `CSCART_IMPORT_CONCURRENCY`, mirror refresh cadence).
