import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";
import { createClient } from "@libsql/client/http";

type Cell =
  | { type: "null" }
  | { type: "integer" | "text"; value: string }
  | { type: "float"; value: number };
interface Statement {
  sql?: string;
  sql_id?: number;
  args: Cell[];
  want_rows: boolean;
}
type Condition =
  | { type: "ok" | "error"; step: number }
  | { type: "not"; cond: Condition }
  | { type: "and" | "or"; conds: Condition[] };
interface Step {
  stmt: Statement;
  condition?: Condition;
}
type RequestBody =
  | { type: "execute"; stmt: Statement }
  | { type: "batch"; batch: { steps: Step[] } }
  | { type: "store_sql"; sql_id: number; sql: string }
  | { type: "close_sql"; sql_id: number }
  | { type: "close" };
interface Result {
  cols: { name: string }[];
  rows: Cell[][];
  affected_row_count: number;
  last_insert_rowid?: string;
}
function encode(value: SQLOutputValue): Cell {
  if (value === null) return { type: "null" };
  if (typeof value === "string") return { type: "text", value };
  if (typeof value === "bigint") return { type: "integer", value: value.toString() };
  if (typeof value === "number") return { type: "float", value };
  throw new Error("Unexpected blob in control-data fixture");
}
function decode(value: Cell): SQLInputValue {
  if (value.type === "null") return null;
  if (value.type === "integer") return BigInt(value.value);
  return value.value;
}
function conditionMatches(
  condition: Condition | undefined,
  results: (Result | null)[],
  errors: unknown[],
): boolean {
  if (!condition) return true;
  switch (condition.type) {
    case "ok":
      return results[condition.step] !== null;
    case "error":
      return errors[condition.step] !== null;
    case "not":
      return !conditionMatches(condition.cond, results, errors);
    case "and":
      return condition.conds.every((item) => conditionMatches(item, results, errors));
    case "or":
      return condition.conds.some((item) => conditionMatches(item, results, errors));
  }
}

function sqliteError(error: unknown): { code: string; message: string } {
  if (!(error instanceof Error)) throw error;
  const errcode = "errcode" in error ? error.errcode : undefined;
  return {
    code: [275, 1555, 2067].includes(Number(errcode)) ? "SQLITE_CONSTRAINT" : "SQLITE_ERROR",
    message: error.message,
  };
}

/** Real HTTP client/JSON protocol, with requests executed only against in-memory SQLite. */
export function sqlHttpFixture() {
  const db = new DatabaseSync(":memory:");
  const queries = new Map<number, string>();
  const requests: RequestBody[] = [];
  const httpRequests: Request[] = [];
  const executedStatements: string[] = [];
  function execute(stmt: Statement): Result {
    const sql = stmt.sql ?? queries.get(stmt.sql_id ?? -1);
    if (!sql) throw new Error("Missing statement SQL");
    executedStatements.push(sql);
    const prepared = db.prepare(sql);
    const cols = prepared.columns().map((column) => ({ name: column.name }));
    const params = stmt.args.map(decode);
    if (cols.length) {
      const rows = prepared.all(...params);
      return {
        cols,
        rows: stmt.want_rows
          ? rows.map((row) => cols.map((col) => encode(row[col.name] ?? null)))
          : [],
        affected_row_count: 0,
      };
    }
    const result = prepared.run(...params);
    return {
      cols: [],
      rows: [],
      affected_row_count: Number(result.changes),
      last_insert_rowid: result.lastInsertRowid.toString(),
    };
  }
  function batch(steps: Step[]) {
    const results: (Result | null)[] = [];
    const errors: ({ code: string; message: string } | null)[] = [];
    for (const step of steps) {
      if (!conditionMatches(step.condition, results, errors)) {
        results.push(null);
        errors.push(null);
        continue;
      }
      try {
        results.push(execute(step.stmt));
        errors.push(null);
      } catch (error) {
        results.push(null);
        errors.push(sqliteError(error));
      }
    }
    return { step_results: results, step_errors: errors };
  }
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    httpRequests.push(request);
    const body = (await request.json()) as { requests: RequestBody[] };
    const results = body.requests.map((item) => {
      requests.push(item);
      switch (item.type) {
        case "store_sql":
          queries.set(item.sql_id, item.sql);
          return { type: "ok", response: { type: item.type } };
        case "close_sql":
          queries.delete(item.sql_id);
          return { type: "ok", response: { type: item.type } };
        case "close":
          return { type: "ok", response: { type: item.type } };
        case "execute":
          return { type: "ok", response: { type: item.type, result: execute(item.stmt) } };
        case "batch":
          return { type: "ok", response: { type: item.type, result: batch(item.batch.steps) } };
      }
      throw new Error("Unsupported SQL HTTP fixture request");
    });
    return Response.json({ baton: null, base_url: null, results });
  };
  const client = createClient({
    url: "https://fixture.invalid",
    authToken: "synthetic-token",
    fetch,
  });
  return {
    db,
    client,
    fetch,
    requests,
    httpRequests,
    executedStatements,
    close: () => {
      client.close();
      db.close();
    },
  };
}
