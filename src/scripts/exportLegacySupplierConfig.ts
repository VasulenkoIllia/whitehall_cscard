import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';

type RowRecord = Record<string, unknown>;

function readRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`${name} is not set`);
  }
  return value.trim();
}

function readSupplierNames(): string[] {
  const raw = process.env.LEGACY_SUPPLIER_NAMES || 'WHITE HALL,sevrukov';
  const parsed = raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (!parsed.length) {
    throw new Error('LEGACY_SUPPLIER_NAMES is empty');
  }
  return parsed;
}

function resolveOutputPath(): string {
  const raw = process.env.LEGACY_CONFIG_OUTPUT_PATH || 'output/legacy_supplier_config_snapshot.json';
  return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
}

async function tableExists(pool: Pool, tableName: string): Promise<boolean> {
  const result = await pool.query(`SELECT to_regclass($1) AS rel`, [tableName]);
  return result.rows[0]?.rel !== null;
}

async function columnExists(pool: Pool, tableName: string, columnName: string): Promise<boolean> {
  const result = await pool.query(
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

async function main() {
  const legacyDatabaseUrl = readRequiredEnv('LEGACY_DATABASE_URL');
  const supplierNames = readSupplierNames();
  const outputPath = resolveOutputPath();
  const supplierNamesLower = supplierNames.map((item) => item.toLowerCase());

  const pool = new Pool({ connectionString: legacyDatabaseUrl });
  try {
    const suppliersResult = await pool.query(
      `SELECT
         id,
         name,
         markup_percent,
         min_profit_enabled,
         min_profit_amount,
         priority,
         is_active,
         markup_rule_set_id
       FROM suppliers
       WHERE LOWER(name) = ANY($1::text[])
       ORDER BY id ASC`,
      [supplierNamesLower]
    );

    const suppliers = suppliersResult.rows as RowRecord[];
    if (!suppliers.length) {
      throw new Error(`No suppliers found for names: ${supplierNames.join(', ')}`);
    }

    const supplierIds = suppliers
      .map((row) => Number(row.id))
      .filter((id) => Number.isFinite(id))
      .map((id) => Math.trunc(id));

    const sourcesResult = await pool.query(
      `SELECT
         id,
         supplier_id,
         source_type,
         source_url,
         sheet_name,
         name,
         is_active
       FROM sources
       WHERE supplier_id = ANY($1::bigint[])
       ORDER BY supplier_id ASC, id ASC`,
      [supplierIds]
    );
    const sources = sourcesResult.rows as RowRecord[];

    const hasCommentColumn = await columnExists(pool, 'column_mappings', 'comment');
    const mappingsQuery = hasCommentColumn
      ? `SELECT DISTINCT ON (supplier_id, COALESCE(source_id, 0))
           id,
           supplier_id,
           source_id,
           mapping,
           header_row,
           mapping_meta,
           comment,
           created_at
         FROM column_mappings
         WHERE supplier_id = ANY($1::bigint[])
         ORDER BY supplier_id ASC, COALESCE(source_id, 0) ASC, id DESC`
      : `SELECT DISTINCT ON (supplier_id, COALESCE(source_id, 0))
           id,
           supplier_id,
           source_id,
           mapping,
           header_row,
           mapping_meta,
           NULL::text AS comment,
           created_at
         FROM column_mappings
         WHERE supplier_id = ANY($1::bigint[])
         ORDER BY supplier_id ASC, COALESCE(source_id, 0) ASC, id DESC`;
    const mappingsResult = await pool.query(mappingsQuery, [supplierIds]);
    const mappings = mappingsResult.rows as RowRecord[];

    let globalRuleSetId: number | null = null;
    if (await tableExists(pool, 'markup_settings')) {
      const globalResult = await pool.query(
        `SELECT global_rule_set_id
         FROM markup_settings
         WHERE id = 1
         LIMIT 1`
      );
      const parsed = Number(globalResult.rows[0]?.global_rule_set_id || 0);
      globalRuleSetId = Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : null;
    }

    const legacyRuleSetIds = new Set<number>();
    for (const supplier of suppliers) {
      const id = Number(supplier.markup_rule_set_id || 0);
      if (Number.isFinite(id) && id > 0) {
        legacyRuleSetIds.add(Math.trunc(id));
      }
    }
    if (globalRuleSetId) {
      legacyRuleSetIds.add(globalRuleSetId);
    }
    const ruleSetIds = Array.from(legacyRuleSetIds.values());

    let ruleSets: RowRecord[] = [];
    let ruleConditions: RowRecord[] = [];
    if (ruleSetIds.length > 0 && (await tableExists(pool, 'markup_rule_sets'))) {
      const ruleSetsResult = await pool.query(
        `SELECT
           id,
           code,
           name,
           description,
           is_active
         FROM markup_rule_sets
         WHERE id = ANY($1::bigint[])
         ORDER BY id ASC`,
        [ruleSetIds]
      );
      ruleSets = ruleSetsResult.rows as RowRecord[];
    }

    if (ruleSetIds.length > 0 && (await tableExists(pool, 'markup_rule_conditions'))) {
      const conditionsResult = await pool.query(
        `SELECT
           id,
           rule_set_id,
           priority,
           price_from,
           price_to,
           action_type,
           action_value,
           is_active
         FROM markup_rule_conditions
         WHERE rule_set_id = ANY($1::bigint[])
         ORDER BY rule_set_id ASC, priority ASC, id ASC`,
        [ruleSetIds]
      );
      ruleConditions = conditionsResult.rows as RowRecord[];
    }

    const snapshot = {
      version: 1,
      generated_at: new Date().toISOString(),
      source: {
        kind: 'legacy_postgres',
        supplier_names_requested: supplierNames
      },
      suppliers,
      sources,
      mappings,
      markup: {
        global_rule_set_id: globalRuleSetId,
        rule_sets: ruleSets,
        rule_conditions: ruleConditions
      }
    };

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(snapshot, null, 2), 'utf8');

    console.log(
      JSON.stringify(
        {
          ok: true,
          output_path: outputPath,
          suppliers: suppliers.length,
          sources: sources.length,
          mappings: mappings.length,
          rule_sets: ruleSets.length,
          rule_conditions: ruleConditions.length
        },
        null,
        2
      )
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
