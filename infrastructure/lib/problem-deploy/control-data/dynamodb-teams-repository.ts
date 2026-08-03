import {
  DeleteCommand,
  type DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";
import type { TeamItem } from "../handlers/event-handler/types.js";
import { deploymentPk, META_SK } from "./dynamodb-deployments-core.js";
import { sweepExpiredRows } from "./dynamodb-ttl-sweep.js";
import type {
  TeamDeploymentRecord,
  TeamLoginKeyRotationInput,
  TeamLoginKeyRotationOutcome,
  TeamRecord,
  TeamsRepository,
} from "./types.js";

function isConditionalTransactionCancellation(error: unknown): boolean {
  if (!(error instanceof Error) || error.name !== "TransactionCanceledException") return false;
  const reasons = (error as { CancellationReasons?: ReadonlyArray<{ Code?: string }> })
    .CancellationReasons;
  return (reasons ?? []).some((reason) => reason.Code === "ConditionalCheckFailed");
}

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
 *   TTL attribute = `expiresAt` (epoch seconds)
 *
 * [Issue #2674] The Teams table no longer carries a login-key GSI. Participant
 * authentication reads the **Deployments** table (`listByTeamLoginKey`), so the
 * old `GSI2PK = TEAMKEY#<plaintext>` index was a write-only exposure of the
 * participant bearer plus a dead 1-RCU/1-WCU standing cost. The plaintext
 * `teamLoginKey` ATTRIBUTE stays — `listTeamsForDeployment` supplies it as the
 * bulk-deploy credential and the operator key-distribution path reads it.
 */

const TEAM_SK_PREFIX = "TEAM#" as const;
// GSI2PK / GSI2SK stay in the strip set even though nothing writes them anymore
// (#2674): rows written before the GSI2 removal still carry the attributes, and
// they must not surface as TeamRecord fields.
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
 * [#2674] GSI2PK / GSI2SK are no longer written — the Teams login-key index is
 * gone; the plaintext `teamLoginKey` attribute itself stays (credential supply).
 *
 * Exported for `DynamoDbEventsRepository.createEventWithTeams` (#2437) — the
 * atomic event+teams transaction must marshal team rows with the exact same
 * keys as this repository's own writes.
 */
export function teamRecordToItem(record: TeamRecord): TeamItem {
  return {
    PK: `EVENT#${record.eventId}`,
    SK: `${TEAM_SK_PREFIX}${record.teamId}`,
    GSI1PK: `TENANT#${record.tenantId}`,
    GSI1SK: `EVENT#${record.eventId}#TEAM#${record.teamId}`,
    ...record,
    teamLoginKey: record.teamLoginKey ?? "",
  };
}

export class DynamoDbTeamsRepository implements TeamsRepository {
  constructor(
    private readonly ddb: DynamoDBDocumentClient,
    private readonly tableName: string,
    private readonly deploymentsTableName?: string,
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

  async listTeamsForDeployment(eventId: string): Promise<readonly TeamDeploymentRecord[]> {
    const records = await this.listTeamsByEvent(eventId);
    return records.map((record) => {
      const { teamLoginKey, ...team } = record;
      if (!teamLoginKey) {
        throw new Error(
          `team ${record.teamId} in event ${eventId} has no participant login credential`,
        );
      }
      return { ...team, credential: { kind: "plaintext", value: teamLoginKey } };
    });
  }

  async rotateLoginKey(input: TeamLoginKeyRotationInput): Promise<TeamLoginKeyRotationOutcome> {
    if (input.deployments.length > 99) {
      throw new Error("rotateLoginKey supports at most 99 deployments per DynamoDB transaction");
    }
    if (input.deployments.length > 0 && !this.deploymentsTableName) {
      throw new Error("rotateLoginKey requires a deployments table name");
    }
    const transactItems: TransactWriteCommandInput["TransactItems"] = [
      {
        Update: {
          TableName: this.tableName,
          Key: { PK: `EVENT#${input.eventId}`, SK: `${TEAM_SK_PREFIX}${input.teamId}` },
          // [#2674] The Teams login-key GSI is gone, so rotation only rewrites the
          // plaintext attribute; the auth-path index rewrite is the deployments
          // Update below (GSI2 on the DEPLOYMENTS table, unchanged).
          UpdateExpression: "SET teamLoginKey = :loginKey, updatedAt = :updatedAt",
          ConditionExpression:
            "tenantId = :tenantId AND eventId = :eventId AND teamId = :teamId AND updatedAt = :expectedUpdatedAt",
          ExpressionAttributeValues: {
            ":loginKey": input.newLoginKey,
            ":updatedAt": input.updatedAt,
            ":tenantId": input.tenantId,
            ":eventId": input.eventId,
            ":teamId": input.teamId,
            ":expectedUpdatedAt": input.expectedUpdatedAt,
          },
        },
      },
      ...input.deployments.map((deployment) => ({
        Update: {
          TableName: this.deploymentsTableName as string,
          Key: { PK: deploymentPk(deployment.jobId), SK: META_SK },
          UpdateExpression:
            "SET teamLoginKey = :loginKey, GSI2PK = :gsi2pk, GSI2SK = :gsi2sk, updatedAt = :updatedAt",
          ConditionExpression: "tenantId = :tenantId AND eventId = :eventId AND teamId = :teamId",
          ExpressionAttributeValues: {
            ":loginKey": input.newLoginKey,
            ":gsi2pk": `TEAMKEY#${input.newLoginKey}`,
            ":gsi2sk": deployment.createdAt,
            ":updatedAt": input.updatedAt,
            ":tenantId": input.tenantId,
            ":eventId": input.eventId,
            ":teamId": input.teamId,
          },
        },
      })),
    ];
    try {
      await this.ddb.send(new TransactWriteCommand({ TransactItems: transactItems }));
      return { outcome: "updated" };
    } catch (error) {
      if (isConditionalTransactionCancellation(error)) return { outcome: "conflict" };
      throw error;
    }
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
    // Sweep rationale (native TTL vs seam uniformity, ADR-049 §5.2) + loop live
    // in `sweepExpiredRows` (shared, #2866).
    return sweepExpiredRows({
      ddb: this.ddb,
      tableName: this.tableName,
      nowEpochSeconds,
      filterExpression: "expiresAt > :zero AND expiresAt <= :now",
    });
  }
}
