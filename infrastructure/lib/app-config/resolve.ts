import * as fs from "node:fs";
import * as path from "node:path";
import { BillingMode } from "aws-cdk-lib/aws-dynamodb";
import * as dotenv from "dotenv";
import { parseAdminAllowlist } from "../control-plane/saml-admin-allowlist.js";
import { parseSamlIdpConfig } from "../control-plane/saml-identity-providers.js";
import { getEnv } from "../helper-functions.js";
import type { ParticipantPortalRuntimeConfig } from "../problem-deploy/participant-portal-hosting.js";
import { parseTenantAdminAllowlist } from "../tenant-template/saml-admin-allowlist.js";
import { parseTenantSamlIdpConfig } from "../tenant-template/saml-identity-providers.js";
import { loadConfig } from "../utils/config-loader.js";
import {
  discoverProblemsCatalog,
  discoverProblemsDisruptions,
  discoverProblemsEndpoints,
  discoverProblemsPhases,
  discoverProblemsScoring,
  discoverProblemsVisibility,
} from "../utils/discover-problems-catalog.js";
import type { ApiKeySSMParameterNames, AppConfig, ProblemsCatalogBundle } from "./types.js";

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
    challengePayloadBucketName,
    challengePayload,
    deployConcurrentBuildLimit,
    controlPlaneSamlIdps,
    controlPlaneSamlAdminAllowlist,
    tenantSamlIdps,
    tenantSamlAdminAllowlist,
    ...budget,
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
    kmsPendingWindowInDays: Number(
      env.CDK_PARAM_KMS_PENDING_WINDOW_DAYS || config?.kmsConfig?.pendingWindowInDays || 7,
    ),
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
  if (input.discoverProblems) return input.discoverProblems(problemsRoot);
  return {
    catalog: discoverProblemsCatalog(problemsRoot),
    scoring: discoverProblemsScoring(problemsRoot),
    endpoints: discoverProblemsEndpoints(problemsRoot),
    phases: discoverProblemsPhases(problemsRoot),
    visibility: discoverProblemsVisibility(problemsRoot),
    disruptions: discoverProblemsDisruptions(problemsRoot),
  };
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
