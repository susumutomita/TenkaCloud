import { type DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";

/**
 * Issue #1292: Tenant Admin 向けに 「自テナントの audit log」 を read する handler module。
 * AdminInsight Lambda 側の `/admin/insight/audit` は SystemAdmin 限定 (= cross-tenant)
 * なので、 同じ DDB Table を tenant scope で query する別経路を提供する。
 *
 * Tenant 越境防止: PK は **caller の JWT claim 由来の tenantId 固定**。 query string は
 * 受けず、 caller の tenantId と異なる scope を読む経路を物理的に持たない (= API 設計時点
 * で越境不能)。
 *
 * 1 page 50 件、 cursor は base64(LastEvaluatedKey)。 同期返却。
 * env `ADMIN_AUDIT_LOG_TABLE_NAME` が未設定なら caller (= index.ts) で 503 を返す。
 */

const LIST_LIMIT_DEFAULT = 50;
const LIST_LIMIT_MAX = 200;

export interface TenantAuditDeps {
  readonly ddb: DynamoDBDocumentClient;
  readonly auditTableName: string;
}

export interface TenantAuditListInput {
  readonly tenantId: string;
  readonly limit?: number;
  readonly cursor?: string;
  readonly from?: string;
  readonly to?: string;
  readonly principal?: string;
  readonly action?: string;
}

export interface TenantAuditItem {
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

export interface TenantAuditListResponse {
  readonly items: readonly TenantAuditItem[];
  readonly nextCursor?: string;
}

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

export async function listTenantAuditEntries(
  deps: TenantAuditDeps,
  input: TenantAuditListInput,
): Promise<TenantAuditListResponse> {
  const limit = Math.min(input.limit ?? LIST_LIMIT_DEFAULT, LIST_LIMIT_MAX);
  const out = await deps.ddb.send(
    new QueryCommand({
      TableName: deps.auditTableName,
      KeyConditionExpression: "PK = :pk",
      ExpressionAttributeValues: { ":pk": `TENANT#${input.tenantId}` },
      Limit: limit,
      ScanIndexForward: false,
      ExclusiveStartKey: decodeCursor(input.cursor),
    }),
  );
  const items = (out.Items ?? [])
    .map((row) => toAuditItem(row, input.tenantId))
    .filter((item) => passFilters(item, input));
  return {
    items,
    ...(out.LastEvaluatedKey
      ? { nextCursor: encodeCursor(out.LastEvaluatedKey as Record<string, unknown>) }
      : {}),
  };
}

/**
 * CSV export 用。 全 page を辿って 1 string に集約する。 上限 5000 行で truncate。
 */
export async function exportTenantAuditCsv(
  deps: TenantAuditDeps,
  input: Omit<TenantAuditListInput, "limit" | "cursor">,
  options: { maxRows?: number } = {},
): Promise<string> {
  const maxRows = options.maxRows ?? 5000;
  const collected: TenantAuditItem[] = [];
  let cursor: string | undefined;
  for (let pageIdx = 0; pageIdx < 200; pageIdx++) {
    const page = await listTenantAuditEntries(deps, {
      ...input,
      limit: LIST_LIMIT_MAX,
      ...(cursor ? { cursor } : {}),
    });
    for (const item of page.items) {
      collected.push(item);
      if (collected.length >= maxRows) return formatCsv(collected);
    }
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return formatCsv(collected);
}

function passFilters(item: TenantAuditItem, input: TenantAuditListInput): boolean {
  if (input.from && item.occurredAt < input.from) return false;
  if (input.to && item.occurredAt > input.to) return false;
  if (input.action && item.action !== input.action) return false;
  if (input.principal) {
    if (item.actor !== input.principal && item.actorUsername !== input.principal) return false;
  }
  return true;
}

function toAuditItem(row: unknown, tenantId: string): TenantAuditItem {
  const r = row as Record<string, unknown>;
  const sk = String(r.SK ?? "");
  return {
    id: sk.startsWith("AUDIT#") ? sk.substring(6) : sk,
    tenantId,
    actor: String(r.actor ?? "unknown"),
    ...(typeof r.actorUsername === "string" ? { actorUsername: r.actorUsername } : {}),
    action: String(r.action ?? ""),
    outcome: String(r.outcome ?? ""),
    ...(typeof r.target === "string" ? { target: r.target } : {}),
    ...(typeof r.ipAddress === "string" ? { ipAddress: r.ipAddress } : {}),
    ...(typeof r.userAgent === "string" ? { userAgent: r.userAgent } : {}),
    occurredAt: String(r.occurredAt ?? ""),
    ...(isRecord(r.extra) ? { extra: r.extra as Record<string, unknown> } : {}),
  };
}

function isRecord(value: unknown): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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

function formatCsv(items: readonly TenantAuditItem[]): string {
  const lines = [CSV_COLUMNS.join(",")];
  for (const item of items) {
    const row = item as unknown as Record<string, unknown>;
    lines.push(CSV_COLUMNS.map((col) => csvEscape(String(row[col] ?? ""))).join(","));
  }
  return `${lines.join("\n")}\n`;
}

function csvEscape(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n") || value.includes("\r")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
