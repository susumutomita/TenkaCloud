import type { BillingMode } from "aws-cdk-lib/aws-dynamodb";
import type { SamlIdpConfig } from "../config/config-interface";
import type { ApiKeySSMParameterNames } from "../interfaces/api-key-ssm-parameter-names";
import type { ParticipantPortalRuntimeConfig } from "../problem-deploy/participant-portal-hosting";

export type { ApiKeySSMParameterNames };

/**
 * Issue #766: bin/infrastructure.ts に散在していた env / config 解決を 1 つの shape に
 * 集約する。pure function `resolveAppConfig` の戻り値で、 stack 配線層 (= `lib/app-wiring`)
 * からはこの object だけを参照する (= 副作用無し、 順序依存無し、 単体テスト可能)。
 */
export interface AppConfig {
  /** development / staging / production 等。`CDK_PARAM_ENVIRONMENT` から決定。 */
  readonly environment: string;
  /** 本 env が production / staging のいずれか (= deterministic default を禁じる対象)。 */
  readonly isProductionLike: boolean;
  /** `config.json` の `appName` を lowercase 化したもの。SSM parameter prefix 等で使う。 */
  readonly appNameLower: string;
  /** `${appNameLower}-${environment}` のプレフィックス (横軸 = 別 application、 縦軸 = 別 env の二重衝突回避)。 */
  readonly namePrefix: string;

  /** SBT が払い出す System Admin (Cognito) の email。 `CDK_PARAM_SYSTEM_ADMIN_EMAIL` から。 */
  readonly systemAdminEmail: string;
  /** Tenant 単位の deploy。 pooled 経路では `"pooled"`。 silo (PLATINUM) では ULID。 */
  readonly tenantId: string;
  /** Tenant の表示名 (= application-admin-console の Home 画面 fallback で使う)。 */
  readonly tenantName: string;
  /** `tenantId === "pooled"` の事前計算 alias。 */
  readonly isPooledDeploy: boolean;
  /** 共通 source artifact (SBT BashJobRunner の deploy 経路で使う zip 名)。 */
  readonly s3SourceBucket: string;
  readonly sourceZip: string;
  readonly commitId: string;

  /** API Gateway stage 名 (= `prod` 等)。`CDK_PARAM_STAGE_NAME` で override 可能。 */
  readonly stageName: string;
  /** Lambda の reserve concurrency (`CDK_PARAM_LAMBDA_RESERVE_CONCURRENCY`、 default 1)。 */
  readonly lambdaReserveConcurrency: number;
  /** Lambda canary deployment preference (`CDK_PARAM_LAMBDA_CANARY_DEPLOYMENT_PREFERENCE`)。 */
  readonly lambdaCanaryDeploymentPreference: string;

  /** AWS account / region (= 全 stack に揃えて env-aware にする) */
  readonly awsAccountId: string;
  readonly awsRegion: string;
  /** awsAccountId / awsRegion が両方 set されているときだけ env-aware にする stackProps fragment。 */
  readonly stackEnv: { env?: { account: string; region: string } };

  /** DynamoDB billing mode + capacity。 PROVISIONED 1/1 を Free Tier に収める。 */
  readonly dynamoBillingMode: BillingMode;
  readonly isDynamoProvisioned: boolean;
  readonly dynamoReadCapacity: number;
  readonly dynamoWriteCapacity: number;

  /** KMS Key 削除待機期間 (= cost cleanup 用、 7-30 日)。 */
  readonly kmsPendingWindowInDays: number;

  /** API Key VALUE (4 tier 分。 production / staging では env 必須、 dev は deterministic default)。 */
  readonly apiKeyPlatinumTierParameter: string;
  readonly apiKeyPremiumTierParameter: string;
  readonly apiKeyStandardTierParameter: string;
  readonly apiKeyBasicTierParameter: string;
  /** SSM Parameter 名 (= bootstrap / tenant stack 間で共有)。 */
  readonly apiKeySSMParameterNames: ApiKeySSMParameterNames;

  /** Participant Portal を立てる (= `CDK_PARAM_ENABLE_PARTICIPANT_PORTAL=true`) か。 */
  readonly enableParticipantPortal: boolean;
  /** Participant Portal の runtime config (event title + region)。 portal 無効時は undefined。 */
  readonly participantPortal:
    | { runtimeConfig: ParticipantPortalRuntimeConfig | "default-dev-mock" }
    | undefined;

  /** `problems/<category>/<id>/metadata.json` から auto-discovery した catalog + 各種 sub-feature。 */
  readonly problems: ProblemsCatalogBundle;

  /** ADR-008 Phase 2 (#642): private 問題 payload を格納する S3 bucket 名 (未設定なら undefined)。 */
  readonly challengePayloadBucketName: string | undefined;

  /** Bulk Deploy の CodeBuild 並列度 (未設定なら AWS account-level quota に任せる)。 */
  readonly deployConcurrentBuildLimit: number | undefined;

  /** AdminConsoleInsight の CORS allow-list 用 origin。 phase 2 deploy 時に install.sh が export する。 */
  readonly adminConsoleOriginForCors: string | undefined;

  // Issue #1053: 旧 `competitorBootstrapTemplateUrlEnv` (= `CDK_PARAM_COMPETITOR_BOOTSTRAP_TEMPLATE_URL`)
  // は廃止。 ProblemDeployBackendStack に hosting を移管したため、 consumer は cross-stack ref で
  // URL を受ける (= Phase 3 env-var dance が不要になる)。

  /** Phase 2 hosting stack を立てるための 3 つの env (全部揃ったときだけ deploy する)。 */
  readonly adminConsoleHostingInputs: AdminConsoleHostingInputs | undefined;

  /**
   * Issue #839 follow-up: 全 tenant 共有の SAML IdP 連携。 config.json の `tenantSamlConfig`
   * からそのまま渡す。 未設定なら従来通り Cognito username/password。
   */
  readonly tenantSamlConfig: SamlIdpConfig | undefined;
  /**
   * Issue #839 follow-up: System Admin (= Control Plane) 用 SAML IdP 連携。 config.json の
   * `controlPlaneConfig.samlIdp` からそのまま渡す。 ControlPlaneStack が SBT UserPool に escape
   * hatch で IdP を付ける。
   */
  readonly controlPlaneSamlConfig: SamlIdpConfig | undefined;

  /**
   * Issue #952 epic / cost guardrails: AWS Budgets monthly limit (USD)。 未指定 / 0 なら
   * budget を立てない (= 旧挙動互換)。 development: 50, production: 200 を推奨。
   */
  readonly monthlyCostLimitUsd: number | undefined;
  /** Budget alarm 通知の追加 email 宛先 (systemAdminEmail は自動同梱)。 */
  readonly budgetAlarmEmails: readonly string[] | undefined;
}

export interface ProblemsCatalogBundle {
  readonly catalog: unknown;
  readonly scoring: unknown;
  readonly endpoints: unknown;
  readonly phases: unknown;
  readonly visibility: unknown;
  /** Issue #888: per-problem `disruptions[]` 宣言。 未宣言の問題はキー無し。 */
  readonly disruptions: unknown;
}

export interface AdminConsoleHostingInputs {
  readonly apiUrl: string;
  readonly cognitoDomain: string;
  readonly userClientId: string;
  readonly pooledApplicationAdminConsoleUrl: string;
  readonly provisioningCodeBuildProject: string;
  readonly adminInsightApiUrl: string;
}
