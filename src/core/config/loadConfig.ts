import type { ActiveStore, AppConfig, LogLevel } from './types';

const VALID_LOG_LEVELS: LogLevel[] = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'];
const VALID_STORES: ActiveStore[] = ['horoshop', 'cscart'];

export class ConfigError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid configuration:\n- ${issues.join('\n- ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

function readString(env: Record<string, string | undefined>, key: string, fallback = ''): string {
  const value = env[key];
  return typeof value === 'string' ? value.trim() : fallback;
}

function readOptionalString(
  env: Record<string, string | undefined>,
  key: string
): string | null {
  const value = readString(env, key);
  return value ? value : null;
}

function readBoolean(
  env: Record<string, string | undefined>,
  key: string,
  fallback: boolean
): boolean {
  const raw = env[key];
  if (typeof raw !== 'string') {
    return fallback;
  }
  return raw === 'true';
}

function readPositiveInteger(
  env: Record<string, string | undefined>,
  key: string,
  fallback: number,
  issues: string[]
): number {
  const raw = env[key];
  if (typeof raw !== 'string' || raw.trim() === '') {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    issues.push(`${key} must be a positive integer`);
    return fallback;
  }

  return value;
}

function readLogLevel(
  env: Record<string, string | undefined>,
  key: string,
  fallback: LogLevel,
  issues: string[]
): LogLevel {
  const raw = readString(env, key, fallback);
  if (VALID_LOG_LEVELS.indexOf(raw as LogLevel) === -1) {
    issues.push(`${key} must be one of: ${VALID_LOG_LEVELS.join(', ')}`);
    return fallback;
  }
  return raw as LogLevel;
}

function readActiveStore(
  env: Record<string, string | undefined>,
  key: string,
  fallback: ActiveStore,
  issues: string[]
): ActiveStore {
  const raw = readString(env, key, fallback);
  if (VALID_STORES.indexOf(raw as ActiveStore) === -1) {
    issues.push(`${key} must be one of: ${VALID_STORES.join(', ')}`);
    return fallback;
  }
  return raw as ActiveStore;
}

function requireKeys(
  env: Record<string, string | undefined>,
  keys: string[],
  issues: string[]
): void {
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (!readString(env, key)) {
      issues.push(`${key} is required`);
    }
  }
}

export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const issues: string[] = [];
  const activeStore = readActiveStore(env, 'ACTIVE_STORE', 'horoshop', issues);

  const config: AppConfig = {
    base: {
      port: readPositiveInteger(env, 'PORT', 3000, issues),
      logLevel: readLogLevel(env, 'LOG_LEVEL', 'info', issues),
      activeStore,
      visibilityYes: readString(env, 'VISIBILITY_YES', 'Так') || 'Так',
      finalizeDeleteEnabled: readBoolean(env, 'FINALIZE_DELETE_ENABLED', true),
      finalizeLegacy: readBoolean(env, 'FINALIZE_LEGACY', false)
    },
    auth: {
      strategy: readString(env, 'AUTH_STRATEGY', 'db') === 'env' ? 'env' : 'db',
      sessionTtlMinutes: readPositiveInteger(env, 'AUTH_SESSION_TTL_MINUTES', 720, issues)
    },
    connectors: {
      horoshop: {
        domain: readString(env, 'HOROSHOP_DOMAIN'),
        login: readString(env, 'HOROSHOP_LOGIN'),
        password: readString(env, 'HOROSHOP_PASSWORD'),
        exportLimit: readPositiveInteger(env, 'HOROSHOP_EXPORT_LIMIT', 500, issues),
        syncDelayMs: readPositiveInteger(env, 'HOROSHOP_SYNC_DELAY_MS', 250, issues),
        syncMaxRetries: readPositiveInteger(env, 'HOROSHOP_SYNC_MAX_RETRIES', 5, issues),
        storeRaw: readBoolean(env, 'HOROSHOP_STORE_RAW', false)
      },
      cscart: {
        baseUrl: readString(env, 'CSCART_BASE_URL'),
        apiUser: readString(env, 'CSCART_API_USER'),
        apiKey: readString(env, 'CSCART_API_KEY'),
        storefrontId: readOptionalString(env, 'CSCART_STOREFRONT_ID'),
        itemsPerPage: readPositiveInteger(env, 'CSCART_ITEMS_PER_PAGE', 1000, issues),
        rateLimitRps: readPositiveInteger(env, 'CSCART_RATE_LIMIT_RPS', 10, issues),
        rateLimitBurst: readPositiveInteger(env, 'CSCART_RATE_LIMIT_BURST', 20, issues)
      }
    }
  };

  if (activeStore === 'horoshop') {
    requireKeys(env, ['HOROSHOP_DOMAIN', 'HOROSHOP_LOGIN', 'HOROSHOP_PASSWORD'], issues);
  }

  if (activeStore === 'cscart') {
    requireKeys(env, ['CSCART_BASE_URL', 'CSCART_API_USER', 'CSCART_API_KEY'], issues);
  }

  if (issues.length > 0) {
    throw new ConfigError(issues);
  }

  return config;
}
