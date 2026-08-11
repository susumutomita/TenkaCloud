import {
  BatchGetCommand,
  DeleteCommand,
  type DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
  UpdateCommand,
  type UpdateCommandInput,
} from "@aws-sdk/lib-dynamodb";
import type { EventItem } from "../handlers/event-handler/types.js";
import { createCursorCodec } from "../handlers/shared/cursor-codec.js";
import {
  type ProgressionGateConfig,
  parseProgressionGate,
} from "../handlers/shared/progression-gate.js";
import { teamRecordToItem } from "./dynamodb-teams-repository.js";
import { sweepExpiredRows } from "./dynamodb-ttl-sweep.js";
import type {
  ClearProgressionGateOutcome,
  CreateEventWithTeamsOutcome,
  EventMutationOutcome,
  EventRecord,
  EventSchedulePatch,
  EventScoringMeta,
  EventsPage,
  EventsRepository,
  ScheduleFiredKind,
  TeamRecord,
} from "./types.js";

/**
 * DynamoDB implementation of {@link EventsRepository}. This is a
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

/**
 * [#862 / #2438] Same allowlist + wire format as the pre-seam `list.ts` cursor
 * codec (moved here verbatim). Moving the Query into this seam must not
 * invalidate cursors already handed out mid-pagination to a UI.
 */
const EVENTS_PAGE_CURSOR_CODEC = createCursorCodec(new Set(["PK", "SK", "GSI1PK", "GSI1SK"]));

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

function isConditionalCheckFailed(err: unknown): boolean {
  return err instanceof Error && err.name === "ConditionalCheckFailedException";
}

/**
 * TransactWrite reports a failed per-item `ConditionExpression` as a
 * `TransactionCanceledException` whose `CancellationReasons` carry
 * `ConditionalCheckFailed` — the transactional sibling of a plain CCF.
 */
function isTransactConditionalCheckFailed(err: unknown): boolean {
  if (!(err instanceof Error) || err.name !== "TransactionCanceledException") return false;
  const reasons = (err as { CancellationReasons?: ReadonlyArray<{ Code?: string }> })
    .CancellationReasons;
  return (reasons ?? []).some((reason) => reason?.Code === "ConditionalCheckFailed");
}

export class DynamoDbEventsRepository implements EventsRepository {
  constructor(
    private readonly ddb: DynamoDBDocumentClient,
    private readonly tableName: string,
    /**
     * [#2437] Required only by {@link createEventWithTeams} (the one method that
     * writes the Teams table). Events-only wirings (e.g. the scheduled-teardown
     * path, which has no Teams table) may omit it — calling
     * `createEventWithTeams` without it fails loudly.
     */
    private readonly teamsTableName?: string,
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

  async deleteEvent(eventId: string): Promise<void> {
    await this.ddb.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: { PK: `EVENT#${eventId}`, SK: EVENT_SK },
      }),
    );
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

  async listEventsPage(
    tenantId: string,
    opts: { readonly limit: number; readonly cursor?: string },
  ): Promise<EventsPage> {
    const exclusiveStartKey = opts.cursor
      ? EVENTS_PAGE_CURSOR_CODEC.decode(opts.cursor)
      : undefined;
    const out = await this.ddb.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: "GSI1",
        KeyConditionExpression: "GSI1PK = :pk",
        ExpressionAttributeValues: { ":pk": `TENANT#${tenantId}` },
        ScanIndexForward: false,
        Limit: opts.limit,
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }),
    );
    const events = (out.Items ?? []).map((item) => itemToRecord(item as Record<string, unknown>));
    const nextCursor = out.LastEvaluatedKey
      ? EVENTS_PAGE_CURSOR_CODEC.encode(out.LastEvaluatedKey as Record<string, unknown>)
      : undefined;
    return { events, nextCursor };
  }

  async listEventsByStatus(statuses: readonly string[]): Promise<readonly EventRecord[]> {
    if (statuses.length === 0) return [];
    // Placeholder names are generated (not the caller's status strings) so this
    // works for any status set; DynamoDB does not care about alias naming.
    const filterExpression = statuses.map((_, i) => `#s = :s${i}`).join(" OR ");
    const expressionAttributeValues = Object.fromEntries(statuses.map((s, i) => [`:s${i}`, s]));
    const records: EventRecord[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const out = await this.ddb.send(
        new ScanCommand({
          TableName: this.tableName,
          FilterExpression: filterExpression,
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: expressionAttributeValues,
          // Mirrors the pre-seam reconciler Scan's page size (MVP scale).
          Limit: 100,
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

  async batchGetEvents(
    eventIds: readonly string[],
  ): Promise<ReadonlyMap<string, EventScoringMeta>> {
    const map = new Map<string, EventScoringMeta>();
    if (eventIds.length === 0) return map;
    // [PR #2455 review] Real DynamoDB BatchGet rejects a request whose Keys
    // contain a duplicate (ValidationException) — dedupe defensively so a
    // caller that hasn't already deduped (unlike today's sole caller,
    // fetchEventScoringMetaMap) doesn't fail the whole batch. Also caps at
    // BatchGet's 100-key-per-request limit (mirrors createEventWithTeams's
    // 100-item TransactWrite cap); a caller needing more must chunk itself.
    const ids = [...new Set(eventIds)];
    if (ids.length > 100) {
      throw new Error(
        `batchGetEvents: ${ids.length} distinct ids exceeds the 100-key BatchGet limit`,
      );
    }
    // [#558] UnprocessedKeys are not retried, mirroring the pre-seam handler's
    // behavior — a partial BatchGet response yields a partial map, and callers
    // treat a missing id as "no meta" (fail-closed policy lives in the caller).
    const out = await this.ddb.send(
      new BatchGetCommand({
        RequestItems: {
          [this.tableName]: {
            Keys: ids.map((eventId) => ({ PK: `EVENT#${eventId}`, SK: EVENT_SK })),
            ProjectionExpression: "eventId, scoringLocked, progressionGate",
          },
        },
      }),
    );
    const rows = (out.Responses?.[this.tableName] ?? []) as Record<string, unknown>[];
    for (const row of rows) {
      if (typeof row.eventId !== "string") continue;
      map.set(row.eventId, {
        scoringLocked: row.scoringLocked === true,
        progressionGate: parseProgressionGate(row.progressionGate),
      });
    }
    return map;
  }

  async countEventsByTenant(tenantId: string): Promise<number> {
    let total = 0;
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const out = await this.ddb.send(
        new QueryCommand({
          TableName: this.tableName,
          IndexName: "GSI1",
          KeyConditionExpression: "GSI1PK = :pk",
          ExpressionAttributeValues: { ":pk": `TENANT#${tenantId}` },
          Select: "COUNT",
          ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
        }),
      );
      total += out.Count ?? 0;
      exclusiveStartKey = out.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (exclusiveStartKey);
    return total;
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

  // ---------------------------------------------------------------------------
  // [Issue #2437 / Phase A2] Conditional writes. Every Update/Condition
  // expression below is a verbatim relocation of the pre-seam handler code —
  // do not "improve" an expression here without a dedicated migration issue.
  // ---------------------------------------------------------------------------

  /** Key of the Events META row (same derivation as every read above). */
  private eventKey(eventId: string): { PK: string; SK: string } {
    return { PK: `EVENT#${eventId}`, SK: EVENT_SK };
  }

  /**
   * CCF probe (mirrors the pre-seam catch + Get pattern): absent row / tenant
   * mismatch folds to `not_found`, anything else is a state `conflict` carrying
   * the probed event.
   */
  private async probeConflict(tenantId: string, eventId: string): Promise<EventMutationOutcome> {
    const event = await this.getEvent(tenantId, eventId);
    if (!event) return { outcome: "not_found" };
    return { outcome: "conflict", event };
  }

  /**
   * Maps an `ALL_NEW` response to `updated`. A missing `Attributes` (never
   * produced by real DynamoDB on a successful ALL_NEW update) folds to
   * `not_found`, preserving the pre-seam handlers' defensive branch.
   */
  private static updatedFrom(
    attributes: Record<string, unknown> | undefined,
  ): EventMutationOutcome {
    if (!attributes) return { outcome: "not_found" };
    return { outcome: "updated", event: itemToRecord(attributes) };
  }

  /**
   * One conditional Events-META update through the shared scaffold: fire the
   * verbatim expression, map success per `ReturnValues`, and map a CCF per the
   * method's `onCcf` policy (`probe` = re-read to split not_found/conflict,
   * `conflict` = fire-and-forget fold with no probe read, `not_found` =
   * tenant-scope-only condition).
   */
  private async conditionalUpdate(
    tenantId: string,
    eventId: string,
    input: Omit<UpdateCommandInput, "TableName" | "Key">,
    onCcf: "probe" | "conflict" | "not_found",
  ): Promise<EventMutationOutcome> {
    try {
      const out = await this.ddb.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: this.eventKey(eventId),
          ...input,
        }),
      );
      if (input.ReturnValues === "ALL_NEW") {
        return DynamoDbEventsRepository.updatedFrom(out.Attributes);
      }
      return { outcome: "updated" };
    } catch (err) {
      if (!isConditionalCheckFailed(err)) throw err;
      if (onCcf === "conflict") return { outcome: "conflict" };
      if (onCcf === "not_found") return { outcome: "not_found" };
      return this.probeConflict(tenantId, eventId);
    }
  }

  async endEvent(tenantId: string, eventId: string, at: string): Promise<EventMutationOutcome> {
    return this.conditionalUpdate(
      tenantId,
      eventId,
      {
        // #1095: ENDED 遷移と同時に scoringLocked / scoringLockedAt / scoringLockedBy を
        //        立てる (= 採点 gate 自動 lock)。
        UpdateExpression:
          "SET #s = :ended, endsAt = :now, updatedAt = :now, scoringLocked = :true, scoringLockedAt = :now, scoringLockedBy = :system",
        // tenant 跨ぎ防止 + status=READY のみ許可
        ConditionExpression: "tenantId = :tenantId AND #s = :ready",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":ended": "ENDED",
          ":ready": "READY",
          ":now": at,
          ":tenantId": tenantId,
          ":true": true,
          ":system": "system:end-event",
        },
        ReturnValues: "ALL_NEW",
      },
      "probe",
    );
  }

  async lockScoring(
    tenantId: string,
    eventId: string,
    lockedBy: string,
    at: string,
  ): Promise<EventMutationOutcome> {
    return this.conditionalUpdate(
      tenantId,
      eventId,
      {
        UpdateExpression:
          "SET scoringLocked = :t, scoringLockedAt = :now, scoringLockedBy = :who, updatedAt = :now",
        ConditionExpression:
          "tenantId = :tenantId AND (#s = :ready OR #s = :ended) AND (attribute_not_exists(scoringLocked) OR scoringLocked = :f)",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":t": true,
          ":f": false,
          ":now": at,
          ":who": lockedBy,
          ":tenantId": tenantId,
          ":ready": "READY",
          ":ended": "ENDED",
        },
        ReturnValues: "ALL_NEW",
      },
      "probe",
    );
  }

  async unlockScoring(
    tenantId: string,
    eventId: string,
    at: string,
  ): Promise<EventMutationOutcome> {
    return this.conditionalUpdate(
      tenantId,
      eventId,
      {
        UpdateExpression:
          "REMOVE scoringLocked, scoringLockedAt, scoringLockedBy SET updatedAt = :now",
        ConditionExpression:
          "tenantId = :tenantId AND (#s = :ready OR #s = :ended) AND scoringLocked = :t",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":t": true,
          ":now": at,
          ":tenantId": tenantId,
          ":ready": "READY",
          ":ended": "ENDED",
        },
        ReturnValues: "ALL_NEW",
      },
      "probe",
    );
  }

  async archiveEvent(tenantId: string, eventId: string, at: string): Promise<EventMutationOutcome> {
    return this.conditionalUpdate(
      tenantId,
      eventId,
      {
        UpdateExpression: "SET #s = :archived, archivedAt = :now, updatedAt = :now",
        // tenant 跨ぎ防止 + 許可状態のみに限定 (DRAFT / ENDED / TEARDOWN)
        ConditionExpression: "tenantId = :tenantId AND #s IN (:draft, :ended, :teardown)",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":archived": "ARCHIVED",
          ":draft": "DRAFT",
          ":ended": "ENDED",
          ":teardown": "TEARDOWN",
          ":now": at,
          ":tenantId": tenantId,
        },
      },
      "probe",
    );
  }

  async updateSchedule(
    tenantId: string,
    eventId: string,
    patch: EventSchedulePatch,
    at: string,
  ): Promise<EventMutationOutcome> {
    // 動的 SET (schedule.ts buildScheduleUpdate の event 側と同一の組み立て順)。
    const parts = ["updatedAt = :now"];
    const values: Record<string, string | number> = { ":now": at, ":tenantId": tenantId };
    if (patch.startsAt !== undefined) {
      parts.push("startsAt = :startsAt");
      values[":startsAt"] = patch.startsAt;
    }
    if (patch.endsAt !== undefined) {
      parts.push("endsAt = :endsAt");
      values[":endsAt"] = patch.endsAt;
    }
    if (patch.teardownAt !== undefined) {
      parts.push("teardownAt = :teardownAt");
      values[":teardownAt"] = patch.teardownAt;
    }
    if (patch.deployAt !== undefined) {
      parts.push("deployAt = :deployAt");
      values[":deployAt"] = patch.deployAt;
    }
    if (patch.scoreboardFreezeMinutes !== undefined) {
      parts.push("scoreboardFreezeMinutes = :fz");
      values[":fz"] = patch.scoreboardFreezeMinutes;
    }
    // 条件は tenant 照合のみ → CCF は行不在 / tenant 不一致 = not_found (probe 不要)。
    return this.conditionalUpdate(
      tenantId,
      eventId,
      {
        UpdateExpression: `SET ${parts.join(", ")}`,
        ConditionExpression: "tenantId = :tenantId",
        ExpressionAttributeValues: values,
        ReturnValues: "ALL_NEW",
      },
      "not_found",
    );
  }

  async markTeardown(tenantId: string, eventId: string, at: string): Promise<EventMutationOutcome> {
    // Fire-and-forget: 呼び出し側は skip するだけなので probe read を費やさない
    // (= 旧 CCF 握り潰しと同一 I/O)。行不在も conflict に畳む。
    return this.conditionalUpdate(
      tenantId,
      eventId,
      {
        UpdateExpression: "SET #status = :teardown, updatedAt = :now",
        ConditionExpression: "tenantId = :tenantId AND #status <> :archived",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":teardown": "TEARDOWN",
          ":archived": "ARCHIVED",
          ":tenantId": tenantId,
          ":now": at,
        },
      },
      "conflict",
    );
  }

  async setProgressionGate(
    tenantId: string,
    eventId: string,
    config: ProgressionGateConfig,
    at: string,
  ): Promise<EventMutationOutcome> {
    // 条件は tenant 照合のみ → CCF = not_found (旧 handler と同じ、存在を漏らさない)。
    return this.conditionalUpdate(
      tenantId,
      eventId,
      {
        UpdateExpression: "SET progressionGate = :cfg, updatedAt = :now",
        ConditionExpression: "tenantId = :tenantId",
        ExpressionAttributeValues: {
          ":cfg": config,
          ":now": at,
          ":tenantId": tenantId,
        },
      },
      "not_found",
    );
  }

  async clearProgressionGate(
    tenantId: string,
    eventId: string,
    at: string,
  ): Promise<ClearProgressionGateOutcome> {
    try {
      const out = await this.ddb.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: this.eventKey(eventId),
          UpdateExpression: "REMOVE progressionGate SET updatedAt = :now",
          ConditionExpression: "tenantId = :tenantId",
          ExpressionAttributeValues: {
            ":now": at,
            ":tenantId": tenantId,
          },
          ReturnValues: "ALL_OLD",
        }),
      );
      const before = out.Attributes as Partial<EventItem> | undefined;
      return { outcome: "updated", removed: before?.progressionGate !== undefined };
    } catch (err) {
      if (isConditionalCheckFailed(err)) return { outcome: "not_found" };
      throw err;
    }
  }

  async markDeploying(
    tenantId: string,
    eventId: string,
    at: string,
  ): Promise<EventMutationOutcome> {
    return this.conditionalUpdate(
      tenantId,
      eventId,
      {
        UpdateExpression: "SET #status = :deploying, updatedAt = :now",
        ConditionExpression:
          "tenantId = :tenantId AND (#status = :draft OR #status = :ready OR #status = :deploying)",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":deploying": "DEPLOYING",
          ":draft": "DRAFT",
          ":ready": "READY",
          ":now": at,
          ":tenantId": tenantId,
        },
      },
      "conflict",
    );
  }

  async transitionStatus(
    tenantId: string,
    eventId: string,
    from: string,
    to: string,
    at: string,
  ): Promise<EventMutationOutcome> {
    // 毎分 tick の CAS: 敗者は次 tick で再評価するだけなので probe しない。
    return this.conditionalUpdate(
      tenantId,
      eventId,
      {
        UpdateExpression: "SET #status = :next, updatedAt = :now",
        // race 防止: 期待 current status と一致しているときのみ更新 (= operator が
        // 手動 archive / 再 deploy で先に動かしてたら CCF で skip)。
        ConditionExpression: "tenantId = :tenant AND #status = :current",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":tenant": tenantId,
          ":current": from,
          ":next": to,
          ":now": at,
        },
      },
      "conflict",
    );
  }

  async markScheduleFired(
    tenantId: string,
    eventId: string,
    kind: ScheduleFiredKind,
    at: string,
  ): Promise<EventMutationOutcome> {
    // firedAttr は固定の literal union なので UpdateExpression への injection はない。
    // conflict = 既発火 (attribute_not_exists 不成立)。冪等 marker なので probe 不要。
    const firedAttr = kind === "teardown" ? "teardownFiredAt" : "deployFiredAt";
    return this.conditionalUpdate(
      tenantId,
      eventId,
      {
        UpdateExpression: `SET ${firedAttr} = :now`,
        ConditionExpression: `tenantId = :tenant AND attribute_not_exists(${firedAttr})`,
        ExpressionAttributeValues: { ":tenant": tenantId, ":now": at },
      },
      "conflict",
    );
  }

  async createEventWithTeams(
    event: EventRecord,
    teams: readonly TeamRecord[],
  ): Promise<CreateEventWithTeamsOutcome> {
    if (!this.teamsTableName) {
      throw new Error(
        "DynamoDbEventsRepository.createEventWithTeams requires a teamsTableName " +
          "(events-only wiring cannot write the Teams table).",
      );
    }
    // TransactWrite は 100 items が AWS の上限。event 1 行 + teams を 1 つの atomic write で
    // 書くため teams は最大 99 (= 100 - event 1 行)。 schema (CreateEventRequestSchema) が
    // teams.max(99) なので validated path では発火しない defense-in-depth。
    if (teams.length + 1 > 100) {
      throw new Error(`TransactWrite items > 100 (teams=${teams.length} + event=1)`);
    }
    const transact: TransactWriteCommandInput = {
      TransactItems: [
        {
          Put: {
            TableName: this.tableName,
            Item: recordToItem(event),
            // 同一 eventId 二重生成防止 (実質起こらないが defense-in-depth)
            ConditionExpression: "attribute_not_exists(PK)",
          },
        },
        ...teams.map((team) => ({
          Put: {
            TableName: this.teamsTableName,
            Item: teamRecordToItem(team),
            ConditionExpression: "attribute_not_exists(PK)",
          },
        })),
      ],
    };
    try {
      await this.ddb.send(new TransactWriteCommand(transact));
      return { outcome: "created" };
    } catch (err) {
      if (isTransactConditionalCheckFailed(err)) return { outcome: "conflict" };
      throw err;
    }
  }
}
