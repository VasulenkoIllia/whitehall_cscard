import type { Application, Request, Response } from 'express';
import type { MasterCatalogService } from '../../../core/master_catalog/MasterCatalogService';
import type { PipelineJobRunner } from '../../../core/jobs/PipelineJobRunner';
import type { createAuthMiddleware } from '../authMiddleware';

type AuthMiddleware = ReturnType<typeof createAuthMiddleware>;

interface MasterCatalogRouteDeps {
  masterCatalogService: MasterCatalogService;
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
  const { masterCatalogService, jobRunner, authMw } = deps;

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
