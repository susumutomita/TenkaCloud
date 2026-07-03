import {
  DeleteCommand,
  type DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import type { EventItem } from "../handlers/event-handler/types.js";
import type { EventRecord, EventsRepository } from "./types.js";

/**
 * [ADR-049 §5.1] DynamoDB implementation of {@link EventsRepository}. This is a
 * behavior-preserving extraction of the DDB access the event-handler already
 * performs (`handlers/event-handler/{list,create}.ts`): the SAME table, keys,
 * GSI, and marshalling. It is the default backend — flipping to SQLite is a
 * one-flag rollback (`CONTROL_DATA_BACKEND`).
 *
 * Physical shape (unchanged, `problem-deploy/events-table.ts`):
 *   PK     = `EVENT#<eventId>`   / SK     = `META`
 *   GSI1PK = `TENANT#<tenantId>` / GSI1SK = `<createdAt>` (ISO 8601)
 *   TTL attribute = `expiresAt` (epoch seconds)
 */

const EVENT_SK = "META" as const;
const DDB_KEY_ATTRS: ReadonlySet<string> = new Set(["PK", "SK", "GSI1PK", "GSI1SK"]);

/** Strip the physical DDB keys, yielding the domain {@link EventRecord}. */
function itemToRecord(item: Record<string, unknown>): EventRecord {
  const record: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(item)) {
    if (DDB_KEY_ATTRS.has(key)) continue;
    record[key] = value;
  }
  return record as unknown as EventRecord;
}

/**
 * Re-derive the physical DDB item from a domain record. The key derivation is
 * byte-identical to `handlers/event-handler/create.ts` (GSI1SK = createdAt), so a
 * record written here is indistinguishable from one written by the existing
 * transactional create path.
 */
function recordToItem(record: EventRecord): EventItem {
  return {
    PK: `EVENT#${record.eventId}`,
    SK: EVENT_SK,
    GSI1PK: `TENANT#${record.tenantId}`,
    GSI1SK: record.createdAt,
    ...record,
  };
}

export class DynamoDbEventsRepository implements EventsRepository {
  constructor(
    private readonly ddb: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async getEvent(tenantId: string, eventId: string): Promise<EventRecord | undefined> {
    const out = await this.ddb.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { PK: `EVENT#${eventId}`, SK: EVENT_SK },
      }),
    );
    const item = out.Item as Record<string, unknown> | undefined;
    // Same guard the handlers apply inline: absent row or tenant mismatch → 404.
    if (!item || item.tenantId !== tenantId) return undefined;
    return itemToRecord(item);
  }

  async putEvent(record: EventRecord): Promise<void> {
    await this.ddb.send(new PutCommand({ TableName: this.tableName, Item: recordToItem(record) }));
  }

  async listEventsByTenant(tenantId: string): Promise<readonly EventRecord[]> {
    const records: EventRecord[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const out = await this.ddb.send(
        new QueryCommand({
          TableName: this.tableName,
          IndexName: "GSI1",
          KeyConditionExpression: "GSI1PK = :pk",
          ExpressionAttributeValues: { ":pk": `TENANT#${tenantId}` },
          // GSI1SK = createdAt → descending = newest-first (mirrors listEvents).
          ScanIndexForward: false,
          ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
        }),
      );
      for (const item of (out.Items ?? []) as Record<string, unknown>[]) {
        records.push(itemToRecord(item));
      }
      exclusiveStartKey = out.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (exclusiveStartKey);
    return records;
  }

  async pruneExpired(nowEpochSeconds: number): Promise<number> {
    // DynamoDB removes expired rows natively via the `expiresAt` TTL attribute;
    // this manual sweep exists so the seam is uniform with the SQLite backends
    // (no native TTL, ADR-049 §5.2). It is idempotent and only ever deletes rows
    // DynamoDB's own TTL would also drop, so it is safe on the DDB backend too.
    let deleted = 0;
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const out = await this.ddb.send(
        new ScanCommand({
          TableName: this.tableName,
          FilterExpression: "expiresAt > :zero AND expiresAt <= :now",
          ExpressionAttributeValues: { ":zero": 0, ":now": nowEpochSeconds },
          ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
        }),
      );
      for (const item of (out.Items ?? []) as Record<string, unknown>[]) {
        await this.ddb.send(
          new DeleteCommand({
            TableName: this.tableName,
            Key: { PK: item.PK, SK: item.SK },
          }),
        );
        deleted += 1;
      }
      exclusiveStartKey = out.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (exclusiveStartKey);
    return deleted;
  }
}
