/**
 * AnthropicClient — fetch wrapper над Anthropic Messages API.
 *
 * ENV:
 *   ANTHROPIC_API_KEY           — fallback ключ. Runtime ключ з app_settings
 *                                 (через keyProvider) має пріоритет.
 *   ANTHROPIC_API_BASE          — default 'https://api.anthropic.com/v1'
 *   ANTHROPIC_MODEL_ENRICHMENT  — default 'claude-haiku-4-5'
 *   ANTHROPIC_MAX_RETRIES       — default 3
 *   ANTHROPIC_TIMEOUT_MS        — default 180000 (3 хв)
 */

import fetch from 'node-fetch';

export interface AnthropicMessageParams {
  model: string;
  systemPrompt: string;
  userMessage: string;
  maxTokens?: number;
  temperature?: number;
  /** Якщо true — system prompt доповнюється JSON-only інструкцією + парсимо output як JSON. */
  jsonOutput?: boolean;
}

export interface AnthropicMessageResult<T = unknown> {
  content: T;
  rawText: string;
  modelVersion: string;
  inputTokens: number;
  outputTokens: number;
  /** Токени, записані в кеш цим запитом (~1.25× ціни). */
  cacheCreationInputTokens: number;
  /** Токени, прочитані з кешу (~0.1× ціни). */
  cacheReadInputTokens: number;
  durationMs: number;
  rawResponse: unknown;
}

export class AnthropicError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'AnthropicError';
  }
}

export interface AnthropicClient {
  isEnabled(): boolean;
  send<T = unknown>(params: AnthropicMessageParams): Promise<AnthropicMessageResult<T>>;
}

/** Повертає runtime API ключ (з БД) або null — тоді береться env ANTHROPIC_API_KEY. */
export type AnthropicKeyProvider = () => Promise<string | null>;

export function createAnthropicClient(
  env: Record<string, string | undefined>,
  keyProvider?: AnthropicKeyProvider
): AnthropicClient {
  const envApiKey = (env.ANTHROPIC_API_KEY || '').trim();
  const baseUrl = (env.ANTHROPIC_API_BASE || 'https://api.anthropic.com/v1').replace(/\/$/, '');
  const maxRetries = parsePositiveInt(env.ANTHROPIC_MAX_RETRIES) ?? 3;
  const timeoutMs = parsePositiveInt(env.ANTHROPIC_TIMEOUT_MS) ?? 180_000;

  // Ключ з БД (keyProvider) має пріоритет; env — fallback. Резолвиться при
  // кожному send(), щоб зміна ключа з фронта діяла без рестарту.
  const resolveApiKey = async (): Promise<string> => {
    const dbKey = keyProvider ? (await keyProvider().catch(() => null))?.trim() : null;
    const apiKey = dbKey || envApiKey;
    if (!apiKey) {
      throw new AnthropicError(501, 'Anthropic API ключ не задано (ні в налаштуваннях, ні в env) — AI недоступний');
    }
    return apiKey;
  };

  const enabled = envApiKey.length > 0 || Boolean(keyProvider);

  return {
    isEnabled: () => enabled,

    async send<T = unknown>(params: AnthropicMessageParams): Promise<AnthropicMessageResult<T>> {
      const apiKey = await resolveApiKey();

      // System як один статичний блок з cache_control — кешується (prompt caching).
      // Дані товару — в user-повідомленні (волатильне, після breakpoint).
      const requestBody: Record<string, unknown> = {
        model: params.model,
        max_tokens: params.maxTokens ?? 4096,
        temperature: params.temperature ?? 0,
        system: [
          {
            type: 'text',
            text: buildSystemPrompt(params.systemPrompt, params.jsonOutput === true),
            cache_control: { type: 'ephemeral' }
          }
        ],
        messages: [{ role: 'user', content: params.userMessage }]
      };

      let lastError: unknown = null;
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        const startedAt = Date.now();
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeoutMs);

          const res = await fetch(`${baseUrl}/messages`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-api-key': apiKey,
              'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify(requestBody),
            signal: controller.signal as unknown as AbortSignal
          }).finally(() => clearTimeout(timer));

          const durationMs = Date.now() - startedAt;

          if (res.status === 429 || res.status >= 500) {
            const text = await res.text().catch(() => '');
            lastError = new AnthropicError(res.status, `Anthropic ${res.status}: ${text.slice(0, 300)}`);
            if (attempt < maxRetries) {
              await sleep(backoffMs(attempt));
              continue;
            }
            throw lastError;
          }

          if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new AnthropicError(res.status, `Anthropic ${res.status}: ${text.slice(0, 500)}`);
          }

          const payload = (await res.json()) as AnthropicApiResponse;
          const rawText = extractText(payload);
          const inputTokens = payload?.usage?.input_tokens ?? 0;
          const outputTokens = payload?.usage?.output_tokens ?? 0;

          let content: T;
          if (params.jsonOutput) {
            content = parseJsonStrict<T>(rawText);
          } else {
            content = rawText as unknown as T;
          }

          return {
            content,
            rawText,
            modelVersion: payload?.model || params.model,
            inputTokens,
            outputTokens,
            cacheCreationInputTokens: payload?.usage?.cache_creation_input_tokens ?? 0,
            cacheReadInputTokens: payload?.usage?.cache_read_input_tokens ?? 0,
            durationMs,
            rawResponse: payload
          };
        } catch (err) {
          lastError = err;
          if (attempt < maxRetries && isRetryable(err)) {
            await sleep(backoffMs(attempt));
            continue;
          }
          throw err;
        }
      }
      throw lastError ?? new AnthropicError(500, 'Anthropic call failed');
    }
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface AnthropicApiResponse {
  id?: string;
  model?: string;
  content?: Array<{ type: string; text?: string }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

function extractText(payload: AnthropicApiResponse): string {
  const blocks = payload?.content || [];
  return blocks
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text || '')
    .join('\n')
    .trim();
}

function buildSystemPrompt(base: string, jsonOnly: boolean): string {
  if (!jsonOnly) return base;
  return [
    base.trim(),
    '',
    'CRITICAL OUTPUT RULES:',
    '1. Your entire response MUST be a single valid JSON object.',
    '2. No prose before or after the JSON.',
    '3. No markdown code fences (no ```json wrappers).',
    '4. No comments inside JSON.',
    '5. Use double quotes for all strings.',
    '6. If you are uncertain about a field, return null + a "reasoning" explaining why.'
  ].join('\n');
}

function parseJsonStrict<T>(raw: string): T {
  let text = raw.trim();
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  }
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace > 0 && lastBrace > firstBrace) {
    text = text.slice(firstBrace, lastBrace + 1);
  }
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new AnthropicError(
      502,
      `AI повернув невалідний JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

function isRetryable(err: unknown): boolean {
  if (err instanceof AnthropicError) {
    return err.status === 429 || err.status >= 500;
  }
  if (err instanceof Error && /aborted|ETIMEDOUT|ECONNRESET|ENOTFOUND/i.test(err.message)) {
    return true;
  }
  return false;
}

function backoffMs(attempt: number): number {
  return Math.min(8000, 500 * Math.pow(2, attempt - 1));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePositiveInt(value: unknown): number | null {
  if (value === null || typeof value === 'undefined') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.trunc(n);
}
