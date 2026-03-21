import fetch from 'node-fetch';

const TELEGRAM_MAX_LENGTH = 3800;

export type TelegramAlertPayload = {
  jobId: number | null;
  level: 'info' | 'warning' | 'error';
  message: string;
  data?: unknown;
};

export interface ErrorAlertSink {
  notifyError(payload: TelegramAlertPayload): Promise<void>;
}

type TelegramAlertServiceOptions = {
  botToken: string;
  chatId: string;
  appName: string;
  timeoutMs: number;
};

function trimText(value: unknown): string {
  return String(value || '').trim();
}

function readPositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.trunc(parsed);
}

function buildText(appName: string, payload: TelegramAlertPayload): string {
  const lines: string[] = [];
  const prefix = appName ? `${appName}: ` : '';
  lines.push(`${prefix}${payload.message || 'Error'}`);
  if (payload.jobId) {
    lines.push(`Job: #${payload.jobId}`);
  }
  lines.push(`Level: ${payload.level}`);
  if (typeof payload.data !== 'undefined' && payload.data !== null) {
    const serialized =
      typeof payload.data === 'string' ? payload.data : JSON.stringify(payload.data);
    if (serialized && serialized !== '{}' && serialized !== 'null') {
      lines.push(`Data: ${serialized}`);
    }
  }
  const text = lines.join('\n');
  if (text.length <= TELEGRAM_MAX_LENGTH) {
    return text;
  }
  return `${text.slice(0, TELEGRAM_MAX_LENGTH)}...`;
}

export class TelegramAlertService implements ErrorAlertSink {
  private readonly botToken: string;
  private readonly chatId: string;
  private readonly appName: string;
  private readonly timeoutMs: number;

  constructor(options: TelegramAlertServiceOptions) {
    this.botToken = options.botToken;
    this.chatId = options.chatId;
    this.appName = options.appName;
    this.timeoutMs = options.timeoutMs;
  }

  async notifyError(payload: TelegramAlertPayload): Promise<void> {
    const text = buildText(this.appName, payload);
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${this.botToken}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: this.chatId,
            text,
            disable_web_page_preview: true
          }),
          timeout: this.timeoutMs
        }
      );
      if (!response.ok) {
        const body = await response.text();
        // eslint-disable-next-line no-console
        console.warn(`telegram_alert_error: ${response.status} ${body}`);
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn(
        `telegram_alert_error: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}

export function createTelegramAlertServiceFromEnv(
  env: Record<string, string | undefined>
): TelegramAlertService | null {
  const botToken = trimText(env.TELEGRAM_BOT_TOKEN);
  const chatId = trimText(env.TELEGRAM_CHAT_ID);
  if (!botToken || !chatId) {
    return null;
  }
  const appName = trimText(env.TELEGRAM_APP_NAME || env.APP_NAME || 'whitehall_cscart');
  const timeoutMs = readPositiveInt(env.TELEGRAM_TIMEOUT_MS, 7000);
  return new TelegramAlertService({
    botToken,
    chatId,
    appName,
    timeoutMs
  });
}
