import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'path';
import type { Application as AppContext } from '../createApplication';
import type { Request, Response } from 'express';
import { createAuthMiddleware } from './authMiddleware';
import { renderLoginPage } from './loginPage';

export function createHttpServer(appContext: AppContext) {
  const app = express();
  const auth = appContext.auth;
  const authMw = createAuthMiddleware(auth);
  const pipeline = appContext.pipeline;
  const jobs = appContext.jobService;
  const jobRunner = appContext.jobRunner;
  const logs = appContext.logService;
  const adminStaticPath = path.join(__dirname, '..', '..', 'public', 'admin');

  const parseLimit = (value: unknown, fallback: number): number => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      return fallback;
    }
    return Math.max(1, Math.min(200, Math.trunc(numeric)));
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
      const execution = await jobRunner.runStoreImport(supplier);
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
      const result = await jobRunner.runStoreImport(supplier);
      res.json(result);
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
        res.json(result);
      } catch (err) {
        res
          .status(readErrorStatus(err))
          .json({ error: readErrorMessage(err, 'update_pipeline_error') });
      }
    }
  );

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
        if (job.type === 'update_pipeline') {
          const childJobs = await jobs.listChildJobs(jobId);
          for (let index = 0; index < childJobs.length; index += 1) {
            const child = childJobs[index];
            if (child.status !== 'running' && child.status !== 'queued') {
              continue;
            }
            await jobs.cancelJob(child.id, `Canceled with parent pipeline #${jobId}`);
            canceledChildren.push(child.id);
            await logs.log(child.id, 'error', 'Job canceled', {
              reason: `Canceled with parent pipeline #${jobId}`,
              parentPipelineJobId: jobId
            });
          }
        }

        const canceled = await jobs.cancelJob(jobId, reason);
        await logs.log(jobId, 'error', 'Job canceled', {
          reason,
          childCanceled: canceledChildren
        });

        return res.json({
          job: canceled,
          childCanceled: canceledChildren
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
