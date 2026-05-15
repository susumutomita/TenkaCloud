import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { EventBridgeClient } from "@aws-sdk/client-eventbridge";
import { S3Client } from "@aws-sdk/client-s3";
import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import { getEnv } from "../../../helper-functions.js";
import { parseProblemsCatalog } from "../shared/catalog.js";
import { resolveVerifiedCompetitorAccount } from "../shared/competitor-account-lookup.js";
import {
  type DeployCreateRequestedDetail,
  EVENT_DETAIL_TYPE_DEPLOY_CREATE_REQUESTED,
  publishProblemEvent,
} from "../shared/events.js";
import { logDeployTrace } from "../shared/trace-log.js";
import { emitShadowAudit } from "../shared/trust-bridge-shadow.js";
import {
  type PrivateVisibility,
  parseProblemsVisibility,
  resolveChallengePayloadBucket,
} from "../shared/visibility.js";
import { buildStackPrefix, slugify } from "./naming.js";
import { generateChallengePayloadUrl } from "./presigned-url.js";
import { generateTeamLoginKey } from "./team-key.js";
import type { DeploymentItem, DeployRequest, DeployResponse } from "./types.js";

export interface DeployContext {
  readonly tableName: string;
  /**
   * Phase 2.2 (Issue #459): CompetitorAccounts table 名 + SSM SecureString path env 名。
   * `startDeployment` が verified=true gate と AssumeRole metadata 注入に使う。
   */
  readonly competitorAccountsTableName: string;
  readonly env: string;
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
   * problemId → problemDir のマップ (例: `{"hello-world": "problems/challenges/hello-world"}`)。
   * MVP-1 で env (`BATTLE_PROBLEMS_CATALOG` JSON) from inject される hard-coded catalog。
   * Phase 2 (ADR-003) で DDB ベースの問題カタログに置換する。
   */
  readonly problemsCatalog: Readonly<Record<string, string>>;
  /**
   * ADR-008 Phase 3: visibility / bucket / s3 client。 いずれか欠けるなら presigned URL を
   * 発行せず local-path 経路で動作する (= dormant default)。
   */
  readonly problemsVisibility?: Readonly<Record<string, PrivateVisibility>>;
  readonly challengePayloadBucket?: string;
  readonly s3?: S3Client;
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
 * Phase 2.2 (Issue #459): verified=true 行が CompetitorAccounts table に無い (tenantId,
 * awsAccountId) 組への deploy を reject するために throw する error。
 * handler 側で 409 Conflict / 422 Unprocessable に変換する。
 */
export class UnverifiedCompetitorAccountError extends Error {
  constructor(public readonly awsAccountId: string) {
    super(`competitor account ${awsAccountId} is not verified for this tenant`);
    this.name = "UnverifiedCompetitorAccountError";
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

  // Phase 2.2 (Issue #459): verified=true な行が無ければ deploy しない (= fail-closed)。
  // 同 account deploy の dev fallback も廃止 — 全 deploy は verified なれた account のみ。
  const verified = await resolveVerifiedCompetitorAccount(
    {
      ddb: ctx.ddb,
      competitorAccountsTableName: ctx.competitorAccountsTableName,
      env: ctx.env,
    },
    ctx.tenantId,
    request.awsAccountId,
  );
  if (!verified) throw new UnverifiedCompetitorAccountError(request.awsAccountId);

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
    competitorRoleArn: verified.competitorRoleArn,
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

  // ADR-008 Phase 3: private 問題 + bucket bind 済なら S3 から 15min TTL presigned URL を
  // 発行。 CodeBuild の deploy-battles.sh が CHALLENGE_PAYLOAD_URL を fetch して zip 展開する。
  const privateBucket = resolveChallengePayloadBucket({
    problemId: request.problemId,
    visibility: ctx.problemsVisibility,
    bucketName: ctx.challengePayloadBucket,
  });
  let challengePayloadUrl: string | undefined;
  if (privateBucket) {
    if (!ctx.s3) {
      throw new Error(
        "deploy-handler: private problem requires S3 client but ctx.s3 is undefined. " +
          "Check CDK wiring for CHALLENGE_PAYLOAD_BUCKET + S3Client.",
      );
    }
    challengePayloadUrl = await generateChallengePayloadUrl({
      s3: ctx.s3,
      bucketName: privateBucket,
      problemId: request.problemId,
    });
  }

  const detail: DeployCreateRequestedDetail = {
    jobId: item.jobId,
    correlationId: item.jobId,
    tenantId: item.tenantId,
    problemId: item.problemId,
    problemDir,
    teamSlug,
    namePrefix: item.namePrefix,
    region: item.region,
    awsAccountId: item.awsAccountId,
    // Phase 2.2: AssumeRole 用 metadata。`resolveVerifiedCompetitorAccount` の戻り値から
    // そのまま詰める。CodeBuild script (deploy-battles.sh wrapper) が SSM ExternalId を
    // fetch して AssumeRole する。
    competitorRoleArn: verified.competitorRoleArn,
    externalIdParameterName: verified.externalIdParameterName,
    ...(challengePayloadUrl ? { challengePayloadUrl } : {}),
  };
  // Issue #795 ADR-017 Phase 3 (shadow integration): 既存 deploy flow を変更せず、
  // CloudActionIntent を構築 + audit log を CloudWatch に emit する。 失敗系も
  // fail-open (= 既存の publishProblemEvent / DDB Put には影響を与えない)。
  emitShadowAudit({
    jobId,
    tenantId: item.tenantId,
    teamSlug,
    problemId: item.problemId,
    namePrefix: item.namePrefix,
    region: item.region,
    awsAccountId: item.awsAccountId,
    ...(verified.competitorRoleArn ? { competitorRoleArn: verified.competitorRoleArn } : {}),
    nowMs,
    ttlSeconds: 900,
    action: "deploy",
    requestedScopes: [
      "cloudformation:CreateStack",
      "cloudformation:DescribeStacks",
      "cloudformation:DescribeStackEvents",
    ],
  });
  try {
    await publishProblemEvent({
      client: ctx.events,
      busName: ctx.eventBusName,
      detailType: EVENT_DETAIL_TYPE_DEPLOY_CREATE_REQUESTED,
      jobId,
      detail,
    });
  } catch (err) {
    try {
      await ctx.ddb.send(
        new UpdateCommand({
          TableName: ctx.tableName,
          Key: { PK: `DEPLOYMENT#${jobId}`, SK: "META" },
          UpdateExpression: "SET #s = :failed, updatedAt = :updatedAt, failureReason = :reason",
          ConditionExpression: "#s = :pending",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: {
            ":failed": "FAILED",
            ":pending": "PENDING",
            ":updatedAt": new Date(ctx.now()).toISOString(),
            ":reason": "Failed to publish DeployCreateRequested event",
          },
        }),
      );
    } catch {
      // best-effort: compensation failure should not hide the original publish error.
    }
    throw err;
  }
  logDeployTrace("deploy.create.enqueued", {
    jobId,
    correlationId: jobId,
    tenantId: item.tenantId,
    problemId: item.problemId,
    teamSlug,
    region: item.region,
    awsAccountId: item.awsAccountId,
    namePrefix: item.namePrefix,
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
  readonly competitorAccountsTableName: string;
  readonly env: string;
  readonly eventBusName: string;
  readonly ddb: DynamoDBDocumentClient;
  readonly events: EventBridgeClient;
  readonly problemsCatalog: Readonly<Record<string, string>>;
  readonly problemsVisibility: Readonly<Record<string, PrivateVisibility>>;
  readonly challengePayloadBucket: string | undefined;
  readonly s3: S3Client;
}

export function buildSharedResources(): DeploySharedResources {
  // ChallengePayloadStack 未 deploy なら env は空文字列で届く。 dormant 扱いに正規化。
  const challengePayloadBucket = process.env.CHALLENGE_PAYLOAD_BUCKET || undefined;
  return {
    tableName: getEnv("DEPLOYMENTS_TABLE_NAME"),
    competitorAccountsTableName: getEnv("COMPETITOR_ACCOUNTS_TABLE_NAME"),
    env: getEnv("DEPLOY_ENVIRONMENT"),
    eventBusName: getEnv("DEPLOY_EVENT_BUS_NAME"),
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    events: new EventBridgeClient({}),
    problemsCatalog: parseProblemsCatalog(process.env.BATTLE_PROBLEMS_CATALOG),
    problemsVisibility: parseProblemsVisibility(process.env.BATTLE_PROBLEMS_VISIBILITY),
    challengePayloadBucket,
    s3: new S3Client({}),
  };
}

export function buildContext(shared: DeploySharedResources, tenantId: string): DeployContext {
  return {
    ...shared,
    tenantId,
    now: () => Date.now(),
  };
}
