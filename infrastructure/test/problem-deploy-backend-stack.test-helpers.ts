import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { Project } from "aws-cdk-lib/aws-codebuild";
import type { PackAsset } from "../lib/app-config/types";
import { CoordinationDispatcherLambda } from "../lib/problem-deploy/coordination-dispatcher-lambda";
import { ParticipantPortalLambda } from "../lib/problem-deploy/participant-portal-lambda";
import { ProblemDeployBackendStack } from "../lib/problem-deploy/problem-deploy-backend-stack";

// synth は 5 個の NodejsFunction (= esbuild bundling) を含むため CI 上で ~7s かかる。
// vitest の default 5s timeout を拡張する (= 既存 #538 test と同じ pattern)。
// Issue #1249: 旧 problem-deploy-backend-stack.test.ts (781 行) を resource type 別 6 ファイル
// + helper に分割した際の共有 timeout (各 file が自前で synth するため timeout が必要)。
// 全 suite 並列時は fork 飽和で 36MB asset の esbuild bundling 単体が 25s+ かかり 30s を
// 超えることがあるため 120s (= 分離実行 ~7s に対する安全マージン、hang 検出は維持)。
export const SYNTH_TIMEOUT_MS = 120_000;

/**
 * Issue #2515: 全 synth helper 共通のメモ化 wrapper。 元は `cachedDefault` /
 * `cachedCodeBuild` の 2 個を手組みキャッシュ変数で個別実装していたが (= 残り 11 個は毎回 synth
 * していた)、引数を持つ helper (`synthLite` / `synthWithPackAssets`) も含めて 1 実装に統一する。
 * 引数を `JSON.stringify` した文字列をキーにする ── 同一引数の再呼び出しはキャッシュを再利用し、
 * 異なる引数 (例: `synthLite("LiteStack", ...)` と `synthLite("LiteStack2", ...)`) は別 synth
 * として区別する。 module scope のキャッシュなので、このヘルパを import する test file 単位で
 * 有効 (Issue #1249 のメモ化方針と同じ)。
 */
function memoizeTemplate<Args extends unknown[]>(
  synth: (...args: Args) => Template,
): (...args: Args) => Template {
  const cache = new Map<string, Template>();
  return (...args: Args): Template => {
    const key = JSON.stringify(args);
    const cached = cache.get(key);
    if (cached) return cached;
    const template = synth(...args);
    cache.set(key, template);
    return template;
  };
}

// 全 it() で同じ Template を使い回す。stack 構造は default props で固定なので、
// describe ブロック単位で 1 度 synth すれば再利用できる。
// Issue #1249: ファイル分割後、複数の test file が同じ default Template を読むので、
// helper module scope でメモ化することで synth コストの増加を防ぐ (元 file と同じ 2 synth)。
//
// Issue #2291 完了: `deployViaLambda` の既定が Lambda 経路へ反転した (resolve.ts で
// CDK_PARAM_DEPLOY_VIA_LAMBDA が未設定なら true)。よって synthDefault は **Lambda deploy 経路**の
// stack shape を返す (= CfnDeploy Lambda + ProblemArtifacts BucketDeployment + Lambda-poll SFN、
// problem-deploy CodeBuild Project は 0 個)。在来 CodeBuild 経路を検証したい test は
// {@link synthWithCodeBuild} (= CDK_PARAM_DEPLOY_VIA_LAMBDA=false rollback 相当) を使う。
export const synthDefault = memoizeTemplate((): Template => {
  const app = new cdk.App({ autoSynth: false });
  const stack = new ProblemDeployBackendStack(app, "TestStack", {
    eventBusArn: "arn:aws:events:ap-northeast-1:123456789012:event-bus/test-bus",
    sourceBucketName: "test-source-bucket",
    sourceObjectKey: "source.zip",
    problemsCatalog: {
      "hello-world": "problems/challenges/hello-world",
    },
    problemsScoring: {},
    problemsEndpoints: {},
    // Issue #2291: Lambda deploy 経路が新既定 (= `make deploy` の live-test 対象)。
    deployViaLambda: true,
    environmentName: "development",
  });
  return Template.fromStack(stack);
});

// Issue #2291 rollback path: `CDK_PARAM_DEPLOY_VIA_LAMBDA=false` は在来 CodeBuild deploy 経路を
// byte 互換で復元する。problem-deploy CodeBuild Project (と CodeBuild を叩く SFN 定義) を実際に
// 検証したい test はこの helper を使う (= 既定反転前の synthDefault と同一 shape)。複数 test file
// から読まれるので synthDefault と同様メモ化する。
export const synthWithCodeBuild = memoizeTemplate((): Template => {
  const app = new cdk.App({ autoSynth: false });
  const stack = new ProblemDeployBackendStack(app, "TestStackCodeBuild", {
    eventBusArn: "arn:aws:events:ap-northeast-1:123456789012:event-bus/test-bus",
    sourceBucketName: "test-source-bucket",
    sourceObjectKey: "source.zip",
    problemsCatalog: {
      "hello-world": "problems/challenges/hello-world",
    },
    problemsScoring: {},
    problemsEndpoints: {},
    // 明示 false = 在来 CodeBuild 経路 (rollback / legacy path)。
    deployViaLambda: false,
    environmentName: "development",
  });
  return Template.fromStack(stack);
});

// Issue #2232: useBulkDistributedMap: true を反映させた EventApi Lambda env を検証するための
// 別 synth (= 既存 synthWithDeployConcurrentBuildLimit と同じ pattern)。
export const synthWithBulkDistributedMap = memoizeTemplate((): Template => {
  const app = new cdk.App({ autoSynth: false });
  const stack = new ProblemDeployBackendStack(app, "TestStackWithDistributedMap", {
    eventBusArn: "arn:aws:events:ap-northeast-1:123456789012:event-bus/test-bus",
    sourceBucketName: "test-source-bucket",
    sourceObjectKey: "source.zip",
    problemsCatalog: { "hello-world": "problems/challenges/hello-world" },
    problemsScoring: {},
    problemsEndpoints: {},
    useBulkDistributedMap: true,
    environmentName: "development",
  });
  return Template.fromStack(stack);
});

// Issue #2311: auditLogEnabled: false を反映させ、 監査を書く Lambda 群の env に
// AUDIT_LOG_ENABLED="false" が注入されることを検証するための別 synth。
export const synthWithAuditLogDisabled = memoizeTemplate((): Template => {
  const app = new cdk.App({ autoSynth: false });
  const stack = new ProblemDeployBackendStack(app, "TestStackAuditDisabled", {
    eventBusArn: "arn:aws:events:ap-northeast-1:123456789012:event-bus/test-bus",
    sourceBucketName: "test-source-bucket",
    sourceObjectKey: "source.zip",
    problemsCatalog: { "hello-world": "problems/challenges/hello-world" },
    problemsScoring: {},
    problemsEndpoints: {},
    auditLogEnabled: false,
    environmentName: "development",
  });
  return Template.fromStack(stack);
});

// Issue #2406: ops monitoring is opt-in via CDK_PARAM_OPS_ALERT_EMAIL. This helper pins the
// ProblemDeployBackendStack shape when the alerting email is present.
export const synthWithOpsMonitoring = memoizeTemplate((): Template => {
  const app = new cdk.App({ autoSynth: false });
  const stack = new ProblemDeployBackendStack(app, "TestStackOpsMonitoring", {
    eventBusArn: "arn:aws:events:ap-northeast-1:123456789012:event-bus/test-bus",
    sourceBucketName: "test-source-bucket",
    sourceObjectKey: "source.zip",
    problemsCatalog: { "hello-world": "problems/challenges/hello-world" },
    problemsScoring: {},
    problemsEndpoints: {},
    deployViaLambda: true,
    environmentName: "development",
    opsMonitoring: {
      alertEmail: "ops@example.com",
      monthlyCostLimitUsd: 25,
      budgetThresholdPercent: 90,
    },
  });
  return Template.fromStack(stack);
});

/**
 * [Issue #3151] ops monitoring **and** a participant portal.
 *
 * The coordination state-budget alarms watch the CoordinationDispatcher
 * Lambda's log group, and that Lambda only exists when the participant portal
 * subsystem is built. {@link synthWithOpsMonitoring} has no portal, which is
 * why the alarm count there is still exactly the two scoring alarms — a stack
 * with no coordination dispatcher has no coordination log to watch.
 */
export const synthWithOpsMonitoringAndPortal = memoizeTemplate((): Template => {
  const app = new cdk.App({ autoSynth: false });
  const stack = new ProblemDeployBackendStack(app, "TestStackOpsMonitoringPortal", {
    eventBusArn: "arn:aws:events:ap-northeast-1:123456789012:event-bus/test-bus",
    sourceBucketName: "test-source-bucket",
    sourceObjectKey: "source.zip",
    problemsCatalog: { "hello-world": "problems/challenges/hello-world" },
    problemsScoring: {},
    problemsEndpoints: {},
    deployViaLambda: true,
    environmentName: "development",
    participantPortal: { runtimeConfig: "default-dev-mock" },
    opsMonitoring: {
      alertEmail: "ops@example.com",
      monthlyCostLimitUsd: 25,
      budgetThresholdPercent: 90,
    },
  });
  return Template.fromStack(stack);
});

// Issue #2290 / #2440: controlDataBackend: "turso" を反映させ、監査 Lambda 群の env に
// CONTROL_DATA_BACKEND="turso" が注入されることを検証するための別 synth (= synthWithAuditLogDisabled
// と同じ pattern)。[Issue #2440] "turso" は純 SQL backend (Events/Teams
// テーブルを synth しない) を意味する。
export const synthWithControlDataBackendTurso = memoizeTemplate((): Template => {
  const app = new cdk.App({ autoSynth: false });
  const stack = new ProblemDeployBackendStack(app, "TestStackControlDataTurso", {
    eventBusArn: "arn:aws:events:ap-northeast-1:123456789012:event-bus/test-bus",
    sourceBucketName: "test-source-bucket",
    sourceObjectKey: "source.zip",
    problemsCatalog: { "hello-world": "problems/challenges/hello-world" },
    problemsScoring: {},
    problemsEndpoints: {},
    controlDataBackend: "turso",
    tursoDatabaseUrl: "libsql://example.turso.io",
    tursoAuthTokenParameterName: "/tenkacloud/development/turso-token",
    environmentName: "development",
  });
  return Template.fromStack(stack);
});

// Issue #2291: Lambda deploy 経路 (CfnDeployLambda + EmitDeployFailedEvent + DeployFailureRule) を
// 明示的に検証するための helper。既定反転後 (#2291 完了) は synthDefault と同一 shape なので、
// 重複 synth を避けて synthDefault のメモ化 Template をそのまま返す。Lambda 経路を意図する
// describe が intent-first に読めるよう別名として残す。単なる delegate なので memoizeTemplate は
// 不要 (synthDefault 自身が既にメモ化済み)。
export function synthWithDeployViaLambda(): Template {
  return synthDefault();
}

// Issue #2462: active pack の実体を materialize する `packAssets` を渡した Lambda 経路の synth。
// `problemsRootAbs` は実在ディレクトリを要する (Source.asset が synth 時に stage する) ため、
// 呼び出し側が fixture dir を作って渡す。
export const synthWithPackAssets = memoizeTemplate((packAssets: readonly PackAsset[]): Template => {
  const app = new cdk.App({ autoSynth: false });
  const stack = new ProblemDeployBackendStack(app, "TestStackPackAssets", {
    eventBusArn: "arn:aws:events:ap-northeast-1:123456789012:event-bus/test-bus",
    sourceBucketName: "test-source-bucket",
    sourceObjectKey: "source.zip",
    problemsCatalog: { "hello-world": "problems/challenges/hello-world" },
    problemsScoring: {},
    problemsEndpoints: {},
    deployViaLambda: true,
    packAssets,
    environmentName: "development",
  });
  return Template.fromStack(stack);
});

// #538: deployConcurrentBuildLimit を反映させた CodeBuild Project を検証するための別 synth。
export const synthWithDeployConcurrentBuildLimit = memoizeTemplate((): Template => {
  const app = new cdk.App({ autoSynth: false });
  const stack = new ProblemDeployBackendStack(app, "TestStackWithLimit", {
    eventBusArn: "arn:aws:events:ap-northeast-1:123456789012:event-bus/test-bus",
    sourceBucketName: "test-source-bucket",
    sourceObjectKey: "source.zip",
    problemsCatalog: { "hello-world": "problems/challenges/hello-world" },
    problemsScoring: {},
    problemsEndpoints: {},
    deployConcurrentBuildLimit: 200,
    // #1766: tier 別同時デプロイ上限の env 配線検証用。
    deployQuotaByTier: { basic: 2, advanced: 5, platinum: 10 },
    environmentName: "development",
  });
  return Template.fromStack(stack);
});

// #778: eventBusArn を省略した Lite mode の synth。 別 stackId / bucket name を渡す。
// stackId / sourceBucketName の組み合わせごとにキャッシュされる (= 同じ引数の再呼び出しのみ再利用)。
export const synthLite = memoizeTemplate((stackId: string, sourceBucketName: string): Template => {
  const app = new cdk.App({ autoSynth: false });
  const stack = new ProblemDeployBackendStack(app, stackId, {
    sourceBucketName,
    sourceObjectKey: "source.zip",
    problemsCatalog: { "hello-world": "problems/challenges/hello-world" },
    problemsScoring: {},
    problemsEndpoints: {},
    environmentName: "development",
    // eventBusArn を省略 (= Lite mode)
  });
  return Template.fromStack(stack);
});

/**
 * ParticipantPortalLambda 単体 synth (#535 再発防止)。
 *
 * Stack 全体を synth すると `ParticipantPortalHosting` が
 * `apps/participant-portal/dist` の asset を要求し、CI 環境 (= dist 未 build) で
 * fail する。Lambda の env / IAM だけ確認できれば十分なので、Lambda construct を
 * 単体で synth する。
 */
export const synthParticipantPortalLambdaOnly = memoizeTemplate((): Template => {
  const app = new cdk.App({ autoSynth: false });
  const stack = new cdk.Stack(app, "TestStack");
  const deployments = new cdk.aws_dynamodb.Table(stack, "Deployments", {
    partitionKey: { name: "PK", type: cdk.aws_dynamodb.AttributeType.STRING },
    sortKey: { name: "SK", type: cdk.aws_dynamodb.AttributeType.STRING },
  });
  const events = new cdk.aws_dynamodb.Table(stack, "Events", {
    partitionKey: { name: "PK", type: cdk.aws_dynamodb.AttributeType.STRING },
    sortKey: { name: "SK", type: cdk.aws_dynamodb.AttributeType.STRING },
  });
  const endpoints = new cdk.aws_dynamodb.Table(stack, "ProblemEndpoints", {
    partitionKey: { name: "PK", type: cdk.aws_dynamodb.AttributeType.STRING },
    sortKey: { name: "SK", type: cdk.aws_dynamodb.AttributeType.STRING },
  });
  new ParticipantPortalLambda(stack, "ParticipantPortal", {
    deploymentsTable: deployments,
    eventsTable: events,
    endpointsTable: endpoints,
    problemsScoring: {},
    problemsEndpoints: {},
    environmentName: "development",
    // deploy-logs streaming grant の対象 (= codebuild:BatchGetBuilds / logs:GetLogEvents scope)。
    deployCodeBuildProject: Project.fromProjectName(stack, "DeployCodeBuild", "tc-deploy-project"),
  });
  return Template.fromStack(stack);
});

/**
 * Issue #2291: ParticipantPortalLambda 単体 synth で `deployJobLogGroup` を渡した (= deployViaLambda
 * ON 相当の) variant。 Lambda 経路の jobId stream を read する `DeployJobLogsRead` grant +
 * `DEPLOY_JOB_LOG_GROUP` env の付与を検証する。 flag OFF 版は `synthParticipantPortalLambdaOnly`。
 */
export const synthParticipantPortalLambdaOnlyWithJobLogGroup = memoizeTemplate((): Template => {
  const app = new cdk.App({ autoSynth: false });
  const stack = new cdk.Stack(app, "TestStack");
  const deployments = new cdk.aws_dynamodb.Table(stack, "Deployments", {
    partitionKey: { name: "PK", type: cdk.aws_dynamodb.AttributeType.STRING },
    sortKey: { name: "SK", type: cdk.aws_dynamodb.AttributeType.STRING },
  });
  const events = new cdk.aws_dynamodb.Table(stack, "Events", {
    partitionKey: { name: "PK", type: cdk.aws_dynamodb.AttributeType.STRING },
    sortKey: { name: "SK", type: cdk.aws_dynamodb.AttributeType.STRING },
  });
  const endpoints = new cdk.aws_dynamodb.Table(stack, "ProblemEndpoints", {
    partitionKey: { name: "PK", type: cdk.aws_dynamodb.AttributeType.STRING },
    sortKey: { name: "SK", type: cdk.aws_dynamodb.AttributeType.STRING },
  });
  const jobLogGroup = new cdk.aws_logs.LogGroup(stack, "JobLogGroup");
  new ParticipantPortalLambda(stack, "ParticipantPortal", {
    deploymentsTable: deployments,
    eventsTable: events,
    endpointsTable: endpoints,
    problemsScoring: {},
    problemsEndpoints: {},
    environmentName: "development",
    deployCodeBuildProject: Project.fromProjectName(stack, "DeployCodeBuild", "tc-deploy-project"),
    // #2291: Lambda 経路の deploy 進捗を read する read scope。
    deployJobLogGroup: jobLogGroup,
  });
  return Template.fromStack(stack);
});

/**
 * Issue #1420: CoordinationDispatcherLambda 単体 synth。stack 全体 synth は
 * ParticipantPortalHosting の dist asset を要求するため、 IAM (最小権限) / Function URL の検証は
 * construct 単体で行う (= synthParticipantPortalLambdaOnly と同方針)。
 */
export const synthCoordinationDispatcherLambdaOnly = memoizeTemplate((): Template => {
  const app = new cdk.App({ autoSynth: false });
  const stack = new cdk.Stack(app, "TestStack");
  const deployments = new cdk.aws_dynamodb.Table(stack, "Deployments", {
    partitionKey: { name: "PK", type: cdk.aws_dynamodb.AttributeType.STRING },
    sortKey: { name: "SK", type: cdk.aws_dynamodb.AttributeType.STRING },
  });
  const events = new cdk.aws_dynamodb.Table(stack, "Events", {
    partitionKey: { name: "PK", type: cdk.aws_dynamodb.AttributeType.STRING },
    sortKey: { name: "SK", type: cdk.aws_dynamodb.AttributeType.STRING },
  });
  new CoordinationDispatcherLambda(stack, "CoordinationDispatcher", {
    deploymentsTable: deployments,
    eventsTable: events,
    environmentName: "development",
  });
  return Template.fromStack(stack);
});

/**
 * The pure-SQL (`turso`) profile: `ProblemDeployBackendStack` synthesizes no control-data
 * tables at all, so the dispatcher gets none. What it must get instead is the backend
 * triple the repository seam needs to build its SQL executor — without it the seam falls
 * through to the DynamoDB branch and throws on every request, which is what made every
 * coordination-plugin battle report `not_configured` (Issue 486).
 */
export const synthCoordinationDispatcherLambdaPureTurso = memoizeTemplate((): Template => {
  const app = new cdk.App({ autoSynth: false });
  const stack = new cdk.Stack(app, "TestStack");
  const dispatcher = new CoordinationDispatcherLambda(stack, "CoordinationDispatcher", {
    environmentName: "development",
    controlDataBackend: "turso",
    tursoDatabaseUrl: "https://example-db.turso.io",
    tursoAuthTokenParameterName: "/TenkaCloud/development/turso/auth-token",
  });
  // Bound and checked rather than instantiated for its side effect: if the construct ever
  // stops exposing the function, the assertions below would silently test an empty stack.
  if (!dispatcher.fn) throw new Error("CoordinationDispatcherLambda exposed no function");
  return Template.fromStack(stack);
});
