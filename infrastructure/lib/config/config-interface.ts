import type { CustomDomainsConfig } from "../security/cloudfront-custom-domain.js";

/**
 * Root configuration for TenkaCloud infrastructure.
 * Loaded from environments/{ENV}/config.json with ${VAR} / ${VAR:-default} placeholder replacement.
 */
export interface Config {
  readonly appName: string;
  readonly accountId: string;
  readonly region: string;
  readonly environment: string;

  readonly controlPlaneConfig: ControlPlaneConfig;
  readonly bootstrapConfig: BootstrapConfig;
  readonly dynamoDbConfig?: DynamoDbConfig;
  readonly kmsConfig?: KmsConfig;
  /**
   * Issue #1056: deploy artifact bucket (= `tenkacloud-source-<account>-<region>`) の
   * lifecycle policy。 同 key に PUT し続ける versioning=Enabled bucket で旧 version が
   * 無限蓄積するのを防ぐため、 `scripts/prepare-source-bundle.sh` が deploy 毎に idempotent
   * に PUT する。 未指定時は default 値 (= 5 世代 / 1 日) が builder で使われる。
   */
  readonly sourceBundleConfig?: SourceBundleConfig;
  // Issue #1066: SAML SSO 関連 (tenantSamlConfig) は廃止。 Issue #1035 の MFA 必須化で
  // 認証強度は維持される。

  /**
   * Issue #952 epic / cost guardrails: AWS Budgets の monthly limit (USD)。
   * 未指定 / 0 なら budget は立てない (= 旧挙動互換)。 development 50 / production 200 を
   * config.json で指定するのを推奨。
   */
  readonly monthlyCostLimitUsd?: number;
  /**
   * Budget alarm 通知の追加 email 宛先。 systemAdminEmail は自動で含めるので、 追加 cc / oncall
   * を渡すときに使う。
   */
  readonly budgetAlarmEmails?: readonly string[];

  /**
   * ADR-003 Phase 2 / problem catalog split: TenkaCloudChallenge repo の publish.yml が
   * S3 にアップロードするための bucket + GitHub OIDC IAM Role 設定。 未指定なら
   * `ChallengePayloadStack` は立てない (= 旧 `CDK_PARAM_CHALLENGE_PAYLOAD_BUCKET` env override
   * 経路だけ動く互換 mode)。
   */
  readonly challengePayloadConfig?: ChallengePayloadConfig;

  /**
   * Issue #1695: 各 SPA hosting にカスタムドメイン + ACM 証明書 (us-east-1) を割り当てて
   * CloudFront の viewer 最小 TLS を 1.2 に強制する opt-in 設定。 未指定の hosting は default
   * `*.cloudfront.net` 証明書配信のまま (= NO-OP、 既存挙動不変)。
   */
  readonly customDomains?: CustomDomainsConfig;
}

export interface ChallengePayloadConfig {
  /** Bucket 名 prefix。 environment 名が suffix される (= `tc-challenges-development` 等)。 */
  readonly bucketPrefix: string;
  /** OIDC AssumeRole を許可する GitHub repo (例 `susumutomita/TenkaCloudChallenge`)。 */
  readonly githubRepository: string;
  /** AssumeRole を許可する branch ref 一覧。 未指定なら `["main"]`。 */
  readonly githubBranches?: readonly string[];
  /**
   * 既存の GitHub OIDC provider ARN。 AWS account に既に存在する場合は import する
   * (= 1 account に同 URL の OIDC provider は 1 つしか作れない)。 未指定なら本 stack が新規作成。
   */
  readonly existingOidcProviderArn?: string;
  /** Noncurrent S3 object を削除するまでの日数 (default 30)。 */
  readonly noncurrentExpirationDays?: number | string;
}

// Issue #1066: SAML IdP 機能を全廃。 MFA 必須化 (Issue #1035) で代替済。

/**
 * KMS Key の削除待機期間。`make destroy` 後 KMS Key が "Pending Deletion" 状態のまま
 * 課金される期間 ($1/key/月) を縮めるため、AWS KMS の許容範囲 [7, 30] 内で指定。
 *
 *   - dev / training: 7 (= 最短、課金最小化)
 *   - production: 14〜30 (= 監査要件 / 誤削除時の rollback 余地)
 *
 * 値は config.json + `${ENV_VAR:-default}` placeholder から渡るため、文字列で来ること
 * がある (placeholder 展開後は string)。bin で `Number()` 正規化する。
 */
export interface KmsConfig {
  readonly pendingWindowInDays?: number | string;
}

/**
 * DynamoDB の billing mode と provisioned throughput。
 *
 *   - BootstrapTemplateStack の TenantMappingTable
 *   - TenantTemplateStack > ApiGateway の AppsTable
 *   - SBT (ControlPlaneStack) が内部で作る TenantDetails table (Aspect で強制)
 *
 * 全てに同じ値を適用する。dev/training は PROVISIONED 1/1 で Free Tier (25 RCU+WCU) 内に
 * 収める。本番でスケール要求が上がったら PAY_PER_REQUEST に切り替えるか capacity を上げる。
 *
 * 値は config.json + ${ENV_VAR:-default} placeholder から渡るため、文字列で来ることが
 * ある (JSON は number/string 両方を許容するが、placeholder 展開後は string)。
 * 受け側 (bin/infrastructure.ts) で `Number()` 正規化する。
 */
export interface DynamoDbConfig {
  readonly billingMode: "PROVISIONED" | "PAY_PER_REQUEST";
  /** PROVISIONED 時のみ使用。PAY_PER_REQUEST では無視される。 */
  readonly readCapacity?: number | string;
  /** PROVISIONED 時のみ使用。PAY_PER_REQUEST では無視される。 */
  readonly writeCapacity?: number | string;
}

export interface ControlPlaneConfig {
  readonly systemAdminEmail: string;
  readonly systemAdminRoleName?: string;
  readonly enableAdvancedSecurityMode?: boolean;
  readonly setAPIGWScopes?: boolean;
  readonly disableAPILogging?: boolean;
  /**
   * Cognito invitation email に埋め込む primary OAuth callback URL。SBT 内蔵 UserPoolUserClient の
   * 1 個目の callbackUrl にもなる。未指定時は localhost dev の URL。
   */
  readonly primaryCallbackUrl?: string;
  /**
   * 追加で SBT UserPoolUserClient に許可する OAuth callback URL。escape hatch で override する。
   */
  readonly additionalCallbackUrls?: readonly string[];
  /** 追加で許可する OAuth logout URL。 */
  readonly additionalLogoutUrls?: readonly string[];
  /**
   * Control Plane API Gateway (HTTP API) の CORS 許可 Origin。未指定時は localhost dev 系の
   * default が入る。prod では CloudFront domain を env で指定する。
   */
  readonly allowedCorsOrigins?: readonly string[];
  // Issue #1066: SAML IdP 関連は廃止。 MFA 必須化 (Issue #1035) で代替。
}

export interface BootstrapConfig {
  /**
   * tenant stack の CloudFormation 名 prefix。`${prefix}-${tenantId}` で生成・削除する。
   */
  readonly tenantCfnStackPrefix: string;
}

/**
 * deploy artifact (= `source.zip`) を置く S3 bucket の lifecycle 制御値。
 *
 * versioning=Enabled の同 key PUT で Noncurrent version が無限蓄積するのを防ぐため、
 * `keepNoncurrentVersions` 世代までを保持し、 それ以上古い旧 version は `expireAfterDays`
 * 日経過で expire させる。 数値は config.json の `${VAR:-default}` placeholder 経由で
 * env override 可能 (= string で来る場合あり、 builder 側で `Number()` 正規化する)。
 */
export interface SourceBundleConfig {
  /** 旧 version の保持世代数 (= AWS `NewerNoncurrentVersions`)。 推奨 5。 */
  readonly keepNoncurrentVersions: number | string;
  /** Noncurrent 化してから expire までの日数 (= AWS `NoncurrentDays`)。 推奨 1。 */
  readonly expireAfterDays: number | string;
}
