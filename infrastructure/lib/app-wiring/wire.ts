import * as cdk from "aws-cdk-lib";
import { AdminConsoleHostingStack } from "../admin-console-hosting";
import { AdminConsoleInsightStack } from "../admin-insight/admin-console-insight-stack";
import type { AppConfig } from "../app-config/types";
import { BootstrapTemplateStack } from "../bootstrap-template/bootstrap-template-stack";
import { CodeBuildUseAwsManagedKms } from "../cdk-aspect/codebuild-use-aws-managed-kms";
import { DestroyPolicySetter } from "../cdk-aspect/destroy-policy-setter";
import { DynamoDbLowCapacity } from "../cdk-aspect/dynamodb-low-capacity";
import { KmsKeyShortPendingWindow } from "../cdk-aspect/kms-key-short-pending-window";
import { ControlPlaneStack } from "../control-plane-stack";
import { ObservabilityStack } from "../observability/cloudwatch-dashboard-stack";
import type { ParticipantPortalRuntimeConfig } from "../problem-deploy/participant-portal-hosting";
import { ProblemDeployBackendStack } from "../problem-deploy/problem-deploy-backend-stack";
import { ServerlessSaaSPipeline } from "../tenant-pipeline/serverless-saas-pipeline";
import { TenantTemplateStack } from "../tenant-template/tenant-template-stack";

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
export function buildTenkaCloudApp(app: cdk.App, config: AppConfig): TenkaCloudAppHandles {
  // App scope Aspect: KMS Key 削除待機期間を `config.kmsPendingWindowInDays` に揃える。
  // SBT が内部生成する CodeBuild EncryptionKey 等も含む全 `AWS::KMS::Key` が対象。
  cdk.Aspects.of(app).add(new KmsKeyShortPendingWindow(config.kmsPendingWindowInDays));

  // SBT BashJobRunner が CodeBuild project artifact 暗号化用に作る customer-managed
  // KMS Key を AWS-managed alias `alias/aws/s3` (無料) に置き換える Aspect (cost cleanup)。
  cdk.Aspects.of(app).add(new CodeBuildUseAwsManagedKms());

  const controlPlaneStack = new ControlPlaneStack(app, "tenkacloud-control-plane", {
    ...config.stackEnv,
    systemAdminEmail: config.systemAdminEmail,
  });

  // SBT が ControlPlane 内部で作る TenantDetails table は default 5/5 (CDK Table の
  // 既定値) なので Free Tier 枠 (25 RCU/WCU) を圧迫する。Aspect で全 CfnTable を
  // dynamoReadCapacity / dynamoWriteCapacity (default 1/1) に揃える。
  cdk.Aspects.of(controlPlaneStack).add(
    new DynamoDbLowCapacity(config.dynamoReadCapacity, config.dynamoWriteCapacity),
  );

  const problemDeployBackendStack = new ProblemDeployBackendStack(
    app,
    "tenkacloud-problem-deploy",
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
      ...(config.challengePayloadBucketName
        ? { challengePayloadBucketName: config.challengePayloadBucketName }
        : {}),
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

  const adminConsoleInsightStack = new AdminConsoleInsightStack(
    app,
    "tenkacloud-admin-console-insight",
    {
      ...config.stackEnv,
      cognitoUserPool: controlPlaneStack.cognitoUserPool,
      cognitoUserClientId: controlPlaneStack.cognitoUserClientId,
      deploymentsTable: problemDeployBackendStack.deploymentsTable,
      eventsTable: problemDeployBackendStack.eventsTable,
      teamsTable: problemDeployBackendStack.teamsTable,
      adminConsoleOrigin: config.adminConsoleOriginForCors,
    },
  );
  adminConsoleInsightStack.addDependency(controlPlaneStack);
  adminConsoleInsightStack.addDependency(problemDeployBackendStack);

  const bootstrapTemplateStack = new BootstrapTemplateStack(app, "tenkacloud-bootstrap", {
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
  });
  cdk.Aspects.of(bootstrapTemplateStack).add(new DestroyPolicySetter());

  const tenantTemplateStack = new TenantTemplateStack(
    app,
    `tenkacloud-tenant-template-${config.tenantId}`,
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
      competitorBootstrapTemplateUrl: config.competitorBootstrapTemplateUrlEnv,
    },
  );
  tenantTemplateStack.addDependency(problemDeployBackendStack);
  tenantTemplateStack.addDependency(bootstrapTemplateStack);
  cdk.Tags.of(tenantTemplateStack).add("TenantId", config.tenantId);
  cdk.Tags.of(tenantTemplateStack).add("IsPooledDeploy", String(config.isPooledDeploy));
  cdk.Aspects.of(tenantTemplateStack).add(new DestroyPolicySetter());

  const serverlessSaaSPipeline = new ServerlessSaaSPipeline(app, "tenkacloud-saas-pipeline", {
    ...config.stackEnv,
    appName: config.appNameLower,
    environmentName: config.environment,
    tenantMappingTable: bootstrapTemplateStack.tenantMappingTable,
    s3SourceBucket: config.s3SourceBucket,
    sourceZip: config.sourceZip,
  });
  cdk.Aspects.of(serverlessSaaSPipeline).add(new DestroyPolicySetter());

  const observabilityStack = new ObservabilityStack(app, "tenkacloud-observability", {
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
  });
  observabilityStack.addDependency(controlPlaneStack);
  observabilityStack.addDependency(problemDeployBackendStack);
  observabilityStack.addDependency(adminConsoleInsightStack);
  observabilityStack.addDependency(bootstrapTemplateStack);
  observabilityStack.addDependency(tenantTemplateStack);
  observabilityStack.addDependency(serverlessSaaSPipeline);

  let adminConsoleHosting: AdminConsoleHostingStack | undefined;
  if (config.adminConsoleHostingInputs) {
    adminConsoleHosting = new AdminConsoleHostingStack(app, "tenkacloud-admin-console-hosting", {
      ...config.stackEnv,
      apiUrl: config.adminConsoleHostingInputs.apiUrl,
      cognitoDomain: config.adminConsoleHostingInputs.cognitoDomain,
      userClientId: config.adminConsoleHostingInputs.userClientId,
      pooledApplicationAdminConsoleUrl:
        config.adminConsoleHostingInputs.pooledApplicationAdminConsoleUrl,
      provisioningCodeBuildProject: config.adminConsoleHostingInputs.provisioningCodeBuildProject,
      awsRegion: config.awsRegion,
      awsAccountId: config.awsAccountId,
      adminInsightApiUrl: config.adminConsoleHostingInputs.adminInsightApiUrl,
    });
    cdk.Aspects.of(adminConsoleHosting).add(new DestroyPolicySetter());
  }

  return {
    controlPlaneStack,
    problemDeployBackendStack,
    adminConsoleInsightStack,
    bootstrapTemplateStack,
    tenantTemplateStack,
    serverlessSaaSPipeline,
    observabilityStack,
    adminConsoleHosting,
  };
}

export interface TenkaCloudAppHandles {
  readonly controlPlaneStack: ControlPlaneStack;
  readonly problemDeployBackendStack: ProblemDeployBackendStack;
  readonly adminConsoleInsightStack: AdminConsoleInsightStack;
  readonly bootstrapTemplateStack: BootstrapTemplateStack;
  readonly tenantTemplateStack: TenantTemplateStack;
  readonly serverlessSaaSPipeline: ServerlessSaaSPipeline;
  readonly observabilityStack: ObservabilityStack;
  readonly adminConsoleHosting: AdminConsoleHostingStack | undefined;
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
