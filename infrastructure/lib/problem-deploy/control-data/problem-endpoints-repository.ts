import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DynamoDbProblemEndpointsRepository } from "./dynamodb-problem-endpoints-repository.js";
import { SqlProblemEndpointsRepository } from "./sql-problem-endpoints-repository.js";
import type { ProblemEndpointsRepository, SqlExecutor } from "./types.js";

export { DynamoDbProblemEndpointsRepository } from "./dynamodb-problem-endpoints-repository.js";
export { SqlProblemEndpointsRepository } from "./sql-problem-endpoints-repository.js";
export type { ProblemEndpointsRepository } from "./types.js";

/**
 * Dependencies for {@link createProblemEndpointsRepository}. Only the fields the
 * selected backend needs must be present; the factory fails loudly (never
 * silently falls back) when a required one is missing.
 */
export interface CreateProblemEndpointsRepositoryDeps {
  /** DynamoDB document client — required for the `dynamodb` backend. */
  readonly ddb?: DynamoDBDocumentClient;
  /** ProblemEndpoints table name — required for the `dynamodb` backend. */
  readonly endpointsTableName?: string;
  /** SQL driver — required for the `turso` backend. */
  readonly sql?: SqlExecutor;
}

/**
 * [Issue #2442 / Phase C1] Cold-start factory that selects the ProblemEndpoints
 * backend from the `CONTROL_DATA_BACKEND` flag value (ADR-035 mechanism; mirror
 * of `createTeamsRepository` / `createDeploymentsRepository`). **Default =
 * dynamodb** (behavior-preserving): an unset / empty / `"dynamodb"` flag
 * returns the DDB repository, so the existing path is byte-identical.
 *
 * `"turso"` returns the SQLite repository. Any other value is a hard
 * error (fail loud). Mirror mode is composed by `runtime-repositories.ts`, not
 * this aggregate factory.
 *
 * @param backend the raw `CONTROL_DATA_BACKEND` value (case-insensitive; may be undefined)
 * @param deps    backend-specific dependencies
 */
export function createProblemEndpointsRepository(
  backend: string | undefined,
  deps: CreateProblemEndpointsRepositoryDeps,
): ProblemEndpointsRepository {
  const selected = (backend ?? "dynamodb").toLowerCase();

  if (selected === "turso") {
    if (!deps.sql) {
      throw new Error(`CONTROL_DATA_BACKEND="${backend}" requires a SqlExecutor (deps.sql).`);
    }
    return new SqlProblemEndpointsRepository(deps.sql);
  }

  if (selected !== "dynamodb") {
    throw new Error(
      `Unknown CONTROL_DATA_BACKEND="${backend}" (expected one of: dynamodb, turso).`,
    );
  }

  if (!deps.ddb || !deps.endpointsTableName) {
    throw new Error(
      "DynamoDbProblemEndpointsRepository requires deps.ddb and deps.endpointsTableName.",
    );
  }
  return new DynamoDbProblemEndpointsRepository(deps.ddb, deps.endpointsTableName);
}
