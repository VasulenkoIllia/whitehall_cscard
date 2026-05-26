import type { Application, Request, Response } from 'express';
import type { MasterCatalogService } from '../../../core/master_catalog/MasterCatalogService';
import type { EnrichmentService } from '../../../core/ai/EnrichmentService';
import type { AiUsageService } from '../../../core/ai/AiUsageService';
import type { PipelineJobRunner } from '../../../core/jobs/PipelineJobRunner';
import type { createAuthMiddleware } from '../authMiddleware';

type AuthMiddleware = ReturnType<typeof createAuthMiddleware>;

interface MasterCatalogRouteDeps {
  masterCatalogService: MasterCatalogService;
  enrichmentService: EnrichmentService;
  aiUsageService: AiUsageService;
  jobRunner: PipelineJobRunner<unknown>;
  authMw: AuthMiddleware;
}

function readErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}
function readErrorStatus(err: unknown, fallback = 500): number {
  if (typeof err === 'object' && err !== null && Number.isFinite((err as any).status)) {
    return Number((err as any).status);
  }
  return fallback;
}
function parsePositiveInt(value: unknown): number | null {
  if (value === null || typeof value === 'undefined' || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.trunc(n);
}
function parseBoolOrNull(value: unknown): boolean | null {
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === 'true' || v === '1' || v === 'yes') return true;
    if (v === 'false' || v === '0' || v === 'no') return false;
  }
  return null;
}

export function registerMasterCatalogRoutes(app: Application, deps: MasterCatalogRouteDeps): void {
  const { masterCatalogService, enrichmentService, aiUsageService, jobRunner, authMw } = deps;

  // AI usage summary (для UI dashboard).
  app.get(
    '/admin/api/master-catalog/ai/usage',
    authMw.requireRole('viewer'),
    async (req: Request, res: Response) => {
      try {
        const periodDays = parsePositiveInt(req.query.periodDays);
        const summary = await aiUsageService.summary(periodDays || undefined);
        const recent = await aiUsageService.recent(20);
        res.json({ summary, recent });
      } catch (err) {
        res.status(readErrorStatus(err)).json({
          error: readErrorMessage(err, 'usage_error')
        });
      }
    }
  );

  // AI status — чи доступне.
  app.get(
    '/admin/api/master-catalog/ai/status',
    authMw.requireRole('viewer'),
    (_req: Request, res: Response) => {
      res.json({
        enabled: enrichmentService.isEnabled(),
        model: process.env.ANTHROPIC_MODEL_ENRICHMENT || 'claude-sonnet-4-5'
      });
    }
  );

  // POST /admin/api/master-catalog/enrich-batch — AI enrich many masters at once.
  app.post(
    '/admin/api/master-catalog/enrich-batch',
    authMw.requireRole('admin'),
    async (req: Request, res: Response) => {
      try {
        const masterIds = Array.isArray(req.body?.masterIds)
          ? (req.body.masterIds as unknown[])
              .map((x) => Number(x))
              .filter((x) => Number.isFinite(x) && x > 0)
          : [];
        if (masterIds.length === 0) {
          res.status(400).json({ error: 'masterIds порожній або невалідний' });
          return;
        }
        const overwrite = req.body?.overwrite === true || req.body?.overwrite === 'true';
        const batchSize = parsePositiveInt(req.body?.batchSize) ?? 10;
        const threshold =
          typeof req.body?.confidenceThreshold === 'number'
            ? req.body.confidenceThreshold
            : undefined;
        const model = typeof req.body?.model === 'string' && req.body.model.trim()
          ? req.body.model.trim() : undefined;
        const result = await enrichmentService.enrichBatch(masterIds, {
          overwriteExisting: overwrite,
          batchSize,
          confidenceThreshold: threshold,
          model
        });
        res.json(result);
      } catch (err) {
        res.status(readErrorStatus(err)).json({
          error: readErrorMessage(err, 'enrich_batch_error')
        });
      }
    }
  );

  // GET /admin/api/master-catalog/:id/enrich/preview — показати prompt без виклику AI.
  app.get(
    '/admin/api/master-catalog/:id/enrich/preview',
    authMw.requireRole('viewer'),
    async (req: Request, res: Response) => {
      try {
        const id = parsePositiveInt(req.params.id);
        if (!id) {
          res.status(400).json({ error: 'id обовʼязковий' });
          return;
        }
        const preview = await enrichmentService.previewPrompt(id);
        res.json(preview);
      } catch (err) {
        res.status(readErrorStatus(err)).json({
          error: readErrorMessage(err, 'preview_error')
        });
      }
    }
  );

  // POST /admin/api/master-catalog/:id/enrich — AI enrich one master.
  app.post(
    '/admin/api/master-catalog/:id/enrich',
    authMw.requireRole('admin'),
    async (req: Request, res: Response) => {
      try {
        const id = parsePositiveInt(req.params.id);
        if (!id) {
          res.status(400).json({ error: 'id обовʼязковий' });
          return;
        }
        const overwrite = req.body?.overwrite === true || req.body?.overwrite === 'true';
        const threshold =
          typeof req.body?.confidenceThreshold === 'number'
            ? req.body.confidenceThreshold
            : undefined;
        const model = typeof req.body?.model === 'string' && req.body.model.trim()
          ? req.body.model.trim() : undefined;
        const result = await enrichmentService.enrichMaster(id, {
          overwriteExisting: overwrite,
          confidenceThreshold: threshold,
          model
        });
        res.json(result);
      } catch (err) {
        res.status(readErrorStatus(err)).json({
          error: readErrorMessage(err, 'enrich_error')
        });
      }
    }
  );

  // POST /admin/api/jobs/master-catalog-sync — запустити sync.
  app.post(
    '/admin/api/jobs/master-catalog-sync',
    authMw.requireRole('admin'),
    async (_req: Request, res: Response) => {
      try {
        const result = await jobRunner.runMasterCatalogSync();
        res.json({ jobId: result.jobId, result: result.result });
      } catch (err) {
        res
          .status(readErrorStatus(err))
          .json({ error: readErrorMessage(err, 'master_catalog_sync_error') });
      }
    }
  );

  // GET /admin/api/master-catalog — list з фільтрами + пагінацією.
  app.get(
    '/admin/api/master-catalog',
    authMw.requireRole('viewer'),
    async (req: Request, res: Response) => {
      try {
        const result = await masterCatalogService.listMasters({
          search:
            typeof req.query.search === 'string' ? req.query.search.trim() || null : null,
          hasName: parseBoolOrNull(req.query.hasName),
          hasFeed: parseBoolOrNull(req.query.hasFeed),
          hasAi: parseBoolOrNull(req.query.hasAi),
          isActive: parseBoolOrNull(req.query.isActive),
          page: parsePositiveInt(req.query.page) || 1,
          pageSize: parsePositiveInt(req.query.pageSize) || 50,
          sort: typeof req.query.sort === 'string' ? req.query.sort : 'newest'
        });
        res.json(result);
      } catch (err) {
        res
          .status(readErrorStatus(err))
          .json({ error: readErrorMessage(err, 'master_catalog_list_error') });
      }
    }
  );

  // GET /admin/api/master-catalog/:id — деталі одного майстра.
  app.get(
    '/admin/api/master-catalog/:id',
    authMw.requireRole('viewer'),
    async (req: Request, res: Response) => {
      try {
        const idOrSku = req.params.id;
        if (!idOrSku) {
          res.status(400).json({ error: 'id обовʼязковий' });
          return;
        }
        const row = await masterCatalogService.getMaster(idOrSku);
        if (!row) {
          res.status(404).json({ error: 'not_found' });
          return;
        }
        res.json(row);
      } catch (err) {
        res
          .status(readErrorStatus(err))
          .json({ error: readErrorMessage(err, 'master_catalog_get_error') });
      }
    }
  );

  // GET /admin/api/master-catalog-sync/runs — історія sync-ів.
  app.get(
    '/admin/api/master-catalog-sync/runs',
    authMw.requireRole('viewer'),
    async (req: Request, res: Response) => {
      try {
        const limit = parsePositiveInt(req.query.limit) || 10;
        const rows = await masterCatalogService.listSyncRuns(limit);
        res.json({ rows });
      } catch (err) {
        res
          .status(readErrorStatus(err))
          .json({ error: readErrorMessage(err, 'master_catalog_runs_error') });
      }
    }
  );
}
