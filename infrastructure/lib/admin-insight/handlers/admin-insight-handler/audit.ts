import { type DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { csvEscapeField } from "../../../utils/csv.js";

/**
 * Issue #950 (ADR-020 Phase D): admin audit log を tenant 別 / system 別に read する。
 *
 * SystemAdmin 用 (= cross-tenant) の 「すべての audit を見る」 経路は admin-insight handler の
 * `/admin/insight/audit?scope=tenant&tenantId=...` または `?scope=system` で実現する。
 *
 * Query 設計:
 *   - PK=TENANT#<tenantId>     → tenant 単位の audit
 *   - PK=SYSTEM#<env>          → SystemAdmin 操作 audit
 *   - sort key (= SK) は ULID で時系列順、 ScanIndexForward=false で新しい順に返す
 *
 * 1 ページ 50 件、 cursor は base64(LastEvaluatedKey) で次ページ移行。
 */

export interface AuditDeps {
  readonly ddb: DynamoDBDocumentClient;
  readonly auditTableName: string;
}

export interface AuditListInput {
  readonly scope: "tenant" | "system";
  /** scope=tenant のみ必須 */
  readonly tenantId?: string;
  readonly limit?: number;
  /** base64(LastEvaluatedKey) */
  readonly cursor?: string;
  /** Issue #1292: ISO8601 lower bound (= 含む)。 occurredAt >= from で filter。 */
  readonly from?: string;
  /** Issue #1292: ISO8601 upper bound (= 含む)。 occurredAt <= to で filter。 */
  readonly to?: string;
  /** Issue #1292: principal (= actor sub or actorUsername) で filter (= 完全一致)。 */
  readonly principal?: string;
  /** Issue #1292: action 名で filter (= 完全一致)。 */
  readonly action?: string;
}

export interface AuditItem {
  readonly id: string;
  readonly tenantId: string;
  readonly actor: string;
  readonly actorUsername?: string;
  readonly action: string;
  readonly outcome: string;
  readonly target?: string;
  readonly ipAddress?: string;
  readonly userAgent?: string;
  readonly occurredAt: string;
  readonly extra?: Record<string, unknown>;
}

export interface AuditListResponse {
  readonly items: readonly AuditItem[];
  readonly nextCursor?: string;
}

const LIST_LIMIT_DEFAULT = 50;
const LIST_LIMIT_MAX = 200;

function decodeCursor(cursor: string | undefined): Record<string, unknown> | undefined {
  if (!cursor) return undefined;
  try {
    return JSON.parse(Buffer.from(cursor, "base64").toString("utf-8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function encodeCursor(key: Record<string, unknown> | undefined): string | undefined {
  if (!key) return undefined;
  return Buffer.from(JSON.stringify(key), "utf-8").toString("base64");
}

export async function listAuditEntries(
  deps: AuditDeps,
  input: AuditListInput,
  env: string,
): Promise<AuditListResponse> {
  const limit = Math.min(input.limit ?? LIST_LIMIT_DEFAULT, LIST_LIMIT_MAX);
  const pk = input.scope === "system" ? `SYSTEM#${env}` : `TENANT#${input.tenantId ?? ""}`;
  const out = await deps.ddb.send(
    new QueryCommand({
      TableName: deps.auditTableName,
      KeyConditionExpression: "PK = :pk",
      ExpressionAttributeValues: { ":pk": pk },
      Limit: limit,
      ScanIndexForward: false,
      ExclusiveStartKey: decodeCursor(input.cursor),
    }),
  );
  const rawItems = (out.Items ?? []).map((row) => toAuditItem(row, input.scope));
  const items = applyFilters(rawItems, input);
  return {
    items,
    ...(out.LastEvaluatedKey
      ? { nextCursor: encodeCursor(out.LastEvaluatedKey as Record<string, unknown>) }
      : {}),
  };
}

/**
 * Issue #1292: client-side filter (= DDB Query は PK 固定 + ScanIndexForward=false で取った後)。
 * RCU 都合で server-side FilterExpression を増やすより、 1 page=50 行に対して JS で
 * shallow filter する方が cost コントロールしやすい。 大規模な horizon は CSV export
 * (= 全頁繰り) で対応する。
 */
function applyFilters(items: readonly AuditItem[], input: AuditListInput): AuditItem[] {
  return items.filter((item) => {
    if (input.from && item.occurredAt < input.from) return false;
    if (input.to && item.occurredAt > input.to) return false;
    if (input.action && item.action !== input.action) return false;
    if (input.principal) {
      const matchActor = item.actor === input.principal;
      const matchUsername = item.actorUsername === input.principal;
      if (!matchActor && !matchUsername) return false;
    }
    return true;
  });
}

/**
 * Issue #1292: CSV export 用に全 page を辿って 1 回で集約する。 retention 365 日 × 1 op/日
 * ≒ 365 行が典型なので、 page 数も 1 桁。 上限 5000 行で truncate。
 *
 * CSV escape: RFC 4180 準拠で `,` / `"` / `\n` を含む値は `"..."` で囲み、 内部 `"` を `""` に。
 */
export async function exportAuditEntriesCsv(
  deps: AuditDeps,
  input: Omit<AuditListInput, "limit" | "cursor">,
  env: string,
  options: { maxRows?: number } = {},
): Promise<string> {
  const maxRows = options.maxRows ?? 5000;
  const collected: AuditItem[] = [];
  let cursor: string | undefined;
  for (let pageIdx = 0; pageIdx < 200; pageIdx++) {
    const page = await listAuditEntries(deps, { ...input, limit: LIST_LIMIT_MAX, cursor }, env);
    for (const item of page.items) {
      collected.push(item);
      if (collected.length >= maxRows) return formatCsv(collected);
    }
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return formatCsv(collected);
}

const CSV_COLUMNS = [
  "occurredAt",
  "tenantId",
  "actor",
  "actorUsername",
  "action",
  "outcome",
  "target",
  "ipAddress",
  "userAgent",
] as const;

function formatCsv(items: readonly AuditItem[]): string {
  const lines = [CSV_COLUMNS.join(",")];
  for (const item of items) {
    const row = item as unknown as Record<string, unknown>;
    lines.push(CSV_COLUMNS.map((col) => csvEscapeField(String(row[col] ?? ""))).join(","));
  }
  return `${lines.join("\n")}\n`;
}

function toAuditItem(row: unknown, scope: AuditListInput["scope"]): AuditItem {
  const r = row as Record<string, unknown>;
  const sk = String(r.SK ?? "");
  return {
    id: sk.startsWith("AUDIT#") ? sk.substring(6) : sk,
    tenantId: scope === "system" ? "SYSTEM" : String(r.PK ?? "").replace(/^TENANT#/, ""),
    actor: String(r.actor ?? "unknown"),
    ...(optionalString(r, "actorUsername") ? { actorUsername: r.actorUsername as string } : {}),
    action: String(r.action ?? ""),
    outcome: String(r.outcome ?? ""),
    ...(optionalString(r, "target") ? { target: r.target as string } : {}),
    ...(optionalString(r, "ipAddress") ? { ipAddress: r.ipAddress as string } : {}),
    ...(optionalString(r, "userAgent") ? { userAgent: r.userAgent as string } : {}),
    occurredAt: String(r.occurredAt ?? ""),
    ...(isRecord(r.extra) ? { extra: r.extra } : {}),
  };
}

function optionalString(row: Record<string, unknown>, key: string): boolean {
  return typeof row[key] === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
