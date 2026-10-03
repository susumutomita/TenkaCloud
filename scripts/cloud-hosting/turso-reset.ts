import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { type Client, createClient } from "@libsql/client/http";
import { SCORE_SUMMARY_SCHEMA_STATEMENTS } from "../../infrastructure/lib/problem-deploy/control-data/score-summary-schema";
import { ADMIN_AUDIT_LOG_SCHEMA_STATEMENTS } from "../../infrastructure/lib/problem-deploy/control-data/sql-admin-audit-log-repository";
import { COMPETITOR_ACCOUNTS_SCHEMA_STATEMENTS } from "../../infrastructure/lib/problem-deploy/control-data/sql-competitor-accounts-repository";
import { DEPLOYMENTS_SCHEMA_STATEMENTS } from "../../infrastructure/lib/problem-deploy/control-data/sql-deployments-core";
import { DISRUPTIONS_SCHEMA_STATEMENTS } from "../../infrastructure/lib/problem-deploy/control-data/sql-disruptions-repository";
import { EVENTS_SCHEMA_STATEMENTS } from "../../infrastructure/lib/problem-deploy/control-data/sql-events-repository";
import { FEATURE_FLAGS_SCHEMA_STATEMENTS } from "../../infrastructure/lib/problem-deploy/control-data/sql-feature-flags-repository";
import { NOTIFICATIONS_SCHEMA_STATEMENTS } from "../../infrastructure/lib/problem-deploy/control-data/sql-notifications-repository";
import { PROBLEM_ENDPOINTS_SCHEMA_STATEMENTS } from "../../infrastructure/lib/problem-deploy/control-data/sql-problem-endpoints-repository";
import { SAML_CONFIG_SCHEMA_STATEMENTS } from "../../infrastructure/lib/problem-deploy/control-data/sql-saml-config-repository";
import { SAML_IDPS_SCHEMA_STATEMENTS } from "../../infrastructure/lib/problem-deploy/control-data/sql-saml-idps-repository";
import { TEAMS_SCHEMA_STATEMENTS } from "../../infrastructure/lib/problem-deploy/control-data/sql-teams-repository";
import { assertTursoSchemaCompatible, PUBLISHED_CLOUD_DATA_TABLES } from "./turso-schema";

export type TursoSchema = "lite-baseline-v1" | "cloud-v1";
export interface TursoResetTarget {
  readonly databaseUrl: string;
  readonly parameterName: string;
  readonly region: string;
  readonly schema: TursoSchema;
}
const liteSchema = [
  ...SCORE_SUMMARY_SCHEMA_STATEMENTS,
  ...ADMIN_AUDIT_LOG_SCHEMA_STATEMENTS,
  ...COMPETITOR_ACCOUNTS_SCHEMA_STATEMENTS,
  ...DEPLOYMENTS_SCHEMA_STATEMENTS,
  ...DISRUPTIONS_SCHEMA_STATEMENTS,
  ...EVENTS_SCHEMA_STATEMENTS,
  ...FEATURE_FLAGS_SCHEMA_STATEMENTS,
  ...NOTIFICATIONS_SCHEMA_STATEMENTS,
  ...PROBLEM_ENDPOINTS_SCHEMA_STATEMENTS,
  ...SAML_CONFIG_SCHEMA_STATEMENTS,
  ...SAML_IDPS_SCHEMA_STATEMENTS,
  ...TEAMS_SCHEMA_STATEMENTS,
].flatMap((sql) => {
  const name = /^CREATE TABLE IF NOT EXISTS ([a-z_]+) \(/u.exec(sql.trim())?.[1];
  const columns = sql.split("\n").flatMap((line) => {
    const column = /^([a-z_]+)\s+(?:TEXT|INTEGER|REAL|BLOB|NUMERIC)\b/u.exec(line.trim())?.[1];
    return column ? [column] : [];
  });
  return name ? [{ name, columns }] : [];
});
export const LITE_TURSO_TABLE_COLUMNS = new Map(
  liteSchema.map(({ name, columns }) => [name, columns]),
);
export const LITE_TURSO_DATA_TABLES = liteSchema
  .map(({ name }) => name)
  .filter((name) => name !== "control_data_migrations");
// The published cloud-v1 schema remains supported solely for explicit teardown.
// Do not initialize it, import its retired repository, or delete other database tables.

/** Delete rows only in the deployed contract's known tables; never bootstrap or migrate. */
export interface TursoResetSql {
  execute(sql: string): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
  batch(statements: { readonly sql: string }[], mode: "write"): Promise<unknown>;
}
export async function resetKnownTursoData(
  client: TursoResetSql,
  schema: TursoSchema,
): Promise<void> {
  const result = await client.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  );
  const tables = new Set(result.rows.map((row) => String(row.name)));
  if (schema === "lite-baseline-v1") await assertTursoSchemaCompatible(client);
  if (schema === "cloud-v1") {
    const version = await client.execute("SELECT version FROM cloud_schema WHERE id = 1");
    if (version.rows.length !== 1 || Number(version.rows[0]?.version) !== 1)
      throw new Error("Unknown published cloud-v1 schema version; purge stopped before mutation.");
  }
  const owned = (
    schema === "cloud-v1" ? PUBLISHED_CLOUD_DATA_TABLES : LITE_TURSO_DATA_TABLES
  ).filter((name) => tables.has(name));
  if (owned.length === 0) return;
  await client.batch(
    [
      ...(schema === "cloud-v1"
        ? [
            {
              sql: "INSERT OR REPLACE INTO cloud_transaction_guard (id, valid) VALUES (1, CASE WHEN ((SELECT version FROM cloud_schema WHERE id = 1) = 1) THEN 1 ELSE 0 END)",
            },
          ]
        : []),
      ...owned.map((name) => ({ sql: `DELETE FROM "${name}"` })),
    ],
    "write",
  );
}

/** Keep SSM credentials inside one client lifetime, including standalone read-only plans. */
export async function withTursoControlData<T>(
  target: Omit<TursoResetTarget, "schema">,
  action: (client: TursoResetSql) => Promise<T>,
): Promise<T> {
  const ssm = new SSMClient({ region: target.region, ignoreConfiguredEndpointUrls: true });
  let client: Client | undefined;
  let authToken: string | undefined;
  try {
    const response = await ssm.send(
      new GetParameterCommand({ Name: target.parameterName, WithDecryption: true }),
    );
    authToken = response.Parameter?.Value?.trim();
    if (response.Parameter?.Type !== "SecureString" || !authToken)
      throw new Error("Turso token is not a nonempty SSM SecureString.");
    client = createClient({ url: target.databaseUrl, authToken });
    return await action(client);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const redacted = authToken
      ? [authToken, JSON.stringify(authToken).slice(1, -1), encodeURIComponent(authToken)].reduce(
          (text, secret) => text.split(secret).join("[REDACTED]"),
          detail,
        )
      : detail;
    throw new Error(redacted);
  } finally {
    client?.close();
    ssm.destroy();
  }
}

/** Explicit destroy-all uses only the provider identity captured from the deployed stack. */
export function purgeTursoControlData(target: TursoResetTarget): Promise<void> {
  return withTursoControlData(target, (client) => resetKnownTursoData(client, target.schema));
}
