export type ActiveStore = 'horoshop' | 'cscart';

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

export interface BaseConfig {
  port: number;
  logLevel: LogLevel;
  activeStore: ActiveStore;
  visibilityYes: string;
  finalizeDeleteEnabled: boolean;
  finalizeLegacy: boolean;
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
  apiKey: string;
  storefrontId: string | null;
}

export interface AppConfig {
  base: BaseConfig;
  connectors: {
    horoshop: HoroshopConfig;
    cscart: CsCartConfig;
  };
}
