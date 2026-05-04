/**
 * TenkaCloud EventBridge Event Types
 *
 * イベント駆動アーキテクチャで使用される型定義。
 * Control Plane と Application Plane 間の通信に使用。
 *
 * Event Flow:
 * 1. TenantOnboarding: テナント作成時に発火 → tenant-provisioner が処理
 * 2. TenantProvisioned: プロビジョニング完了時に発火 → provisioning-completion が処理
 * 3. TenantUpdated: テナント設定変更時に発火 → 関連リソースを更新
 * 4. TenantOffboarding: テナント削除時に発火 → リソースをクリーンアップ
 */

// =============================================================================
// Provisioned Resources
// =============================================================================

/**
 * プロビジョニングで作成されたリソース情報
 */
export interface ProvisionedResources {
  /** S3 バケット名（ENTERPRISE の場合は専用バケット） */
  s3Bucket?: string;
  /** S3 プレフィックス（POOL モデルの場合） */
  s3Prefix?: string;
  /** テナント用 IAM Role ARN */
  iamRoleArn?: string;
  /** CloudWatch Logs グループ名 */
  cloudwatchLogGroup?: string;
  /** Auth0 Organization ID */
  auth0OrganizationId?: string;
}

// =============================================================================
// Event Detail Types
// =============================================================================

/**
 * TenantOnboarding イベントの詳細
 * DynamoDB Stream INSERT をトリガーに provisioning Lambda が発火
 */
export interface TenantOnboardingDetail {
  /** テナント ID (ULID) */
  tenantId: string;
  /** テナント名 */
  tenantName: string;
  /** テナントスラッグ（URL 用） */
  slug: string;
  /** 料金プラン */
  tier: 'FREE' | 'PRO' | 'ENTERPRISE';
  /** 管理者メールアドレス */
  adminEmail: string;
  /** 管理者名 */
  adminName?: string;
  /** リソース分離モデル */
  isolationModel: 'POOL' | 'SILO';
  /** デプロイリージョン */
  region: string;
  /** イベント発生時刻 (ISO 8601) */
  timestamp: string;
}

/**
 * TenantProvisioned イベントの詳細
 * tenant-provisioner がリソース作成完了後に発火
 */
export interface TenantProvisionedDetail {
  /** テナント ID (ULID) */
  tenantId: string;
  /** プロビジョニング結果 */
  status: 'COMPLETED' | 'FAILED';
  /** 作成されたリソース情報 */
  resources?: ProvisionedResources;
  /** 失敗時のエラーメッセージ */
  error?: string;
  /** イベント発生時刻 (ISO 8601) */
  timestamp: string;
}

/**
 * TenantUpdated イベントの詳細
 * テナント設定変更（tier 変更など）時に発火
 */
export interface TenantUpdatedDetail {
  /** テナント ID (ULID) */
  tenantId: string;
  /** テナントスラッグ */
  slug: string;
  /** 変更後の tier */
  tier: 'FREE' | 'PRO' | 'ENTERPRISE';
  /** 変更前の tier（tier 変更の場合） */
  previousTier?: 'FREE' | 'PRO' | 'ENTERPRISE';
  /** 変更後の分離モデル */
  isolationModel: 'POOL' | 'SILO';
  /** 変更前の分離モデル（変更があった場合） */
  previousIsolationModel?: 'POOL' | 'SILO';
  /** re-provisioning が必要かどうか */
  requiresReprovisioning: boolean;
  /** イベント発生時刻 (ISO 8601) */
  timestamp: string;
}

/**
 * TenantOffboarding イベントの詳細
 * テナント削除時に発火
 */
export interface TenantOffboardingDetail {
  /** テナント ID (ULID) */
  tenantId: string;
  /** テナントスラッグ */
  slug: string;
  /** 削除されるリソース情報 */
  resources?: ProvisionedResources;
  /** イベント発生時刻 (ISO 8601) */
  timestamp: string;
}

// =============================================================================
// Problem Deployment Event Types
// =============================================================================

/**
 * ProblemDeployRequested イベントの詳細
 * GameDay 問題デプロイ時に problem-service が発火 → ProblemDeployPlane が処理
 */
/**
 * 問題デプロイのアクション種別。
 * - deploy: 新規 CFn create-stack
 * - redeploy: 失敗 stack を delete してから create (rollback / failed 状態の復旧)
 * - teardown: イベント終了後に delete-stack (リソース解放)
 */
export type ProblemDeployAction = "deploy" | "redeploy" | "teardown";

export interface ProblemDeployRequestedDetail {
  /** 問題 ID */
  problemId: string;
  /** チーム ID (= competitor account id) */
  teamId: string;
  /** テナント ID */
  tenantId: string;
  /** イベント ID（DynamoDB PK 復元用） */
  eventId: string;
  /** Deployment Job ID（DynamoDB SK 復元用） */
  jobId: string;
  /** デプロイ先 IAM Role ARN（cross-account AssumeRole） */
  targetRoleArn: string;
  /** Confused Deputy 防止用 ExternalId */
  externalId: string;
  /** CloudFormation テンプレート URL */
  templateUrl: string;
  /**
   * 実行アクション。省略時は "deploy" 互換。
   * CodeBuild の buildspec が $ACTION で分岐する。
   */
  action?: ProblemDeployAction;
  /**
   * Complete/Failed イベントを DynamoDB の Job にマップし直すための複合キー
   * `${eventId}:${problemId}:${jobId}` 形式
   */
  deploymentKey: string;
  /** イベント発生時刻 (ISO 8601) */
  timestamp: string;
}

/**
 * ProblemDeployCompleted / Failed イベントの tenantData payload
 * SBT ScriptJob が環境変数から outgoing event に差し込む
 */
export interface ProblemDeployOutcomeTenantData {
  deployStatus: "completed" | "failed";
  stackName?: string;
  stackId?: string;
  errorReason?: string;
}

/**
 * 成功イベント detail — SBT が tenantData でラップして返す。
 * tenantRegistrationData には CFn の Outputs を入れる。
 */
export interface ProblemDeployCompletedDetail {
  deploymentKey: string;
  jobOutput: {
    tenantData: ProblemDeployOutcomeTenantData;
    tenantRegistrationData?: Record<string, string>;
  };
}

/**
 * 失敗イベント detail — SBT の jobFailureStatus 制約で flat な形状になる。
 * 判別は detail-type を使うこと。
 */
export interface ProblemDeployFailedDetail {
  deploymentKey: string;
  jobOutput: {
    deployStatus: "failed";
  };
}

// =============================================================================
// Event Type Constants
// =============================================================================

/**
 * EventBridge イベントタイプ定数
 */
export const EventDetailType = {
  TENANT_ONBOARDING: 'TenantOnboarding',
  TENANT_PROVISIONED: 'TenantProvisioned',
  TENANT_UPDATED: 'TenantUpdated',
  TENANT_OFFBOARDING: 'TenantOffboarding',
  PROBLEM_DEPLOY_REQUESTED: 'ProblemDeployRequested',
  PROBLEM_DEPLOY_COMPLETED: 'problem.deploy.completed',
  PROBLEM_DEPLOY_FAILED: 'problem.deploy.failed',
} as const;

export type EventDetailType =
  (typeof EventDetailType)[keyof typeof EventDetailType];

/**
 * EventBridge イベントソース
 */
export const EventSource = {
  CONTROL_PLANE: 'tenkacloud.control-plane',
  APPLICATION_PLANE: 'tenkacloud.application-plane',
  PROBLEM_SERVICE: 'tenkacloud.problem-service',
  PROBLEM_DEPLOY_PLANE: 'tenkacloud.problem-deploy-plane',
} as const;

export type EventSource = (typeof EventSource)[keyof typeof EventSource];

/**
 * EventBridge バス名
 */
export const EventBusName = {
  DEFAULT: 'default',
  TENKACLOUD: 'tenkacloud-events',
} as const;

export type EventBusName = (typeof EventBusName)[keyof typeof EventBusName];

// =============================================================================
// EventBridge Event Wrapper
// =============================================================================

/**
 * EventBridge イベントのラッパー型
 * AWS Lambda の EventBridgeEvent と互換
 */
export interface TenkaCloudEvent<T> {
  /** イベントバージョン */
  version: string;
  /** イベント ID */
  id: string;
  /** イベントタイプ */
  'detail-type': EventDetailType;
  /** イベントソース */
  source: EventSource;
  /** AWS アカウント ID */
  account: string;
  /** イベント発生時刻 */
  time: string;
  /** リージョン */
  region: string;
  /** リソース ARN 配列 */
  resources: string[];
  /** イベント詳細 */
  detail: T;
}

// =============================================================================
// Helper Types
// =============================================================================

/**
 * イベントタイプから詳細型へのマッピング
 */
export type EventDetailMap = {
  TenantOnboarding: TenantOnboardingDetail;
  TenantProvisioned: TenantProvisionedDetail;
  TenantUpdated: TenantUpdatedDetail;
  TenantOffboarding: TenantOffboardingDetail;
  ProblemDeployRequested: ProblemDeployRequestedDetail;
  "problem.deploy.completed": ProblemDeployCompletedDetail;
  "problem.deploy.failed": ProblemDeployFailedDetail;
};

// =============================================================================
// Deployment Key Helpers
// =============================================================================

/**
 * composite deployment key encode / decode
 * Requested/Completed/Failed イベント間で DynamoDB の Job を特定するために使う
 */
export function encodeDeploymentKey(
  eventId: string,
  problemId: string,
  jobId: string,
): string {
  return `${eventId}:${problemId}:${jobId}`;
}

export function decodeDeploymentKey(
  deploymentKey: string,
): { eventId: string; problemId: string; jobId: string } | null {
  const parts = deploymentKey.split(":");
  if (parts.length !== 3 || parts.some((p) => p.length === 0)) {
    return null;
  }
  return { eventId: parts[0], problemId: parts[1], jobId: parts[2] };
}
