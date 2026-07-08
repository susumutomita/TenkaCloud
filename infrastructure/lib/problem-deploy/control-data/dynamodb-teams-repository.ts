import {
  DeleteCommand,
  type DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import type { TeamItem } from "../handlers/event-handler/types.js";
import type { TeamRecord, TeamsRepository } from "./types.js";

/**
 * [ADR-049 §5.1] DynamoDB implementation of {@link TeamsRepository}. This is a
 * behavior-preserving extraction of the DDB access the event-handler already
 * performs (`handlers/event-handler/{create,list}.ts`): the SAME table, keys,
 * GSIs, and marshalling. It is the default backend — flipping to SQLite is a
 * one-flag rollback (`CONTROL_DATA_BACKEND`).
 *
 * Physical shape (unchanged, `problem-deploy/teams-table.ts` / event-handler
 * `create.ts`):
 *   PK     = `EVENT#<eventId>`   / SK     = `TEAM#<teamId>`
 *   GSI1PK = `TENANT#<tenantId>` / GSI1SK = `EVENT#<eventId>#TEAM#<teamId>`
 *   GSI2PK = `TEAMKEY#<teamLoginKey>` / GSI2SK = `META`   (sparse — participant login)
 *   TTL attribute = `expiresAt` (epoch seconds)
 *
 * GSI2 は **sparse**: `teamLoginKey` が空のときは GSI2PK / GSI2SK を書かず index から
 * 外す (= create.ts が `TEAMKEY#<key>` を書く挙動、 teardown が REMOVE で失効させる挙動と
 * 一致させる)。
 */

const TEAM_SK_PREFIX = "TEAM#" as const;
const TEAM_GSI2_SK = "META" as const;
const DDB_KEY_ATTRS: ReadonlySet<string> = new Set([
  "PK",
  "SK",
  "GSI1PK",
  "GSI1SK",
  "GSI2PK",
  "GSI2SK",
]);

/** Strip the six physical DDB keys, yielding the domain {@link TeamRecord}. */
function itemToRecord(item: Record<string, unknown>): TeamRecord {
  const record: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(item)) {
    if (DDB_KEY_ATTRS.has(key)) continue;
    record[key] = value;
  }
  return record as unknown as TeamRecord;
}

/**
 * Re-derive the physical DDB item from a domain record. The key derivation is
 * byte-identical to `handlers/event-handler/create.ts`, so a record written here
 * is indistinguishable from one written by the existing transactional create path.
 * GSI2PK / GSI2SK are written **only when `teamLoginKey` is non-empty** so the
 * participant-login index stays sparse (matches create.ts / teardown behavior).
 *
 * Exported for `DynamoDbEventsRepository.createEventWithTeams` (#2437) — the
 * atomic event+teams transaction must marshal team rows with the exact same
 * keys as this repository's own writes.
 */
export function teamRecordToItem(record: TeamRecord): TeamItem {
  const base: TeamItem = {
    PK: `EVENT#${record.eventId}`,
    SK: `${TEAM_SK_PREFIX}${record.teamId}`,
    GSI1PK: `TENANT#${record.tenantId}`,
    GSI1SK: `EVENT#${record.eventId}#TEAM#${record.teamId}`,
    ...record,
    teamLoginKey: record.teamLoginKey ?? "",
  };
  if (record.teamLoginKey) {
    base.GSI2PK = `TEAMKEY#${record.teamLoginKey}`;
    base.GSI2SK = TEAM_GSI2_SK;
  }
  return base;
}

export class DynamoDbTeamsRepository implements TeamsRepository {
  constructor(
    private readonly ddb: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async getTeam(
    tenantId: string,
    eventId: string,
    teamId: string,
  ): Promise<TeamRecord | undefined> {
    const out = await this.ddb.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { PK: `EVENT#${eventId}`, SK: `${TEAM_SK_PREFIX}${teamId}` },
      }),
    );
    const item = out.Item as Record<string, unknown> | undefined;
    // Same guard the handlers apply inline: absent row or tenant mismatch → 404.
    if (!item || item.tenantId !== tenantId) return undefined;
    return itemToRecord(item);
  }

  async getTeamByLoginKey(loginKey: string): Promise<TeamRecord | undefined> {
    // Participant bearer lookup: GSI2 (`TEAMKEY#<key>`) は sparse かつ team 毎に一意なので
    // 高々 1 行しか返らない。 先頭行を採用し、 無ければ undefined (= 401 相当)。
    const out = await this.ddb.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: "GSI2",
        KeyConditionExpression: "GSI2PK = :pk",
        ExpressionAttributeValues: { ":pk": `TEAMKEY#${loginKey}` },
      }),
    );
    const item = (out.Items ?? [])[0] as Record<string, unknown> | undefined;
    if (!item) return undefined;
    return itemToRecord(item);
  }

  async listTeamsByEvent(eventId: string): Promise<readonly TeamRecord[]> {
    const records: TeamRecord[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const out = await this.ddb.send(
        new QueryCommand({
          TableName: this.tableName,
          // event-handler/list.ts の getEventDetail が発火していた inline query と byte 互換。
          KeyConditionExpression: "PK = :pk AND begins_with(SK, :tprefix)",
          ExpressionAttributeValues: {
            ":pk": `EVENT#${eventId}`,
            ":tprefix": TEAM_SK_PREFIX,
          },
          // 既定 ScanIndexForward=true → SK 昇順 = `TEAM#<teamId>` 昇順 = teamId 昇順。
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

  async putTeam(record: TeamRecord): Promise<void> {
    await this.ddb.send(
      new PutCommand({ TableName: this.tableName, Item: teamRecordToItem(record) }),
    );
  }

  async deleteTeam(eventId: string, teamId: string): Promise<void> {
    await this.ddb.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: { PK: `EVENT#${eventId}`, SK: `${TEAM_SK_PREFIX}${teamId}` },
      }),
    );
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
