import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DynamoDbCompetitorAccountsRepository } from "./dynamodb-competitor-accounts-repository.js";
import { SqlCompetitorAccountsRepository } from "./sql-competitor-accounts-repository.js";
import type { CompetitorAccountsRepository, SqlExecutor } from "./types.js";

export { DynamoDbCompetitorAccountsRepository } from "./dynamodb-competitor-accounts-repository.js";
export { SqlCompetitorAccountsRepository } from "./sql-competitor-accounts-repository.js";
export type { CompetitorAccountsRepository } from "./types.js";

/**
 * Dependencies for {@link createCompetitorAccountsRepository}. Only the fields
 * the selected backend needs must be present; the factory fails loudly (never
 * silently falls back) when a required one is missing.
 */
export interface CreateCompetitorAccountsRepositoryDeps {
  /** DynamoDB document client — required for the `dynamodb` backend. */
  readonly ddb?: DynamoDBDocumentClient;
  /** CompetitorAccounts table name — required for the `dynamodb` backend. */
  readonly competitorAccountsTableName?: string;
  /** SQL driver — required for the `turso` backend. */
  readonly sql?: SqlExecutor;
}

/**
 * [Issue #2442 / Phase C2] Cold-start factory that selects the
 * CompetitorAccounts backend from the `CONTROL_DATA_BACKEND` flag value
 * (mirrors `createProblemEndpointsRepository` /
 * `createTeamsRepository`). **Default = dynamodb** (behavior-preserving): an
 * unset / empty / `"dynamodb"` flag returns the DDB repository, so the
 * existing path is byte-identical.
 *
 * `"turso"` returns the SQLite repository. Any other value is a hard
 * error (fail loud). Mirror mode is composed by `runtime-repositories.ts`, not
 * this aggregate factory.
 *
 * @param backend the raw `CONTROL_DATA_BACKEND` value (case-insensitive; may be undefined)
 * @param deps    backend-specific dependencies
 */
export function createCompetitorAccountsRepository(
  backend: string | undefined,
  deps: CreateCompetitorAccountsRepositoryDeps,
): CompetitorAccountsRepository {
  const selected = (backend ?? "dynamodb").toLowerCase();

  if (selected === "turso") {
    if (!deps.sql) {
      throw new Error(`CONTROL_DATA_BACKEND="${backend}" requires a SqlExecutor (deps.sql).`);
    }
    return new SqlCompetitorAccountsRepository(deps.sql);
  }

  if (selected !== "dynamodb") {
    throw new Error(
      `Unknown CONTROL_DATA_BACKEND="${backend}" (expected one of: dynamodb, turso).`,
    );
  }

  if (!deps.ddb || !deps.competitorAccountsTableName) {
    throw new Error(
      "DynamoDbCompetitorAccountsRepository requires deps.ddb and deps.competitorAccountsTableName.",
    );
  }
  return new DynamoDbCompetitorAccountsRepository(deps.ddb, deps.competitorAccountsTableName);
}
