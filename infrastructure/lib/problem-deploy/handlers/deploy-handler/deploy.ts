import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { EventBridgeClient } from "@aws-sdk/client-eventbridge";
import { S3Client } from "@aws-sdk/client-s3";
import { SSMClient } from "@aws-sdk/client-ssm";
import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import { getEnv } from "../../../helper-functions.js";
import { createSakuraAppRunRestClient } from "../../runtime-clients/sakura-apprun-rest-client.js";
import { parseProblemsCatalog } from "../shared/catalog.js";
import { resolveVerifiedCompetitorAccount } from "../shared/competitor-account-lookup.js";
import { deploymentTerminalExpiresAt } from "../shared/deployment-retention.js";
import {
  type AdapterDependencies,
  EXECUTABLE_ENGINE,
  EXECUTABLE_PROVIDER,
  type ProblemRuntime,
  SAKURA_ENGINE,
  SAKURA_PROVIDER,
  selectAdapter,
} from "../shared/runtime/index.js";
import { getSakuraCredential } from "../shared/sakura-credential-store.js";
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
  /**
   * [ADR-026 / Issue #1412] sakura/apprun deploy の account-gated 配線。 `ssm` は per-team Sakura
   * API key store (SSM SecureString) の読取、 `sakuraAppRunBaseUrl` は AppRun REST base URL の override。
   * 未配線 (= ssm undefined) なら sakura/apprun 問題は selectAdapter で reserved error のまま (= 従来動作)。
   */
  readonly ssm?: Pick<SSMClient, "send">;
  readonly sakuraAppRunBaseUrl?: string;
  /**
   * [ADR-023 / Issue #1268] Optional per-problemId runtime resolver. If
   * undefined OR if it returns undefined for a given problemId, the deploy
   * worker assumes `aws/cloudformation` — which preserves pre-#1268 behavior
   * exactly (every problem in the catalog today is CFn-backed).
   *
   * Tests pin this to assert that an `azure/bicep` problem is rejected with
   * `RuntimeNotSupportedError` BEFORE any DDB Put / EventBridge publish runs.
   */
  readonly resolveProblemRuntime?: (problemId: string) => ProblemRuntime | undefined;
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
 * [ADR-026 / #1412] sakura/apprun の adapter context を組む。 getApiKey は per-team SSM SecureString
 * store を引き、 未登録なら loud に throw (= silent fallback 禁止)。 client は実 AppRun REST 実装を
 * credential で束ねる factory。 SSM が配線されていない (= ctx.ssm undefined) ときは呼ばれない。
 */
function buildSakuraAdapterContext(
  ssm: Pick<SSMClient, "send">,
  env: string,
  tenantId: string,
  teamSlug: string,
  sakuraAppRunBaseUrl: string | undefined,
): NonNullable<AdapterDependencies["sakura"]> {
  return {
    getApiKey: async () => {
      const credential = await getSakuraCredential({ ssm, env }, tenantId, teamSlug);
      if (!credential) {
        throw new Error(
          `no Sakura API key registered for tenant ${tenantId} team ${teamSlug} ` +
            "(register it in the per-team SSM SecureString store before deploying a sakura/apprun problem)",
        );
      }
      return credential;
    },
    client: (credential) =>
      createSakuraAppRunRestClient(
        credential,
        sakuraAppRunBaseUrl ? { baseUrl: sakuraAppRunBaseUrl } : {},
      ),
  };
}

/**
 * runtime に応じた adapter 依存を組む。 aws は常に存在し、 sakura/apprun は SSM (per-team key store) が
 * 配線されたときだけ追加する (= 未配線なら selectAdapter が reserved error)。 deps を組む条件分岐を
 * startDeployment から切り出して責務を分離する (SRP)。
 */
function buildAdapterDependencies(
  ctx: DeployContext,
  runtime: ProblemRuntime,
  teamSlug: string,
): AdapterDependencies {
  const aws = { events: ctx.events, eventBusName: ctx.eventBusName };
  if (ctx.ssm && runtime.provider === SAKURA_PROVIDER && runtime.engine === SAKURA_ENGINE) {
    return {
      aws,
      sakura: buildSakuraAdapterContext(
        ctx.ssm,
        ctx.env,
        ctx.tenantId,
        teamSlug,
        ctx.sakuraAppRunBaseUrl,
      ),
    };
  }
  return { aws };
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

  // [ADR-023 / Issue #1268] Resolve runtime BEFORE any cloud mutation. Default
  // is aws/cloudformation (= the only registered adapter today), which keeps
  // legacy problems and explicit `runtime: aws/cloudformation` declarations on
  // the exact same path. A mismatched runtime (e.g. azure/bicep) raises
  // `RuntimeNotSupportedError` here — pre-DDB-Put / pre-EventBridge — so the
  // platform never half-creates an AWS-shaped artifact for a non-AWS problem.
  const runtime: ProblemRuntime = ctx.resolveProblemRuntime?.(request.problemId) ?? {
    provider: EXECUTABLE_PROVIDER,
    engine: EXECUTABLE_ENGINE,
    entry: "template.yaml",
  };
  // teamSlug は sakura の per-team key 解決にも使うので runtime 解決直後に確定する。
  const teamSlug = slugify(request.teamName);
  const adapter = selectAdapter(runtime, buildAdapterDependencies(ctx, runtime, teamSlug));

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
    // [ADR-023 / Issue #1268] dispatch via runtime adapter. For AWS / CFn (=
    // the only registered adapter today) this is byte-for-byte the same
    // `publishProblemEvent` the legacy inline code did — see
    // `AwsCloudFormationRuntimeAdapter.deploy`. No new IAM, no new SDK calls.
    await adapter.deploy({
      jobId,
      correlationId: jobId,
      tenantId: item.tenantId,
      problemId: item.problemId,
      problemDir,
      teamSlug,
      namePrefix: item.namePrefix,
      region: item.region,
      awsAccountId: item.awsAccountId,
      ...(verified.competitorRoleArn ? { competitorRoleArn: verified.competitorRoleArn } : {}),
      ...(verified.externalIdParameterName
        ? { externalIdParameterName: verified.externalIdParameterName }
        : {}),
      ...(challengePayloadUrl ? { challengePayloadUrl } : {}),
    });
  } catch (err) {
    try {
      await ctx.ddb.send(
        new UpdateCommand({
          TableName: ctx.tableName,
          Key: { PK: `DEPLOYMENT#${jobId}`, SK: "META" },
          // Issue #1200: FAILED terminal 化のタイミングで expiresAt を 7 日 retention に
          // refresh する (= 旧来 create 時の 8h session TTL を上書きし、 audit 履歴を 7 日残す)。
          UpdateExpression:
            "SET #s = :failed, updatedAt = :updatedAt, failureReason = :reason, expiresAt = :expiresAt",
          // #872: compensation 経路に tenantId condition (= 直前 PutItem 自身が item.tenantId を
          // 書いているので transitively 一致するが、 write レベルで明示する defense-in-depth)。
          ConditionExpression: "tenantId = :tenantId AND #s = :pending",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: {
            ":failed": "FAILED",
            ":pending": "PENDING",
            ":updatedAt": new Date(ctx.now()).toISOString(),
            ":reason": "Failed to publish DeployCreateRequested event",
            ":tenantId": item.tenantId,
            ":expiresAt": deploymentTerminalExpiresAt(ctx.now()),
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
  /** [ADR-026 / #1412] per-team Sakura API key store の読取 client。 */
  readonly ssm: SSMClient;
  /** [ADR-026 / #1412] AppRun REST base URL の override (env)。 未設定なら本番 AppRun 共用型。 */
  readonly sakuraAppRunBaseUrl: string | undefined;
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
    ssm: new SSMClient({}),
    sakuraAppRunBaseUrl: process.env.SAKURA_APPRUN_BASE_URL || undefined,
  };
}

export function buildContext(shared: DeploySharedResources, tenantId: string): DeployContext {
  return {
    ...shared,
    tenantId,
    now: () => Date.now(),
  };
}
