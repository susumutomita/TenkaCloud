import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DynamoDbSamlConfigRepository } from "./dynamodb-saml-config-repository.js";
import { SqlSamlConfigRepository } from "./sql-saml-config-repository.js";
import type { SamlConfigRepository, SqlExecutor } from "./types.js";

export { DynamoDbSamlConfigRepository } from "./dynamodb-saml-config-repository.js";
export { SqlSamlConfigRepository } from "./sql-saml-config-repository.js";
export type { SamlConfigRepository } from "./types.js";

/**
 * Dependencies for {@link createSamlConfigRepository}. Only the fields the
 * selected backend needs must be present; the factory fails loudly (never
 * silently falls back) when a required one is missing.
 */
export interface CreateSamlConfigRepositoryDeps {
  /** DynamoDB document client — required for the `dynamodb` backend. */
  readonly ddb?: DynamoDBDocumentClient;
  /** CompetitorAccounts table name (SAML_CONFIG shares its partition) — required for `dynamodb`. */
  readonly competitorAccountsTableName?: string;
  /** SQL driver — required for the `turso` backend. */
  readonly sql?: SqlExecutor;
}

/**
 * [Issue #2442 / Phase C2] Cold-start factory that selects the SamlConfig
 * backend from the `CONTROL_DATA_BACKEND` flag value (mirror of
 * `createCompetitorAccountsRepository`). **Default = dynamodb**
 * (behavior-preserving).
 */
export function createSamlConfigRepository(
  backend: string | undefined,
  deps: CreateSamlConfigRepositoryDeps,
): SamlConfigRepository {
  const selected = (backend ?? "dynamodb").toLowerCase();

  if (selected === "turso") {
    if (!deps.sql) {
      throw new Error(`CONTROL_DATA_BACKEND="${backend}" requires a SqlExecutor (deps.sql).`);
    }
    return new SqlSamlConfigRepository(deps.sql);
  }

  if (selected !== "dynamodb") {
    throw new Error(
      `Unknown CONTROL_DATA_BACKEND="${backend}" (expected one of: dynamodb, turso).`,
    );
  }

  if (!deps.ddb || !deps.competitorAccountsTableName) {
    throw new Error(
      "DynamoDbSamlConfigRepository requires deps.ddb and deps.competitorAccountsTableName.",
    );
  }
  return new DynamoDbSamlConfigRepository(deps.ddb, deps.competitorAccountsTableName);
}
