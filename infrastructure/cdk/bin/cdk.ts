#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import * as dotenv from "dotenv";
import { type Logger, createLogger, format, transports } from "winston";
import { AdminApiStack } from "../lib/admin-api-stack";
import { AdminConsoleHostingStack } from "../lib/admin-console-hosting";
import { BootstrapTemplateStack } from "../lib/bootstrap-template/bootstrap-template-stack";
import { DestroyPolicySetter } from "../lib/cdk-aspect/destroy-policy-setter";
import { ControlPlaneStack } from "../lib/control-plane-stack";
import { ProblemDeployPipelineStack } from "../lib/problem-deploy-pipeline";
import { getEnv } from "../lib/helper-functions";
import { ServerlessSaaSPipeline } from "../lib/tenant-pipeline/serverless-saas-pipeline";
import { TenantTemplateStack } from "../lib/tenant-template/tenant-template-stack";

const logger: Logger = createLogger({
  level: "info",
  format: format.combine(
    format.colorize(),
    format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    format.printf(({ timestamp, level, message }) => `[${timestamp}] ${level}: ${message}`),
  ),
  transports: [new transports.Console()],
});

// TenkaCloud の env 読み込み。`server/environments/<env>/.env` がある場合だけ load。
// install.sh が直接 export してくる CDK_PARAM_* は既に process.env にあり上書き不要。
const environment = process.env.CDK_PARAM_ENVIRONMENT ?? "development";
const envFilePath = path.resolve(__dirname, `../environments/${environment}/.env`);
if (fs.existsSync(envFilePath)) {
  dotenv.config({ path: envFilePath });
  logger.info(`Loaded env from ${envFilePath}`);
} else {
  logger.warn(`.env file not found at ${envFilePath}; using process.env only`);
}

const app = new cdk.App();

// required input parameters
if (!process.env.CDK_PARAM_SYSTEM_ADMIN_EMAIL) {
  throw new Error("Please provide system admin email via CDK_PARAM_SYSTEM_ADMIN_EMAIL");
}

if (!process.env.CDK_PARAM_TENANT_ID) {
  logger.info('Tenant ID is empty, a default tenant id "pooled" will be assigned');
}

const pooledId = "pooled";

const systemAdminEmail = process.env.CDK_PARAM_SYSTEM_ADMIN_EMAIL;
const tenantId = process.env.CDK_PARAM_TENANT_ID || pooledId;
const s3SourceBucket = getEnv("CDK_PARAM_S3_BUCKET_NAME");
const sourceZip = getEnv("CDK_SOURCE_NAME");
const commitId = getEnv("CDK_PARAM_COMMIT_ID");

if (!process.env.CDK_PARAM_IDP_NAME) {
  process.env.CDK_PARAM_IDP_NAME = "COGNITO";
}
if (!process.env.CDK_PARAM_SYSTEM_ADMIN_ROLE_NAME) {
  process.env.CDK_PARAM_SYSTEM_ADMIN_ROLE_NAME = "SystemAdmin";
}

// default values for optional input parameters
const defaultStageName = "prod";
const defaultLambdaReserveConcurrency = "1";
const defaultLambdaCanaryDeploymentPreference = "True";
const defaultApiKeyPlatinumTierParameter = "88b43c36-802e-11eb-af35-38f9d35b2c15-test2";
const defaultApiKeyPremiumTierParameter = "6db2bdc2-6d96-11eb-a56f-38f9d33cfd0f-test2";
const defaultApiKeyStandardTierParameter = "b1c735d8-6d96-11eb-a28b-38f9d33cfd0f-test2";
const defaultApiKeyBasicTierParameter = "daae9784-6d96-11eb-a28b-38f9d33cfd0f-test2";

// optional input parameters
const stageName = process.env.CDK_PARAM_STAGE_NAME || defaultStageName;
const lambdaReserveConcurrency = Number(
  process.env.CDK_PARAM_LAMBDA_RESERVE_CONCURRENCY || defaultLambdaReserveConcurrency,
);
const lambdaCanaryDeploymentPreference =
  process.env.CDK_PARAM_LAMBDA_CANARY_DEPLOYMENT_PREFERENCE || defaultLambdaCanaryDeploymentPreference;
const apiKeyPlatinumTierParameter =
  process.env.CDK_PARAM_API_KEY_PLATINUM_TIER_PARAMETER || defaultApiKeyPlatinumTierParameter;
const apiKeyPremiumTierParameter =
  process.env.CDK_PARAM_API_KEY_PREMIUM_TIER_PARAMETER || defaultApiKeyPremiumTierParameter;
const apiKeyStandardTierParameter =
  process.env.CDK_PARAM_API_KEY_STANDARD_TIER_PARAMETER || defaultApiKeyStandardTierParameter;
const apiKeyBasicTierParameter = process.env.CDK_PARAM_API_KEY_BASIC_TIER_PARAMETER || defaultApiKeyBasicTierParameter;
const isPooledDeploy = tenantId === pooledId;

logger.info(`Deploying environment=${environment} tenantId=${tenantId} (pooled=${isPooledDeploy})`);

// parameter names to facilitate sharing api keys
// between the bootstrap template and the tenant template stack(s).
// SBT の tier 値 (basic/standard/premium/platinum) と一致させること。詳細は
// docs/decisions/013-sbt-control-plane-onboarding-wire-format.md。
const apiKeySSMParameterNames = {
  basic: { keyId: "apiKeyBasicTierKeyId", value: "apiKeyBasicTierValue" },
  standard: { keyId: "apiKeyStandardTierKeyId", value: "apiKeyStandardTierValue" },
  premium: { keyId: "apiKeyPremiumTierKeyId", value: "apiKeyPremiumTierValue" },
  platinum: { keyId: "apiKeyPlatinumTierKeyId", value: "apiKeyPlatinumTierValue" },
};

const controlPlaneStack = new ControlPlaneStack(app, "ControlPlaneStack", {
  systemAdminEmail,
});

// DynamoDB プロビジョンドキャパシティ。未指定時は dev 想定で 1/1。
// 本番でスケール要求が上がったら env var で override する。
const dynamoReadCapacity = Number(process.env.CDK_PARAM_DYNAMODB_READ_CAPACITY ?? "1");
const dynamoWriteCapacity = Number(process.env.CDK_PARAM_DYNAMODB_WRITE_CAPACITY ?? "1");

const bootstrapTemplateStack = new BootstrapTemplateStack(app, "tenkacloud-bootstrap-stack", {
  systemAdminEmail,
  eventBusArn: controlPlaneStack.eventBusArn,
  apiKeyPlatinumTierParameter,
  apiKeyPremiumTierParameter,
  apiKeyStandardTierParameter,
  apiKeyBasicTierParameter,
  apiKeySSMParameterNames,
  tenantMappingTableReadCapacity: dynamoReadCapacity,
  tenantMappingTableWriteCapacity: dynamoWriteCapacity,
});
cdk.Aspects.of(bootstrapTemplateStack).add(new DestroyPolicySetter());

const tenantTemplateStack = new TenantTemplateStack(app, `tenkacloud-tenant-template-${tenantId}`, {
  tenantId,
  stageName,
  lambdaReserveConcurrency,
  lambdaCanaryDeploymentPreference,
  isPooledDeploy,
  ApiKeySSMParameterNames: apiKeySSMParameterNames,
  tenantMappingTable: bootstrapTemplateStack.tenantMappingTable,
  commitId,
});

tenantTemplateStack.addDependency(bootstrapTemplateStack);
cdk.Tags.of(tenantTemplateStack).add("TenantId", tenantId);
cdk.Tags.of(tenantTemplateStack).add("IsPooledDeploy", String(isPooledDeploy));
cdk.Aspects.of(tenantTemplateStack).add(new DestroyPolicySetter());

const tenkaCloudPipeline = new ServerlessSaaSPipeline(app, "TenkaCloudPipeline", {
  tenantMappingTable: bootstrapTemplateStack.tenantMappingTable,
  s3SourceBucket,
  sourceZip,
});
cdk.Aspects.of(tenkaCloudPipeline).add(new DestroyPolicySetter());

// AdminApiStack: AdminWeb から各 microservice (Lambda) を呼び出す HTTP API Gateway。
// Cognito JWT Authorizer + 各 Lambda 個別 IAM (DynamoDB R/W のみ) で service 間 invoke を防止。
// build artifact (server/microservices/<svc>/dist/lambda/) が必要 — install.sh phase 0 で build される。
// build artifact 未生成時 (例: synth without build) は skip。
const microserviceDirs = [
  "tenant-management",
  "problem-service",
  "gameday-service",
  "battle-service",
  "scoring-service",
  "leaderboard-service",
];
const microservicesRoot = path.resolve(__dirname, "..", "..", "..", "server", "microservices");
const missingBundles = microserviceDirs.filter(
  (svc) => !fs.existsSync(path.join(microservicesRoot, svc, "dist", "lambda")),
);
let adminApiStack: AdminApiStack | undefined;
if (missingBundles.length === 0) {
  adminApiStack = new AdminApiStack(app, "AdminApiStack", {
    jwtIssuer: controlPlaneStack.jwtIssuer,
    jwtAudience: controlPlaneStack.jwtAudience,
    adminConsoleOrigin: process.env.CDK_PARAM_ADMIN_CONSOLE_ORIGIN,
    dynamoReadCapacity: dynamoReadCapacity,
    dynamoWriteCapacity: dynamoWriteCapacity,
  });
  adminApiStack.addDependency(controlPlaneStack);
  cdk.Aspects.of(adminApiStack).add(new DestroyPolicySetter());
} else {
  logger.warn(
    `Skipping AdminApiStack: dist/lambda missing for [${missingBundles.join(", ")}]. Run 'bash scripts/build-microservices-lambda.sh' first.`,
  );
}

// ProblemDeployPipelineStack: GameDay の admin が UI から「全チームに problem を deploy」
// 「失敗した team を retry (redeploy)」「event 終了で全 stack を teardown」を起動すると、
// problem-service が SBT EventBus に ProblemDeployRequested を publish する。
// 本 stack はそれを受けて CodeBuild project を起動し、各 team account に
// AssumeRole + CFn deploy/delete する。SBT の BashJobRunner と同じ event-driven パターン。
const problemDeployPipeline = new ProblemDeployPipelineStack(app, "ProblemDeployPipelineStack", {
  eventBusArn: controlPlaneStack.eventBusArn,
});
problemDeployPipeline.addDependency(controlPlaneStack);
cdk.Aspects.of(problemDeployPipeline).add(new DestroyPolicySetter());

// AdminConsoleHostingStack: client/AdminWeb (Next.js) を CloudFront+S3 で配信する想定。
// ⚠️ TenkaCloud の AdminWeb は `output: 'standalone'` + API routes (NextAuth 等) を持つため
//    pure S3+CloudFront には収まらない。詳細は admin-console-hosting.ts のヘッダコメント参照。
// 3-phase deploy の phase 2 で deploy される (install.sh が backend outputs を env として渡す)。
const adminConsoleApiUrl = process.env.CDK_PARAM_CONTROL_PLANE_API_URL;
const adminConsoleCognitoDomain = process.env.CDK_PARAM_CONTROL_PLANE_COGNITO_DOMAIN;
const adminConsoleUserClientId = process.env.CDK_PARAM_CONTROL_PLANE_USER_CLIENT_ID;
// AdminApiStack の URL — install.sh phase 1 deploy 後に export される。
// 未設定でも AdminConsoleHosting は deploy 可能 (runtime-config に adminApiUrl が無い → AdminWeb は SBT API のみ使う)。
const adminApiUrl = process.env.CDK_PARAM_ADMIN_API_URL;

if (adminConsoleApiUrl && adminConsoleCognitoDomain && adminConsoleUserClientId) {
  const adminConsoleHosting = new AdminConsoleHostingStack(app, "AdminConsoleHostingStack", {
    apiUrl: adminConsoleApiUrl,
    cognitoDomain: adminConsoleCognitoDomain,
    userClientId: adminConsoleUserClientId,
    adminApiUrl,
  });
  cdk.Aspects.of(adminConsoleHosting).add(new DestroyPolicySetter());
}
