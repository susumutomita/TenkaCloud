import { type DynamoDBDocumentClient, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { createCursorCodec } from "../handlers/shared/cursor-codec.js";
import type { NotificationItem } from "../handlers/shared/notification.js";
import { sweepExpiredRows } from "./dynamodb-ttl-sweep.js";
import type { NotificationRecord, NotificationsPage, NotificationsRepository } from "./types.js";

const NOTIFICATION_SK_PREFIX = "NOTIFICATION#" as const;
const NOTIFICATIONS_PAGE_CURSOR_CODEC = createCursorCodec(new Set(["PK", "SK"]));
const DDB_KEY_ATTRS: ReadonlySet<string> = new Set(["PK", "SK"]);

function itemToRecord(item: Record<string, unknown>): NotificationRecord {
  const record: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(item)) {
    if (DDB_KEY_ATTRS.has(key)) continue;
    record[key] = value;
  }
  return record as unknown as NotificationRecord;
}

function recordToItem(record: NotificationRecord): NotificationItem {
  return {
    PK: `EVENT#${record.eventId}`,
    SK: `${NOTIFICATION_SK_PREFIX}${record.occurredAt}#${record.notificationId}`,
    ...record,
  };
}

export class DynamoDbNotificationsRepository implements NotificationsRepository {
  constructor(
    private readonly ddb: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async append(record: NotificationRecord): Promise<void> {
    await this.ddb.send(new PutCommand({ TableName: this.tableName, Item: recordToItem(record) }));
  }

  async listByEvent(
    eventId: string,
    opts: { readonly limit: number; readonly cursor?: string },
  ): Promise<NotificationsPage> {
    const exclusiveStartKey = opts.cursor
      ? NOTIFICATIONS_PAGE_CURSOR_CODEC.decode(opts.cursor)
      : undefined;
    const out = await this.ddb.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
        ExpressionAttributeValues: {
          ":pk": `EVENT#${eventId}`,
          ":prefix": NOTIFICATION_SK_PREFIX,
        },
        ScanIndexForward: false,
        Limit: opts.limit,
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }),
    );
    const notifications = (out.Items ?? []).map((item) =>
      itemToRecord(item as Record<string, unknown>),
    );
    const nextCursor = out.LastEvaluatedKey
      ? NOTIFICATIONS_PAGE_CURSOR_CODEC.encode(out.LastEvaluatedKey as Record<string, unknown>)
      : undefined;
    return { notifications, nextCursor };
  }

  async pruneExpired(nowEpochSeconds: number): Promise<number> {
    // Sweep rationale (native TTL vs seam uniformity) + loop live
    // in `sweepExpiredRows` (shared, #2866).
    return sweepExpiredRows({
      ddb: this.ddb,
      tableName: this.tableName,
      nowEpochSeconds,
      filterExpression: "expiresAt > :zero AND expiresAt <= :now",
    });
  }
}
