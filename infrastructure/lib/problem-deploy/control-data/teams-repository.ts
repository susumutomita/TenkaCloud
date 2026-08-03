import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DynamoDbTeamsRepository } from "./dynamodb-teams-repository.js";
import { SqlTeamsRepository } from "./sql-teams-repository.js";
import type { SqlExecutor, TeamsRepository } from "./types.js";

export { DynamoDbTeamsRepository } from "./dynamodb-teams-repository.js";
export {
  hashLoginKey,
  SqlTeamsRepository,
  TEAM_LOGIN_KEY_SCRUB_MIGRATION_ID,
  TEAM_LOGIN_KEY_SCRUB_SQL,
} from "./sql-teams-repository.js";
export type {
  SqlExecutor,
  TeamDeploymentRecord,
  TeamRecord,
  TeamsRepository,
} from "./types.js";

/**
 * Dependencies for {@link createTeamsRepository}. Only the fields the selected
 * backend needs must be present; the factory fails loudly (never silently falls
 * back) when a required one is missing.
 */
export interface CreateTeamsRepositoryDeps {
  /** DynamoDB document client — required for the `dynamodb` backend. */
  readonly ddb?: DynamoDBDocumentClient;
  /** Teams table name — required for the `dynamodb` backend. */
  readonly teamsTableName?: string;
  /** Deployments table name — required only by login-key rotation. */
  readonly deploymentsTableName?: string;
  /** SQL driver — required for the `turso` backend. */
  readonly sql?: SqlExecutor;
}

/**
 * [ADR-049 §5.1] Cold-start factory that selects the Teams backend from the
 * `CONTROL_DATA_BACKEND` flag value (ADR-035 mechanism; mirror of
 * `createEventsRepository`). **Default = dynamodb** (behavior-preserving): an
 * unset / empty / `"dynamodb"` flag returns the DDB repository, so the existing
 * path is byte-identical. `"turso"` returns the SQLite repository. Any
 * other value is a hard error (fail loud).
 *
 * @param backend the raw `CONTROL_DATA_BACKEND` value (case-insensitive; may be undefined)
 * @param deps    backend-specific dependencies
 */
export function createTeamsRepository(
  backend: string | undefined,
  deps: CreateTeamsRepositoryDeps,
): TeamsRepository {
  const selected = (backend ?? "dynamodb").toLowerCase();

  if (selected === "turso") {
    if (!deps.sql) {
      throw new Error(
        `CONTROL_DATA_BACKEND="${backend}" requires a SqlExecutor (deps.sql). ` +
          "The @libsql/Turso adapter is a follow-up (ADR-049 §5.2) and is not wired yet.",
      );
    }
    return new SqlTeamsRepository(deps.sql);
  }

  if (selected !== "dynamodb") {
    throw new Error(
      `Unknown CONTROL_DATA_BACKEND="${backend}" (expected one of: dynamodb, turso).`,
    );
  }

  if (!deps.ddb || !deps.teamsTableName) {
    throw new Error("DynamoDbTeamsRepository requires deps.ddb and deps.teamsTableName.");
  }
  return new DynamoDbTeamsRepository(deps.ddb, deps.teamsTableName, deps.deploymentsTableName);
}
