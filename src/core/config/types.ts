export type ActiveStore = 'horoshop' | 'cscart';

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

export interface BaseConfig {
  port: number;
  logLevel: LogLevel;
  activeStore: ActiveStore;
  databaseUrl: string;
  visibilityYes: string;
  finalizeDeleteEnabled: boolean;
  finalizeLegacy: boolean;
  cleanupRetentionDays: number;
}

export interface AuthEnvConfig {
  strategy: 'db' | 'env';
  sessionTtlMinutes: number;
}

export interface HoroshopConfig {
  domain: string;
  login: string;
  password: string;
  exportLimit: number;
  syncDelayMs: number;
  syncMaxRetries: number;
  storeRaw: boolean;
}

export interface CsCartConfig {
  baseUrl: string;
  apiUser: string;
  apiKey: string;
  storefrontId: string | null;
  itemsPerPage: number;
  rateLimitRps: number;
  rateLimitBurst: number;
  allowCreate: boolean;
}

export interface SchedulerTaskConfig {
  enabled: boolean;
  intervalMinutes: number;
  runOnStartup: boolean;
}

export interface SchedulerConfig {
  enabled: boolean;
  tickSeconds: number;
  updatePipeline: SchedulerTaskConfig & { supplier: string | null };
  storeMirrorSync: SchedulerTaskConfig;
  cleanup: SchedulerTaskConfig;
}

export interface AppConfig {
  base: BaseConfig;
  auth: AuthEnvConfig;
  scheduler: SchedulerConfig;
  connectors: {
    horoshop: HoroshopConfig;
    cscart: CsCartConfig;
  };
}
