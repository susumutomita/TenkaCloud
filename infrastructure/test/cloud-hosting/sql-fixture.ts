import { DatabaseSync } from "node:sqlite";
import { CONTROL_DATA_SCHEMA_STATEMENTS } from "../../lib/problem-deploy/control-data/sql-control-schema.js";
import type { SqlExecutor, SqlStatement } from "../../lib/problem-deploy/control-data/sql-port.js";

/** Real SQLite transaction behavior, including CHECK failures and JSON predicates. */
export function sqliteFixture(path = ":memory:") {
  const db = new DatabaseSync(path);
  const sql: SqlExecutor = {
    run: (statement, params = []) => db.prepare(statement).run(...params),
    get: (statement, params = []) => db.prepare(statement).get(...params),
    all: (statement, params = []) => db.prepare(statement).all(...params),
    batch: (statements: readonly SqlStatement[]) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map(({ sql: statement, params = [] }) =>
          db.prepare(statement).run(...params),
        );
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
  for (const statement of CONTROL_DATA_SCHEMA_STATEMENTS) db.exec(statement);
  return { db, sql, close: () => db.close() };
}
