#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { resolveAppConfig } from "../lib/app-config/index.js";
import { resolveLitePackCatalog } from "../lib/app-wiring/lite-pack-catalog.js";
import { buildProblemDeployBackendBaseProps } from "../lib/app-wiring/problem-deploy-backend-props.js";
import { applyDynamoLowCapacity, applyGlobalAspects } from "../lib/app-wiring/wire/aspects.js";
import { ProblemDeployBackendStack } from "../lib/problem-deploy/problem-deploy-backend-stack.js";
import { TenkaCloudLiteStack } from "../lib/tenkacloud-lite/index.js";
import { resolveLiteStackNames } from "../lib/tenkacloud-lite/stack-names.js";

/**
 * Issue #778: TenkaCloud Lite mode の CDK app entry point。
 *
 * SBT / Pipeline / 動的 tenant 作成のフル機能を持ち込まず、 tenantId="local" 固定で
 * ApplicationAdminConsole + ProblemDeploy backend だけを deploy する経路。
 * `make lite-up` (= `scripts/tenkacloud-lite.ts`) から呼ばれる。
 *
 * 配線:
 *   1. ProblemDeployBackendStack を eventBusArn=undefined で作る (= local
 *      EventBus に倒す)
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
// [Issue #2459] Extracted to `lib/app-wiring/lite-pack-catalog.ts` for direct unit coverage
// (was a module-private `resolveLiteCatalog` here). Byte-identical behavior.
const liteCatalog = resolveLitePackCatalog(import.meta.dirname);
const config = resolveAppConfig({
  env: process.env,
  binDir: import.meta.dirname,
  ...(liteCatalog
    ? { catalogSource: liteCatalog.catalogSource, packAssets: liteCatalog.packAssets }
    : {}),
});

// Issue #2193: stack 名 + env suffix 規則は lib/tenkacloud-lite/stack-names.ts に集約
// (CLI runner `scripts/tenkacloud-lite.ts` と共有し、 describe/destroy の対象名と一致させる)。
const liteStackNames = resolveLiteStackNames(config.environment);

// Issue #2209: App scope の Tags / Aspects (cost allocation tag / KMS pending window /
// CodeBuild KMS / LogGroup retention) は SaaS mode (wire.ts) と同じヘルパを共有する。
// Lite 側だけの手コピーは、 wire 側への Aspect 追加が Lite に伝播しない drift の温床だった。
applyGlobalAspects(app, config);

// Issue #778 / PR #791: eventBusArn 省略で local bus 自動作成。
const problemDeployBackend = new ProblemDeployBackendStack(app, liteStackNames.problemDeploy, {
  ...config.stackEnv,
  // source bundle + problems.* の共通 props は SaaS (wire.ts) と共有の factory (#2209)。
  // 新しい問題メタデータ field は factory に 1 回追加すれば両モードへ届く。
  ...buildProblemDeployBackendBaseProps(config),
  // eventBusArn は **明示的に渡さない** (= Lite では ControlPlane 不在のため)
  // Lite では participant portal を runtime-config "default-dev-mock" で立てる
  // (= portal Lambda + S3+CloudFront を持ち込む)。 frontend は backend mode で動く。
  participantPortal: { runtimeConfig: "default-dev-mock" },
});
applyDynamoLowCapacity(problemDeployBackend, config);

// AppPlaneCore (= tenantId="local" 固定) を抱える Lite stack。 ProblemDeploy stack
// の Lambda refs を cross-stack で渡す (= 既存 Full mode の TenantTemplateStack
// と同 pattern)。
const liteStack = new TenkaCloudLiteStack(app, liteStackNames.app, {
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
  // Issue #2230: Lite mode でも deploy 時 feature flag override を焼く
  // (= nonAwsRuntime の検証は Lite が主戦場)。
  features: config.features,
  // Issue #2442: control-plane data backend の選択。base props
  // (`buildProblemDeployBackendBaseProps`) と同じ `config` source を共有し、両モードへ同一に
  // 届ける (= Lite mode での flag 切替配線、 SamlIdpsTable の条件付き synth に使う)。
  controlDataBackend: config.controlDataBackend,
  tursoDatabaseUrl: config.tursoDatabaseUrl,
  tursoAuthTokenParameterName: config.tursoAuthTokenParameterName,
});
applyDynamoLowCapacity(liteStack, config);
liteStack.addDependency(problemDeployBackend);
