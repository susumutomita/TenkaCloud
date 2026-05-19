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
import { buildAppPlaneCore } from "../app-plane-core";
import type { SamlIdpConfig } from "../config/config-interface";
import type { ApiKeySSMParameterNames } from "../interfaces/api-key-ssm-parameter-names";

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
  tenantMappingTable: Table;
  commitId: string;
  waveNumber?: string;
  /**
   * `ProblemDeployBackendStack.deployApiLambda` をクロススタック参照で受ける。
   * tenant API の Cognito-gated routes (`POST /problems/:id/deploy` 等) が本 Lambda を
   * `LambdaIntegration` で invoke する (ADR-001 / Issue #458)。
   */
  deployApiLambda: IFunction;
  /**
   * `ProblemDeployBackendStack.eventApiLambda` をクロススタック参照で受ける (ADR-004 Phase 1)。
   * tenant API の `/events*` routes が本 Lambda を invoke する。
   */
  eventApiLambda: IFunction;
  /**
   * `ProblemDeployBackendStack.competitorAccountsApiLambda` をクロススタック参照で受ける
   * (Issue #459 / ADR-002 Phase 2.1)。tenant API の `/admin/competitor-accounts*` routes が
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
   * `AdminConsoleHostingStack` の `competitorBootstrapTemplateUrl` をクロススタック参照で受け、
   * application-admin-console の runtime-config に注入する。
   * Phase 1 deploy 時 (AdminConsoleHostingStack 未存在) は undefined、 Phase 3 で
   * install.sh が tenant-template-pooled を再 deploy するときに埋まる。
   */
  competitorBootstrapTemplateUrl?: string;
  /**
   * Issue #839 follow-up: 全 tenant 共有の SAML IdP 連携 (= operator 会社 SSO)。
   * 未設定なら従来通り Cognito username/password。 wire.ts が `Config.tenantSamlConfig` を
   * そのまま渡す。
   */
  samlConfig?: SamlIdpConfig;
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

  constructor(scope: Construct, id: string, props: TenantTemplateStackProps) {
    super(scope, id, props);
    const waveNumber = props.waveNumber || "1";

    // Issue #778 ADR-016 Phase 1: App Plane コア構成 (= hosting + identity + apiGateway +
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
    const appPlaneCore = buildAppPlaneCore(this, {
      tenantId: props.tenantId,
      tenantName: props.tenantName,
      environment: props.environment,
      isPooledDeploy: props.isPooledDeploy,
      deployApiLambda: props.deployApiLambda,
      eventApiLambda: props.eventApiLambda,
      competitorAccountsApiLambda: props.competitorAccountsApiLambda,
      participantPortalUrl: props.participantPortalUrl,
      competitorBootstrapTemplateUrl: props.competitorBootstrapTemplateUrl,
      apiKeyConfig: {
        ssmParameterNames: props.ApiKeySSMParameterNames,
        ssmLookup: (name) => this.ssmLookup(name),
      },
      samlConfig: props.samlConfig,
    });
    const applicationAdminConsoleHosting = appPlaneCore.applicationAdminConsoleHosting;
    const identityProvider = appPlaneCore.identityProvider;
    const apiGateway = appPlaneCore.apiGateway;
    this.tenantApiId = apiGateway.restApi.restApiId;
    this.tenantApiName = apiGateway.restApi.restApiName;
    this.tenantApiStageName = apiGateway.restApi.deploymentStage.stageName;
    this.applicationAdminConsoleUrl = applicationAdminConsoleHosting.distributionUrl;

    new AwsCustomResource(this, "CreateTenantMapping", {
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
