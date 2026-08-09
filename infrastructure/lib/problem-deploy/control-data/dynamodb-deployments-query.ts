import { QueryCommand, type ScanCommandInput } from "@aws-sdk/lib-dynamodb";
import {
  type DynamoDbDeploymentsCore,
  deploymentPk,
  itemToRecord,
  jobIdFromPk,
  LIST_PAGE_CURSOR_CODEC,
  META_SK,
} from "./dynamodb-deployments-core.js";
import type { DeploymentRecord, DeploymentsPage, DeploymentsQueryPort } from "./types.js";

/**
 * [#2527 Slice 3] DynamoDB {@link DeploymentsQueryPort} adapter — point reads, GSI/tenant listings, and reconciler page scans,
 * moved verbatim from the pre-split `DynamoDbDeploymentsRepository`. Engine
 * primitives (keys, conditional writes, pagination) live on
 * {@link DynamoDbDeploymentsCore}.
 */
export class DynamoDbDeploymentsQuery implements DeploymentsQueryPort {
  constructor(private readonly core: DynamoDbDeploymentsCore) {}

  /** Point read — implemented on the core engine because the write-side conflict probes reuse it. */
  readonly getDeployment: DeploymentsQueryPort["getDeployment"] = (...args) =>
    this.core.getDeployment(...args);

  async queryDeploymentMeta(jobId: string): Promise<DeploymentRecord | undefined> {
    const out = await this.core.ddb.send(
      new QueryCommand({
        TableName: this.core.tableName,
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
    const out = await this.core.ddb.send(
      new QueryCommand({
        TableName: this.core.tableName,
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
      const out = await this.core.ddb.send(
        new QueryCommand({
          TableName: this.core.tableName,
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

  /**
   * [Issue #2946] `attribute_exists(completedAt)` を GSI1 に対して `Select=COUNT` で drain する。
   * GSI の追加は不要 (= standing cost が増えない)。marker の有無だけを見るので、撤去で status が
   * `DELETED` になった行も数え続ける。
   */
  async countEverCompletedByTenant(tenantId: string): Promise<number> {
    let completed = 0;
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const out = await this.core.ddb.send(
        new QueryCommand({
          TableName: this.core.tableName,
          IndexName: "GSI1",
          KeyConditionExpression: "GSI1PK = :pk",
          FilterExpression: "attribute_exists(completedAt)",
          ExpressionAttributeValues: { ":pk": `TENANT#${tenantId}` },
          Select: "COUNT",
          ExclusiveStartKey: exclusiveStartKey,
        }),
      );
      completed += out.Count ?? 0;
      exclusiveStartKey = out.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (exclusiveStartKey);
    return completed;
  }

  async listByTenantAndEvent(
    tenantId: string,
    eventId: string,
  ): Promise<readonly DeploymentRecord[]> {
    const items = await this.core.queryAllPages({
      IndexName: "GSI1",
      KeyConditionExpression: "GSI1PK = :pk",
      FilterExpression: "eventId = :ev",
      ExpressionAttributeValues: { ":pk": `TENANT#${tenantId}`, ":ev": eventId },
    });
    return items.map(itemToRecord);
  }

  async listDeploymentKeysByEvent(tenantId: string, eventId: string): Promise<readonly string[]> {
    const items = await this.core.queryAllPages({
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
    const items = await this.core.queryAllPages({
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
    const items = await this.core.queryAllPages({
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
    const items = await this.core.queryAllPages({
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
    const out = await this.core.ddb.send(
      new QueryCommand({
        TableName: this.core.tableName,
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
    const out = await this.core.ddb.send(
      new QueryCommand({
        TableName: this.core.tableName,
        IndexName: "GSI2",
        KeyConditionExpression: "GSI2PK = :pk",
        ExpressionAttributeValues: { ":pk": `TEAMKEY#${teamLoginKey}` },
      }),
    );
    return (out.Items ?? []).map((item) => itemToRecord(item as Record<string, unknown>));
  }

  // -- Full-table Scans (per-page callback) --------------------------------

  async forEachCompleteDeploymentPage(
    eventId: string | undefined,
    onPage: (items: readonly DeploymentRecord[]) => Promise<void>,
  ): Promise<void> {
    const input: Omit<ScanCommandInput, "TableName" | "ExclusiveStartKey"> = eventId
      ? {
          FilterExpression: "#status = :complete AND eventId = :eventId",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":complete": "COMPLETE", ":eventId": eventId },
          Limit: 200,
        }
      : {
          FilterExpression: "#status = :complete",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":complete": "COMPLETE" },
          Limit: 200,
        };
    await this.core.scanAllPages(input, async (items) => {
      await onPage(items.map(itemToRecord));
    });
  }

  async forEachRuntimeReconcilablePage(
    onPage: (items: readonly DeploymentRecord[]) => Promise<void>,
  ): Promise<void> {
    await this.core.scanAllPages(
      {
        FilterExpression: "attribute_exists(runtimeProvider) AND #s IN (:p, :i, :c, :d)",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":p": "PENDING",
          ":i": "IN_PROGRESS",
          ":c": "COMPLETE",
          ":d": "DELETING",
        },
        Limit: 200,
      },
      async (items) => {
        await onPage(items.map(itemToRecord));
      },
    );
  }

  async forEachRuntimeScoreFeedPage(
    eventId: string,
    onPage: (
      items: readonly Pick<DeploymentRecord, "eventId" | "teamId" | "problemId" | "score">[],
    ) => Promise<void>,
  ): Promise<void> {
    await this.core.scanAllPages(
      {
        FilterExpression:
          "#status = :complete AND eventId = :eventId AND attribute_exists(teamId) AND attribute_exists(score)",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":complete": "COMPLETE", ":eventId": eventId },
        ProjectionExpression: "eventId, teamId, problemId, score",
        ConsistentRead: true,
        Limit: 200,
      },
      async (items) => {
        await onPage(
          items.map((item) => ({
            eventId: item.eventId as string | undefined,
            teamId: item.teamId as string | undefined,
            problemId: item.problemId as string,
            score: item.score as number | undefined,
          })),
        );
      },
    );
  }
}
