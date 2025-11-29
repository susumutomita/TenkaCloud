/**
 * Problem Deployer
 *
 * 問題のデプロイオーケストレーションを担当
 */

import { CloudProviderFactory } from '../providers/factory';
import type {
  CloudCredentials,
  CloudProvider,
  DeploymentJob,
  DeploymentJobStatus,
  DeploymentResult,
  Problem,
} from '../types';
import type {
  DeployStackOptions,
  IDeploymentOrchestrator,
  OrchestratorOptions,
} from '../providers/interface';

/**
 * デプロイジョブの状態管理
 */
interface JobState {
  job: DeploymentJob;
  subscribers: Set<(job: DeploymentJob) => void>;
}

/**
 * ProblemDeployer
 *
 * 問題を複数のアカウントに並列デプロイするオーケストレーター
 */
export class ProblemDeployer implements IDeploymentOrchestrator {
  private jobs: Map<string, JobState> = new Map();
  private problemCache: Map<string, Problem> = new Map();
  private credentialsCache: Map<string, CloudCredentials> = new Map();
  private factory: CloudProviderFactory;

  constructor() {
    this.factory = CloudProviderFactory.getInstance();
  }

  /**
   * 問題をキャッシュに登録
   */
  registerProblem(problem: Problem): void {
    this.problemCache.set(problem.id, problem);
  }

  /**
   * 認証情報をキャッシュに登録
   */
  registerCredentials(accountId: string, credentials: CloudCredentials): void {
    this.credentialsCache.set(accountId, credentials);
  }

  /**
   * デプロイジョブの作成
   */
  async createJobs(
    jobs: Omit<DeploymentJob, 'id' | 'createdAt'>[]
  ): Promise<string[]> {
    const jobIds: string[] = [];

    for (const jobData of jobs) {
      const id = this.generateJobId();
      const job: DeploymentJob = {
        ...jobData,
        id,
        createdAt: new Date(),
      };

      this.jobs.set(id, {
        job,
        subscribers: new Set(),
      });

      jobIds.push(id);
    }

    return jobIds;
  }

  /**
   * デプロイの開始
   */
  async startDeployment(
    jobIds: string[],
    options?: OrchestratorOptions
  ): Promise<void> {
    const concurrency = options?.concurrency ?? 10;
    const maxRetries = options?.maxRetries ?? 3;
    const retryDelaySeconds = options?.retryDelaySeconds ?? 30;

    // 並列実行のためのキューを作成
    const queue = [...jobIds];
    const running: Promise<void>[] = [];

    while (queue.length > 0 || running.length > 0) {
      // 同時実行数に達していない場合、新しいジョブを開始
      while (running.length < concurrency && queue.length > 0) {
        const jobId = queue.shift()!;
        const promise = this.executeJob(
          jobId,
          maxRetries,
          retryDelaySeconds
        ).finally(() => {
          // 完了したら running から削除
          const index = running.indexOf(promise);
          if (index > -1) {
            running.splice(index, 1);
          }
        });
        running.push(promise);
      }

      // いずれかのジョブが完了するまで待機
      if (running.length > 0) {
        await Promise.race(running);
      }
    }
  }

  /**
   * 単一ジョブの実行
   */
  private async executeJob(
    jobId: string,
    maxRetries: number,
    retryDelaySeconds: number
  ): Promise<void> {
    const state = this.jobs.get(jobId);
    if (!state) {
      console.error(`Job ${jobId} not found`);
      return;
    }

    const { job } = state;

    // ステータスを更新
    this.updateJobStatus(jobId, 'in_progress');

    // 問題と認証情報を取得
    const problem = this.problemCache.get(job.problemId);
    if (!problem) {
      this.updateJobStatus(
        jobId,
        'failed',
        `Problem ${job.problemId} not found`
      );
      return;
    }

    const credentials = this.credentialsCache.get(job.competitorAccountId);
    if (!credentials) {
      this.updateJobStatus(
        jobId,
        'failed',
        `Credentials for account ${job.competitorAccountId} not found`
      );
      return;
    }

    // プロバイダーを取得
    let provider;
    try {
      provider = this.factory.getProvider(job.provider);
    } catch {
      this.updateJobStatus(
        jobId,
        'failed',
        `Provider ${job.provider} not available`
      );
      return;
    }

    // デプロイ実行（リトライあり）
    let lastError: string | undefined;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const options: DeployStackOptions = {
          stackName: this.generateStackName(job),
          region: job.region,
          parameters: {
            ProblemId: problem.id,
            EventId: job.eventId,
            CompetitorAccountId: job.competitorAccountId,
          },
          tags: {
            'tenkacloud:event-id': job.eventId,
            'tenkacloud:problem-id': job.problemId,
            'tenkacloud:competitor-account': job.competitorAccountId,
          },
          rollbackOnFailure: true,
        };

        const result = await provider.deployStack(
          problem,
          credentials,
          options
        );

        if (result.success) {
          this.updateJobStatus(jobId, 'completed', undefined, result);
          return;
        }

        lastError = result.error;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }

      // リトライ前に待機
      if (attempt < maxRetries) {
        console.log(
          `Job ${jobId} failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${retryDelaySeconds}s...`
        );
        await this.sleep(retryDelaySeconds * 1000);
        state.job.retryCount = attempt + 1;
      }
    }

    // すべてのリトライが失敗
    this.updateJobStatus(jobId, 'failed', lastError);
  }

  /**
   * ジョブステータスの更新
   */
  private updateJobStatus(
    jobId: string,
    status: DeploymentJobStatus,
    error?: string,
    result?: DeploymentResult
  ): void {
    const state = this.jobs.get(jobId);
    if (!state) return;

    state.job.status = status;
    state.job.error = error;
    state.job.result = result;

    if (status === 'in_progress' && !state.job.startedAt) {
      state.job.startedAt = new Date();
    }

    if (
      status === 'completed' ||
      status === 'failed' ||
      status === 'cancelled'
    ) {
      state.job.completedAt = new Date();
    }

    if (result?.stackName) {
      state.job.stackName = result.stackName;
    }
    if (result?.stackId) {
      state.job.stackId = result.stackId;
    }

    // サブスクライバーに通知
    this.notifySubscribers(jobId);
  }

  /**
   * デプロイステータスの取得
   */
  async getStatus(jobIds: string[]): Promise<DeploymentJob[]> {
    return jobIds
      .map((id) => this.jobs.get(id)?.job)
      .filter((job): job is DeploymentJob => job !== undefined);
  }

  /**
   * デプロイのキャンセル
   */
  async cancelDeployment(jobIds: string[]): Promise<void> {
    for (const jobId of jobIds) {
      const state = this.jobs.get(jobId);
      if (state && state.job.status === 'in_progress') {
        this.updateJobStatus(jobId, 'cancelled');
        // 実際のキャンセル処理（スタック削除など）は別途実装が必要
      }
    }
  }

  /**
   * デプロイ進捗のサブスクライブ
   */
  subscribe(
    jobIds: string[],
    callback: (job: DeploymentJob) => void
  ): () => void {
    for (const jobId of jobIds) {
      const state = this.jobs.get(jobId);
      if (state) {
        state.subscribers.add(callback);
      }
    }

    // unsubscribe 関数を返す
    return () => {
      for (const jobId of jobIds) {
        const state = this.jobs.get(jobId);
        if (state) {
          state.subscribers.delete(callback);
        }
      }
    };
  }

  /**
   * サブスクライバーへの通知
   */
  private notifySubscribers(jobId: string): void {
    const state = this.jobs.get(jobId);
    if (!state) return;

    for (const callback of state.subscribers) {
      try {
        callback(state.job);
      } catch (error) {
        console.error(`Error in subscriber callback for job ${jobId}:`, error);
      }
    }
  }

  /**
   * ジョブIDの生成
   */
  private generateJobId(): string {
    return `job-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }

  /**
   * スタック名の生成
   *
   * CloudFormation スタック名の制約:
   * - 英数字とハイフンのみ
   * - 128文字以内
   * - 先頭は英字
   */
  private generateStackName(job: DeploymentJob): string {
    const sanitize = (input: string): string =>
      input.replace(/[^a-zA-Z0-9-]/g, '').substring(0, 20);

    const eventId = sanitize(job.eventId);
    const problemId = sanitize(job.problemId);
    const accountId = sanitize(job.competitorAccountId).substring(0, 8);

    return `tenkacloud-${eventId}-${problemId}-${accountId}`;
  }

  /**
   * スリープ
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ==========================================================================
  // ヘルパーメソッド
  // ==========================================================================

  /**
   * イベント全体のデプロイ
   */
  async deployEvent(
    eventId: string,
    problems: Problem[],
    competitorAccounts: { id: string; credentials: CloudCredentials }[],
    provider: CloudProvider,
    region: string,
    options?: OrchestratorOptions
  ): Promise<string[]> {
    // 問題をキャッシュに登録
    for (const problem of problems) {
      this.registerProblem(problem);
    }

    // 認証情報をキャッシュに登録
    for (const account of competitorAccounts) {
      this.registerCredentials(account.id, account.credentials);
    }

    // 全組み合わせのジョブを作成
    const jobData: Omit<DeploymentJob, 'id' | 'createdAt'>[] = [];
    for (const problem of problems) {
      for (const account of competitorAccounts) {
        jobData.push({
          eventId,
          problemId: problem.id,
          competitorAccountId: account.id,
          provider,
          region,
          status: 'pending',
          retryCount: 0,
          maxRetries: options?.maxRetries || 3,
        });
      }
    }

    // ジョブを作成
    const jobIds = await this.createJobs(jobData);

    // デプロイを開始
    await this.startDeployment(jobIds, options);

    return jobIds;
  }

  /**
   * 全ジョブのステータスサマリーを取得
   */
  getStatusSummary(jobIds: string[]): {
    total: number;
    pending: number;
    inProgress: number;
    completed: number;
    failed: number;
    cancelled: number;
  } {
    const summary = {
      total: jobIds.length,
      pending: 0,
      inProgress: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    };

    for (const jobId of jobIds) {
      const state = this.jobs.get(jobId);
      if (!state) continue;

      switch (state.job.status) {
        case 'pending':
        case 'queued':
          summary.pending++;
          break;
        case 'in_progress':
          summary.inProgress++;
          break;
        case 'completed':
          summary.completed++;
          break;
        case 'failed':
        case 'rollback_in_progress':
        case 'rolled_back':
          summary.failed++;
          break;
        case 'cancelled':
          summary.cancelled++;
          break;
      }
    }

    return summary;
  }
}

/**
 * シングルトンインスタンスを取得
 */
let deployerInstance: ProblemDeployer | null = null;

export function getProblemDeployer(): ProblemDeployer {
  if (!deployerInstance) {
    deployerInstance = new ProblemDeployer();
  }
  return deployerInstance;
}
