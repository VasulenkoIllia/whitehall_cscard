/**
 * AnthropicBatchClient — wrapper над Anthropic Message Batches API.
 * https://docs.anthropic.com/en/docs/build-with-claude/message-batches
 *
 * 3 операції:
 *   1. submitBatch(requests) → batch_id + initial status
 *   2. fetchStatus(batch_id) → poll current status + counts
 *   3. fetchResults(results_url) → JSONL з результатами
 *
 * Ціна: -50% від звичайних rates.
 * SLA: до 24 годин (зазвичай 1-2 години).
 * Max requests per batch: 100 000.
 */

import fetch from 'node-fetch';

export interface BatchRequest {
  custom_id: string;
  params: {
    model: string;
    max_tokens: number;
    temperature?: number;
    system?: string;
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  };
}

export interface BatchStatusResponse {
  id: string;
  type: 'message_batch';
  processing_status: 'in_progress' | 'canceling' | 'ended';
  request_counts: {
    processing: number;
    succeeded: number;
    errored: number;
    canceled: number;
    expired: number;
  };
  ended_at: string | null;
  created_at: string;
  expires_at: string;
  archived_at: string | null;
  cancel_initiated_at: string | null;
  results_url: string | null;
}

export interface BatchResultEntry {
  custom_id: string;
  result:
    | {
        type: 'succeeded';
        message: {
          id: string;
          type: 'message';
          role: 'assistant';
          content: Array<{ type: string; text?: string }>;
          model: string;
          stop_reason: string | null;
          stop_sequence: string | null;
          usage: { input_tokens: number; output_tokens: number };
        };
      }
    | {
        type: 'errored';
        error: { type: string; message: string };
      }
    | { type: 'canceled' }
    | { type: 'expired' };
}

export interface AnthropicBatchClient {
  isEnabled(): boolean;
  submitBatch(requests: BatchRequest[]): Promise<BatchStatusResponse>;
  fetchStatus(batchId: string): Promise<BatchStatusResponse>;
  fetchResults(resultsUrl: string): Promise<BatchResultEntry[]>;
}

export function createAnthropicBatchClient(
  env: Record<string, string | undefined>,
  keyProvider?: () => Promise<string | null>
): AnthropicBatchClient {
  const envApiKey = (env.ANTHROPIC_API_KEY || '').trim();
  const baseUrl = (env.ANTHROPIC_API_BASE || 'https://api.anthropic.com/v1').replace(/\/$/, '');
  const timeoutMs = Number(env.ANTHROPIC_TIMEOUT_MS) || 180_000;

  const enabled = envApiKey.length > 0 || Boolean(keyProvider);

  // Ключ з БД має пріоритет над env; резолвиться при кожному запиті.
  async function resolveApiKey(): Promise<string> {
    const dbKey = keyProvider ? (await keyProvider().catch(() => null))?.trim() : null;
    const apiKey = dbKey || envApiKey;
    if (!apiKey) throw new Error('Anthropic API ключ не задано (ні в налаштуваннях, ні в env)');
    return apiKey;
  }

  async function call<T>(path: string, init: { method?: string; body?: unknown }): Promise<T> {
    const apiKey = await resolveApiKey();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${baseUrl}${path}`, {
        method: init.method || 'GET',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'message-batches-2024-09-24'
        },
        body: init.body ? JSON.stringify(init.body) : undefined,
        signal: controller.signal as unknown as AbortSignal
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Anthropic ${res.status}: ${text.slice(0, 500)}`);
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  async function callRaw(url: string): Promise<string> {
    const apiKey = await resolveApiKey();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'message-batches-2024-09-24'
        },
        signal: controller.signal as unknown as AbortSignal
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Anthropic ${res.status}: ${text.slice(0, 500)}`);
      }
      return await res.text();
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    isEnabled: () => enabled,

    async submitBatch(requests: BatchRequest[]): Promise<BatchStatusResponse> {
      if (requests.length === 0) throw new Error('Batch порожній');
      if (requests.length > 100_000) throw new Error('Batch перевищує ліміт 100 000 requests');
      return call<BatchStatusResponse>('/messages/batches', {
        method: 'POST',
        body: { requests }
      });
    },

    async fetchStatus(batchId: string): Promise<BatchStatusResponse> {
      return call<BatchStatusResponse>(`/messages/batches/${batchId}`, {});
    },

    async fetchResults(resultsUrl: string): Promise<BatchResultEntry[]> {
      // results_url повертає JSONL — рядок на entry.
      const text = await callRaw(resultsUrl);
      const lines = text.split('\n').filter((l) => l.trim().length > 0);
      return lines.map((line) => JSON.parse(line) as BatchResultEntry);
    }
  };
}
