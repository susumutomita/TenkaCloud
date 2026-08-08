import * as cdk from "aws-cdk-lib";
import { AdminConsoleHostingStack } from "../admin-console-hosting.js";
import { AdminConsoleRuntimeConfigStack } from "../admin-console-runtime-config-stack.js";
import { AdminConsoleInsightStack } from "../admin-insight/admin-console-insight-stack.js";
import type { AppConfig } from "../app-config/types.js";
import { BootstrapTemplateStack } from "../bootstrap-template/bootstrap-template-stack.js";
import { DestroyPolicySetter } from "../cdk-aspect/destroy-policy-setter.js";
import { ChallengePayloadStack } from "../challenge-payload/challenge-payload-stack.js";
import { ControlPlaneStack } from "../control-plane-stack.js";
import { ObservabilityStack } from "../observability/cloudwatch-dashboard-stack.js";
import type { ParticipantPortalRuntimeConfig } from "../problem-deploy/participant-portal-hosting.js";
import { ProblemDeployBackendStack } from "../problem-deploy/problem-deploy-backend-stack.js";
import { ServerlessSaaSPipeline } from "../tenant-pipeline/serverless-saas-pipeline.js";
import { TenantTemplateStack } from "../tenant-template/tenant-template-stack.js";
import { buildProblemDeployBackendBaseProps } from "./problem-deploy-backend-props.js";
import { applyDynamoLowCapacity, applyGlobalAspects } from "./wire/aspects.js";
import { registerStackDependencies } from "./wire/dependencies.js";
import { addCostGuardrails, apiIdFromExecuteApiUrl } from "./wire/guardrails.js";

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
  // App scope の global Tags / Aspects (cost allocation tag / KMS pending window / CodeBuild KMS)
  // を最初に付与する (= 全 stack の CFn template に波及するため stack 生成より前)。詳細は wire/aspects.ts。
  applyGlobalAspects(app, config);

  // Issue #1031: admin-console-hosting を最初に立てる (= 依存なし、 wildcard CSP)。
  // 後続 control-plane / admin-console-insight が `distributionDomainName` を cross-stack ref で
  // 受け取る (= adminConsoleOrigin)。 これで install.sh の Phase 1/2/3 の env-var dance を
  // 撤廃でき、 `bun run cdk -- deploy --all` 1 発で全 stack が立つ。
  const adminConsoleHostingStack = new AdminConsoleHostingStack(
    app,
    stackId("tenkacloud-admin-console-hosting", config.environment),
    {
      ...config.stackEnv,
      // Issue #1695: config.json に customDomains.adminConsole があれば TLS 1.2 を強制 (opt-in)。
      customDomain: config.customDomains?.adminConsole,
    },
  );
  // Issue #2960 x #2959: `retainDataTables` を選んだ利用者の意思を Aspect が握り潰さない
  // ための除外 type。CDK 既定の RETAIN と明示 RETAIN は cfnOptions では区別できないので、
  // config を知っている側 (ここ) が type で名指しする。
  const destroyPolicySkipTypes = config.retainDataTables ? ["AWS::DynamoDB::Table"] : [];
  const destroyPolicySetter = () =>
    new DestroyPolicySetter({ skipResourceTypes: destroyPolicySkipTypes });

  cdk.Aspects.of(adminConsoleHostingStack).add(destroyPolicySetter());
  const adminConsoleOrigin = `https://${adminConsoleHostingStack.distributionDomainName}`;

  const controlPlaneStack = new ControlPlaneStack(
    app,
    stackId("tenkacloud-control-plane", config.environment),
    {
      ...config.stackEnv,
      systemAdminEmail: config.systemAdminEmail,
      adminConsoleOrigin,
      // Issue #1993: System Admin ログインの Cognito カスタムドメイン (未設定なら NO-OP)。
      loginCustomDomain: config.customDomains?.controlPlaneLogin,
      // Issue #1335 Phase 1: opt-in SAML SSO (= 未設定なら空配列で no-op)。
      samlIdps: config.controlPlaneSamlIdps,
      samlAdminAllowlist: config.controlPlaneSamlAdminAllowlist,
      // #2941: `/admin/idp` CRUD Lambda の repository seam backend。 default "dynamodb" では
      // system scope の SamlIdpsTable を synth し、 turso では table を作らず SQL executor 直結。
      controlDataBackend: config.controlDataBackend,
      retainDataTables: config.retainDataTables,
      tursoDatabaseUrl: config.tursoDatabaseUrl,
      tursoAuthTokenParameterName: config.tursoAuthTokenParameterName,
    },
  );
  // Issue #2960: destroy 後に CDK 既定 RETAIN の resource (LogGroup / UserPool / Bucket) が
  // 残り、log group だけで 48 個が孤児になっていた。 Aspect は明示 Retain を尊重するので
  // (#2959 の opt-in と両立する)、 全 stack に当てて既定 RETAIN の取りこぼしを塞ぐ。
  cdk.Aspects.of(controlPlaneStack).add(destroyPolicySetter());

  // SBT が ControlPlane 内部で作る TenantDetails table は default 5/5 (CDK Table の
  // 既定値) なので Free Tier 枠 (25 RCU/WCU) を圧迫する。Aspect で全 CfnTable を
  // dynamoReadCapacity / dynamoWriteCapacity (default 1/1) に揃える。
  applyDynamoLowCapacity(controlPlaneStack, config, {
    // SBT 0.9.5 hard-codes only this new internal table to PAY_PER_REQUEST. TenkaCloud's
    // PROVISIONED environments convert that exact construct path to configured capacity.
    convertSbtTenantRegistrationTable: config.isDynamoProvisioned,
  });

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
  // Issue #2209: source bundle + problems.* の共通 props は Lite (bin/tenkacloud-lite.ts) と
  // 共有の factory に集約。 SaaS 固有の差分 (eventBusArn / quota / portal / challenge bucket)
  // だけをここで足す。
  const problemDeployBackendStack = new ProblemDeployBackendStack(
    app,
    stackId("tenkacloud-problem-deploy", config.environment),
    {
      ...config.stackEnv,
      ...buildProblemDeployBackendBaseProps(config),
      eventBusArn: controlPlaneStack.eventBusArn,
      ...(challengePayloadBucketName ? { challengePayloadBucketName } : {}),
      participantPortal: config.participantPortal as
        | { runtimeConfig: ParticipantPortalRuntimeConfig | "default-dev-mock" }
        | undefined,
      // #1766: tier 別の同時デプロイ上限 (未設定ならクォータ無効)。
      deployQuotaByTier: config.deployQuotaByTier,
    },
  );
  applyDynamoLowCapacity(problemDeployBackendStack, config);
  // Issue #2960: destroy 後に CDK 既定 RETAIN の resource (LogGroup / UserPool / Bucket) が
  // 残り、log group だけで 48 個が孤児になっていた。 Aspect は明示 Retain を尊重するので
  // (#2959 の opt-in と両立する)、 全 stack に当てて既定 RETAIN の取りこぼしを塞ぐ。
  cdk.Aspects.of(problemDeployBackendStack).add(destroyPolicySetter());

  // Issue #814 Phase 2: bootstrap を adminConsoleInsight より先に instantiate する。
  // adminConsoleInsight が bootstrap の `deprovisioningStateMachineArn` を受け取り、
  // ListExecutions の IAM scope に使うため (= forward dependency が必要)。
  const bootstrapTemplateStack = new BootstrapTemplateStack(
    app,
    stackId("tenkacloud-bootstrap", config.environment),
    {
      ...config.stackEnv,
      systemAdminEmail: config.systemAdminEmail,
      // #2194: the resolved (per-environment) source bucket name, so the tenant
      // provision/deprovision ScriptJobs read the exact bucket the deploy created
      // instead of recomputing a divergent name.
      sourceBucketName: config.s3SourceBucket,
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
  cdk.Aspects.of(bootstrapTemplateStack).add(destroyPolicySetter());

  const tenantTemplateStack = new TenantTemplateStack(
    app,
    stackId(`tenkacloud-tenant-template-${config.tenantId}`, config.environment),
    {
      ...config.stackEnv,
      tenantId: config.tenantId,
      tenantName: config.tenantName,
      environment: config.environment,
      // Issue #1993 / #1994: tenant (pooled / silo) ログインの Cognito カスタムドメイン (未設定で NO-OP)。
      loginCustomDomain: config.customDomains?.applicationLogin,
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
      // Issue #1340 Phase 2: opt-in per-tenant SAML SSO (= 未設定なら空配列で no-op)。
      // pooled tier では本 props を受けても TenantTemplateStack が `isPooledDeploy` で
      // ignore するため、 pooled / silo どちらでも同 env を渡してよい (ADR-018 と整合)。
      samlIdps: config.tenantSamlIdps,
      samlAdminAllowlist: config.tenantSamlAdminAllowlist,
      // Issue #2230 (ADR-035): deploy 時 feature flag override を runtime-config に焼く。
      features: config.features,
    },
  );
  cdk.Tags.of(tenantTemplateStack).add("TenantId", config.tenantId);
  cdk.Tags.of(tenantTemplateStack).add("IsPooledDeploy", String(config.isPooledDeploy));
  cdk.Aspects.of(tenantTemplateStack).add(destroyPolicySetter());

  // Issue #1340 Phase 2: tenant SAML が有効なときだけ per-tenant SignInAuditLambda を立てる
  // (= 未設定 / pooled tier 経路では空配列 → AdminConsoleInsightStack は何も attach しない、
  // 既存 stack の CFn 物理差分 0 件)。 silo / Lite 経路で SAML が attach されたときのみ
  // tenantUserPoolId を渡し、 `TENANT#<tenantId>` partition に書く Lambda を集約する。
  const tenantSignInAudit =
    config.tenantSamlIdps.length > 0 && !config.isPooledDeploy
      ? [{ tenantId: config.tenantId, userPoolId: tenantTemplateStack.tenantUserPoolId }]
      : undefined;

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
      provisioningStateMachineArn: bootstrapTemplateStack.provisioningStateMachineArn,
      // Issue #950 (ADR-020 Phase D): admin audit log table を cross-stack read で渡す
      adminAuditLogTable: problemDeployBackendStack.adminAuditLogTable,
      // Issue #2311: 監査ログ feature flag を admin-insight / sign-in-audit Lambda 群へ伝播。
      auditLogEnabled: config.auditLogEnabled,
      // Issue #1335 Phase 1: Control Plane UserPool に Pre-Token Generation trigger を attach し、
      // sign-in 成功時に audit 行を書き出す。 UserPool + Audit Table が両方ある stack は本 stack のみ
      // (= Control Plane が UserPool を作り、 ProblemDeploy が audit table を作る、 2 つの cross-stack
      // ref が交わる唯一の stack)。
      environmentName: config.environment,
      // Issue #1340 Phase 2: tenant SAML 有効時のみ per-tenant audit Lambda を集約配線する。
      ...(tenantSignInAudit ? { tenantSignInAudit } : {}),
      // Issue #1431: in-console cost panel。 CostBudget は addCostGuardrails で
      // `monthlyCostLimitUsd > 0` のときだけ `tenkacloud-<env>-monthly-cost` という名前で作られる。
      // 同じ条件のときだけ budget 名を渡し、 admin-insight Lambda が DescribeBudget (無料) で読む。
      ...(config.monthlyCostLimitUsd && config.monthlyCostLimitUsd > 0
        ? { costBudgetName: `tenkacloud-${config.environment}-monthly-cost` }
        : {}),
      // [#2461] control-plane data backend を admin-insight Lambda にも届ける (= EventApiLambda /
      // ProblemDeployBackendStack と同型)。 default "dynamodb" + turso URL 未設定なら Lambda env を
      // 足さず SSM policy も付かないので CFn byte 互換 (= 既存 stack テストが pin 済み)。 turso 選択時
      // のみ admin-insight Lambda に CONTROL_DATA_BACKEND env + SSM GetParameter policy が UPDATE される。
      controlDataBackend: config.controlDataBackend,
      tursoDatabaseUrl: config.tursoDatabaseUrl,
      tursoAuthTokenParameterName: config.tursoAuthTokenParameterName,
    },
  );
  // Issue #2960: destroy 後に CDK 既定 RETAIN の resource (LogGroup / UserPool / Bucket) が
  // 残り、log group だけで 48 個が孤児になっていた。 Aspect は明示 Retain を尊重するので
  // (#2959 の opt-in と両立する)、 全 stack に当てて既定 RETAIN の取りこぼしを塞ぐ。
  cdk.Aspects.of(adminConsoleInsightStack).add(destroyPolicySetter());

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
  cdk.Aspects.of(serverlessSaaSPipeline).add(destroyPolicySetter());

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
        // Issue #2441: 純 SQL backend では Deployments table 自体が無い (= undefined)。
        deployments: problemDeployBackendStack.deploymentsTable?.tableName,
        // Issue #2440: 純 SQL backend では Events/Teams table 自体が無い (= undefined)。
        events: problemDeployBackendStack.eventsTable?.tableName,
        teams: problemDeployBackendStack.teamsTable?.tableName,
        // Issue #2442: 純 SQL backend では CompetitorAccounts table 自体が無い (= undefined)。
        competitorAccounts: problemDeployBackendStack.competitorAccountsTable?.tableName,
        // Issue #2442: 純 SQL backend では ProblemEndpoints table 自体が無い (= undefined)。
        problemEndpoints: problemDeployBackendStack.problemEndpointsTable?.tableName,
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
        // Issue #2291: Lambda deploy path の CfnDeploy 関数名 (= deployViaLambda ON のときだけ存在)。
        // undefined (flag OFF / CodeBuild 経路) なら key を足さず dashboard は byte 互換 (default-safe)。
        ...(problemDeployBackendStack.cfnDeployLambdaName
          ? { cfnDeploy: problemDeployBackendStack.cfnDeployLambdaName }
          : {}),
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
  // Issue #2960: destroy 後に CDK 既定 RETAIN の resource (LogGroup / UserPool / Bucket) が
  // 残り、log group だけで 48 個が孤児になっていた。 Aspect は明示 Retain を尊重するので
  // (#2959 の opt-in と両立する)、 全 stack に当てて既定 RETAIN の取りこぼしを塞ぐ。
  cdk.Aspects.of(observabilityStack).add(destroyPolicySetter());

  // Issue #952 epic / cost guardrails: 月次 AWS Budget を立てる。 limit / alarm 通知先は config から。
  // limit が 0 / 未指定なら budget は立てない (= legacy 互換)。詳細は wire/guardrails.ts。
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
      // Issue #2230 (ADR-035): deploy 時 feature flag override (admin-console 側 registry 用)。
      features: config.features,
    },
  );
  cdk.Aspects.of(adminConsoleRuntimeConfigStack).add(destroyPolicySetter());

  // 全 stack を生成し終えた後で deploy 順序の `addDependency()` 群を 1 ヶ所に集約適用する。
  // 旧コードは各 stack 生成直後に inline で呼んでいたが、 同じ依存 edge を同じ順で張るため
  // CFn manifest は byte 一致のまま (= 物理差分 0 件)。詳細は wire/dependencies.ts。
  registerStackDependencies({
    adminConsoleHostingStack,
    controlPlaneStack,
    challengePayloadStack,
    problemDeployBackendStack,
    bootstrapTemplateStack,
    tenantTemplateStack,
    adminConsoleInsightStack,
    serverlessSaaSPipeline,
    observabilityStack,
    adminConsoleRuntimeConfigStack,
  });

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
  // この stack は DynamoDB table を持たないが、除外条件は 1 箇所から導出しておく
  // (将来 table が増えたときに、ここだけ #2959 の opt-in を無視する状態を作らない)。
  cdk.Aspects.of(stack).add(
    new DestroyPolicySetter({
      skipResourceTypes: config.retainDataTables ? ["AWS::DynamoDB::Table"] : [],
    }),
  );
  return stack;
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
