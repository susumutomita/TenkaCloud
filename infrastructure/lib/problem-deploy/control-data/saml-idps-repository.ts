import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DynamoDbSamlIdpsRepository } from "./dynamodb-saml-idps-repository.js";
import { SqlSamlIdpsRepository } from "./sql-saml-idps-repository.js";
import type { SamlIdpsRepository, SqlExecutor } from "./types.js";

export { DynamoDbSamlIdpsRepository } from "./dynamodb-saml-idps-repository.js";
export { SqlSamlIdpsRepository } from "./sql-saml-idps-repository.js";
export type { SamlIdpsRepository } from "./types.js";

/**
 * Dependencies for {@link createSamlIdpsRepository}. Only the fields the
 * selected backend needs must be present; the factory fails loudly (never
 * silently falls back) when a required one is missing.
 */
export interface CreateSamlIdpsRepositoryDeps {
  /** DynamoDB document client — required for the `dynamodb` backend. */
  readonly ddb?: DynamoDBDocumentClient;
  /** SamlIdps table name — required for the `dynamodb` backend. */
  readonly samlIdpsTableName?: string;
  /** SQL driver — required for the `turso` backend. */
  readonly sql?: SqlExecutor;
}

/**
 * [Issue #2442 / Phase C5] Cold-start factory that selects the SamlIdps backend
 * from the `CONTROL_DATA_BACKEND` flag value (mirror of
 * `createProblemEndpointsRepository`). **Default = dynamodb**
 * (behavior-preserving): an unset / empty / `"dynamodb"` flag returns the DDB
 * repository, so the existing path is byte-identical.
 *
 * `"turso"` returns the SQLite repository. Any other value is a hard
 * error (fail loud). Mirror mode is composed by `runtime-repositories.ts`, not
 * this aggregate factory.
 *
 * @param backend the raw `CONTROL_DATA_BACKEND` value (case-insensitive; may be undefined)
 * @param deps    backend-specific dependencies
 */
export function createSamlIdpsRepository(
  backend: string | undefined,
  deps: CreateSamlIdpsRepositoryDeps,
): SamlIdpsRepository {
  const selected = (backend ?? "dynamodb").toLowerCase();

  if (selected === "turso") {
    if (!deps.sql) {
      throw new Error(`CONTROL_DATA_BACKEND="${backend}" requires a SqlExecutor (deps.sql).`);
    }
    return new SqlSamlIdpsRepository(deps.sql);
  }

  if (selected !== "dynamodb") {
    throw new Error(
      `Unknown CONTROL_DATA_BACKEND="${backend}" (expected one of: dynamodb, turso).`,
    );
  }

  if (!deps.ddb || !deps.samlIdpsTableName) {
    throw new Error("DynamoDbSamlIdpsRepository requires deps.ddb and deps.samlIdpsTableName.");
  }
  return new DynamoDbSamlIdpsRepository(deps.ddb, deps.samlIdpsTableName);
}
