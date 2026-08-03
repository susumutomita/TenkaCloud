import { type DynamoDBDocumentClient, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { queryAllItemsBounded } from "../handlers/shared/ddb-paginate.js";
import { sweepExpiredRows } from "./dynamodb-ttl-sweep.js";
import type { AdminAuditLogPage, AdminAuditLogRepository, AdminAuditRow } from "./types.js";

/**
 * [Issue #2442 / Phase C4] DynamoDB implementation of {@link AdminAuditLogRepository}. A
 * behavior-preserving extraction of the DDB access `handlers/shared/audit-log.ts` (write),
 * `handlers/event-handler/audit-log-read.ts` (tenant-scoped read), and
 * `admin-insight/handlers/admin-insight-handler/audit.ts` (SystemAdmin cross-tenant read)
 * previously performed inline: the SAME table, keys, `KeyConditionExpression` /
 * `ExpressionAttributeValues`, and marshalling. It is the default backend — flipping to SQLite
 * is a one-flag rollback (`CONTROL_DATA_BACKEND`).
 *
 * Physical shape (unchanged, `admin-audit-log-table.ts`):
 *   PK = `TENANT#<tenantId>` | `SYSTEM#<env>`     SK = `AUDIT#<ulid>`
 * GSI1 (`ACTOR#<sub>` PK) is written on every row (byte-identical Put) but never queried by any
 * handler today (grep-confirmed) — no `listByActor`-style method exists here.
 *
 * Cursor wire format: plain base64 JSON of `LastEvaluatedKey` (not the shared/cursor-codec
 * allowlist codec used elsewhere) — this is the exact encode/decode the pre-seam
 * `audit-log-read.ts` / `admin-insight-handler/audit.ts` already used, preserved byte-for-byte so
 * a cursor a client already holds keeps working across this seam's deploy.
 */
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

function itemToRow(item: Record<string, unknown>): AdminAuditRow {
  return {
    pk: String(item.PK ?? ""),
    sk: String(item.SK ?? ""),
    gsi1pk: String(item.GSI1PK ?? ""),
    gsi1sk: String(item.GSI1SK ?? ""),
    actor: String(item.actor ?? "unknown"),
    ...(typeof item.actorUsername === "string" ? { actorUsername: item.actorUsername } : {}),
    action: String(item.action ?? ""),
    outcome: String(item.outcome ?? ""),
    ...(typeof item.target === "string" ? { target: item.target } : {}),
    ...(typeof item.ipAddress === "string" ? { ipAddress: item.ipAddress } : {}),
    ...(typeof item.userAgent === "string" ? { userAgent: item.userAgent } : {}),
    occurredAt: String(item.occurredAt ?? ""),
    ttl: Number(item.ttl ?? 0),
    ...(item.extra && typeof item.extra === "object"
      ? { extra: item.extra as Record<string, unknown> }
      : {}),
  };
}

export class DynamoDbAdminAuditLogRepository implements AdminAuditLogRepository {
  constructor(
    private readonly ddb: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async appendAudit(row: AdminAuditRow): Promise<void> {
    const item: Record<string, unknown> = {
      PK: row.pk,
      SK: row.sk,
      GSI1PK: row.gsi1pk,
      GSI1SK: row.gsi1sk,
      actor: row.actor,
      action: row.action,
      outcome: row.outcome,
      occurredAt: row.occurredAt,
      ttl: row.ttl,
    };
    if (row.actorUsername) item.actorUsername = row.actorUsername;
    if (row.target) item.target = row.target;
    if (row.ipAddress) item.ipAddress = row.ipAddress;
    if (row.userAgent) item.userAgent = row.userAgent;
    if (row.extra) item.extra = row.extra;
    // Verbatim relocation: no `ConditionExpression` (unlike Disruptions' `AUDIT#` rows) — the
    // pre-seam handler never guarded against a ULID collision here either.
    await this.ddb.send(new PutCommand({ TableName: this.tableName, Item: item }));
  }

  async listPage(
    pk: string,
    opts: { readonly limit: number; readonly cursor?: string },
  ): Promise<AdminAuditLogPage> {
    const out = await this.ddb.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "PK = :pk",
        ExpressionAttributeValues: { ":pk": pk },
        Limit: opts.limit,
        ScanIndexForward: false,
        ExclusiveStartKey: decodeCursor(opts.cursor),
      }),
    );
    const items = (out.Items ?? []).map((item) => itemToRow(item as Record<string, unknown>));
    const nextCursor = encodeCursor(out.LastEvaluatedKey as Record<string, unknown> | undefined);
    return { items, ...(nextCursor ? { nextCursor } : {}) };
  }

  async listAllByPartition(
    pk: string,
    opts: { readonly pageSize: number; readonly maxPages: number },
  ): Promise<readonly AdminAuditRow[]> {
    const rows = await queryAllItemsBounded(
      this.ddb,
      {
        TableName: this.tableName,
        KeyConditionExpression: "PK = :pk",
        ExpressionAttributeValues: { ":pk": pk },
        Limit: opts.pageSize,
        ScanIndexForward: false,
      },
      opts.maxPages,
    );
    return rows.map((row) => itemToRow(row as Record<string, unknown>));
  }

  async pruneExpired(nowEpochSeconds: number): Promise<number> {
    // The `ttl` attribute is a DynamoDB reserved word, hence the `#ttl` alias.
    // Sweep rationale + loop live in `sweepExpiredRows` (shared, #2866).
    return sweepExpiredRows({
      ddb: this.ddb,
      tableName: this.tableName,
      nowEpochSeconds,
      filterExpression: "#ttl > :zero AND #ttl <= :now",
      expressionAttributeNames: { "#ttl": "ttl" },
    });
  }
}
