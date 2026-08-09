import type { Stack } from "aws-cdk-lib";
import type { Table } from "aws-cdk-lib/aws-dynamodb";
import type { IFunction } from "aws-cdk-lib/aws-lambda";
import { isHumanAuthorizerAudiencePinEnabled } from "../app-config/index.js";
import type { ApiKeySSMParameterNames } from "../interfaces/api-key-ssm-parameter-names.js";
import { SamlIdpLambda } from "../problem-deploy/saml-idp-lambda.js";
import type { CustomDomainConfig } from "../security/cloudfront-custom-domain.js";
import { ApiGateway } from "../tenant-template/api-gateway.js";
import { ApplicationAdminConsoleHosting } from "../tenant-template/application-admin-console-hosting.js";
import { IdentityProvider } from "../tenant-template/identity-provider.js";
import { attachTenantFederatedAdminAllowlist } from "../tenant-template/saml-admin-allowlist.js";
import {
  attachTenantSamlIdentityProviders,
  type IdpDirectory,
  type SamlIdpConfig,
} from "../tenant-template/saml-identity-providers.js";
import { LiteAdminClaimsLambda } from "./lite-admin-claims-lambda.js";

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
  /** Issue #1993 / #1994: tenant ログイン用 Cognito カスタムドメイン (任意、 未設定で NO-OP)。 */
  readonly loginCustomDomain?: CustomDomainConfig;
  readonly deployApiLambda: IFunction;
  readonly eventApiLambda: IFunction;
  readonly competitorAccountsApiLambda: IFunction;
  /**
   * Issue #1312: SAML IdP CRUD 用 DDB Table。 渡された時に本 helper が `SamlIdpLambda` へ
   * `SAML_IDPS_TABLE_NAME` env + R+W grant を配線する (= `SamlIdpLambda` 自体の生成有無は
   * {@link attachSamlIdpLambda} が決める — table の有無だけでは決めない、 下記参照)。
   *
   * [Issue #2442 / Phase C5] `controlDataBackend` が純 SQL (`turso`) のときは caller
   * (`TenkaCloudLiteStack`) が本 table を synth せず `undefined` を渡す。 IdP CRUD API 自体は
   * `attachSamlIdpLambda` が独立して制御するため、 table 不在でも Lambda は生成され続ける
   * (= repository seam 経由で SQL executor に直結する)。
   */
  readonly samlIdpsTable?: Table;
  /**
   * [Issue #2442 / Phase C5] `true` のとき `SamlIdpLambda` を新規 instantiate (UserPool は同
   * stack で立てた `IdentityProvider.tenantUserPool` 直結) + ApiGateway に `/tenant/idp*` route
   * を生やす。 SamlIdpLambda を caller 側で先に立てると ProblemDeploy → Lite UserPool の逆方向
   * 参照になり `addDependency` cycle になるため、 同 stack 内 instantiation を Lite mode 配線契約
   * とする。
   *
   * `samlIdpsTable` の有無から意図的に切り離してある: 純 SQL backend では table が synth され
   * ないが、 Lite mode は `controlDataBackend` の値に関わらず IdP CRUD API を提供し続ける契約
   * なので、 `TenkaCloudLiteStack` は本 flag を常に `true` で渡す。 未指定 (= SaaS/Full mode の
   * `TenantTemplateStack`) では Lambda を一切立てず、 既存 CFn 物理差分を 0 件に保つ。
   */
  readonly attachSamlIdpLambda?: boolean;
  readonly participantPortalUrl?: string;
  readonly competitorBootstrapTemplateUrl?: string;
  /**
   * Full mode (= SaaS pipeline 経由) では tier API key SSM lookup を渡す。
   * Lite mode (= Phase 3 以降) では undefined を渡し、 API Gateway 側の Usage Plan / API Key
   * 配線をスキップする (= 後続 phase で ApiGateway 側にも optional 化を入れる予定)。
   */
  readonly apiKeyConfig: AppPlaneCoreApiKeyConfig;
  /**
   * Issue #1327: Lite mode 専用の opt-in flag。 `true` のとき Cognito Pre-Token Generation
   * Lambda を UserPool に attach し、 JWT 発行直前に `custom:userRole = "TenantAdmin"` +
   * `custom:tenantId = "local"` を注入する。
   *
   * SaaS mode (= SBT pipeline / `provision-tenant.sh` 経路) では `undefined` / `false` を渡し、
   * Lambda trigger を一切立てない (= role 割り当ては SaaS 側 admin-create-user 経路に任せる)。
   * 既定 `false` にすることで、 既存 SaaS / Full mode の CFn 物理差分を 0 件に保つ。
   */
  readonly liteAdminClaimsInjection?: boolean;
  /**
   * Issue #1340 Phase 2: per-tenant SAML IdP 群 (= env `TENANT_SAML_IDPS` を parse 済)。
   * 未指定 / 空配列なら従来 Cognito local auth + MFA 強制のみ (= 既存 SaaS / Full mode の
   * CFn 物理差分を 0 件に保つ opt-in)。
   *
   * pooled UserPool を共有する pooled tier (BASIC / STANDARD / PREMIUM) では SAML attach を
   * **配線しない**。 caller 側 (= `TenantTemplateStack`) で pooled tier を判定して props を
   * 渡さない (= ADR-018 `pooled-userpool-saml-isolation` と整合)。 Lite mode (= 単一 tenant、
   * 1 UserPool) と silo (PLATINUM) tier では tenant 内で完結するため安全に attach できる。
   */
  readonly samlIdps?: readonly SamlIdpConfig[];
  /**
   * Issue #1340 Phase 2: federated 管理者 allowlist (`provider/email`)。 `samlIdps` 設定時
   * のみ意味を持つ。 空配列 = federated sign-in 全拒否 (fail-safe)。
   */
  readonly samlAdminAllowlist?: readonly string[];
  /**
   * Issue #2230 (ADR-035): SPA feature flag の deploy 時 override。 runtime-config.json の
   * `features` に焼かれ、application-admin-console の `resolveFeatureFlags` が merge する。
   */
  readonly features?: Readonly<Record<string, boolean>>;
  /**
   * [Issue #2442 / Phase C5] control-plane data backend (dynamodb|turso)。 `SamlIdpLambda` へ
   * そのまま転送する (default 未指定 / `dynamodb` は env を足さず byte 互換)。
   */
  readonly controlDataBackend?: string;
  /** [Issue #2442 / Phase C5] `SamlIdpLambda` の Turso executor 配線用 URL。 */
  readonly tursoDatabaseUrl?: string;
  /** [Issue #2442 / Phase C5] `SamlIdpLambda` の Turso auth token を格納する SSM parameter 名。 */
  readonly tursoAuthTokenParameterName?: string;
}

export interface AppPlaneCoreHandles {
  readonly applicationAdminConsoleHosting: ApplicationAdminConsoleHosting;
  readonly identityProvider: IdentityProvider;
  readonly apiGateway: ApiGateway;
  readonly applicationAdminConsoleUrl: string;
  /**
   * Issue #1312: `attachSamlIdpLambda: true` を渡したときに作られる SAML IdP CRUD Lambda
   * (Issue #2442 / Phase C5: table 有無ではなく `attachSamlIdpLambda` が生成有無を決める)。
   * 未配線時は undefined。
   */
  readonly samlIdpLambda?: SamlIdpLambda;
  /**
   * Issue #1327: `liteAdminClaimsInjection: true` を渡したときに立つ Pre-Token Generation Lambda。
   * SaaS mode 経路では undefined のまま (= attach なし)。
   */
  readonly liteAdminClaimsLambda?: LiteAdminClaimsLambda;
  /**
   * Issue #1340 Phase 2: SAML HRD directory (= domain → providerName[])。 application-admin-console
   * の Login が email から候補 IdP を解決して `identity_provider=` を組み立てる public metadata。
   * SAML 未設定なら `{}` (= 全 email が Cognito local auth に流れる、 旧動作互換)。
   * `runtime-config.json` の `samlIdpDirectory` field に焼き込まれる。
   */
  readonly samlIdpDirectory: IdpDirectory;
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
    loginCustomDomain: props.loginCustomDomain,
  });

  // Issue #1312: attachSamlIdpLambda が true なら SAML IdP CRUD Lambda を同 stack で立てる
  // (= UserPool を cross-stack ref で渡すと cyclic dependency になるため同 stack 配置が契約)。
  // [Issue #2442 / Phase C5] table の有無から意図的に切り離してある — 純 SQL backend では
  // samlIdpsTable が undefined でも Lambda 自体は生成される (AppPlaneCoreProps.attachSamlIdpLambda
  // の docstring 参照)。
  const samlIdpLambda = props.attachSamlIdpLambda
    ? new SamlIdpLambda(scope, "SamlIdp", {
        samlIdpsTable: props.samlIdpsTable,
        userPool: identityProvider.tenantUserPool,
        idpTierGuard: "silo",
        controlDataBackend: props.controlDataBackend,
        tursoDatabaseUrl: props.tursoDatabaseUrl,
        tursoAuthTokenParameterName: props.tursoAuthTokenParameterName,
      })
    : undefined;

  // Issue #1327: Lite mode opt-in で Cognito Pre-Token Generation Lambda を UserPool に attach。
  // SaaS mode 経路 (= flag 未指定 / false) では Lambda を一切立てず、 既存 stack の CFn 物理差分を
  // 0 件に保つ。 Lambda は event を mutate して返すだけ (= IAM / external API call 不要)。
  const liteAdminClaimsLambda = props.liteAdminClaimsInjection
    ? new LiteAdminClaimsLambda(scope, "LiteAdminClaims", {
        userPool: identityProvider.tenantUserPool,
      })
    : undefined;

  // Issue #1340 Phase 2: opt-in で per-tenant SAML IdP を UserPool に attach する。
  //
  // 1. attach: samlIdps 未指定 / 空なら何もしない (= 既存 CFn 物理差分 0 件)。 設定時は
  //    UserPool に SAML provider を attach し、 client の SupportedIdentityProviders を
  //    COGNITO + 各 provider に拡張。 directory は per-tenant runtime-config.json に焼く
  //    (= tenant 越境はしない、 物理的 isolation)。
  // 2. federated admin allowlist: SAML が attach された tenant でのみ Pre sign-up Lambda を
  //    attach する。 空配列でも attach する (= fail-safe、 「テナント外 federated user が
  //    全員 TenantAdmin」 構成事故を防ぐ)。
  // 3. pooled tier の判定は caller (= `TenantTemplateStack`) が担う。 builder 自身は同 UserPool
  //    instance に対して attach するだけで、 pooled / silo の境界を持たない (= ADR-018 相当の
  //    pooled UserPool 共有 SAML を防ぐ責務は外側にある)。
  const samlIdps = props.samlIdps ?? [];
  const samlIdpDirectory = attachTenantSamlIdentityProviders(
    scope,
    identityProvider.tenantUserPool,
    identityProvider.cfnTenantUserPoolClient,
    samlIdps,
  );
  if (samlIdps.length > 0) {
    attachTenantFederatedAdminAllowlist(
      scope,
      identityProvider.tenantUserPool,
      props.samlAdminAllowlist ?? [],
    );
  }

  // Issue #2953: opt-in で human authorizer に `aud` の照合を入れる。human の ID token は
  // `aud` に app client id を持ち、machine の access token は `aud` を持たないため、client id を
  // pin すると access token が gateway 段で 401 になる。既定 OFF (= property を書かない) なので
  // 既存 authorizer の CFn 物理差分は 0 件。
  const humanAudienceValidationExpression = isHumanAuthorizerAudiencePinEnabled(props.features)
    ? `^${identityProvider.tenantUserPoolClient.userPoolClientId}$`
    : undefined;

  const apiGateway = new ApiGateway(scope, "ApiGateway", {
    tenantId: props.tenantId,
    isPooledDeploy: props.isPooledDeploy,
    idpDetails: identityProvider.identityDetails,
    userPool: identityProvider.tenantUserPool,
    ...(humanAudienceValidationExpression ? { humanAudienceValidationExpression } : {}),
    deployApiLambda: props.deployApiLambda,
    eventApiLambda: props.eventApiLambda,
    competitorAccountsApiLambda: props.competitorAccountsApiLambda,
    ...(samlIdpLambda ? { samlIdpLambda: samlIdpLambda.fn } : {}),
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
    features: props.features,
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
    // Issue #1340 Phase 2: HRD directory を runtime-config.json に焼く (= 未認証 Login が読む
    // public metadata、 非秘匿)。 SAML 未設定なら `{}`。
    samlIdpDirectory,
  });

  return {
    applicationAdminConsoleHosting,
    identityProvider,
    apiGateway,
    applicationAdminConsoleUrl: applicationAdminConsoleHosting.distributionUrl,
    samlIdpDirectory,
    ...(samlIdpLambda ? { samlIdpLambda } : {}),
    ...(liteAdminClaimsLambda ? { liteAdminClaimsLambda } : {}),
  };
}
