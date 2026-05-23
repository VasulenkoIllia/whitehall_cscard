import type { Application, Request, Response } from 'express';
import type { CatalogService } from '../../../core/catalog/CatalogService';
import type { PipelineJobRunner } from '../../../core/jobs/PipelineJobRunner';
import type { createAuthMiddleware } from '../authMiddleware';

type AuthMiddleware = ReturnType<typeof createAuthMiddleware>;

interface CatalogRouteDeps {
  catalogService: CatalogService;
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
function parseHasOffers(value: unknown): boolean | null {
  if (typeof value === 'string') {
    const n = value.trim().toLowerCase();
    if (n === 'true' || n === '1' || n === 'yes') return true;
    if (n === 'false' || n === '0' || n === 'no') return false;
  }
  return null;
}
function parsePositiveInt(value: unknown): number | null {
  if (value === null || typeof value === 'undefined') return null;
  const p = Number(value);
  if (!Number.isFinite(p) || p <= 0) return null;
  return Math.trunc(p);
}
function parseMasterId(req: Request, res: Response): number | null {
  const id = parsePositiveInt(req.params.id);
  if (!id) {
    res.status(400).json({ error: 'master id must be a positive number' });
    return null;
  }
  return id;
}

export function registerCatalogRoutes(app: Application, deps: CatalogRouteDeps): void {
  const { catalogService, jobRunner, authMw } = deps;

  // Запуск офлайн-збірки каталогу. Опційно: supplierId (тільки 1 постачальник),
  // force (skipdetection вимикається).
  app.post(
    '/admin/api/jobs/catalog-assemble',
    authMw.requireRole('admin'),
    async (req: Request, res: Response) => {
      try {
        const supplierId = parsePositiveInt(req.body?.supplierId);
        const force = req.body?.force === true || req.body?.force === 'true';
        const result = await jobRunner.runCatalogAssemble({ supplierId, force });
        res.json({ jobId: result.jobId, result: result.result });
      } catch (err) {
        res
          .status(readErrorStatus(err))
          .json({ error: readErrorMessage(err, 'catalog_assemble_error') });
      }
    }
  );

  app.get(
    '/admin/api/catalog/assembly-runs',
    authMw.requireRole('viewer'),
    async (req: Request, res: Response) => {
      try {
        const limit = parsePositiveInt(req.query.limit) || 20;
        const rows = await catalogService.listAssemblyRuns(limit);
        res.json({ rows });
      } catch (err) {
        res
          .status(readErrorStatus(err))
          .json({ error: readErrorMessage(err, 'catalog_runs_error') });
      }
    }
  );

  app.get(
    '/admin/api/catalog/assembly-runs/latest',
    authMw.requireRole('viewer'),
    async (_req: Request, res: Response) => {
      try {
        const run = await catalogService.getLatestAssemblyRun();
        res.json({ run });
      } catch (err) {
        res
          .status(readErrorStatus(err))
          .json({ error: readErrorMessage(err, 'catalog_runs_latest_error') });
      }
    }
  );

  app.get(
    '/admin/api/catalog/masters',
    authMw.requireRole('viewer'),
    async (req: Request, res: Response) => {
      try {
        const result = await catalogService.listMasters({
          search: typeof req.query.search === 'string' ? req.query.search : '',
          hasOffers: parseHasOffers(req.query.hasOffers),
          supplierId: parsePositiveInt(req.query.supplierId),
          minOffers: parsePositiveInt(req.query.minOffers),
          sort: typeof req.query.sort === 'string' ? req.query.sort : undefined,
          limit: parsePositiveInt(req.query.limit) || 50,
          offset: Number(req.query.offset) || 0
        });
        res.json(result);
      } catch (err) {
        res
          .status(readErrorStatus(err))
          .json({ error: readErrorMessage(err, 'catalog_masters_list_error') });
      }
    }
  );

  app.get(
    '/admin/api/catalog/masters/:id',
    authMw.requireRole('viewer'),
    async (req: Request, res: Response) => {
      const masterId = parseMasterId(req, res);
      if (!masterId) return;
      try {
        const detail = await catalogService.getMaster(masterId);
        if (!detail) {
          res.status(404).json({ error: 'master_not_found' });
          return;
        }
        res.json(detail);
      } catch (err) {
        res
          .status(readErrorStatus(err))
          .json({ error: readErrorMessage(err, 'catalog_master_detail_error') });
      }
    }
  );

  app.get(
    '/admin/api/catalog/masters/:id/offers',
    authMw.requireRole('viewer'),
    async (req: Request, res: Response) => {
      const masterId = parseMasterId(req, res);
      if (!masterId) return;
      try {
        const offers = await catalogService.listOffers(masterId);
        res.json({ rows: offers });
      } catch (err) {
        res
          .status(readErrorStatus(err))
          .json({ error: readErrorMessage(err, 'catalog_master_offers_error') });
      }
    }
  );

  // Master fields config (definitions) — спільне з MapperTab.
  app.get(
    '/admin/api/catalog/fields',
    authMw.requireRole('viewer'),
    async (_req: Request, res: Response) => {
      try {
        const rows = await catalogService.listMasterFields();
        res.json({ rows });
      } catch (err) {
        res
          .status(readErrorStatus(err))
          .json({ error: readErrorMessage(err, 'catalog_fields_error') });
      }
    }
  );

  // color_mappings — CRUD.
  app.get('/admin/api/catalog/color-mappings', authMw.requireRole('viewer'),
    async (_req, res) => {
      try { res.json({ rows: await catalogService.listColorMappings() }); }
      catch (err) {
        res.status(readErrorStatus(err))
           .json({ error: readErrorMessage(err, 'color_mappings_error') });
      }
    });
  app.post('/admin/api/catalog/color-mappings', authMw.requireRole('admin'),
    async (req, res) => {
      try {
        const r = await catalogService.createColorMapping({
          colorFrom: String(req.body?.colorFrom || ''),
          colorTo:   String(req.body?.colorTo || ''),
          notes:     req.body?.notes ?? null,
          isActive:  req.body?.isActive !== false
        });
        res.json(r);
      } catch (err) {
        res.status(readErrorStatus(err))
           .json({ error: readErrorMessage(err, 'color_mapping_create_error') });
      }
    });
  app.put('/admin/api/catalog/color-mappings/:id', authMw.requireRole('admin'),
    async (req, res) => {
      const id = parsePositiveInt(req.params.id);
      if (!id) { res.status(400).json({ error: 'id must be positive' }); return; }
      try {
        await catalogService.updateColorMapping(id, {
          colorFrom: req.body?.colorFrom,
          colorTo:   req.body?.colorTo,
          notes:     req.body?.notes,
          isActive:  req.body?.isActive
        });
        res.json({ ok: true });
      } catch (err) {
        res.status(readErrorStatus(err))
           .json({ error: readErrorMessage(err, 'color_mapping_update_error') });
      }
    });
  app.delete('/admin/api/catalog/color-mappings/:id', authMw.requireRole('admin'),
    async (req, res) => {
      const id = parsePositiveInt(req.params.id);
      if (!id) { res.status(400).json({ error: 'id must be positive' }); return; }
      try { await catalogService.deleteColorMapping(id); res.json({ ok: true }); }
      catch (err) {
        res.status(readErrorStatus(err))
           .json({ error: readErrorMessage(err, 'color_mapping_delete_error') });
      }
    });

  // category_mappings — CRUD.
  app.get('/admin/api/catalog/category-mappings', authMw.requireRole('viewer'),
    async (_req, res) => {
      try { res.json({ rows: await catalogService.listCategoryMappings() }); }
      catch (err) {
        res.status(readErrorStatus(err))
           .json({ error: readErrorMessage(err, 'category_mappings_error') });
      }
    });
  app.post('/admin/api/catalog/category-mappings', authMw.requireRole('admin'),
    async (req, res) => {
      try {
        const r = await catalogService.createCategoryMapping({
          categoryFrom: String(req.body?.categoryFrom || ''),
          categoryTo:   String(req.body?.categoryTo || ''),
          notes:        req.body?.notes ?? null,
          isActive:     req.body?.isActive !== false
        });
        res.json(r);
      } catch (err) {
        res.status(readErrorStatus(err))
           .json({ error: readErrorMessage(err, 'category_mapping_create_error') });
      }
    });
  app.put('/admin/api/catalog/category-mappings/:id', authMw.requireRole('admin'),
    async (req, res) => {
      const id = parsePositiveInt(req.params.id);
      if (!id) { res.status(400).json({ error: 'id must be positive' }); return; }
      try {
        await catalogService.updateCategoryMapping(id, {
          categoryFrom: req.body?.categoryFrom,
          categoryTo:   req.body?.categoryTo,
          notes:        req.body?.notes,
          isActive:     req.body?.isActive
        });
        res.json({ ok: true });
      } catch (err) {
        res.status(readErrorStatus(err))
           .json({ error: readErrorMessage(err, 'category_mapping_update_error') });
      }
    });
  app.delete('/admin/api/catalog/category-mappings/:id', authMw.requireRole('admin'),
    async (req, res) => {
      const id = parsePositiveInt(req.params.id);
      if (!id) { res.status(400).json({ error: 'id must be positive' }); return; }
      try { await catalogService.deleteCategoryMapping(id); res.json({ ok: true }); }
      catch (err) {
        res.status(readErrorStatus(err))
           .json({ error: readErrorMessage(err, 'category_mapping_delete_error') });
      }
    });

  // Картка товару — конфіг полів + кандидати + збережені значення.
  app.get(
    '/admin/api/catalog/masters/:id/card',
    authMw.requireRole('viewer'),
    async (req: Request, res: Response) => {
      const masterId = parseMasterId(req, res);
      if (!masterId) return;
      try {
        const card = await catalogService.getMasterCard(masterId);
        if (!card) {
          res.status(404).json({ error: 'master_not_found' });
          return;
        }
        res.json(card);
      } catch (err) {
        res
          .status(readErrorStatus(err))
          .json({ error: readErrorMessage(err, 'catalog_master_card_error') });
      }
    }
  );

  app.put(
    '/admin/api/catalog/masters/:id/card',
    authMw.requireRole('admin'),
    async (req: Request, res: Response) => {
      const masterId = parseMasterId(req, res);
      if (!masterId) return;
      const inputs = Array.isArray(req.body?.values) ? req.body.values : [];
      if (inputs.length === 0) {
        res.status(400).json({ error: 'values array is required' });
        return;
      }
      try {
        const userIdRaw = (req as any).userId;
        const updatedBy =
          typeof userIdRaw === 'string' && userIdRaw.length > 0 ? userIdRaw : null;
        const card = await catalogService.saveMasterFieldValues(masterId, inputs, updatedBy);
        if (!card) {
          res.status(404).json({ error: 'master_not_found' });
          return;
        }
        res.json(card);
      } catch (err) {
        res
          .status(readErrorStatus(err))
          .json({ error: readErrorMessage(err, 'catalog_master_card_save_error') });
      }
    }
  );
}
