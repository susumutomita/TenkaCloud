import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { EventBridgeClient } from "@aws-sdk/client-eventbridge";
import { S3Client } from "@aws-sdk/client-s3";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import { getEnv } from "../../../helper-functions.js";
import { parseProblemsCatalog } from "../shared/catalog.js";
import { resolveVerifiedCompetitorAccount } from "../shared/competitor-account-lookup.js";
import {
  type DeployCreateRequestedDetail,
  EVENT_DETAIL_TYPE_DEPLOY_CREATE_REQUESTED,
  publishProblemEvent,
} from "../shared/events.js";
import { parseProblemsVisibility, shouldGeneratePresignedUrl } from "../shared/visibility.js";
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
   * ADR-008 Phase 3 (Issue #642): private 問題 id のセット (= `{id: "private"}`)。
   * `BATTLE_PROBLEMS_VISIBILITY` env から parse 済の map。 未指定 / 空なら全 public 扱い。
   */
  readonly problemsVisibility?: Readonly<Record<string, "private">>;
  /**
   * ADR-008 Phase 3 (Issue #642): private 問題 payload を格納する S3 bucket 名
   * (= `tc-challenges-${env}`)。 env (`CHALLENGE_PAYLOAD_BUCKET`) で binding。
   * 未設定なら presigned URL を発行せず、 既存 local-path 経路で動作する (= dormant default)。
   */
  readonly challengePayloadBucket?: string;
  /**
   * S3 client。 cold start 1 回構築されて warm invoke で再利用される想定。 テストで DI 可能。
   * presigned URL 発行が不要 (= 全 public 問題) の deploy では参照されないため optional。
   */
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

  // ADR-008 Phase 3 (Issue #642): private 問題で bucket env が bind されているなら
  // S3 から 15min TTL presigned URL を発行して event detail に詰める。 CodeBuild の
  // deploy-battles.sh (PR-638) が CHALLENGE_PAYLOAD_URL を受け取って zip を fetch する。
  // 失敗時は throw して deploy を止める (= 握り潰さない、 静かな regression を防ぐ)。
  let challengePayloadUrl: string | undefined;
  if (
    shouldGeneratePresignedUrl({
      problemId: request.problemId,
      visibility: ctx.problemsVisibility ?? {},
      bucketName: ctx.challengePayloadBucket,
    })
  ) {
    if (!ctx.s3) {
      throw new Error(
        "deploy-handler: private problem requires S3 client but ctx.s3 is undefined. " +
          "Check CDK wiring for CHALLENGE_PAYLOAD_BUCKET + S3Client.",
      );
    }
    challengePayloadUrl = await generateChallengePayloadUrl({
      s3: ctx.s3,
      bucketName: ctx.challengePayloadBucket as string,
      problemId: request.problemId,
    });
  }

  const detail: DeployCreateRequestedDetail = {
    jobId: item.jobId,
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
  readonly competitorAccountsTableName: string;
  readonly env: string;
  readonly eventBusName: string;
  readonly ddb: DynamoDBDocumentClient;
  readonly events: EventBridgeClient;
  readonly problemsCatalog: Readonly<Record<string, string>>;
  readonly problemsVisibility: Readonly<Record<string, "private">>;
  readonly challengePayloadBucket: string | undefined;
  readonly s3: S3Client;
}

export function buildSharedResources(): DeploySharedResources {
  // ADR-008 Phase 3 (Issue #642): bucket env が空文字列 / 未設定なら presigned URL を発行しない。
  // ChallengePayloadStack 未 deploy 時に Lambda が起動できるようにするための fail-open 設計。
  const bucketEnv = process.env.CHALLENGE_PAYLOAD_BUCKET;
  const challengePayloadBucket =
    typeof bucketEnv === "string" && bucketEnv.length > 0 ? bucketEnv : undefined;
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
