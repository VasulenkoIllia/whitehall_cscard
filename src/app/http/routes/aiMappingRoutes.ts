/**
 * Routes для AI-mapping wizard.
 *
 *   POST /admin/api/ai-mapping/analyze-tabs
 *        body: { supplierId, sheetUrl }
 *        → { analysisId, spreadsheetId, tabs: [...], modelVersion, tokens, durationMs }
 *
 *   POST /admin/api/ai-mapping/suggest
 *        body: { supplierId, sheetUrl, tabName, sourceId? }
 *        → { suggestionId, modelVersion, result: {...}, tokens, durationMs }
 *
 *   GET  /admin/api/ai-mapping/pending?supplierId=&sourceId=&tabName=
 *        → null | { id, headerRow, mapping, warnings, ... }
 *
 *   POST /admin/api/ai-mapping/suggestions/:id/review
 *        body: { status: 'approved'|'rejected'|'edited', appliedMapping?, notes? }
 *        → { ok: true }
 *
 *   GET  /admin/api/ai-mapping/analyses?supplierId=&limit=
 *        → { rows: [...] }
 *
 *   GET  /admin/api/ai-mapping/status
 *        → { enabled: bool, models: { mapping, tabAnalyzer } }
 */

import type { Application, Request, Response } from 'express';
import type { AiMappingService } from '../../../core/ai/AiMappingService';
import type { createAuthMiddleware } from '../authMiddleware';

type AuthMiddleware = ReturnType<typeof createAuthMiddleware>;

interface AiMappingRouteDeps {
  aiMappingService: AiMappingService;
  authMw: AuthMiddleware;
  env: Record<string, string | undefined>;
}

function readErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}
function readErrorStatus(err: unknown, fallback = 500): number {
  if (typeof err === 'object' && err !== null && Number.isFinite((err as { status?: number }).status)) {
    return Number((err as { status?: number }).status);
  }
  return fallback;
}
function parsePositiveInt(value: unknown): number | null {
  if (value === null || typeof value === 'undefined' || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.trunc(n);
}
function parseString(value: unknown): string | null {
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  return null;
}

export function registerAiMappingRoutes(app: Application, deps: AiMappingRouteDeps): void {
  const { aiMappingService, authMw, env } = deps;

  // Статус сервісу — чи доступне AI взагалі (показуємо у UI кнопку enabled/disabled).
  app.get(
    '/admin/api/ai-mapping/status',
    authMw.requireRole('viewer'),
    (_req: Request, res: Response) => {
      res.json({
        enabled: aiMappingService.isEnabled(),
        models: {
          mapping: env.ANTHROPIC_MODEL_MAPPING || 'claude-sonnet-4-5',
          tabAnalyzer: env.ANTHROPIC_MODEL_TAB_ANALYZER || 'claude-haiku-4-5'
        }
      });
    }
  );

  // Phase 1: tab analyzer.
  app.post(
    '/admin/api/ai-mapping/analyze-tabs',
    authMw.requireRole('admin'),
    async (req: Request, res: Response) => {
      try {
        const supplierId = parsePositiveInt(req.body?.supplierId);
        const sheetUrl = parseString(req.body?.sheetUrl);
        if (!supplierId) {
          res.status(400).json({ error: 'supplierId обовʼязковий' });
          return;
        }
        if (!sheetUrl) {
          res.status(400).json({ error: 'sheetUrl обовʼязковий' });
          return;
        }
        const result = await aiMappingService.analyzeTabs({ supplierId, sheetUrl });
        res.json(result);
      } catch (err) {
        res.status(readErrorStatus(err)).json({
          error: readErrorMessage(err, 'analyze_tabs_error')
        });
      }
    }
  );

  // Phase 2: mapping suggester.
  app.post(
    '/admin/api/ai-mapping/suggest',
    authMw.requireRole('admin'),
    async (req: Request, res: Response) => {
      try {
        const supplierId = parsePositiveInt(req.body?.supplierId);
        const sheetUrl = parseString(req.body?.sheetUrl);
        const tabName = parseString(req.body?.tabName);
        const sourceId = parsePositiveInt(req.body?.sourceId);
        if (!supplierId || !sheetUrl || !tabName) {
          res.status(400).json({ error: 'supplierId, sheetUrl, tabName обовʼязкові' });
          return;
        }
        const result = await aiMappingService.suggestMapping({
          supplierId,
          sheetUrl,
          tabName,
          sourceId
        });
        res.json(result);
      } catch (err) {
        res.status(readErrorStatus(err)).json({
          error: readErrorMessage(err, 'suggest_mapping_error')
        });
      }
    }
  );

  // Read останній pending.
  app.get(
    '/admin/api/ai-mapping/pending',
    authMw.requireRole('viewer'),
    async (req: Request, res: Response) => {
      try {
        const supplierId = parsePositiveInt(req.query?.supplierId);
        if (!supplierId) {
          res.status(400).json({ error: 'supplierId обовʼязковий' });
          return;
        }
        const sourceId = parsePositiveInt(req.query?.sourceId);
        const tabName = parseString(req.query?.tabName);
        const result = await aiMappingService.getPendingSuggestion({
          supplierId,
          sourceId,
          tabName: tabName ?? undefined
        });
        res.json(result || null);
      } catch (err) {
        res.status(readErrorStatus(err)).json({
          error: readErrorMessage(err, 'get_pending_error')
        });
      }
    }
  );

  // Approve / reject / edit.
  app.post(
    '/admin/api/ai-mapping/suggestions/:id/review',
    authMw.requireRole('admin'),
    async (req: Request, res: Response) => {
      try {
        const suggestionId = parsePositiveInt(req.params?.id);
        if (!suggestionId) {
          res.status(400).json({ error: 'suggestionId обовʼязковий' });
          return;
        }
        const status = parseString(req.body?.status);
        if (status !== 'approved' && status !== 'rejected' && status !== 'edited') {
          res.status(400).json({ error: 'status має бути approved|rejected|edited' });
          return;
        }
        const appliedMapping =
          req.body?.appliedMapping && typeof req.body.appliedMapping === 'object'
            ? (req.body.appliedMapping as Record<string, unknown>)
            : null;
        await aiMappingService.markSuggestionReviewed({
          suggestionId,
          status,
          appliedMapping: appliedMapping as never,
          reviewerId: (req as { userId?: string }).userId ?? null,
          notes: parseString(req.body?.notes)
        });
        res.json({ ok: true });
      } catch (err) {
        res.status(readErrorStatus(err)).json({
          error: readErrorMessage(err, 'review_suggestion_error')
        });
      }
    }
  );

  // Історія аналізів tabs (для UI).
  app.get(
    '/admin/api/ai-mapping/analyses',
    authMw.requireRole('viewer'),
    async (req: Request, res: Response) => {
      try {
        const supplierId = parsePositiveInt(req.query?.supplierId);
        if (!supplierId) {
          res.status(400).json({ error: 'supplierId обовʼязковий' });
          return;
        }
        const limit = parsePositiveInt(req.query?.limit) || 5;
        const rows = await aiMappingService.listTabAnalyses({ supplierId, limit });
        res.json({ rows });
      } catch (err) {
        res.status(readErrorStatus(err)).json({
          error: readErrorMessage(err, 'list_analyses_error')
        });
      }
    }
  );
}
