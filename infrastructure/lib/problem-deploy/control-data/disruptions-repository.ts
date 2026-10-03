import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DynamoDbDisruptionsRepository } from "./dynamodb-disruptions-repository.js";
import { SqlDisruptionsRepository } from "./sql-disruptions-repository.js";
import type { DisruptionsRepository, SqlExecutor } from "./types.js";

export { DynamoDbDisruptionsRepository } from "./dynamodb-disruptions-repository.js";
export { SqlDisruptionsRepository } from "./sql-disruptions-repository.js";
export type { DisruptionsRepository } from "./types.js";

/**
 * Dependencies for {@link createDisruptionsRepository}. Only the fields the selected backend
 * needs must be present; the factory fails loudly (never silently falls back) when a required
 * one is missing.
 */
export interface CreateDisruptionsRepositoryDeps {
  /** DynamoDB document client — required for the `dynamodb` backend. */
  readonly ddb?: DynamoDBDocumentClient;
  /** Disruptions table name — required for the `dynamodb` backend. */
  readonly disruptionsTableName?: string;
  /** SQL driver — required for the `turso` backend. */
  readonly sql?: SqlExecutor;
}

/**
 * [Issue #2442 / Phase C3] Cold-start factory that selects the Disruptions backend from the
 * `CONTROL_DATA_BACKEND` flag value (mirrors
 * `createCompetitorAccountsRepository` / `createProblemEndpointsRepository`). **Default =
 * dynamodb** (behavior-preserving): an unset / empty / `"dynamodb"` flag returns the DDB
 * repository, so the existing path is byte-identical.
 *
 * `"turso"` returns the SQLite repository. Any other value is a hard error (fail
 * loud). Mirror mode is composed by `runtime-repositories.ts`, not this aggregate factory.
 *
 * @param backend the raw `CONTROL_DATA_BACKEND` value (case-insensitive; may be undefined)
 * @param deps    backend-specific dependencies
 */
export function createDisruptionsRepository(
  backend: string | undefined,
  deps: CreateDisruptionsRepositoryDeps,
): DisruptionsRepository {
  const selected = (backend ?? "dynamodb").toLowerCase();

  if (selected === "turso") {
    if (!deps.sql) {
      throw new Error(`CONTROL_DATA_BACKEND="${backend}" requires a SqlExecutor (deps.sql).`);
    }
    return new SqlDisruptionsRepository(deps.sql);
  }

  if (selected !== "dynamodb") {
    throw new Error(
      `Unknown CONTROL_DATA_BACKEND="${backend}" (expected one of: dynamodb, turso).`,
    );
  }

  if (!deps.ddb || !deps.disruptionsTableName) {
    throw new Error(
      "DynamoDbDisruptionsRepository requires deps.ddb and deps.disruptionsTableName.",
    );
  }
  return new DynamoDbDisruptionsRepository(deps.ddb, deps.disruptionsTableName);
}
