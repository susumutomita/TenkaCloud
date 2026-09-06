import type { Client, InArgs, InStatement, ResultSet } from "@libsql/client/http";
import { SCORE_SUMMARY_SCHEMA_STATEMENTS } from "./score-summary-schema.js";
import { ADMIN_AUDIT_LOG_SCHEMA_STATEMENTS } from "./sql-admin-audit-log-repository.js";
import { COMPETITOR_ACCOUNTS_SCHEMA_STATEMENTS } from "./sql-competitor-accounts-repository.js";
import { DEPLOYMENTS_SCHEMA_STATEMENTS } from "./sql-deployments-repository.js";
import { DISRUPTIONS_SCHEMA_STATEMENTS } from "./sql-disruptions-repository.js";
import { EVENTS_SCHEMA_STATEMENTS } from "./sql-events-repository.js";
import { FEATURE_FLAGS_SCHEMA_STATEMENTS } from "./sql-feature-flags-repository.js";
import { NOTIFICATIONS_SCHEMA_STATEMENTS } from "./sql-notifications-repository.js";
import { PROBLEM_ENDPOINTS_SCHEMA_STATEMENTS } from "./sql-problem-endpoints-repository.js";
import { SAML_CONFIG_SCHEMA_STATEMENTS } from "./sql-saml-config-repository.js";
import { SAML_IDPS_SCHEMA_STATEMENTS } from "./sql-saml-idps-repository.js";
import { TEAMS_SCHEMA_STATEMENTS } from "./sql-teams-repository.js";
import type { SqlExecutor, SqlParam, SqlRow, SqlRunResult, SqlStatement } from "./types.js";

type LibsqlClient = Pick<Client, "execute" | "batch">;

function statement(sql: string, params: readonly SqlParam[] = []): InStatement {
  return { sql, args: [...params] as InArgs };
}

function rows(result: ResultSet): readonly SqlRow[] {
  return result.rows as readonly SqlRow[];
}

/**
 * Production SqlExecutor for Turso / remote sqld.
 *
 * The HTTP-only entrypoint avoids pulling the native local-SQLite client into
 * the Lambda bundle. Each repository operation maps to one libSQL request.
 */
export class LibsqlExecutor implements SqlExecutor {
  constructor(private readonly client: LibsqlClient) {}

  async run(sql: string, params?: readonly SqlParam[]): Promise<SqlRunResult> {
    const result = await this.client.execute(statement(sql, params));
    return { changes: result.rowsAffected };
  }

  async get(sql: string, params?: readonly SqlParam[]): Promise<SqlRow | undefined> {
    const result = await this.client.execute(statement(sql, params));
    return rows(result)[0];
  }

  async all(sql: string, params?: readonly SqlParam[]): Promise<readonly SqlRow[]> {
    return rows(await this.client.execute(statement(sql, params)));
  }

  async batch(statements: readonly SqlStatement[]): Promise<readonly SqlRunResult[]> {
    // `batch(..., "write")` is libSQL's non-interactive atomic transaction — the
    // same primitive the schema bootstrap below uses. All-or-nothing: a
    // constraint violation rolls every statement back and the error propagates.
    const results = await this.client.batch(
      statements.map((entry) => statement(entry.sql, entry.params)),
      "write",
    );
    return results.map((result) => ({ changes: result.rowsAffected }));
  }
}

/**
 * Idempotent schema bootstrap. `batch(..., "write")` is a non-interactive,
 * atomic transaction, so it does not consume Turso's five-second interactive
 * transaction window.
 */
export async function initializeControlDataSchema(client: LibsqlClient): Promise<void> {
  const statements: InStatement[] = [
    ...EVENTS_SCHEMA_STATEMENTS.map((sql) => statement(sql)),
    ...TEAMS_SCHEMA_STATEMENTS.map((sql) => statement(sql)),
    ...NOTIFICATIONS_SCHEMA_STATEMENTS.map((sql) => statement(sql)),
    ...FEATURE_FLAGS_SCHEMA_STATEMENTS.map((sql) => statement(sql)),
    ...DEPLOYMENTS_SCHEMA_STATEMENTS.map((sql) => statement(sql)),
    ...PROBLEM_ENDPOINTS_SCHEMA_STATEMENTS.map((sql) => statement(sql)),
    ...COMPETITOR_ACCOUNTS_SCHEMA_STATEMENTS.map((sql) => statement(sql)),
    ...SAML_CONFIG_SCHEMA_STATEMENTS.map((sql) => statement(sql)),
    ...SAML_IDPS_SCHEMA_STATEMENTS.map((sql) => statement(sql)),
    ...DISRUPTIONS_SCHEMA_STATEMENTS.map((sql) => statement(sql)),
    ...ADMIN_AUDIT_LOG_SCHEMA_STATEMENTS.map((sql) => statement(sql)),
    ...SCORE_SUMMARY_SCHEMA_STATEMENTS.map((sql) => statement(sql)),
  ];
  await client.batch(statements, "write");
  // Existing installations predate this additive column. Inspect on every
  // bootstrap, and tolerate another cold start winning ALTER only after a
  // fresh schema read confirms the required column actually exists.
  const hasInitializationColumn = async () =>
    (await client.execute(statement("PRAGMA table_info(coordination_run)"))).rows.some(
      (row) => row.name === "pending_initialization",
    );
  if (await hasInitializationColumn()) return;
  try {
    await client.execute(
      statement(
        "ALTER TABLE coordination_run ADD COLUMN pending_initialization INTEGER NOT NULL DEFAULT 0",
      ),
    );
  } catch (error) {
    if (!(await hasInitializationColumn())) throw error;
  }
}
