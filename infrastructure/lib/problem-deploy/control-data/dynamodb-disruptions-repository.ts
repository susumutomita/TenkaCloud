import {
  type DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { DisruptionAuditRow } from "../handlers/event-handler/disruption-types.js";
import { createCursorCodec } from "../handlers/shared/cursor-codec.js";
import { sweepExpiredRows } from "./dynamodb-ttl-sweep.js";
import type {
  DisruptionAuditPage,
  DisruptionClaimOutcome,
  DisruptionExecutionClaimInput,
  DisruptionRecurringMutationOutcome,
  DisruptionRecurringRecord,
  DisruptionsRepository,
} from "./types.js";

/**
 * [Issue #2442 / Phase C3] DynamoDB implementation of {@link DisruptionsRepository}. A
 * behavior-preserving extraction of the DDB access `event-handler/disruption-fire.ts` /
 * `event-handler/disruption-recurring.ts` / `disruption-executor-handler/executor-store.ts` /
 * `generic-scoring-handler/index.ts` previously performed inline: the SAME table, keys,
 * `ConditionExpression` / `KeyConditionExpression` / `ExpressionAttributeValues`, and
 * marshalling. It is the default backend — flipping to SQLite is a one-flag rollback
 * (`CONTROL_DATA_BACKEND`).
 *
 * Physical shape (unchanged, `disruptions-table.ts`):
 *   PK = `EVENT#<eventId>`     SK = `AUDIT#<firedAt>#<auditId>`
 *   PK = `EVENT#<eventId>`     SK = `RECUR#<requestId>`
 *   PK = `REQUEST#<tenantId>#<requestId>`  SK = `METADATA`
 *   PK = `EXEC#<requestId>#<teamId>[...]`  SK = `METADATA`
 * GSI1 (`TENANT#<tenantId>` PK) is written on every row (byte-identical to the pre-seam Puts)
 * but is never queried by this backend — no handler reads it today (grep-confirmed).
 */
const AUDIT_PAGE_CURSOR_CODEC = createCursorCodec(new Set(["PK", "SK", "GSI1PK", "GSI1SK"]));

function requestIdempotencyKey(tenantId: string, requestId: string): string {
  return `REQUEST#${tenantId}#${requestId}`;
}

function isConditionalCheckFailed(err: unknown): boolean {
  return err instanceof Error && err.name === "ConditionalCheckFailedException";
}

/** Normalizes a raw DDB item into the domain {@link DisruptionAuditRow}, defaults for missing fields. */
function itemToAuditRow(item: Record<string, unknown>): DisruptionAuditRow {
  const scheduledFor = item.scheduledFor;
  return {
    auditId: String(item.auditId ?? ""),
    tenantId: String(item.tenantId ?? ""),
    eventId: String(item.eventId ?? ""),
    problemId: String(item.problemId ?? ""),
    disruptionId: String(item.disruptionId ?? ""),
    firedBy: String(item.firedBy ?? ""),
    firedAt: String(item.firedAt ?? ""),
    scope: (item.scope ?? "team") as DisruptionAuditRow["scope"],
    targetTeamIds: Array.isArray(item.targetTeamIds) ? (item.targetTeamIds as string[]) : [],
    parameters: (item.parameters && typeof item.parameters === "object"
      ? item.parameters
      : {}) as Readonly<Record<string, unknown>>,
    requestId: String(item.requestId ?? ""),
    expiresAt: Number(item.expiresAt ?? 0),
    ...(typeof scheduledFor === "string" ? { scheduledFor } : {}),
  };
}

function itemToRecurringRecord(item: Record<string, unknown>): DisruptionRecurringRecord {
  const cancelledAt = item.cancelledAt;
  return {
    requestId: String(item.requestId ?? ""),
    tenantId: String(item.tenantId ?? ""),
    eventId: String(item.eventId ?? ""),
    problemId: String(item.problemId ?? ""),
    disruptionId: String(item.disruptionId ?? ""),
    firedBy: String(item.firedBy ?? ""),
    firedAt: String(item.firedAt ?? ""),
    scope: String(item.scope ?? ""),
    affectedTeamIds: Array.isArray(item.affectedTeamIds) ? (item.affectedTeamIds as string[]) : [],
    intervalMinutes: Number(item.intervalMinutes ?? 0),
    maxFires: Number(item.maxFires ?? 0),
    endsAt: String(item.endsAt ?? ""),
    expiresAt: Number(item.expiresAt ?? 0),
    ...(typeof cancelledAt === "string" ? { cancelledAt } : {}),
  };
}

/** `EXEC#<requestId>#<teamId>[#INJECT|#RECUR#<firedAt>]` — mirrors the pre-seam `claimExecution`. */
function executionClaimKey(input: DisruptionExecutionClaimInput): string {
  if (input.phase === "inject") return `EXEC#${input.requestId}#${input.teamId}#INJECT`;
  if (input.phase === "recurring") {
    return `EXEC#${input.requestId}#${input.teamId}#RECUR#${input.firedAt}`;
  }
  return `EXEC#${input.requestId}#${input.teamId}`;
}

export class DynamoDbDisruptionsRepository implements DisruptionsRepository {
  constructor(
    private readonly ddb: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async claimFireIdempotency(draft: DisruptionAuditRow): Promise<DisruptionClaimOutcome> {
    const idempotencyKey = requestIdempotencyKey(draft.tenantId, draft.requestId);
    try {
      await this.ddb.send(
        new PutCommand({
          TableName: this.tableName,
          Item: {
            PK: idempotencyKey,
            SK: "METADATA",
            GSI1PK: idempotencyKey,
            GSI1SK: "METADATA",
            ...draft,
          },
          ConditionExpression: "attribute_not_exists(PK)",
        }),
      );
      return { outcome: "claimed" };
    } catch (err) {
      if (isConditionalCheckFailed(err)) return { outcome: "already" };
      throw err;
    }
  }

  async getFireIdempotencyRecord(
    tenantId: string,
    requestId: string,
  ): Promise<DisruptionAuditRow | undefined> {
    const out = await this.ddb.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { PK: requestIdempotencyKey(tenantId, requestId), SK: "METADATA" },
        ConsistentRead: true,
      }),
    );
    const item = out.Item as Record<string, unknown> | undefined;
    if (!item || typeof item.auditId !== "string" || item.auditId.length === 0) return undefined;
    return itemToAuditRow(item);
  }

  async appendAudit(record: DisruptionAuditRow): Promise<void> {
    await this.ddb.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          PK: `EVENT#${record.eventId}`,
          SK: `AUDIT#${record.firedAt}#${record.auditId}`,
          GSI1PK: `TENANT#${record.tenantId}`,
          GSI1SK: `AUDIT#${record.firedAt}#${record.auditId}`,
          ...record,
        },
        // 同 SK の上書きを防ぐ (= 万一 ULID collision でも reject)。 CCF は意図的に catch しない
        // (= pre-seam handler と同じく uncaught で fail loud)。
        ConditionExpression: "attribute_not_exists(SK)",
      }),
    );
  }

  async listAuditPage(
    eventId: string,
    opts: { readonly limit: number; readonly cursor?: string },
  ): Promise<DisruptionAuditPage> {
    const exclusiveStartKey = opts.cursor ? AUDIT_PAGE_CURSOR_CODEC.decode(opts.cursor) : undefined;
    const out = await this.ddb.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :ap)",
        ExpressionAttributeValues: { ":pk": `EVENT#${eventId}`, ":ap": "AUDIT#" },
        ScanIndexForward: false,
        Limit: opts.limit,
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }),
    );
    const items = (out.Items ?? []).map((item) => itemToAuditRow(item as Record<string, unknown>));
    const nextCursor = out.LastEvaluatedKey
      ? AUDIT_PAGE_CURSOR_CODEC.encode(out.LastEvaluatedKey as Record<string, unknown>)
      : undefined;
    return { items, ...(nextCursor ? { nextCursor } : {}) };
  }

  async listAuditSince(eventId: string, sinceIso: string): Promise<readonly DisruptionAuditRow[]> {
    // Verbatim relocation: no `begins_with` on the pre-seam query, so this also matches any
    // `RECUR#` rows lexicographically >= "AUDIT#<sinceIso>" (harmless — RECUR# rows carry
    // `affectedTeamIds`, not `targetTeamIds`, so downstream `resolveOperatorEffects` filters
    // them out by shape). No page drain, matching the pre-seam single Query.
    const out = await this.ddb.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "PK = :pk AND SK >= :since",
        ExpressionAttributeValues: {
          ":pk": `EVENT#${eventId}`,
          ":since": `AUDIT#${sinceIso}`,
        },
      }),
    );
    return (out.Items ?? []).map((item) => itemToAuditRow(item as Record<string, unknown>));
  }

  async putRecurringRegistry(record: DisruptionRecurringRecord): Promise<void> {
    await this.ddb.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          PK: `EVENT#${record.eventId}`,
          SK: `RECUR#${record.requestId}`,
          GSI1PK: `TENANT#${record.tenantId}`,
          GSI1SK: `RECUR#${record.firedAt}#${record.requestId}`,
          ...record,
        },
        ConditionExpression: "attribute_not_exists(SK)",
      }),
    );
  }

  async listRecurringByEvent(
    eventId: string,
    tenantId: string,
  ): Promise<readonly DisruptionRecurringRecord[]> {
    const out = await this.ddb.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :p)",
        FilterExpression: "tenantId = :t",
        ExpressionAttributeValues: {
          ":pk": `EVENT#${eventId}`,
          ":p": "RECUR#",
          ":t": tenantId,
        },
      }),
    );
    return (out.Items ?? []).map((item) => itemToRecurringRecord(item as Record<string, unknown>));
  }

  async getRecurringRegistry(
    eventId: string,
    requestId: string,
  ): Promise<DisruptionRecurringRecord | undefined> {
    const out = await this.ddb.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { PK: `EVENT#${eventId}`, SK: `RECUR#${requestId}` },
      }),
    );
    return out.Item ? itemToRecurringRecord(out.Item as Record<string, unknown>) : undefined;
  }

  async cancelRecurringRegistry(
    eventId: string,
    requestId: string,
    tenantId: string,
    cancelledAt: string,
  ): Promise<DisruptionRecurringMutationOutcome> {
    try {
      await this.ddb.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { PK: `EVENT#${eventId}`, SK: `RECUR#${requestId}` },
          UpdateExpression: "SET cancelledAt = :c",
          ConditionExpression: "tenantId = :t",
          ExpressionAttributeValues: { ":c": cancelledAt, ":t": tenantId },
        }),
      );
      return { outcome: "updated" };
    } catch (err) {
      if (isConditionalCheckFailed(err)) return { outcome: "not_found" };
      throw err;
    }
  }

  async claimExecutionSlot(input: DisruptionExecutionClaimInput): Promise<DisruptionClaimOutcome> {
    try {
      await this.ddb.send(
        new PutCommand({
          TableName: this.tableName,
          Item: {
            PK: executionClaimKey(input),
            SK: "METADATA",
            disruptionId: input.disruptionId,
            eventId: input.eventId,
            problemId: input.problemId,
            tenantId: input.tenantId,
            teamId: input.teamId,
            requestId: input.requestId,
            firedAt: input.firedAt,
            expiresAt: input.expiresAt,
          },
          ConditionExpression: "attribute_not_exists(PK)",
        }),
      );
      return { outcome: "claimed" };
    } catch (err) {
      if (isConditionalCheckFailed(err)) return { outcome: "already" };
      throw err;
    }
  }

  async pruneExpired(nowEpochSeconds: number): Promise<number> {
    // Sweep rationale (native TTL vs seam uniformity) + loop live
    // in `sweepExpiredRows` (shared, #2866). One Scan covers every row shape
    // (audit / fire-claim / recurring / exec-claim) since they all share this
    // physical table.
    return sweepExpiredRows({
      ddb: this.ddb,
      tableName: this.tableName,
      nowEpochSeconds,
      filterExpression: "expiresAt > :zero AND expiresAt <= :now",
    });
  }
}
