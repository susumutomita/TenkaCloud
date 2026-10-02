import { CONTROL_DATA_SCHEMA_STATEMENTS, SQL_SCHEMA_VERSION } from "./sql-control-schema.js";
import type { SqlExecutor } from "./sql-port.js";
import { sqlGuard } from "./sql-transaction.js";

// Derive ownership from our fixed schema, never from arbitrary database tables.
// Historical Lite tables and other applications' rows are not migrated or reset.
const ownedTables = CONTROL_DATA_SCHEMA_STATEMENTS.flatMap((statement) => {
  const match = /^CREATE TABLE IF NOT EXISTS (cloud_[a-z_]+) \(/u.exec(statement);
  return match?.[1] && match[1] !== "cloud_schema" ? [match[1]] : [];
});

/** Explicit destroy-all/reset operation. Callers own user confirmation and scope verification. */
export async function resetControlData(sql: SqlExecutor): Promise<void> {
  await sql.batch([
    sqlGuard("(SELECT version FROM cloud_schema WHERE id = 1) = ?", [SQL_SCHEMA_VERSION]),
    ...ownedTables.map((table) => ({ sql: `DELETE FROM ${table}` })),
  ]);
}
