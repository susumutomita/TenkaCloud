import type { SamlConfigRecord, SamlConfigRepository, SqlExecutor } from "./types.js";

/**
 * [Issue #2442 / Phase C2] SQLite schema for the SamlConfig sub-aggregate. On
 * DynamoDB this row co-habits the CompetitorAccounts table's `TENANT#<t>`
 * partition (sparse `SK = "SAML_CONFIG"`); the SQL backend gives it its own
 * table (the same precedent as `tenant_feature_flags` co-habiting the Events
 * DynamoDB table while getting its own SQL table, #2439).
 */
export const SAML_CONFIG_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS saml_configs (
  tenant_id TEXT PRIMARY KEY,
  payload   TEXT NOT NULL
)`,
] as const;

/** SQL script form retained for local SQLite parity tests and manual bootstrap. */
export const SAML_CONFIG_SCHEMA_SQL = `${SAML_CONFIG_SCHEMA_STATEMENTS.join(";\n")};`;

export class SqlSamlConfigRepository implements SamlConfigRepository {
  constructor(private readonly sql: SqlExecutor) {}

  async getSamlConfig(tenantId: string): Promise<SamlConfigRecord | undefined> {
    const row = await this.sql.get("SELECT payload FROM saml_configs WHERE tenant_id = ?", [
      tenantId,
    ]);
    return row ? (JSON.parse(String(row.payload)) as SamlConfigRecord) : undefined;
  }

  async putSamlConfig(record: SamlConfigRecord): Promise<SamlConfigRecord> {
    await this.sql.run(
      "INSERT INTO saml_configs (tenant_id, payload) VALUES (?, ?) " +
        "ON CONFLICT(tenant_id) DO UPDATE SET payload = excluded.payload",
      [record.tenantId, JSON.stringify(record)],
    );
    return record;
  }

  async deleteSamlConfig(tenantId: string): Promise<void> {
    await this.sql.run("DELETE FROM saml_configs WHERE tenant_id = ?", [tenantId]);
  }
}
