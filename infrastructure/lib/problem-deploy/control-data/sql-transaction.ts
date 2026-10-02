import type { SqlExecutor, SqlParam, SqlStatement } from "./sql-port.js";

/** A failed predicate is a named CHECK violation, aborting the entire write batch. */
export function sqlGuard(predicate: string, params: readonly SqlParam[] = []): SqlStatement {
  return {
    sql: `INSERT OR REPLACE INTO cloud_transaction_guard (id, valid) VALUES (1, CASE WHEN (${predicate}) THEN 1 ELSE 0 END)`,
    params,
  };
}
/** Must immediately follow the conditional mutation whose row count it checks. */
export function sqlChangesGuard(expected = 1): SqlStatement {
  return sqlGuard("changes() = ?", [expected]);
}
export function sqlIntakeGuard(): SqlStatement {
  return sqlGuard("NOT EXISTS (SELECT 1 FROM cloud_installation_control WHERE id = 1)");
}
/** Do not turn network failures, corruption, or arbitrary constraints into a conflict. */
export function sqlConflict(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = "code" in error ? error.code : undefined;
  const extended = "extendedCode" in error ? error.extendedCode : undefined;
  const errcode = "errcode" in error ? error.errcode : undefined;
  // sqld's replica write proxy wraps primary constraint failures in PROXY_ERROR.
  // Recognize only its exact primary-execution diagnostic and our named CAS
  // guard or fixed-schema uniqueness constraints; transport failures still fail.
  if (code === "PROXY_ERROR") {
    return /^(?:PROXY_ERROR: ){1,2}error executing a request on the primary: (?:CHECK constraint failed: cloud_cas_guard|UNIQUE constraint failed: cloud_[a-z_]+\.[a-z_]+(?:, cloud_[a-z_]+\.[a-z_]+)*)$/u.test(
      error.message,
    );
  }
  if (
    [code, extended].some(
      (value) => value === "SQLITE_CONSTRAINT_PRIMARYKEY" || value === "SQLITE_CONSTRAINT_UNIQUE",
    ) ||
    (code === "ERR_SQLITE_ERROR" && (errcode === 1555 || errcode === 2067))
  )
    return true;
  // Hrana HTTP currently exposes only the server's base code. Require that
  // actual SQLite constraint code plus its precise diagnostic; never classify
  // an arbitrary transport error merely because its text mentions a constraint.
  if (code === "SQLITE_CONSTRAINT" && /(?:^|: )UNIQUE constraint failed: /u.test(error.message))
    return true;
  return (
    (code === "SQLITE_CONSTRAINT" ||
      code === "SQLITE_CONSTRAINT_CHECK" ||
      extended === "SQLITE_CONSTRAINT_CHECK" ||
      (code === "ERR_SQLITE_ERROR" && errcode === 275)) &&
    /(?:^|: )CHECK constraint failed: cloud_cas_guard$/u.test(error.message)
  );
}
export async function sqlCommit(
  sql: SqlExecutor,
  statements: readonly SqlStatement[],
): Promise<boolean> {
  try {
    await sql.batch(statements);
    return true;
  } catch (error) {
    if (sqlConflict(error)) return false;
    throw error;
  }
}
