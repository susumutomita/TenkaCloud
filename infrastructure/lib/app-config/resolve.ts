import * as fs from "node:fs";
import * as path from "node:path";
import { BillingMode } from "aws-cdk-lib/aws-dynamodb";
import * as dotenv from "dotenv";
import { parseAdminAllowlist } from "../control-plane/saml-admin-allowlist.js";
import { parseSamlIdpConfig } from "../control-plane/saml-identity-providers.js";
import { getEnv } from "../helper-functions.js";
import { parseDeployAllowedCidrs } from "../problem-deploy/deploy-allowed-cidrs.js";
import { parseDeployQuota } from "../problem-deploy/handlers/deploy-handler/deploy-quota.js";
import type { ParticipantPortalRuntimeConfig } from "../problem-deploy/participant-portal-hosting.js";
import { type CatalogSource, LocalCatalogSource } from "../problem-pack/catalog-source.js";
import type { EffectiveCatalogProvenance } from "../problem-pack/effective-catalog.js";
import { parseTenantAdminAllowlist } from "../tenant-template/saml-admin-allowlist.js";
import { parseTenantSamlIdpConfig } from "../tenant-template/saml-identity-providers.js";
import { loadConfig } from "../utils/config-loader.js";
import type {
  ApiKeySSMParameterNames,
  AppConfig,
  ControlDataBackend,
  PackAsset,
  ProblemsCatalogBundle,
} from "./types.js";

/**
 * Issue #766: bin/infrastructure.ts に散在していた env / config 解決を 1 つの pure function
 * に集約する。 副作用は次の 3 つだけ:
 *
 *   1. `.env` ファイルの読み込み (= dotenv 経由で `process.env` に注入)
 *   2. `process.env.CDK_PARAM_IDP_NAME` / `CDK_PARAM_SYSTEM_ADMIN_ROLE_NAME` の default 注入
 *      (= 既存 SBT ref-arch の互換上、 process.env 経由で参照される場合があるため)
 *   3. `discoverProblems*` 経由の filesystem 読み (= `problems/` ディレクトリの metadata)
 *
 * これら以外は input (= `process.env` + repo paths) から output (= `AppConfig`) への純関数。
 * stack 配線層 (= `lib/app-wiring`) は `AppConfig` だけを参照し、 process.env を直読みしない。
 */
export interface ResolveAppConfigInput {
  readonly env: NodeJS.ProcessEnv;
  /** `bin/infrastructure.ts` の import.meta.dirname (= `infrastructure/bin`)。 .env / config.json の base path 解決に使う。 */
  readonly binDir: string;
  /**
   * テストから filesystem 読みを差し替えるための optional hook。 既定では実 dotenv / fs。
   */
  readonly fs?: Pick<typeof fs, "existsSync">;
  readonly dotenvConfig?: (opts: { path: string }) => void;
  /** テストから problems discovery を差し替える hook。 既定では実 discover*。 */
  readonly discoverProblems?: (problemsRoot: string) => ProblemsCatalogBundle;
  /**
   * [#2092] catalog の取得元 (= source abstraction)。 既定は {@link LocalCatalogSource}
   * (= local `problems/` tree、 従来挙動と byte-identical)。 snapshot adapter は dormant
   * のまま追加されており、 ここに差し替えても remote fetch は発生しない。
   */
  readonly catalogSource?: CatalogSource;
  /**
   * [#2462] Installed + active pack revisions to materialize at synth time. Built from the SAME
   * local activation store as {@link catalogSource} by `bin/tenkacloud-lite.ts`, so the asset set
   * and the pack catalog keys stay consistent. Passed straight through to
   * {@link AppConfig.packAssets}; undefined on the default / SaaS path (= no materialization).
   */
  readonly packAssets?: readonly PackAsset[];
}

export function resolveAppConfig(input: ResolveAppConfigInput): AppConfig {
  const env = input.env;
  const environment = loadEnvironment(input);
  const systemAdminEmail = requireSystemAdminEmail(env);
  const tenant = resolveTenant(env);
  const s3SourceBucket = getEnvFromEnv(env, "CDK_PARAM_S3_BUCKET_NAME");
  const sourceZip = getEnvFromEnv(env, "CDK_SOURCE_NAME");
  const commitId = getEnvFromEnv(env, "CDK_PARAM_COMMIT_ID");
  injectSbtDefaults(env);
  const stageName = env.CDK_PARAM_STAGE_NAME || "prod";
  const lambdaReserveConcurrency = Number(env.CDK_PARAM_LAMBDA_RESERVE_CONCURRENCY || "1");
  const lambdaCanaryDeploymentPreference =
    env.CDK_PARAM_LAMBDA_CANARY_DEPLOYMENT_PREFERENCE || "True";
  const aws = resolveAwsEnvironment(env);
  const config = loadConfig(environment, input.binDir);
  const dynamo = resolveDynamoConfig(env, config);
  const naming = resolveAppNaming(config, environment);
  const apiKeys = resolveApiKeys(env, naming, environment);
  const participantPortal = resolveParticipantPortal(env, aws.awsRegion);
  const problems = discoverAppProblems(input);
  const challengePayloadBucketName = env.CDK_PARAM_CHALLENGE_PAYLOAD_BUCKET || undefined;
  const challengePayload = resolveChallengePayload(env, config, environment);
  const deployConcurrentBuildLimit = resolveDeployConcurrentBuildLimit(env);
  const deployAllowedCidrs = parseDeployAllowedCidrs(env.CDK_PARAM_DEPLOY_ALLOWED_CIDRS);
  const deployQuotaByTier = resolveDeployQuotaByTier(env);
  // Issue #2232: previously wired end-to-end (stack prop → Lambda env →
  // handler → DistributedMap state machine) with no way to set it true in
  // production — the DistributedMap branch was permanently unreachable
  // outside tests. Default false preserves the existing legacy fan-out.
  const useBulkDistributedMap = env.CDK_PARAM_BULK_DEPLOY_VIA_DISTRIBUTED_MAP === "true";
  // Issue #2291: DeployCreate を Lambda CreateStack + poll 経路にするか。default true (未設定 /
  // "false" 以外は Lambda 経路 = problem-deploy CodeBuild を生成しない新既定で、`make deploy` が
  // Lambda 経路で live-test 可能になる)。明示 "false" のときだけ在来 CodeBuild 経路へ rollback する
  // (= CFn テンプレ byte 互換の legacy path を復元する reversible な逃げ道)。
  const deployViaLambda = env.CDK_PARAM_DEPLOY_VIA_LAMBDA !== "false";
  // Issue #2311: 監査ログ出力の on/off。default true (未設定 / "true" は従来どおり出力 →
  // リグレッションなし)。明示 "false" のときだけ監査 Lambda 群を no-op 化する。
  const auditLogEnabled = env.CDK_PARAM_AUDIT_LOG_ENABLED !== "false";
  // Issue #2290: control-plane data backend の選択。default "dynamodb" (未設定 / "dynamodb" は
  // 在来 DDB 経路で Lambda env を足さない = byte 互換)。dynamodb/turso 以外は synth 時に throw。
  const controlDataBackend = resolveControlDataBackend(env);
  const tursoDatabaseUrl = env.CDK_PARAM_TURSO_DATABASE_URL?.trim() || undefined;
  const tursoAuthTokenParameterName =
    env.CDK_PARAM_TURSO_AUTH_TOKEN_PARAMETER_NAME?.trim() || undefined;
  if (controlDataBackend !== "dynamodb" && (!tursoDatabaseUrl || !tursoAuthTokenParameterName)) {
    throw new Error(
      "CDK_PARAM_TURSO_DATABASE_URL and CDK_PARAM_TURSO_AUTH_TOKEN_PARAMETER_NAME " +
        "are required when CDK_PARAM_CONTROL_DATA_BACKEND is turso.",
    );
  }
  const features = resolveFeatures(env);

  // Issue #1031: 旧 `CDK_PARAM_ADMIN_CONSOLE_ORIGIN` env 直読みは廃止。 admin-console-hosting
  // が先に立ち、 cross-stack ref で control-plane / admin-console-insight に流れる。
  // Issue #1053: 旧 `CDK_PARAM_COMPETITOR_BOOTSTRAP_TEMPLATE_URL` も同じく cross-stack ref へ。

  // Issue #839 follow-up: SAML IdP 設定を config.json から取り出す (= 未設定なら undefined)。
  // tenant-stack 側 (= application-admin-console / pooled tenant + per-tenant silo + Lite) と
  // control-plane 側 (= admin-console / SBT ControlPlane) で独立して enable できる。
  // Issue #1066: SAML IdP 関連 (tenantSamlConfig / controlPlaneConfig.samlIdp) は廃止済。

  // Issue #952 epic / cost guardrails
  // schema (config-schema.json) は integer / 数値文字列 ("50") の双方を許容するため、
  // ここでも `${MONTHLY_COST_LIMIT_USD:-50}` 経由で来た文字列を Number で正規化する。
  const budget = resolveBudgetConfig(config);
  const opsMonitoring = resolveOpsMonitoringConfig(env, config);

  // Issue #1335 Phase 1: Control Plane SAML opt-in env を parse (= 未設定なら空配列)。
  // 不正な JSON / 形式は parseSamlIdpConfig / parseAdminAllowlist が throw する (fail-loud)。
  const controlPlaneSamlIdps = parseSamlIdpConfig(env.CONTROL_PLANE_SAML_IDPS);
  const controlPlaneSamlAdminAllowlist = parseAdminAllowlist(
    env.CONTROL_PLANE_SAML_ADMIN_ALLOWLIST,
  );

  // Issue #1340 Phase 2: per-tenant Application Plane SAML opt-in env を parse (= 未設定なら
  // 空配列、 既存 pooled / silo / Lite mode の CFn 物理差分は 0 件)。 Phase 1 と同じ
  // parser を `TENANT_SAML_IDPS` / `TENANT_SAML_ADMIN_ALLOWLIST` env で呼び出す。
  const tenantSamlIdps = parseTenantSamlIdpConfig(env.TENANT_SAML_IDPS);
  const tenantSamlAdminAllowlist = parseTenantAdminAllowlist(env.TENANT_SAML_ADMIN_ALLOWLIST);

  return {
    environment,
    ...naming,
    systemAdminEmail,
    ...tenant,
    s3SourceBucket,
    sourceZip,
    commitId,
    stageName,
    lambdaReserveConcurrency,
    lambdaCanaryDeploymentPreference,
    ...aws,
    ...dynamo,
    ...apiKeys,
    ...participantPortal,
    problems,
    // [#2462] Pass the Lite activation store's pack assets straight through. Absent (default /
    // SaaS) → the `packAssets` key is omitted entirely, keeping the AppConfig shape byte-identical.
    ...(input.packAssets && input.packAssets.length > 0 ? { packAssets: input.packAssets } : {}),
    challengePayloadBucketName,
    challengePayload,
    // Issue #1695: config.json の customDomains を AppConfig にそのまま透過 (opt-in TLS 1.2)。
    customDomains: config?.customDomains,
    deployConcurrentBuildLimit,
    deployAllowedCidrs,
    deployQuotaByTier,
    useBulkDistributedMap,
    deployViaLambda,
    auditLogEnabled,
    controlDataBackend,
    tursoDatabaseUrl,
    tursoAuthTokenParameterName,
    features,
    controlPlaneSamlIdps,
    controlPlaneSamlAdminAllowlist,
    tenantSamlIdps,
    tenantSamlAdminAllowlist,
    ...budget,
    ...opsMonitoring,
  };
}

type LoadedConfig = ReturnType<typeof loadConfig>;

function loadEnvironment(input: ResolveAppConfigInput): string {
  const environment = input.env.CDK_PARAM_ENVIRONMENT ?? "development";
  const envFilePath = path.resolve(input.binDir, `../environments/${environment}/.env`);
  if ((input.fs ?? fs).existsSync(envFilePath)) {
    (input.dotenvConfig ?? ((opts) => void dotenv.config(opts)))({ path: envFilePath });
    console.log(`[bin] Loaded env from ${envFilePath}`);
  }
  return environment;
}

function requireSystemAdminEmail(env: NodeJS.ProcessEnv): string {
  const systemAdminEmail = env.CDK_PARAM_SYSTEM_ADMIN_EMAIL;
  if (!systemAdminEmail) throw new Error("Please provide system admin email");
  return systemAdminEmail;
}

function resolveTenant(
  env: NodeJS.ProcessEnv,
): Pick<AppConfig, "tenantId" | "tenantName" | "isPooledDeploy"> {
  const pooledId = "pooled";
  if (!env.CDK_PARAM_TENANT_ID) {
    console.log('Tenant ID is empty, a default tenant id "pooled" will be assigned');
  }
  const tenantId = env.CDK_PARAM_TENANT_ID || pooledId;
  const isPooledDeploy = tenantId === pooledId;
  return {
    tenantId,
    isPooledDeploy,
    tenantName: env.CDK_PARAM_TENANT_NAME || (isPooledDeploy ? "Shared Pooled Tenant" : tenantId),
  };
}

function injectSbtDefaults(env: NodeJS.ProcessEnv): void {
  if (!env.CDK_PARAM_IDP_NAME) env.CDK_PARAM_IDP_NAME = "COGNITO";
  if (!env.CDK_PARAM_SYSTEM_ADMIN_ROLE_NAME) env.CDK_PARAM_SYSTEM_ADMIN_ROLE_NAME = "SystemAdmin";
}

function resolveAwsEnvironment(
  env: NodeJS.ProcessEnv,
): Pick<AppConfig, "awsRegion" | "awsAccountId" | "stackEnv"> {
  const awsRegion = env.CDK_PARAM_AWS_REGION ?? env.CDK_DEFAULT_REGION ?? "";
  const awsAccountId = env.CDK_PARAM_AWS_ACCOUNT_ID ?? env.CDK_DEFAULT_ACCOUNT ?? "";
  return {
    awsRegion,
    awsAccountId,
    stackEnv:
      awsAccountId && awsRegion ? { env: { account: awsAccountId, region: awsRegion } } : {},
  };
}

function resolveDynamoConfig(
  env: NodeJS.ProcessEnv,
  config: LoadedConfig,
): Pick<
  AppConfig,
  | "dynamoBillingMode"
  | "isDynamoProvisioned"
  | "dynamoReadCapacity"
  | "dynamoWriteCapacity"
  | "kmsPendingWindowInDays"
> {
  const ddb = config?.dynamoDbConfig;
  const dynamoBillingMode =
    ddb?.billingMode === "PAY_PER_REQUEST" ? BillingMode.PAY_PER_REQUEST : BillingMode.PROVISIONED;
  return {
    dynamoBillingMode,
    isDynamoProvisioned: dynamoBillingMode === BillingMode.PROVISIONED,
    dynamoReadCapacity: Number(env.CDK_PARAM_DYNAMODB_READ_CAPACITY || ddb?.readCapacity || 1),
    dynamoWriteCapacity: Number(env.CDK_PARAM_DYNAMODB_WRITE_CAPACITY || ddb?.writeCapacity || 1),
    kmsPendingWindowInDays: Number(env.CDK_PARAM_KMS_PENDING_WINDOW_DAYS || 7),
  };
}

function resolveAppNaming(
  config: LoadedConfig,
  environment: string,
): Pick<AppConfig, "appNameLower" | "namePrefix" | "isProductionLike"> {
  const appNameLower = (config?.appName ?? "tenkacloud").toLowerCase();
  return {
    appNameLower,
    namePrefix: `${appNameLower}-${environment}`,
    isProductionLike: environment === "production" || environment === "staging",
  };
}

function resolveApiKeys(
  env: NodeJS.ProcessEnv,
  naming: Pick<AppConfig, "appNameLower" | "namePrefix" | "isProductionLike">,
  environment: string,
): Pick<
  AppConfig,
  | "apiKeyPlatinumTierParameter"
  | "apiKeyPremiumTierParameter"
  | "apiKeyStandardTierParameter"
  | "apiKeyBasicTierParameter"
  | "apiKeySSMParameterNames"
> {
  const resolve = (envVar: string, tier: string): string =>
    resolveApiKeyValue({ env, envVar, tier, environment, ...naming });
  return {
    apiKeyPlatinumTierParameter: resolve("CDK_PARAM_API_KEY_PLATINUM_TIER_PARAMETER", "platinum"),
    apiKeyPremiumTierParameter: resolve("CDK_PARAM_API_KEY_PREMIUM_TIER_PARAMETER", "premium"),
    apiKeyStandardTierParameter: resolve("CDK_PARAM_API_KEY_STANDARD_TIER_PARAMETER", "standard"),
    apiKeyBasicTierParameter: resolve("CDK_PARAM_API_KEY_BASIC_TIER_PARAMETER", "basic"),
    apiKeySSMParameterNames: buildApiKeyParameterNames(naming.namePrefix),
  };
}

function buildApiKeyParameterNames(namePrefix: string): ApiKeySSMParameterNames {
  return {
    basic: {
      keyId: `${namePrefix}-apiKeyBasicTierKeyId`,
      value: `${namePrefix}-apiKeyBasicTierValue`,
    },
    standard: {
      keyId: `${namePrefix}-apiKeyStandardTierKeyId`,
      value: `${namePrefix}-apiKeyStandardTierValue`,
    },
    premium: {
      keyId: `${namePrefix}-apiKeyPremiumTierKeyId`,
      value: `${namePrefix}-apiKeyPremiumTierValue`,
    },
    platinum: {
      keyId: `${namePrefix}-apiKeyPlatinumTierKeyId`,
      value: `${namePrefix}-apiKeyPlatinumTierValue`,
    },
  };
}

function resolveParticipantPortal(
  env: NodeJS.ProcessEnv,
  awsRegion: string,
): Pick<AppConfig, "enableParticipantPortal" | "participantPortal"> {
  const enableParticipantPortal = env.CDK_PARAM_ENABLE_PARTICIPANT_PORTAL === "true";
  const title = env.CDK_PARAM_PARTICIPANT_PORTAL_EVENT_TITLE;
  const runtimeConfig: ParticipantPortalRuntimeConfig | "default-dev-mock" = title
    ? { eventTitle: title, eventRegion: awsRegion || "ap-northeast-1", mode: "dev-mock" }
    : "default-dev-mock";
  return {
    enableParticipantPortal,
    participantPortal: enableParticipantPortal ? { runtimeConfig } : undefined,
  };
}

function discoverAppProblems(input: ResolveAppConfigInput): ProblemsCatalogBundle {
  const problemsRoot = path.resolve(input.binDir, "..", "..", "problems");
  if (input.discoverProblems)
    return withPackOnlyProvenance(input.discoverProblems(problemsRoot), {});
  // [#2092] Backend deploy paths consume ONE effective catalog through the source
  // abstraction. The default {@link LocalCatalogSource} preserves the exact current
  // synth-time behavior (byte-identical), so this is a CFn NO-OP. Lite mode can
  // pass a SnapshotCatalogSource from `bin/tenkacloud-lite.ts` when a local
  // activation store exists; SaaS pooled remains unwired.
  const source = input.catalogSource ?? new LocalCatalogSource();
  return withPackOnlyProvenance(
    source.loadBundle(problemsRoot),
    source.describeProvenance(problemsRoot),
  );
}

function withPackOnlyProvenance(
  bundle: ProblemsCatalogBundle,
  provenance: Readonly<Record<string, EffectiveCatalogProvenance>>,
): ProblemsCatalogBundle {
  const packOnly: Record<string, EffectiveCatalogProvenance> = {};
  for (const [problemId, entry] of Object.entries(provenance)) {
    if (entry.source === "pack") packOnly[problemId] = entry;
  }
  return { ...bundle, provenance: packOnly };
}

function resolveChallengePayload(
  env: NodeJS.ProcessEnv,
  config: LoadedConfig,
  environment: string,
): AppConfig["challengePayload"] {
  const challenge = config?.challengePayloadConfig;
  if (!challenge) return undefined;
  return {
    bucketName: `${String(challenge.bucketPrefix)}${environment}`,
    githubRepository: String(challenge.githubRepository),
    githubBranches:
      Array.isArray(challenge.githubBranches) && challenge.githubBranches.length > 0
        ? (challenge.githubBranches as readonly string[])
        : (["main"] as const),
    existingOidcProviderArn:
      typeof challenge.existingOidcProviderArn === "string" &&
      challenge.existingOidcProviderArn !== ""
        ? challenge.existingOidcProviderArn
        : env.CDK_PARAM_GITHUB_OIDC_PROVIDER_ARN || undefined,
    noncurrentExpirationDays:
      challenge.noncurrentExpirationDays !== undefined &&
      challenge.noncurrentExpirationDays !== null
        ? Number(challenge.noncurrentExpirationDays)
        : undefined,
  };
}

function resolveDeployConcurrentBuildLimit(env: NodeJS.ProcessEnv): number | undefined {
  const raw = env.CDK_PARAM_DEPLOY_CONCURRENT_BUILD_LIMIT;
  const limit = raw && raw.trim() !== "" ? Number(raw) : undefined;
  if (limit !== undefined && !Number.isInteger(limit)) {
    throw new Error(
      `CDK_PARAM_DEPLOY_CONCURRENT_BUILD_LIMIT は整数で指定してください (got: ${raw})`,
    );
  }
  return limit;
}

/**
 * Issue #2290 (ADR-049 §5.1): control-plane data backend の選択フラグ
 * (`CDK_PARAM_CONTROL_DATA_BACKEND`) を synth 時に検証する。control-data repository seam を
 * `dynamodb` / `turso` の二択から選ぶ (#2677 で `sql` alias と `*-mirror` bridge を削除)。
 * **default `"dynamodb"`** (未設定 / 空文字は在来 DDB 経路で、
 * `controlDataBackendEnv` が Lambda env を足さない = CFn テンプレ byte 互換)。大文字小文字は無視して
 * lowercase 正規化し、2 値以外は throw する (= runtime factory の guard と揃えた fail-loud、
 * 壊れた値を Lambda まで持ち越さない / no-silent-fallback)。
 */
function resolveControlDataBackend(env: NodeJS.ProcessEnv): ControlDataBackend {
  const raw = env.CDK_PARAM_CONTROL_DATA_BACKEND;
  if (raw === undefined || raw.trim() === "") return "dynamodb";
  const normalized = raw.trim().toLowerCase();
  if (normalized === "dynamodb" || normalized === "turso") {
    return normalized;
  }
  throw new Error(`CDK_PARAM_CONTROL_DATA_BACKEND must be one of dynamodb|turso, got: ${raw}`);
}

/**
 * #1766: tier 別の同時デプロイ上限。`CDK_PARAM_DEPLOY_QUOTA_BY_TIER` (JSON) を synth 時に
 * 検証する (= 壊れた値を Lambda runtime まで持ち越さない)。format の正本は handler 側の
 * `parseDeployQuota` と共有する。未設定はクォータ無効 (undefined)。
 */
function resolveDeployQuotaByTier(env: NodeJS.ProcessEnv) {
  return parseDeployQuota(env.CDK_PARAM_DEPLOY_QUOTA_BY_TIER);
}

/**
 * Issue #2230 (ADR-035): `CDK_PARAM_FEATURES` (JSON) を synth 時に検証して SPA feature flag
 * の deploy 時 override にする。壊れた値を runtime-config.json まで持ち越さないため、
 * JSON でない / object でない / boolean 以外の値はここで fail loudly する
 * (= SPA 側 `resolveFeatureFlags` は tolerant だが、deploy 入力の誤りは synth で止める)。
 * 未設定は undefined (= runtime-config に `features` key を書かない)。
 */
/**
 * Issue #2948 / ADR-0005: machine (M2M) token 経路の deploy 時 opt-in flag key。
 *
 * 既存の `CDK_PARAM_FEATURES` 機構に相乗りする (= 新しい env / 新しい仕組みを足さない)。
 * ON にするのは `CDK_PARAM_FEATURES='{"machineTokenPath":true}'`。
 * **default は OFF** で、key 自体が無いときの CFn テンプレは旧版と byte 互換である。
 */
export const MACHINE_TOKEN_PATH_FEATURE_KEY = "machineTokenPath";

/**
 * `features.machineTokenPath` を読む唯一の accessor。未設定 / false は OFF。
 *
 * OFF のとき capability resource server が存在しないため Cognito が `tenkacloud/*` scope を
 * 発行できず、handler 側の machine 分岐は到達不能になる (= 「設定が空だから安全」ではなく
 * 「発行できないから安全」)。
 */
export function isMachineTokenPathEnabled(
  features: Readonly<Record<string, boolean>> | undefined,
): boolean {
  return features?.[MACHINE_TOKEN_PATH_FEATURE_KEY] === true;
}

/**
 * Issue #2953: human TenantAPI authorizer で access token を弾く opt-in flag key。
 *
 * **default OFF**。稼働中の authorizer の UPDATE であり、読み違えていれば全 tenant の console が
 * 401 になる。#2948 の `TenantMachine` role により緊急性は無くなっているので、非本番 stage の
 * live pre-flight (ID token 200 / access token 401) を済ませてから立てる。
 */
export const HUMAN_AUTHORIZER_REJECTS_ACCESS_TOKENS_FEATURE_KEY =
  "humanAuthorizerRejectsAccessTokens";

/** `features.humanAuthorizerRejectsAccessTokens` を読む唯一の accessor。未設定 / false は OFF。 */
export function isHumanAuthorizerAudiencePinEnabled(
  features: Readonly<Record<string, boolean>> | undefined,
): boolean {
  return features?.[HUMAN_AUTHORIZER_REJECTS_ACCESS_TOKENS_FEATURE_KEY] === true;
}

export function resolveFeatures(
  env: NodeJS.ProcessEnv,
): Readonly<Record<string, boolean>> | undefined {
  const raw = env.CDK_PARAM_FEATURES;
  if (raw === undefined || raw.trim() === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`CDK_PARAM_FEATURES は JSON object で指定してください (got: ${raw})`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`CDK_PARAM_FEATURES は JSON object で指定してください (got: ${raw})`);
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "boolean") {
      throw new Error(
        `CDK_PARAM_FEATURES の "${key}" は boolean で指定してください (got: ${JSON.stringify(value)})`,
      );
    }
  }
  return parsed as Readonly<Record<string, boolean>>;
}

function resolveBudgetConfig(
  config: LoadedConfig,
): Pick<AppConfig, "monthlyCostLimitUsd" | "budgetAlarmEmails"> {
  const raw = config?.monthlyCostLimitUsd;
  const parsed = raw !== undefined && raw !== null ? Number(raw) : Number.NaN;
  return {
    monthlyCostLimitUsd: Number.isFinite(parsed) && parsed > 0 ? parsed : undefined,
    budgetAlarmEmails:
      Array.isArray(config?.budgetAlarmEmails) && config.budgetAlarmEmails.length > 0
        ? config.budgetAlarmEmails
        : undefined,
  };
}

function resolveOpsMonitoringConfig(
  env: NodeJS.ProcessEnv,
  config: LoadedConfig,
): Pick<AppConfig, "opsMonitoring"> {
  const alertEmail = env.CDK_PARAM_OPS_ALERT_EMAIL?.trim();
  if (!alertEmail) return { opsMonitoring: undefined };

  const monthlyCostLimitUsd = parsePositiveNumber(
    env.CDK_PARAM_OPS_MONTHLY_COST_LIMIT_USD ??
      config?.opsMonitoringConfig?.monthlyCostLimitUsd ??
      10,
    "CDK_PARAM_OPS_MONTHLY_COST_LIMIT_USD",
  );
  const budgetThresholdPercent = parsePositiveNumber(
    env.CDK_PARAM_OPS_BUDGET_THRESHOLD_PERCENT ??
      config?.opsMonitoringConfig?.budgetThresholdPercent ??
      100,
    "CDK_PARAM_OPS_BUDGET_THRESHOLD_PERCENT",
    100,
  );

  return {
    opsMonitoring: {
      alertEmail,
      monthlyCostLimitUsd,
      budgetThresholdPercent,
    },
  };
}

function parsePositiveNumber(raw: number | string, label: string, max?: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || (max !== undefined && parsed > max)) {
    const suffix = max === undefined ? "" : ` and <= ${max}`;
    throw new Error(`${label} must be a positive number${suffix} (got: ${raw})`);
  }
  return parsed;
}

interface ResolveApiKeyValueArgs {
  readonly env: NodeJS.ProcessEnv;
  readonly envVar: string;
  readonly tier: string;
  readonly environment: string;
  readonly appNameLower: string;
  readonly isProductionLike: boolean;
}

/**
 * production / staging では API Key VALUE を env 必須にし、 dev では deterministic default
 * を返す。 deterministic default は `<appName>-<env>-<tier>-tier-key-default-do-not-share` で
 * 同 deploy を idempotent に保つ (= 旧 SBT ref-arch hardcoded UUID で `AlreadyExists` していた
 * 問題 #523 を継続的に避ける)。
 */
export function resolveApiKeyValue(args: ResolveApiKeyValueArgs): string {
  const fromEnv = args.env[args.envVar];
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  if (args.isProductionLike) {
    throw new Error(
      `${args.envVar} が ${args.environment} 環境で未設定です。 SSM SecureString 等で安全な値を生成して ` +
        `infrastructure/environments/${args.environment}/.env に設定してください (= deterministic default は dev 限定)。`,
    );
  }
  return `${args.appNameLower}-${args.environment}-${args.tier}-tier-key-default-do-not-share`.toLowerCase();
}

/**
 * `getEnv` (helper-functions) が process.env 直読みなので、 ここでは env オブジェクトを
 * 受け取って同じ semantics で値を返す薄い wrapper。 (= unit test から差し替え可能)
 */
function getEnvFromEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value === "") {
    // helper-functions.getEnv に揃える: 副作用の throw メッセージ も同 format で。
    return getEnv(name);
  }
  return value;
}
