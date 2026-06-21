/**
 * DeepseekClient — fetch wrapper над DeepSeek API (OpenAI-сумісний).
 *
 * Реалізує той самий контракт, що й AnthropicClient (isEnabled/send), тому
 * EnrichmentService працює з ним через createAiRouter без жодних змін.
 *
 * Відмінності від Anthropic:
 *   - endpoint POST {base}/chat/completions, заголовок Authorization: Bearer.
 *   - system/user — це messages[0]/messages[1] (OpenAI-формат).
 *   - JSON-режим: response_format:{type:'json_object'} (потрібне слово «json»
 *     у промпті + приклад — у ENRICHMENT_SYSTEM_PROMPT вони є).
 *   - Кешування АВТОМАТИЧНЕ: usage повертає prompt_cache_hit_tokens /
 *     prompt_cache_miss_tokens; cache-hit тарифікується дешевше. Окремого
 *     «запису в кеш» (як ephemeral у Anthropic) немає → cacheCreation = 0.
 *   - DeepSeek інколи повертає порожній content — трактуємо як retryable.
 *
 * ENV:
 *   DEEPSEEK_API_KEY      — fallback ключ. Runtime ключ з app_settings має пріоритет.
 *   DEEPSEEK_API_BASE     — default 'https://api.deepseek.com'
 *   DEEPSEEK_MAX_RETRIES  — default 3
 *   DEEPSEEK_TIMEOUT_MS   — default 180000 (3 хв)
 */

import fetch from 'node-fetch';
import {
  AnthropicClient,
  AnthropicMessageParams,
  AnthropicMessageResult,
  AnthropicKeyProvider,
  buildSystemPrompt,
  parseJsonStrict
} from './AnthropicClient';

export class DeepseekError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'DeepseekError';
  }
}

export function createDeepseekClient(
  env: Record<string, string | undefined>,
  keyProvider?: AnthropicKeyProvider
): AnthropicClient {
  const envApiKey = (env.DEEPSEEK_API_KEY || '').trim();
  const baseUrl = (env.DEEPSEEK_API_BASE || 'https://api.deepseek.com').replace(/\/$/, '');
  const maxRetries = parsePositiveInt(env.DEEPSEEK_MAX_RETRIES) ?? 3;
  const timeoutMs = parsePositiveInt(env.DEEPSEEK_TIMEOUT_MS) ?? 180_000;

  const resolveApiKey = async (): Promise<string> => {
    const dbKey = keyProvider ? (await keyProvider().catch(() => null))?.trim() : null;
    const apiKey = dbKey || envApiKey;
    if (!apiKey) {
      throw new DeepseekError(501, 'DeepSeek API ключ не задано (ні в налаштуваннях, ні в env) — модель недоступна');
    }
    return apiKey;
  };

  const enabled = envApiKey.length > 0 || Boolean(keyProvider);

  return {
    isEnabled: () => enabled,

    async send<T = unknown>(params: AnthropicMessageParams): Promise<AnthropicMessageResult<T>> {
      const apiKey = await resolveApiKey();

      const requestBody: Record<string, unknown> = {
        model: params.model,
        max_tokens: params.maxTokens ?? 4096,
        temperature: params.temperature ?? 0,
        messages: [
          { role: 'system', content: buildSystemPrompt(params.systemPrompt, params.jsonOutput === true) },
          { role: 'user', content: params.userMessage }
        ]
      };
      if (params.jsonOutput) {
        requestBody.response_format = { type: 'json_object' };
      }

      let lastError: unknown = null;
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        const startedAt = Date.now();
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeoutMs);

          const res = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${apiKey}`
            },
            body: JSON.stringify(requestBody),
            signal: controller.signal as unknown as AbortSignal
          }).finally(() => clearTimeout(timer));

          const durationMs = Date.now() - startedAt;

          if (res.status === 429 || res.status >= 500) {
            const text = await res.text().catch(() => '');
            lastError = new DeepseekError(res.status, `DeepSeek ${res.status}: ${text.slice(0, 300)}`);
            if (attempt < maxRetries) {
              await sleep(backoffMs(attempt));
              continue;
            }
            throw lastError;
          }

          if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new DeepseekError(res.status, `DeepSeek ${res.status}: ${text.slice(0, 500)}`);
          }

          const payload = (await res.json()) as DeepseekApiResponse;
          const rawText = (payload?.choices?.[0]?.message?.content || '').trim();

          // DeepSeek інколи повертає порожній content — retry (відома проблема API).
          if (!rawText) {
            lastError = new DeepseekError(502, 'DeepSeek повернув порожній content');
            if (attempt < maxRetries) {
              await sleep(backoffMs(attempt));
              continue;
            }
            throw lastError;
          }

          const usage = payload?.usage || {};
          const cacheRead = usage.prompt_cache_hit_tokens ?? 0;
          // Некешований input: явний cache_miss або (prompt - hit).
          const inputTokens =
            usage.prompt_cache_miss_tokens ??
            Math.max(0, (usage.prompt_tokens ?? 0) - cacheRead);
          const outputTokens = usage.completion_tokens ?? 0;

          let content: T;
          if (params.jsonOutput) {
            content = parseJsonStrict<T>(rawText);
          } else {
            content = rawText as unknown as T;
          }

          return {
            content,
            rawText,
            // У лог пишемо ОБРАНУ модель (deepseek-chat / deepseek-reasoner).
            // DeepSeek у відповіді повертає назву базової моделі (deepseek-v4-flash)
            // для обох режимів — це приховувало б, що саме запускали.
            modelVersion: params.model,
            inputTokens,
            outputTokens,
            // У DeepSeek немає окремого «запису в кеш» — кеш автоматичний.
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: cacheRead,
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
      throw lastError ?? new DeepseekError(500, 'DeepSeek call failed');
    }
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface DeepseekApiResponse {
  model?: string;
  choices?: Array<{ message?: { content?: string } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
  };
}

function isRetryable(err: unknown): boolean {
  if (err instanceof DeepseekError) {
    return err.status === 429 || err.status === 502 || err.status >= 500;
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
