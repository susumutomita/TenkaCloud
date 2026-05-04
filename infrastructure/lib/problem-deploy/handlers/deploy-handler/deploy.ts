import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import { getEnv } from "../../../helper-functions.js";
import { buildStackPrefix } from "./naming.js";
import { generateTeamLoginKey } from "./team-key.js";
import {
  type DeploymentItem,
  type DeployRequest,
  type DeployRequestedDetail,
  type DeployResponse,
  EVENT_DETAIL_TYPE_DEPLOY_REQUESTED,
  EVENT_SOURCE,
} from "./types.js";

export interface DeployContext {
  readonly tableName: string;
  readonly eventBusName: string;
  readonly ddb: DynamoDBDocumentClient;
  readonly events: EventBridgeClient;
  /** epoch ms 提供。テストで決定論的にできるよう DI。 */
  readonly now: () => number;
  /** stack の自動 teardown までの猶予時間。default 8 時間。 */
  readonly ttlMs?: number;
  /** caller (TenantAdmin JWT) の `custom:tenantId`。 */
  readonly tenantId: string;
}

export type DeployInvocation = DeployRequest & {
  readonly problemId: string;
};

const DEFAULT_TTL_MS = 8 * 60 * 60 * 1000;

const toEpochSeconds = (ms: number): number => Math.floor(ms / 1000);

/**
 * 1 件の deploy job を起動する。
 *
 * DDB Put → EventBridge Publish の順序は失敗セマンティクスが要求する: PutEvents が
 * 先にいくと、worker が DDB から読めない行を見にいく可能性がある。Promise.all 化しない。
 *
 * 重複 deploy 防止 (同一 namePrefix の同時起動拒否) は別途 conditional put で追加する想定。
 */
export async function startDeployment(
  ctx: DeployContext,
  request: DeployInvocation,
): Promise<DeployResponse> {
  const jobId = ulid();
  const teamLoginKey = generateTeamLoginKey();
  const namePrefix = buildStackPrefix(request.problemId, request.teamName);
  const nowMs = ctx.now();
  const expiresAt = toEpochSeconds(nowMs + (ctx.ttlMs ?? DEFAULT_TTL_MS));
  const createdAt = new Date(nowMs).toISOString();

  const item: DeploymentItem = {
    PK: `DEPLOYMENT#${jobId}`,
    SK: "META",
    GSI1PK: `TENANT#${ctx.tenantId}`,
    GSI1SK: createdAt,

    jobId,
    problemId: request.problemId,
    tenantId: ctx.tenantId,
    awsAccountId: request.awsAccountId,
    region: request.region,
    teamName: request.teamName,
    namePrefix,
    teamLoginKey,
    status: "PENDING",
    createdAt,
    updatedAt: createdAt,
    expiresAt,
    accountGroupId: request.accountGroupId,
    problemSetId: request.problemSetId,
  };

  await ctx.ddb.send(
    new PutCommand({
      TableName: ctx.tableName,
      Item: item,
    }),
  );

  const detail: DeployRequestedDetail = {
    jobId: item.jobId,
    problemId: item.problemId,
    tenantId: item.tenantId,
    awsAccountId: item.awsAccountId,
    region: item.region,
    teamName: item.teamName,
    namePrefix: item.namePrefix,
  };
  await ctx.events.send(
    new PutEventsCommand({
      Entries: [
        {
          EventBusName: ctx.eventBusName,
          Source: EVENT_SOURCE,
          DetailType: EVENT_DETAIL_TYPE_DEPLOY_REQUESTED,
          Detail: JSON.stringify(detail),
          Resources: [`tenkacloud:deployment:${jobId}`],
        },
      ],
    }),
  );

  return {
    jobId,
    status: item.status,
    namePrefix,
    teamLoginKey,
    expiresAt: item.expiresAt,
  };
}

/**
 * Lambda module-scope で 1 度だけ build される shared resources。warm invoke で
 * SDK client / env を再利用するため module scope に hoist する。
 */
export interface DeploySharedResources {
  readonly tableName: string;
  readonly eventBusName: string;
  readonly ddb: DynamoDBDocumentClient;
  readonly events: EventBridgeClient;
}

export function buildSharedResources(): DeploySharedResources {
  return {
    tableName: getEnv("DEPLOYMENTS_TABLE_NAME"),
    eventBusName: getEnv("DEPLOY_EVENT_BUS_NAME"),
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    events: new EventBridgeClient({}),
  };
}

export function buildContext(shared: DeploySharedResources, tenantId: string): DeployContext {
  return {
    ...shared,
    tenantId,
    now: () => Date.now(),
  };
}
