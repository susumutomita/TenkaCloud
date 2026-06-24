#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { resolveAppConfig } from "../lib/app-config/index.js";
import { CodeBuildUseAwsManagedKms } from "../lib/cdk-aspect/codebuild-use-aws-managed-kms.js";
import { DynamoDbLowCapacity } from "../lib/cdk-aspect/dynamodb-low-capacity.js";
import { KmsKeyShortPendingWindow } from "../lib/cdk-aspect/kms-key-short-pending-window.js";
import { LogGroupRetention } from "../lib/cdk-aspect/log-group-retention.js";
import { ProblemDeployBackendStack } from "../lib/problem-deploy/problem-deploy-backend-stack.js";
import { TenkaCloudLiteStack } from "../lib/tenkacloud-lite/index.js";

/**
 * Issue #778 ADR-016 Phase 5: TenkaCloud Lite mode の CDK app entry point。
 *
 * SBT / Pipeline / 動的 tenant 作成のフル機能を持ち込まず、 tenantId="local" 固定で
 * ApplicationAdminConsole + ProblemDeploy backend だけを deploy する経路。
 * `make lite-up` (= `scripts/tenkacloud-lite.ts`) から呼ばれる。
 *
 * 配線:
 *   1. ProblemDeployBackendStack を eventBusArn=undefined で作る (= local
 *      EventBus に倒す、 ADR-016 Phase 2)
 *   2. TenkaCloudLiteStack を作って ProblemDeploy stack の Lambda refs を渡す
 *
 * config 解決は Full mode と同じ `resolveAppConfig` を使う (= env / .env /
 * problems 列挙)。 Lite 固有の調整は本ファイル内で配線レイヤだけ:
 *   - ControlPlane / BootstrapTemplate / TenantTemplate / Pipeline /
 *     AdminConsoleInsight は作らない (= Lite mode の出発点)
 *   - AdminConsoleHosting (= System Admin SPA) も作らない (= Lite は Tenant
 *     Admin Console + Participant Portal の 2 画面で完結)
 */

const app = new cdk.App();
const config = resolveAppConfig({ env: process.env, binDir: import.meta.dirname });

/**
 * Issue #992: 同 AWS account に複数 env を deploy できるよう stack ID に env suffix を付ける。
 * development は default で suffix なし (= 旧 deploy 互換)、 staging / production 等は
 * `-<env>` で別 stack 名前空間に置く。 wire.ts の同名 helper と一致させる。
 */
function stackId(base: string): string {
  if (config.environment === "development") return base;
  return `${base}-${config.environment}`;
}

// Issue #952 / PR-957: cost allocation tag を App scope で全リソースに付与する。
// SaaS mode (wire.ts) と同じ規則。 AWS Billing console で `Project` を Cost
// Allocation Tag として activate すれば Budget / Cost Explorer で TenkaCloud
// 分だけを抽出できる。
cdk.Tags.of(app).add("Project", "TenkaCloud");
cdk.Tags.of(app).add("Environment", config.environment);

cdk.Aspects.of(app).add(new KmsKeyShortPendingWindow(config.kmsPendingWindowInDays));
cdk.Aspects.of(app).add(new CodeBuildUseAwsManagedKms());
// 全 LogGroup の retention を `CDK_PARAM_LOG_RETENTION_DAYS` (既定 1 日) に揃える。 KMS /
// CodeBuild の App scope cost aspect と同じ位置に並べ、 Lite の両 stack の log group を一掃する。
cdk.Aspects.of(app).add(new LogGroupRetention());

// Issue #778 ADR-016 Phase 2 / PR-#791: eventBusArn 省略で local bus 自動作成。
const problemDeployBackend = new ProblemDeployBackendStack(
  app,
  stackId("tenkacloud-lite-problem-deploy"),
  {
    ...config.stackEnv,
    // eventBusArn は **明示的に渡さない** (= Lite では ControlPlane 不在のため)
    sourceBucketName: config.s3SourceBucket,
    sourceObjectKey: config.sourceZip,
    problemsCatalog: config.problems.catalog as Readonly<Record<string, string>>,
    problemsScoring: config.problems.scoring as Readonly<Record<string, unknown>>,
    problemsEndpoints: config.problems.endpoints as Readonly<Record<string, unknown>>,
    problemsPhases: (config.problems.phases ?? {}) as Readonly<Record<string, unknown>>,
    problemsVisibility: (config.problems.visibility ?? {}) as Readonly<Record<string, "private">>,
    // Issue #888: Lite mode でも problemsDisruptions を Lambda env に渡す。
    problemsDisruptions: (config.problems.disruptions ?? {}) as Readonly<Record<string, unknown>>,
    // #1420 ADR-030 Phase 3: Lite mode でも coordination plugin path を dispatcher へ渡す。
    problemsCoordination: (config.problems.coordination ?? {}) as Readonly<Record<string, unknown>>,
    // #1420 ADR-030 Phase 3b: Lite mode でも synth-bundle 済み coordination plugin を S3 へ配置。
    problemsCoordinationBundles: (config.problems.coordinationBundles ?? {}) as Readonly<
      Record<string, string>
    >,
    // Lite では participant portal を runtime-config "default-dev-mock" で立てる
    // (= portal Lambda + S3+CloudFront を持ち込む)。 frontend は backend mode で動く。
    participantPortal: { runtimeConfig: "default-dev-mock" },
    deployConcurrentBuildLimit: config.deployConcurrentBuildLimit,
    environmentName: config.environment,
  },
);
cdk.Aspects.of(problemDeployBackend).add(
  new DynamoDbLowCapacity(config.dynamoReadCapacity, config.dynamoWriteCapacity),
);

// AppPlaneCore (= tenantId="local" 固定) を抱える Lite stack。 ProblemDeploy stack
// の Lambda refs を cross-stack で渡す (= 既存 Full mode の TenantTemplateStack
// と同 pattern)。
const liteStack = new TenkaCloudLiteStack(app, stackId("tenkacloud-lite"), {
  ...config.stackEnv,
  environment: config.environment,
  deployApiLambda: problemDeployBackend.deployApiLambda,
  eventApiLambda: problemDeployBackend.eventApiLambda,
  competitorAccountsApiLambda: problemDeployBackend.competitorAccountsApiLambda,
  // Issue #1053: ProblemDeployBackendStack に移管した hosting の URL を cross-stack ref で渡す。
  competitorBootstrapTemplateUrl: problemDeployBackend.competitorBootstrapTemplateUrl,
  ...(problemDeployBackend.participantPortalUrl
    ? { participantPortalUrl: problemDeployBackend.participantPortalUrl }
    : {}),
  // Issue #1340 Phase 2: opt-in per-tenant SAML (= 未設定なら空配列で no-op)。
  samlIdps: config.tenantSamlIdps,
  samlAdminAllowlist: config.tenantSamlAdminAllowlist,
});
cdk.Aspects.of(liteStack).add(
  new DynamoDbLowCapacity(config.dynamoReadCapacity, config.dynamoWriteCapacity),
);
liteStack.addDependency(problemDeployBackend);
