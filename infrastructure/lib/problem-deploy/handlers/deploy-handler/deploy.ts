import type { CloudActionEnforcementMode } from "@TenkaCloud/trust-bridge";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { EventBridgeClient } from "@aws-sdk/client-eventbridge";
import { S3Client } from "@aws-sdk/client-s3";
import { SSMClient } from "@aws-sdk/client-ssm";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import { getEnv } from "../../../helper-functions.js";
import type { DeploymentsLifecyclePort } from "../../control-data/deployments-repository.js";
import type { ControlDataRuntime } from "../../control-data/runtime-repositories.js";
import { getAzureCredential } from "../shared/azure-credential-store.js";
import { parseProblemsCatalog } from "../shared/catalog.js";
import { resolveVerifiedCompetitorAccount } from "../shared/competitor-account-lookup.js";
import { deploymentTerminalExpiresAt } from "../shared/deployment-retention.js";
import { getGcpCredential } from "../shared/gcp-credential-store.js";
import {
  AZURE_PROVIDER,
  EXECUTABLE_ENGINE,
  EXECUTABLE_PROVIDER,
  GCP_PROVIDER,
  makeProblemRuntimeDescriptorResolver,
  makeProblemRuntimeResolver,
  type ProblemRuntime,
  type ProblemRuntimeDescriptor,
  SAKURA_PROVIDER,
  selectAdapter,
} from "../shared/runtime/index.js";
import { getSakuraCredential } from "../shared/sakura-credential-store.js";
import { logDeployTrace } from "../shared/trace-log.js";
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
import { resolveDeploymentsRepository } from "./shared.js";
import { generateTeamLoginKey } from "./team-key.js";
import {
  type CompositeDeployRequest,
  type DeploymentItem,
  type DeployResponse,
  runtimeItemFields,
} from "./types.js";

/**
 * deploy worker の実行コンテキスト。 provider 別 adapter 依存の DI surface (env / tenantId / events /
 * eventBusName + sakura/azure/gcp の account-gated client) は [[AdapterDependencyConfig]] を継承して 1 箇所で
 * 定義する (= DeployContext と builder 間の重複排除、 DRY)。 ここでは deploy 固有の DDB / TTL / catalog /
 * visibility / runtime resolver を追加する。
 */
export interface DeployContext extends AdapterDependencyConfig {
  /** [#2527 Slice 4] Injected control-data runtime (from the Lambda entrypoint's instance). */
  readonly runtime: ControlDataRuntime;
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
   * env (`BATTLE_PROBLEMS_CATALOG` JSON) から注入される hard-coded catalog。
   */
  readonly problemsCatalog: Readonly<Record<string, string>>;
  /**
   * visibility / bucket / client。 いずれか欠けるなら presigned URL を
   * 発行せず local-path 経路で動作する (= dormant default)。
   */
  readonly problemsVisibility?: Readonly<Record<string, PrivateVisibility>>;
  readonly challengePayloadBucket?: string;
  readonly s3?: S3Client;
  /**
   * [Issue #1268] Optional per-problemId runtime resolver. If
   * undefined OR if it returns undefined for a given problemId, the deploy
   * worker assumes `aws/cloudformation`, preserving the legacy path for metadata that omits
   * an explicit runtime.
   *
   * Tests pin this to assert that an `azure/bicep` problem is rejected with
   * `RuntimeNotSupportedError` BEFORE any DDB Put / EventBridge publish runs.
   */
  readonly resolveProblemRuntime?: (problemId: string) => ProblemRuntime | undefined;
  /**
   * [Composite Runtime / Issue #2075] Per-problemId runtime DESCRIPTOR resolver
   * (single OR composite). The route uses this to detect a composite problem and
   * fork to the composite path; legacy / single-provider problems return a single
   * descriptor (or undefined) and stay on `startDeployment` unchanged. Undefined
   * here keeps every problem on the legacy single-provider path.
   */
  readonly resolveProblemRuntimeDescriptor?: (
    problemId: string,
  ) => ProblemRuntimeDescriptor | undefined;
  /** #1766: tier 別同時デプロイ上限。未設定 = クォータ無効 (在来 stack / Lite)。 */
  readonly deployQuota?: DeployQuotaConfig;
  /**
   * Issue #2019: TrustBridge high-risk enforcement mode. `"shadow"`
   * (default / unset) = no behavior change, every deploy proceeds. `"enforce"`
   * = opt-in; a high-risk deploy (replacing a live stack) is held as
   * `APPROVAL_PENDING` instead of dispatching the adapter.
   */
  readonly cloudActionEnforcementMode?: CloudActionEnforcementMode;
}

/**
 * [Issue #2561] `awsAccountId` / `region` are required only when the resolved
 * problem runtime is `aws/cloudformation` (the route's default). A non-AWS
 * single-provider problem (gcp/azure/sakura) needs neither — it is keyed on
 * `teamName`/`teamSlug` against the provider's own per-team credential store.
 * Reuses {@link CompositeDeployRequest}'s exact relaxation (it already models
 * "AWS fields required only when the plan/runtime actually targets AWS") so
 * the two optional-AWS-input shapes never drift apart.
 */
export type DeployInvocation = CompositeDeployRequest & {
  readonly problemId: string;
  /** #1766: JWT claim から解決済みの quota tier。未指定は最も厳しい basic に倒す。 */
  readonly quotaTier?: QuotaTier;
};

const DEFAULT_TTL_MS = 8 * 60 * 60 * 1000;

const toEpochSeconds = (ms: number): number => Math.floor(ms / 1000);

/**
 * private 問題なら 15min TTL の presigned URL を返す。 public 問題 /
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
 * [Issue #2561] The resolved runtime is `aws/cloudformation` but the request
 * omitted `awsAccountId`/`region`. The route's strict `DeployRequestSchema`
 * already guarantees this cannot happen for a real HTTP request; this is
 * defense-in-depth for direct `startDeployment` callers (unit tests, future
 * entry points) now that {@link DeployInvocation} accepts the same optional
 * shape non-AWS single-provider deploys use.
 */
export class AwsAccountRequiredError extends Error {
  constructor() {
    super("aws/cloudformation runtime requires awsAccountId and region");
    this.name = "AwsAccountRequiredError";
  }
}

/**
 * [Issue #2561] No per-team credential is registered for a non-AWS
 * single-provider problem's provider (`gcp`/`azure`/`sakura`). Thrown BEFORE
 * any DDB/SQL write or EventBridge publish (fail-closed, mirrors
 * `UnverifiedCompetitorAccountError`'s pre-mutation gate for AWS).
 */
export class NonAwsCredentialUnregisteredError extends Error {
  constructor(
    public readonly provider: string,
    public readonly teamSlug: string,
  ) {
    super(`no ${provider} credential registered for team ${teamSlug}`);
    this.name = "NonAwsCredentialUnregisteredError";
  }
}

/**
 * [Issue #2561] Fail-closed pre-mutation check that a non-AWS single-provider
 * problem's team actually has a credential registered. Keyed by
 * `(ctx.tenantId, teamSlug)` — never `teamSlug` alone — so this preserves the
 * same tenant-isolation property `resolveVerifiedCompetitorAccount` provides
 * for AWS. `ctx.ssm` is guaranteed defined here: `selectAdapter` above only
 * returns a sakura/azure/gcp adapter when `buildAdapterDependencies` saw
 * `ctx.ssm` truthy (otherwise it already threw `RuntimeNotSupportedError`).
 */
async function assertNonAwsCredentialRegistered(
  ctx: DeployContext,
  provider: string,
  teamSlug: string,
): Promise<void> {
  const deps = { ssm: ctx.ssm as NonNullable<DeployContext["ssm"]>, env: ctx.env };
  const credential =
    provider === SAKURA_PROVIDER
      ? await getSakuraCredential(deps, ctx.tenantId, teamSlug)
      : provider === AZURE_PROVIDER
        ? await getAzureCredential(deps, ctx.tenantId, teamSlug)
        : provider === GCP_PROVIDER
          ? await getGcpCredential(deps, ctx.tenantId, teamSlug)
          : undefined;
  if (!credential) throw new NonAwsCredentialUnregisteredError(provider, teamSlug);
}

/** Resolved AWS-side identifiers a successful gate check produces; empty for non-AWS. */
interface DeployAuthorization {
  readonly awsAccountId: string;
  readonly region: string;
  readonly competitorRoleArn?: string;
  readonly externalIdParameterName?: string;
}

/**
 * [Issue #2561] Runs the pre-mutation authorization gate for `runtime`'s
 * provider and returns the resolved AWS identifiers (empty strings / undefined
 * for a non-AWS single-provider deploy). Extracted out of `startDeployment` to
 * keep the provider branch — and its cognitive complexity — out of the main
 * DDB-Put/EventBridge-publish orchestration.
 */
async function resolveDeployAuthorization(
  ctx: DeployContext,
  runtime: ProblemRuntime,
  request: DeployInvocation,
  teamSlug: string,
): Promise<DeployAuthorization> {
  if (runtime.provider !== EXECUTABLE_PROVIDER) {
    await assertNonAwsCredentialRegistered(ctx, runtime.provider, teamSlug);
    return { awsAccountId: "", region: "" };
  }
  if (!request.awsAccountId || !request.region) throw new AwsAccountRequiredError();
  // Phase 2.2 (Issue #459): verified=true な行が無ければ deploy しない (= fail-closed)。
  // 同 account deploy の dev fallback も廃止 — 全 deploy は verified なれた account のみ。
  const verified = await resolveVerifiedCompetitorAccount(
    {
      runtime: ctx.runtime,
      ddb: ctx.ddb,
      competitorAccountsTableName: ctx.competitorAccountsTableName,
      env: ctx.env,
    },
    ctx.tenantId,
    request.awsAccountId,
  );
  if (!verified) throw new UnverifiedCompetitorAccountError(request.awsAccountId);
  return {
    awsAccountId: request.awsAccountId,
    region: request.region,
    competitorRoleArn: verified.competitorRoleArn,
    externalIdParameterName: verified.externalIdParameterName,
  };
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

  // [Issue #1268] Resolve runtime BEFORE any cloud mutation. Default
  // is aws/cloudformation, which keeps legacy problems and explicit AWS declarations on the
  // same path. Configured provider contexts select their exact adapters; an unknown runtime or
  // missing provider context raises `RuntimeNotSupportedError` before any DDB Put, event publish,
  // or cloud call.
  const runtime: ProblemRuntime = ctx.resolveProblemRuntime?.(request.problemId) ?? {
    provider: EXECUTABLE_PROVIDER,
    engine: EXECUTABLE_ENGINE,
    entry: "template.yaml",
  };
  // teamSlug は sakura の per-team key 解決にも使うので runtime 解決直後に確定する。
  const teamSlug = slugify(request.teamName);
  const adapter = selectAdapter(runtime, buildAdapterDependencies(ctx, runtime, teamSlug));

  // [Issue #2561] Single-provider deploys split on the resolved runtime's
  // provider BEFORE any cloud mutation, same spirit as the pre-mutation
  // runtime-adapter gate above: AWS keeps the existing verified=true
  // CompetitorAccounts gate (Phase 2.2 / Issue #459); a non-AWS provider
  // (gcp/azure/sakura) is gated on its own per-team credential store instead —
  // an AWS competitor account is not what authorizes a GCP/Azure/Sakura-only
  // deploy, so requiring one blocked every non-AWS single-provider deploy even
  // after `nonAwsRuntime` + per-team credentials were configured correctly.
  const { awsAccountId, region, competitorRoleArn, externalIdParameterName } =
    await resolveDeployAuthorization(ctx, runtime, request, teamSlug);

  // #1766 (+PR-1803 review): クォータはより具体的な検証 (unknown problem / runtime 不一致 /
  // unverified account) の後、cloud mutation (DDB Put / EventBridge publish) の直前に
  // enforce する。先頭で弾くと、本来 404/422 を返すべきリクエストまで 429 で隠れる。
  await enforceDeployQuota(
    { runtime: ctx.runtime, ddb: ctx.ddb, tableName: ctx.tableName, quota: ctx.deployQuota },
    ctx.tenantId,
    request.quotaTier ?? "basic",
  );

  const jobId = ulid();
  const teamLoginKey = generateTeamLoginKey();
  const namePrefix = buildStackPrefix(request.problemId, request.teamName);
  const nowMs = ctx.now();
  const expiresAt = toEpochSeconds(nowMs + (ctx.ttlMs ?? DEFAULT_TTL_MS));
  const createdAt = new Date(nowMs).toISOString();

  const item: Omit<DeploymentItem, "PK" | "SK" | "GSI1PK" | "GSI1SK" | "GSI2PK" | "GSI2SK"> = {
    jobId,
    problemId: request.problemId,
    tenantId: ctx.tenantId,
    // [Issue #2561] "" for a non-AWS single-provider deploy (mirrors the composite
    // parent row's exact `?? ""` precedent, `composite-deploy.ts`) — the row is
    // still keyed/tracked by jobId/teamSlug, not by an AWS account it never had.
    awsAccountId,
    ...(competitorRoleArn ? { competitorRoleArn } : {}),
    region,
    teamName: request.teamName,
    namePrefix,
    teamLoginKey,
    status: "PENDING",
    createdAt,
    updatedAt: createdAt,
    expiresAt,
    accountGroupId: request.accountGroupId,
    problemSetId: request.problemSetId,
    // [#1410-1412] 非 AWS runtime のときだけ provider/engine/entry を永続化する
    // (= teardown / status が adapter 経由で動く判別。 AWS 行は従来どおり field なしで byte-identical)。
    ...runtimeItemFields(runtime),
  };

  const deploymentsRepository: DeploymentsLifecyclePort = await resolveDeploymentsRepository(ctx);
  await deploymentsRepository.putDeployment(item);

  // private 問題 + bucket bind 済なら S3 から 15min TTL presigned URL を
  // 発行。 CodeBuild の deploy-battles.sh が CHALLENGE_PAYLOAD_URL を fetch して zip 展開する。
  const challengePayloadUrl = await resolveChallengePayloadUrl(ctx, request.problemId);

  // Issue #2019: staged enforcement gate. In the default `shadow` mode
  // this is a single env compare that returns `null` (proceed) with zero extra
  // I/O — the legacy path below is byte-for-byte unchanged. Only when the operator
  // opts in (`CLOUD_ACTION_ENFORCEMENT_MODE=enforce`) and this deploy matches the
  // gated high-risk rule (replacing a live stack) does it HOLD: it flips the row
  // PENDING → APPROVAL_PENDING and returns the held response WITHOUT dispatching
  // the adapter, so **no AssumeRole / CloudFormation runs**.
  const held = await maybeHoldDeploy({
    mode: ctx.cloudActionEnforcementMode ?? "shadow",
    runtime: ctx.runtime,
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
    // [Issue #1268 #2064] dispatch via the prepared-dispatch seam.
    // AWS / CFn keeps the same `publishProblemEvent` used by the legacy inline path; configured
    // provider adapters use this same prepared-dispatch seam without silent fallback.
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
      ...(competitorRoleArn ? { competitorRoleArn } : {}),
      ...(externalIdParameterName ? { externalIdParameterName } : {}),
      ...(challengePayloadUrl ? { challengePayloadUrl } : {}),
    });
  } catch (err) {
    try {
      // Issue #1200: FAILED terminal 化のタイミングで expiresAt を 7 日 retention に
      // refresh する (= 旧来 create 時の 8h session TTL を上書きし、 audit 履歴を 7 日残す)。
      // #872: compensation 経路に tenantId condition (= 直前 PutItem 自身が item.tenantId を
      // 書いているので transitively 一致するが、 write レベルで明示する defense-in-depth)。
      // [Issue #2441 / Phase B2] seam の `markFailedIfPending` は CCF を `conflict`
      // outcome に畳むので投げない — outer catch はそれ以外の書込失敗 (ネットワーク等)
      // だけを best-effort に握りつぶす、旧来と同じ挙動。
      await deploymentsRepository.markFailedIfPending(
        jobId,
        item.tenantId,
        "Failed to publish DeployCreateRequested event",
        new Date(ctx.now()).toISOString(),
        deploymentTerminalExpiresAt(ctx.now()),
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
  /**
   * [#2527 Slice 4] Injected control-data runtime — the Lambda entrypoint
   * (`index.ts`) creates it via `createDefaultControlDataRuntime()` once per
   * instance; every repository seam resolves through it.
   */
  readonly runtime: ControlDataRuntime;
  readonly tableName: string;
  readonly competitorAccountsTableName: string;
  readonly env: string;
  readonly eventBusName: string;
  readonly ddb: DynamoDBDocumentClient;
  readonly events: EventBridgeClient;
  readonly problemsCatalog: Readonly<Record<string, string>>;
  readonly problemsVisibility: Readonly<Record<string, PrivateVisibility>>;
  /**
   * [#2054] Per-problemId runtime resolver, baked from non-aws
   * `metadata.runtime` at synth. Returns undefined for CFn problems (→ aws
   * default); returns e.g. `docker/compose` for a container problem so the
   * deploy is rejected pre-mutation instead of half-creating an AWS artifact.
   */
  readonly resolveProblemRuntime?: (problemId: string) => ProblemRuntime | undefined;
  /**
   * [Composite Runtime / Issue #2075] Descriptor resolver (single OR composite),
   * baked from the same `BATTLE_PROBLEMS_RUNTIMES` env. Lets the route detect a
   * composite problem; absent for every single-provider problem.
   */
  readonly resolveProblemRuntimeDescriptor?: (
    problemId: string,
  ) => ProblemRuntimeDescriptor | undefined;
  readonly challengePayloadBucket: string | undefined;
  readonly s3: S3Client;
  /**
   * [Issue #2745] 問題 source (`problems/` materialized tree) を持つ bucket 名。 `s3` (上記) が同じ
   * client を読取に再利用する。 未設定 (Lite / SOURCE_BUCKET_NAME 未配線) なら public 問題の GCP
   * Terraform source 読取だけが利用不可 (= private 問題の challengePayloadUrl 経路は影響なし)。
   */
  readonly sourceBucketName: string | undefined;
  /** [#1412] per-team Sakura API key store の読取 client。 */
  readonly ssm: SSMClient;
  /** [#1412] AppRun REST base URL の override (env)。 未設定なら本番 AppRun 共用型。 */
  readonly sakuraAppRunBaseUrl: string | undefined;
  /** #1766: tier 別同時デプロイ上限 (env JSON)。 未設定 = クォータ無効 (在来 stack / Lite)。 */
  readonly deployQuota: DeployQuotaConfig | undefined;
  /**
   * Issue #2019: TrustBridge high-risk enforcement mode (env). Default
   * `"shadow"` (= unset / anything but `"enforce"`) keeps the legacy path.
   */
  readonly cloudActionEnforcementMode: CloudActionEnforcementMode;
}

export function buildSharedResources(runtime: ControlDataRuntime): DeploySharedResources {
  // ChallengePayloadStack 未 deploy なら env は空文字列で届く。 dormant 扱いに正規化。
  const challengePayloadBucket = process.env.CHALLENGE_PAYLOAD_BUCKET || undefined;
  return {
    runtime,
    // [Issue #2441 / Phase B PR-6] pure SQL backend (turso) では Deployments table 自体が
    // synth されず env も配線されないため、module-load を `getEnv` の fail-fast に委ねると
    // cold start が Initialization Error で落ちる。空文字 default に緩和し、dynamodb
    // backend の誤設定は runtime resolver (`runtime-repositories.ts`) が fail loud に受ける
    // (= silent fallback にはならない、event-handler/shared.ts と同じ緩和)。
    tableName: process.env.DEPLOYMENTS_TABLE_NAME ?? "",
    // [Issue #2442 / Phase C2] pure SQL backend (turso) では CompetitorAccounts table
    // 自体が synth されず env も配線されないため、`getEnv` の fail-fast に委ねると cold
    // start が Initialization Error で落ちる (= DeployApiLambda 全 route が壊れる)。空文字
    // default に緩和し、dynamodb backend の誤設定は runtime resolver が fail loud
    // に受ける (= silent fallback にはならない、tableName と同じ緩和)。
    competitorAccountsTableName: process.env.COMPETITOR_ACCOUNTS_TABLE_NAME ?? "",
    env: getEnv("DEPLOY_ENVIRONMENT"),
    eventBusName: getEnv("DEPLOY_EVENT_BUS_NAME"),
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    events: new EventBridgeClient({}),
    problemsCatalog: parseProblemsCatalog(process.env.BATTLE_PROBLEMS_CATALOG),
    problemsVisibility: parseProblemsVisibility(process.env.BATTLE_PROBLEMS_VISIBILITY),
    resolveProblemRuntime: makeProblemRuntimeResolver(process.env.BATTLE_PROBLEMS_RUNTIMES),
    resolveProblemRuntimeDescriptor: makeProblemRuntimeDescriptorResolver(
      process.env.BATTLE_PROBLEMS_RUNTIMES,
    ),
    challengePayloadBucket,
    s3: new S3Client({}),
    // [Issue #2745] materialized problems/ tree bucket — same env `SOURCE_BUCKET_NAME` the
    // CfnDeploy Lambda reads (create-stack.ts); empty when unset (Lite mode default) so
    // startup never fails-fast on it (mirrors the tableName / competitorAccountsTableName
    // `?? ""`-style relaxations above).
    sourceBucketName: process.env.SOURCE_BUCKET_NAME || undefined,
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
