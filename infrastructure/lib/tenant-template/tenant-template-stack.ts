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
import type { ApiKeySSMParameterNames } from "../interfaces/api-key-ssm-parameter-names";
import { ApiGateway } from "./api-gateway";
import { ApplicationAdminConsoleHosting } from "./application-admin-console-hosting";
import { IdentityProvider } from "./identity-provider";

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
}

export class TenantTemplateStack extends Stack {
  constructor(scope: Construct, id: string, props: TenantTemplateStackProps) {
    super(scope, id, props);
    const waveNumber = props.waveNumber || "1";

    // 順序の意図: hosting → identity → hosting.deployRuntimeConfig の 3 段階。
    // identity の UserPoolClient callback URL に hosting.distributionUrl を渡す必要が
    // あり、hosting の runtime-config.json には identity の cognitoDomain / clientId
    // が必要なため、循環参照を 2 段階構築 (コンストラクタ + method) で回避する。
    //
    // pooled / silo どちらの TenantTemplateStack インスタンスでも同じ構造を立てる。
    //   - pooled: install.sh phase 1 で 1 度だけ立つ共有 console
    //   - silo:   provision-tenant.sh が PLATINUM tier で per-tenant に立てる
    // tenantId 注入は本 PR には含まない (#48 で追加)。
    const applicationAdminConsoleHosting = new ApplicationAdminConsoleHosting(
      this,
      "ApplicationAdminConsoleHosting",
      {
        tenantId: props.tenantId,
      },
    );

    const identityProvider = new IdentityProvider(this, "IdentityProvider", {
      tenantId: props.tenantId,
      environment: props.environment,
      applicationAdminConsoleUrl: applicationAdminConsoleHosting.distributionUrl,
    });

    // Note: apiUrl は apiGateway が確定してから渡すので、先に apiGateway を作る。
    // 旧コードでは hosting.deployRuntimeConfig が先だったが、apiUrl が必要になった
    // ので順序を変更する。
    // (実行順): hosting → identity → apiGateway → hosting.deployRuntimeConfig

    const apiGateway = new ApiGateway(this, "ApiGateway", {
      tenantId: props.tenantId,
      isPooledDeploy: props.isPooledDeploy,
      idpDetails: identityProvider.identityDetails,
      userPool: identityProvider.tenantUserPool,
      deployApiLambda: props.deployApiLambda,
      eventApiLambda: props.eventApiLambda,
      competitorAccountsApiLambda: props.competitorAccountsApiLambda,
      apiKeyBasicTier: {
        apiKeyId: this.ssmLookup(props.ApiKeySSMParameterNames.basic.keyId),
        value: this.ssmLookup(props.ApiKeySSMParameterNames.basic.value),
      },
      apiKeyStandardTier: {
        apiKeyId: this.ssmLookup(props.ApiKeySSMParameterNames.standard.keyId),
        value: this.ssmLookup(props.ApiKeySSMParameterNames.standard.value),
      },
      apiKeyPremiumTier: {
        apiKeyId: this.ssmLookup(props.ApiKeySSMParameterNames.premium.keyId),
        value: this.ssmLookup(props.ApiKeySSMParameterNames.premium.value),
      },
      apiKeyPlatinumTier: {
        apiKeyId: this.ssmLookup(props.ApiKeySSMParameterNames.platinum.keyId),
        value: this.ssmLookup(props.ApiKeySSMParameterNames.platinum.value),
      },
    });

    // apiGateway 確定後に runtime-config.json を配置する (apiUrl を詰めるため)。
    // ADR-001 / Issue #458: Deploy 系 endpoint は本 tenant API に統合されたので
    // runtime-config.json は `apiUrl` 1 本のみ (旧 `deployApiUrl` 廃止)。
    applicationAdminConsoleHosting.deployRuntimeConfig({
      cognitoDomain: identityProvider.cognitoDomainUrl,
      cognitoClientId: identityProvider.tenantUserPoolClient.userPoolClientId,
      tenantId: props.tenantId,
      tenantName: props.tenantName,
      apiUrl: apiGateway.restApi.url,
      participantPortalUrl: props.participantPortalUrl,
      competitorBootstrapTemplateUrl: props.competitorBootstrapTemplateUrl,
    });

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
