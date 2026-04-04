import express from 'express';
import cookieParser from 'cookie-parser';
import fs from 'fs';
import path from 'path';
import type { Application as AppContext } from '../createApplication';
import type { NextFunction, Request, Response } from 'express';
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
  const schedulerSettings = appContext.schedulerSettingsService;
  const logs = appContext.logService;
  const bundledAdminPath = path.join(__dirname, '..', '..', 'public', 'admin');
  const workspaceAdminPath = path.join(process.cwd(), 'public', 'admin');
  const adminStaticPath = fs.existsSync(bundledAdminPath) ? bundledAdminPath : workspaceAdminPath;

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

  const parseOptionalPositiveInt = (value: unknown): number | null => {
    if (value === null || typeof value === 'undefined' || String(value).trim() === '') {
      return null;
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return null;
    }
    return Math.trunc(parsed);
  };

  const parseOffset = (value: unknown): number => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric < 0) {
      return 0;
    }
    return Math.trunc(numeric);
  };

  const parseSupplierSort = (value: unknown): 'id_asc' | 'name_asc' | 'name_desc' => {
    if (typeof value !== 'string') {
      return 'id_asc';
    }
    const normalized = value.trim().toLowerCase();
    if (
      normalized === 'name_asc' ||
      normalized === 'a-z' ||
      normalized === 'az' ||
      normalized === 'asc'
    ) {
      return 'name_asc';
    }
    if (
      normalized === 'name_desc' ||
      normalized === 'z-a' ||
      normalized === 'za' ||
      normalized === 'desc'
    ) {
      return 'name_desc';
    }
    return 'id_asc';
  };

  const normalizeAdminNextPath = (value: unknown, fallback = '/admin'): string => {
    if (typeof value !== 'string') {
      return fallback;
    }
    const nextPath = value.trim();
    if (!nextPath) {
      return fallback;
    }
    if (!nextPath.startsWith('/')) {
      return fallback;
    }
    if (nextPath.startsWith('//')) {
      return fallback;
    }
    if (!nextPath.startsWith('/admin')) {
      return fallback;
    }
    if (nextPath === '/admin/login' || nextPath.startsWith('/admin/login?')) {
      return fallback;
    }
    if (nextPath.startsWith('/admin/api')) {
      return fallback;
    }
    if (nextPath.startsWith('/admin/assets')) {
      return fallback;
    }
    return nextPath;
  };

  const buildLoginRedirectPath = (req: Request): string => {
    const nextPath = normalizeAdminNextPath(req.originalUrl, '/admin');
    return `/admin/login?next=${encodeURIComponent(nextPath)}`;
  };

  const requireAdminUiAuth = (req: Request, res: Response, next: NextFunction) => {
    if (!req.userRole) {
      return res.redirect(302, buildLoginRedirectPath(req));
    }
    return next();
  };

  const toCsvCell = (value: unknown): string => {
    if (value === null || typeof value === 'undefined') {
      return '';
    }
    const text = String(value);
    if (/[",\n\r]/.test(text)) {
      return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
  };

  const writeCsvRow = (res: Response, values: unknown[]): void => {
    res.write(`${values.map((value) => toCsvCell(value)).join(',')}\n`);
  };

  const startCsvDownload = (res: Response, filenamePrefix: string): void => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${filenamePrefix}_${Date.now()}.csv"`
    );
    res.write('\uFEFF');
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

  // Root redirect: logged in → /admin, not logged in → /admin/login
  app.get('/', (req: Request, res: Response) => {
    if (req.userRole) {
      return res.redirect(302, '/admin');
    }
    return res.redirect(302, '/admin/login');
  });

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

  app.get('/admin/api/suppliers', authMw.requireRole('viewer'), async (req: Request, res: Response) => {
    try {
      const search = typeof req.query.search === 'string' ? req.query.search : null;
      const sort = parseSupplierSort(req.query.sort);
      const items = await catalogAdmin.listSuppliers({
        search,
        sort
      });
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

  app.get(
    '/admin/api/mappings/:supplierId/list',
    authMw.requireRole('viewer'),
    async (req: Request, res: Response) => {
      try {
        const supplierId = parseRequiredPositiveInt(req.params.supplierId, 'supplierId');
        const sourceId =
          typeof req.query.sourceId === 'string' ? Number(req.query.sourceId) : null;
        const mappings = await catalogAdmin.listMappings(supplierId, sourceId);
        return res.json(mappings);
      } catch (err) {
        return res
          .status(readErrorStatus(err))
          .json({ error: readErrorMessage(err, 'mappings_list_error') });
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

  app.delete(
    '/admin/api/mappings/:supplierId/:mappingId',
    authMw.requireRole('admin'),
    async (req: Request, res: Response) => {
      try {
        const supplierId = parseRequiredPositiveInt(req.params.supplierId, 'supplierId');
        const mappingId = parseRequiredPositiveInt(req.params.mappingId, 'mappingId');
        const deleted = await catalogAdmin.deleteMapping(supplierId, mappingId);
        if (!deleted) {
          return res.status(404).json({ error: 'mapping not found' });
        }
        return res.json(deleted);
      } catch (err) {
        return res
          .status(readErrorStatus(err))
          .json({ error: readErrorMessage(err, 'mapping_delete_error') });
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

  app.delete(
    '/admin/api/markup-rule-sets/:id',
    authMw.requireRole('admin'),
    async (req: Request, res: Response) => {
      try {
        const ruleSetId = parseRequiredPositiveInt(req.params.id, 'rule set id');
        const result = await catalogAdmin.deleteMarkupRuleSet(ruleSetId);
        return res.json(result);
      } catch (err) {
        return res
          .status(readErrorStatus(err))
          .json({ error: readErrorMessage(err, 'markup_rule_set_delete_error') });
      }
    }
  );

  app.post(
    '/admin/api/markup-rule-sets/default',
    authMw.requireRole('admin'),
    async (req: Request, res: Response) => {
      try {
        const result = await catalogAdmin.setDefaultMarkupRuleSet(req.body || {});
        return res.json(result);
      } catch (err) {
        return res
          .status(readErrorStatus(err))
          .json({ error: readErrorMessage(err, 'markup_rule_set_default_error') });
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

  // ─── Size Mappings ──────────────────────────────────────────────────────────

  app.get('/admin/api/size-mappings/unmapped', authMw.requireRole('viewer'), async (req: Request, res: Response) => {
    try {
      const limit = req.query.limit ? Number(req.query.limit) : 200;
      const result = await catalogAdmin.listUnmappedSizes(limit);
      return res.json(result);
    } catch (err) {
      return res.status(readErrorStatus(err)).json({ error: readErrorMessage(err, 'size_mappings_unmapped_error') });
    }
  });

  app.get('/admin/api/size-mappings', authMw.requireRole('viewer'), async (req: Request, res: Response) => {
    try {
      const search = typeof req.query.search === 'string' ? req.query.search : undefined;
      const limit = req.query.limit ? Number(req.query.limit) : 200;
      const offset = req.query.offset ? Number(req.query.offset) : 0;
      const result = await catalogAdmin.listSizeMappings({ search, limit, offset });
      return res.json(result);
    } catch (err) {
      return res.status(readErrorStatus(err)).json({ error: readErrorMessage(err, 'size_mappings_list_error') });
    }
  });

  app.post('/admin/api/size-mappings', authMw.requireRole('admin'), async (req: Request, res: Response) => {
    try {
      const result = await catalogAdmin.createSizeMapping(req.body || {});
      return res.json(result);
    } catch (err) {
      return res.status(readErrorStatus(err)).json({ error: readErrorMessage(err, 'size_mapping_create_error') });
    }
  });

  app.put('/admin/api/size-mappings/:id', authMw.requireRole('admin'), async (req: Request, res: Response) => {
    try {
      const id = parseRequiredPositiveInt(req.params.id, 'mapping id');
      const result = await catalogAdmin.updateSizeMapping(id, req.body || {});
      if (!result) return res.status(404).json({ error: 'size mapping not found' });
      return res.json(result);
    } catch (err) {
      return res.status(readErrorStatus(err)).json({ error: readErrorMessage(err, 'size_mapping_update_error') });
    }
  });

  app.delete('/admin/api/size-mappings/:id', authMw.requireRole('admin'), async (req: Request, res: Response) => {
    try {
      const id = parseRequiredPositiveInt(req.params.id, 'mapping id');
      const result = await catalogAdmin.deleteSizeMapping(id);
      if (!result) return res.status(404).json({ error: 'size mapping not found' });
      return res.json(result);
    } catch (err) {
      return res.status(readErrorStatus(err)).json({ error: readErrorMessage(err, 'size_mapping_delete_error') });
    }
  });

  app.post('/admin/api/size-mappings/bulk-import', authMw.requireRole('admin'), async (req: Request, res: Response) => {
    try {
      const rows = req.body?.rows;
      if (!Array.isArray(rows)) return res.status(400).json({ error: 'rows must be an array' });
      const result = await catalogAdmin.bulkImportSizeMappings(rows);
      return res.json(result);
    } catch (err) {
      return res.status(readErrorStatus(err)).json({ error: readErrorMessage(err, 'size_mapping_bulk_import_error') });
    }
  });

  app.get('/admin/api/size-mappings/export', authMw.requireRole('viewer'), async (req: Request, res: Response) => {
    try {
      const pageSize = 5000;
      const search = typeof req.query.search === 'string' ? req.query.search : undefined;
      let offset = 0;

      startCsvDownload(res, 'size_mappings');
      writeCsvRow(res, ['size_from', 'size_to', 'notes', 'is_active', 'created_at']);

      while (true) {
        // eslint-disable-next-line no-await-in-loop
        const chunk = await catalogAdmin.listSizeMappings({ search, limit: pageSize, offset, maxLimit: pageSize });
        for (let index = 0; index < chunk.rows.length; index += 1) {
          const row = chunk.rows[index] as Record<string, unknown>;
          writeCsvRow(res, [row.size_from, row.size_to, row.notes, row.is_active, row.created_at]);
        }
        if (chunk.rows.length < pageSize) {
          break;
        }
        offset += pageSize;
      }

      res.end();
    } catch (err) {
      return res.status(readErrorStatus(err)).json({ error: readErrorMessage(err, 'size_mappings_export_error') });
    }
  });

  app.get('/admin/api/size-mappings/unmapped-export', authMw.requireRole('viewer'), async (req: Request, res: Response) => {
    try {
      startCsvDownload(res, 'unmapped_sizes');
      writeCsvRow(res, ['raw_size', 'will_become', 'product_count', 'supplier_count']);

      const result = await catalogAdmin.listUnmappedSizes(100000, 100000);
      for (let index = 0; index < result.rows.length; index += 1) {
        const row = result.rows[index];
        writeCsvRow(res, [row.raw_size, row.will_become, row.product_count, row.supplier_count]);
      }

      res.end();
    } catch (err) {
      return res.status(readErrorStatus(err)).json({ error: readErrorMessage(err, 'unmapped_sizes_export_error') });
    }
  });

  // ────────────────────────────────────────────────────────────────────────────

  app.get('/admin/api/preview', authMw.requireRole('viewer'), async (req: Request, res: Response) => {
    const supplier = typeof req.query.supplier === 'string' ? req.query.supplier : null;
    try {
      const preview = await pipeline.runStoreExport(0, supplier);
      const batchRows = Array.isArray(preview.batch.rows) ? preview.batch.rows.length : 0;
      res.json({
        store: appContext.connector.store,
        total: preview.preview.total,
        previewTotal: preview.preview.total,
        batchTotal: batchRows,
        supplier: preview.preview.supplier,
        batchMeta: preview.batch.meta || null,
        sample: preview.preview.rows.slice(0, 10)
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'preview_error';
      res.status(500).json({ error: msg });
    }
  });

  app.get('/admin/api/store-preview', authMw.requireRole('viewer'), async (req: Request, res: Response) => {
    try {
      const limit = parseLimit(req.query.limit, 100);
      const offset = parseOffset(req.query.offset);
      const supplierId = parseOptionalPositiveInt(req.query.supplierId);
      const search = typeof req.query.search === 'string' ? req.query.search : null;
      const store = typeof req.query.store === 'string' ? req.query.store : 'cscart';
      const mode =
        typeof req.query.mode === 'string' && req.query.mode.trim().toLowerCase() === 'delta'
          ? 'delta'
          : 'candidates';

      if (mode === 'delta') {
        let supplierFilter: string | null = null;
        if (supplierId) {
          const supplierName = await catalogAdmin.getSupplierNameById(supplierId);
          if (!supplierName) {
            return res.status(404).json({ error: 'supplier not found' });
          }
          supplierFilter = supplierName;
        }

        const exportResult = await pipeline.runStoreExport(0, supplierFilter);
        const suppliersForPrefix = await catalogAdmin.listSuppliers({
          search: null,
          sort: 'id_asc'
        });
        const prefixBySupplierName = new Map<string, string>();
        for (let index = 0; index < suppliersForPrefix.length; index += 1) {
          const row = suppliersForPrefix[index] as Record<string, unknown>;
          const name = String(row.name || '').trim().toLowerCase();
          const prefix = String(row.sku_prefix || '').trim();
          if (!name || !prefix) {
            continue;
          }
          prefixBySupplierName.set(name, prefix);
        }
        const preparedRows = (Array.isArray(exportResult.batch?.rows) ? exportResult.batch.rows : []).map(
          (row) => {
            const payload = (row || {}) as Record<string, unknown>;
            const supplierName =
              payload.supplier === null || typeof payload.supplier === 'undefined'
                ? null
                : String(payload.supplier);
            const supplierPrefix = supplierName
              ? prefixBySupplierName.get(supplierName.trim().toLowerCase()) || null
              : null;
            return {
              article: String(payload.productCode || ''),
              size: payload.size === null || typeof payload.size === 'undefined' ? null : String(payload.size),
              supplier_name: supplierName,
              supplier_sku_prefix: supplierPrefix,
              parent_article:
                payload.parentProductCode === null || typeof payload.parentProductCode === 'undefined'
                  ? null
                  : String(payload.parentProductCode),
              visibility: payload.visibility === true,
              price_final:
                payload.price === null || typeof payload.price === 'undefined'
                  ? null
                  : Number(payload.price),
              quantity: null,
              price_base: null,
              comment: null
            };
          }
        );

        const searchLower = String(search || '').trim().toLowerCase();
        const filteredRows = searchLower
          ? preparedRows.filter((row) => {
              const article = String(row.article || '').toLowerCase();
              const supplierName = String(row.supplier_name || '').toLowerCase();
              const supplierPrefix = String(row.supplier_sku_prefix || '').toLowerCase();
              const parentArticle = String(row.parent_article || '').toLowerCase();
              return (
                article.includes(searchLower) ||
                supplierName.includes(searchLower) ||
                supplierPrefix.includes(searchLower) ||
                parentArticle.includes(searchLower)
              );
            })
          : preparedRows;

        const total = filteredRows.length;
        const rows = filteredRows.slice(offset, offset + limit);
        return res.json({
          mode,
          store: appContext.connector.store,
          supplier: supplierFilter,
          total,
          previewTotal: Number(exportResult.preview?.total || 0),
          batchTotal: Array.isArray(exportResult.batch?.rows) ? exportResult.batch.rows.length : 0,
          batchMeta: exportResult.batch?.meta || null,
          rows
        });
      }

      const result = await catalogAdmin.listStoreImportPreview({
        limit,
        offset,
        supplierId,
        search,
        store
      });
      return res.json({
        mode,
        ...result,
        previewTotal: result.total,
        batchTotal: null,
        batchMeta: null
      });
    } catch (err) {
      return res
        .status(readErrorStatus(err))
        .json({ error: readErrorMessage(err, 'store_preview_error') });
    }
  });

  app.get('/admin/api/store-mirror-preview', authMw.requireRole('viewer'), async (req: Request, res: Response) => {
    try {
      const limit = parseLimit(req.query.limit, 100);
      const offset = parseOffset(req.query.offset);
      const search = typeof req.query.search === 'string' ? req.query.search : null;
      const store = typeof req.query.store === 'string' ? req.query.store : 'cscart';
      const result = await catalogAdmin.listStoreMirrorPreview({
        limit,
        offset,
        search,
        store
      });
      return res.json(result);
    } catch (err) {
      return res
        .status(readErrorStatus(err))
        .json({ error: readErrorMessage(err, 'store_mirror_preview_error') });
    }
  });

  app.get('/admin/api/merged-preview', authMw.requireRole('viewer'), async (req: Request, res: Response) => {
    try {
      const limit = parseLimit(req.query.limit, 100);
      const offset = parseOffset(req.query.offset);
      const jobId = parseOptionalPositiveInt(req.query.jobId);
      const search = typeof req.query.search === 'string' ? req.query.search : null;
      const sort = typeof req.query.sort === 'string' ? req.query.sort : null;
      const result = await catalogAdmin.listMergedPreview({
        limit,
        offset,
        jobId,
        search,
        sort
      });
      return res.json(result);
    } catch (err) {
      return res
        .status(readErrorStatus(err))
        .json({ error: readErrorMessage(err, 'merged_preview_error') });
    }
  });

  app.get('/admin/api/final-preview', authMw.requireRole('viewer'), async (req: Request, res: Response) => {
    try {
      const limit = parseLimit(req.query.limit, 100);
      const offset = parseOffset(req.query.offset);
      const jobId = parseOptionalPositiveInt(req.query.jobId);
      const supplierId = parseOptionalPositiveInt(req.query.supplierId);
      const search = typeof req.query.search === 'string' ? req.query.search : null;
      const sort = typeof req.query.sort === 'string' ? req.query.sort : null;
      const result = await catalogAdmin.listFinalPreview({
        limit,
        offset,
        jobId,
        supplierId,
        search,
        sort
      });
      return res.json(result);
    } catch (err) {
      return res
        .status(readErrorStatus(err))
        .json({ error: readErrorMessage(err, 'final_preview_error') });
    }
  });

  app.get('/admin/api/compare-preview', authMw.requireRole('viewer'), async (req: Request, res: Response) => {
    try {
      const limit = parseLimit(req.query.limit, 100);
      const offset = parseOffset(req.query.offset);
      const supplierId = parseOptionalPositiveInt(req.query.supplierId);
      const search = typeof req.query.search === 'string' ? req.query.search : null;
      const missingOnly =
        typeof req.query.missingOnly === 'string'
          ? req.query.missingOnly === '1' || req.query.missingOnly.toLowerCase() === 'true'
          : false;
      const store = typeof req.query.store === 'string' ? req.query.store : 'cscart';
      const result = await catalogAdmin.listComparePreview({
        limit,
        offset,
        supplierId,
        search,
        missingOnly,
        store
      });
      return res.json(result);
    } catch (err) {
      return res
        .status(readErrorStatus(err))
        .json({ error: readErrorMessage(err, 'compare_preview_error') });
    }
  });

  app.get('/admin/api/merged-export', authMw.requireRole('viewer'), async (req: Request, res: Response) => {
    try {
      const pageSize = 5000;
      const sort = typeof req.query.sort === 'string' ? req.query.sort : null;
      const search = typeof req.query.search === 'string' ? req.query.search : null;
      let jobId = parseOptionalPositiveInt(req.query.jobId);
      let offset = 0;

      startCsvDownload(res, 'merged_export');
      writeCsvRow(res, [
        'article',
        'size',
        'quantity',
        'price',
        'extra',
        'comment',
        'supplier',
        'supplier_sku_prefix',
        'created_at'
      ]);

      while (true) {
        // eslint-disable-next-line no-await-in-loop
        const chunk = await catalogAdmin.listMergedPreview({
          limit: pageSize,
          offset,
          jobId,
          search,
          sort
        });
        if (!jobId && chunk.jobId) {
          jobId = Number(chunk.jobId);
        }

        for (let index = 0; index < chunk.rows.length; index += 1) {
          const row = chunk.rows[index] as Record<string, unknown>;
          writeCsvRow(res, [
            row.article,
            row.size,
            row.quantity,
            row.price,
            row.extra,
            row.comment,
            row.supplier_name,
            row.supplier_sku_prefix,
            row.created_at
          ]);
        }

        if (chunk.rows.length < pageSize) {
          break;
        }
        offset += pageSize;
      }

      res.end();
    } catch (err) {
      return res
        .status(readErrorStatus(err))
        .json({ error: readErrorMessage(err, 'merged_export_error') });
    }
  });

  app.get('/admin/api/final-export', authMw.requireRole('viewer'), async (req: Request, res: Response) => {
    try {
      const pageSize = 5000;
      const sort = typeof req.query.sort === 'string' ? req.query.sort : null;
      const search = typeof req.query.search === 'string' ? req.query.search : null;
      const supplierId = parseOptionalPositiveInt(req.query.supplierId);
      let jobId = parseOptionalPositiveInt(req.query.jobId);
      let offset = 0;

      startCsvDownload(res, 'final_export');
      writeCsvRow(res, [
        'article',
        'size',
        'quantity',
        'price_base',
        'price_final',
        'extra',
        'comment',
        'supplier',
        'supplier_sku_prefix'
      ]);

      while (true) {
        // eslint-disable-next-line no-await-in-loop
        const chunk = await catalogAdmin.listFinalPreview({
          limit: pageSize,
          offset,
          jobId,
          supplierId,
          search,
          sort
        });
        if (!jobId && chunk.jobId) {
          jobId = Number(chunk.jobId);
        }

        for (let index = 0; index < chunk.rows.length; index += 1) {
          const row = chunk.rows[index] as Record<string, unknown>;
          writeCsvRow(res, [
            row.article,
            row.size,
            row.quantity,
            row.price_base,
            row.price_final,
            row.extra,
            row.comment,
            row.supplier_name,
            row.supplier_sku_prefix
          ]);
        }

        if (chunk.rows.length < pageSize) {
          break;
        }
        offset += pageSize;
      }

      res.end();
    } catch (err) {
      return res
        .status(readErrorStatus(err))
        .json({ error: readErrorMessage(err, 'final_export_error') });
    }
  });

  app.get('/admin/api/compare-export', authMw.requireRole('viewer'), async (req: Request, res: Response) => {
    try {
      const pageSize = 5000;
      const supplierId = parseOptionalPositiveInt(req.query.supplierId);
      const search = typeof req.query.search === 'string' ? req.query.search : null;
      const missingOnly =
        typeof req.query.missingOnly === 'string'
          ? req.query.missingOnly === '1' || req.query.missingOnly.toLowerCase() === 'true'
          : false;
      const store = typeof req.query.store === 'string' ? req.query.store : 'cscart';
      let offset = 0;

      startCsvDownload(res, 'compare_export');
      writeCsvRow(res, [
        'article',
        'size',
        'quantity',
        'price_base',
        'price_final',
        'extra',
        'comment',
        'supplier',
        'supplier_sku_prefix',
        'sku_article',
        'store_article',
        'store_sku',
        'store_visibility',
        'store_price',
        'store_supplier'
      ]);

      while (true) {
        // eslint-disable-next-line no-await-in-loop
        const chunk = await catalogAdmin.listComparePreview({
          limit: pageSize,
          offset,
          supplierId,
          search,
          missingOnly,
          store
        });

        for (let index = 0; index < chunk.rows.length; index += 1) {
          const row = chunk.rows[index] as Record<string, unknown>;
          writeCsvRow(res, [
            row.article,
            row.size,
            row.quantity,
            row.price_base,
            row.price_final,
            row.extra,
            row.comment,
            row.supplier_name,
            row.supplier_sku_prefix,
            row.sku_article,
            row.store_article,
            row.store_sku,
            row.store_visibility,
            row.store_price,
            row.store_supplier
          ]);
        }

        if (chunk.rows.length < pageSize) {
          break;
        }
        offset += pageSize;
      }

      res.end();
    } catch (err) {
      return res
        .status(readErrorStatus(err))
        .json({ error: readErrorMessage(err, 'compare_export_error') });
    }
  });

  app.post('/admin/api/store-import', authMw.requireRole('admin'), async (req: Request, res: Response) => {
    const supplier = typeof req.body?.supplier === 'string' ? req.body.supplier : null;
    try {
      const execution = await jobRunner.runStoreImport(supplier, readStoreImportRunOptions(req));
      const batchTotal = Array.isArray(execution.result.batch?.rows)
        ? execution.result.batch.rows.length
        : null;
      res.json({
        jobId: execution.jobId,
        store: appContext.connector.store,
        imported: execution.result.importResult.imported,
        skipped: execution.result.importResult.skipped,
        warnings: execution.result.importResult.warnings,
        total: execution.result.preview.total,
        previewTotal: execution.result.preview.total,
        batchTotal,
        batchMeta: execution.result.batch?.meta || null
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

  app.get('/admin/api/backend-readiness', authMw.requireRole('viewer'), async (req: Request, res: Response) => {
    try {
      const store = typeof req.query.store === 'string' ? req.query.store : 'cscart';
      const maxMirrorAgeMinutesRaw =
        typeof req.query.maxMirrorAgeMinutes === 'string'
          ? Number(req.query.maxMirrorAgeMinutes)
          : NaN;
      const maxMirrorAgeMinutes = Number.isFinite(maxMirrorAgeMinutesRaw)
        ? Math.max(1, Math.trunc(maxMirrorAgeMinutesRaw))
        : 120;
      const result = await catalogAdmin.getBackendReadiness({
        store,
        maxMirrorAgeMinutes
      });
      return res.json(result);
    } catch (err) {
      return res
        .status(readErrorStatus(err))
        .json({ error: readErrorMessage(err, 'backend_readiness_error') });
    }
  });

  app.get('/admin/api/cron-settings', authMw.requireRole('viewer'), async (_req: Request, res: Response) => {
    try {
      const settings = await schedulerSettings.listSettings();
      return res.json(settings);
    } catch (err) {
      return res
        .status(readErrorStatus(err))
        .json({ error: readErrorMessage(err, 'cron_settings_error') });
    }
  });

  app.put('/admin/api/cron-settings', authMw.requireRole('admin'), async (req: Request, res: Response) => {
    try {
      const settings = await schedulerSettings.updateSettings(req.body?.settings);
      return res.json(settings);
    } catch (err) {
      return res
        .status(readErrorStatus(err))
        .json({ error: readErrorMessage(err, 'cron_settings_update_error') });
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
      const { jobId, bgPromise } = await jobRunner.startImportAllAsync();
      // bgPromise handles its own errors internally; this is belt-and-suspenders.
      bgPromise.catch(() => undefined);
      res.json({ jobId });
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
      const { jobId, bgPromise } = await jobRunner.startFinalizeAsync();
      bgPromise.catch(() => undefined);
      res.json({ jobId });
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

  app.get('/admin/login', (req: Request, res: Response) => {
    const nextPath = normalizeAdminNextPath(req.query?.next, '/admin');
    if (req.userRole) {
      return res.redirect(302, nextPath);
    }
    return res.set('Content-Type', 'text/html; charset=utf-8').send(renderLoginPage(nextPath));
  });

  // Protected static admin UI
  app.use('/admin', requireAdminUiAuth, express.static(adminStaticPath));
  app.get('/admin/*', requireAdminUiAuth, (_req, res) => {
    res.sendFile(path.join(adminStaticPath, 'index.html'));
  });

  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));

  return app;
}
