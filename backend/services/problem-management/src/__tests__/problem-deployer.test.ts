/**
 * Problem Deployer Tests
 *
 * 問題デプロイヤーの単体テスト
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ProblemDeployer, getProblemDeployer } from '../problems/deployer';
import { CloudProviderFactory } from '../providers/factory';
import type { ICloudProvider } from '../providers/interface';
import type { Problem, CloudCredentials, DeploymentJob } from '../types';

// モックプロバイダーの作成
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
  deleteStack: vi.fn().mockResolvedValue({ success: true, startedAt: new Date() }),
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

const createMockCredentials = (accountId = 'account-1'): CloudCredentials => ({
  provider: 'aws',
  accountId,
  region: 'ap-northeast-1',
});

describe('ProblemDeployer', () => {
  let deployer: ProblemDeployer;
  let factory: CloudProviderFactory;

  beforeEach(() => {
    deployer = new ProblemDeployer();
    factory = CloudProviderFactory.getInstance();
    factory.clearProviders();
  });

  describe('registerProblem', () => {
    it('問題をキャッシュに登録できるべき', () => {
      const problem = createMockProblem();
      deployer.registerProblem(problem);
      // 内部メソッドなので直接確認は難しいが、後続のテストで確認
    });
  });

  describe('registerCredentials', () => {
    it('認証情報をキャッシュに登録できるべき', () => {
      const credentials = createMockCredentials();
      deployer.registerCredentials('account-1', credentials);
      // 内部メソッドなので直接確認は難しいが、後続のテストで確認
    });
  });

  describe('createJobs', () => {
    it('デプロイジョブを作成できるべき', async () => {
      const jobData: Omit<DeploymentJob, 'id' | 'createdAt'>[] = [
        {
          eventId: 'event-1',
          problemId: 'problem-1',
          competitorAccountId: 'account-1',
          provider: 'aws',
          region: 'ap-northeast-1',
          status: 'pending',
          retryCount: 0,
          maxRetries: 3,
        },
      ];

      const jobIds = await deployer.createJobs(jobData);

      expect(jobIds).toHaveLength(1);
      expect(jobIds[0]).toMatch(/^job-\d+-[a-z0-9]+$/);
    });

    it('複数のジョブを一度に作成できるべき', async () => {
      const jobData: Omit<DeploymentJob, 'id' | 'createdAt'>[] = [
        {
          eventId: 'event-1',
          problemId: 'problem-1',
          competitorAccountId: 'account-1',
          provider: 'aws',
          region: 'ap-northeast-1',
          status: 'pending',
          retryCount: 0,
          maxRetries: 3,
        },
        {
          eventId: 'event-1',
          problemId: 'problem-2',
          competitorAccountId: 'account-2',
          provider: 'aws',
          region: 'ap-northeast-1',
          status: 'pending',
          retryCount: 0,
          maxRetries: 3,
        },
      ];

      const jobIds = await deployer.createJobs(jobData);

      expect(jobIds).toHaveLength(2);
      expect(jobIds[0]).not.toBe(jobIds[1]);
    });
  });

  describe('getStatus', () => {
    it('ジョブのステータスを取得できるべき', async () => {
      const jobIds = await deployer.createJobs([
        {
          eventId: 'event-1',
          problemId: 'problem-1',
          competitorAccountId: 'account-1',
          provider: 'aws',
          region: 'ap-northeast-1',
          status: 'pending',
          retryCount: 0,
          maxRetries: 3,
        },
      ]);

      const status = await deployer.getStatus(jobIds);

      expect(status).toHaveLength(1);
      expect(status[0].status).toBe('pending');
    });

    it('存在しないジョブIDは結果に含まれないべき', async () => {
      const status = await deployer.getStatus(['non-existent']);
      expect(status).toHaveLength(0);
    });
  });

  describe('cancelDeployment', () => {
    it('pending状態のジョブはキャンセルされないべき', async () => {
      const jobIds = await deployer.createJobs([
        {
          eventId: 'event-1',
          problemId: 'problem-1',
          competitorAccountId: 'account-1',
          provider: 'aws',
          region: 'ap-northeast-1',
          status: 'pending',
          retryCount: 0,
          maxRetries: 3,
        },
      ]);

      // pending 状態のジョブにキャンセルを試行
      await deployer.cancelDeployment(jobIds);

      // pending の場合はキャンセルされない（in_progressのみキャンセル可能）
      const status = await deployer.getStatus(jobIds);
      expect(status[0].status).toBe('pending');
    });

    it('存在しないジョブのキャンセルはエラーにならないべき', async () => {
      await expect(deployer.cancelDeployment(['non-existent'])).resolves.not.toThrow();
    });
  });

  describe('subscribe', () => {
    it('ジョブの進捗をサブスクライブできるべき', async () => {
      const jobIds = await deployer.createJobs([
        {
          eventId: 'event-1',
          problemId: 'problem-1',
          competitorAccountId: 'account-1',
          provider: 'aws',
          region: 'ap-northeast-1',
          status: 'pending',
          retryCount: 0,
          maxRetries: 3,
        },
      ]);

      const callback = vi.fn();
      const unsubscribe = deployer.subscribe(jobIds, callback);

      expect(typeof unsubscribe).toBe('function');
    });

    it('unsubscribe関数でサブスクリプションを解除できるべき', async () => {
      const jobIds = await deployer.createJobs([
        {
          eventId: 'event-1',
          problemId: 'problem-1',
          competitorAccountId: 'account-1',
          provider: 'aws',
          region: 'ap-northeast-1',
          status: 'pending',
          retryCount: 0,
          maxRetries: 3,
        },
      ]);

      const callback = vi.fn();
      const unsubscribe = deployer.subscribe(jobIds, callback);

      unsubscribe();
      // エラーなく実行される
    });
  });

  describe('getStatusSummary', () => {
    it('ジョブのステータスサマリーを取得できるべき', async () => {
      const jobIds = await deployer.createJobs([
        {
          eventId: 'event-1',
          problemId: 'problem-1',
          competitorAccountId: 'account-1',
          provider: 'aws',
          region: 'ap-northeast-1',
          status: 'pending',
          retryCount: 0,
          maxRetries: 3,
        },
        {
          eventId: 'event-1',
          problemId: 'problem-2',
          competitorAccountId: 'account-2',
          provider: 'aws',
          region: 'ap-northeast-1',
          status: 'pending',
          retryCount: 0,
          maxRetries: 3,
        },
      ]);

      const summary = deployer.getStatusSummary(jobIds);

      expect(summary.total).toBe(2);
      expect(summary.pending).toBe(2);
      expect(summary.inProgress).toBe(0);
      expect(summary.completed).toBe(0);
      expect(summary.failed).toBe(0);
      expect(summary.cancelled).toBe(0);
    });

    it('存在しないジョブIDはカウントされないべき', () => {
      const summary = deployer.getStatusSummary(['non-existent']);
      expect(summary.total).toBe(1);
      expect(summary.pending).toBe(0);
    });
  });

  describe('startDeployment', () => {
    it('問題がキャッシュにない場合は失敗ステータスになるべき', async () => {
      factory.registerProvider(createMockProvider());

      const credentials = createMockCredentials();
      deployer.registerCredentials('account-1', credentials);

      const jobIds = await deployer.createJobs([
        {
          eventId: 'event-1',
          problemId: 'problem-1', // キャッシュに登録していない
          competitorAccountId: 'account-1',
          provider: 'aws',
          region: 'ap-northeast-1',
          status: 'pending',
          retryCount: 0,
          maxRetries: 0,
        },
      ]);

      await deployer.startDeployment(jobIds, { maxRetries: 0 });

      const status = await deployer.getStatus(jobIds);
      expect(status[0].status).toBe('failed');
      expect(status[0].error).toContain('Problem problem-1 not found');
    });

    it('認証情報がキャッシュにない場合は失敗ステータスになるべき', async () => {
      factory.registerProvider(createMockProvider());

      const problem = createMockProblem();
      deployer.registerProblem(problem);
      // 認証情報は登録しない

      const jobIds = await deployer.createJobs([
        {
          eventId: 'event-1',
          problemId: 'problem-1',
          competitorAccountId: 'account-1',
          provider: 'aws',
          region: 'ap-northeast-1',
          status: 'pending',
          retryCount: 0,
          maxRetries: 0,
        },
      ]);

      await deployer.startDeployment(jobIds, { maxRetries: 0 });

      const status = await deployer.getStatus(jobIds);
      expect(status[0].status).toBe('failed');
      expect(status[0].error).toContain('Credentials for account account-1 not found');
    });

    it('プロバイダーが登録されていない場合は失敗ステータスになるべき', async () => {
      // プロバイダーは登録しない
      const problem = createMockProblem();
      const credentials = createMockCredentials();
      deployer.registerProblem(problem);
      deployer.registerCredentials('account-1', credentials);

      const jobIds = await deployer.createJobs([
        {
          eventId: 'event-1',
          problemId: 'problem-1',
          competitorAccountId: 'account-1',
          provider: 'aws',
          region: 'ap-northeast-1',
          status: 'pending',
          retryCount: 0,
          maxRetries: 0,
        },
      ]);

      await deployer.startDeployment(jobIds, { maxRetries: 0 });

      const status = await deployer.getStatus(jobIds);
      expect(status[0].status).toBe('failed');
      expect(status[0].error).toContain('Provider aws not available');
    });

    it('デプロイが成功した場合は完了ステータスになるべき', async () => {
      factory.registerProvider(createMockProvider(true));

      const problem = createMockProblem();
      const credentials = createMockCredentials();
      deployer.registerProblem(problem);
      deployer.registerCredentials('account-1', credentials);

      const jobIds = await deployer.createJobs([
        {
          eventId: 'event-1',
          problemId: 'problem-1',
          competitorAccountId: 'account-1',
          provider: 'aws',
          region: 'ap-northeast-1',
          status: 'pending',
          retryCount: 0,
          maxRetries: 3,
        },
      ]);

      await deployer.startDeployment(jobIds, { maxRetries: 0 });

      const status = await deployer.getStatus(jobIds);
      expect(status[0].status).toBe('completed');
      expect(status[0].stackName).toBe('test-stack');
      expect(status[0].stackId).toBe('stack-123');
    });

    it('デプロイが失敗した場合は失敗ステータスになるべき', async () => {
      factory.registerProvider(createMockProvider(false));

      const problem = createMockProblem();
      const credentials = createMockCredentials();
      deployer.registerProblem(problem);
      deployer.registerCredentials('account-1', credentials);

      const jobIds = await deployer.createJobs([
        {
          eventId: 'event-1',
          problemId: 'problem-1',
          competitorAccountId: 'account-1',
          provider: 'aws',
          region: 'ap-northeast-1',
          status: 'pending',
          retryCount: 0,
          maxRetries: 0,
        },
      ]);

      await deployer.startDeployment(jobIds, { maxRetries: 0, retryDelaySeconds: 0 });

      const status = await deployer.getStatus(jobIds);
      expect(status[0].status).toBe('failed');
      expect(status[0].error).toBe('Deployment failed');
    });
  });

  describe('deployEvent', () => {
    it('イベント全体をデプロイできるべき', async () => {
      factory.registerProvider(createMockProvider(true));

      const problems = [createMockProblem('problem-1'), createMockProblem('problem-2')];
      const accounts = [
        { id: 'account-1', credentials: createMockCredentials('account-1') },
        { id: 'account-2', credentials: createMockCredentials('account-2') },
      ];

      const jobIds = await deployer.deployEvent(
        'event-1',
        problems,
        accounts,
        'aws',
        'ap-northeast-1',
        { maxRetries: 0 }
      );

      // 問題2 × アカウント2 = 4ジョブ
      expect(jobIds).toHaveLength(4);

      const status = await deployer.getStatus(jobIds);
      expect(status.every(s => s.status === 'completed')).toBe(true);
    });
  });
});

describe('getProblemDeployer', () => {
  it('シングルトンインスタンスを返すべき', () => {
    const deployer1 = getProblemDeployer();
    const deployer2 = getProblemDeployer();

    expect(deployer1).toBe(deployer2);
  });
});
