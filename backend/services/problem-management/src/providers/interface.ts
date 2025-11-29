/**
 * Cloud Provider Abstraction Interface
 *
 * クラウドプロバイダー（AWS/GCP/Azure/Local）を統一的に扱うための抽象化レイヤー
 */

import type {
  CloudCredentials,
  CloudProvider,
  DeploymentJob,
  DeploymentResult,
  Problem,
  StackStatus,
} from '../types';

/**
 * クラウドプロバイダー共通インターフェース
 *
 * 各プロバイダー（AWS, GCP, Azure, Local）はこのインターフェースを実装する
 */
export interface ICloudProvider {
  /** プロバイダー識別子 */
  readonly provider: CloudProvider;

  /** プロバイダー名（表示用） */
  readonly displayName: string;

  /**
   * 認証情報の検証
   * @param credentials 認証情報
   * @returns 認証が有効かどうか
   */
  validateCredentials(credentials: CloudCredentials): Promise<boolean>;

  /**
   * 問題スタックのデプロイ
   * @param problem 問題定義
   * @param credentials 認証情報
   * @param options デプロイオプション
   * @returns デプロイ結果
   */
  deployStack(
    problem: Problem,
    credentials: CloudCredentials,
    options: DeployStackOptions
  ): Promise<DeploymentResult>;

  /**
   * スタックのステータス取得
   * @param stackName スタック名
   * @param credentials 認証情報
   * @returns スタックステータス
   */
  getStackStatus(stackName: string, credentials: CloudCredentials): Promise<StackStatus | null>;

  /**
   * スタックの削除
   * @param stackName スタック名
   * @param credentials 認証情報
   * @returns 削除結果
   */
  deleteStack(stackName: string, credentials: CloudCredentials): Promise<DeploymentResult>;

  /**
   * スタック出力の取得
   * @param stackName スタック名
   * @param credentials 認証情報
   * @returns 出力値のマップ
   */
  getStackOutputs(stackName: string, credentials: CloudCredentials): Promise<Record<string, string>>;

  /**
   * 静的ファイルのアップロード
   * @param localPath ローカルパス
   * @param remotePath リモートパス
   * @param credentials 認証情報
   * @returns アップロード先URL
   */
  uploadStaticFiles(localPath: string, remotePath: string, credentials: CloudCredentials): Promise<string>;

  /**
   * リソースのクリーンアップ
   * @param accountId アカウントID
   * @param credentials 認証情報
   * @param options クリーンアップオプション
   * @returns クリーンアップ結果
   */
  cleanupResources(
    accountId: string,
    credentials: CloudCredentials,
    options?: CleanupOptions
  ): Promise<CleanupResult>;

  /**
   * 利用可能なリージョン一覧の取得
   * @returns リージョン一覧
   */
  getAvailableRegions(): Promise<RegionInfo[]>;

  /**
   * アカウント情報の取得
   * @param credentials 認証情報
   * @returns アカウント情報
   */
  getAccountInfo(credentials: CloudCredentials): Promise<AccountInfo>;
}

/**
 * デプロイオプション
 */
export interface DeployStackOptions {
  /** スタック名 */
  stackName: string;
  /** リージョン */
  region: string;
  /** パラメータ */
  parameters?: Record<string, string>;
  /** タグ */
  tags?: Record<string, string>;
  /** タイムアウト（秒） */
  timeoutSeconds?: number;
  /** 失敗時にロールバックするか */
  rollbackOnFailure?: boolean;
  /** 通知先ARN（AWSの場合） */
  notificationArns?: string[];
  /** ドライラン */
  dryRun?: boolean;
}

/**
 * クリーンアップオプション
 */
export interface CleanupOptions {
  /** 除外するリソースタイプ */
  excludeResourceTypes?: string[];
  /** 除外するリソース名パターン */
  excludePatterns?: string[];
  /** 除外するタグ */
  excludeTags?: Record<string, string>;
  /** ドライラン */
  dryRun?: boolean;
  /** 強制削除 */
  force?: boolean;
}

/**
 * クリーンアップ結果
 */
export interface CleanupResult {
  success: boolean;
  deletedResources: DeletedResource[];
  failedResources: FailedResource[];
  totalDeleted: number;
  totalFailed: number;
  dryRun: boolean;
}

export interface DeletedResource {
  type: string;
  id: string;
  name?: string;
  region?: string;
}

export interface FailedResource {
  type: string;
  id: string;
  name?: string;
  region?: string;
  error: string;
}

/**
 * リージョン情報
 */
export interface RegionInfo {
  code: string;
  name: string;
  available: boolean;
}

/**
 * アカウント情報
 */
export interface AccountInfo {
  accountId: string;
  accountName?: string;
  alias?: string;
  provider: CloudProvider;
}

/**
 * 採点関数インターフェース
 */
export interface IScoringFunction {
  /**
   * 採点関数のデプロイ
   * @param problem 問題定義
   * @param credentials 認証情報
   * @param options オプション
   * @returns デプロイ結果
   */
  deploy(
    problem: Problem,
    credentials: CloudCredentials,
    options: ScoringFunctionDeployOptions
  ): Promise<ScoringFunctionDeployResult>;

  /**
   * 採点の実行
   * @param functionArn 関数ARN/URL
   * @param payload ペイロード
   * @param credentials 認証情報
   * @returns 採点結果
   */
  invoke(
    functionArn: string,
    payload: ScoringPayload,
    credentials: CloudCredentials
  ): Promise<ScoringResponse>;

  /**
   * 採点関数の削除
   * @param functionArn 関数ARN/URL
   * @param credentials 認証情報
   */
  delete(functionArn: string, credentials: CloudCredentials): Promise<void>;
}

export interface ScoringFunctionDeployOptions {
  functionName: string;
  region: string;
  timeout?: number;
  memorySize?: number;
  environment?: Record<string, string>;
}

export interface ScoringFunctionDeployResult {
  success: boolean;
  functionArn?: string;
  functionUrl?: string;
  error?: string;
}

export interface ScoringPayload {
  problemId: string;
  competitorAccountId: string;
  region: string;
  stackOutputs: Record<string, string>;
  criteria: string[];
}

export interface ScoringResponse {
  success: boolean;
  scores: {
    criterion: string;
    score: number;
    maxScore: number;
    details?: string;
  }[];
  error?: string;
}

/**
 * プロバイダーファクトリー
 *
 * プロバイダーのインスタンスを生成するファクトリー
 */
export interface ICloudProviderFactory {
  /**
   * プロバイダーインスタンスの取得
   * @param provider プロバイダー識別子
   * @returns プロバイダーインスタンス
   */
  getProvider(provider: CloudProvider): ICloudProvider;

  /**
   * 登録済みプロバイダー一覧の取得
   * @returns プロバイダー一覧
   */
  getRegisteredProviders(): CloudProvider[];

  /**
   * プロバイダーの登録
   * @param provider プロバイダーインスタンス
   */
  registerProvider(provider: ICloudProvider): void;
}

/**
 * デプロイオーケストレーター
 *
 * 複数の問題を複数のアカウントに並列デプロイする
 */
export interface IDeploymentOrchestrator {
  /**
   * デプロイジョブの作成
   * @param jobs デプロイジョブ一覧
   * @returns 作成されたジョブID一覧
   */
  createJobs(jobs: Omit<DeploymentJob, 'id' | 'createdAt'>[]): Promise<string[]>;

  /**
   * デプロイの開始
   * @param jobIds ジョブID一覧
   * @param options オプション
   */
  startDeployment(jobIds: string[], options?: OrchestratorOptions): Promise<void>;

  /**
   * デプロイステータスの取得
   * @param jobIds ジョブID一覧
   * @returns ジョブステータス一覧
   */
  getStatus(jobIds: string[]): Promise<DeploymentJob[]>;

  /**
   * デプロイのキャンセル
   * @param jobIds ジョブID一覧
   */
  cancelDeployment(jobIds: string[]): Promise<void>;

  /**
   * デプロイ進捗のサブスクライブ
   * @param jobIds ジョブID一覧
   * @param callback コールバック
   * @returns unsubscribe関数
   */
  subscribe(jobIds: string[], callback: (job: DeploymentJob) => void): () => void;
}

export interface OrchestratorOptions {
  /** 並列実行数 */
  concurrency?: number;
  /** リトライ回数 */
  maxRetries?: number;
  /** リトライ間隔（秒） */
  retryDelaySeconds?: number;
  /** タイムアウト（秒） */
  timeoutSeconds?: number;
}
