import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import { buildStackPrefix } from "./naming.js";
import { generateTeamLoginKey } from "./team-key.js";
import type {
  DeploymentItem,
  DeployRequest,
  DeployRequestedDetail,
  DeployResponse,
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
  /** caller (TenantAdmin JWT) の `custom:tenantId`。今は trust 前提、将来 authorizer から差し込む。 */
  readonly tenantId: string;
}

export type DeployInvocation = DeployRequest & {
  readonly problemId: string;
};

const DEFAULT_TTL_MS = 8 * 60 * 60 * 1000;

/**
 * 1 件の deploy job を起動する。
 *
 * 1. jobId (ULID) と teamLoginKey (32 byte b64url) を生成
 * 2. NamePrefix を計算 (UI と同じ規約: `tc-{problemSlug}-{teamSlug}`)
 * 3. Deployments DDB に PutItem (status=PENDING)
 * 4. EventBridge に `tenkacloud.problem.DeployRequested` を put (PR-D worker が拾う)
 * 5. caller に jobId / namePrefix / teamLoginKey を返す (teamLoginKey はこの 1 度だけ露出)
 *
 * 失敗時は throw する (caller = ルートハンドラが 5xx に変換)。重複 deploy 防止 (同じ
 * NamePrefix の同時起動拒否) は Phase 2 で conditional put として追加する。
 */
export async function startDeployment(
  ctx: DeployContext,
  request: DeployInvocation,
): Promise<DeployResponse> {
  const jobId = ulid();
  const teamLoginKey = generateTeamLoginKey();
  const namePrefix = buildStackPrefix(request.problemId, request.teamName);
  const nowMs = ctx.now();
  const expiresMs = nowMs + (ctx.ttlMs ?? DEFAULT_TTL_MS);
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
    // DynamoDB TTL は epoch seconds
    expiresAt: Math.floor(expiresMs / 1000),
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
    jobId,
    problemId: request.problemId,
    tenantId: ctx.tenantId,
    awsAccountId: request.awsAccountId,
    region: request.region,
    teamName: request.teamName,
    namePrefix,
  };
  await ctx.events.send(
    new PutEventsCommand({
      Entries: [
        {
          EventBusName: ctx.eventBusName,
          Source: "tenkacloud.problem",
          DetailType: "DeployRequested",
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
 * Lambda runtime で利用する default context。env vars 経由で table / bus 名を受け取る。
 */
export function createDefaultContext(tenantId: string): DeployContext {
  const tableName = required("DEPLOYMENTS_TABLE_NAME");
  const eventBusName = required("DEPLOY_EVENT_BUS_NAME");
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const events = new EventBridgeClient({});
  return {
    tableName,
    eventBusName,
    ddb,
    events,
    now: () => Date.now(),
    tenantId,
  };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`env var ${name} is not set`);
  return value;
}
