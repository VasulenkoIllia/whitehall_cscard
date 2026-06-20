import type { Application, Request, Response } from 'express';
import {
  AppSettingsService,
  SETTING_ENRICHMENT_PROMPT,
  SETTING_ANTHROPIC_API_KEY,
  SETTING_DEEPSEEK_API_KEY,
  SETTING_EXCEL_EXCLUDED_COLUMNS,
  DEFAULT_EXCEL_EXCLUDED_COLUMNS
} from '../../../core/settings/AppSettingsService';
import { ENRICHMENT_SYSTEM_PROMPT } from '../../../core/ai/EnrichmentPrompt';
import type { createAuthMiddleware } from '../authMiddleware';

type AuthMiddleware = ReturnType<typeof createAuthMiddleware>;

interface SettingsRouteDeps {
  appSettingsService: AppSettingsService;
  authMw: AuthMiddleware;
  env: Record<string, string | undefined>;
}

const MAX_PROMPT_BYTES = 50 * 1024;

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

/** Конфіг провайдерів AI-ключів для узагальнених роутів /settings/ai-key/:provider. */
interface KeyProviderConfig {
  setting: string;
  envVar: string;
  prefix: RegExp;
  prefixHint: string;
  get: (svc: AppSettingsService) => Promise<string | null>;
}
const KEY_PROVIDERS: Record<string, KeyProviderConfig> = {
  anthropic: {
    setting: SETTING_ANTHROPIC_API_KEY,
    envVar: 'ANTHROPIC_API_KEY',
    prefix: /^sk-ant-/,
    prefixHint: 'sk-ant-',
    get: (svc) => svc.getAnthropicApiKey()
  },
  deepseek: {
    setting: SETTING_DEEPSEEK_API_KEY,
    envVar: 'DEEPSEEK_API_KEY',
    prefix: /^sk-/,
    prefixHint: 'sk-',
    get: (svc) => svc.getDeepseekApiKey()
  }
};

async function keyStatus(
  svc: AppSettingsService,
  cfg: KeyProviderConfig,
  env: Record<string, string | undefined>
): Promise<{ configured: boolean; source: 'db' | 'env' | null; masked: string | null }> {
  const dbKey = await cfg.get(svc);
  const envKey = (env[cfg.envVar] || '').trim();
  const active = dbKey || envKey || null;
  return {
    configured: Boolean(active),
    source: dbKey ? 'db' : envKey ? 'env' : null,
    masked: active ? `••••${active.slice(-4)}` : null
  };
}

export function registerSettingsRoutes(app: Application, deps: SettingsRouteDeps): void {
  const { appSettingsService, authMw, env } = deps;

  // ─── AI API keys (узагальнено: anthropic + deepseek) ────────────────────────

  // GET — статус усіх провайдерів (тільки маска + джерело, ніколи повний ключ).
  app.get(
    '/admin/api/settings/ai-keys',
    authMw.requireRole('admin'),
    async (_req: Request, res: Response) => {
      try {
        const out: Record<string, unknown> = {};
        for (const [name, cfg] of Object.entries(KEY_PROVIDERS)) {
          out[name] = await keyStatus(appSettingsService, cfg, env);
        }
        res.json(out);
      } catch (err) {
        res.status(readErrorStatus(err)).json({ error: readErrorMessage(err, 'settings_keys_error') });
      }
    }
  );

  // PUT — зберегти ключ конкретного провайдера.
  app.put(
    '/admin/api/settings/ai-key/:provider',
    authMw.requireRole('admin'),
    async (req: Request, res: Response) => {
      try {
        const cfg = KEY_PROVIDERS[String(req.params.provider)];
        if (!cfg) {
          res.status(404).json({ error: 'Невідомий провайдер (anthropic | deepseek)' });
          return;
        }
        const raw = req.body?.apiKey;
        const apiKey = typeof raw === 'string' ? raw.trim() : '';
        if (!apiKey) {
          res.status(400).json({ error: 'apiKey порожній' });
          return;
        }
        if (!cfg.prefix.test(apiKey)) {
          res.status(400).json({ error: `Ключ має починатися з ${cfg.prefixHint}` });
          return;
        }
        await appSettingsService.set(cfg.setting, apiKey);
        res.json({ configured: true, source: 'db', masked: `••••${apiKey.slice(-4)}` });
      } catch (err) {
        res.status(readErrorStatus(err)).json({ error: readErrorMessage(err, 'settings_key_save_error') });
      }
    }
  );

  // DELETE — прибрати DB-ключ провайдера (повернутись до env).
  app.delete(
    '/admin/api/settings/ai-key/:provider',
    authMw.requireRole('admin'),
    async (req: Request, res: Response) => {
      try {
        const cfg = KEY_PROVIDERS[String(req.params.provider)];
        if (!cfg) {
          res.status(404).json({ error: 'Невідомий провайдер (anthropic | deepseek)' });
          return;
        }
        await appSettingsService.delete(cfg.setting);
        res.json(await keyStatus(appSettingsService, cfg, env));
      } catch (err) {
        res.status(readErrorStatus(err)).json({ error: readErrorMessage(err, 'settings_key_delete_error') });
      }
    }
  );

  // ─── Enrichment prompt ──────────────────────────────────────────────────────

  // GET — поточний промпт (кастомний або default) + default для порівняння.
  app.get(
    '/admin/api/settings/enrichment-prompt',
    authMw.requireRole('viewer'),
    async (_req: Request, res: Response) => {
      try {
        const setting = await appSettingsService.getEnrichmentPrompt();
        res.json({
          prompt: setting.prompt,
          isCustom: setting.isCustom,
          version: setting.version,
          defaultPrompt: ENRICHMENT_SYSTEM_PROMPT
        });
      } catch (err) {
        res.status(readErrorStatus(err)).json({ error: readErrorMessage(err, 'settings_prompt_error') });
      }
    }
  );

  // PUT — зберегти кастомний промпт. Порожній/null = скинути до default.
  app.put(
    '/admin/api/settings/enrichment-prompt',
    authMw.requireRole('admin'),
    async (req: Request, res: Response) => {
      try {
        const raw = req.body?.prompt;
        const prompt = typeof raw === 'string' ? raw.trim() : '';
        if (prompt.length === 0) {
          await appSettingsService.delete(SETTING_ENRICHMENT_PROMPT);
        } else {
          if (Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_BYTES) {
            res.status(400).json({ error: `Промпт завеликий (макс ${MAX_PROMPT_BYTES / 1024} KB)` });
            return;
          }
          await appSettingsService.set(SETTING_ENRICHMENT_PROMPT, prompt);
        }
        const setting = await appSettingsService.getEnrichmentPrompt();
        res.json({ prompt: setting.prompt, isCustom: setting.isCustom, version: setting.version });
      } catch (err) {
        res.status(readErrorStatus(err)).json({ error: readErrorMessage(err, 'settings_prompt_save_error') });
      }
    }
  );

  // ─── Anthropic API key ──────────────────────────────────────────────────────

  // GET — тільки маска + джерело. Повний ключ ніколи не повертається.
  app.get(
    '/admin/api/settings/anthropic-key',
    authMw.requireRole('admin'),
    async (_req: Request, res: Response) => {
      try {
        const dbKey = await appSettingsService.getAnthropicApiKey();
        const envKey = (env.ANTHROPIC_API_KEY || '').trim();
        const active = dbKey || envKey || null;
        res.json({
          configured: Boolean(active),
          source: dbKey ? 'db' : envKey ? 'env' : null,
          masked: active ? `••••${active.slice(-4)}` : null
        });
      } catch (err) {
        res.status(readErrorStatus(err)).json({ error: readErrorMessage(err, 'settings_key_error') });
      }
    }
  );

  // PUT — зберегти власний ключ (пріоритет над env).
  app.put(
    '/admin/api/settings/anthropic-key',
    authMw.requireRole('admin'),
    async (req: Request, res: Response) => {
      try {
        const raw = req.body?.apiKey;
        const apiKey = typeof raw === 'string' ? raw.trim() : '';
        if (!apiKey) {
          res.status(400).json({ error: 'apiKey порожній' });
          return;
        }
        if (!/^sk-ant-/.test(apiKey)) {
          res.status(400).json({ error: 'Ключ має починатися з sk-ant-' });
          return;
        }
        await appSettingsService.set(SETTING_ANTHROPIC_API_KEY, apiKey);
        res.json({ configured: true, source: 'db', masked: `••••${apiKey.slice(-4)}` });
      } catch (err) {
        res.status(readErrorStatus(err)).json({ error: readErrorMessage(err, 'settings_key_save_error') });
      }
    }
  );

  // DELETE — прибрати DB-ключ (повернутись до env).
  app.delete(
    '/admin/api/settings/anthropic-key',
    authMw.requireRole('admin'),
    async (_req: Request, res: Response) => {
      try {
        await appSettingsService.delete(SETTING_ANTHROPIC_API_KEY);
        const envKey = (env.ANTHROPIC_API_KEY || '').trim();
        res.json({
          configured: envKey.length > 0,
          source: envKey ? 'env' : null,
          masked: envKey ? `••••${envKey.slice(-4)}` : null
        });
      } catch (err) {
        res.status(readErrorStatus(err)).json({ error: readErrorMessage(err, 'settings_key_delete_error') });
      }
    }
  );

  // ─── Excel import excluded columns ──────────────────────────────────────────

  app.get(
    '/admin/api/settings/excel-excluded-columns',
    authMw.requireRole('admin'),
    async (_req: Request, res: Response) => {
      try {
        const { columns, isCustom } = await appSettingsService.getExcelExcludedColumns();
        res.json({ columns, isCustom, defaultColumns: DEFAULT_EXCEL_EXCLUDED_COLUMNS });
      } catch (err) {
        res.status(readErrorStatus(err)).json({ error: readErrorMessage(err, 'settings_excel_error') });
      }
    }
  );

  app.put(
    '/admin/api/settings/excel-excluded-columns',
    authMw.requireRole('admin'),
    async (req: Request, res: Response) => {
      try {
        const raw = req.body?.columns;
        if (!Array.isArray(raw)) {
          res.status(400).json({ error: 'columns має бути масивом рядків' });
          return;
        }
        const columns = (raw as unknown[])
          .filter((x): x is string => typeof x === 'string')
          .map((x) => x.trim())
          .filter((x) => x.length > 0);
        await appSettingsService.set(SETTING_EXCEL_EXCLUDED_COLUMNS, null, columns);
        res.json({ columns, isCustom: true });
      } catch (err) {
        res.status(readErrorStatus(err)).json({ error: readErrorMessage(err, 'settings_excel_save_error') });
      }
    }
  );
}
