import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DynamoDbDeploymentsRepository } from "./dynamodb-deployments-repository.js";
import type { DeploymentsRepository } from "./types.js";

export { DynamoDbDeploymentsRepository } from "./dynamodb-deployments-repository.js";
export type {
  ControlDataBackend,
  CoordinationStateRecord,
  DeploymentRecord,
  DeploymentsPage,
  DeploymentsRepository,
  InboxEventRecord,
  ScoreEventRecord,
} from "./types.js";

/**
 * Dependencies for {@link createDeploymentsRepository}. Only the fields the
 * selected backend needs must be present; the factory fails loudly (never
 * silently falls back) when a required one is missing.
 */
export interface CreateDeploymentsRepositoryDeps {
  /** DynamoDB document client — required for the `dynamodb` backend. */
  readonly ddb?: DynamoDBDocumentClient;
  /** Deployments table name — required for the `dynamodb` backend. */
  readonly deploymentsTableName?: string;
}

/**
 * [Issue #2441 / Phase B1] Cold-start factory that selects the Deployments READ
 * backend from the `CONTROL_DATA_BACKEND` flag value (ADR-035 mechanism; mirror
 * of `createEventsRepository` / `createTeamsRepository`). **Default = dynamodb**
 * (behavior-preserving): an unset / empty / `"dynamodb"` flag returns the DDB
 * repository, so the existing path is byte-identical.
 *
 * `"turso"` / `"sql"` fail loudly: the SQL implementation of the Deployments
 * seam lands in **Phase B4 (#2441)** — B1 ships only the DynamoDB backend plus
 * the interface. Any other value is a hard error (fail loud).
 *
 * @param backend the raw `CONTROL_DATA_BACKEND` value (case-insensitive; may be undefined)
 * @param deps    backend-specific dependencies
 */
export function createDeploymentsRepository(
  backend: string | undefined,
  deps: CreateDeploymentsRepositoryDeps,
): DeploymentsRepository {
  const selected = (backend ?? "dynamodb").toLowerCase();

  if (selected === "turso" || selected === "sql") {
    throw new Error(
      `CONTROL_DATA_BACKEND="${backend}" is not yet supported for the Deployments seam: ` +
        "the SQL implementation lands in Phase B4 (#2441).",
    );
  }

  if (selected !== "dynamodb") {
    throw new Error(
      `Unknown CONTROL_DATA_BACKEND="${backend}" (expected one of: dynamodb, turso, sql).`,
    );
  }

  if (!deps.ddb || !deps.deploymentsTableName) {
    throw new Error(
      "DynamoDbDeploymentsRepository requires deps.ddb and deps.deploymentsTableName.",
    );
  }
  return new DynamoDbDeploymentsRepository(deps.ddb, deps.deploymentsTableName);
}
