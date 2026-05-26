import type { Application, Request, Response } from 'express';
import type {
  FeedService,
  FeedCreatePayload,
  FeedUpdatePayload
} from '../../../core/feeds/FeedService';
import type { PipelineJobRunner } from '../../../core/jobs/PipelineJobRunner';
import type { createAuthMiddleware } from '../authMiddleware';

type AuthMiddleware = ReturnType<typeof createAuthMiddleware>;

interface FeedRouteDeps {
  feedService: FeedService;
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

export function registerFeedRoutes(app: Application, deps: FeedRouteDeps): void {
  const { feedService, jobRunner, authMw } = deps;

  // LIST feeds.
  app.get(
    '/admin/api/feeds',
    authMw.requireRole('viewer'),
    async (_req: Request, res: Response) => {
      try {
        const rows = await feedService.list();
        res.json({ rows });
      } catch (err) {
        res.status(readErrorStatus(err)).json({ error: readErrorMessage(err, 'feeds_list_error') });
      }
    }
  );

  // CREATE feed.
  app.post(
    '/admin/api/feeds',
    authMw.requireRole('admin'),
    async (req: Request, res: Response) => {
      try {
        const payload = req.body as FeedCreatePayload;
        const row = await feedService.create(payload);
        res.json(row);
      } catch (err) {
        res.status(readErrorStatus(err, 400)).json({ error: readErrorMessage(err, 'feeds_create_error') });
      }
    }
  );

  // UPDATE feed.
  app.put(
    '/admin/api/feeds/:id',
    authMw.requireRole('admin'),
    async (req: Request, res: Response) => {
      try {
        const id = parsePositiveInt(req.params.id);
        if (!id) {
          res.status(400).json({ error: 'id обовʼязковий' });
          return;
        }
        const payload = req.body as FeedUpdatePayload;
        const row = await feedService.update(id, payload);
        res.json(row);
      } catch (err) {
        res.status(readErrorStatus(err, 400)).json({ error: readErrorMessage(err, 'feeds_update_error') });
      }
    }
  );

  // DELETE feed.
  app.delete(
    '/admin/api/feeds/:id',
    authMw.requireRole('admin'),
    async (req: Request, res: Response) => {
      try {
        const id = parsePositiveInt(req.params.id);
        if (!id) {
          res.status(400).json({ error: 'id обовʼязковий' });
          return;
        }
        await feedService.delete(id);
        res.json({ ok: true });
      } catch (err) {
        res.status(readErrorStatus(err)).json({ error: readErrorMessage(err, 'feeds_delete_error') });
      }
    }
  );

  // TRIGGER import.
  app.post(
    '/admin/api/jobs/feed-import',
    authMw.requireRole('admin'),
    async (req: Request, res: Response) => {
      try {
        const feedId = parsePositiveInt(req.body?.feedId);
        if (!feedId) {
          res.status(400).json({ error: 'feedId обовʼязковий' });
          return;
        }
        const result = await jobRunner.runFeedImport(feedId);
        res.json({ jobId: result.jobId, result: result.result });
      } catch (err) {
        res.status(readErrorStatus(err)).json({ error: readErrorMessage(err, 'feed_import_error') });
      }
    }
  );

  // LIST import runs per feed.
  app.get(
    '/admin/api/feeds/:id/imports',
    authMw.requireRole('viewer'),
    async (req: Request, res: Response) => {
      try {
        const id = parsePositiveInt(req.params.id);
        if (!id) {
          res.status(400).json({ error: 'id обовʼязковий' });
          return;
        }
        const limit = parsePositiveInt(req.query.limit) || 10;
        const rows = await feedService.listImportRuns(id, limit);
        res.json({ rows });
      } catch (err) {
        res.status(readErrorStatus(err)).json({ error: readErrorMessage(err, 'feeds_imports_error') });
      }
    }
  );
}
