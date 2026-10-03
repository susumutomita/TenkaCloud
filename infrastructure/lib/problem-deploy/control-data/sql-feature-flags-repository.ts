import type { FeatureFlagsRepository, SqlExecutor, TenantFeatureFlagsRecord } from "./types.js";

export const FEATURE_FLAGS_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS tenant_feature_flags (
  tenant_id TEXT PRIMARY KEY,
  payload   TEXT NOT NULL
)`,
] as const;

export const FEATURE_FLAGS_SCHEMA_SQL = `${FEATURE_FLAGS_SCHEMA_STATEMENTS.join(";\n")};`;

export class SqlFeatureFlagsRepository implements FeatureFlagsRepository {
  constructor(private readonly sql: SqlExecutor) {}

  async get(tenantId: string): Promise<TenantFeatureFlagsRecord | undefined> {
    const row = await this.sql.get("SELECT payload FROM tenant_feature_flags WHERE tenant_id = ?", [
      tenantId,
    ]);
    return row ? (JSON.parse(String(row.payload)) as TenantFeatureFlagsRecord) : undefined;
  }

  async put(record: TenantFeatureFlagsRecord): Promise<void> {
    await this.sql.run(
      "INSERT INTO tenant_feature_flags (tenant_id, payload) VALUES (?, ?) " +
        "ON CONFLICT(tenant_id) DO UPDATE SET payload = excluded.payload",
      [record.tenantId, JSON.stringify(record)],
    );
  }
}
