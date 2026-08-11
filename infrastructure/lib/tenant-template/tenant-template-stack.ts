import { CfnOutput, Stack, type StackProps } from "aws-cdk-lib";
import type { Table } from "aws-cdk-lib/aws-dynamodb";
import type { IFunction } from "aws-cdk-lib/aws-lambda";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import {
  AwsCustomResource,
  AwsCustomResourcePolicy,
  PhysicalResourceId,
} from "aws-cdk-lib/custom-resources";
import type { Construct } from "constructs";
import { isMachineTokenPathEnabled } from "../app-config/index.js";
import { buildAppPlaneCore } from "../app-plane-core/index.js";
import type { ApiKeySSMParameterNames } from "../interfaces/api-key-ssm-parameter-names.js";
import {
  bindScope,
  capabilityScope,
  MACHINE_CAPABILITIES,
} from "../problem-deploy/handlers/shared/machine-scopes.js";
import type { CustomDomainConfig } from "../security/cloudfront-custom-domain.js";
import { deploymentLogGroup } from "../utils/deployment-log-group.js";
import { MachineApiGateway } from "./machine-api-gateway.js";
import { MachineIdentity } from "./machine-identity.js";
import type { SamlIdpConfig } from "./saml-identity-providers.js";

interface TenantTemplateStackProps extends StackProps {
  stageName: string;
  lambdaReserveConcurrency: number;
  lambdaCanaryDeploymentPreference: string;
  isPooledDeploy: boolean;
  ApiKeySSMParameterNames: ApiKeySSMParameterNames;
  tenantId: string;
  /**
   * 画面表示用のテナント名 (admin-console から POST /tenants 時に入力された名前)。
   * runtime-config.json 経由で application-admin-console に渡し、HomePage 等で表示する。
   */
  tenantName: string;
  /**
   * 環境名 (development / staging / production など)。
   * Cognito UserPool domain prefix の region globally unique 制約を満たすために
   * tenantId / accountId と組み合わせて使う。
   */
  environment: string;
  /** Issue #1993 / #1994: tenant ログイン用 Cognito カスタムドメイン (任意、 未設定で NO-OP)。 */
  loginCustomDomain?: CustomDomainConfig;
  tenantMappingTable: Table;
  commitId: string;
  waveNumber?: string;
  /**
   * `ProblemDeployBackendStack.deployApiLambda` をクロススタック参照で受ける。
   * tenant API の Cognito-gated routes (`POST /problems/:id/deploy` 等) が本 Lambda を
   * `LambdaIntegration` で invoke する (Issue #458)。
   */
  deployApiLambda: IFunction;
  /**
   * `ProblemDeployBackendStack.eventApiLambda` をクロススタック参照で受ける。
   * tenant API の `/events*` routes が本 Lambda を invoke する。
   */
  eventApiLambda: IFunction;
  /**
   * `ProblemDeployBackendStack.competitorAccountsApiLambda` をクロススタック参照で受ける
   * (Issue #459)。tenant API の `/admin/competitor-accounts*` routes が
   * 本 Lambda を invoke する。
   */
  competitorAccountsApiLambda: IFunction;
  /**
   * Participant Portal の CloudFront URL。`ProblemDeployBackendStack` の
   * `participantPortalUrl` をクロススタック参照で受け、application-admin-console の
   * runtime-config.json に注入する (operator が EventDetail 等で「Portal URL を共有」
   * できるようにするため)。Participant Portal が無効化された tenant では undefined。
   */
  participantPortalUrl?: string;
  /**
   * #718: 競技者向け CFn bootstrap template (competitor-bootstrap.yaml) の public S3 URL。
   * #1053 で hosting が `ProblemDeployBackendStack` へ移り、 wire.ts が同 stack の
   * `competitorBootstrapTemplateUrl` をクロススタック参照で渡す。 値は application-admin-console
   * の runtime-config に注入される。
   * optional なのは problem-deploy を配線しない構成 (= 本 stack を直接 instantiate する unit
   * test) のためで、 install.sh の deploy では常に cross-stack ref が入る (#1031 で Phase 1/2/3
   * の再 deploy dance は廃止済み)。
   */
  competitorBootstrapTemplateUrl?: string;
  /**
   * Issue #1340 Phase 2: opt-in で attach する per-tenant SAML IdP 群 (= env `TENANT_SAML_IDPS`
   * を bin/infrastructure → app-config で parse 済の正規化 list)。 未指定 / 空配列なら従来
   * Cognito local auth + MFA 強制のみ。 設定時のみ allowlist が動く。
   *
   * **Pooled tier:** BASIC / STANDARD / PREMIUM は UserPool を全 pooled tenant が
   * 共有するため、 SAML attach は他 tenant に副作用を及ぼす。 本 stack は `isPooledDeploy=true`
   * のとき samlIdps を ignore し、 silo (PLATINUM) instance / Lite mode のみ attach する。
   */
  samlIdps?: readonly SamlIdpConfig[];
  /**
   * Issue #1340 Phase 2: per-tenant federated 管理者 allowlist (`provider/email`)。
   * `samlIdps` 設定時のみ意味を持つ。 空配列 = federated sign-in 全拒否 (fail-safe)。
   */
  samlAdminAllowlist?: readonly string[];
  /** Issue #2230: runtime-config.json に焼く SPA feature flag override (未設定 = key なし)。 */
  features?: Readonly<Record<string, boolean>>;
}

export class TenantTemplateStack extends Stack {
  /** Tenant REST API ID for execute-api references. */
  public readonly tenantApiId: string;
  /** Tenant REST API name for REST API CloudWatch metrics. */
  public readonly tenantApiName: string;
  /** Tenant REST API deployment stage name for CloudWatch metrics. */
  public readonly tenantApiStageName: string;
  /**
   * Issue #1031: pooled tenant が共有する application-admin-console の CloudFront URL。
   * `AdminConsoleRuntimeConfigStack` が runtime-config.json の `pooledApplicationAdminConsoleUrl`
   * field に焼き込む cross-stack ref として使う。 silo (PLATINUM) instance も同 field を持つが、
   * admin-console は pooled URL のみを runtime-config 経由で表示する。
   */
  public readonly applicationAdminConsoleUrl: string;
  /**
   * Issue #1340 Phase 2: tenant UserPool ID (= 文字列、 cross-stack ref で sign-in audit Lambda
   * の EventBridge rule filter に渡す)。 audit Lambda は CloudTrail Cognito events を default
   * EventBridge bus 経由で listen するため、 UserPool 構造体への直接 ref は持たない (= cross-stack
   * の cyclic 依存を回避)。
   */
  public readonly tenantUserPoolId: string;
  /**
   * Issue #1340 Phase 2: per-tenant SAML HRD directory (domain → providerName[])。 SAML 未設定
   * なら空 object。 既に `runtime-config.json` に焼かれて Login が読むため stack 外に公開する
   * 必要は無いが、 cross-stack 配線テスト / audit 用に expose しておく。
   */
  public readonly samlIdpDirectory: Readonly<Record<string, readonly string[]>>;

  constructor(scope: Construct, id: string, props: TenantTemplateStackProps) {
    super(scope, id, props);
    const waveNumber = props.waveNumber || "1";

    // Issue #778: App Plane コア構成 (hosting + identity + apiGateway +
    // runtime-config 配置) は `buildAppPlaneCore` builder に切り出して Lite mode と共有する。
    // CFn 物理差分 0 件 invariant のため、 sub-construct は同 stack scope に同 logical ID で
    // 生成される (= Stack/ApplicationAdminConsoleHosting / Stack/IdentityProvider / Stack/ApiGateway)。
    //
    // 順序の意図: hosting → identity → apiGateway → hosting.deployRuntimeConfig の 4 段。
    // identity の UserPoolClient callback URL に hosting.distributionUrl を渡す必要があり、
    // hosting の runtime-config.json には identity の cognitoDomain / clientId / apiGateway の
    // apiUrl が必要なため、 builder 内で 2 段階構築 (コンストラクタ + deployRuntimeConfig
    // method) で循環参照を回避する。
    //
    // pooled / silo どちらの TenantTemplateStack インスタンスでも同じ構造を立てる。
    //   - pooled: install.sh phase 1 で 1 度だけ立つ共有 console
    //   - silo:   provision-tenant.sh が PLATINUM tier で per-tenant に立てる
    // Issue #1340 Phase 2: pooled tier (= UserPool 共有) では SAML attach を一切しない
    // (既存の分離契約と整合)。 silo / per-tenant deploy のときだけ env-driven SAML 設定を渡す。
    // pooled 経路では props.samlIdps を渡しても force-empty にして CFn 物理差分を出さない。
    const effectiveSamlIdps = props.isPooledDeploy ? [] : (props.samlIdps ?? []);
    const effectiveSamlAdminAllowlist = props.isPooledDeploy
      ? []
      : (props.samlAdminAllowlist ?? []);

    const appPlaneCore = buildAppPlaneCore(this, {
      features: props.features,
      tenantId: props.tenantId,
      tenantName: props.tenantName,
      environment: props.environment,
      isPooledDeploy: props.isPooledDeploy,
      loginCustomDomain: props.loginCustomDomain,
      deployApiLambda: props.deployApiLambda,
      eventApiLambda: props.eventApiLambda,
      competitorAccountsApiLambda: props.competitorAccountsApiLambda,
      participantPortalUrl: props.participantPortalUrl,
      competitorBootstrapTemplateUrl: props.competitorBootstrapTemplateUrl,
      samlIdps: effectiveSamlIdps,
      samlAdminAllowlist: effectiveSamlAdminAllowlist,
      apiKeyConfig: {
        ssmParameterNames: props.ApiKeySSMParameterNames,
        ssmLookup: (name) => this.ssmLookup(name),
      },
    });
    const applicationAdminConsoleHosting = appPlaneCore.applicationAdminConsoleHosting;
    const identityProvider = appPlaneCore.identityProvider;
    const apiGateway = appPlaneCore.apiGateway;
    this.tenantApiId = apiGateway.restApi.restApiId;
    this.tenantApiName = apiGateway.restApi.restApiName;
    this.tenantApiStageName = apiGateway.restApi.deploymentStage.stageName;
    this.applicationAdminConsoleUrl = applicationAdminConsoleHosting.distributionUrl;
    this.tenantUserPoolId = identityProvider.tenantUserPool.userPoolId;
    this.samlIdpDirectory = appPlaneCore.samlIdpDirectory;

    // Issue #2948: machine (M2M) token 経路。default OFF。
    // ON のときだけ capability resource server と machine 専用 RestApi を CREATE する。
    // 既存 UserPool / human UserPoolClient / human TenantAPI には一切触らない (= NO-OP)。
    if (isMachineTokenPathEnabled(props.features)) {
      const machineIdentity = new MachineIdentity(this, "MachineIdentity", {
        userPool: identityProvider.tenantUserPool,
      });
      const machineApiGateway = new MachineApiGateway(this, "MachineApiGateway", {
        tenantId: props.tenantId,
        userPool: identityProvider.tenantUserPool,
        deployApiLambda: props.deployApiLambda,
        eventApiLambda: props.eventApiLambda,
        capabilityScopes: machineIdentity.capabilityScopes,
      });

      new CfnOutput(this, "MachineApiUrl", {
        value: machineApiGateway.restApi.url,
        description: `テナント ${props.tenantId} 向け machine (M2M) API のベース URL`,
      });
      // 発行 script と CLI が要求する scope を 1 行で読めるようにする。secret ではない。
      new CfnOutput(this, "MachineOAuthScopes", {
        value: [...MACHINE_CAPABILITIES.map(capabilityScope), bindScope(props.tenantId)].join(" "),
        description: `テナント ${props.tenantId} の machine credential が要求できる OAuth scope`,
      });
    }

    new AwsCustomResource(this, "CreateTenantMapping", {
      // 明示 LogGroup が無いと、 この custom resource の Lambda が作る log group は初回実行時に
      // Lambda サービスが暗黙生成し、 retention 未設定 (= 無期限保持) になる (#2960)。
      logGroup: deploymentLogGroup(this, "CreateTenantMappingLogs"),
      installLatestAwsSdk: true,
      onCreate: {
        service: "DynamoDB",
        action: "putItem",
        physicalResourceId: PhysicalResourceId.of("CreateTenantMapping"),
        parameters: {
          TableName: props.tenantMappingTable.tableName,
          Item: {
            tenantId: { S: props.tenantId },
            stackName: { S: Stack.of(this).stackName },
            codeCommitId: { S: props.commitId },
            waveNumber: { S: waveNumber },
          },
        },
      },
      onUpdate: {
        service: "DynamoDB",
        action: "updateItem",
        physicalResourceId: PhysicalResourceId.of("CreateTenantMapping"),
        parameters: {
          TableName: props.tenantMappingTable.tableName,
          Key: {
            tenantId: { S: props.tenantId },
          },
          UpdateExpression: "set codeCommitId = :codeCommitId",
          ExpressionAttributeValues: {
            ":codeCommitId": { S: props.commitId },
          },
        },
      },
      onDelete: {
        service: "DynamoDB",
        action: "deleteItem",
        parameters: {
          TableName: props.tenantMappingTable.tableName,
          Key: {
            tenantId: { S: props.tenantId },
          },
        },
      },
      policy: AwsCustomResourcePolicy.fromSdkCalls({
        resources: [props.tenantMappingTable.tableArn],
      }),
    });

    new CfnOutput(this, "ApiGatewayUrl", {
      value: apiGateway.restApi.url,
    });

    new CfnOutput(this, "TenantUserpoolId", {
      value: identityProvider.tenantUserPool.userPoolId,
    });

    new CfnOutput(this, "UserPoolClientId", {
      value: identityProvider.tenantUserPoolClient.userPoolClientId,
    });

    new CfnOutput(this, "ApplicationAdminConsoleUrl", {
      value: applicationAdminConsoleHosting.distributionUrl,
      description: `テナント ${props.tenantId} 向け application-admin-console の CloudFront URL`,
    });

    new CfnOutput(this, "TenantCognitoDomain", {
      value: identityProvider.cognitoDomainUrl,
      description: `テナント ${props.tenantId} 向け Cognito Hosted UI ドメイン`,
    });
  }

  ssmLookup(parameterName: string) {
    return StringParameter.valueForStringParameter(this, parameterName);
  }
}
