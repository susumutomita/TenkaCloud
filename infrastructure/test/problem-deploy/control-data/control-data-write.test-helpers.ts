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
import { ADMIN_AUDIT_LOG_SCHEMA_SQL } from "../../../lib/problem-deploy/control-data/sql-admin-audit-log-repository";
import { COMPETITOR_ACCOUNTS_SCHEMA_SQL } from "../../../lib/problem-deploy/control-data/sql-competitor-accounts-repository";
import { DEPLOYMENTS_SCHEMA_SQL } from "../../../lib/problem-deploy/control-data/sql-deployments-repository";
import { DISRUPTIONS_SCHEMA_SQL } from "../../../lib/problem-deploy/control-data/sql-disruptions-repository";
import { EVENTS_SCHEMA_SQL } from "../../../lib/problem-deploy/control-data/sql-events-repository";
import { FEATURE_FLAGS_SCHEMA_SQL } from "../../../lib/problem-deploy/control-data/sql-feature-flags-repository";
import { NOTIFICATIONS_SCHEMA_SQL } from "../../../lib/problem-deploy/control-data/sql-notifications-repository";
import { PROBLEM_ENDPOINTS_SCHEMA_SQL } from "../../../lib/problem-deploy/control-data/sql-problem-endpoints-repository";
import { SAML_CONFIG_SCHEMA_SQL } from "../../../lib/problem-deploy/control-data/sql-saml-config-repository";
import { SAML_IDPS_SCHEMA_SQL } from "../../../lib/problem-deploy/control-data/sql-saml-idps-repository";
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
type TransactItem = NonNullable<TransactWriteCommand["input"]["TransactItems"]>[number];

function resolveName(token: string, names: Names): string {
  return token.startsWith("#") ? (names?.[token] ?? token) : token;
}

function tokenize(expr: string): string[] {
  return expr.match(/[#:]?[A-Za-z0-9_.]+|<>|=|\(|\)|,/g) ?? [];
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function containsValue(container: unknown, needle: unknown): boolean {
  if (container instanceof Set) return [...container].some((value) => deepEqual(value, needle));
  if (Array.isArray(container)) return container.some((value) => deepEqual(value, needle));
  if (typeof container === "string" && typeof needle === "string")
    return container.includes(needle);
  return false;
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

  function parseAttributeFunction(): boolean | undefined {
    const fn = peek();
    if (fn === "attribute_not_exists") {
      next();
      expect("(");
      const attr = next();
      expect(")");
      return item[resolveName(attr, names)] === undefined;
    }
    if (fn === "attribute_exists") {
      next();
      expect("(");
      const attr = next();
      expect(")");
      return item[resolveName(attr, names)] !== undefined;
    }
    if (fn === "contains") {
      next();
      expect("(");
      const attr = next();
      expect(",");
      const value = next();
      expect(")");
      return containsValue(item[resolveName(attr, names)], operandValue(value));
    }
    return undefined;
  }

  function parseComparison(): boolean {
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

  function parsePrimary(): boolean {
    if (peek() === "NOT") {
      next();
      return !parsePrimary();
    }
    if (peek() === "(") {
      next();
      const value = parseOr();
      expect(")");
      return value;
    }
    return parseAttributeFunction() ?? parseComparison();
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

function splitTopLevelCommas(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i];
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (char === "," && depth === 0) {
      parts.push(body.slice(start, i).trim());
      start = i + 1;
    }
  }
  const tail = body.slice(start).trim();
  if (tail) parts.push(tail);
  return parts;
}

function splitTopLevelEquals(assignment: string): readonly [string, string] {
  let depth = 0;
  for (let i = 0; i < assignment.length; i += 1) {
    const char = assignment[i];
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (char === "=" && depth === 0) {
      return [assignment.slice(0, i).trim(), assignment.slice(i + 1).trim()];
    }
  }
  throw new Error(`FakeDdb: unsupported SET assignment "${assignment}"`);
}

function splitUpdateClauses(expr: string): Array<readonly ["SET" | "REMOVE" | "ADD", string]> {
  const matches = [...expr.matchAll(/\b(SET|REMOVE|ADD)\b/g)];
  return matches.map((match, index) => {
    const keyword = match[1] as "SET" | "REMOVE" | "ADD";
    const start = (match.index ?? 0) + keyword.length;
    const end = matches[index + 1]?.index ?? expr.length;
    return [keyword, expr.slice(start, end).trim()] as const;
  });
}

function evalUpdateValue(item: Item, rawValue: string, names: Names, values: Values): unknown {
  if (rawValue.startsWith(":")) return values?.[rawValue];
  const listAppend = rawValue.match(
    /^list_append\(if_not_exists\(([^,]+),\s*(:[A-Za-z0-9_]+)\),\s*(:[A-Za-z0-9_]+)\)$/,
  );
  if (listAppend) {
    const attr = resolveName(listAppend[1]?.trim() ?? "", names);
    const fallback = values?.[listAppend[2] ?? ""];
    const append = values?.[listAppend[3] ?? ""];
    const base = item[attr] === undefined ? fallback : item[attr];
    if (!Array.isArray(base) || !Array.isArray(append)) {
      throw new Error(`FakeDdb: list_append operands must be arrays in "${rawValue}"`);
    }
    return [...base, ...append];
  }
  // [Issue #2946] bare `if_not_exists(attr, :value)` — write-once semantics. The deployment
  // completion marker uses it so the first COMPLETE timestamp is never moved by a re-entry of
  // the success path. Modelled here so the parity tests exercise the real behaviour rather
  // than a stubbed one.
  const ifNotExists = rawValue.match(/^if_not_exists\(([^,]+),\s*(:[A-Za-z0-9_]+)\)$/);
  if (ifNotExists) {
    const attr = resolveName(ifNotExists[1]?.trim() ?? "", names);
    const fallback = values?.[ifNotExists[2] ?? ""];
    return item[attr] === undefined ? fallback : item[attr];
  }
  throw new Error(`FakeDdb: unsupported SET value "${rawValue}"`);
}

function applySetClause(item: Item, body: string, names: Names, values: Values): void {
  for (const assignment of splitTopLevelCommas(body)) {
    const [rawAttr, rawValue] = splitTopLevelEquals(assignment);
    if (!rawAttr) throw new Error(`FakeDdb: unsupported SET assignment "${assignment}"`);
    item[resolveName(rawAttr, names)] = evalUpdateValue(item, rawValue, names, values);
  }
}

function applyRemoveClause(item: Item, body: string, names: Names): void {
  for (const rawAttr of splitTopLevelCommas(body)) {
    delete item[resolveName(rawAttr.trim(), names)];
  }
}

function applyAddValue(item: Item, attr: string, delta: unknown, rawValue: string): void {
  if (typeof delta === "number") {
    item[attr] = Number(item[attr] ?? 0) + delta;
    return;
  }
  if (delta instanceof Set) {
    const existing = item[attr] instanceof Set ? (item[attr] as Set<unknown>) : new Set();
    item[attr] = new Set([...existing, ...delta]);
    return;
  }
  throw new Error(`FakeDdb: unsupported ADD value "${rawValue}"`);
}

function applyAddClause(item: Item, body: string, names: Names, values: Values): void {
  for (const addition of splitTopLevelCommas(body)) {
    const [rawAttr, rawValue] = addition.trim().split(/\s+/);
    if (!rawAttr || !rawValue?.startsWith(":")) {
      throw new Error(`FakeDdb: unsupported ADD expression "${addition}"`);
    }
    applyAddValue(item, resolveName(rawAttr, names), values?.[rawValue], rawValue);
  }
}

/** Applies an UpdateExpression (`SET` / `REMOVE` / `ADD` clauses) in place. */
export function applyUpdateExpression(
  item: Item,
  expr: string,
  names: Names,
  values: Values,
): void {
  const clauses = splitUpdateClauses(expr);
  for (const [keyword, body] of clauses) {
    if (keyword === "SET") {
      applySetClause(item, body, names, values);
    } else if (keyword === "REMOVE") {
      applyRemoveClause(item, body, names);
    } else if (keyword === "ADD") {
      applyAddClause(item, body, names, values);
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
export function makeFakeDdb(options: { readonly pageSize?: number } = {}): DynamoDBDocumentClient {
  // [#2441 / Phase B1] Optional forced page size. When set, drainable query
  // branches (GSI1-with-filter / base-table begins_with / SK BETWEEN) paginate
  // by this size even without an explicit `Limit`, so multi-page drain contracts
  // can be pinned. Unset (the existing callers) = no forced pagination, so the
  // A1-A4 write-parity suites see byte-identical fake behavior.
  const forcedPageSize = options.pageSize;
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

  /**
   * Base-table pagination by SK (shared by begins_with / SK BETWEEN). Honors
   * ScanIndexForward, ExclusiveStartKey (start-after by SK), and Limit ??
   * forcedPageSize. LastEvaluatedKey is `{ PK, SK }` (base-table key).
   *
   * A cursor whose `PK` does not match the queried partition (a foreign/
   * cross-partition cursor — real DynamoDB's per-partition pagination makes
   * this an opaque, effectively-invalid position) is ignored rather than
   * applied, so callers restart from the first page instead of the boundary
   * silently emptying every result.
   */
  const paginateBySk = (
    matched: Item[],
    cmd: QueryCommand,
    pk?: unknown,
  ): { Items: Item[]; LastEvaluatedKey?: Item } => {
    const forward = cmd.input.ScanIndexForward !== false;
    let items = matched.sort((a, b) => {
      const cmp = String(a.SK).localeCompare(String(b.SK));
      return forward ? cmp : -cmp;
    });
    const esk = cmd.input.ExclusiveStartKey as Item | undefined;
    if (esk && (pk === undefined || esk.PK === pk)) {
      const startSk = String(esk.SK);
      items = items.filter((it) => {
        const cmp = String(it.SK).localeCompare(startSk);
        return forward ? cmp > 0 : cmp < 0;
      });
    }
    const limit = cmd.input.Limit ?? forcedPageSize;
    if (limit !== undefined && items.length > limit) {
      const page = items.slice(0, limit);
      const last = page[page.length - 1] as Item;
      return { Items: page, LastEvaluatedKey: { PK: last.PK, SK: last.SK } };
    }
    return { Items: items };
  };

  /** GSI3: composite parent → target (sparse, single page, ordered by GSI3SK). */
  const queryGsi3 = (cmd: QueryCommand, table: Map<string, Item>, pk: unknown): Item[] => {
    const forward = cmd.input.ScanIndexForward !== false;
    return [...table.values()]
      .filter((it) => it.GSI3PK === pk)
      .sort((a, b) => {
        const cmp = String(a.GSI3SK).localeCompare(String(b.GSI3SK));
        return forward ? cmp : -cmp;
      });
  };

  /**
   * GSI1: `GSI1PK = :pk`, optional FilterExpression (#2441 eventId / status /
   * namePrefix reads), GSI1SK order per ScanIndexForward, Limit ?? forcedPageSize
   * paging with `{PK,SK,GSI1PK,GSI1SK}` LastEvaluatedKey.
   */
  const queryGsi1 = (
    cmd: QueryCommand,
    table: Map<string, Item>,
    pk: unknown,
  ): { Items: Item[]; LastEvaluatedKey?: Item } => {
    const forward = cmd.input.ScanIndexForward !== false;
    let items = [...table.values()].filter((it) => it.GSI1PK === pk);
    const filter = cmd.input.FilterExpression;
    if (filter) {
      items = items.filter((it) =>
        evalConditionExpression(
          filter,
          it,
          cmd.input.ExpressionAttributeNames,
          cmd.input.ExpressionAttributeValues,
        ),
      );
    }
    items.sort((a, b) => {
      const cmp = String(a.GSI1SK).localeCompare(String(b.GSI1SK));
      return forward ? cmp : -cmp;
    });
    const esk = cmd.input.ExclusiveStartKey as Item | undefined;
    if (esk) {
      const startSk = String(esk.GSI1SK);
      items = items.filter((it) => {
        const cmp = String(it.GSI1SK).localeCompare(startSk);
        return forward ? cmp > 0 : cmp < 0;
      });
    }
    const limit = cmd.input.Limit ?? forcedPageSize;
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

  /** Base-table (no IndexName) reads: begins_with / SK BETWEEN / exact SK. */
  const queryBase = (
    cmd: QueryCommand,
    table: Map<string, Item>,
    values: Record<string, unknown>,
    pk: unknown,
  ): { Items: Item[]; LastEvaluatedKey?: Item } => {
    const kce = cmd.input.KeyConditionExpression ?? "";
    if (kce.includes("begins_with")) {
      // PK = :pk AND begins_with(SK, :prefix) — the prefix placeholder differs
      // per site (:tprefix TEAM# / :evpfx EVENT#), so extract it from the expr.
      const match = kce.match(/begins_with\(SK,\s*(:[A-Za-z0-9_]+)\)/);
      const prefix = String(values[match?.[1] ?? ":tprefix"]);
      let matched = [...table.values()].filter(
        (it) => it.PK === pk && String(it.SK).startsWith(prefix),
      );
      // [Issue #2442 / Phase C3] disruptions `listRecurringByEvent` combines a base-table
      // begins_with KeyCondition with a `tenantId = :t` FilterExpression.
      if (cmd.input.FilterExpression) {
        matched = matched.filter((it) =>
          evalConditionExpression(
            cmd.input.FilterExpression as string,
            it,
            cmd.input.ExpressionAttributeNames,
            cmd.input.ExpressionAttributeValues,
          ),
        );
      }
      return paginateBySk(matched, cmd, pk);
    }
    if (kce.includes("BETWEEN")) {
      // [#2441] PK = :pk AND SK BETWEEN :sk_start AND :sk_end (EVENT# / INBOX# ranges).
      const start = String(values[":sk_start"]);
      const end = String(values[":sk_end"]);
      return paginateBySk(
        [...table.values()].filter(
          (it) => it.PK === pk && String(it.SK) >= start && String(it.SK) <= end,
        ),
        cmd,
        pk,
      );
    }
    const gteMatch = kce.match(/SK >= (:[A-Za-z0-9_]+)/);
    if (gteMatch) {
      // [Issue #2442 / Phase C3] PK = :pk AND SK >= :since (disruptions `listAuditSince` —
      // open-ended lower bound, no upper bound / begins_with prefix).
      const since = String(values[gteMatch[1] ?? ""]);
      return {
        Items: [...table.values()].filter((it) => it.PK === pk && String(it.SK) >= since),
      };
    }
    if (!kce.includes("SK")) {
      // [Issue #2442 / Phase C4] Base-table PK-only query (AdminAuditLog `listPage` /
      // `listAllByPartition`) — no SK condition at all, every row under the partition,
      // paginated by ScanIndexForward/Limit/ExclusiveStartKey like the begins_with branch.
      return paginateBySk(
        [...table.values()].filter((it) => it.PK === pk),
        cmd,
        pk,
      );
    }
    // [#2441] Base-table exact read: PK = :pk AND SK = :sk (cast-event META Query).
    const sk = values[":sk"];
    return { Items: [...table.values()].filter((it) => it.PK === pk && it.SK === sk) };
  };

  const query = (cmd: QueryCommand): { Items: Item[]; LastEvaluatedKey?: Item } => {
    const table = tableFor(cmd.input.TableName);
    const values = cmd.input.ExpressionAttributeValues ?? {};
    const pk = values[":pk"];
    if (cmd.input.IndexName === "GSI2") {
      // Participant-login lookup: GSI2PK = TEAMKEY#<key> (sparse, single page).
      return { Items: [...table.values()].filter((it) => it.GSI2PK === pk) };
    }
    if (cmd.input.IndexName === "GSI3") return { Items: queryGsi3(cmd, table, pk) };
    if (cmd.input.IndexName === "GSI1") return queryGsi1(cmd, table, pk);
    return queryBase(cmd, table, values, pk);
  };

  const scan = (cmd: ScanCommand): { Items: Item[]; LastEvaluatedKey?: Item } => {
    const values = cmd.input.ExpressionAttributeValues ?? {};
    if (values[":zero"] !== undefined && values[":now"] !== undefined) {
      // TTL prune sweep (`expiresAt > :zero AND expiresAt <= :now`) uses `>` / `<=`,
      // which `evalConditionExpression` doesn't support — hand-evaluated as before.
      // No pagination here: the pre-existing Events/Teams/Notifications prune sweeps
      // never exercised multi-page Scan drain.
      const zero = Number(values[":zero"]);
      const now = Number(values[":now"]);
      // [Issue #2442 / Phase C4] AdminAuditLog's native TTL attribute is `ttl` (not
      // `expiresAt`, per `admin-audit-log-table.ts`'s `timeToLiveAttribute`), aliased as
      // `#ttl` in its FilterExpression to avoid the reserved-word risk. Resolve via
      // ExpressionAttributeNames when present, falling back to the `expiresAt` convention
      // every other aggregate uses.
      const names = cmd.input.ExpressionAttributeNames as Record<string, string> | undefined;
      const attr = names?.["#ttl"] ?? "expiresAt";
      const items = [...tableFor(cmd.input.TableName).values()].filter((it) => {
        const exp = Number(it[attr]);
        return exp > zero && exp <= now;
      });
      return { Items: items };
    }
    // General full-table Scan filtered by FilterExpression (`=` / `<>` / `IN` / OR / AND
    // — the same grammar `evalConditionExpression` already supports for conditional writes).
    const matched = [...tableFor(cmd.input.TableName).values()].filter((it) =>
      cmd.input.FilterExpression
        ? evalConditionExpression(
            cmd.input.FilterExpression,
            it,
            cmd.input.ExpressionAttributeNames,
            cmd.input.ExpressionAttributeValues,
          )
        : true,
    );
    // [#2441 / Phase B3] Every real Scan site sets its own `Limit` (200 verbatim),
    // so `Limit ?? forcedPageSize` would never let `forcedPageSize` engage. Only
    // `forcedPageSize` being *explicitly set* forces multi-page drain (capped
    // below whatever `Limit` the command carries — a real Scan can also
    // page well short of `Limit` on the 1MB response-size boundary, so this is a
    // faithful page-size simulation, not a Limit override). Every pre-#2441 Scan
    // caller (no `pageSize` passed) reproduces the old single-page, unsorted-order
    // behavior exactly (no slicing applied, `Limit` fully ignored).
    if (forcedPageSize === undefined) return { Items: matched };
    const limit = Math.min(cmd.input.Limit ?? Number.POSITIVE_INFINITY, forcedPageSize);
    const sorted = matched.sort((a, b) => keyOf(a.PK, a.SK).localeCompare(keyOf(b.PK, b.SK)));
    const esk = cmd.input.ExclusiveStartKey as Item | undefined;
    const items = esk ? sorted.filter((it) => keyOf(it.PK, it.SK) > keyOf(esk.PK, esk.SK)) : sorted;
    if (items.length > limit) {
      const page = items.slice(0, limit);
      const last = page[page.length - 1] as Item;
      return { Items: page, LastEvaluatedKey: { PK: last.PK, SK: last.SK } };
    }
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

  const conditionCode = (ok: boolean): "None" | "ConditionalCheckFailed" =>
    ok ? "None" : "ConditionalCheckFailed";

  const transactPutConditionCode = (put: NonNullable<TransactItem["Put"]>) => {
    const item = put.Item as Item;
    const existing = tableFor(put.TableName).get(keyOf(item.PK, item.SK)) ?? {};
    const ok = put.ConditionExpression
      ? evalConditionExpression(
          put.ConditionExpression,
          existing,
          put.ExpressionAttributeNames,
          put.ExpressionAttributeValues,
        )
      : true;
    return conditionCode(ok);
  };

  const transactUpdateConditionCode = (updateEntry: NonNullable<TransactItem["Update"]>) => {
    const key = updateEntry.Key as Item;
    const existing = tableFor(updateEntry.TableName).get(keyOf(key.PK, key.SK)) ?? {};
    const ok = updateEntry.ConditionExpression
      ? evalConditionExpression(
          updateEntry.ConditionExpression,
          existing,
          updateEntry.ExpressionAttributeNames,
          updateEntry.ExpressionAttributeValues,
        )
      : true;
    return conditionCode(ok);
  };

  const transactDeleteConditionCode = (deleteEntry: NonNullable<TransactItem["Delete"]>) => {
    const key = deleteEntry.Key as Item;
    const existing = tableFor(deleteEntry.TableName).get(keyOf(key.PK, key.SK)) ?? {};
    const ok = deleteEntry.ConditionExpression
      ? evalConditionExpression(
          deleteEntry.ConditionExpression,
          existing,
          deleteEntry.ExpressionAttributeNames,
          deleteEntry.ExpressionAttributeValues,
        )
      : true;
    return conditionCode(ok);
  };

  const transactConditionCode = (entry: TransactItem): "None" | "ConditionalCheckFailed" => {
    if (entry.Put) return transactPutConditionCode(entry.Put);
    if (entry.Update) return transactUpdateConditionCode(entry.Update);
    if (entry.Delete) return transactDeleteConditionCode(entry.Delete);
    throw new Error("FakeDdb: unsupported transact item");
  };

  const applyTransactItem = (entry: TransactItem): void => {
    const put = entry.Put;
    const updateEntry = entry.Update;
    const deleteEntry = entry.Delete;
    if (put) {
      const item = put.Item as Item;
      tableFor(put.TableName).set(keyOf(item.PK, item.SK), item);
      return;
    }
    if (updateEntry) {
      const table = tableFor(updateEntry.TableName);
      const key = updateEntry.Key as Item;
      const storeKey = keyOf(key.PK, key.SK);
      const item = table.get(storeKey) ?? { PK: key.PK, SK: key.SK };
      applyUpdateExpression(
        item,
        updateEntry.UpdateExpression ?? "",
        updateEntry.ExpressionAttributeNames,
        updateEntry.ExpressionAttributeValues,
      );
      table.set(storeKey, item);
      return;
    }
    if (deleteEntry) {
      const key = deleteEntry.Key as Item;
      tableFor(deleteEntry.TableName).delete(keyOf(key.PK, key.SK));
    }
  };

  const transactWrite = (cmd: TransactWriteCommand): Record<string, never> => {
    const items = cmd.input.TransactItems ?? [];
    const reasons = items.map(transactConditionCode);
    if (reasons.includes("ConditionalCheckFailed")) {
      // All-or-nothing: nothing above is applied on any per-item failure.
      const err = new Error("Transaction cancelled, please refer cancellation reasons");
      err.name = "TransactionCanceledException";
      (err as unknown as { CancellationReasons: Array<{ Code: string }> }).CancellationReasons =
        reasons.map((code) => ({ Code: code }));
      throw err;
    }
    for (const entry of items) applyTransactItem(entry);
    return {};
  };

  const put = (cmd: PutCommand): Record<string, never> => {
    const item = cmd.input.Item as Item;
    const table = tableFor(cmd.input.TableName);
    const existing = table.get(keyOf(item.PK, item.SK)) ?? {};
    if (
      cmd.input.ConditionExpression &&
      !evalConditionExpression(
        cmd.input.ConditionExpression,
        existing,
        cmd.input.ExpressionAttributeNames,
        cmd.input.ExpressionAttributeValues,
      )
    ) {
      throw conditionalCheckFailed();
    }
    table.set(keyOf(item.PK, item.SK), item);
    return {};
  };

  const get = (cmd: GetCommand): { Item?: Item } => {
    const key = cmd.input.Key as Item;
    return { Item: tableFor(cmd.input.TableName).get(keyOf(key.PK, key.SK)) };
  };

  const del = (cmd: DeleteCommand): Record<string, never> => {
    const key = cmd.input.Key as Item;
    const table = tableFor(cmd.input.TableName);
    const existing = table.get(keyOf(key.PK, key.SK)) ?? {};
    // [Issue #2442 / Phase C2] `CompetitorAccountsRepository.deleteAccount` is the
    // first site to issue a conditional `DeleteCommand`
    // (`attribute_exists(PK) AND attribute_exists(SK)`, matching the pre-seam
    // handler's atomic TOCTOU-free existence check) — every prior Delete site
    // (Teams / ProblemEndpoints / Events / Notifications) is unconditional.
    if (
      cmd.input.ConditionExpression &&
      !evalConditionExpression(
        cmd.input.ConditionExpression,
        existing,
        cmd.input.ExpressionAttributeNames,
        cmd.input.ExpressionAttributeValues,
      )
    ) {
      throw conditionalCheckFailed();
    }
    table.delete(keyOf(key.PK, key.SK));
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
 * node:sqlite-backed SqlExecutor (in-memory) bootstrapped with the control-data
 * schemas the repository parity tests exercise.
 * `batch` wraps the statements in BEGIN/COMMIT with ROLLBACK on failure —
 * the same all-or-nothing semantics `LibsqlExecutor.batch` gets from
 * `client.batch(…, "write")`.
 */
export function makeSqliteExecutor(): SqlExecutor {
  const db = new DatabaseSync(":memory:");
  db.exec(EVENTS_SCHEMA_SQL);
  db.exec(TEAMS_SCHEMA_SQL);
  db.exec(NOTIFICATIONS_SCHEMA_SQL);
  db.exec(FEATURE_FLAGS_SCHEMA_SQL);
  db.exec(DEPLOYMENTS_SCHEMA_SQL);
  db.exec(PROBLEM_ENDPOINTS_SCHEMA_SQL);
  db.exec(COMPETITOR_ACCOUNTS_SCHEMA_SQL);
  db.exec(SAML_CONFIG_SCHEMA_SQL);
  db.exec(SAML_IDPS_SCHEMA_SQL);
  db.exec(DISRUPTIONS_SCHEMA_SQL);
  db.exec(ADMIN_AUDIT_LOG_SCHEMA_SQL);
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
