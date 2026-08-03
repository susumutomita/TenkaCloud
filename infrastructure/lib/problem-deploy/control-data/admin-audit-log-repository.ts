import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DynamoDbAdminAuditLogRepository } from "./dynamodb-admin-audit-log-repository.js";
import { SqlAdminAuditLogRepository } from "./sql-admin-audit-log-repository.js";
import type { AdminAuditLogRepository, SqlExecutor } from "./types.js";

export { DynamoDbAdminAuditLogRepository } from "./dynamodb-admin-audit-log-repository.js";
export { SqlAdminAuditLogRepository } from "./sql-admin-audit-log-repository.js";
export type { AdminAuditLogRepository } from "./types.js";

/**
 * Dependencies for {@link createAdminAuditLogRepository}. Only the fields the selected backend
 * needs must be present; the factory fails loudly (never silently falls back) when a required
 * one is missing.
 */
export interface CreateAdminAuditLogRepositoryDeps {
  /** DynamoDB document client — required for the `dynamodb` backend. */
  readonly ddb?: DynamoDBDocumentClient;
  /** AdminAuditLog table name — required for the `dynamodb` backend. */
  readonly adminAuditLogTableName?: string;
  /** SQL driver — required for the `turso` backend. */
  readonly sql?: SqlExecutor;
}

/**
 * [Issue #2442 / Phase C4] Cold-start factory that selects the AdminAuditLog backend from the
 * `CONTROL_DATA_BACKEND` flag value (ADR-035 mechanism; mirror of
 * `createDisruptionsRepository` / `createCompetitorAccountsRepository`). **Default = dynamodb**
 * (behavior-preserving): an unset / empty / `"dynamodb"` flag returns the DDB repository, so the
 * existing path is byte-identical.
 *
 * `"turso"` returns the SQLite repository. Any other value is a hard error (fail loud).
 * Mirror mode is composed by `runtime-repositories.ts`, not this aggregate factory.
 *
 * @param backend the raw `CONTROL_DATA_BACKEND` value (case-insensitive; may be undefined)
 * @param deps    backend-specific dependencies
 */
export function createAdminAuditLogRepository(
  backend: string | undefined,
  deps: CreateAdminAuditLogRepositoryDeps,
): AdminAuditLogRepository {
  const selected = (backend ?? "dynamodb").toLowerCase();

  if (selected === "turso") {
    if (!deps.sql) {
      throw new Error(`CONTROL_DATA_BACKEND="${backend}" requires a SqlExecutor (deps.sql).`);
    }
    return new SqlAdminAuditLogRepository(deps.sql);
  }

  if (selected !== "dynamodb") {
    throw new Error(
      `Unknown CONTROL_DATA_BACKEND="${backend}" (expected one of: dynamodb, turso).`,
    );
  }

  if (!deps.ddb || !deps.adminAuditLogTableName) {
    throw new Error(
      "DynamoDbAdminAuditLogRepository requires deps.ddb and deps.adminAuditLogTableName.",
    );
  }
  return new DynamoDbAdminAuditLogRepository(deps.ddb, deps.adminAuditLogTableName);
}
