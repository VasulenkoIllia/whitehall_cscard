import type { Pool } from 'pg';
import type { ErrorAlertSink } from '../alerts/TelegramAlertService';

export type LogLevel = 'info' | 'warning' | 'error';

type LogServiceOptions = {
  errorAlertSink?: ErrorAlertSink | null;
};

const LOG_PAYLOAD_MAX_BYTES = (() => {
  const parsed = Number(process.env.LOG_PAYLOAD_MAX_BYTES || 32768);
  if (!Number.isFinite(parsed)) {
    return 32768;
  }
  return Math.max(1024, Math.trunc(parsed));
})();

const LOG_MAX_DEPTH = 5;
const LOG_MAX_KEYS = 60;
const LOG_MAX_ARRAY_ITEMS = 60;
const LOG_MAX_STRING_LENGTH = 4000;

function trimString(value: string, maxLength = LOG_MAX_STRING_LENGTH): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}...[truncated ${value.length - maxLength} chars]`;
}

function sanitizeLogValue(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === 'undefined') {
    return null;
  }
  if (depth > LOG_MAX_DEPTH) {
    return '[depth_limit]';
  }
  if (value instanceof Error) {
    return {
      name: value.name || 'Error',
      message: trimString(value.message || ''),
      stack: value.stack ? trimString(value.stack, LOG_MAX_STRING_LENGTH * 2) : null
    };
  }
  if (typeof value === 'string') {
    return trimString(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    const normalizedItems = value
      .slice(0, LOG_MAX_ARRAY_ITEMS)
      .map((item) => sanitizeLogValue(item, depth + 1));
    if (value.length > LOG_MAX_ARRAY_ITEMS) {
      normalizedItems.push(`[${value.length - LOG_MAX_ARRAY_ITEMS} items truncated]`);
    }
    return normalizedItems;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    const limited = entries.slice(0, LOG_MAX_KEYS);
    const normalized: Record<string, unknown> = {};
    for (let index = 0; index < limited.length; index += 1) {
      const [key, entryValue] = limited[index];
      normalized[key] = sanitizeLogValue(entryValue, depth + 1);
    }
    if (entries.length > LOG_MAX_KEYS) {
      normalized.__truncated_keys = entries.length - LOG_MAX_KEYS;
    }
    return normalized;
  }
  return trimString(String(value));
}

function normalizeLogPayload(data: unknown): unknown {
  if (typeof data === 'undefined') {
    return null;
  }

  const sanitized = sanitizeLogValue(data);

  try {
    const encoded = JSON.stringify(sanitized);
    if (!encoded) {
      return null;
    }
    const payloadBytes = Buffer.byteLength(encoded, 'utf8');
    if (payloadBytes <= LOG_PAYLOAD_MAX_BYTES) {
      return sanitized;
    }
    const sampleLength = Math.max(256, LOG_PAYLOAD_MAX_BYTES - 128);
    return {
      truncated: true,
      originalBytes: payloadBytes,
      maxBytes: LOG_PAYLOAD_MAX_BYTES,
      sample: trimString(encoded, sampleLength)
    };
  } catch (_error) {
    return {
      message: 'unserializable_log_payload'
    };
  }
}

export class LogService {
  private readonly errorAlertSink: ErrorAlertSink | null;

  constructor(private readonly pool: Pool, options?: LogServiceOptions) {
    this.errorAlertSink = options?.errorAlertSink || null;
  }

  async log(jobId: number | null, level: LogLevel, message: string, data?: unknown): Promise<void> {
    const payload = normalizeLogPayload(data);
    await this.pool.query(
      'INSERT INTO logs (job_id, level, message, data) VALUES ($1, $2, $3, $4)',
      [jobId || null, level, message, payload]
    );

    if (level === 'error' && this.errorAlertSink) {
      await this.errorAlertSink.notifyError({
        jobId: jobId || null,
        level,
        message,
        data: payload
      });
    }
  }
}
