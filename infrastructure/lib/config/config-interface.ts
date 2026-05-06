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
}

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
}

export interface BootstrapConfig {
  /**
   * tenant stack の CloudFormation 名 prefix。`${prefix}-${tenantId}` で生成・削除する。
   */
  readonly tenantCfnStackPrefix: string;
}
