import { createHash } from 'crypto';
import type { Pool } from 'pg';
import { ENRICHMENT_SYSTEM_PROMPT } from '../ai/EnrichmentPrompt';

/**
 * AppSettingsService — runtime-редаговані налаштування у таблиці app_settings.
 *
 * Ключі:
 *   enrichment_system_prompt        — кастомний system prompt (value TEXT).
 *   anthropic_api_key               — власний ключ Claude з фронта (value TEXT).
 *   excel_import_excluded_columns   — масив колонок Excel, які не йдуть в AI (value_json).
 *
 * Значення читаються з БД при кожному запиті — без кешу. Для admin-tool
 * трафіку це копійки, зате зміни застосовуються миттєво без рестарту.
 */

export const SETTING_ENRICHMENT_PROMPT = 'enrichment_system_prompt';
export const SETTING_ANTHROPIC_API_KEY = 'anthropic_api_key';
export const SETTING_DEEPSEEK_API_KEY = 'deepseek_api_key';
export const SETTING_EXCEL_EXCLUDED_COLUMNS = 'excel_import_excluded_columns';

/**
 * Дефолтні виключені колонки Excel: фото/лінки/технічне/SEO-сміття роздувають
 * токени і не потрібні AI. Матчинг — case-insensitive substring по назві колонки.
 * Підлаштовано під реальний файл (enriched_final.xlsx): photo_1..15, url,
 * feed_url, image_count, _feed_matched, feed_keywords*, юридичні поля.
 */
export const DEFAULT_EXCEL_EXCLUDED_COLUMNS = [
  'photo', 'image', 'picture', 'img', 'фото', 'зображення', 'картинка',
  'url', 'link', 'посилання',
  '_feed_matched', 'keywords',
  'тнвэд', 'тнвед', 'висновок сез', 'адреса виробника', 'закону україни'
];

export interface EnrichmentPromptSetting {
  prompt: string;
  isCustom: boolean;
  /** 'v1' для вбудованого, 'custom-<sha256:8>' для кастомного. */
  version: string;
}

export class AppSettingsService {
  constructor(private readonly pool: Pool) {}

  async get(key: string): Promise<{ value: string | null; valueJson: unknown } | null> {
    const res = await this.pool.query<{ value: string | null; value_json: unknown }>(
      `SELECT value, value_json FROM app_settings WHERE key = $1`,
      [key]
    );
    if (res.rowCount === 0) return null;
    return { value: res.rows[0].value, valueJson: res.rows[0].value_json };
  }

  async set(key: string, value: string | null, valueJson?: unknown): Promise<void> {
    await this.pool.query(
      `INSERT INTO app_settings (key, value, value_json, updated_at)
       VALUES ($1, $2, $3::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value,
             value_json = EXCLUDED.value_json,
             updated_at = NOW()`,
      [key, value, typeof valueJson === 'undefined' ? null : JSON.stringify(valueJson)]
    );
  }

  async delete(key: string): Promise<void> {
    await this.pool.query(`DELETE FROM app_settings WHERE key = $1`, [key]);
  }

  /**
   * System prompt для enrichment: кастомний з БД або вбудований default.
   * version пишеться у master_catalog.ai_prompt_version — щоб було видно,
   * яким промптом збагачено кожен рядок.
   */
  async getEnrichmentPrompt(): Promise<EnrichmentPromptSetting> {
    const row = await this.get(SETTING_ENRICHMENT_PROMPT);
    const custom = row?.value?.trim();
    if (custom) {
      const hash = createHash('sha256').update(custom).digest('hex').slice(0, 8);
      return { prompt: custom, isCustom: true, version: `custom-${hash}` };
    }
    return { prompt: ENRICHMENT_SYSTEM_PROMPT, isCustom: false, version: 'v1' };
  }

  /** Власний ключ Claude з БД (пріоритет над env) або null. */
  async getAnthropicApiKey(): Promise<string | null> {
    const row = await this.get(SETTING_ANTHROPIC_API_KEY);
    const key = row?.value?.trim();
    return key && key.length > 0 ? key : null;
  }

  /** Власний ключ DeepSeek з БД (пріоритет над env) або null. */
  async getDeepseekApiKey(): Promise<string | null> {
    const row = await this.get(SETTING_DEEPSEEK_API_KEY);
    const key = row?.value?.trim();
    return key && key.length > 0 ? key : null;
  }

  /** Список виключених колонок для Excel-імпорту: збережений або дефолтний. */
  async getExcelExcludedColumns(): Promise<{ columns: string[]; isCustom: boolean }> {
    const row = await this.get(SETTING_EXCEL_EXCLUDED_COLUMNS);
    if (Array.isArray(row?.valueJson)) {
      const columns = (row!.valueJson as unknown[])
        .filter((x): x is string => typeof x === 'string')
        .map((x) => x.trim())
        .filter((x) => x.length > 0);
      return { columns, isCustom: true };
    }
    return { columns: [...DEFAULT_EXCEL_EXCLUDED_COLUMNS], isCustom: false };
  }
}
