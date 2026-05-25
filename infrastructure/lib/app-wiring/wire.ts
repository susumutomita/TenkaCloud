import * as cdk from "aws-cdk-lib";
import { AdminConsoleHostingStack } from "../admin-console-hosting.js";
import { AdminConsoleRuntimeConfigStack } from "../admin-console-runtime-config-stack.js";
import { AdminConsoleInsightStack } from "../admin-insight/admin-console-insight-stack.js";
import type { AppConfig } from "../app-config/types.js";
import { BootstrapTemplateStack } from "../bootstrap-template/bootstrap-template-stack.js";
import { CodeBuildUseAwsManagedKms } from "../cdk-aspect/codebuild-use-aws-managed-kms.js";
import { DestroyPolicySetter } from "../cdk-aspect/destroy-policy-setter.js";
import { DynamoDbLowCapacity } from "../cdk-aspect/dynamodb-low-capacity.js";
import { KmsKeyShortPendingWindow } from "../cdk-aspect/kms-key-short-pending-window.js";
import { ChallengePayloadStack } from "../challenge-payload/challenge-payload-stack.js";
import { ControlPlaneStack } from "../control-plane-stack.js";
import { ObservabilityStack } from "../observability/cloudwatch-dashboard-stack.js";
import { CostBudget } from "../observability/cost-budget.js";
import { FreeTierAlarms } from "../observability/free-tier-alarms.js";
import type { ParticipantPortalRuntimeConfig } from "../problem-deploy/participant-portal-hosting.js";
import { ProblemDeployBackendStack } from "../problem-deploy/problem-deploy-backend-stack.js";
import { ServerlessSaaSPipeline } from "../tenant-pipeline/serverless-saas-pipeline.js";
import { TenantTemplateStack } from "../tenant-template/tenant-template-stack.js";

/**
 * Issue #766: TenkaCloud の全 stack 配線を 1 つの pure function に集約する。
 *
 * 引数の `AppConfig` は `lib/app-config/resolve.ts` で env から解決済。 本関数は
 * `process.env` を直読みせず、 副作用は CDK の `App` への construct 追加のみ。
 *
 * stack の生成順 + ID + 依存関係は旧 `bin/infrastructure.ts` と完全に揃えて、
 * `cdk synth` 結果が変わらない (= CFn / IAM / Lambda の意図しない CREATE/REPLACE/DELETE
 * を発生させない) ことを invariant とする。
 */
/**
 * Issue #992: 同 AWS account に複数 環境 (development / staging / production) を同居させるために、
 * 全 stack ID に env suffix を付ける。 ただし `development` だけは旧 ID (= suffix 無し) を維持し
 * (= 既存 deploy への影響 0)、 staging / production 等は `-<env>` で区別。
 *
 * CDK の Stack ID は default で physical CFn stackName と一致するため、 ID を変えると stack を
 * 新規作成扱いになる (= 旧 stack は orphan)。 development は default 環境なので互換維持を優先、
 * 他環境は名前空間が分かれることが主目的なので最初から suffix 付きで運用する。
 */
function stackId(base: string, environment: string): string {
  if (environment === "development") return base;
  return `${base}-${environment}`;
}

export function buildTenkaCloudApp(app: cdk.App, config: AppConfig): TenkaCloudAppHandles {
  // Issue #952 / PR-957 user feedback: cost allocation tag を App scope で全リソースに
  // 強制付与する。 名前 prefix 識別ではなく tag で resource ownership を表明することで:
  //   - 同一 AWS account 内に他 workload があっても混ざらない (= cost / drift / cleanup 識別)
  //   - AWS Budgets / Cost Explorer の `TagKeyValue` filter (= `user:Project$TenkaCloud`) で
  //     TenkaCloud 分だけを抽出して予算管理できる
  //   - user は AWS Billing console で 1 回 "Project" tag を "Cost Allocation Tag" として
  //     activate する必要がある (= 既存リソースへの遡及反映には最大 24h)
  cdk.Tags.of(app).add("Project", "TenkaCloud");
  cdk.Tags.of(app).add("Environment", config.environment);

  // App scope Aspect: KMS Key 削除待機期間を `config.kmsPendingWindowInDays` に揃える。
  // SBT が内部生成する CodeBuild EncryptionKey 等も含む全 `AWS::KMS::Key` が対象。
  cdk.Aspects.of(app).add(new KmsKeyShortPendingWindow(config.kmsPendingWindowInDays));

  // SBT BashJobRunner が CodeBuild project artifact 暗号化用に作る customer-managed
  // KMS Key を AWS-managed alias `alias/aws/s3` (無料) に置き換える Aspect (cost cleanup)。
  cdk.Aspects.of(app).add(new CodeBuildUseAwsManagedKms());

  // Issue #1031: admin-console-hosting を最初に立てる (= 依存なし、 wildcard CSP)。
  // 後続 control-plane / admin-console-insight が `distributionDomainName` を cross-stack ref で
  // 受け取る (= adminConsoleOrigin)。 これで install.sh の Phase 1/2/3 の env-var dance を
  // 撤廃でき、 `bun cdk deploy --all` 1 発で全 stack が立つ。
  const adminConsoleHostingStack = new AdminConsoleHostingStack(
    app,
    stackId("tenkacloud-admin-console-hosting", config.environment),
    {
      ...config.stackEnv,
    },
  );
  cdk.Aspects.of(adminConsoleHostingStack).add(new DestroyPolicySetter());
  const adminConsoleOrigin = `https://${adminConsoleHostingStack.distributionDomainName}`;

  const controlPlaneStack = new ControlPlaneStack(
    app,
    stackId("tenkacloud-control-plane", config.environment),
    {
      ...config.stackEnv,
      systemAdminEmail: config.systemAdminEmail,
      adminConsoleOrigin,
      // Issue #1335 Phase 1: opt-in SAML SSO (= 未設定なら空配列で no-op)。
      samlIdps: config.controlPlaneSamlIdps,
      samlAdminAllowlist: config.controlPlaneSamlAdminAllowlist,
    },
  );
  controlPlaneStack.addDependency(adminConsoleHostingStack);

  // SBT が ControlPlane 内部で作る TenantDetails table は default 5/5 (CDK Table の
  // 既定値) なので Free Tier 枠 (25 RCU/WCU) を圧迫する。Aspect で全 CfnTable を
  // dynamoReadCapacity / dynamoWriteCapacity (default 1/1) に揃える。
  cdk.Aspects.of(controlPlaneStack).add(
    new DynamoDbLowCapacity(config.dynamoReadCapacity, config.dynamoWriteCapacity),
  );

  // ADR-003 Phase 2 / catalog split: TenkaCloudChallenge repo の publish.yml が S3 に
  // payload を push するための bucket + OIDC IAM Role を立てる。 config.challengePayload が
  // 設定されていれば stack を立てる (= 旧 env override `CDK_PARAM_CHALLENGE_PAYLOAD_BUCKET`
  // は互換目的で残す = override 優先)。
  const challengePayloadStack = createChallengePayloadStack(app, config);
  const challengePayloadBucketName =
    config.challengePayloadBucketName ?? challengePayloadStack?.bucketName;

  // deploy 順序: ChallengePayloadStack の bucket が先に立ってから ProblemDeployBackend を deploy
  // しないと、 Worker Lambda が起動時に bucket name を IAM policy で参照する経路で
  // race condition が起きる。 explicit dependency で順序を pin。
  const problemDeployBackendStack = new ProblemDeployBackendStack(
    app,
    stackId("tenkacloud-problem-deploy", config.environment),
    {
      ...config.stackEnv,
      eventBusArn: controlPlaneStack.eventBusArn,
      sourceBucketName: config.s3SourceBucket,
      sourceObjectKey: config.sourceZip,
      problemsCatalog: config.problems.catalog as ProblemDeployBackendCatalog,
      problemsScoring: config.problems.scoring as ProblemDeployBackendScoring,
      problemsEndpoints: config.problems.endpoints as ProblemDeployBackendEndpoints,
      problemsPhases: config.problems.phases as ProblemDeployBackendPhases,
      problemsVisibility: config.problems.visibility as ProblemDeployBackendVisibility,
      // Issue #888: per-problem `disruptions[]` を Lambda env に injection
      problemsDisruptions: config.problems.disruptions as Readonly<Record<string, unknown>>,
      ...(challengePayloadBucketName ? { challengePayloadBucketName } : {}),
      participantPortal: config.participantPortal as
        | { runtimeConfig: ParticipantPortalRuntimeConfig | "default-dev-mock" }
        | undefined,
      deployConcurrentBuildLimit: config.deployConcurrentBuildLimit,
      environmentName: config.environment,
    },
  );
  cdk.Aspects.of(problemDeployBackendStack).add(
    new DynamoDbLowCapacity(config.dynamoReadCapacity, config.dynamoWriteCapacity),
  );
  if (challengePayloadStack) {
    problemDeployBackendStack.addDependency(challengePayloadStack);
  }

  // Issue #814 Phase 2: bootstrap を adminConsoleInsight より先に instantiate する。
  // adminConsoleInsight が bootstrap の `deprovisioningStateMachineArn` を受け取り、
  // ListExecutions の IAM scope に使うため (= forward dependency が必要)。
  const bootstrapTemplateStack = new BootstrapTemplateStack(
    app,
    stackId("tenkacloud-bootstrap", config.environment),
    {
      ...config.stackEnv,
      systemAdminEmail: config.systemAdminEmail,
      eventBusArn: controlPlaneStack.eventBusArn,
      apiKeyPlatinumTierParameter: config.apiKeyPlatinumTierParameter,
      apiKeyPremiumTierParameter: config.apiKeyPremiumTierParameter,
      apiKeyStandardTierParameter: config.apiKeyStandardTierParameter,
      apiKeyBasicTierParameter: config.apiKeyBasicTierParameter,
      apiKeySSMParameterNames: config.apiKeySSMParameterNames,
      tenantMappingTableBillingMode: config.dynamoBillingMode,
      tenantMappingTableReadCapacity: config.isDynamoProvisioned
        ? config.dynamoReadCapacity
        : undefined,
      tenantMappingTableWriteCapacity: config.isDynamoProvisioned
        ? config.dynamoWriteCapacity
        : undefined,
    },
  );
  cdk.Aspects.of(bootstrapTemplateStack).add(new DestroyPolicySetter());

  const adminConsoleInsightStack = new AdminConsoleInsightStack(
    app,
    stackId("tenkacloud-admin-console-insight", config.environment),
    {
      ...config.stackEnv,
      cognitoUserPool: controlPlaneStack.cognitoUserPool,
      cognitoUserClientId: controlPlaneStack.cognitoUserClientId,
      deploymentsTable: problemDeployBackendStack.deploymentsTable,
      eventsTable: problemDeployBackendStack.eventsTable,
      teamsTable: problemDeployBackendStack.teamsTable,
      // Issue #1031: cross-stack ref で adminConsoleOrigin を受ける (= 旧 env-var dance 撤廃)。
      adminConsoleOrigin,
      // Issue #814 Phase 2: SBT BashJobRunner の deprovisioning state machine ARN を渡し、
      // admin-insight Lambda が ListExecutions で履歴を引けるようにする。
      deprovisioningStateMachineArn: bootstrapTemplateStack.deprovisioningStateMachineArn,
      // Issue #950 (ADR-020 Phase D): admin audit log table を cross-stack read で渡す
      adminAuditLogTable: problemDeployBackendStack.adminAuditLogTable,
      // Issue #1335 Phase 1: Control Plane UserPool に Pre-Token Generation trigger を attach し、
      // sign-in 成功時に audit 行を書き出す。 UserPool + Audit Table が両方ある stack は本 stack のみ
      // (= Control Plane が UserPool を作り、 ProblemDeploy が audit table を作る、 2 つの cross-stack
      // ref が交わる唯一の stack)。
      environmentName: config.environment,
    },
  );
  adminConsoleInsightStack.addDependency(controlPlaneStack);
  adminConsoleInsightStack.addDependency(problemDeployBackendStack);
  adminConsoleInsightStack.addDependency(bootstrapTemplateStack);

  const tenantTemplateStack = new TenantTemplateStack(
    app,
    stackId(`tenkacloud-tenant-template-${config.tenantId}`, config.environment),
    {
      ...config.stackEnv,
      tenantId: config.tenantId,
      tenantName: config.tenantName,
      environment: config.environment,
      stageName: config.stageName,
      lambdaReserveConcurrency: config.lambdaReserveConcurrency,
      lambdaCanaryDeploymentPreference: config.lambdaCanaryDeploymentPreference,
      isPooledDeploy: config.isPooledDeploy,
      ApiKeySSMParameterNames: config.apiKeySSMParameterNames,
      tenantMappingTable: bootstrapTemplateStack.tenantMappingTable,
      commitId: config.commitId,
      deployApiLambda: problemDeployBackendStack.deployApiLambda,
      eventApiLambda: problemDeployBackendStack.eventApiLambda,
      competitorAccountsApiLambda: problemDeployBackendStack.competitorAccountsApiLambda,
      participantPortalUrl: problemDeployBackendStack.participantPortalUrl,
      // Issue #1053: hosting を ProblemDeployBackendStack に移管したため、 cross-stack ref で
      // URL を受ける。 旧 `CDK_PARAM_COMPETITOR_BOOTSTRAP_TEMPLATE_URL` env-var dance は廃止。
      competitorBootstrapTemplateUrl: problemDeployBackendStack.competitorBootstrapTemplateUrl,
    },
  );
  tenantTemplateStack.addDependency(problemDeployBackendStack);
  tenantTemplateStack.addDependency(bootstrapTemplateStack);
  cdk.Tags.of(tenantTemplateStack).add("TenantId", config.tenantId);
  cdk.Tags.of(tenantTemplateStack).add("IsPooledDeploy", String(config.isPooledDeploy));
  cdk.Aspects.of(tenantTemplateStack).add(new DestroyPolicySetter());

  const serverlessSaaSPipeline = new ServerlessSaaSPipeline(
    app,
    stackId("tenkacloud-saas-pipeline", config.environment),
    {
      ...config.stackEnv,
      appName: config.appNameLower,
      environmentName: config.environment,
      tenantMappingTable: bootstrapTemplateStack.tenantMappingTable,
      s3SourceBucket: config.s3SourceBucket,
      sourceZip: config.sourceZip,
    },
  );
  cdk.Aspects.of(serverlessSaaSPipeline).add(new DestroyPolicySetter());

  const observabilityStack = new ObservabilityStack(
    app,
    stackId("tenkacloud-observability", config.environment),
    {
      ...config.stackEnv,
      environment: config.environment,
      stateMachines: {
        deployCreateArn: problemDeployBackendStack.deployCreateStateMachineArn,
        deployDeleteArn: problemDeployBackendStack.deployDeleteStateMachineArn,
      },
      codeBuildProjectNames: {
        problemDeploy: problemDeployBackendStack.deployCodeBuildProjectName,
        provisioning: serverlessSaaSPipeline.provisioningCodeBuildProjectName,
      },
      dynamoDbTableNames: {
        deployments: problemDeployBackendStack.deploymentsTable.tableName,
        events: problemDeployBackendStack.eventsTable.tableName,
        teams: problemDeployBackendStack.teamsTable.tableName,
        competitorAccounts: problemDeployBackendStack.competitorAccountsTable.tableName,
        problemEndpoints: problemDeployBackendStack.problemEndpointsTable.tableName,
        tenantMappingTable: bootstrapTemplateStack.tenantMappingTable.tableName,
      },
      lambdaFunctionNames: {
        deployApi: problemDeployBackendStack.deployApiLambda.functionName,
        eventApi: problemDeployBackendStack.eventApiLambda.functionName,
        participantPortal: problemDeployBackendStack.participantPortalLambda?.functionName,
        adminInsight: adminConsoleInsightStack.lambdaFunctionName,
        competitorAccounts: problemDeployBackendStack.competitorAccountsApiLambda.functionName,
        externalIdAudit: problemDeployBackendStack.externalIdAuditLambda.functionName,
        genericScoring: problemDeployBackendStack.genericScoringLambda.functionName,
      },
      apiGateways: {
        controlPlane: {
          kind: "http",
          label: "control-plane",
          apiId: apiIdFromExecuteApiUrl(controlPlaneStack.regApiGatewayUrl),
          stage: "$default",
        },
        tenant: {
          kind: "rest",
          label: "tenant",
          apiName: tenantTemplateStack.tenantApiName,
          stage: tenantTemplateStack.tenantApiStageName,
        },
        problemDeploy: {
          kind: "rest",
          label: "problem-deploy",
          apiName: tenantTemplateStack.tenantApiName,
          stage: tenantTemplateStack.tenantApiStageName,
        },
        adminInsight: {
          kind: "http",
          label: "admin-insight",
          apiId: adminConsoleInsightStack.apiId,
          stage: "$default",
        },
      },
    },
  );
  observabilityStack.addDependency(controlPlaneStack);
  observabilityStack.addDependency(problemDeployBackendStack);
  observabilityStack.addDependency(adminConsoleInsightStack);
  observabilityStack.addDependency(bootstrapTemplateStack);
  observabilityStack.addDependency(tenantTemplateStack);
  observabilityStack.addDependency(serverlessSaaSPipeline);

  // Issue #952 epic / cost guardrails: 月次 AWS Budget を立てる。 limit / alarm 通知先は config から。
  // limit が 0 / 未指定なら budget は立てない (= legacy 互換)。
  addCostGuardrails({
    config,
    observabilityStack,
    problemDeployBackendStack,
    adminConsoleInsightStack,
    bootstrapTemplateStack,
    controlPlaneStack,
    tenantTemplateStack,
  });

  // Issue #1031: runtime-config.json を SiteBucket に配置する専用 stack。 全 backend stack の
  // cross-stack ref を集めて 1 ヶ所で runtime-config を組み立てる (= 旧 install.sh phase 2 で
  // env-var 経由していた値を CFn ref に置換)。
  const adminConsoleRuntimeConfigStack = new AdminConsoleRuntimeConfigStack(
    app,
    stackId("tenkacloud-admin-console-runtime-config", config.environment),
    {
      ...config.stackEnv,
      siteBucket: adminConsoleHostingStack.siteBucket,
      distribution: adminConsoleHostingStack.distribution,
      apiUrl: controlPlaneStack.regApiGatewayUrl,
      cognitoDomain: controlPlaneStack.cognitoDomain,
      userClientId: controlPlaneStack.cognitoUserClientId,
      pooledApplicationAdminConsoleUrl: tenantTemplateStack.applicationAdminConsoleUrl,
      provisioningCodeBuildProject: serverlessSaaSPipeline.provisioningCodeBuildProjectName,
      awsRegion: config.awsRegion,
      awsAccountId: config.awsAccountId,
      adminInsightApiUrl: adminConsoleInsightStack.apiUrl,
      competitorBootstrapTemplateUrl: problemDeployBackendStack.competitorBootstrapTemplateUrl,
      cloudWatchDashboardName: observabilityStack.dashboardName,
      // Issue #1335 Phase 1: SAML HRD directory (domain → providerName[])。 admin-console Login が
      // email から候補 IdP を解決して `identity_provider=` を組み立てる (= 公開 metadata、 非秘匿)。
      samlIdpDirectory: controlPlaneStack.samlIdpDirectory,
    },
  );
  adminConsoleRuntimeConfigStack.addDependency(observabilityStack);
  adminConsoleRuntimeConfigStack.addDependency(adminConsoleHostingStack);
  adminConsoleRuntimeConfigStack.addDependency(controlPlaneStack);
  adminConsoleRuntimeConfigStack.addDependency(adminConsoleInsightStack);
  adminConsoleRuntimeConfigStack.addDependency(tenantTemplateStack);
  adminConsoleRuntimeConfigStack.addDependency(serverlessSaaSPipeline);
  adminConsoleRuntimeConfigStack.addDependency(problemDeployBackendStack);
  cdk.Aspects.of(adminConsoleRuntimeConfigStack).add(new DestroyPolicySetter());

  return {
    controlPlaneStack,
    problemDeployBackendStack,
    adminConsoleInsightStack,
    bootstrapTemplateStack,
    tenantTemplateStack,
    serverlessSaaSPipeline,
    observabilityStack,
    adminConsoleHosting: adminConsoleHostingStack,
    adminConsoleRuntimeConfigStack,
  };
}

function createChallengePayloadStack(
  app: cdk.App,
  config: AppConfig,
): ChallengePayloadStack | undefined {
  if (!config.challengePayload || config.challengePayloadBucketName) return undefined;
  const stack = new ChallengePayloadStack(
    app,
    stackId("tenkacloud-challenge-payload", config.environment),
    {
      ...config.stackEnv,
      environmentName: config.environment,
      bucketName: config.challengePayload.bucketName,
      githubRepository: config.challengePayload.githubRepository,
      githubBranches: config.challengePayload.githubBranches,
      ...(config.challengePayload.existingOidcProviderArn
        ? { existingOidcProviderArn: config.challengePayload.existingOidcProviderArn }
        : {}),
      ...(config.challengePayload.noncurrentExpirationDays !== undefined
        ? { noncurrentExpirationDays: config.challengePayload.noncurrentExpirationDays }
        : {}),
    },
  );
  cdk.Aspects.of(stack).add(new DestroyPolicySetter());
  return stack;
}

function addCostGuardrails(args: {
  readonly config: AppConfig;
  readonly observabilityStack: ObservabilityStack;
  readonly problemDeployBackendStack: ProblemDeployBackendStack;
  readonly adminConsoleInsightStack: AdminConsoleInsightStack;
  readonly bootstrapTemplateStack: BootstrapTemplateStack;
  readonly controlPlaneStack: ControlPlaneStack;
  readonly tenantTemplateStack: TenantTemplateStack;
}): void {
  const { config } = args;
  if (!config.monthlyCostLimitUsd || config.monthlyCostLimitUsd <= 0) return;
  const budget = new CostBudget(args.observabilityStack, "CostBudget", {
    budgetNamePrefix: `tenkacloud-${config.environment}`,
    monthlyLimitUsd: config.monthlyCostLimitUsd,
    notificationEmails: Array.from(
      new Set([config.systemAdminEmail, ...(config.budgetAlarmEmails ?? [])]),
    ),
    costAllocationTags: { Project: ["TenkaCloud"] },
  });
  new FreeTierAlarms(args.observabilityStack, "FreeTierAlarms", {
    notificationTopic: budget.topic,
    lambdaFunctionNames: freeTierLambdaNames(args),
    dynamoDbTableNames: freeTierTableNames(args),
    apiGateways: freeTierApiGateways(args),
  });
}

function freeTierLambdaNames(args: {
  readonly problemDeployBackendStack: ProblemDeployBackendStack;
  readonly adminConsoleInsightStack: AdminConsoleInsightStack;
}): string[] {
  const problem = args.problemDeployBackendStack;
  return [
    problem.deployApiLambda.functionName,
    problem.eventApiLambda.functionName,
    args.adminConsoleInsightStack.lambdaFunctionName,
    problem.competitorAccountsApiLambda.functionName,
    problem.externalIdAuditLambda.functionName,
    problem.genericScoringLambda.functionName,
    ...(problem.participantPortalLambda ? [problem.participantPortalLambda.functionName] : []),
  ];
}

function freeTierTableNames(args: {
  readonly problemDeployBackendStack: ProblemDeployBackendStack;
  readonly bootstrapTemplateStack: BootstrapTemplateStack;
}): string[] {
  const problem = args.problemDeployBackendStack;
  return [
    problem.deploymentsTable.tableName,
    problem.eventsTable.tableName,
    problem.teamsTable.tableName,
    problem.competitorAccountsTable.tableName,
    problem.problemEndpointsTable.tableName,
    args.bootstrapTemplateStack.tenantMappingTable.tableName,
  ];
}

function freeTierApiGateways(args: {
  readonly controlPlaneStack: ControlPlaneStack;
  readonly tenantTemplateStack: TenantTemplateStack;
  readonly adminConsoleInsightStack: AdminConsoleInsightStack;
}): ConstructorParameters<typeof FreeTierAlarms>[2]["apiGateways"] {
  return [
    {
      kind: "http",
      label: "control-plane",
      apiId: apiIdFromExecuteApiUrl(args.controlPlaneStack.regApiGatewayUrl),
      stage: "$default",
    },
    {
      kind: "rest",
      label: "tenant",
      apiName: args.tenantTemplateStack.tenantApiName,
      stage: args.tenantTemplateStack.tenantApiStageName,
    },
    {
      kind: "http",
      label: "admin-insight",
      apiId: args.adminConsoleInsightStack.apiId,
      stage: "$default",
    },
  ];
}

export interface TenkaCloudAppHandles {
  readonly controlPlaneStack: ControlPlaneStack;
  readonly problemDeployBackendStack: ProblemDeployBackendStack;
  readonly adminConsoleInsightStack: AdminConsoleInsightStack;
  readonly bootstrapTemplateStack: BootstrapTemplateStack;
  readonly tenantTemplateStack: TenantTemplateStack;
  readonly serverlessSaaSPipeline: ServerlessSaaSPipeline;
  readonly observabilityStack: ObservabilityStack;
  readonly adminConsoleHosting: AdminConsoleHostingStack;
  /** Issue #1031: runtime-config.json を SiteBucket に配置する専用 stack (= 旧 install.sh phase 2 を置換)。 */
  readonly adminConsoleRuntimeConfigStack: AdminConsoleRuntimeConfigStack;
}

const apiIdFromExecuteApiUrl = (apiUrl: string): string =>
  cdk.Fn.select(0, cdk.Fn.split(".", cdk.Fn.select(2, cdk.Fn.split("/", apiUrl))));

// The `unknown` parts of ProblemsCatalogBundle map to the (unexported) prop types of
// ProblemDeployBackendStack. They are intentionally widened in the AppConfig surface
// (= app-config has no dependency on the construct's prop types) and re-narrowed here
// at the consumer boundary. The cast is structurally safe because both sides originate
// from the same `discoverProblems*` outputs.
type ProblemDeployBackendCatalog = ConstructorParameters<
  typeof ProblemDeployBackendStack
>[2]["problemsCatalog"];
type ProblemDeployBackendScoring = ConstructorParameters<
  typeof ProblemDeployBackendStack
>[2]["problemsScoring"];
type ProblemDeployBackendEndpoints = ConstructorParameters<
  typeof ProblemDeployBackendStack
>[2]["problemsEndpoints"];
type ProblemDeployBackendPhases = ConstructorParameters<
  typeof ProblemDeployBackendStack
>[2]["problemsPhases"];
type ProblemDeployBackendVisibility = ConstructorParameters<
  typeof ProblemDeployBackendStack
>[2]["problemsVisibility"];
