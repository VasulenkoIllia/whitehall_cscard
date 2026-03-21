import fs from 'fs';
import path from 'path';
import { Pool, type PoolClient } from 'pg';

type UnknownRecord = Record<string, unknown>;

function readRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`${name} is not set`);
  }
  return value.trim();
}

function readInputPath(): string {
  const raw = readRequiredEnv('LEGACY_CONFIG_INPUT_PATH');
  return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
}

function readDryRunFlag(): boolean {
  const raw = String(process.env.LEGACY_CONFIG_DRY_RUN || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

function toInt(value: unknown): number | null {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  const normalized = Math.trunc(numeric);
  return normalized > 0 ? normalized : null;
}

function toNumber(value: unknown, fallback: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return numeric;
}

function toBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
      return true;
    }
    if (normalized === 'false' || normalized === '0' || normalized === 'no') {
      return false;
    }
  }
  return fallback;
}

function toNullableText(value: unknown): string | null {
  if (value === null || typeof value === 'undefined') {
    return null;
  }
  const normalized = String(value).trim();
  return normalized ? normalized : null;
}

function readArray(value: unknown): UnknownRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item) => item && typeof item === 'object') as UnknownRecord[];
}

async function hasColumn(client: PoolClient, tableName: string, columnName: string): Promise<boolean> {
  const result = await client.query(
    `SELECT 1
     FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = $1
       AND column_name = $2
     LIMIT 1`,
    [tableName, columnName]
  );
  return (result.rowCount || 0) > 0;
}

async function upsertRuleSets(
  client: PoolClient,
  ruleSets: UnknownRecord[],
  ruleConditions: UnknownRecord[]
): Promise<Map<number, number>> {
  const map = new Map<number, number>();

  for (const ruleSet of ruleSets) {
    const legacyRuleSetId = toInt(ruleSet.id);
    const name = toNullableText(ruleSet.name);
    if (!legacyRuleSetId || !name) {
      continue;
    }
    const isActive = toBoolean(ruleSet.is_active, true);

    const existing = await client.query(
      `SELECT id
       FROM markup_rule_sets
       WHERE LOWER(name) = LOWER($1)
       ORDER BY id ASC
       LIMIT 1`,
      [name]
    );

    let targetRuleSetId: number;
    if (existing.rows[0]) {
      targetRuleSetId = Number(existing.rows[0].id);
      await client.query(
        `UPDATE markup_rule_sets
         SET name = $1,
             is_active = $2
         WHERE id = $3`,
        [name, isActive, targetRuleSetId]
      );
    } else {
      const inserted = await client.query(
        `INSERT INTO markup_rule_sets (name, is_active)
         VALUES ($1, $2)
         RETURNING id`,
        [name, isActive]
      );
      targetRuleSetId = Number(inserted.rows[0].id);
    }
    map.set(legacyRuleSetId, targetRuleSetId);
  }

  for (const [legacyRuleSetId, targetRuleSetId] of map.entries()) {
    await client.query('DELETE FROM markup_rule_conditions WHERE rule_set_id = $1', [targetRuleSetId]);

    const conditions = ruleConditions.filter(
      (item) => toInt(item.rule_set_id) === legacyRuleSetId
    );
    for (const condition of conditions) {
      const actionType = toNullableText(condition.action_type);
      if (actionType !== 'fixed_add' && actionType !== 'percent') {
        continue;
      }
      const priority = Number.isFinite(Number(condition.priority))
        ? Math.trunc(Number(condition.priority))
        : 100;
      const priceFrom = Math.max(0, toNumber(condition.price_from, 0));
      const rawPriceTo = condition.price_to;
      const priceTo =
        rawPriceTo === null || typeof rawPriceTo === 'undefined'
          ? null
          : toNumber(rawPriceTo, Number.NaN);
      const normalizedPriceTo = Number.isFinite(priceTo) ? priceTo : null;
      const actionValue = Math.max(0, toNumber(condition.action_value, 0));
      const isActive = toBoolean(condition.is_active, true);

      await client.query(
        `INSERT INTO markup_rule_conditions
           (rule_set_id, priority, price_from, price_to, action_type, action_value, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          targetRuleSetId,
          priority,
          priceFrom,
          normalizedPriceTo,
          actionType,
          actionValue,
          isActive
        ]
      );
    }
  }

  return map;
}

async function main() {
  const databaseUrl = readRequiredEnv('DATABASE_URL');
  const inputPath = readInputPath();
  const dryRun = readDryRunFlag();

  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input snapshot not found: ${inputPath}`);
  }

  const raw = fs.readFileSync(inputPath, 'utf8');
  const parsed = JSON.parse(raw) as UnknownRecord;
  const suppliers = readArray(parsed.suppliers);
  const sources = readArray(parsed.sources);
  const mappings = readArray(parsed.mappings);
  const markup = (parsed.markup && typeof parsed.markup === 'object'
    ? (parsed.markup as UnknownRecord)
    : {}) as UnknownRecord;
  const ruleSets = readArray(
    markup.rule_sets ?? (parsed.markup_rule_sets as unknown)
  );
  const ruleConditions = readArray(
    markup.rule_conditions ?? (parsed.markup_rule_conditions as unknown)
  );

  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const hasMappingCommentColumn = await hasColumn(client, 'column_mappings', 'comment');

    const ruleSetIdMap = await upsertRuleSets(client, ruleSets, ruleConditions);
    const supplierIdMap = new Map<number, number>();
    const sourceIdMap = new Map<number, number>();

    let suppliersCreated = 0;
    let suppliersUpdated = 0;
    let sourcesCreated = 0;
    let sourcesUpdated = 0;
    let mappingsInserted = 0;

    for (const supplier of suppliers) {
      const legacySupplierId = toInt(supplier.id);
      const name = toNullableText(supplier.name);
      if (!legacySupplierId || !name) {
        continue;
      }

      const markupPercent = toNumber(supplier.markup_percent, 0);
      const minProfitEnabled = toBoolean(supplier.min_profit_enabled, false);
      const minProfitAmount = minProfitEnabled ? Math.max(0, toNumber(supplier.min_profit_amount, 0)) : 0;
      const priority = Number.isFinite(Number(supplier.priority))
        ? Math.trunc(Number(supplier.priority))
        : 100;
      const isActive = toBoolean(supplier.is_active, true);
      const legacyRuleSetId = toInt(supplier.markup_rule_set_id);
      const targetRuleSetId = legacyRuleSetId ? (ruleSetIdMap.get(legacyRuleSetId) ?? null) : null;

      const existing = await client.query(
        `SELECT id
         FROM suppliers
         WHERE LOWER(name) = LOWER($1)
         ORDER BY id ASC
         LIMIT 1`,
        [name]
      );

      let targetSupplierId: number;
      if (existing.rows[0]) {
        targetSupplierId = Number(existing.rows[0].id);
        await client.query(
          `UPDATE suppliers
           SET name = $1,
               markup_percent = $2,
               min_profit_enabled = $3,
               min_profit_amount = $4,
               priority = $5,
               is_active = $6,
               markup_rule_set_id = $7
           WHERE id = $8`,
          [
            name,
            markupPercent,
            minProfitEnabled,
            minProfitAmount,
            priority,
            isActive,
            targetRuleSetId,
            targetSupplierId
          ]
        );
        suppliersUpdated += 1;
      } else {
        const inserted = await client.query(
          `INSERT INTO suppliers
             (name, markup_percent, min_profit_enabled, min_profit_amount, priority, is_active, markup_rule_set_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id`,
          [name, markupPercent, minProfitEnabled, minProfitAmount, priority, isActive, targetRuleSetId]
        );
        targetSupplierId = Number(inserted.rows[0].id);
        suppliersCreated += 1;
      }

      supplierIdMap.set(legacySupplierId, targetSupplierId);
    }

    for (const source of sources) {
      const legacySourceId = toInt(source.id);
      const legacySupplierId = toInt(source.supplier_id);
      if (!legacySourceId || !legacySupplierId) {
        continue;
      }
      const targetSupplierId = supplierIdMap.get(legacySupplierId);
      if (!targetSupplierId) {
        continue;
      }

      const sourceType = toNullableText(source.source_type);
      const sourceUrl = toNullableText(source.source_url);
      if (!sourceType || !sourceUrl) {
        continue;
      }
      const sheetName = toNullableText(source.sheet_name);
      const name = toNullableText(source.name) || sheetName || 'Source';
      const isActive = toBoolean(source.is_active, true);

      const existing = await client.query(
        `SELECT id
         FROM sources
         WHERE supplier_id = $1
           AND source_type = $2
           AND source_url = $3
           AND COALESCE(sheet_name, '') = COALESCE($4::text, '')
         ORDER BY id DESC
         LIMIT 1`,
        [targetSupplierId, sourceType, sourceUrl, sheetName]
      );

      let targetSourceId: number;
      if (existing.rows[0]) {
        targetSourceId = Number(existing.rows[0].id);
        await client.query(
          `UPDATE sources
           SET name = $1,
               is_active = $2,
               sheet_name = $3
           WHERE id = $4`,
          [name, isActive, sheetName, targetSourceId]
        );
        sourcesUpdated += 1;
      } else {
        const inserted = await client.query(
          `INSERT INTO sources
             (supplier_id, source_type, source_url, sheet_name, name, is_active)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id`,
          [targetSupplierId, sourceType, sourceUrl, sheetName, name, isActive]
        );
        targetSourceId = Number(inserted.rows[0].id);
        sourcesCreated += 1;
      }

      sourceIdMap.set(legacySourceId, targetSourceId);
    }

    const mappingsSorted = mappings
      .slice()
      .sort((a, b) => toNumber(a.id, 0) - toNumber(b.id, 0));

    for (const mapping of mappingsSorted) {
      const legacySupplierId = toInt(mapping.supplier_id);
      if (!legacySupplierId) {
        continue;
      }
      const targetSupplierId = supplierIdMap.get(legacySupplierId);
      if (!targetSupplierId) {
        continue;
      }

      const legacySourceId = toInt(mapping.source_id);
      const targetSourceId = legacySourceId ? (sourceIdMap.get(legacySourceId) ?? null) : null;
      const mappingData =
        mapping.mapping && typeof mapping.mapping === 'object'
          ? (mapping.mapping as UnknownRecord)
          : null;
      if (!mappingData) {
        continue;
      }
      const headerRow = Number.isFinite(Number(mapping.header_row))
        ? Math.trunc(Number(mapping.header_row))
        : null;
      const mappingMeta =
        mapping.mapping_meta && typeof mapping.mapping_meta === 'object'
          ? { ...(mapping.mapping_meta as UnknownRecord) }
          : null;
      if (mappingMeta) {
        const legacyMetaSourceId = toInt(mappingMeta.source_id);
        if (legacyMetaSourceId) {
          const mappedSourceId = sourceIdMap.get(legacyMetaSourceId);
          if (mappedSourceId) {
            mappingMeta.source_id = mappedSourceId;
          } else {
            delete mappingMeta.source_id;
          }
        }
      }

      const comment = toNullableText(mapping.comment);
      if (hasMappingCommentColumn) {
        await client.query(
          `INSERT INTO column_mappings
             (supplier_id, source_id, mapping, header_row, mapping_meta, comment)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [targetSupplierId, targetSourceId, mappingData, headerRow, mappingMeta, comment]
        );
      } else {
        await client.query(
          `INSERT INTO column_mappings
             (supplier_id, source_id, mapping, header_row, mapping_meta)
           VALUES ($1, $2, $3, $4, $5)`,
          [targetSupplierId, targetSourceId, mappingData, headerRow, mappingMeta]
        );
      }
      mappingsInserted += 1;
    }

    const summary = {
      ok: true,
      dry_run: dryRun,
      suppliers_created: suppliersCreated,
      suppliers_updated: suppliersUpdated,
      sources_created: sourcesCreated,
      sources_updated: sourcesUpdated,
      mappings_inserted: mappingsInserted,
      rule_sets_total: ruleSetIdMap.size
    };

    if (dryRun) {
      await client.query('ROLLBACK');
    } else {
      await client.query('COMMIT');
    }

    console.log(JSON.stringify(summary, null, 2));
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
