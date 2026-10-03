import { csvEscapeField } from "../../../utils/csv.js";
import type { AdminAuditLogRepository, AdminAuditRow } from "../../control-data/types.js";

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
 *
 * [Issue #2442 / Phase C4] Raw DDB access moved behind {@link AdminAuditLogRepository}
 * (`resolveAdminAuditLogRepository` in `shared.ts` resolves it). The cursor wire format on the
 * DynamoDB backend stays byte-identical (plain base64 JSON) — this module no longer computes it
 * directly, but the repository's `listPage` produces the exact same encoding. env
 * `ADMIN_AUDIT_LOG_TABLE_NAME` が未設定 (かつ dynamodb backend) なら caller (= routes/
 * audit-log.ts) で 503 を返す。
 */

const LIST_LIMIT_DEFAULT = 50;
const LIST_LIMIT_MAX = 200;
/** CSV export が 1 tenant partition で辿る最大ページ数。memory / round-trip の上限を bound する。 */
const EXPORT_MAX_PAGES = 200;

export interface TenantAuditDeps {
  readonly repository: AdminAuditLogRepository;
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

export async function listTenantAuditEntries(
  deps: TenantAuditDeps,
  input: TenantAuditListInput,
): Promise<TenantAuditListResponse> {
  const limit = Math.min(input.limit ?? LIST_LIMIT_DEFAULT, LIST_LIMIT_MAX);
  const page = await deps.repository.listPage(`TENANT#${input.tenantId}`, {
    limit,
    cursor: input.cursor,
  });
  const items = page.items
    .map((row) => toAuditItem(row, input.tenantId))
    .filter((item) => passFilters(item, input));
  return {
    items,
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
  };
}

/**
 * CSV export 用。 page を drain して 1 string に集約する。 上限 5000 行で truncate。
 *
 * tenant scope の PK 固定 query を {@link AdminAuditLogRepository.listAllByPartition} で最大
 * EXPORT_MAX_PAGES ページまで drain し (= memory / round-trip を bound)、
 * {@link listTenantAuditEntries} と同じ map / filter を適用したうえで maxRows で truncate する。
 */
export async function exportTenantAuditCsv(
  deps: TenantAuditDeps,
  input: Omit<TenantAuditListInput, "limit" | "cursor">,
  options: { maxRows?: number } = {},
): Promise<string> {
  const maxRows = options.maxRows ?? 5000;
  const rows = await deps.repository.listAllByPartition(`TENANT#${input.tenantId}`, {
    pageSize: LIST_LIMIT_MAX,
    maxPages: EXPORT_MAX_PAGES,
  });
  const collected: TenantAuditItem[] = [];
  for (const row of rows) {
    const item = toAuditItem(row, input.tenantId);
    if (!passFilters(item, input)) continue;
    collected.push(item);
    if (collected.length >= maxRows) break;
  }
  return formatCsv(collected);
}

/**
 * #2954: `principal` は既定で完全一致だが、末尾 `*` を付けると prefix 一致になる。
 *
 * これが要るのは machine (M2M) principal のためである。machine の actor は
 * `m2m:<clientId>` で、client id は credential を発行するたびに変わる。完全一致しか無いと
 * 「machine が起こした操作を全部見る」ができず、client id を全部集めて 1 本ずつ引くしかない。
 * `principal=m2m:*` の 1 query で引けるようにする。human の完全一致挙動は不変。
 */
function matchesPrincipal(candidate: string | undefined, filter: string): boolean {
  if (candidate === undefined) return false;
  if (filter.endsWith("*")) return candidate.startsWith(filter.slice(0, -1));
  return candidate === filter;
}

function passFilters(item: TenantAuditItem, input: TenantAuditListInput): boolean {
  if (input.from && item.occurredAt < input.from) return false;
  if (input.to && item.occurredAt > input.to) return false;
  if (input.action && item.action !== input.action) return false;
  if (input.principal) {
    if (
      !matchesPrincipal(item.actor, input.principal) &&
      !matchesPrincipal(item.actorUsername, input.principal)
    ) {
      return false;
    }
  }
  return true;
}

function toAuditItem(row: AdminAuditRow, tenantId: string): TenantAuditItem {
  const sk = row.sk;
  return {
    id: sk.startsWith("AUDIT#") ? sk.substring(6) : sk,
    tenantId,
    actor: row.actor,
    ...(row.actorUsername ? { actorUsername: row.actorUsername } : {}),
    action: row.action,
    outcome: row.outcome,
    ...(row.target ? { target: row.target } : {}),
    ...(row.ipAddress ? { ipAddress: row.ipAddress } : {}),
    ...(row.userAgent ? { userAgent: row.userAgent } : {}),
    occurredAt: row.occurredAt,
    ...(row.extra ? { extra: row.extra as Record<string, unknown> } : {}),
  };
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
    lines.push(CSV_COLUMNS.map((col) => csvEscapeField(String(row[col] ?? ""))).join(","));
  }
  return `${lines.join("\n")}\n`;
}
