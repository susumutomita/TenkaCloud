import {
  type DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  type QueryCommandInput,
} from "@aws-sdk/lib-dynamodb";
import { createCursorCodec } from "../handlers/shared/cursor-codec.js";
import type {
  CoordinationStateRecord,
  DeploymentRecord,
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

/** Domain `jobId` from a physical base PK (`DEPLOYMENT#<jobId>`). */
function jobIdFromPk(pk: unknown): string {
  const raw = String(pk ?? "");
  return raw.startsWith(DEPLOYMENT_PK_PREFIX) ? raw.slice(DEPLOYMENT_PK_PREFIX.length) : raw;
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
}
