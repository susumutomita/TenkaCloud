#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import { BillingMode } from "aws-cdk-lib/aws-dynamodb";
import * as dotenv from "dotenv";
import { AdminConsoleHostingStack } from "../lib/admin-console-hosting";
import { BootstrapTemplateStack } from "../lib/bootstrap-template/bootstrap-template-stack";
import { DestroyPolicySetter } from "../lib/cdk-aspect/destroy-policy-setter";
import { DynamoDbLowCapacity } from "../lib/cdk-aspect/dynamodb-low-capacity";
import { ControlPlaneStack } from "../lib/control-plane-stack";
import { getEnv } from "../lib/helper-functions";
import { ProblemDeployBackendStack } from "../lib/problem-deploy/problem-deploy-backend-stack";
import { ServerlessSaaSPipeline } from "../lib/tenant-pipeline/serverless-saas-pipeline";
import { TenantTemplateStack } from "../lib/tenant-template/tenant-template-stack";
import { loadConfig } from "../lib/utils/config-loader";

// TenkaCloud の env 読み込み。`infrastructure/environments/<env>/.env` がある場合だけ load。
// ref の bin は CDK_PARAM_* を全部 process.env から直読みするので、ここで先に注入しておく。
// install.sh が直接 export してくる CDK_PARAM_* は既に process.env にあり上書き不要。
const environment = process.env.CDK_PARAM_ENVIRONMENT ?? "development";
const envFilePath = path.resolve(__dirname, `../environments/${environment}/.env`);
if (fs.existsSync(envFilePath)) {
  dotenv.config({ path: envFilePath });
  console.log(`[bin] Loaded env from ${envFilePath}`);
}

const app = new cdk.App();

// required input parameters
if (!process.env.CDK_PARAM_SYSTEM_ADMIN_EMAIL) {
  throw new Error("Please provide system admin email");
}

if (!process.env.CDK_PARAM_TENANT_ID) {
  console.log('Tenant ID is empty, a default tenant id "pooled" will be assigned');
}

const pooledId = "pooled";

const systemAdminEmail = process.env.CDK_PARAM_SYSTEM_ADMIN_EMAIL;
const tenantId = process.env.CDK_PARAM_TENANT_ID || pooledId;
// admin-console での tenant 作成時の名前。provision-tenant.sh が SBT イベントから
// 受け取って CDK_PARAM_TENANT_NAME に export する。pooled stack (install.sh phase 1)
// では env が無いので "Shared Pooled Tenant" を default。
const tenantName =
  process.env.CDK_PARAM_TENANT_NAME || (tenantId === pooledId ? "Shared Pooled Tenant" : tenantId);
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
  process.env.CDK_PARAM_LAMBDA_CANARY_DEPLOYMENT_PREFERENCE ||
  defaultLambdaCanaryDeploymentPreference;
const apiKeyPlatinumTierParameter =
  process.env.CDK_PARAM_API_KEY_PLATINUM_TIER_PARAMETER || defaultApiKeyPlatinumTierParameter;
const apiKeyPremiumTierParameter =
  process.env.CDK_PARAM_API_KEY_PREMIUM_TIER_PARAMETER || defaultApiKeyPremiumTierParameter;
const apiKeyStandardTierParameter =
  process.env.CDK_PARAM_API_KEY_STANDARD_TIER_PARAMETER || defaultApiKeyStandardTierParameter;
const apiKeyBasicTierParameter =
  process.env.CDK_PARAM_API_KEY_BASIC_TIER_PARAMETER || defaultApiKeyBasicTierParameter;

// DynamoDB の billing mode + read/write capacity は `environments/<env>/config.json`
// の `dynamoDbConfig` セクションで宣言し、`.env` の `${VAR:-default}` で override する
// (jpki-api 互換)。caller (bin) を 1 箇所に集約することで stack 側で fallback default が
// 分岐しないようにする (default の発生源を単一化)。
//
//   - config.json: `dynamoDbConfig.{billingMode,readCapacity,writeCapacity}`
//   - .env       : `DYNAMODB_BILLING_MODE` / `DYNAMODB_READ_CAPACITY` / `DYNAMODB_WRITE_CAPACITY` で override
//
// 後方互換: 旧 `CDK_PARAM_DYNAMODB_*_CAPACITY` env も尊重する (set されていれば config 値より優先)。
const config = loadConfig(environment, __dirname);
const ddb = config?.dynamoDbConfig;
const dynamoBillingMode =
  ddb?.billingMode === "PAY_PER_REQUEST" ? BillingMode.PAY_PER_REQUEST : BillingMode.PROVISIONED;
const isDynamoProvisioned = dynamoBillingMode === BillingMode.PROVISIONED;
const dynamoReadCapacity = Number(
  process.env.CDK_PARAM_DYNAMODB_READ_CAPACITY || ddb?.readCapacity || 1,
);
const dynamoWriteCapacity = Number(
  process.env.CDK_PARAM_DYNAMODB_WRITE_CAPACITY || ddb?.writeCapacity || 1,
);
// Cognito UserPool domain は region globally unique なので env / tenantId / accountId を
// 入れて衝突回避する (#83)。AdminConsoleHostingStack 用にも同じ値が要るので前倒しで定義。
const awsRegion = process.env.CDK_PARAM_AWS_REGION ?? process.env.CDK_DEFAULT_REGION ?? "";
const awsAccountId = process.env.CDK_PARAM_AWS_ACCOUNT_ID ?? process.env.CDK_DEFAULT_ACCOUNT ?? "";
const isPooledDeploy = tenantId === pooledId;

// parameter names to facilitate sharing api keys
// between the bootstrap template and the tenant template stack(s)
const apiKeySSMParameterNames = {
  basic: { keyId: "apiKeyBasicTierKeyId", value: "apiKeyBasicTierValue" },
  standard: { keyId: "apiKeyStandardTierKeyId", value: "apiKeyStandardTierValue" },
  premium: { keyId: "apiKeyPremiumTierKeyId", value: "apiKeyPremiumTierValue" },
  platinum: { keyId: "apiKeyPlatinumTierKeyId", value: "apiKeyPlatinumTierValue" },
};

// 全 stack の env を統一する: TenantTemplateStack だけ env-aware にすると、
// env-agnostic な BootstrapTemplateStack の TenantMappingTable を cross-env 参照する
// ことになり CDK が CannotUseCrossEnvironment で拒否する。
// awsAccountId / awsRegion が両方 set されているときだけ env-aware にする。
const stackEnv =
  awsAccountId && awsRegion ? { env: { account: awsAccountId, region: awsRegion } } : {};

const controlPlaneStack = new ControlPlaneStack(app, "ControlPlaneStack", {
  ...stackEnv,
  systemAdminEmail,
});
// SBT が ControlPlane 内部で作る TenantDetails table はデフォルト 5/5 (CDK Table の
// 既定値) なので Free Tier 枠 (25 RCU/WCU) を圧迫する。Aspect で全 CfnTable を
// dynamoReadCapacity / dynamoWriteCapacity (default 1/1) に揃えて Free Tier に収める。
cdk.Aspects.of(controlPlaneStack).add(
  new DynamoDbLowCapacity(dynamoReadCapacity, dynamoWriteCapacity),
);

// Problem deploy backend: Deployments DDB + IAM Role + Deploy API Lambda + Worker Lambda。
// `DEPLOY_EXTERNAL_ID` は競技者 Bootstrap CFn (templates/competitor-bootstrap.yaml) で
// 設定された ExternalId と一致させる必要がある。.env から渡す。
const deployExternalId = process.env.CDK_PARAM_DEPLOY_EXTERNAL_ID || "tenkacloud-dev-external-id";
const problemDeployBackendStack = new ProblemDeployBackendStack(app, "ProblemDeployBackendStack", {
  ...stackEnv,
  eventBusArn: controlPlaneStack.eventBusArn,
  deployExternalId,
});
cdk.Aspects.of(problemDeployBackendStack).add(
  new DynamoDbLowCapacity(dynamoReadCapacity, dynamoWriteCapacity),
);

const bootstrapTemplateStack = new BootstrapTemplateStack(
  app,
  "serverless-saas-ref-arch-bootstrap-stack",
  {
    ...stackEnv,
    systemAdminEmail,
    eventBusArn: controlPlaneStack.eventBusArn,
    apiKeyPlatinumTierParameter,
    apiKeyPremiumTierParameter,
    apiKeyStandardTierParameter,
    apiKeyBasicTierParameter,
    apiKeySSMParameterNames,
    tenantMappingTableBillingMode: dynamoBillingMode,
    tenantMappingTableReadCapacity: isDynamoProvisioned ? dynamoReadCapacity : undefined,
    tenantMappingTableWriteCapacity: isDynamoProvisioned ? dynamoWriteCapacity : undefined,
  },
);
cdk.Aspects.of(bootstrapTemplateStack).add(new DestroyPolicySetter());

const tenantTemplateStack = new TenantTemplateStack(
  app,
  `serverless-saas-ref-arch-tenant-template-${tenantId}`,
  {
    ...stackEnv,
    tenantId,
    tenantName,
    environment,
    stageName,
    lambdaReserveConcurrency,
    lambdaCanaryDeploymentPreference,
    isPooledDeploy,
    ApiKeySSMParameterNames: apiKeySSMParameterNames,
    tenantMappingTable: bootstrapTemplateStack.tenantMappingTable,
    commitId,
  },
);

tenantTemplateStack.addDependency(bootstrapTemplateStack);
cdk.Tags.of(tenantTemplateStack).add("TenantId", tenantId);
cdk.Tags.of(tenantTemplateStack).add("IsPooledDeploy", String(isPooledDeploy));
cdk.Aspects.of(tenantTemplateStack).add(new DestroyPolicySetter());

const serverlessSaaSPipeline = new ServerlessSaaSPipeline(app, "ServerlessSaaSPipeline", {
  ...stackEnv,
  tenantMappingTable: bootstrapTemplateStack.tenantMappingTable,
  s3SourceBucket,
  sourceZip,
});
cdk.Aspects.of(serverlessSaaSPipeline).add(new DestroyPolicySetter());

// AdminConsoleHostingStack: React admin-console を CloudFront+S3 で配信 + runtime-config.json 配置。
// 3-phase deploy の phase 2 で deploy される (install.sh が backend outputs を env として渡す)。
// phase 1 では env 未設定なので synth 対象外 (dist/ がまだ無くてもエラーにならない)。
const adminConsoleApiUrl = process.env.CDK_PARAM_CONTROL_PLANE_API_URL;
const adminConsoleCognitoDomain = process.env.CDK_PARAM_CONTROL_PLANE_COGNITO_DOMAIN;
const adminConsoleUserClientId = process.env.CDK_PARAM_CONTROL_PLANE_USER_CLIENT_ID;

// 以下は #57 で追加したオプション env。phase 2 の install.sh が CFn / CodeBuild API
// から取って渡す。未設定なら空文字 fallback (admin-console 側で「unknown / 未発行」表示)。
const pooledAppConsoleUrl = process.env.CDK_PARAM_POOLED_APP_CONSOLE_URL ?? "";
const provisioningCodeBuildProject =
  process.env.CDK_PARAM_PROVISIONING_CODEBUILD_PROJECT ?? "unknown";
// awsRegion / awsAccountId は TenantTemplateStack のために前倒しで定義済み (上を参照)。

if (adminConsoleApiUrl && adminConsoleCognitoDomain && adminConsoleUserClientId) {
  const adminConsoleHosting = new AdminConsoleHostingStack(app, "AdminConsoleHostingStack", {
    ...stackEnv,
    apiUrl: adminConsoleApiUrl,
    cognitoDomain: adminConsoleCognitoDomain,
    userClientId: adminConsoleUserClientId,
    pooledApplicationAdminConsoleUrl: pooledAppConsoleUrl,
    provisioningCodeBuildProject,
    awsRegion,
    awsAccountId,
  });
  cdk.Aspects.of(adminConsoleHosting).add(new DestroyPolicySetter());
}
