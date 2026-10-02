import type { Client, InArgs, InStatement, ResultSet } from "@libsql/client/http";
import { CONTROL_DATA_SCHEMA_STATEMENTS, SQL_SCHEMA_VERSION } from "./sql-control-schema.js";
import type { SqlExecutor, SqlParam, SqlRow, SqlRunResult, SqlStatement } from "./sql-port.js";

type LibsqlClient = Pick<Client, "execute" | "batch">;

function statement(sql: string, params: readonly SqlParam[] = []): InStatement {
  return { sql, args: [...params] as InArgs };
}

function rows(result: ResultSet): readonly SqlRow[] {
  return result.rows as readonly SqlRow[];
}

/**
 * Production SqlExecutor for Turso / remote sqld.
 *
 * The HTTP-only entrypoint avoids pulling the native local-SQLite client into
 * the Lambda bundle. Each repository operation maps to one libSQL request.
 */
export class LibsqlExecutor implements SqlExecutor {
  constructor(private readonly client: LibsqlClient) {}

  async run(sql: string, params?: readonly SqlParam[]): Promise<SqlRunResult> {
    const result = await this.client.execute(statement(sql, params));
    return { changes: result.rowsAffected };
  }

  async get(sql: string, params?: readonly SqlParam[]): Promise<SqlRow | undefined> {
    return (await this.all(sql, params))[0];
  }

  async all(sql: string, params?: readonly SqlParam[]): Promise<readonly SqlRow[]> {
    // libSQL replicas classify BEGIN/SELECT/COMMIT as a read-only program.
    // A zero-row UPDATE makes the whole batch route to the primary without
    // changing data. Auth revocation and other authority checks cannot use
    // replica-local reads. One HTTP request, with a short primary write lock.
    // https://github.com/tursodatabase/libsql/blob/main/libsql-server/src/query_analysis.rs
    const results = await this.client.batch(
      [statement("UPDATE cloud_schema SET version = version WHERE 0"), statement(sql, params)],
      "write",
    );
    const result = results[1];
    if (!result) throw new Error("Missing authoritative SQL query result.");
    return rows(result);
  }

  async batch(statements: readonly SqlStatement[]): Promise<readonly SqlRunResult[]> {
    // `batch(..., "write")` is libSQL's non-interactive atomic transaction — the
    // same primitive the schema bootstrap below uses. All-or-nothing: a
    // constraint violation rolls every statement back and the error propagates.
    const results = await this.client.batch(
      statements.map((entry) => statement(entry.sql, entry.params)),
      "write",
    );
    return results.map((result) => ({ changes: result.rowsAffected }));
  }
}

/**
 * Idempotent schema bootstrap. `batch(..., "write")` is a non-interactive,
 * atomic transaction, so it does not consume Turso's five-second interactive
 * transaction window.
 */
export async function initializeControlDataSchema(client: LibsqlClient): Promise<void> {
  const results = await client.batch(
    [
      ...CONTROL_DATA_SCHEMA_STATEMENTS.map((sql) => statement(sql)),
      statement("SELECT version FROM cloud_schema WHERE id = 1"),
    ],
    "write",
  );
  // Read schema identity in the same primary transaction, without a later
  // replica-local SELECT racing replication of the newly created schema.
  if (results.at(-1)?.rows[0]?.version !== SQL_SCHEMA_VERSION)
    throw new Error("Unsupported cloud control-data schema version.");
}
