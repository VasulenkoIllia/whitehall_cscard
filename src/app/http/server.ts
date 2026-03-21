import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'path';
import type { Application as AppContext } from '../createApplication';
import type { Request, Response } from 'express';
import { createAuthMiddleware } from './authMiddleware';
import { renderLoginPage } from './loginPage';
import { getSheetPreview, listSheetNames } from '../../core/pipeline/googleSheetsService';

export function createHttpServer(appContext: AppContext) {
  const app = express();
  const auth = appContext.auth;
  const authMw = createAuthMiddleware(auth);
  const pipeline = appContext.pipeline;
  const jobs = appContext.jobService;
  const jobRunner = appContext.jobRunner;
  const catalogAdmin = appContext.catalogAdminService;
  const logs = appContext.logService;
  const adminStaticPath = path.join(__dirname, '..', '..', 'public', 'admin');

  const parseLimit = (value: unknown, fallback: number): number => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      return fallback;
    }
    return Math.max(1, Math.min(200, Math.trunc(numeric)));
  };

  const parseBoolean = (value: unknown): boolean => {
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      return normalized === '1' || normalized === 'true' || normalized === 'yes';
    }
    return false;
  };

  const parseRequiredPositiveInt = (value: unknown, fieldName: string): number => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      const error = new Error(`${fieldName} must be a positive number`);
      (error as any).status = 400;
      throw error;
    }
    return Math.trunc(parsed);
  };

  const readStoreImportRunOptions = (req: Request) => {
    const rawResumeFromJobId = req.body?.resumeFromJobId;
    let resumeFromJobId: number | null = null;
    if (
      rawResumeFromJobId !== undefined &&
      rawResumeFromJobId !== null &&
      String(rawResumeFromJobId).trim() !== ''
    ) {
      const parsed = Number(rawResumeFromJobId);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        const error = new Error('resumeFromJobId must be a positive number');
        (error as any).status = 400;
        throw error;
      }
      resumeFromJobId = Math.trunc(parsed);
    }
    return {
      resumeFromJobId,
      resumeLatest: parseBoolean(req.body?.resumeLatest)
    };
  };

  const readErrorMessage = (err: unknown, fallback: string): string => {
    if (err instanceof Error && err.message) {
      return err.message;
    }
    return fallback;
  };

  const readErrorStatus = (err: unknown, fallback = 500): number => {
    if (typeof err === 'object' && err !== null && Number.isFinite((err as any).status)) {
      return Number((err as any).status);
    }
    return fallback;
  };

  const readVerboseFlag = (req: Request): boolean => {
    const queryValue = req.query?.verbose;
    if (typeof queryValue === 'string') {
      const normalized = queryValue.trim().toLowerCase();
      return normalized === '1' || normalized === 'true' || normalized === 'yes';
    }
    return parseBoolean((req.body || {}).verbose);
  };

  const summarizeStoreImportExecution = (execution: any) => {
    const batchRows = Array.isArray(execution?.batch?.rows) ? execution.batch.rows.length : null;
    return {
      previewTotal: Number(execution?.preview?.total || 0),
      batchStore: execution?.batch?.store || null,
      batchRows,
      batchMeta: execution?.batch?.meta || null,
      importResult: execution?.importResult || null
    };
  };

  app.use(express.json({ limit: '2mb' }));
  app.use(cookieParser());
  app.use(authMw.attachSession);

  app.get('/health', (_req, res) => res.json({ ok: true }));

  app.post('/auth/login', async (req: Request, res: Response) => {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'missing_credentials' });
    }
    const session = await auth.authenticate({ email, password });
    if (!session) {
      return res.status(401).json({ error: 'invalid_credentials' });
    }
    res.cookie('session_token', session.token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: appContext.config.auth.sessionTtlMinutes * 60 * 1000
    });
    return res.json({ ok: true, role: session.role });
  });

  app.post('/auth/logout', (req: Request, res: Response) => {
    const token = req.cookies?.session_token;
    if (token) {
      auth.invalidate(token);
      res.clearCookie('session_token');
    }
    res.json({ ok: true });
  });

  app.get('/admin/api/me', authMw.requireRole('viewer'), (req: Request, res: Response) =>
    res.json({ role: req.userRole || null })
  );

  app.get('/admin/api/suppliers', authMw.requireRole('viewer'), async (_req: Request, res: Response) => {
    try {
      const items = await catalogAdmin.listSuppliers();
      return res.json(items);
    } catch (err) {
      return res
        .status(readErrorStatus(err))
        .json({ error: readErrorMessage(err, 'suppliers_list_error') });
    }
  });

  app.post('/admin/api/suppliers', authMw.requireRole('admin'), async (req: Request, res: Response) => {
    try {
      const created = await catalogAdmin.createSupplier(req.body || {});
      return res.json(created);
    } catch (err) {
      return res
        .status(readErrorStatus(err))
        .json({ error: readErrorMessage(err, 'supplier_create_error') });
    }
  });

  app.put('/admin/api/suppliers/bulk', authMw.requireRole('admin'), async (req: Request, res: Response) => {
    try {
      const result = await catalogAdmin.bulkUpdateSuppliers(req.body || {});
      return res.json(result);
    } catch (err) {
      return res
        .status(readErrorStatus(err))
        .json({ error: readErrorMessage(err, 'supplier_bulk_update_error') });
    }
  });

  app.put('/admin/api/suppliers/:id', authMw.requireRole('admin'), async (req: Request, res: Response) => {
    try {
      const supplierId = parseRequiredPositiveInt(req.params.id, 'supplier id');
      const updated = await catalogAdmin.updateSupplier(supplierId, req.body || {});
      return res.json(updated);
    } catch (err) {
      return res
        .status(readErrorStatus(err))
        .json({ error: readErrorMessage(err, 'supplier_update_error') });
    }
  });

  app.delete('/admin/api/suppliers/:id', authMw.requireRole('admin'), async (req: Request, res: Response) => {
    try {
      const supplierId = parseRequiredPositiveInt(req.params.id, 'supplier id');
      const deleted = await catalogAdmin.deleteSupplier(supplierId);
      if (!deleted) {
        return res.status(404).json({ error: 'supplier not found' });
      }
      return res.json(deleted);
    } catch (err) {
      return res
        .status(readErrorStatus(err))
        .json({ error: readErrorMessage(err, 'supplier_delete_error') });
    }
  });

  app.get('/admin/api/sources', authMw.requireRole('viewer'), async (req: Request, res: Response) => {
    try {
      const supplierIdRaw = typeof req.query.supplierId === 'string' ? Number(req.query.supplierId) : null;
      const supplierId =
        supplierIdRaw !== null && Number.isFinite(supplierIdRaw) && supplierIdRaw > 0
          ? Math.trunc(supplierIdRaw)
          : null;
      const items = await catalogAdmin.listSources(supplierId);
      return res.json(items);
    } catch (err) {
      return res
        .status(readErrorStatus(err))
        .json({ error: readErrorMessage(err, 'sources_list_error') });
    }
  });

  app.post('/admin/api/sources', authMw.requireRole('admin'), async (req: Request, res: Response) => {
    try {
      const created = await catalogAdmin.createSource(req.body || {});
      return res.json(created);
    } catch (err) {
      return res
        .status(readErrorStatus(err))
        .json({ error: readErrorMessage(err, 'source_create_error') });
    }
  });

  app.put('/admin/api/sources/:id', authMw.requireRole('admin'), async (req: Request, res: Response) => {
    try {
      const sourceId = parseRequiredPositiveInt(req.params.id, 'source id');
      const updated = await catalogAdmin.updateSource(sourceId, req.body || {});
      return res.json(updated);
    } catch (err) {
      return res
        .status(readErrorStatus(err))
        .json({ error: readErrorMessage(err, 'source_update_error') });
    }
  });

  app.delete('/admin/api/sources/:id', authMw.requireRole('admin'), async (req: Request, res: Response) => {
    try {
      const sourceId = parseRequiredPositiveInt(req.params.id, 'source id');
      const deleted = await catalogAdmin.deleteSource(sourceId);
      if (!deleted) {
        return res.status(404).json({ error: 'source not found' });
      }
      return res.json(deleted);
    } catch (err) {
      return res
        .status(readErrorStatus(err))
        .json({ error: readErrorMessage(err, 'source_delete_error') });
    }
  });

  app.get('/admin/api/source-sheets', authMw.requireRole('viewer'), async (req: Request, res: Response) => {
    try {
      const sourceId = parseRequiredPositiveInt(req.query.sourceId, 'sourceId');
      const source = await catalogAdmin.getSourceById(sourceId);
      if (!source) {
        return res.status(404).json({ error: 'source not found' });
      }
      if (source.source_type !== 'google_sheet') {
        return res.status(400).json({ error: 'unsupported source type' });
      }

      const sheets = await listSheetNames(String(source.source_url || ''));
      let selectedSheetName =
        typeof source.sheet_name === 'string' && source.sheet_name.trim()
          ? source.sheet_name.trim()
          : null;
      if (selectedSheetName && sheets.indexOf(selectedSheetName) === -1) {
        selectedSheetName = null;
      }
      if (!selectedSheetName) {
        selectedSheetName = sheets[0] || null;
      }

      return res.json({
        sourceId: source.id,
        sheets,
        selectedSheetName
      });
    } catch (err) {
      return res
        .status(readErrorStatus(err))
        .json({ error: readErrorMessage(err, 'source_sheets_error') });
    }
  });

  app.get('/admin/api/source-preview', authMw.requireRole('viewer'), async (req: Request, res: Response) => {
    try {
      const sourceId = parseRequiredPositiveInt(req.query.sourceId, 'sourceId');
      const headerRowParam = req.query.headerRow;
      const headerRow =
        typeof headerRowParam === 'undefined' ? 1 : Number(headerRowParam);
      const sheetName =
        typeof req.query.sheetName === 'string' && req.query.sheetName.trim()
          ? req.query.sheetName.trim()
          : null;

      const source = await catalogAdmin.getActiveImportSourceById(sourceId);
      if (!source) {
        return res.status(404).json({ error: 'source not found' });
      }
      if (source.source_type !== 'google_sheet') {
        return res.status(400).json({ error: 'unsupported source type' });
      }

      const preview = await getSheetPreview(
        String(source.source_url || ''),
        sheetName || (source.sheet_name ? String(source.sheet_name) : null),
        headerRow,
        5
      );

      const hasHeader = preview.headerRow > 0;
      let headers: string[] = [];
      let sampleRows: string[][] = [];
      if (hasHeader) {
        headers = preview.rows[0] || [];
        sampleRows = preview.rows.slice(1);
      } else {
        const maxColumns = preview.rows.reduce(
          (max, row) => Math.max(max, row.length),
          0
        );
        headers = Array.from({ length: maxColumns }, () => '');
        sampleRows = preview.rows;
      }

      return res.json({
        sourceId: source.id,
        sheetName: preview.sheetName,
        headerRow: preview.headerRow,
        headers,
        sampleRows
      });
    } catch (err) {
      return res
        .status(readErrorStatus(err))
        .json({ error: readErrorMessage(err, 'source_preview_error') });
    }
  });

  app.get(
    '/admin/api/mappings/:supplierId',
    authMw.requireRole('viewer'),
    async (req: Request, res: Response) => {
      try {
        const supplierId = parseRequiredPositiveInt(req.params.supplierId, 'supplierId');
        const sourceId =
          typeof req.query.sourceId === 'string' ? Number(req.query.sourceId) : null;
        const mapping = await catalogAdmin.getLatestMapping(supplierId, sourceId);
        return res.json(mapping);
      } catch (err) {
        return res
          .status(readErrorStatus(err))
          .json({ error: readErrorMessage(err, 'mapping_get_error') });
      }
    }
  );

  app.post(
    '/admin/api/mappings/:supplierId',
    authMw.requireRole('admin'),
    async (req: Request, res: Response) => {
      try {
        const supplierId = parseRequiredPositiveInt(req.params.supplierId, 'supplierId');
        const mapping = await catalogAdmin.saveMapping(supplierId, req.body || {});
        return res.json(mapping);
      } catch (err) {
        return res
          .status(readErrorStatus(err))
          .json({ error: readErrorMessage(err, 'mapping_save_error') });
      }
    }
  );

  app.get(
    '/admin/api/markup-rule-sets',
    authMw.requireRole('viewer'),
    async (_req: Request, res: Response) => {
      try {
        const payload = await catalogAdmin.listMarkupRuleSets();
        return res.json(payload);
      } catch (err) {
        return res
          .status(readErrorStatus(err))
          .json({ error: readErrorMessage(err, 'markup_rule_sets_list_error') });
      }
    }
  );

  app.post(
    '/admin/api/markup-rule-sets',
    authMw.requireRole('admin'),
    async (req: Request, res: Response) => {
      try {
        const result = await catalogAdmin.createMarkupRuleSet(req.body || {});
        return res.json(result);
      } catch (err) {
        return res
          .status(readErrorStatus(err))
          .json({ error: readErrorMessage(err, 'markup_rule_set_create_error') });
      }
    }
  );

  app.put(
    '/admin/api/markup-rule-sets/:id',
    authMw.requireRole('admin'),
    async (req: Request, res: Response) => {
      try {
        const ruleSetId = parseRequiredPositiveInt(req.params.id, 'rule set id');
        const result = await catalogAdmin.updateMarkupRuleSet(ruleSetId, req.body || {});
        return res.json(result);
      } catch (err) {
        return res
          .status(readErrorStatus(err))
          .json({ error: readErrorMessage(err, 'markup_rule_set_update_error') });
      }
    }
  );

  app.post(
    '/admin/api/markup-rule-sets/apply',
    authMw.requireRole('admin'),
    async (req: Request, res: Response) => {
      try {
        const result = await catalogAdmin.applyMarkupRuleSet(req.body || {});
        return res.json(result);
      } catch (err) {
        return res
          .status(readErrorStatus(err))
          .json({ error: readErrorMessage(err, 'markup_rule_set_apply_error') });
      }
    }
  );

  app.get(
    '/admin/api/price-overrides',
    authMw.requireRole('viewer'),
    async (req: Request, res: Response) => {
      try {
        const limit = parseLimit(req.query.limit, 100);
        const offsetRaw = Number(req.query.offset);
        const offset = Number.isFinite(offsetRaw) ? Math.max(0, Math.trunc(offsetRaw)) : 0;
        const search = typeof req.query.search === 'string' ? req.query.search : null;
        const result = await catalogAdmin.listPriceOverrides({
          limit,
          offset,
          search
        });
        return res.json(result);
      } catch (err) {
        return res
          .status(readErrorStatus(err))
          .json({ error: readErrorMessage(err, 'price_overrides_list_error') });
      }
    }
  );

  app.post(
    '/admin/api/price-overrides',
    authMw.requireRole('admin'),
    async (req: Request, res: Response) => {
      try {
        const result = await catalogAdmin.upsertPriceOverride(req.body || {});
        return res.json(result);
      } catch (err) {
        return res
          .status(readErrorStatus(err))
          .json({ error: readErrorMessage(err, 'price_override_save_error') });
      }
    }
  );

  app.put(
    '/admin/api/price-overrides/:id',
    authMw.requireRole('admin'),
    async (req: Request, res: Response) => {
      try {
        const overrideId = parseRequiredPositiveInt(req.params.id, 'override id');
        const result = await catalogAdmin.updatePriceOverride(overrideId, req.body || {});
        return res.json(result);
      } catch (err) {
        return res
          .status(readErrorStatus(err))
          .json({ error: readErrorMessage(err, 'price_override_update_error') });
      }
    }
  );

  app.get('/admin/api/preview', authMw.requireRole('viewer'), async (req: Request, res: Response) => {
    const supplier = typeof req.query.supplier === 'string' ? req.query.supplier : null;
    try {
      const preview = await pipeline.runStoreExport(0, supplier);
      res.json({
        store: appContext.connector.store,
        total: preview.preview.total,
        supplier: preview.preview.supplier,
        sample: preview.preview.rows.slice(0, 10)
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'preview_error';
      res.status(500).json({ error: msg });
    }
  });

  app.post('/admin/api/store-import', authMw.requireRole('admin'), async (req: Request, res: Response) => {
    const supplier = typeof req.body?.supplier === 'string' ? req.body.supplier : null;
    try {
      const execution = await jobRunner.runStoreImport(supplier, readStoreImportRunOptions(req));
      res.json({
        jobId: execution.jobId,
        store: appContext.connector.store,
        imported: execution.result.importResult.imported,
        skipped: execution.result.importResult.skipped,
        warnings: execution.result.importResult.warnings,
        total: execution.result.preview.total
      });
    } catch (err) {
      res.status(readErrorStatus(err)).json({ error: readErrorMessage(err, 'store_import_error') });
    }
  });

  app.get('/admin/api/logs', authMw.requireRole('viewer'), async (req: Request, res: Response) => {
    try {
      const limit = parseLimit(req.query.limit, 200);
      const jobIdRaw = typeof req.query.jobId === 'string' ? Number(req.query.jobId) : null;
      const jobId =
        jobIdRaw !== null && Number.isFinite(jobIdRaw) && jobIdRaw > 0 ? Math.trunc(jobIdRaw) : null;
      const level = typeof req.query.level === 'string' ? req.query.level : null;
      const items = await catalogAdmin.listLogs({
        jobId,
        level,
        limit
      });
      return res.json(items);
    } catch (err) {
      return res
        .status(readErrorStatus(err))
        .json({ error: readErrorMessage(err, 'logs_list_error') });
    }
  });

  app.get('/admin/api/stats', authMw.requireRole('viewer'), async (_req: Request, res: Response) => {
    try {
      const stats = await catalogAdmin.getStats();
      return res.json(stats);
    } catch (err) {
      return res
        .status(readErrorStatus(err))
        .json({ error: readErrorMessage(err, 'stats_error') });
    }
  });

  app.get('/admin/api/jobs', authMw.requireRole('viewer'), async (req: Request, res: Response) => {
    try {
      const limit = parseLimit(req.query.limit, 50);
      const items = await jobs.listJobs(limit);
      res.json({ items });
    } catch (err) {
      res.status(readErrorStatus(err)).json({ error: readErrorMessage(err, 'jobs_list_error') });
    }
  });

  app.get('/admin/api/jobs/:jobId', authMw.requireRole('viewer'), async (req: Request, res: Response) => {
    const jobId = Number(req.params.jobId);
    if (!Number.isFinite(jobId)) {
      return res.status(400).json({ error: 'jobId must be a number' });
    }
    try {
      const job = await jobs.getJob(jobId);
      if (!job) {
        return res.status(404).json({ error: 'job_not_found' });
      }
      const [children, jobLogs] = await Promise.all([
        jobs.listChildJobs(jobId),
        jobs.listJobLogs(jobId, 300)
      ]);
      return res.json({
        job,
        children,
        logs: jobLogs
      });
    } catch (err) {
      return res
        .status(readErrorStatus(err))
        .json({ error: readErrorMessage(err, 'job_details_error') });
    }
  });

  app.post('/admin/api/jobs/import-all', authMw.requireRole('admin'), async (_req: Request, res: Response) => {
    try {
      const result = await jobRunner.runImportAll();
      res.json(result);
    } catch (err) {
      res.status(readErrorStatus(err)).json({ error: readErrorMessage(err, 'import_all_error') });
    }
  });

  app.post(
    '/admin/api/jobs/import-source',
    authMw.requireRole('admin'),
    async (req: Request, res: Response) => {
      try {
        const sourceId = parseRequiredPositiveInt(req.body?.sourceId, 'sourceId');
        const result = await jobRunner.runImportSource(sourceId);
        if (readVerboseFlag(req)) {
          return res.json(result);
        }
        return res.json({
          jobId: result.jobId,
          result: result.result
        });
      } catch (err) {
        return res
          .status(readErrorStatus(err))
          .json({ error: readErrorMessage(err, 'import_source_error') });
      }
    }
  );

  app.post(
    '/admin/api/jobs/import-supplier',
    authMw.requireRole('admin'),
    async (req: Request, res: Response) => {
      try {
        const supplierId = parseRequiredPositiveInt(req.body?.supplierId, 'supplierId');
        const result = await jobRunner.runImportSupplier(supplierId);
        if (readVerboseFlag(req)) {
          return res.json(result);
        }
        return res.json({
          jobId: result.jobId,
          result: result.result
        });
      } catch (err) {
        return res
          .status(readErrorStatus(err))
          .json({ error: readErrorMessage(err, 'import_supplier_error') });
      }
    }
  );

  app.post('/admin/api/jobs/finalize', authMw.requireRole('admin'), async (_req: Request, res: Response) => {
    try {
      const result = await jobRunner.runFinalize();
      res.json(result);
    } catch (err) {
      res.status(readErrorStatus(err)).json({ error: readErrorMessage(err, 'finalize_error') });
    }
  });

  app.post('/admin/api/jobs/store-import', authMw.requireRole('admin'), async (req: Request, res: Response) => {
    const supplier = typeof req.body?.supplier === 'string' ? req.body.supplier : null;
    try {
      const result = await jobRunner.runStoreImport(supplier, readStoreImportRunOptions(req));
      if (readVerboseFlag(req)) {
        return res.json(result);
      }
      return res.json({
        jobId: result.jobId,
        result: summarizeStoreImportExecution(result.result)
      });
    } catch (err) {
      res.status(readErrorStatus(err)).json({ error: readErrorMessage(err, 'store_import_error') });
    }
  });

  app.post(
    '/admin/api/jobs/update-pipeline',
    authMw.requireRole('admin'),
    async (req: Request, res: Response) => {
      const supplier = typeof req.body?.supplier === 'string' ? req.body.supplier : null;
      try {
        const result = await jobRunner.runUpdatePipeline(supplier);
        if (readVerboseFlag(req)) {
          return res.json(result);
        }
        return res.json({
          jobId: result.jobId,
          result: {
            importSummary: result.result.importSummary,
            finalizeSummary: result.result.finalizeSummary,
            storeExecution: summarizeStoreImportExecution(result.result.storeExecution)
          }
        });
      } catch (err) {
        res
          .status(readErrorStatus(err))
          .json({ error: readErrorMessage(err, 'update_pipeline_error') });
      }
    }
  );

  app.post(
    '/admin/api/jobs/store-mirror-sync',
    authMw.requireRole('admin'),
    async (_req: Request, res: Response) => {
      try {
        const result = await jobRunner.runStoreMirrorSync();
        res.json(result);
      } catch (err) {
        res
          .status(readErrorStatus(err))
          .json({ error: readErrorMessage(err, 'store_mirror_sync_error') });
      }
    }
  );

  app.post('/admin/api/jobs/cleanup', authMw.requireRole('admin'), async (req: Request, res: Response) => {
    const requested = Number(req.body?.retentionDays);
    const retentionDays = Number.isFinite(requested)
      ? Math.max(1, Math.trunc(requested))
      : appContext.config.base.cleanupRetentionDays;
    try {
      const result = await jobRunner.runCleanup(retentionDays);
      res.json(result);
    } catch (err) {
      res.status(readErrorStatus(err)).json({ error: readErrorMessage(err, 'cleanup_error') });
    }
  });

  app.post(
    '/admin/api/jobs/:jobId/cancel',
    authMw.requireRole('admin'),
    async (req: Request, res: Response) => {
      const jobId = Number(req.params.jobId);
      if (!Number.isFinite(jobId)) {
        return res.status(400).json({ error: 'jobId must be a number' });
      }
      try {
        const job = await jobs.getJob(jobId);
        if (!job) {
          return res.status(404).json({ error: 'job_not_found' });
        }
        if (job.status !== 'running' && job.status !== 'queued') {
          return res.status(409).json({ error: 'job_not_running' });
        }

        const reason =
          typeof req.body?.reason === 'string' && req.body.reason.trim()
            ? req.body.reason.trim()
            : 'Canceled by user';

        const canceledChildren: number[] = [];
        const terminatedChildren: Array<{ jobId: number; pids: number[] }> = [];
        if (job.type === 'update_pipeline') {
          const childJobs = await jobs.listChildJobs(jobId);
          for (let index = 0; index < childJobs.length; index += 1) {
            const child = childJobs[index];
            if (child.status !== 'running' && child.status !== 'queued') {
              continue;
            }
            let childTerminatedPids: number[] = [];
            if (child.status === 'running') {
              const terminations = await jobs.terminateJobBackend(child.id, child.type);
              childTerminatedPids = terminations
                .filter((row) => row.terminated === true)
                .map((row) => row.pid)
                .filter((value) => Number.isFinite(value));
            }
            await jobs.cancelJob(child.id, `Canceled with parent pipeline #${jobId}`);
            canceledChildren.push(child.id);
            if (childTerminatedPids.length > 0) {
              terminatedChildren.push({ jobId: child.id, pids: childTerminatedPids });
            }
            await logs.log(child.id, 'error', 'Job canceled', {
              reason: `Canceled with parent pipeline #${jobId}`,
              parentPipelineJobId: jobId,
              terminatedPids: childTerminatedPids
            });
          }
        }

        let terminatedPids: number[] = [];
        if (job.status === 'running') {
          const terminations = await jobs.terminateJobBackend(job.id, job.type);
          terminatedPids = terminations
            .filter((row) => row.terminated === true)
            .map((row) => row.pid)
            .filter((value) => Number.isFinite(value));
        }
        const canceled = await jobs.cancelJob(jobId, reason);
        await logs.log(jobId, 'error', 'Job canceled', {
          reason,
          childCanceled: canceledChildren,
          terminatedPids,
          terminatedChildren
        });

        return res.json({
          job: canceled,
          childCanceled: canceledChildren,
          terminatedPids,
          terminatedChildren
        });
      } catch (err) {
        return res
          .status(readErrorStatus(err))
          .json({ error: readErrorMessage(err, 'job_cancel_error') });
      }
    }
  );

  app.get('/admin/login', (_req, res) => {
    res.set('Content-Type', 'text/html; charset=utf-8').send(renderLoginPage());
  });

  // Protected static admin UI
  app.use('/admin', authMw.requireRole('viewer'), express.static(adminStaticPath));
  app.get('/admin/*', authMw.requireRole('viewer'), (_req, res) => {
    res.sendFile(path.join(adminStaticPath, 'index.html'));
  });

  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));

  return app;
}
