import { createClient } from "@libsql/client/http";

export const PUBLISHED_CLOUD_DATA_TABLES = [
  "cloud_transaction_guard",
  "cloud_events",
  "cloud_teams",
  "cloud_access_keys",
  "cloud_create_receipts",
  "cloud_deployments",
  "cloud_team_scores",
  "cloud_installation_control",
  "cloud_connections",
  "cloud_deployment_targets",
  "cloud_deployment_receipts",
  "cloud_dispatch",
  "cloud_creations",
  "cloud_deployment_attempts",
  "cloud_teardowns",
  "cloud_score_events",
  "cloud_competitor_accounts",
  "cloud_competitor_references",
  "cloud_external_id",
  "cloud_coordination_runs",
  "cloud_coordination_history",
  "cloud_coordination_receipts",
  "cloud_coordination_scores",
] as const;
const INCOMPATIBLE_SCHEMA =
  "This Turso database contains incompatible published cloud-v1 data or an unrecognized schema. Use a separate database or plan an explicit migration. No schema was initialized and no data was modified.";
interface SchemaClient {
  execute(sql: string): Promise<{ readonly rows: readonly unknown[] }>;
}
function tableName(row: unknown): string {
  if (!row || typeof row !== "object" || !("name" in row) || typeof row.name !== "string")
    throw new Error(INCOMPATIBLE_SCHEMA);
  return row.name;
}
/** Read-only: preserve existing data; empty tables left by an explicit purge need no migration. */
export async function assertTursoSchemaCompatible(client: SchemaClient): Promise<void> {
  await client.execute("SELECT 1");
  const result = await client.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'cloud_*'",
  );
  const names = result.rows.map(tableName);
  if (names.length === 0) return;
  const known = new Set<string>(["cloud_schema", ...PUBLISHED_CLOUD_DATA_TABLES]);
  if (!names.includes("cloud_schema") || names.some((name) => !known.has(name)))
    throw new Error(INCOMPATIBLE_SCHEMA);
  const version = await client.execute("SELECT version FROM cloud_schema WHERE id = 1");
  const record = version.rows[0];
  if (
    version.rows.length !== 1 ||
    !record ||
    typeof record !== "object" ||
    !("version" in record) ||
    record.version !== 1
  )
    throw new Error(INCOMPATIBLE_SCHEMA);
  const dataTables = names.filter((name) => name !== "cloud_schema");
  if (dataTables.length === 0) return;
  // Names were checked against a fixed source allowlist, never accepted as arbitrary SQL.
  const occupied = await client.execute(
    dataTables
      .map((name) => `SELECT '${name}' AS name WHERE EXISTS (SELECT 1 FROM "${name}" LIMIT 1)`)
      .join(" UNION ALL "),
  );
  if (occupied.rows.length > 0) throw new Error(INCOMPATIBLE_SCHEMA);
}
export async function probeTursoConnection(config: {
  readonly url: string;
  readonly authToken: string;
}): Promise<void> {
  const client = createClient(config);
  try {
    await assertTursoSchemaCompatible(client);
  } finally {
    client.close();
  }
}
