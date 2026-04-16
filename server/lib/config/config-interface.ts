/**
 * Root configuration interface for TenkaCloud infrastructure.
 * Values are loaded from environment/{ENV}/config.json with placeholder replacement.
 */
export interface Config {
  readonly appName: string;
  readonly accountId: string;
  readonly region: string;
  readonly environment: string;

  readonly controlPlaneConfig: ControlPlaneConfig;
  readonly appPlaneConfig: AppPlaneConfig;
  readonly problemDeployConfig: ProblemDeployConfig;
  readonly dynamoDbConfig: DynamoDbConfig;
}

export interface ControlPlaneConfig {
  /** Email address for the initial system admin (receives temporary password) */
  readonly systemAdminEmail: string;
  /** IAM role name for the system admin (default: SystemAdmin) */
  readonly systemAdminRoleName?: string;
  /** Enable Cognito Advanced Security Mode (default: true) */
  readonly enableAdvancedSecurityMode?: boolean;
  /** Set API Gateway scopes for authorization (default: true) */
  readonly setAPIGWScopes?: boolean;
  /** Disable CloudWatch API logging to reduce cost (default: false) */
  readonly disableAPILogging?: boolean;
  /** API Gateway throttling settings */
  readonly apiThrottling?: ApiThrottlingConfig;
}

export interface ApiThrottlingConfig {
  /** Steady-state requests per second (default: 10) */
  readonly rateLimit: number;
  /** Maximum burst capacity (default: 5) */
  readonly burstLimit: number;
}

export interface AppPlaneConfig {
  /** DynamoDB table name prefix for tenant resources */
  readonly dynamoDbTablePrefix: string;
  /** CloudFormation stack name prefix for tenant stacks */
  readonly cfnStackPrefix: string;
}

export interface ProblemDeployConfig {
  /** IAM role name pattern in team accounts for cross-account AssumeRole */
  readonly targetRoleName: string;
}

export interface DynamoDbConfig {
  /** Billing mode: PROVISIONED or PAY_PER_REQUEST (default: PROVISIONED) */
  readonly billingMode: "PROVISIONED" | "PAY_PER_REQUEST";
  /** Read capacity units (only used when billingMode is PROVISIONED, default: 5) */
  readonly readCapacity?: number;
  /** Write capacity units (only used when billingMode is PROVISIONED, default: 5) */
  readonly writeCapacity?: number;
  /** Enable point-in-time recovery (default: true) */
  readonly pointInTimeRecovery?: boolean;
}
