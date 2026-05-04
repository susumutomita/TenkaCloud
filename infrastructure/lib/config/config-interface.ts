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
  /** Default broker Entra profile applied when onboarding payload omits brokerEntraProfileId. */
  readonly brokerEntra?: BrokerEntraConfig;
}

export interface BrokerEntraConfig {
  /**
   * Graph 認証情報 (JSON: TENANT_ID / CLIENT_ID / CLIENT_SECRET) を格納した SSM Parameter Store の
   * SecureString パラメータ名。Secrets Manager は使わない (Standard Parameter Store は無料)。
   * パラメータ自体は手動で作成しておく前提 (CDK でシークレット値を管理しない)。
   */
  readonly graphParameterName: string;
  /**
   * Entra applicationTemplate ID。省略時は Custom SAML (GraphClient 側のデフォルト)。
   */
  readonly applicationTemplateId?: string;
}

export interface BootstrapConfig {
  /**
   * tenant stack の CloudFormation 名 prefix。`${prefix}-${tenantId}` で生成・削除する。
   */
  readonly tenantCfnStackPrefix: string;
}
