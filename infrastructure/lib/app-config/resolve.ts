import * as fs from "node:fs";
import * as path from "node:path";
import { BillingMode } from "aws-cdk-lib/aws-dynamodb";
import * as dotenv from "dotenv";
import { getEnv } from "../helper-functions";
import type { ParticipantPortalRuntimeConfig } from "../problem-deploy/participant-portal-hosting";
import { loadConfig } from "../utils/config-loader";
import {
  discoverProblemsCatalog,
  discoverProblemsEndpoints,
  discoverProblemsPhases,
  discoverProblemsScoring,
  discoverProblemsVisibility,
} from "../utils/discover-problems-catalog";
import type {
  AdminConsoleHostingInputs,
  ApiKeySSMParameterNames,
  AppConfig,
  ProblemsCatalogBundle,
} from "./types";

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
  /** `bin/infrastructure.ts` の __dirname (= `infrastructure/bin`)。 .env / config.json の base path 解決に使う。 */
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
  const fsOps = input.fs ?? fs;
  const loadDotenv = input.dotenvConfig ?? ((opts) => void dotenv.config(opts));

  const environment = env.CDK_PARAM_ENVIRONMENT ?? "development";
  const envFilePath = path.resolve(input.binDir, `../environments/${environment}/.env`);
  if (fsOps.existsSync(envFilePath)) {
    loadDotenv({ path: envFilePath });
    console.log(`[bin] Loaded env from ${envFilePath}`);
  }

  // required env: SystemAdmin の email (= SBT が ControlPlane で作る admin user 宛)。
  const systemAdminEmail = env.CDK_PARAM_SYSTEM_ADMIN_EMAIL;
  if (!systemAdminEmail) {
    throw new Error("Please provide system admin email");
  }

  const pooledId = "pooled";
  if (!env.CDK_PARAM_TENANT_ID) {
    console.log('Tenant ID is empty, a default tenant id "pooled" will be assigned');
  }
  const tenantId = env.CDK_PARAM_TENANT_ID || pooledId;
  const isPooledDeploy = tenantId === pooledId;
  const tenantName =
    env.CDK_PARAM_TENANT_NAME || (isPooledDeploy ? "Shared Pooled Tenant" : tenantId);

  const s3SourceBucket = getEnvFromEnv(env, "CDK_PARAM_S3_BUCKET_NAME");
  const sourceZip = getEnvFromEnv(env, "CDK_SOURCE_NAME");
  const commitId = getEnvFromEnv(env, "CDK_PARAM_COMMIT_ID");

  // SBT ref-arch 互換: process.env 直読み経路がまだあるので default をここで注入する。
  if (!env.CDK_PARAM_IDP_NAME) env.CDK_PARAM_IDP_NAME = "COGNITO";
  if (!env.CDK_PARAM_SYSTEM_ADMIN_ROLE_NAME) env.CDK_PARAM_SYSTEM_ADMIN_ROLE_NAME = "SystemAdmin";

  const stageName = env.CDK_PARAM_STAGE_NAME || "prod";
  const lambdaReserveConcurrency = Number(env.CDK_PARAM_LAMBDA_RESERVE_CONCURRENCY || "1");
  const lambdaCanaryDeploymentPreference =
    env.CDK_PARAM_LAMBDA_CANARY_DEPLOYMENT_PREFERENCE || "True";

  const awsRegion = env.CDK_PARAM_AWS_REGION ?? env.CDK_DEFAULT_REGION ?? "";
  const awsAccountId = env.CDK_PARAM_AWS_ACCOUNT_ID ?? env.CDK_DEFAULT_ACCOUNT ?? "";
  const stackEnv =
    awsAccountId && awsRegion ? { env: { account: awsAccountId, region: awsRegion } } : {};

  const config = loadConfig(environment, input.binDir);
  const ddb = config?.dynamoDbConfig;
  const dynamoBillingMode =
    ddb?.billingMode === "PAY_PER_REQUEST" ? BillingMode.PAY_PER_REQUEST : BillingMode.PROVISIONED;
  const isDynamoProvisioned = dynamoBillingMode === BillingMode.PROVISIONED;
  const dynamoReadCapacity = Number(env.CDK_PARAM_DYNAMODB_READ_CAPACITY || ddb?.readCapacity || 1);
  const dynamoWriteCapacity = Number(
    env.CDK_PARAM_DYNAMODB_WRITE_CAPACITY || ddb?.writeCapacity || 1,
  );
  const kmsPendingWindowInDays = Number(
    env.CDK_PARAM_KMS_PENDING_WINDOW_DAYS || config?.kmsConfig?.pendingWindowInDays || 7,
  );

  const appNameLower = (config?.appName ?? "tenkacloud").toLowerCase();
  const namePrefix = `${appNameLower}-${environment}`;
  const isProductionLike = environment === "production" || environment === "staging";

  const apiKeySSMParameterNames: ApiKeySSMParameterNames = {
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

  const resolve = (envVar: string, tier: string): string =>
    resolveApiKeyValue({
      env,
      envVar,
      tier,
      environment,
      appNameLower,
      isProductionLike,
    });

  const apiKeyPlatinumTierParameter = resolve(
    "CDK_PARAM_API_KEY_PLATINUM_TIER_PARAMETER",
    "platinum",
  );
  const apiKeyPremiumTierParameter = resolve("CDK_PARAM_API_KEY_PREMIUM_TIER_PARAMETER", "premium");
  const apiKeyStandardTierParameter = resolve(
    "CDK_PARAM_API_KEY_STANDARD_TIER_PARAMETER",
    "standard",
  );
  const apiKeyBasicTierParameter = resolve("CDK_PARAM_API_KEY_BASIC_TIER_PARAMETER", "basic");

  const enableParticipantPortal = env.CDK_PARAM_ENABLE_PARTICIPANT_PORTAL === "true";
  const participantPortalEventTitle = env.CDK_PARAM_PARTICIPANT_PORTAL_EVENT_TITLE;
  const participantPortalRuntimeConfig: ParticipantPortalRuntimeConfig | "default-dev-mock" =
    participantPortalEventTitle
      ? {
          eventTitle: participantPortalEventTitle,
          eventRegion: awsRegion || "ap-northeast-1",
          mode: "dev-mock",
        }
      : "default-dev-mock";
  const participantPortal = enableParticipantPortal
    ? { runtimeConfig: participantPortalRuntimeConfig }
    : undefined;

  const problemsRoot = path.resolve(input.binDir, "..", "..", "problems");
  const problems =
    input.discoverProblems !== undefined
      ? input.discoverProblems(problemsRoot)
      : ({
          catalog: discoverProblemsCatalog(problemsRoot),
          scoring: discoverProblemsScoring(problemsRoot),
          endpoints: discoverProblemsEndpoints(problemsRoot),
          phases: discoverProblemsPhases(problemsRoot),
          visibility: discoverProblemsVisibility(problemsRoot),
        } satisfies ProblemsCatalogBundle);

  const challengePayloadBucketName = env.CDK_PARAM_CHALLENGE_PAYLOAD_BUCKET || undefined;

  const rawConcurrentLimit = env.CDK_PARAM_DEPLOY_CONCURRENT_BUILD_LIMIT;
  const deployConcurrentBuildLimit =
    rawConcurrentLimit && rawConcurrentLimit.trim() !== "" ? Number(rawConcurrentLimit) : undefined;
  if (deployConcurrentBuildLimit !== undefined && !Number.isInteger(deployConcurrentBuildLimit)) {
    throw new Error(
      `CDK_PARAM_DEPLOY_CONCURRENT_BUILD_LIMIT は整数で指定してください (got: ${rawConcurrentLimit})`,
    );
  }

  const adminConsoleOriginForCors = env.CDK_PARAM_ADMIN_CONSOLE_ORIGIN;
  const competitorBootstrapTemplateUrlEnv = env.CDK_PARAM_COMPETITOR_BOOTSTRAP_TEMPLATE_URL;

  const adminConsoleHostingInputs = buildHostingInputs(env);

  return {
    environment,
    isProductionLike,
    appNameLower,
    namePrefix,
    systemAdminEmail,
    tenantId,
    tenantName,
    isPooledDeploy,
    s3SourceBucket,
    sourceZip,
    commitId,
    stageName,
    lambdaReserveConcurrency,
    lambdaCanaryDeploymentPreference,
    awsAccountId,
    awsRegion,
    stackEnv,
    dynamoBillingMode,
    isDynamoProvisioned,
    dynamoReadCapacity,
    dynamoWriteCapacity,
    kmsPendingWindowInDays,
    apiKeyPlatinumTierParameter,
    apiKeyPremiumTierParameter,
    apiKeyStandardTierParameter,
    apiKeyBasicTierParameter,
    apiKeySSMParameterNames,
    enableParticipantPortal,
    participantPortal,
    problems,
    challengePayloadBucketName,
    deployConcurrentBuildLimit,
    adminConsoleOriginForCors,
    competitorBootstrapTemplateUrlEnv,
    adminConsoleHostingInputs,
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

function buildHostingInputs(env: NodeJS.ProcessEnv): AdminConsoleHostingInputs | undefined {
  const apiUrl = env.CDK_PARAM_CONTROL_PLANE_API_URL;
  const cognitoDomain = env.CDK_PARAM_CONTROL_PLANE_COGNITO_DOMAIN;
  const userClientId = env.CDK_PARAM_CONTROL_PLANE_USER_CLIENT_ID;
  if (!apiUrl || !cognitoDomain || !userClientId) return undefined;
  return {
    apiUrl,
    cognitoDomain,
    userClientId,
    pooledApplicationAdminConsoleUrl: env.CDK_PARAM_POOLED_APP_CONSOLE_URL ?? "",
    provisioningCodeBuildProject: env.CDK_PARAM_PROVISIONING_CODEBUILD_PROJECT ?? "unknown",
    adminInsightApiUrl: env.CDK_PARAM_ADMIN_INSIGHT_API_URL ?? "",
  };
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
