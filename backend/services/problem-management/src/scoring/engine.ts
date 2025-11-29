/**
 * Scoring Engine
 *
 * 問題採点エンジン - 各クラウドプロバイダーでの採点実行を管理
 */

import type {
  CloudCredentials,
  CloudProvider,
  Problem,
  ScoringResult,
} from '../types';

/**
 * 採点関数インターフェース（採点エンジン用）
 */
export interface IScoringExecutor {
  readonly type: string;
  execute(
    problem: Problem,
    credentials: CloudCredentials,
    competitorAccountId: string
  ): Promise<ScoringExecutionResult>;
}

export interface ScoringExecutionResult {
  totalScore: number;
  maxPossibleScore: number;
  criteriaResults: {
    name: string;
    points: number;
    maxPoints: number;
    passed: boolean;
    feedback: string;
  }[];
  executionTimeMs: number;
}

/**
 * 採点リクエスト
 */
export interface ScoringRequest {
  eventId: string;
  problemId: string;
  competitorAccountId: string;
  teamId?: string;
  credentials: CloudCredentials;
  problem: Problem;
}

/**
 * 採点ジョブ
 */
export interface ScoringJob {
  id: string;
  request: ScoringRequest;
  status: 'pending' | 'running' | 'completed' | 'failed';
  result?: ScoringResult;
  error?: string;
  startedAt?: Date;
  completedAt?: Date;
  retryCount: number;
}

/**
 * 採点エンジン設定
 */
export interface ScoringEngineConfig {
  maxConcurrency: number;
  retryAttempts: number;
  retryDelayMs: number;
  timeoutMs: number;
}

/**
 * 採点結果サブスクライバー
 */
export type ScoringResultSubscriber = (result: ScoringResult) => void;

/**
 * 採点エンジン
 *
 * 採点ジョブのキューイングと実行を管理
 */
export class ScoringEngine {
  private scoringFunctions: Map<CloudProvider, IScoringExecutor> = new Map();
  private jobQueue: ScoringJob[] = [];
  private activeJobs: Map<string, ScoringJob> = new Map();
  private subscribers: ScoringResultSubscriber[] = [];
  private config: ScoringEngineConfig;
  private isProcessing = false;
  private jobIdCounter = 0;

  constructor(config: Partial<ScoringEngineConfig> = {}) {
    this.config = {
      maxConcurrency: config.maxConcurrency ?? 5,
      retryAttempts: config.retryAttempts ?? 3,
      retryDelayMs: config.retryDelayMs ?? 5000,
      timeoutMs: config.timeoutMs ?? 300000, // 5分
    };
  }

  /**
   * 採点関数の登録
   */
  registerScoringFunction(provider: CloudProvider, scoringFunction: IScoringExecutor): void {
    this.scoringFunctions.set(provider, scoringFunction);
    console.log(`[ScoringEngine] Registered scoring function for provider: ${provider}`);
  }

  /**
   * 結果サブスクライバーの追加
   */
  subscribe(subscriber: ScoringResultSubscriber): () => void {
    this.subscribers.push(subscriber);
    return () => {
      const index = this.subscribers.indexOf(subscriber);
      if (index >= 0) {
        this.subscribers.splice(index, 1);
      }
    };
  }

  /**
   * 採点ジョブのエンキュー
   */
  enqueue(request: ScoringRequest): string {
    const jobId = `score-${++this.jobIdCounter}-${Date.now()}`;
    const job: ScoringJob = {
      id: jobId,
      request,
      status: 'pending',
      retryCount: 0,
    };

    this.jobQueue.push(job);
    console.log(`[ScoringEngine] Job enqueued: ${jobId} for problem ${request.problemId}`);

    // 処理を開始
    this.processQueue();

    return jobId;
  }

  /**
   * 一括採点のエンキュー
   */
  enqueueBatch(requests: ScoringRequest[]): string[] {
    return requests.map(request => this.enqueue(request));
  }

  /**
   * ジョブステータスの取得
   */
  getJobStatus(jobId: string): ScoringJob | undefined {
    return this.activeJobs.get(jobId) ||
      this.jobQueue.find(job => job.id === jobId);
  }

  /**
   * キュー処理
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessing) {
      return;
    }

    this.isProcessing = true;

    try {
      while (this.jobQueue.length > 0 && this.activeJobs.size < this.config.maxConcurrency) {
        const job = this.jobQueue.shift();
        if (!job) {
          break;
        }

        this.activeJobs.set(job.id, job);
        this.executeJob(job).catch(error => {
          console.error(`[ScoringEngine] Job ${job.id} failed:`, error);
        });
      }
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * ジョブ実行
   */
  private async executeJob(job: ScoringJob): Promise<void> {
    job.status = 'running';
    job.startedAt = new Date();

    const { request } = job;
    const provider = request.credentials.provider;

    try {
      const scoringFunction = this.scoringFunctions.get(provider);
      if (!scoringFunction) {
        throw new Error(`No scoring function registered for provider: ${provider}`);
      }

      // タイムアウト付きで採点実行
      const result = await this.executeWithTimeout(
        scoringFunction.execute(
          request.problem,
          request.credentials,
          request.competitorAccountId
        ),
        this.config.timeoutMs
      );

      // 結果を設定 - ScoringExecutionResult を ScoringResult に変換
      job.status = 'completed';
      job.completedAt = new Date();

      // criteriaResults を scores に変換
      const scores = result.criteriaResults.map(cr => ({
        criterion: cr.name,
        score: cr.points,
        maxScore: cr.maxPoints,
        details: cr.feedback,
      }));

      const percentage = result.maxPossibleScore > 0
        ? Math.round((result.totalScore / result.maxPossibleScore) * 100)
        : 0;

      job.result = {
        eventId: request.eventId,
        problemId: request.problemId,
        competitorAccountId: request.competitorAccountId,
        teamId: request.teamId,
        scores,
        totalScore: result.totalScore,
        maxTotalScore: result.maxPossibleScore,
        percentage,
        scoredAt: new Date(),
      };

      // サブスクライバーに通知
      this.notifySubscribers(job.result);

      console.log(`[ScoringEngine] Job ${job.id} completed with score: ${job.result.totalScore}`);

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // リトライ判定
      if (job.retryCount < this.config.retryAttempts) {
        job.retryCount++;
        job.status = 'pending';
        console.log(`[ScoringEngine] Job ${job.id} failed, retrying (${job.retryCount}/${this.config.retryAttempts})`);

        // 遅延してリトライ
        await this.delay(this.config.retryDelayMs);
        this.jobQueue.push(job);
      } else {
        job.status = 'failed';
        job.completedAt = new Date();
        job.error = errorMessage;
        console.error(`[ScoringEngine] Job ${job.id} failed permanently:`, errorMessage);
      }
    } finally {
      this.activeJobs.delete(job.id);
      this.processQueue();
    }
  }

  /**
   * タイムアウト付き実行
   */
  private async executeWithTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number
  ): Promise<T> {
    return Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Scoring timeout')), timeoutMs);
      }),
    ]);
  }

  /**
   * 遅延
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * サブスクライバーへの通知
   */
  private notifySubscribers(result: ScoringResult): void {
    for (const subscriber of this.subscribers) {
      try {
        subscriber(result);
      } catch (error) {
        console.error('[ScoringEngine] Subscriber error:', error);
      }
    }
  }

  /**
   * 統計情報の取得
   */
  getStats(): ScoringEngineStats {
    return {
      queuedJobs: this.jobQueue.length,
      activeJobs: this.activeJobs.size,
      registeredProviders: Array.from(this.scoringFunctions.keys()),
    };
  }
}

/**
 * 採点エンジン統計
 */
export interface ScoringEngineStats {
  queuedJobs: number;
  activeJobs: number;
  registeredProviders: CloudProvider[];
}

/**
 * Lambda 採点関数実装
 */
export class LambdaScoringFunction implements IScoringExecutor {
  readonly type = 'lambda';
  private functionArn: string;

  constructor(functionArn: string) {
    this.functionArn = functionArn;
  }

  async execute(
    problem: Problem,
    credentials: CloudCredentials,
    competitorAccountId: string
  ): Promise<ScoringExecutionResult> {
    // Lambda 関数を呼び出して採点
    console.log(`[LambdaScoring] Executing scoring for problem ${problem.id}`);
    console.log(`[LambdaScoring] Function ARN: ${this.functionArn}`);
    console.log(`[LambdaScoring] Competitor Account: ${competitorAccountId}`);

    // 実際の実装では AWS SDK を使用して Lambda を呼び出す
    // const lambda = new LambdaClient({ region: credentials.region });
    // const response = await lambda.send(new InvokeCommand({
    //   FunctionName: this.functionArn,
    //   Payload: JSON.stringify({ problem, competitorAccountId }),
    // }));

    // シミュレーション: 採点基準に基づいてスコアを計算
    const criteriaResults = problem.scoring.criteria.map(criterion => ({
      name: criterion.name,
      points: Math.floor(Math.random() * criterion.maxPoints),
      maxPoints: criterion.maxPoints,
      passed: Math.random() > 0.3,
      feedback: `${criterion.name}の評価結果`,
    }));

    const totalScore = criteriaResults.reduce((sum, r) => sum + r.points, 0);
    const maxPossibleScore = criteriaResults.reduce((sum, r) => sum + r.maxPoints, 0);

    return {
      totalScore,
      maxPossibleScore,
      criteriaResults,
      executionTimeMs: Math.floor(Math.random() * 5000) + 1000,
    };
  }
}

/**
 * コンテナ採点関数実装
 */
export class ContainerScoringFunction implements IScoringExecutor {
  readonly type = 'container';
  private imageUri: string;

  constructor(imageUri: string) {
    this.imageUri = imageUri;
  }

  async execute(
    problem: Problem,
    credentials: CloudCredentials,
    competitorAccountId: string
  ): Promise<ScoringExecutionResult> {
    console.log(`[ContainerScoring] Executing scoring for problem ${problem.id}`);
    console.log(`[ContainerScoring] Image URI: ${this.imageUri}`);
    console.log(`[ContainerScoring] Competitor Account: ${competitorAccountId}`);

    // 実際の実装では ECS/Fargate でコンテナを起動して採点
    // または Kubernetes Job を作成

    // シミュレーション
    const criteriaResults = problem.scoring.criteria.map(criterion => ({
      name: criterion.name,
      points: Math.floor(Math.random() * criterion.maxPoints),
      maxPoints: criterion.maxPoints,
      passed: Math.random() > 0.3,
      feedback: `${criterion.name}の評価結果`,
    }));

    const totalScore = criteriaResults.reduce((sum, r) => sum + r.points, 0);
    const maxPossibleScore = criteriaResults.reduce((sum, r) => sum + r.maxPoints, 0);

    return {
      totalScore,
      maxPossibleScore,
      criteriaResults,
      executionTimeMs: Math.floor(Math.random() * 10000) + 2000,
    };
  }
}

/**
 * ローカル採点関数実装（開発・テスト用）
 */
export class LocalScoringFunction implements IScoringExecutor {
  readonly type = 'local';

  async execute(
    problem: Problem,
    _credentials: CloudCredentials,
    competitorAccountId: string
  ): Promise<ScoringExecutionResult> {
    console.log(`[LocalScoring] Executing scoring for problem ${problem.id}`);
    console.log(`[LocalScoring] Competitor Account: ${competitorAccountId}`);

    // ローカルでの採点シミュレーション
    await new Promise(resolve => setTimeout(resolve, 500));

    const criteriaResults = problem.scoring.criteria.map(criterion => ({
      name: criterion.name,
      points: criterion.maxPoints, // ローカルでは満点
      maxPoints: criterion.maxPoints,
      passed: true,
      feedback: `${criterion.name}: OK (ローカル環境)`,
    }));

    const totalScore = criteriaResults.reduce((sum, r) => sum + r.points, 0);
    const maxPossibleScore = criteriaResults.reduce((sum, r) => sum + r.maxPoints, 0);

    return {
      totalScore,
      maxPossibleScore,
      criteriaResults,
      executionTimeMs: 500,
    };
  }
}

/**
 * デフォルトの採点エンジンインスタンスを取得
 */
export function createScoringEngine(config?: Partial<ScoringEngineConfig>): ScoringEngine {
  const engine = new ScoringEngine(config);

  // ローカル採点関数をデフォルトで登録
  engine.registerScoringFunction('local', new LocalScoringFunction());

  return engine;
}
