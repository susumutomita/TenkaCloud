import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { EventBridgeClient } from "@aws-sdk/client-eventbridge";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import { getEnv } from "../../../helper-functions.js";
import {
  type DeployCreateRequestedDetail,
  EVENT_DETAIL_TYPE_DEPLOY_CREATE_REQUESTED,
  publishProblemEvent,
} from "../shared/events.js";
import { buildStackPrefix, slugify } from "./naming.js";
import { generateTeamLoginKey } from "./team-key.js";
import type { DeploymentItem, DeployRequest, DeployResponse } from "./types.js";

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
  /**
   * problemId → problemDir のマップ (例: `{"hello-world": "problems/sample/hello-world"}`)。
   * MVP-1 で env (`BATTLE_PROBLEMS_CATALOG` JSON) から injected される hard-coded catalog。
   * Phase 2 (ADR-003) で DDB ベースの問題カタログに置換する。
   */
  readonly problemsCatalog: Readonly<Record<string, string>>;
}

export type DeployInvocation = DeployRequest & {
  readonly problemId: string;
};

const DEFAULT_TTL_MS = 8 * 60 * 60 * 1000;

const toEpochSeconds = (ms: number): number => Math.floor(ms / 1000);

export class UnknownProblemError extends Error {
  constructor(problemId: string) {
    super(`unknown problemId: ${problemId}`);
    this.name = "UnknownProblemError";
  }
}

/**
 * 1 件の deploy job を起動する。
 *
 * DDB Put → EventBridge Publish の順序は失敗セマンティクスが要求する: PutEvents が
 * 先にいくと、subscriber が DDB から読めない行を見にいく可能性がある。Promise.all 化しない。
 */
export async function startDeployment(
  ctx: DeployContext,
  request: DeployInvocation,
): Promise<DeployResponse> {
  const problemDir = ctx.problemsCatalog[request.problemId];
  if (!problemDir) throw new UnknownProblemError(request.problemId);

  const jobId = ulid();
  const teamLoginKey = generateTeamLoginKey();
  const namePrefix = buildStackPrefix(request.problemId, request.teamName);
  const teamSlug = slugify(request.teamName);
  const nowMs = ctx.now();
  const expiresAt = toEpochSeconds(nowMs + (ctx.ttlMs ?? DEFAULT_TTL_MS));
  const createdAt = new Date(nowMs).toISOString();

  const item: DeploymentItem = {
    PK: `DEPLOYMENT#${jobId}`,
    SK: "META",
    GSI1PK: `TENANT#${ctx.tenantId}`,
    GSI1SK: createdAt,
    GSI2PK: `TEAMKEY#${teamLoginKey}`,
    GSI2SK: createdAt,

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

  const detail: DeployCreateRequestedDetail = {
    jobId: item.jobId,
    tenantId: item.tenantId,
    problemId: item.problemId,
    problemDir,
    teamSlug,
    namePrefix: item.namePrefix,
    region: item.region,
    awsAccountId: item.awsAccountId,
  };
  await publishProblemEvent({
    client: ctx.events,
    busName: ctx.eventBusName,
    detailType: EVENT_DETAIL_TYPE_DEPLOY_CREATE_REQUESTED,
    jobId,
    detail,
  });

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
  readonly problemsCatalog: Readonly<Record<string, string>>;
}

export function buildSharedResources(): DeploySharedResources {
  const catalogRaw = process.env.BATTLE_PROBLEMS_CATALOG ?? "{}";
  let problemsCatalog: Record<string, string> = {};
  try {
    const parsed = JSON.parse(catalogRaw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "string") problemsCatalog[k] = v;
      }
    }
  } catch {
    problemsCatalog = {};
  }

  return {
    tableName: getEnv("DEPLOYMENTS_TABLE_NAME"),
    eventBusName: getEnv("DEPLOY_EVENT_BUS_NAME"),
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    events: new EventBridgeClient({}),
    problemsCatalog,
  };
}

export function buildContext(shared: DeploySharedResources, tenantId: string): DeployContext {
  return {
    ...shared,
    tenantId,
    now: () => Date.now(),
  };
}
