import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DynamoDbEventsRepository } from "./dynamodb-events-repository.js";
import { SqlEventsRepository } from "./sql-events-repository.js";
import type { EventsRepository, SqlExecutor } from "./types.js";

export { DynamoDbEventsRepository } from "./dynamodb-events-repository.js";
export { EVENTS_SCHEMA_SQL, SqlEventsRepository } from "./sql-events-repository.js";
export type {
  ControlDataBackend,
  EventRecord,
  EventsRepository,
  SqlExecutor,
  SqlParam,
  SqlRow,
  SqlRunResult,
} from "./types.js";

/**
 * Dependencies for {@link createEventsRepository}. Only the fields the selected
 * backend needs must be present; the factory fails loudly (never silently falls
 * back) when a required one is missing.
 */
export interface CreateEventsRepositoryDeps {
  /** DynamoDB document client — required for the `dynamodb` backend. */
  readonly ddb?: DynamoDBDocumentClient;
  /** Events table name — required for the `dynamodb` backend. */
  readonly eventsTableName?: string;
  /** SQL driver — required for the `turso` / `sql` backend. */
  readonly sql?: SqlExecutor;
}

/**
 * [ADR-049 §5.1] Cold-start factory that selects the Events backend from the
 * `CONTROL_DATA_BACKEND` flag value (ADR-035 mechanism). **Default = dynamodb**
 * (behavior-preserving): an unset / empty / `"dynamodb"` flag returns the DDB
 * repository, so the existing path is byte-identical. `"turso"` / `"sql"` return
 * the SQLite repository. Any other value is a hard error (fail loud).
 *
 * @param backend the raw `CONTROL_DATA_BACKEND` value (case-insensitive; may be undefined)
 * @param deps    backend-specific dependencies
 */
export function createEventsRepository(
  backend: string | undefined,
  deps: CreateEventsRepositoryDeps,
): EventsRepository {
  const selected = (backend ?? "dynamodb").toLowerCase();

  if (selected === "turso" || selected === "sql") {
    if (!deps.sql) {
      throw new Error(
        `CONTROL_DATA_BACKEND="${backend}" requires a SqlExecutor (deps.sql). ` +
          "The @libsql/Turso adapter is a follow-up (ADR-049 §5.2) and is not wired yet.",
      );
    }
    return new SqlEventsRepository(deps.sql);
  }

  if (selected !== "dynamodb") {
    throw new Error(
      `Unknown CONTROL_DATA_BACKEND="${backend}" (expected one of: dynamodb, turso, sql).`,
    );
  }

  if (!deps.ddb || !deps.eventsTableName) {
    throw new Error("DynamoDbEventsRepository requires deps.ddb and deps.eventsTableName.");
  }
  return new DynamoDbEventsRepository(deps.ddb, deps.eventsTableName);
}
