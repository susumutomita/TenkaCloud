import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DynamoDbFeatureFlagsRepository } from "./dynamodb-feature-flags-repository.js";
import { SqlFeatureFlagsRepository } from "./sql-feature-flags-repository.js";
import type { FeatureFlagsRepository, SqlExecutor } from "./types.js";

export { DynamoDbFeatureFlagsRepository } from "./dynamodb-feature-flags-repository.js";
export { SqlFeatureFlagsRepository } from "./sql-feature-flags-repository.js";
export type { FeatureFlagsRepository, SqlExecutor, TenantFeatureFlagsRecord } from "./types.js";

/**
 * Dependencies for {@link createFeatureFlagsRepository}. Only the fields the
 * selected backend needs must be present; the factory fails loudly (never
 * silently falls back) when a required one is missing.
 */
export interface CreateFeatureFlagsRepositoryDeps {
  /** DynamoDB document client — required for the `dynamodb` backend. */
  readonly ddb?: DynamoDBDocumentClient;
  /** Events table name — required for the `dynamodb` backend. */
  readonly eventsTableName?: string;
  /** SQL driver — required for the `turso` backend. */
  readonly sql?: SqlExecutor;
}

/**
 * [ADR-049 §5.1] Cold-start factory that selects the FeatureFlags backend from
 * the `CONTROL_DATA_BACKEND` flag value. **Default = dynamodb**
 * (behavior-preserving): an unset / empty / `"dynamodb"` flag returns the DDB
 * repository. `"turso"` returns the SQLite repository. Any other value
 * is a hard error (fail loud).
 */
export function createFeatureFlagsRepository(
  backend: string | undefined,
  deps: CreateFeatureFlagsRepositoryDeps,
): FeatureFlagsRepository {
  const selected = (backend ?? "dynamodb").toLowerCase();

  if (selected === "turso") {
    if (!deps.sql) {
      throw new Error(
        `CONTROL_DATA_BACKEND="${backend}" requires a SqlExecutor (deps.sql). ` +
          "The @libsql/Turso adapter is a follow-up (ADR-049 §5.2) and is not wired yet.",
      );
    }
    return new SqlFeatureFlagsRepository(deps.sql);
  }

  if (selected !== "dynamodb") {
    throw new Error(
      `Unknown CONTROL_DATA_BACKEND="${backend}" (expected one of: dynamodb, turso).`,
    );
  }

  if (!deps.ddb || !deps.eventsTableName) {
    throw new Error("DynamoDbFeatureFlagsRepository requires deps.ddb and deps.eventsTableName.");
  }
  return new DynamoDbFeatureFlagsRepository(deps.ddb, deps.eventsTableName);
}
