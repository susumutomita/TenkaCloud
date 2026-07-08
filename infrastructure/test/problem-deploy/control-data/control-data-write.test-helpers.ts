import { DatabaseSync } from "node:sqlite";
import {
  BatchGetCommand,
  DeleteCommand,
  type DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { EVENTS_SCHEMA_SQL } from "../../../lib/problem-deploy/control-data/sql-events-repository";
import { TEAMS_SCHEMA_SQL } from "../../../lib/problem-deploy/control-data/sql-teams-repository";
import type { SqlExecutor } from "../../../lib/problem-deploy/control-data/types";

/**
 * [Issue #2437] Shared fakes for the conditional-write parity suite.
 *
 * `makeFakeDdb` extends the read-only fake used by the A1 parity tests with a
 * faithful in-memory evaluation of the exact Update/Condition expression
 * grammar the repositories issue (SET / REMOVE clauses; `=`, `<>`, `IN`,
 * `attribute_not_exists`, AND/OR, parentheses, `#name` aliases) plus
 * all-or-nothing `TransactWriteCommand` Puts — so a failed condition raises the
 * same `ConditionalCheckFailedException` / `TransactionCanceledException` the
 * real DocumentClient raises. Items are scoped per `TableName` so the Events
 * and Teams repositories can share one fake (the atomic event+teams create
 * spans both tables).
 *
 * Filename ends in `.test-helpers.ts` (NOT `.test.ts`) so vitest's collector
 * does not pick it up as a test file.
 */

type Item = Record<string, unknown>;
type Names = Record<string, string> | undefined;
type Values = Record<string, unknown> | undefined;

function resolveName(token: string, names: Names): string {
  return token.startsWith("#") ? (names?.[token] ?? token) : token;
}

function tokenize(expr: string): string[] {
  return expr.match(/[#:]?[A-Za-z0-9_.]+|<>|=|\(|\)|,/g) ?? [];
}

/**
 * Evaluates a ConditionExpression against one item (absent item = `{}` so
 * every attribute reads `undefined`, matching DynamoDB's behavior for a
 * conditional update on a missing row).
 */
export function evalConditionExpression(
  expr: string,
  item: Item,
  names: Names,
  values: Values,
): boolean {
  const tokens = tokenize(expr);
  let pos = 0;
  const peek = (): string | undefined => tokens[pos];
  const next = (): string => {
    const token = tokens[pos];
    if (token === undefined) throw new Error(`FakeDdb: unexpected end of condition: ${expr}`);
    pos += 1;
    return token;
  };
  const expect = (want: string): void => {
    const got = next();
    if (got !== want) throw new Error(`FakeDdb: expected "${want}" but got "${got}" in: ${expr}`);
  };
  const operandValue = (token: string): unknown =>
    token.startsWith(":") ? values?.[token] : item[resolveName(token, names)];

  function parsePrimary(): boolean {
    if (peek() === "(") {
      next();
      const value = parseOr();
      expect(")");
      return value;
    }
    if (peek() === "attribute_not_exists") {
      next();
      expect("(");
      const attr = next();
      expect(")");
      return item[resolveName(attr, names)] === undefined;
    }
    const left = next();
    const op = next();
    if (op === "=") return operandValue(left) === operandValue(next());
    if (op === "<>") return operandValue(left) !== operandValue(next());
    if (op === "IN") {
      expect("(");
      const list: unknown[] = [operandValue(next())];
      while (peek() === ",") {
        next();
        list.push(operandValue(next()));
      }
      expect(")");
      return list.includes(operandValue(left));
    }
    throw new Error(`FakeDdb: unsupported operator "${op}" in: ${expr}`);
  }
  function parseAnd(): boolean {
    let value = parsePrimary();
    while (peek() === "AND") {
      next();
      const right = parsePrimary();
      value = value && right;
    }
    return value;
  }
  function parseOr(): boolean {
    let value = parseAnd();
    while (peek() === "OR") {
      next();
      const right = parseAnd();
      value = value || right;
    }
    return value;
  }

  const result = parseOr();
  if (pos !== tokens.length) {
    throw new Error(`FakeDdb: trailing tokens in condition: ${expr}`);
  }
  return result;
}

/** Applies an UpdateExpression (`SET a = :v, …` / `REMOVE a, …` clauses) in place. */
export function applyUpdateExpression(
  item: Item,
  expr: string,
  names: Names,
  values: Values,
): void {
  const clauses = expr
    .split(/\b(SET|REMOVE)\b/)
    .map((clause) => clause.trim())
    .filter(Boolean);
  for (let index = 0; index < clauses.length; index += 2) {
    const keyword = clauses[index];
    const body = clauses[index + 1] ?? "";
    if (keyword === "SET") {
      for (const assignment of body.split(",")) {
        const [rawAttr, rawValue] = assignment.split("=").map((part) => part.trim());
        if (!rawAttr || !rawValue?.startsWith(":")) {
          throw new Error(`FakeDdb: unsupported SET assignment "${assignment}"`);
        }
        item[resolveName(rawAttr, names)] = values?.[rawValue];
      }
    } else if (keyword === "REMOVE") {
      for (const rawAttr of body.split(",")) {
        delete item[resolveName(rawAttr.trim(), names)];
      }
    } else {
      throw new Error(`FakeDdb: unsupported update clause "${keyword}"`);
    }
  }
}

function conditionalCheckFailed(): Error {
  const err = new Error("The conditional request failed");
  err.name = "ConditionalCheckFailedException";
  return err;
}

/**
 * In-memory DynamoDB document client covering every command the Events / Teams
 * repositories issue, including conditional writes. Table-scoped so one fake
 * backs both repositories.
 */
export function makeFakeDdb(): DynamoDBDocumentClient {
  const tables = new Map<string, Map<string, Item>>();
  const tableFor = (name: unknown): Map<string, Item> => {
    const key = String(name);
    let table = tables.get(key);
    if (!table) {
      table = new Map();
      tables.set(key, table);
    }
    return table;
  };
  const keyOf = (pk: unknown, sk: unknown): string => `${String(pk)} ${String(sk)}`;

  const query = (cmd: QueryCommand): { Items: Item[]; LastEvaluatedKey?: Item } => {
    const table = tableFor(cmd.input.TableName);
    const values = cmd.input.ExpressionAttributeValues ?? {};
    const pk = values[":pk"];
    if (cmd.input.IndexName === "GSI2") {
      // Participant-login lookup: GSI2PK = TEAMKEY#<key> (sparse).
      return { Items: [...table.values()].filter((it) => it.GSI2PK === pk) };
    }
    if (cmd.input.KeyConditionExpression?.includes("begins_with")) {
      // base-table: PK = :pk AND begins_with(SK, :tprefix), SK 昇順。
      const prefix = String(values[":tprefix"]);
      const items = [...table.values()]
        .filter((it) => it.PK === pk && String(it.SK).startsWith(prefix))
        .sort((a, b) => String(a.SK).localeCompare(String(b.SK)));
      return { Items: items };
    }
    // GSI1: GSI1PK = :pk, GSI1SK order per ScanIndexForward. `Limit` /
    // `ExclusiveStartKey` are honored here (unlike the other branches above)
    // because this is the only path callers page through (`listEventsPage` /
    // `countEventsByTenant`'s Select=COUNT full-drain).
    const forward = cmd.input.ScanIndexForward !== false;
    let items = [...table.values()]
      .filter((it) => it.GSI1PK === pk)
      .sort((a, b) => {
        const cmp = String(a.GSI1SK).localeCompare(String(b.GSI1SK));
        return forward ? cmp : -cmp;
      });
    const exclusiveStartKey = cmd.input.ExclusiveStartKey as Item | undefined;
    if (exclusiveStartKey) {
      const startSk = String(exclusiveStartKey.GSI1SK);
      items = items.filter((it) => {
        const cmp = String(it.GSI1SK).localeCompare(startSk);
        return forward ? cmp > 0 : cmp < 0;
      });
    }
    const limit = cmd.input.Limit;
    if (limit !== undefined && items.length > limit) {
      const page = items.slice(0, limit);
      const last = page[page.length - 1] as Item;
      return {
        Items: page,
        LastEvaluatedKey: { PK: last.PK, SK: last.SK, GSI1PK: last.GSI1PK, GSI1SK: last.GSI1SK },
      };
    }
    return { Items: items };
  };

  const scan = (cmd: ScanCommand): { Items: Item[] } => {
    const values = cmd.input.ExpressionAttributeValues ?? {};
    if (values[":zero"] !== undefined && values[":now"] !== undefined) {
      // TTL prune sweep (`expiresAt > :zero AND expiresAt <= :now`) uses `>` / `<=`,
      // which `evalConditionExpression` doesn't support — hand-evaluated as before.
      const zero = Number(values[":zero"]);
      const now = Number(values[":now"]);
      const items = [...tableFor(cmd.input.TableName).values()].filter((it) => {
        const exp = Number(it.expiresAt);
        return exp > zero && exp <= now;
      });
      return { Items: items };
    }
    // General full-table Scan filtered by FilterExpression (`=` / `<>` / `IN` / OR / AND
    // — the same grammar `evalConditionExpression` already supports for conditional writes).
    const items = [...tableFor(cmd.input.TableName).values()].filter((it) =>
      cmd.input.FilterExpression
        ? evalConditionExpression(
            cmd.input.FilterExpression,
            it,
            cmd.input.ExpressionAttributeNames,
            cmd.input.ExpressionAttributeValues,
          )
        : true,
    );
    return { Items: items };
  };

  const batchGet = (cmd: BatchGetCommand): { Responses: Record<string, Item[]> } => {
    const responses: Record<string, Item[]> = {};
    for (const [tableName, spec] of Object.entries(cmd.input.RequestItems ?? {})) {
      const table = tableFor(tableName);
      const keys = (spec as { Keys?: Item[] }).Keys ?? [];
      responses[tableName] = keys
        .map((key) => table.get(keyOf(key.PK, key.SK)))
        .filter((item): item is Item => item !== undefined);
    }
    return { Responses: responses };
  };

  const update = (cmd: UpdateCommand): { Attributes?: Item } => {
    const table = tableFor(cmd.input.TableName);
    const key = cmd.input.Key as Item;
    const storeKey = keyOf(key.PK, key.SK);
    const existing = table.get(storeKey);
    if (
      cmd.input.ConditionExpression &&
      !evalConditionExpression(
        cmd.input.ConditionExpression,
        existing ?? {},
        cmd.input.ExpressionAttributeNames,
        cmd.input.ExpressionAttributeValues,
      )
    ) {
      throw conditionalCheckFailed();
    }
    const before = existing ? { ...existing } : undefined;
    const item = existing ?? { PK: key.PK, SK: key.SK };
    applyUpdateExpression(
      item,
      cmd.input.UpdateExpression ?? "",
      cmd.input.ExpressionAttributeNames,
      cmd.input.ExpressionAttributeValues,
    );
    table.set(storeKey, item);
    if (cmd.input.ReturnValues === "ALL_NEW") return { Attributes: { ...item } };
    if (cmd.input.ReturnValues === "ALL_OLD") return { Attributes: before };
    return {};
  };

  const transactWrite = (cmd: TransactWriteCommand): Record<string, never> => {
    const items = cmd.input.TransactItems ?? [];
    const reasons = items.map((entry) => {
      const put = entry.Put;
      if (!put) throw new Error("FakeDdb: only Put transact items are supported");
      const table = tableFor(put.TableName);
      const item = put.Item as Item;
      const existing = table.get(keyOf(item.PK, item.SK)) ?? {};
      const ok = put.ConditionExpression
        ? evalConditionExpression(
            put.ConditionExpression,
            existing,
            put.ExpressionAttributeNames,
            put.ExpressionAttributeValues,
          )
        : true;
      return ok ? "None" : "ConditionalCheckFailed";
    });
    if (reasons.includes("ConditionalCheckFailed")) {
      // All-or-nothing: nothing above is applied on any per-item failure.
      const err = new Error("Transaction cancelled, please refer cancellation reasons");
      err.name = "TransactionCanceledException";
      (err as unknown as { CancellationReasons: Array<{ Code: string }> }).CancellationReasons =
        reasons.map((code) => ({ Code: code }));
      throw err;
    }
    for (const entry of items) {
      const put = entry.Put;
      if (!put) continue;
      const item = put.Item as Item;
      tableFor(put.TableName).set(keyOf(item.PK, item.SK), item);
    }
    return {};
  };

  const put = (cmd: PutCommand): Record<string, never> => {
    const item = cmd.input.Item as Item;
    tableFor(cmd.input.TableName).set(keyOf(item.PK, item.SK), item);
    return {};
  };

  const get = (cmd: GetCommand): { Item?: Item } => {
    const key = cmd.input.Key as Item;
    return { Item: tableFor(cmd.input.TableName).get(keyOf(key.PK, key.SK)) };
  };

  const del = (cmd: DeleteCommand): Record<string, never> => {
    const key = cmd.input.Key as Item;
    tableFor(cmd.input.TableName).delete(keyOf(key.PK, key.SK));
    return {};
  };

  const runQuery = (
    cmd: QueryCommand,
  ): { Items?: Item[]; Count?: number; LastEvaluatedKey?: Item } => {
    const result = query(cmd);
    // Real DynamoDB's `Select: "COUNT"` response omits Items and carries Count instead,
    // but still paginates — LastEvaluatedKey must survive the COUNT branch too.
    return cmd.input.Select === "COUNT"
      ? { Count: result.Items.length, LastEvaluatedKey: result.LastEvaluatedKey }
      : result;
  };

  // biome-ignore lint/suspicious/noExplicitAny: fake dispatches by command class.
  const handlers = new Map<unknown, (cmd: any) => unknown>([
    [PutCommand, put],
    [GetCommand, get],
    [QueryCommand, runQuery],
    [ScanCommand, scan],
    [BatchGetCommand, batchGet],
    [DeleteCommand, del],
    [UpdateCommand, update],
    [TransactWriteCommand, transactWrite],
  ]);

  // biome-ignore lint/suspicious/noExplicitAny: fake dispatches by command class.
  const send = async (cmd: any): Promise<unknown> => {
    const handler = handlers.get(cmd.constructor);
    if (!handler) throw new Error(`FakeDdb: unsupported command ${cmd?.constructor?.name}`);
    return handler(cmd);
  };

  return { send } as unknown as DynamoDBDocumentClient;
}

/**
 * node:sqlite-backed SqlExecutor (in-memory) bootstrapped with BOTH the events
 * and teams schemas (the atomic event+teams create spans both tables).
 * `batch` wraps the statements in BEGIN/COMMIT with ROLLBACK on failure —
 * the same all-or-nothing semantics `LibsqlExecutor.batch` gets from
 * `client.batch(…, "write")`.
 */
export function makeSqliteExecutor(): SqlExecutor {
  const db = new DatabaseSync(":memory:");
  db.exec(EVENTS_SCHEMA_SQL);
  db.exec(TEAMS_SCHEMA_SQL);
  return {
    run: (sql, params = []) => {
      const result = db.prepare(sql).run(...params);
      return { changes: result.changes };
    },
    get: (sql, params = []) =>
      db.prepare(sql).get(...params) as Record<string, unknown> | undefined,
    all: (sql, params = []) => db.prepare(sql).all(...params) as Record<string, unknown>[],
    batch: (statements) => {
      db.exec("BEGIN");
      try {
        const results = statements.map((statement) => ({
          changes: db.prepare(statement.sql).run(...(statement.params ?? [])).changes,
        }));
        db.exec("COMMIT");
        return results;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
  };
}
