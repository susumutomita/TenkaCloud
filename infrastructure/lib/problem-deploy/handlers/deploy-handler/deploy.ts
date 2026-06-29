import type { CloudActionEnforcementMode } from "@TenkaCloud/trust-bridge";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { EventBridgeClient } from "@aws-sdk/client-eventbridge";
import { S3Client } from "@aws-sdk/client-s3";
import { SSMClient } from "@aws-sdk/client-ssm";
import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import { getEnv } from "../../../helper-functions.js";
import { parseProblemsCatalog } from "../shared/catalog.js";
import { resolveVerifiedCompetitorAccount } from "../shared/competitor-account-lookup.js";
import { deploymentTerminalExpiresAt } from "../shared/deployment-retention.js";
import {
  EXECUTABLE_ENGINE,
  EXECUTABLE_PROVIDER,
  makeProblemRuntimeResolver,
  type ProblemRuntime,
  selectAdapter,
} from "../shared/runtime/index.js";
import { logDeployTrace } from "../shared/trace-log.js";
import { emitShadowAudit } from "../shared/trust-bridge-shadow.js";
import {
  type PrivateVisibility,
  parseProblemsVisibility,
  resolveChallengePayloadBucket,
} from "../shared/visibility.js";
import { type AdapterDependencyConfig, buildAdapterDependencies } from "./adapter-dependencies.js";
import { maybeHoldDeploy, parseEnforcementMode } from "./cloud-action-enforcement.js";
import {
  type DeployQuotaConfig,
  enforceDeployQuota,
  parseDeployQuota,
  type QuotaTier,
} from "./deploy-quota.js";
import { buildStackPrefix, slugify } from "./naming.js";
import { dispatchPreparedDeployment } from "./prepared-dispatch.js";
import { generateChallengePayloadUrl } from "./presigned-url.js";
import { generateTeamLoginKey } from "./team-key.js";
import type { DeploymentItem, DeployRequest, DeployResponse } from "./types.js";

/**
 * deploy worker の実行コンテキスト。 provider 別 adapter 依存の DI surface (env / tenantId / events /
 * eventBusName + sakura/azure/gcp の account-gated client) は [[AdapterDependencyConfig]] を継承して 1 箇所で
 * 定義する (= DeployContext と builder 間の重複排除、 DRY)。 ここでは deploy 固有の DDB / TTL / catalog /
 * visibility / runtime resolver を追加する。
 */
export interface DeployContext extends AdapterDependencyConfig {
  readonly tableName: string;
  /**
   * Phase 2.2 (Issue #459): CompetitorAccounts table 名 + SSM SecureString path env 名。
   * `startDeployment` が verified=true gate と AssumeRole metadata 注入に使う。
   */
  readonly competitorAccountsTableName: string;
  readonly ddb: DynamoDBDocumentClient;
  /** epoch ms 提供。テストで決定論的にできるよう DI。 */
  readonly now: () => number;
  /** stack の自動 teardown までの猶予時間。default 8 時間。 */
  readonly ttlMs?: number;
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
   * [ADR-023 / Issue #1268] Optional per-problemId runtime resolver. If
   * undefined OR if it returns undefined for a given problemId, the deploy
   * worker assumes `aws/cloudformation` — which preserves pre-#1268 behavior
   * exactly (every problem in the catalog today is CFn-backed).
   *
   * Tests pin this to assert that an `azure/bicep` problem is rejected with
   * `RuntimeNotSupportedError` BEFORE any DDB Put / EventBridge publish runs.
   */
  readonly resolveProblemRuntime?: (problemId: string) => ProblemRuntime | undefined;
  /** #1766: tier 別同時デプロイ上限。未設定 = クォータ無効 (在来 stack / Lite)。 */
  readonly deployQuota?: DeployQuotaConfig;
  /**
   * Issue #2019 / ADR-017: TrustBridge high-risk enforcement mode. `"shadow"`
   * (default / unset) = no behavior change, every deploy proceeds. `"enforce"`
   * = opt-in; a high-risk deploy (replacing a live stack) is held as
   * `APPROVAL_PENDING` instead of dispatching the adapter.
   */
  readonly cloudActionEnforcementMode?: CloudActionEnforcementMode;
}

export type DeployInvocation = DeployRequest & {
  readonly problemId: string;
  /** #1766: JWT claim から解決済みの quota tier。未指定は最も厳しい basic に倒す。 */
  readonly quotaTier?: QuotaTier;
};

const DEFAULT_TTL_MS = 8 * 60 * 60 * 1000;

const toEpochSeconds = (ms: number): number => Math.floor(ms / 1000);

/**
 * [ADR-026/027/032 / #1410-1412] 非 AWS runtime のときだけ provider/engine/entry を DeploymentItem に
 * 載せる (= teardown / status の adapter 経路判別)。 AWS/CFn は field を載せず従来行と byte-identical。
 */
function runtimeItemFields(
  runtime: ProblemRuntime,
): Pick<DeploymentItem, "runtimeProvider" | "runtimeEngine" | "runtimeEntry"> {
  if (runtime.provider === EXECUTABLE_PROVIDER && runtime.engine === EXECUTABLE_ENGINE) {
    return {};
  }
  return {
    runtimeProvider: runtime.provider,
    runtimeEngine: runtime.engine,
    runtimeEntry: runtime.entry,
  };
}

/**
 * ADR-008 Phase 3: private 問題なら 15min TTL の presigned URL を返す。 public 問題 /
 * bucket 未配線なら undefined (= local-path 経路)。 private なのに S3 client が無ければ
 * 設定不整合として loud throw する (= silent fallback 禁止)。
 */
async function resolveChallengePayloadUrl(
  ctx: DeployContext,
  problemId: string,
): Promise<string | undefined> {
  const privateBucket = resolveChallengePayloadBucket({
    problemId,
    visibility: ctx.problemsVisibility,
    bucketName: ctx.challengePayloadBucket,
  });
  if (!privateBucket) {
    return undefined;
  }
  if (!ctx.s3) {
    throw new Error(
      "deploy-handler: private problem requires S3 client but ctx.s3 is undefined. " +
        "Check CDK wiring for CHALLENGE_PAYLOAD_BUCKET + S3Client.",
    );
  }
  return generateChallengePayloadUrl({ s3: ctx.s3, bucketName: privateBucket, problemId });
}

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

  // #1766 (+PR-1803 review): クォータはより具体的な検証 (unknown problem / runtime 不一致 /
  // unverified account) の後、cloud mutation (DDB Put / EventBridge publish) の直前に
  // enforce する。先頭で弾くと、本来 404/422 を返すべきリクエストまで 429 で隠れる。
  await enforceDeployQuota(
    { ddb: ctx.ddb, tableName: ctx.tableName, quota: ctx.deployQuota },
    ctx.tenantId,
    request.quotaTier ?? "basic",
  );

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
    // [ADR-026/027/032 / #1410-1412] 非 AWS runtime のときだけ provider/engine/entry を永続化する
    // (= teardown / status が adapter 経由で動く判別。 AWS 行は従来どおり field なしで byte-identical)。
    ...runtimeItemFields(runtime),
  };

  await ctx.ddb.send(
    new PutCommand({
      TableName: ctx.tableName,
      Item: item,
    }),
  );

  // ADR-008 Phase 3: private 問題 + bucket bind 済なら S3 から 15min TTL presigned URL を
  // 発行。 CodeBuild の deploy-battles.sh が CHALLENGE_PAYLOAD_URL を fetch して zip 展開する。
  const challengePayloadUrl = await resolveChallengePayloadUrl(ctx, request.problemId);

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

  // Issue #2019 / ADR-017: staged enforcement gate. In the default `shadow` mode
  // this is a single env compare that returns `null` (proceed) with zero extra
  // I/O — the legacy path below is byte-for-byte unchanged. Only when the operator
  // opts in (`CLOUD_ACTION_ENFORCEMENT_MODE=enforce`) and this deploy matches the
  // gated high-risk rule (replacing a live stack) does it HOLD: it flips the row
  // PENDING → APPROVAL_PENDING and returns the held response WITHOUT dispatching
  // the adapter, so **no AssumeRole / CloudFormation runs**.
  const held = await maybeHoldDeploy({
    mode: ctx.cloudActionEnforcementMode ?? "shadow",
    ddb: ctx.ddb,
    tableName: ctx.tableName,
    jobId,
    tenantId: item.tenantId,
    problemId: item.problemId,
    teamSlug,
    namePrefix: item.namePrefix,
    teamLoginKey,
    expiresAt: item.expiresAt,
    nowIso: new Date(ctx.now()).toISOString(),
  });
  if (held) {
    return held;
  }

  try {
    // [ADR-023 / Issue #1268 / #2064] dispatch via the prepared-dispatch seam.
    // For AWS / CFn (= the only registered adapter today) this is byte-for-byte
    // the same `publishProblemEvent` the legacy inline code did — see
    // `AwsCloudFormationRuntimeAdapter.deploy`. No new IAM, no new SDK calls.
    // The adapter was already selected above (the pre-mutation runtime gate);
    // dispatchPreparedDeployment owns only the deploy invocation + rethrow.
    await dispatchPreparedDeployment({
      adapter,
      jobId,
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
  /**
   * [ADR-023 / #2054] Per-problemId runtime resolver, baked from non-aws
   * `metadata.runtime` at synth. Returns undefined for CFn problems (→ aws
   * default); returns e.g. `docker/compose` for a container problem so the
   * deploy is rejected pre-mutation instead of half-creating an AWS artifact.
   */
  readonly resolveProblemRuntime?: (problemId: string) => ProblemRuntime | undefined;
  readonly challengePayloadBucket: string | undefined;
  readonly s3: S3Client;
  /** [ADR-026 / #1412] per-team Sakura API key store の読取 client。 */
  readonly ssm: SSMClient;
  /** [ADR-026 / #1412] AppRun REST base URL の override (env)。 未設定なら本番 AppRun 共用型。 */
  readonly sakuraAppRunBaseUrl: string | undefined;
  /** #1766: tier 別同時デプロイ上限 (env JSON)。 未設定 = クォータ無効 (在来 stack / Lite)。 */
  readonly deployQuota: DeployQuotaConfig | undefined;
  /**
   * Issue #2019 / ADR-017: TrustBridge high-risk enforcement mode (env). Default
   * `"shadow"` (= unset / anything but `"enforce"`) keeps the legacy path.
   */
  readonly cloudActionEnforcementMode: CloudActionEnforcementMode;
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
    resolveProblemRuntime: makeProblemRuntimeResolver(process.env.BATTLE_PROBLEMS_RUNTIMES),
    challengePayloadBucket,
    s3: new S3Client({}),
    ssm: new SSMClient({}),
    sakuraAppRunBaseUrl: process.env.SAKURA_APPRUN_BASE_URL || undefined,
    deployQuota: parseDeployQuota(process.env.DEPLOY_QUOTA_BY_TIER),
    cloudActionEnforcementMode: parseEnforcementMode(process.env.CLOUD_ACTION_ENFORCEMENT_MODE),
  };
}

export function buildContext(shared: DeploySharedResources, tenantId: string): DeployContext {
  return {
    ...shared,
    tenantId,
    now: () => Date.now(),
  };
}
