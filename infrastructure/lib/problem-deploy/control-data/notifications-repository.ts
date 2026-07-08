import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DynamoDbNotificationsRepository } from "./dynamodb-notifications-repository.js";
import { SqlNotificationsRepository } from "./sql-notifications-repository.js";
import type { NotificationsRepository, SqlExecutor } from "./types.js";

export { DynamoDbNotificationsRepository } from "./dynamodb-notifications-repository.js";
export {
  NOTIFICATIONS_SCHEMA_SQL,
  SqlNotificationsRepository,
} from "./sql-notifications-repository.js";
export type {
  ControlDataBackend,
  NotificationRecord,
  NotificationsPage,
  NotificationsRepository,
  SqlExecutor,
  SqlParam,
  SqlRow,
  SqlRunResult,
} from "./types.js";

/**
 * Dependencies for {@link createNotificationsRepository}. Only the fields the
 * selected backend needs must be present; the factory fails loudly (never
 * silently falls back) when a required one is missing.
 */
export interface CreateNotificationsRepositoryDeps {
  /** DynamoDB document client — required for the `dynamodb` backend. */
  readonly ddb?: DynamoDBDocumentClient;
  /** Events table name — required for the `dynamodb` backend. */
  readonly eventsTableName?: string;
  /** SQL driver — required for the `turso` / `sql` backend. */
  readonly sql?: SqlExecutor;
}

/**
 * [ADR-049 §5.1] Cold-start factory that selects the Notifications backend from
 * the `CONTROL_DATA_BACKEND` flag value. **Default = dynamodb**
 * (behavior-preserving): an unset / empty / `"dynamodb"` flag returns the DDB
 * repository. `"turso"` / `"sql"` return the SQLite repository. Any other value
 * is a hard error (fail loud).
 */
export function createNotificationsRepository(
  backend: string | undefined,
  deps: CreateNotificationsRepositoryDeps,
): NotificationsRepository {
  const selected = (backend ?? "dynamodb").toLowerCase();

  if (selected === "turso" || selected === "sql") {
    if (!deps.sql) {
      throw new Error(
        `CONTROL_DATA_BACKEND="${backend}" requires a SqlExecutor (deps.sql). ` +
          "The @libsql/Turso adapter is a follow-up (ADR-049 §5.2) and is not wired yet.",
      );
    }
    return new SqlNotificationsRepository(deps.sql);
  }

  if (selected !== "dynamodb") {
    throw new Error(
      `Unknown CONTROL_DATA_BACKEND="${backend}" (expected one of: dynamodb, turso, sql).`,
    );
  }

  if (!deps.ddb || !deps.eventsTableName) {
    throw new Error("DynamoDbNotificationsRepository requires deps.ddb and deps.eventsTableName.");
  }
  return new DynamoDbNotificationsRepository(deps.ddb, deps.eventsTableName);
}
