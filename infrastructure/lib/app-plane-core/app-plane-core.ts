import type { Stack } from "aws-cdk-lib";
import type { IFunction } from "aws-cdk-lib/aws-lambda";
import type { SamlIdpConfig } from "../config/config-interface";
import type { ApiKeySSMParameterNames } from "../interfaces/api-key-ssm-parameter-names";
import { ApiGateway } from "../tenant-template/api-gateway";
import { ApplicationAdminConsoleHosting } from "../tenant-template/application-admin-console-hosting";
import { IdentityProvider } from "../tenant-template/identity-provider";

/**
 * Issue #778 ADR-016 Phase 1: TenantTemplateStack から共通 App Plane コア構成を抽出する。
 *
 * 抽出対象 (= Full mode と Lite mode で共有する):
 *   - ApplicationAdminConsoleHosting (= SPA + runtime-config 配信)
 *   - IdentityProvider (= tenant Cognito UserPool + UserPoolClient + Hosted UI domain)
 *   - ApiGateway (= REST API + DeployApi / EventApi / CompetitorAccountsApi 統合)
 *   - runtime-config.json 配置 (= apiGateway 確定後の 2 段階構築)
 *
 * 抽出しない (= Full mode 固有、 TenantTemplateStack 側に残す):
 *   - TenantMappingTable への AwsCustomResource Put / Update / Delete (SBT pipeline 連携)
 *   - SBT tag (TenantId / IsPooledDeploy)
 *   - tier API key の SSM lookup (Lite mode では不要、 後続 phase で apiKeyConfig optional 化)
 *
 * ## CFn 物理差分 0 件 invariant
 *
 * Construct 抽出ではなく **builder 関数** にしているのは、 CDK の construct path
 * (= `Stack/AppPlaneCore/ApplicationAdminConsoleHosting`) が変わると CFn logical ID が
 * drift して既存 stack を REPLACE してしまうため。 builder は `scope = stack` のまま
 * 3 つの sub-construct を生成するので、 logical ID は旧 `Stack/ApplicationAdminConsoleHosting`
 * と完全に一致する。
 *
 * 将来 (= Phase 3) の TenkaCloudLiteStack は同じ builder を別 Stack で呼ぶだけ。
 */

export interface AppPlaneCoreApiKeyConfig {
  readonly ssmParameterNames: ApiKeySSMParameterNames;
  /**
   * SSM Parameter から値を引く関数。 stack の `valueForStringParameter` を bind した callback
   * を受ける (= stack scope に依存しないため)。 Lite mode で API Key 経路を skip する場合は
   * 本 prop ごと undefined を渡す (= 後続 phase で実装)。
   */
  readonly ssmLookup: (parameterName: string) => string;
}

export interface AppPlaneCoreProps {
  readonly tenantId: string;
  readonly tenantName: string;
  readonly environment: string;
  readonly isPooledDeploy: boolean;
  readonly deployApiLambda: IFunction;
  readonly eventApiLambda: IFunction;
  readonly competitorAccountsApiLambda: IFunction;
  readonly participantPortalUrl?: string;
  readonly competitorBootstrapTemplateUrl?: string;
  /**
   * Full mode (= SaaS pipeline 経由) では tier API key SSM lookup を渡す。
   * Lite mode (= Phase 3 以降) では undefined を渡し、 API Gateway 側の Usage Plan / API Key
   * 配線をスキップする (= 後続 phase で ApiGateway 側にも optional 化を入れる予定)。
   */
  readonly apiKeyConfig: AppPlaneCoreApiKeyConfig;
  /**
   * Issue #839 follow-up: 全 tenant 共有の SAML IdP 連携設定 (= operator 会社 SSO)。
   * 未設定なら従来通り Cognito username/password。 詳細は `SamlIdpConfig` 参照。
   */
  readonly samlConfig?: SamlIdpConfig;
}

export interface AppPlaneCoreHandles {
  readonly applicationAdminConsoleHosting: ApplicationAdminConsoleHosting;
  readonly identityProvider: IdentityProvider;
  readonly apiGateway: ApiGateway;
  readonly applicationAdminConsoleUrl: string;
}

/**
 * Stack の中で App Plane コア構成 (= hosting + identity + api gateway + runtime-config) を
 * 立てる pure helper。 旧 TenantTemplateStack の constructor 内 logic を 1 関数に集約。
 *
 * 順序 (= 旧実装と完全同一):
 *   1. hosting (CloudFront URL を identity に渡す必要があるので先)
 *   2. identity (UserPoolClient callback URL に hosting.distributionUrl が必要)
 *   3. apiGateway (Cognito user pool + Lambda 統合を組み立てる)
 *   4. hosting.deployRuntimeConfig (apiUrl が確定してから呼ぶ)
 *
 * scope は Stack を直接受け取り、 sub-construct ID を旧パスと完全一致させる
 * (= `Stack/ApplicationAdminConsoleHosting` 等)。
 */
export function buildAppPlaneCore(scope: Stack, props: AppPlaneCoreProps): AppPlaneCoreHandles {
  const applicationAdminConsoleHosting = new ApplicationAdminConsoleHosting(
    scope,
    "ApplicationAdminConsoleHosting",
    {
      tenantId: props.tenantId,
    },
  );

  const identityProvider = new IdentityProvider(scope, "IdentityProvider", {
    tenantId: props.tenantId,
    environment: props.environment,
    applicationAdminConsoleUrl: applicationAdminConsoleHosting.distributionUrl,
    samlConfig: props.samlConfig,
  });

  const apiGateway = new ApiGateway(scope, "ApiGateway", {
    tenantId: props.tenantId,
    isPooledDeploy: props.isPooledDeploy,
    idpDetails: identityProvider.identityDetails,
    userPool: identityProvider.tenantUserPool,
    deployApiLambda: props.deployApiLambda,
    eventApiLambda: props.eventApiLambda,
    competitorAccountsApiLambda: props.competitorAccountsApiLambda,
    apiKeyBasicTier: {
      apiKeyId: props.apiKeyConfig.ssmLookup(props.apiKeyConfig.ssmParameterNames.basic.keyId),
      value: props.apiKeyConfig.ssmLookup(props.apiKeyConfig.ssmParameterNames.basic.value),
    },
    apiKeyStandardTier: {
      apiKeyId: props.apiKeyConfig.ssmLookup(props.apiKeyConfig.ssmParameterNames.standard.keyId),
      value: props.apiKeyConfig.ssmLookup(props.apiKeyConfig.ssmParameterNames.standard.value),
    },
    apiKeyPremiumTier: {
      apiKeyId: props.apiKeyConfig.ssmLookup(props.apiKeyConfig.ssmParameterNames.premium.keyId),
      value: props.apiKeyConfig.ssmLookup(props.apiKeyConfig.ssmParameterNames.premium.value),
    },
    apiKeyPlatinumTier: {
      apiKeyId: props.apiKeyConfig.ssmLookup(props.apiKeyConfig.ssmParameterNames.platinum.keyId),
      value: props.apiKeyConfig.ssmLookup(props.apiKeyConfig.ssmParameterNames.platinum.value),
    },
    // Issue #860: CORS allowOrigins を application-admin-console URL に絞る。
    applicationAdminConsoleUrl: applicationAdminConsoleHosting.distributionUrl,
    environment: props.environment,
  });

  applicationAdminConsoleHosting.deployRuntimeConfig({
    cognitoDomain: identityProvider.cognitoDomainUrl,
    cognitoClientId: identityProvider.tenantUserPoolClient.userPoolClientId,
    tenantId: props.tenantId,
    tenantName: props.tenantName,
    apiUrl: apiGateway.restApi.url,
    participantPortalUrl: props.participantPortalUrl,
    competitorBootstrapTemplateUrl: props.competitorBootstrapTemplateUrl,
    // Issue #897: pooled stack の UserPool は全 pooled tenant が共有するため、 SAML SSO のような
    // UserPool mutate を伴う機能は他 tenant に副作用を及ぼす。 frontend は isolation を見て
    // pooled では SAML SSO page を隠し、 silo (PLATINUM) でのみ有効にする。
    isolation: props.isPooledDeploy ? "pooled" : "silo",
  });

  return {
    applicationAdminConsoleHosting,
    identityProvider,
    apiGateway,
    applicationAdminConsoleUrl: applicationAdminConsoleHosting.distributionUrl,
  };
}
