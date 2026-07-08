import {
  type DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  type QueryCommandInput,
  TransactWriteCommand,
  type TransactWriteCommandInput,
  UpdateCommand,
  type UpdateCommandInput,
} from "@aws-sdk/lib-dynamodb";
import {
  compositeTargetGsi3Pk,
  compositeTargetGsi3Sk,
} from "../handlers/deploy-handler/composite-deployment.js";
import { createCursorCodec } from "../handlers/shared/cursor-codec.js";
import { buildScoreEventItem } from "../handlers/shared/score-event.js";
import type {
  BulkDeploymentCreateEntry,
  CompositeParentDeploymentRecord,
  CompositeTargetDeploymentRecord,
  CoordinationStateRecord,
  DeploymentKindScoringResult,
  DeploymentMutationOutcome,
  DeploymentRecord,
  DeploymentSchedulePatch,
  DeploymentsPage,
  DeploymentsRepository,
  InboxEventRecord,
  ScoreEventRecord,
} from "./types.js";

/**
 * [Issue #2441 / Phase B1] DynamoDB implementation of the Deployments READ seam.
 * A behavior-preserving extraction of the DDB reads the six handler groups
 * already perform (`deploy-handler` / `participant-handler` / `generic-scoring`
 * / `event-handler` / `disruption-executor`): the SAME table, keys, GSIs, and
 * marshalling. It is the default backend — flipping to the SQL backend (B4) is a
 * one-flag rollback (`CONTROL_DATA_BACKEND`).
 *
 * Physical shape (unchanged, `problem-deploy/deployments-table.ts`):
 *   Base:  PK = `DEPLOYMENT#<jobId>`  / SK = `META`
 *            | `EVENT#<isoTs>#<ulid>`   (sparse score events)
 *            | `INBOX#<isoTs>#<ulid>`   (sparse inter-team cast/inbox)
 *          PK = `COORD#<tenantId>#<eventId>` / SK = `STATE` (coordination state)
 *   GSI1:  `TENANT#<tenantId>` / `createdAt`  — tenant listing
 *   GSI2:  `TEAMKEY#<teamLoginKey>` / `createdAt` — sparse, participant login
 *   GSI3:  `PARENT_DEPLOYMENT#<id>` / `ORDINAL#…#TARGET#…` — sparse, composite
 *
 * Every request below is a verbatim relocation of the named pre-seam site — do
 * NOT "improve" an expression here without a dedicated migration issue.
 */

const DEPLOYMENT_PK_PREFIX = "DEPLOYMENT#" as const;
const META_SK = "META" as const;
const EVENT_SK_PREFIX = "EVENT#" as const;
const COORD_STATE_SK = "STATE" as const;

/** Base PK for a deployment partition. */
function deploymentPk(jobId: string): string {
  return `${DEPLOYMENT_PK_PREFIX}${jobId}`;
}

/** COORD# partition key (`coordination-store.ts` `pk`). */
function coordinationPk(tenantId: string, eventId: string): string {
  return `COORD#${tenantId}#${eventId}`;
}

/** The physical DDB keys stripped from every returned domain record. */
const DDB_KEY_ATTRS: ReadonlySet<string> = new Set([
  "PK",
  "SK",
  "GSI1PK",
  "GSI1SK",
  "GSI2PK",
  "GSI2SK",
  "GSI3PK",
  "GSI3SK",
]);

/** Strip the physical DDB keys, yielding a domain record. */
function stripKeys<T>(item: Record<string, unknown>): T {
  const record: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(item)) {
    if (DDB_KEY_ATTRS.has(key)) continue;
    record[key] = value;
  }
  return record as unknown as T;
}

const itemToRecord = (item: Record<string, unknown>): DeploymentRecord =>
  stripKeys<DeploymentRecord>(item);
const itemToScoreEvent = (item: Record<string, unknown>): ScoreEventRecord =>
  stripKeys<ScoreEventRecord>(item);
const itemToInboxEvent = (item: Record<string, unknown>): InboxEventRecord =>
  stripKeys<InboxEventRecord>(item);

type DeploymentWriteRecord =
  | DeploymentRecord
  | CompositeParentDeploymentRecord
  | CompositeTargetDeploymentRecord;

function isCompositeParentRecord(
  record: DeploymentWriteRecord,
): record is CompositeParentDeploymentRecord {
  return (record as { runtimeKind?: unknown }).runtimeKind === "composite";
}

function isCompositeTargetRecord(
  record: DeploymentWriteRecord,
): record is CompositeTargetDeploymentRecord {
  return typeof (record as { parentDeploymentId?: unknown }).parentDeploymentId === "string";
}

/**
 * Re-derive physical keys for META rows from the domain record. Normal
 * deployments get GSI1 plus sparse GSI2 exactly like `deploy.ts`; composite
 * parents stay unindexed, and composite targets get only GSI3 exactly like
 * `composite-repository.ts`.
 */
function recordToItem(record: DeploymentWriteRecord): Record<string, unknown> {
  const item: Record<string, unknown> = {
    PK: deploymentPk(record.jobId),
    SK: META_SK,
    ...record,
  };
  if (isCompositeParentRecord(record)) return item;
  if (isCompositeTargetRecord(record)) {
    item.GSI3PK = compositeTargetGsi3Pk(record.parentDeploymentId);
    item.GSI3SK = compositeTargetGsi3Sk(record.targetOrdinal, record.targetId);
    return item;
  }
  item.GSI1PK = `TENANT#${record.tenantId}`;
  item.GSI1SK = record.createdAt;
  if (record.teamLoginKey) {
    item.GSI2PK = `TEAMKEY#${record.teamLoginKey}`;
    item.GSI2SK = record.createdAt;
  }
  return item;
}

/** Domain `jobId` from a physical base PK (`DEPLOYMENT#<jobId>`). */
function jobIdFromPk(pk: unknown): string {
  const raw = String(pk ?? "");
  return raw.startsWith(DEPLOYMENT_PK_PREFIX) ? raw.slice(DEPLOYMENT_PK_PREFIX.length) : raw;
}

function isConditionalCheckFailed(err: unknown): boolean {
  return err instanceof Error && err.name === "ConditionalCheckFailedException";
}

function isTransactConditionalCheckFailed(err: unknown): boolean {
  if (!(err instanceof Error) || err.name !== "TransactionCanceledException") return false;
  const reasons = (err as { CancellationReasons?: ReadonlyArray<{ Code?: string }> })
    .CancellationReasons;
  return (reasons ?? []).some((reason) => reason?.Code === "ConditionalCheckFailed");
}

/**
 * [#862 / list.ts] The exact allowlist + wire format of the pre-seam
 * `deploy-handler/list.ts` cursor codec (moved here verbatim). Moving the Query
 * into this seam must not invalidate cursors already handed to a UI mid-page.
 */
const LIST_PAGE_CURSOR_CODEC = createCursorCodec(
  new Set(["PK", "SK", "GSI1PK", "GSI1SK", "GSI2PK", "GSI2SK"]),
);

export class DynamoDbDeploymentsRepository implements DeploymentsRepository {
  constructor(
    private readonly ddb: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  /** Key of the Deployments META row (same derivation as every read above). */
  private deploymentKey(jobId: string): { PK: string; SK: string } {
    return { PK: deploymentPk(jobId), SK: META_SK };
  }

  private async probeConflict(tenantId: string, jobId: string): Promise<DeploymentMutationOutcome> {
    const record = await this.getDeployment(jobId);
    if (!record || record.tenantId !== tenantId) return { outcome: "not_found" };
    return { outcome: "conflict", record };
  }

  private static updatedFrom(
    attributes: Record<string, unknown> | undefined,
  ): DeploymentMutationOutcome {
    if (!attributes) return { outcome: "not_found" };
    return { outcome: "updated", record: itemToRecord(attributes) };
  }

  private async conditionalUpdate(
    jobId: string,
    input: Omit<UpdateCommandInput, "TableName" | "Key">,
    onCcf: "conflict" | "not_found" | { readonly probeTenantId: string },
  ): Promise<DeploymentMutationOutcome> {
    try {
      const out = await this.ddb.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: this.deploymentKey(jobId),
          ...input,
        }),
      );
      if (input.ReturnValues === "ALL_NEW") {
        return DynamoDbDeploymentsRepository.updatedFrom(out.Attributes);
      }
      return { outcome: "updated" };
    } catch (err) {
      if (!isConditionalCheckFailed(err)) throw err;
      if (onCcf === "conflict") return { outcome: "conflict" };
      if (onCcf === "not_found") return { outcome: "not_found" };
      return this.probeConflict(onCcf.probeTenantId, jobId);
    }
  }

  private async conditionalPut(
    record: DeploymentWriteRecord,
    onCcf: "conflict" | { readonly probeTenantId: string },
  ): Promise<DeploymentMutationOutcome> {
    try {
      await this.ddb.send(
        new PutCommand({
          TableName: this.tableName,
          Item: recordToItem(record),
          ConditionExpression: "attribute_not_exists(PK)",
        }),
      );
      return { outcome: "updated", record: record as DeploymentRecord };
    } catch (err) {
      if (!isConditionalCheckFailed(err)) throw err;
      if (onCcf === "conflict") return { outcome: "conflict" };
      return this.probeConflict(onCcf.probeTenantId, record.jobId);
    }
  }

  private async transactWrite(
    input: TransactWriteCommandInput,
  ): Promise<DeploymentMutationOutcome> {
    try {
      await this.ddb.send(new TransactWriteCommand(input));
      return { outcome: "updated" };
    } catch (err) {
      if (isTransactConditionalCheckFailed(err)) return { outcome: "conflict" };
      throw err;
    }
  }

  /**
   * Drain every page of a Query, up to `maxPages` (default: all). Mirrors
   * `handlers/shared/ddb-paginate.ts` — the caller must NOT pass
   * `ExclusiveStartKey` (this loop owns it). The per-page callers below hand in
   * the byte-verbatim request; pagination is the only thing added.
   */
  private async queryAllPages(
    input: Omit<QueryCommandInput, "TableName" | "ExclusiveStartKey">,
    maxPages = Number.POSITIVE_INFINITY,
  ): Promise<Record<string, unknown>[]> {
    const items: Record<string, unknown>[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    let pages = 0;
    while (pages < maxPages) {
      const out = await this.ddb.send(
        new QueryCommand({
          TableName: this.tableName,
          ...input,
          ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
        }),
      );
      for (const item of (out.Items ?? []) as Record<string, unknown>[]) items.push(item);
      exclusiveStartKey = out.LastEvaluatedKey as Record<string, unknown> | undefined;
      pages += 1;
      if (!exclusiveStartKey) break;
    }
    return items;
  }

  // -- Point reads ----------------------------------------------------------

  async getDeployment(jobId: string): Promise<DeploymentRecord | undefined> {
    const out = await this.ddb.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { PK: deploymentPk(jobId), SK: META_SK },
      }),
    );
    const item = out.Item as Record<string, unknown> | undefined;
    if (!item) return undefined;
    return itemToRecord(item);
  }

  async queryDeploymentMeta(jobId: string): Promise<DeploymentRecord | undefined> {
    const out = await this.ddb.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "PK = :pk AND SK = :sk",
        ExpressionAttributeValues: { ":pk": deploymentPk(jobId), ":sk": META_SK },
      }),
    );
    const item = (out.Items ?? [])[0] as Record<string, unknown> | undefined;
    if (!item) return undefined;
    return itemToRecord(item);
  }

  // -- GSI1: tenant-scoped -------------------------------------------------

  async listByTenantPage(
    tenantId: string,
    opts: { readonly limit: number; readonly cursor?: string },
  ): Promise<DeploymentsPage> {
    const exclusiveStartKey = opts.cursor ? LIST_PAGE_CURSOR_CODEC.decode(opts.cursor) : undefined;
    const out = await this.ddb.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: "GSI1",
        KeyConditionExpression: "GSI1PK = :pk",
        ExpressionAttributeValues: { ":pk": `TENANT#${tenantId}` },
        ScanIndexForward: false,
        Limit: opts.limit,
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    const items = (out.Items ?? []).map((item) => itemToRecord(item as Record<string, unknown>));
    const nextCursor = out.LastEvaluatedKey
      ? LIST_PAGE_CURSOR_CODEC.encode(out.LastEvaluatedKey as Record<string, unknown>)
      : undefined;
    return { items, nextCursor };
  }

  async countActiveByTenant(
    tenantId: string,
    activeStatuses: readonly string[],
    opts?: { readonly stopAtCount?: number },
  ): Promise<number> {
    // FilterExpression `#s IN (:s0, :s1, …)` derived from `activeStatuses` so the
    // two never drift (deploy-quota.ts). Placeholder names are generated.
    const statusPlaceholders = activeStatuses.map((_, i) => `:s${i}`);
    const statusValues = Object.fromEntries(activeStatuses.map((s, i) => [`:s${i}`, s] as const));
    let active = 0;
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const out = await this.ddb.send(
        new QueryCommand({
          TableName: this.tableName,
          IndexName: "GSI1",
          KeyConditionExpression: "GSI1PK = :pk",
          FilterExpression: `#s IN (${statusPlaceholders.join(", ")})`,
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: { ":pk": `TENANT#${tenantId}`, ...statusValues },
          Select: "COUNT",
          ExclusiveStartKey: exclusiveStartKey,
        }),
      );
      active += out.Count ?? 0;
      exclusiveStartKey = out.LastEvaluatedKey as Record<string, unknown> | undefined;
      // Pre-seam early-break (deploy-quota.ts): stop paging once over the quota.
      if (opts?.stopAtCount !== undefined && active >= opts.stopAtCount) break;
    } while (exclusiveStartKey);
    return active;
  }

  async listByTenantAndEvent(
    tenantId: string,
    eventId: string,
  ): Promise<readonly DeploymentRecord[]> {
    const items = await this.queryAllPages({
      IndexName: "GSI1",
      KeyConditionExpression: "GSI1PK = :pk",
      FilterExpression: "eventId = :ev",
      ExpressionAttributeValues: { ":pk": `TENANT#${tenantId}`, ":ev": eventId },
    });
    return items.map(itemToRecord);
  }

  async listDeploymentKeysByEvent(tenantId: string, eventId: string): Promise<readonly string[]> {
    const items = await this.queryAllPages({
      IndexName: "GSI1",
      KeyConditionExpression: "GSI1PK = :pk",
      FilterExpression: "eventId = :ev",
      ProjectionExpression: "PK",
      ExpressionAttributeValues: { ":pk": `TENANT#${tenantId}`, ":ev": eventId },
    });
    return items.map((item) => jobIdFromPk(item.PK));
  }

  async listReconcilerRowsByEvent(
    tenantId: string,
    eventId: string,
  ): Promise<readonly Pick<DeploymentRecord, "jobId" | "status" | "updatedAt">[]> {
    const items = await this.queryAllPages({
      IndexName: "GSI1",
      KeyConditionExpression: "GSI1PK = :pk",
      FilterExpression: "eventId = :ev",
      ProjectionExpression: "PK, #status, updatedAt",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":pk": `TENANT#${tenantId}`, ":ev": eventId },
    });
    return items.map((item) => ({
      jobId: jobIdFromPk(item.PK),
      status: item.status as DeploymentRecord["status"],
      updatedAt: item.updatedAt as string,
    }));
  }

  async listByEventTeamProblem(
    tenantId: string,
    eventId: string,
    teamId: string,
    problemId: string,
  ): Promise<readonly DeploymentRecord[]> {
    const items = await this.queryAllPages({
      IndexName: "GSI1",
      KeyConditionExpression: "GSI1PK = :pk",
      FilterExpression: "eventId = :ev AND teamId = :tid AND problemId = :pid",
      ExpressionAttributeValues: {
        ":pk": `TENANT#${tenantId}`,
        ":ev": eventId,
        ":tid": teamId,
        ":pid": problemId,
      },
    });
    return items.map(itemToRecord);
  }

  async findByNamePrefix(
    tenantId: string,
    namePrefix: string,
  ): Promise<readonly Pick<DeploymentRecord, "namePrefix" | "jobId" | "status">[]> {
    const items = await this.queryAllPages({
      IndexName: "GSI1",
      KeyConditionExpression: "GSI1PK = :pk",
      FilterExpression: "namePrefix = :np",
      ProjectionExpression: "namePrefix, jobId, #s",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":pk": `TENANT#${tenantId}`, ":np": namePrefix },
    });
    return items.map((item) => ({
      namePrefix: item.namePrefix as string,
      jobId: item.jobId as string,
      status: item.status as DeploymentRecord["status"],
    }));
  }

  async listDeploymentSummariesByTenant(
    tenantId: string,
  ): Promise<
    readonly Pick<
      DeploymentRecord,
      "jobId" | "teamId" | "eventId" | "displayTeamName" | "teamName" | "problemId" | "status"
    >[]
  > {
    // Single page, no drain — verbatim `event-handler/list.ts` getEventDetail.
    const out = await this.ddb.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: "GSI1",
        KeyConditionExpression: "GSI1PK = :pk",
        ExpressionAttributeValues: { ":pk": `TENANT#${tenantId}` },
        ProjectionExpression:
          "PK, teamId, eventId, displayTeamName, teamName, problemId, jobId, #s",
        ExpressionAttributeNames: { "#s": "status" },
      }),
    );
    return (out.Items ?? []).map((raw) => {
      const item = raw as Record<string, unknown>;
      return {
        jobId: (item.jobId as string | undefined) ?? jobIdFromPk(item.PK),
        teamId: item.teamId as string | undefined,
        eventId: item.eventId as string | undefined,
        displayTeamName: item.displayTeamName as string | undefined,
        teamName: item.teamName as string,
        problemId: item.problemId as string,
        status: item.status as DeploymentRecord["status"],
      };
    });
  }

  // -- GSI2: participant login --------------------------------------------

  async listByTeamLoginKey(teamLoginKey: string): Promise<readonly DeploymentRecord[]> {
    // Single page (no drain) — verbatim `participant-handler/shared.ts`
    // `queryTeamItems` (the participant-login path).
    const out = await this.ddb.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: "GSI2",
        KeyConditionExpression: "GSI2PK = :pk",
        ExpressionAttributeValues: { ":pk": `TEAMKEY#${teamLoginKey}` },
      }),
    );
    return (out.Items ?? []).map((item) => itemToRecord(item as Record<string, unknown>));
  }

  // -- GSI3: composite targets --------------------------------------------

  async listCompositeTargets(parentDeploymentId: string): Promise<readonly DeploymentRecord[]> {
    // Single page — verbatim `deploy-handler/composite-repository.ts`.
    const out = await this.ddb.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: "GSI3",
        KeyConditionExpression: "GSI3PK = :pk",
        ExpressionAttributeValues: { ":pk": `PARENT_DEPLOYMENT#${parentDeploymentId}` },
        ScanIndexForward: true,
      }),
    );
    return (out.Items ?? []).map((item) => itemToRecord(item as Record<string, unknown>));
  }

  // -- Base partition: sparse sub-aggregates -------------------------------

  async listScoreEvents(
    jobId: string,
    opts: { readonly pageSize: number; readonly maxPages?: number },
  ): Promise<readonly ScoreEventRecord[]> {
    const items = await this.queryAllPages(
      {
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :evpfx)",
        ExpressionAttributeValues: { ":pk": deploymentPk(jobId), ":evpfx": EVENT_SK_PREFIX },
        ScanIndexForward: false,
        Limit: opts.pageSize,
      },
      opts.maxPages,
    );
    return items.map(itemToScoreEvent);
  }

  async listScoreEventsInRange(
    jobId: string,
    fromSk: string,
    toSk: string,
  ): Promise<readonly ScoreEventRecord[]> {
    const items = await this.queryRange(jobId, fromSk, toSk);
    return items.map(itemToScoreEvent);
  }

  async listInboxEventsInRange(
    jobId: string,
    fromSk: string,
    toSk: string,
  ): Promise<readonly InboxEventRecord[]> {
    const items = await this.queryRange(jobId, fromSk, toSk);
    return items.map(itemToInboxEvent);
  }

  /**
   * The shared `SK BETWEEN` drain behind {@link listScoreEventsInRange} /
   * {@link listInboxEventsInRange} — byte-identical to `battle-attacks.ts` /
   * `cast-event.ts` `queryInboxRows` (`:sk_start` / `:sk_end` placeholders,
   * `ScanIndexForward=false`, full drain). The two callers differ only in the
   * `EVENT#` vs `INBOX#` bounds they pass and the record type they map to.
   */
  private queryRange(
    jobId: string,
    fromSk: string,
    toSk: string,
  ): Promise<Record<string, unknown>[]> {
    return this.queryAllPages({
      KeyConditionExpression: "PK = :pk AND SK BETWEEN :sk_start AND :sk_end",
      ExpressionAttributeValues: {
        ":pk": deploymentPk(jobId),
        ":sk_start": fromSk,
        ":sk_end": toSk,
      },
      ScanIndexForward: false,
    });
  }

  // -- COORD#: coordination state -----------------------------------------

  async readCoordinationState(
    tenantId: string,
    eventId: string,
  ): Promise<CoordinationStateRecord | undefined> {
    const out = await this.ddb.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { PK: coordinationPk(tenantId, eventId), SK: COORD_STATE_SK },
      }),
    );
    const item = out.Item as Record<string, unknown> | undefined;
    if (!item) return undefined;
    return { state: item.state, version: Number(item.version ?? 0) };
  }

  // -- Conditional / atomic writes ------------------------------------------

  async putDeployment(record: DeploymentRecord): Promise<void> {
    await this.ddb.send(new PutCommand({ TableName: this.tableName, Item: recordToItem(record) }));
  }

  async markFailedIfPending(
    jobId: string,
    tenantId: string,
    reason: string,
    at: string,
    expiresAt: number,
  ): Promise<DeploymentMutationOutcome> {
    return this.conditionalUpdate(
      jobId,
      {
        UpdateExpression:
          "SET #s = :failed, updatedAt = :updatedAt, failureReason = :reason, expiresAt = :expiresAt",
        ConditionExpression: "tenantId = :tenantId AND #s = :pending",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":failed": "FAILED",
          ":pending": "PENDING",
          ":updatedAt": at,
          ":reason": reason,
          ":tenantId": tenantId,
          ":expiresAt": expiresAt,
        },
      },
      "conflict",
    );
  }

  async retryToPending(
    jobId: string,
    tenantId: string,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.conditionalUpdate(
      jobId,
      {
        UpdateExpression: "SET #s = :pending, updatedAt = :updatedAt REMOVE failureReason",
        ConditionExpression: "#s = :failed AND tenantId = :tenantId",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":pending": "PENDING",
          ":failed": "FAILED",
          ":updatedAt": at,
          ":tenantId": tenantId,
        },
      },
      "conflict",
    );
  }

  async compensateRetryToFailed(
    jobId: string,
    tenantId: string,
    reason: string,
    at: string,
    expiresAt: number,
  ): Promise<DeploymentMutationOutcome> {
    return this.conditionalUpdate(
      jobId,
      {
        UpdateExpression:
          "SET #s = :failed, updatedAt = :updatedAt, failureReason = :reason, expiresAt = :expiresAt",
        ConditionExpression: "#s = :pending AND tenantId = :tenantId",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":failed": "FAILED",
          ":pending": "PENDING",
          ":updatedAt": at,
          ":reason": reason,
          ":tenantId": tenantId,
          ":expiresAt": expiresAt,
        },
      },
      "conflict",
    );
  }

  async markDeleting(
    jobId: string,
    tenantId: string,
    at: string,
    expiresAt: number,
  ): Promise<DeploymentMutationOutcome> {
    return this.conditionalUpdate(
      jobId,
      {
        UpdateExpression: "SET #s = :deleting, updatedAt = :updatedAt, expiresAt = :expiresAt",
        ConditionExpression: "tenantId = :tenantId AND #s IN (:p, :ap, :i, :c, :f)",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":deleting": "DELETING",
          ":updatedAt": at,
          ":tenantId": tenantId,
          ":p": "PENDING",
          ":ap": "APPROVAL_PENDING",
          ":i": "IN_PROGRESS",
          ":c": "COMPLETE",
          ":f": "FAILED",
          ":expiresAt": expiresAt,
        },
      },
      "conflict",
    );
  }

  async compensateDeleteToFailed(
    jobId: string,
    tenantId: string,
    reason: string,
    at: string,
    expiresAt: number,
  ): Promise<DeploymentMutationOutcome> {
    return this.conditionalUpdate(
      jobId,
      {
        UpdateExpression:
          "SET #s = :failed, updatedAt = :updatedAt, failureReason = :reason, expiresAt = :expiresAt",
        ConditionExpression: "tenantId = :tenantId AND #s = :deleting",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":failed": "FAILED",
          ":deleting": "DELETING",
          ":updatedAt": at,
          ":reason": reason,
          ":tenantId": tenantId,
          ":expiresAt": expiresAt,
        },
      },
      "conflict",
    );
  }

  async markApprovalPending(
    jobId: string,
    tenantId: string,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.conditionalUpdate(
      jobId,
      {
        UpdateExpression: "SET #s = :approvalPending, updatedAt = :updatedAt",
        ConditionExpression: "tenantId = :tenantId AND #s = :pending",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":approvalPending": "APPROVAL_PENDING",
          ":pending": "PENDING",
          ":updatedAt": at,
          ":tenantId": tenantId,
        },
      },
      "conflict",
    );
  }

  async failCompositeTargetIfPending(
    jobId: string,
    reason: string,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.conditionalUpdate(
      jobId,
      {
        UpdateExpression: "SET #s = :failed, failureReason = :reason, updatedAt = :now",
        ConditionExpression: "#s = :pending",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":failed": "FAILED",
          ":pending": "PENDING",
          ":reason": reason,
          ":now": at,
        },
      },
      "conflict",
    );
  }

  async markCompositeParentDeleting(jobId: string, at: string): Promise<DeploymentMutationOutcome> {
    return this.conditionalUpdate(
      jobId,
      {
        UpdateExpression: "SET #s = :deleting, updatedAt = :now",
        ConditionExpression: "runtimeKind = :composite AND #s <> :deleting",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":deleting": "DELETING",
          ":composite": "composite",
          ":now": at,
        },
      },
      "conflict",
    );
  }

  async putCompositeParent(
    record: CompositeParentDeploymentRecord,
  ): Promise<DeploymentMutationOutcome> {
    return this.conditionalPut(record, { probeTenantId: record.tenantId });
  }

  async putCompositeTarget(
    record: CompositeTargetDeploymentRecord,
  ): Promise<DeploymentMutationOutcome> {
    return this.conditionalPut(record, "conflict");
  }

  async applyMultiFlagCorrectScore(
    jobId: string,
    points: number,
    flagId: string,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.conditionalUpdate(
      jobId,
      {
        UpdateExpression:
          "ADD score :pts, solvedFlagIds :flagIdSet SET lastScoredAt = :now, updatedAt = :now",
        ConditionExpression:
          "attribute_not_exists(solvedFlagIds) OR NOT contains(solvedFlagIds, :flagId)",
        ExpressionAttributeValues: {
          ":pts": points,
          ":flagIdSet": new Set([flagId]),
          ":flagId": flagId,
          ":now": at,
        },
        ReturnValues: "ALL_NEW",
      },
      "conflict",
    );
  }

  async applyMultiFlagWrongPenalty(
    jobId: string,
    penalty: number,
    flagId: string,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.conditionalUpdate(
      jobId,
      {
        UpdateExpression: "ADD wrongAnswerCount :one, score :neg SET updatedAt = :now",
        ConditionExpression:
          "attribute_not_exists(solvedFlagIds) OR NOT contains(solvedFlagIds, :flagId)",
        ExpressionAttributeValues: {
          ":one": 1,
          ":neg": -penalty,
          ":flagId": flagId,
          ":now": at,
        },
        ReturnValues: "ALL_NEW",
      },
      "conflict",
    );
  }

  async applyFlagWrongPenalty(
    jobId: string,
    penalty: number,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.conditionalUpdate(
      jobId,
      {
        UpdateExpression: "ADD wrongAnswerCount :one, score :neg SET updatedAt = :now",
        ConditionExpression: "attribute_not_exists(flagSubmitted) OR flagSubmitted = :false",
        ExpressionAttributeValues: { ":one": 1, ":neg": -penalty, ":false": false, ":now": at },
        ReturnValues: "ALL_NEW",
      },
      "conflict",
    );
  }

  async applyFlagCorrectScore(
    jobId: string,
    points: number,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.conditionalUpdate(
      jobId,
      {
        UpdateExpression:
          "ADD score :pts SET flagSubmitted = :true, lastScoredAt = :now, updatedAt = :now",
        ConditionExpression: "attribute_not_exists(flagSubmitted) OR flagSubmitted = :false",
        ExpressionAttributeValues: {
          ":pts": points,
          ":true": true,
          ":false": false,
          ":now": at,
        },
        ReturnValues: "ALL_NEW",
      },
      "conflict",
    );
  }

  async applyHintPenalty(
    jobId: string,
    hint: Parameters<DeploymentsRepository["applyHintPenalty"]>[1],
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.conditionalUpdate(
      jobId,
      {
        UpdateExpression:
          "SET hintsRevealed = list_append(if_not_exists(hintsRevealed, :empty), :record), updatedAt = :now " +
          "ADD score :neg",
        ConditionExpression:
          "attribute_not_exists(hintsRevealed) OR NOT contains(hintsRevealed, :recordForContains)",
        ExpressionAttributeValues: {
          ":empty": [],
          ":record": [hint],
          ":recordForContains": hint,
          ":now": at,
          ":neg": hint.penaltyApplied === 0 ? 0 : -hint.penaltyApplied,
        },
        ReturnValues: "ALL_NEW",
      },
      "conflict",
    );
  }

  async updateDisplayTeamName(
    jobId: string,
    name: string,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.conditionalUpdate(
      jobId,
      {
        UpdateExpression: "SET displayTeamName = :name, updatedAt = :now",
        ExpressionAttributeValues: { ":name": name, ":now": at },
        ReturnValues: "ALL_NEW",
      },
      "conflict",
    );
  }

  async applyKindScoringResult(
    jobId: string,
    result: DeploymentKindScoringResult,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    const setParts: string[] = ["lastScoredAt = :now", "updatedAt = :now"];
    const values: Record<string, unknown> = { ":now": at };
    const addScore = result.scoreDelta !== 0 ? "ADD score :pts " : "";
    if (result.scoreDelta !== 0) values[":pts"] = result.scoreDelta;
    if (result.lastResult) {
      setParts.push("lastResult = :lr");
      values[":lr"] = result.lastResult;
    }
    if (result.endpointsHealthJson !== undefined) {
      setParts.push("endpointsHealth = :health");
      values[":health"] = result.endpointsHealthJson;
    }
    if (result.attackProbesJson !== undefined) {
      setParts.push("attackProbes = :attackProbes");
      values[":attackProbes"] = result.attackProbesJson;
    }
    if (result.postureJson !== undefined) {
      setParts.push("posture = :posture");
      values[":posture"] = result.postureJson;
    }
    if (result.platform !== undefined) {
      setParts.push("platform = :platform");
      values[":platform"] = result.platform;
    }
    if (result.newState !== undefined) {
      setParts.push("scoringState = :state");
      values[":state"] = JSON.stringify(result.newState);
    }
    return this.conditionalUpdate(
      jobId,
      {
        UpdateExpression: `${addScore}SET ${setParts.join(", ")}`,
        ExpressionAttributeValues: values,
      },
      "conflict",
    );
  }

  async casCompositeParentStatus(
    jobId: string,
    previousStatus: Parameters<DeploymentsRepository["casCompositeParentStatus"]>[1],
    nextStatus: Parameters<DeploymentsRepository["casCompositeParentStatus"]>[2],
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.conditionalUpdate(
      jobId,
      {
        UpdateExpression: "SET #s = :next, updatedAt = :now",
        ConditionExpression: "#s = :prev AND runtimeKind = :composite",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":next": nextStatus,
          ":prev": previousStatus,
          ":now": at,
          ":composite": "composite",
        },
      },
      "conflict",
    );
  }

  async latchGateCompleted(jobId: string, at: string): Promise<DeploymentMutationOutcome> {
    return this.conditionalUpdate(
      jobId,
      {
        UpdateExpression: "SET gateCompletedAt = :now, updatedAt = :now",
        ConditionExpression: "attribute_not_exists(gateCompletedAt)",
        ExpressionAttributeValues: { ":now": at },
      },
      "conflict",
    );
  }

  async awardGateBonusAtomic(
    parent: Pick<DeploymentRecord, "jobId" | "problemId" | "teamId" | "eventId" | "expiresAt">,
    bonus: number,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    const scoreEvent = buildScoreEventItem(parent, "gate-bonus", bonus, at);
    return this.transactWrite({
      TransactItems: [
        {
          Update: {
            TableName: this.tableName,
            Key: this.deploymentKey(parent.jobId),
            UpdateExpression: "ADD score :bonus SET gateBonusAwardedAt = :now, updatedAt = :now",
            ConditionExpression: "attribute_not_exists(gateBonusAwardedAt)",
            ExpressionAttributeValues: { ":bonus": bonus, ":now": at },
          },
        },
        { Put: { TableName: this.tableName, Item: scoreEvent } },
      ],
    });
  }

  async setScoringState(
    jobId: string,
    stateJson: string,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.conditionalUpdate(
      jobId,
      {
        UpdateExpression: "SET scoringState = :state, updatedAt = :now",
        ExpressionAttributeValues: { ":state": stateJson, ":now": at },
      },
      "conflict",
    );
  }

  async markStuckDeletingFailed(
    jobId: string,
    reason: string,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.conditionalUpdate(
      jobId,
      {
        UpdateExpression:
          "SET #status = :failed, updatedAt = :now, #reason = :reason REMOVE GSI2PK, GSI2SK",
        ConditionExpression: "#status = :deleting",
        ExpressionAttributeNames: { "#status": "status", "#reason": "failureReason" },
        ExpressionAttributeValues: {
          ":deleting": "DELETING",
          ":failed": "FAILED",
          ":now": at,
          ":reason": reason,
        },
      },
      "conflict",
    );
  }

  async transitionRuntimeStatus(
    jobId: string,
    tenantId: string,
    currentStatus: Parameters<DeploymentsRepository["transitionRuntimeStatus"]>[2],
    nextStatus: Parameters<DeploymentsRepository["transitionRuntimeStatus"]>[3],
    stackOutputs: string | undefined,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    const sets = ["#s = :next", "updatedAt = :now"];
    const values: Record<string, unknown> = {
      ":next": nextStatus,
      ":now": at,
      ":cur": currentStatus,
      ":tenant": tenantId,
    };
    if (stackOutputs !== undefined) {
      sets.push("stackOutputs = :outputs");
      values[":outputs"] = stackOutputs;
    }
    return this.conditionalUpdate(
      jobId,
      {
        UpdateExpression: `SET ${sets.join(", ")}`,
        ConditionExpression: "tenantId = :tenant AND #s = :cur",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: values,
      },
      "conflict",
    );
  }

  async compensateBulkTeardown(
    jobId: string,
    tenantId: string,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.conditionalUpdate(
      jobId,
      {
        UpdateExpression: "SET #s = :failed, updatedAt = :updatedAt, failureReason = :reason",
        ConditionExpression: "tenantId = :tenantId AND #s = :deleting",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":failed": "FAILED",
          ":deleting": "DELETING",
          ":updatedAt": at,
          ":reason": "Failed to publish DeployDeleteRequested event (bulk teardown)",
          ":tenantId": tenantId,
        },
      },
      "conflict",
    );
  }

  async markDeletingForBulk(
    jobId: string,
    tenantId: string,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.conditionalUpdate(
      jobId,
      {
        UpdateExpression: "SET #s = :deleting, updatedAt = :updatedAt",
        ConditionExpression: "tenantId = :tenantId AND #s IN (:p, :ap, :i, :c, :f)",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":deleting": "DELETING",
          ":updatedAt": at,
          ":tenantId": tenantId,
          ":p": "PENDING",
          ":ap": "APPROVAL_PENDING",
          ":i": "IN_PROGRESS",
          ":c": "COMPLETE",
          ":f": "FAILED",
        },
      },
      "conflict",
    );
  }

  async applySchedulePatch(
    jobId: string,
    tenantId: string,
    patch: DeploymentSchedulePatch,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    const deploymentParts = ["updatedAt = :now"];
    const deploymentValues: Record<string, string> = { ":now": at, ":tenantId": tenantId };
    if (patch.startsAt !== undefined) {
      deploymentParts.push("eventStartsAt = :s");
      deploymentValues[":s"] = patch.startsAt;
    }
    if (patch.endsAt !== undefined) {
      deploymentParts.push("eventEndsAt = :e");
      deploymentValues[":e"] = patch.endsAt;
    }
    return this.conditionalUpdate(
      jobId,
      {
        UpdateExpression: `SET ${deploymentParts.join(", ")}`,
        ConditionExpression: "tenantId = :tenantId",
        ExpressionAttributeValues: deploymentValues,
      },
      "not_found",
    );
  }

  async createBulkDeployments(
    tenantId: string,
    entries: readonly BulkDeploymentCreateEntry[],
  ): Promise<DeploymentMutationOutcome> {
    if (entries.length === 0) return { outcome: "updated" };
    const transactItems: TransactWriteCommandInput["TransactItems"] = [];
    for (const entry of entries) {
      transactItems.push({
        Put: {
          TableName: this.tableName,
          Item: recordToItem(entry.record),
          ConditionExpression: "attribute_not_exists(PK)",
        },
      });
      if (entry.replacesJobId) {
        transactItems.push({
          Delete: {
            TableName: this.tableName,
            Key: this.deploymentKey(entry.replacesJobId),
            ConditionExpression: "tenantId = :tenantId",
            ExpressionAttributeValues: { ":tenantId": tenantId },
          },
        });
      }
    }
    return this.transactWrite({ TransactItems: transactItems });
  }

  async compensateBulkCreateToFailed(
    jobId: string,
    tenantId: string,
    reason: string,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.conditionalUpdate(
      jobId,
      {
        UpdateExpression: "SET #s = :failed, updatedAt = :updatedAt, failureReason = :reason",
        ConditionExpression: "tenantId = :tenantId AND #s = :pending",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":failed": "FAILED",
          ":pending": "PENDING",
          ":tenantId": tenantId,
          ":updatedAt": at,
          ":reason": reason,
        },
      },
      "conflict",
    );
  }

  async stampEventEndsAt(
    jobId: string,
    tenantId: string,
    endsAt: string,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.conditionalUpdate(
      jobId,
      {
        UpdateExpression: "SET eventEndsAt = :e, updatedAt = :now",
        ConditionExpression: "tenantId = :tenantId",
        ExpressionAttributeValues: { ":e": endsAt, ":now": at, ":tenantId": tenantId },
      },
      "not_found",
    );
  }
}
