/**
 * Problem Deployer Tests
 *
 * 問題デプロイヤーの振る舞いテスト（BDD スタイル）
 *
 * このテストは問題デプロイヤーの外部仕様を検証する。
 * - イベント開始時に参加者環境へ問題をデプロイする
 * - デプロイの進捗をリアルタイムで追跡できる
 * - デプロイの成功・失敗を適切に管理する
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ProblemDeployer, getProblemDeployer } from '../problems/deployer';
import { CloudProviderFactory } from '../providers/factory';
import type { ICloudProvider } from '../providers/interface';
import type { Problem, CloudCredentials, DeploymentJob } from '../types';

// =============================================================================
// テストフィクスチャ
// =============================================================================

/**
 * モックプロバイダーを作成する
 */
const createMockProvider = (shouldSucceed = true): ICloudProvider => ({
  provider: 'aws',
  displayName: 'Mock AWS Provider',
  validateCredentials: vi.fn().mockResolvedValue(true),
  deployStack: vi.fn().mockResolvedValue({
    success: shouldSucceed,
    stackName: 'test-stack',
    stackId: 'stack-123',
    startedAt: new Date(),
    completedAt: new Date(),
    error: shouldSucceed ? undefined : 'Deployment failed',
  }),
  getStackStatus: vi.fn().mockResolvedValue(null),
  deleteStack: vi
    .fn()
    .mockResolvedValue({ success: true, startedAt: new Date() }),
  getStackOutputs: vi.fn().mockResolvedValue({}),
  uploadStaticFiles: vi.fn().mockResolvedValue('https://example.com/files'),
  cleanupResources: vi.fn().mockResolvedValue({
    success: true,
    deletedResources: [],
    failedResources: [],
    totalDeleted: 0,
    totalFailed: 0,
    dryRun: false,
  }),
  getAvailableRegions: vi.fn().mockResolvedValue([]),
  getAccountInfo: vi.fn().mockResolvedValue({
    accountId: '123456789012',
    provider: 'aws',
  }),
});

/**
 * テスト用の問題を作成する
 */
const createMockProblem = (id = 'problem-1'): Problem => ({
  id,
  title: 'テスト問題',
  type: 'gameday',
  category: 'architecture',
  difficulty: 'medium',
  metadata: {
    author: 'test',
    version: '1.0.0',
    createdAt: '2024-01-01',
  },
  description: {
    overview: 'テスト概要',
    objectives: ['目標1'],
    hints: ['ヒント1'],
  },
  deployment: {
    providers: ['aws'],
    templates: {
      aws: {
        type: 'cloudformation',
        path: '/templates/test.yaml',
      },
    },
    regions: {
      aws: ['ap-northeast-1'],
    },
  },
  scoring: {
    type: 'lambda',
    path: '/scoring/test',
    criteria: [{ name: 'EC2', weight: 100, maxPoints: 100 }],
    timeoutMinutes: 10,
  },
});

/**
 * テスト用の認証情報を作成する
 */
const createMockCredentials = (accountId = 'account-1'): CloudCredentials => ({
  provider: 'aws',
  accountId,
  region: 'ap-northeast-1',
});

/**
 * デプロイジョブのテストデータを作成する
 */
const createJobData = (
  overrides: Partial<Omit<DeploymentJob, 'id' | 'createdAt'>> = {}
): Omit<DeploymentJob, 'id' | 'createdAt'> => ({
  eventId: 'event-1',
  problemId: 'problem-1',
  competitorAccountId: 'account-1',
  provider: 'aws',
  region: 'ap-northeast-1',
  status: 'pending',
  retryCount: 0,
  maxRetries: 3,
  ...overrides,
});

// =============================================================================
// 問題のキャッシュ登録に関するテスト
// =============================================================================

describe('イベントで使用する問題を登録する場合', () => {
  let deployer: ProblemDeployer;
  let factory: CloudProviderFactory;

  beforeEach(() => {
    deployer = new ProblemDeployer();
    factory = CloudProviderFactory.getInstance();
    factory.clearProviders();
  });

  it('問題定義がデプロイヤーにキャッシュされるべき', () => {
    // Given: 問題定義
    const problem = createMockProblem();

    // When: 問題を登録する
    deployer.registerProblem(problem);

    // Then: 登録が成功する（後続のデプロイテストで確認）
  });
});

// =============================================================================
// 認証情報の登録に関するテスト
// =============================================================================

describe('参加者の認証情報を登録する場合', () => {
  let deployer: ProblemDeployer;
  let factory: CloudProviderFactory;

  beforeEach(() => {
    deployer = new ProblemDeployer();
    factory = CloudProviderFactory.getInstance();
    factory.clearProviders();
  });

  it('認証情報がデプロイヤーにキャッシュされるべき', () => {
    // Given: 参加者の認証情報
    const credentials = createMockCredentials();

    // When: 認証情報を登録する
    deployer.registerCredentials('account-1', credentials);

    // Then: 登録が成功する（後続のデプロイテストで確認）
  });
});

// =============================================================================
// デプロイジョブの作成に関するテスト
// =============================================================================

describe('デプロイジョブを作成する場合', () => {
  let deployer: ProblemDeployer;
  let factory: CloudProviderFactory;

  beforeEach(() => {
    deployer = new ProblemDeployer();
    factory = CloudProviderFactory.getInstance();
    factory.clearProviders();
  });

  describe('単一のジョブを作成した場合', () => {
    it('一意のジョブ ID が発行されるべき', async () => {
      // Given: デプロイジョブ情報
      const jobData = [createJobData()];

      // When: ジョブを作成する
      const jobIds = await deployer.createJobs(jobData);

      // Then: 一意のジョブ ID が発行される
      expect(jobIds).toHaveLength(1);
      expect(jobIds[0]).toMatch(/^job-\d+-[a-z0-9]+$/);
    });
  });

  describe('複数のジョブを一括作成した場合', () => {
    it('ジョブごとに異なる ID が発行されるべき', async () => {
      // Given: 複数のデプロイジョブ情報
      const jobData = [
        createJobData({
          problemId: 'problem-1',
          competitorAccountId: 'account-1',
        }),
        createJobData({
          problemId: 'problem-2',
          competitorAccountId: 'account-2',
        }),
      ];

      // When: ジョブを一括作成する
      const jobIds = await deployer.createJobs(jobData);

      // Then: すべてのジョブに異なる ID が発行される
      expect(jobIds).toHaveLength(2);
      expect(jobIds[0]).not.toBe(jobIds[1]);
    });
  });
});

// =============================================================================
// デプロイステータスの確認に関するテスト
// =============================================================================

describe('デプロイジョブのステータスを確認する場合', () => {
  let deployer: ProblemDeployer;
  let factory: CloudProviderFactory;

  beforeEach(() => {
    deployer = new ProblemDeployer();
    factory = CloudProviderFactory.getInstance();
    factory.clearProviders();
  });

  describe('存在するジョブ ID を指定した場合', () => {
    it('現在のステータスが取得できるべき', async () => {
      // Given: 作成済みのジョブ
      const jobIds = await deployer.createJobs([createJobData()]);

      // When: ステータスを取得する
      const status = await deployer.getStatus(jobIds);

      // Then: ステータスが取得できる
      expect(status).toHaveLength(1);
      expect(status[0].status).toBe('pending');
    });
  });

  describe('存在しないジョブ ID を指定した場合', () => {
    it('結果が空であるべき', async () => {
      // When: 存在しないジョブ ID でステータスを取得する
      const status = await deployer.getStatus(['non-existent']);

      // Then: 結果が空
      expect(status).toHaveLength(0);
    });
  });
});

// =============================================================================
// デプロイのキャンセルに関するテスト
// =============================================================================

describe('デプロイをキャンセルする場合', () => {
  let deployer: ProblemDeployer;
  let factory: CloudProviderFactory;

  beforeEach(() => {
    deployer = new ProblemDeployer();
    factory = CloudProviderFactory.getInstance();
    factory.clearProviders();
  });

  describe('pending 状態のジョブをキャンセルした場合', () => {
    it('ジョブは pending 状態のまま保持されるべき（実行前はキャンセル不可）', async () => {
      // Given: pending 状態のジョブ
      const jobIds = await deployer.createJobs([createJobData()]);

      // When: キャンセルを試行する
      await deployer.cancelDeployment(jobIds);

      // Then: pending 状態のまま（実行中のみキャンセル可能）
      const status = await deployer.getStatus(jobIds);
      expect(status[0].status).toBe('pending');
    });
  });

  describe('存在しないジョブをキャンセルした場合', () => {
    it('エラーにならずに正常終了するべき', async () => {
      // When: 存在しないジョブをキャンセルする
      // Then: エラーにならない
      await expect(
        deployer.cancelDeployment(['non-existent'])
      ).resolves.not.toThrow();
    });
  });
});

// =============================================================================
// デプロイ進捗の購読に関するテスト
// =============================================================================

describe('デプロイ進捗を購読する場合', () => {
  let deployer: ProblemDeployer;
  let factory: CloudProviderFactory;

  beforeEach(() => {
    deployer = new ProblemDeployer();
    factory = CloudProviderFactory.getInstance();
    factory.clearProviders();
  });

  describe('購読を開始した場合', () => {
    it('購読解除用の関数が返されるべき', async () => {
      // Given: 作成済みのジョブ
      const jobIds = await deployer.createJobs([createJobData()]);

      // When: 進捗を購読する
      const callback = vi.fn();
      const unsubscribe = deployer.subscribe(jobIds, callback);

      // Then: 購読解除関数が返される
      expect(typeof unsubscribe).toBe('function');
    });
  });

  describe('購読を解除した場合', () => {
    it('エラーなく解除されるべき', async () => {
      // Given: 購読中の状態
      const jobIds = await deployer.createJobs([createJobData()]);
      const callback = vi.fn();
      const unsubscribe = deployer.subscribe(jobIds, callback);

      // When: 購読を解除する
      unsubscribe();

      // Then: エラーなく実行される
    });
  });
});

// =============================================================================
// ステータスサマリーの取得に関するテスト
// =============================================================================

describe('デプロイ状況のサマリーを取得する場合', () => {
  let deployer: ProblemDeployer;
  let factory: CloudProviderFactory;

  beforeEach(() => {
    deployer = new ProblemDeployer();
    factory = CloudProviderFactory.getInstance();
    factory.clearProviders();
  });

  describe('複数のジョブが存在する場合', () => {
    it('ステータスごとの件数が集計されるべき', async () => {
      // Given: 複数の pending ジョブ
      const jobIds = await deployer.createJobs([
        createJobData({
          problemId: 'problem-1',
          competitorAccountId: 'account-1',
        }),
        createJobData({
          problemId: 'problem-2',
          competitorAccountId: 'account-2',
        }),
      ]);

      // When: サマリーを取得する
      const summary = deployer.getStatusSummary(jobIds);

      // Then: 件数が正しく集計される
      expect(summary.total).toBe(2);
      expect(summary.pending).toBe(2);
      expect(summary.inProgress).toBe(0);
      expect(summary.completed).toBe(0);
      expect(summary.failed).toBe(0);
      expect(summary.cancelled).toBe(0);
    });
  });

  describe('存在しないジョブ ID が含まれる場合', () => {
    it('存在しないジョブは集計対象外となるべき', () => {
      // When: 存在しないジョブ ID でサマリーを取得する
      const summary = deployer.getStatusSummary(['non-existent']);

      // Then: total は 1 だが、どのステータスにもカウントされない
      expect(summary.total).toBe(1);
      expect(summary.pending).toBe(0);
    });
  });
});

// =============================================================================
// デプロイ実行に関するテスト
// =============================================================================

describe('問題をデプロイする場合', () => {
  let deployer: ProblemDeployer;
  let factory: CloudProviderFactory;

  beforeEach(() => {
    deployer = new ProblemDeployer();
    factory = CloudProviderFactory.getInstance();
    factory.clearProviders();
  });

  describe('問題がキャッシュに登録されていない場合', () => {
    it('デプロイは失敗ステータスになるべき', async () => {
      // Given: 問題を登録せず、認証情報とプロバイダーのみ登録
      factory.registerProvider(createMockProvider());
      const credentials = createMockCredentials();
      deployer.registerCredentials('account-1', credentials);

      const jobIds = await deployer.createJobs([
        createJobData({ maxRetries: 0 }),
      ]);

      // When: デプロイを開始する
      await deployer.startDeployment(jobIds, { maxRetries: 0 });

      // Then: 失敗ステータスになる
      const status = await deployer.getStatus(jobIds);
      expect(status[0].status).toBe('failed');
      expect(status[0].error).toContain('Problem problem-1 not found');
    });
  });

  describe('認証情報がキャッシュに登録されていない場合', () => {
    it('デプロイは失敗ステータスになるべき', async () => {
      // Given: 認証情報を登録せず、問題とプロバイダーのみ登録
      factory.registerProvider(createMockProvider());
      const problem = createMockProblem();
      deployer.registerProblem(problem);

      const jobIds = await deployer.createJobs([
        createJobData({ maxRetries: 0 }),
      ]);

      // When: デプロイを開始する
      await deployer.startDeployment(jobIds, { maxRetries: 0 });

      // Then: 失敗ステータスになる
      const status = await deployer.getStatus(jobIds);
      expect(status[0].status).toBe('failed');
      expect(status[0].error).toContain(
        'Credentials for account account-1 not found'
      );
    });
  });

  describe('クラウドプロバイダーが登録されていない場合', () => {
    it('デプロイは失敗ステータスになるべき', async () => {
      // Given: プロバイダーを登録せず、問題と認証情報のみ登録
      const problem = createMockProblem();
      const credentials = createMockCredentials();
      deployer.registerProblem(problem);
      deployer.registerCredentials('account-1', credentials);

      const jobIds = await deployer.createJobs([
        createJobData({ maxRetries: 0 }),
      ]);

      // When: デプロイを開始する
      await deployer.startDeployment(jobIds, { maxRetries: 0 });

      // Then: 失敗ステータスになる
      const status = await deployer.getStatus(jobIds);
      expect(status[0].status).toBe('failed');
      expect(status[0].error).toContain('Provider aws not available');
    });
  });

  describe('すべての前提条件が満たされている場合', () => {
    it('デプロイは完了ステータスになるべき', async () => {
      // Given: すべてのリソースを登録
      factory.registerProvider(createMockProvider(true));
      const problem = createMockProblem();
      const credentials = createMockCredentials();
      deployer.registerProblem(problem);
      deployer.registerCredentials('account-1', credentials);

      const jobIds = await deployer.createJobs([createJobData()]);

      // When: デプロイを開始する
      await deployer.startDeployment(jobIds, { maxRetries: 0 });

      // Then: 完了ステータスになる
      const status = await deployer.getStatus(jobIds);
      expect(status[0].status).toBe('completed');
      expect(status[0].stackName).toBe('test-stack');
      expect(status[0].stackId).toBe('stack-123');
    });
  });

  describe('クラウドプロバイダーがデプロイに失敗した場合', () => {
    it('デプロイは失敗ステータスになるべき', async () => {
      // Given: デプロイに失敗するプロバイダー
      factory.registerProvider(createMockProvider(false));
      const problem = createMockProblem();
      const credentials = createMockCredentials();
      deployer.registerProblem(problem);
      deployer.registerCredentials('account-1', credentials);

      const jobIds = await deployer.createJobs([
        createJobData({ maxRetries: 0 }),
      ]);

      // When: デプロイを開始する
      await deployer.startDeployment(jobIds, {
        maxRetries: 0,
        retryDelaySeconds: 0,
      });

      // Then: 失敗ステータスになる
      const status = await deployer.getStatus(jobIds);
      expect(status[0].status).toBe('failed');
      expect(status[0].error).toBe('Deployment failed');
    });
  });
});

// =============================================================================
// イベント全体のデプロイに関するテスト
// =============================================================================

describe('イベント全体をデプロイする場合', () => {
  let deployer: ProblemDeployer;
  let factory: CloudProviderFactory;

  beforeEach(() => {
    deployer = new ProblemDeployer();
    factory = CloudProviderFactory.getInstance();
    factory.clearProviders();
  });

  describe('複数の問題と参加者がいる場合', () => {
    it('すべての組み合わせに対してデプロイが実行されるべき', async () => {
      // Given: 2つの問題と2つのアカウント
      factory.registerProvider(createMockProvider(true));
      const problems = [
        createMockProblem('problem-1'),
        createMockProblem('problem-2'),
      ];
      const accounts = [
        { id: 'account-1', credentials: createMockCredentials('account-1') },
        { id: 'account-2', credentials: createMockCredentials('account-2') },
      ];

      // When: イベント全体をデプロイする
      const jobIds = await deployer.deployEvent(
        'event-1',
        problems,
        accounts,
        'aws',
        'ap-northeast-1',
        { maxRetries: 0 }
      );

      // Then: 問題2 × アカウント2 = 4ジョブが作成され、すべて完了
      expect(jobIds).toHaveLength(4);
      const status = await deployer.getStatus(jobIds);
      expect(status.every((s) => s.status === 'completed')).toBe(true);
    });
  });
});

// =============================================================================
// シングルトンインスタンスに関するテスト
// =============================================================================

describe('グローバルデプロイヤーインスタンスを取得する場合', () => {
  it('常に同じインスタンスが返されるべき', () => {
    // When: デプロイヤーインスタンスを2回取得する
    const deployer1 = getProblemDeployer();
    const deployer2 = getProblemDeployer();

    // Then: 同一インスタンスが返される
    expect(deployer1).toBe(deployer2);
  });
});
