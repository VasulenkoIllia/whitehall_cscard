/**
 * Тонкий wrapper над Anthropic Messages API через fetch (без @anthropic-ai/sdk —
 * мінус 1 deps, простіше тримати під контролем). Підтримує лише те, що нам треба:
 *   * messages.create з system prompt + 1 user message
 *   * JSON-only output (за допомогою stop_sequence + parse fallback)
 *   * retry на 429/5xx з exponential backoff
 *
 * Налаштування через ENV:
 *   ANTHROPIC_API_KEY            — обов'язково. Без нього клієнт у "disabled" mode.
 *   ANTHROPIC_API_BASE           — за замовч 'https://api.anthropic.com/v1'
 *   ANTHROPIC_MODEL_MAPPING      — за замовч 'claude-sonnet-4-5' (для column mapping)
 *   ANTHROPIC_MODEL_TAB_ANALYZER — за замовч 'claude-haiku-4-5' (для tab-analyzer)
 *   ANTHROPIC_MAX_RETRIES        — за замовч 3
 *   ANTHROPIC_TIMEOUT_MS         — за замовч 60000 (1 хв на один call)
 *
 * Чому ці моделі:
 *   * Sonnet 4.5 — потужність достатня для аналізу 67 колонок з sample rows.
 *     ~$3/MTok input, $15/MTok output. Per-supplier call: ~$0.05-0.10.
 *   * Haiku 4.5 — простіша задача "is_catalog true/false" на 5-20 tabs.
 *     ~$1/MTok input, $5/MTok output. Per-file call: ~$0.01-0.02.
 *   * Опціонально все можна перемкнути на Sonnet через env (якщо Haiku десь даватиме збої).
 */

import fetch from 'node-fetch';

export interface AnthropicClientOptions {
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
  maxRetries?: number;
  timeoutMs?: number;
}

export interface AnthropicMessageParams {
  model: string;
  systemPrompt: string;
  userMessage: string;
  maxTokens?: number;
  temperature?: number;
  /**
   * Якщо true — додаємо JSON-only inструкцію в system prompt + парсимо output як JSON.
   * Викидає Error якщо response не валідний JSON.
   */
  jsonOutput?: boolean;
}

export interface AnthropicMessageResult<T = unknown> {
  /** Розпарсений JSON або сирий текст (якщо jsonOutput=false). */
  content: T;
  rawText: string;
  modelVersion: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  /** Повна відповідь API (для зберігання у БД для дебагу). */
  rawResponse: unknown;
}

export interface AnthropicClient {
  isEnabled(): boolean;
  send<T = unknown>(params: AnthropicMessageParams): Promise<AnthropicMessageResult<T>>;
}

export function createAnthropicClient(env: Record<string, string | undefined>): AnthropicClient {
  const apiKey = (env.ANTHROPIC_API_KEY || '').trim();
  const baseUrl = (env.ANTHROPIC_API_BASE || 'https://api.anthropic.com/v1').replace(/\/$/, '');
  const maxRetries = parsePositiveInt(env.ANTHROPIC_MAX_RETRIES) ?? 3;
  const timeoutMs = parsePositiveInt(env.ANTHROPIC_TIMEOUT_MS) ?? 60_000;

  const enabled = apiKey.length > 0;

  return {
    isEnabled: () => enabled,
    async send<T = unknown>(params: AnthropicMessageParams): Promise<AnthropicMessageResult<T>> {
      if (!enabled) {
        throw new AnthropicError(
          501,
          'ANTHROPIC_API_KEY не задано — AI mapping недоступний'
        );
      }

      const requestBody: Record<string, unknown> = {
        model: params.model,
        max_tokens: params.maxTokens ?? 4096,
        temperature: params.temperature ?? 0,
        system: buildSystemPrompt(params.systemPrompt, params.jsonOutput === true),
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

export class AnthropicError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'AnthropicError';
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

interface AnthropicApiResponse {
  id?: string;
  model?: string;
  content?: Array<{ type: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
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
    '6. Numbers as numbers (not strings) when the schema expects numbers.',
    '7. If you are uncertain about a field, return null + a "reasoning" explaining why.'
  ].join('\n');
}

function parseJsonStrict<T>(raw: string): T {
  // Remove markdown fences if model still added them.
  let text = raw.trim();
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  }
  // Sometimes models prepend "Here is the JSON:" — strip leading non-{ chars.
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
