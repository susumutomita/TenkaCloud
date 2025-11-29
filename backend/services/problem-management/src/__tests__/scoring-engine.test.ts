/**
 * Scoring Engine Tests
 *
 * 採点エンジンの単体テスト
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  ScoringEngine,
  LocalScoringFunction,
  LambdaScoringFunction,
  ContainerScoringFunction,
  createScoringEngine,
} from '../scoring/engine';
import type { Problem, CloudCredentials, ScoringResult } from '../types';

// テスト用のモックデータ
const mockProblem: Problem = {
  id: 'test-problem-1',
  title: 'テスト問題',
  type: 'gameday',
  category: 'architecture',
  difficulty: 'medium',
  metadata: {
    author: 'test',
    version: '1.0.0',
    createdAt: '2024-01-01T00:00:00Z',
  },
  description: {
    overview: 'テスト概要',
    objectives: ['目標1', '目標2'],
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
    criteria: [
      { name: 'EC2構築', weight: 1, maxPoints: 50 },
      { name: 'S3設定', weight: 1, maxPoints: 30 },
      { name: 'セキュリティ', weight: 1, maxPoints: 20 },
    ],
    timeoutMinutes: 10,
  },
};

const mockCredentials: CloudCredentials = {
  provider: 'aws',
  accountId: '123456789012',
  region: 'ap-northeast-1',
};

describe('ScoringEngine', () => {
  let engine: ScoringEngine;

  beforeEach(() => {
    engine = new ScoringEngine({
      maxConcurrency: 3,
      retryAttempts: 2,
      retryDelayMs: 100,
      timeoutMs: 5000,
    });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('createScoringEngine', () => {
    it('デフォルト設定で採点エンジンを作成できるべき', () => {
      const engine = createScoringEngine();
      const stats = engine.getStats();

      expect(stats.registeredProviders).toContain('local');
    });

    it('カスタム設定で採点エンジンを作成できるべき', () => {
      const engine = createScoringEngine({
        maxConcurrency: 10,
        retryAttempts: 5,
      });

      const stats = engine.getStats();
      expect(stats.registeredProviders).toContain('local');
    });
  });

  describe('registerScoringFunction', () => {
    it('採点関数を登録できるべき', () => {
      const localScoring = new LocalScoringFunction();
      engine.registerScoringFunction('local', localScoring);

      const stats = engine.getStats();
      expect(stats.registeredProviders).toContain('local');
    });

    it('複数のプロバイダーに採点関数を登録できるべき', () => {
      engine.registerScoringFunction('local', new LocalScoringFunction());
      engine.registerScoringFunction('aws', new LambdaScoringFunction('arn:aws:lambda:test'));

      const stats = engine.getStats();
      expect(stats.registeredProviders).toContain('local');
      expect(stats.registeredProviders).toContain('aws');
    });
  });

  describe('subscribe', () => {
    it('結果サブスクライバーを追加できるべき', () => {
      const subscriber = vi.fn();
      const unsubscribe = engine.subscribe(subscriber);

      expect(typeof unsubscribe).toBe('function');
    });

    it('サブスクライバーを解除できるべき', () => {
      const subscriber = vi.fn();
      const unsubscribe = engine.subscribe(subscriber);

      unsubscribe();
      // 内部状態の確認は困難なので、エラーなく実行できることを確認
    });
  });

  describe('enqueue', () => {
    it('採点ジョブをエンキューできるべき', () => {
      engine.registerScoringFunction('aws', new LocalScoringFunction());

      const jobId = engine.enqueue({
        eventId: 'event-1',
        problemId: 'problem-1',
        competitorAccountId: 'account-1',
        credentials: mockCredentials,
        problem: mockProblem,
      });

      expect(jobId).toMatch(/^score-\d+-\d+$/);
    });

    it('ジョブステータスを取得できるべき', () => {
      engine.registerScoringFunction('aws', new LocalScoringFunction());

      const jobId = engine.enqueue({
        eventId: 'event-1',
        problemId: 'problem-1',
        competitorAccountId: 'account-1',
        credentials: mockCredentials,
        problem: mockProblem,
      });

      const status = engine.getJobStatus(jobId);
      expect(status).toBeDefined();
      expect(['pending', 'running', 'completed', 'failed']).toContain(status?.status);
    });
  });

  describe('enqueueBatch', () => {
    it('複数のジョブを一括エンキューできるべき', () => {
      engine.registerScoringFunction('aws', new LocalScoringFunction());

      const requests = [
        {
          eventId: 'event-1',
          problemId: 'problem-1',
          competitorAccountId: 'account-1',
          credentials: mockCredentials,
          problem: mockProblem,
        },
        {
          eventId: 'event-1',
          problemId: 'problem-2',
          competitorAccountId: 'account-1',
          credentials: mockCredentials,
          problem: mockProblem,
        },
      ];

      const jobIds = engine.enqueueBatch(requests);

      expect(jobIds).toHaveLength(2);
      expect(jobIds[0]).not.toBe(jobIds[1]);
    });
  });

  describe('getStats', () => {
    it('統計情報を取得できるべき', () => {
      engine.registerScoringFunction('local', new LocalScoringFunction());

      const stats = engine.getStats();

      expect(stats).toHaveProperty('queuedJobs');
      expect(stats).toHaveProperty('activeJobs');
      expect(stats).toHaveProperty('registeredProviders');
      expect(typeof stats.queuedJobs).toBe('number');
      expect(typeof stats.activeJobs).toBe('number');
      expect(Array.isArray(stats.registeredProviders)).toBe(true);
    });
  });
});

describe('LocalScoringFunction', () => {
  it('ローカル採点を実行できるべき', async () => {
    const scorer = new LocalScoringFunction();
    const result = await scorer.execute(mockProblem, mockCredentials, 'account-1');

    expect(result.totalScore).toBe(result.maxPossibleScore);
    expect(result.criteriaResults).toHaveLength(mockProblem.scoring.criteria.length);
    expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('すべての基準が passed=true であるべき', async () => {
    const scorer = new LocalScoringFunction();
    const result = await scorer.execute(mockProblem, mockCredentials, 'account-1');

    for (const criterion of result.criteriaResults) {
      expect(criterion.passed).toBe(true);
    }
  });

  it('type が local であるべき', () => {
    const scorer = new LocalScoringFunction();
    expect(scorer.type).toBe('local');
  });
});

describe('LambdaScoringFunction', () => {
  it('Lambda 採点関数を作成できるべき', () => {
    const scorer = new LambdaScoringFunction('arn:aws:lambda:us-east-1:123456789012:function:scoring');
    expect(scorer.type).toBe('lambda');
  });

  it('採点を実行できるべき（シミュレーション）', async () => {
    const scorer = new LambdaScoringFunction('arn:aws:lambda:us-east-1:123456789012:function:scoring');
    const result = await scorer.execute(mockProblem, mockCredentials, 'account-1');

    expect(result.totalScore).toBeGreaterThanOrEqual(0);
    expect(result.maxPossibleScore).toBe(100); // 50 + 30 + 20
    expect(result.criteriaResults).toHaveLength(3);
    expect(result.executionTimeMs).toBeGreaterThan(0);
  });
});

describe('ContainerScoringFunction', () => {
  it('コンテナ採点関数を作成できるべき', () => {
    const scorer = new ContainerScoringFunction('123456789012.dkr.ecr.us-east-1.amazonaws.com/scoring:latest');
    expect(scorer.type).toBe('container');
  });

  it('採点を実行できるべき（シミュレーション）', async () => {
    const scorer = new ContainerScoringFunction('123456789012.dkr.ecr.us-east-1.amazonaws.com/scoring:latest');
    const result = await scorer.execute(mockProblem, mockCredentials, 'account-1');

    expect(result.totalScore).toBeGreaterThanOrEqual(0);
    expect(result.maxPossibleScore).toBe(100);
    expect(result.criteriaResults).toHaveLength(3);
    expect(result.executionTimeMs).toBeGreaterThan(0);
  });
});

describe('ScoringEngine Advanced', () => {
  it('サブスクライバーにジョブ完了を通知すべき', async () => {
    const engine = new ScoringEngine({
      maxConcurrency: 1,
      retryAttempts: 0,
      retryDelayMs: 0,
      timeoutMs: 10000,
    });
    engine.registerScoringFunction('aws', new LocalScoringFunction());

    const subscriber = vi.fn();
    engine.subscribe(subscriber);

    engine.enqueue({
      eventId: 'event-1',
      problemId: 'problem-1',
      competitorAccountId: 'account-1',
      credentials: mockCredentials,
      problem: mockProblem,
    });

    // LocalScoringFunction は 500ms の遅延があるので待機
    await new Promise(resolve => setTimeout(resolve, 600));

    expect(subscriber).toHaveBeenCalled();
    const result = subscriber.mock.calls[0][0] as ScoringResult;
    expect(result.eventId).toBe('event-1');
    expect(result.problemId).toBe('problem-1');
    expect(result.competitorAccountId).toBe('account-1');
  });

  it('teamId が設定されている場合は結果に含まれるべき', async () => {
    const engine = new ScoringEngine({
      maxConcurrency: 1,
      retryAttempts: 0,
      retryDelayMs: 0,
      timeoutMs: 10000,
    });
    engine.registerScoringFunction('aws', new LocalScoringFunction());

    const subscriber = vi.fn();
    engine.subscribe(subscriber);

    engine.enqueue({
      eventId: 'event-1',
      problemId: 'problem-1',
      competitorAccountId: 'account-1',
      teamId: 'team-1',
      credentials: mockCredentials,
      problem: mockProblem,
    });

    await new Promise(resolve => setTimeout(resolve, 600));

    expect(subscriber).toHaveBeenCalled();
    const result = subscriber.mock.calls[0][0] as ScoringResult;
    expect(result.teamId).toBe('team-1');
  });

  it('プロバイダーが登録されていない場合はリトライ後に失敗すべき', async () => {
    const engine = new ScoringEngine({
      maxConcurrency: 1,
      retryAttempts: 1,
      retryDelayMs: 10,
      timeoutMs: 5000,
    });
    // プロバイダーを登録しない

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    engine.enqueue({
      eventId: 'event-1',
      problemId: 'problem-1',
      competitorAccountId: 'account-1',
      credentials: mockCredentials,
      problem: mockProblem,
    });

    // リトライを含めて待機（retryAttempts=1 なので2回の試行）
    await new Promise(resolve => setTimeout(resolve, 300));

    // エラーログを確認
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('failed permanently'),
      expect.stringContaining('No scoring function registered')
    );

    consoleSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('サブスクライバーがエラーを投げても他のサブスクライバーに通知すべき', async () => {
    const engine = new ScoringEngine({
      maxConcurrency: 1,
      retryAttempts: 0,
      retryDelayMs: 0,
      timeoutMs: 10000,
    });
    engine.registerScoringFunction('aws', new LocalScoringFunction());

    const errorSubscriber = vi.fn().mockImplementation(() => {
      throw new Error('Subscriber error');
    });
    const normalSubscriber = vi.fn();

    engine.subscribe(errorSubscriber);
    engine.subscribe(normalSubscriber);

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    engine.enqueue({
      eventId: 'event-1',
      problemId: 'problem-1',
      competitorAccountId: 'account-1',
      credentials: mockCredentials,
      problem: mockProblem,
    });

    await new Promise(resolve => setTimeout(resolve, 600));

    expect(errorSubscriber).toHaveBeenCalled();
    expect(normalSubscriber).toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[ScoringEngine] Subscriber error'),
      expect.any(Error)
    );

    consoleSpy.mockRestore();
  });

  it('サブスクライバーを解除した後は通知されないべき', async () => {
    const engine = new ScoringEngine({
      maxConcurrency: 1,
      retryAttempts: 0,
      retryDelayMs: 0,
      timeoutMs: 10000,
    });
    engine.registerScoringFunction('aws', new LocalScoringFunction());

    const subscriber = vi.fn();
    const unsubscribe = engine.subscribe(subscriber);

    // 解除
    unsubscribe();

    engine.enqueue({
      eventId: 'event-1',
      problemId: 'problem-1',
      competitorAccountId: 'account-1',
      credentials: mockCredentials,
      problem: mockProblem,
    });

    await new Promise(resolve => setTimeout(resolve, 600));

    expect(subscriber).not.toHaveBeenCalled();
  });

  it('maxPossibleScore が 0 の場合は percentage が 0 であるべき', async () => {
    const engine = new ScoringEngine({
      maxConcurrency: 1,
      retryAttempts: 0,
      retryDelayMs: 0,
      timeoutMs: 10000,
    });
    engine.registerScoringFunction('aws', new LocalScoringFunction());

    const subscriber = vi.fn();
    engine.subscribe(subscriber);

    const problemWithZeroScore: Problem = {
      ...mockProblem,
      scoring: {
        ...mockProblem.scoring,
        criteria: [{ name: 'Test', weight: 0, maxPoints: 0 }],
      },
    };

    engine.enqueue({
      eventId: 'event-1',
      problemId: 'problem-1',
      competitorAccountId: 'account-1',
      credentials: mockCredentials,
      problem: problemWithZeroScore,
    });

    await new Promise(resolve => setTimeout(resolve, 600));

    const result = subscriber.mock.calls[0][0] as ScoringResult;
    expect(result.percentage).toBe(0);
  });

  it('存在しないジョブ ID のステータスは undefined を返すべき', () => {
    const engine = new ScoringEngine();
    const status = engine.getJobStatus('non-existent-job-id');
    expect(status).toBeUndefined();
  });

  it('複数のジョブを並行処理すべき', async () => {
    const engine = new ScoringEngine({
      maxConcurrency: 3,
      retryAttempts: 0,
      retryDelayMs: 0,
      timeoutMs: 10000,
    });
    engine.registerScoringFunction('aws', new LocalScoringFunction());

    const subscriber = vi.fn();
    engine.subscribe(subscriber);

    // 5つのジョブをエンキュー
    for (let i = 0; i < 5; i++) {
      engine.enqueue({
        eventId: 'event-1',
        problemId: `problem-${i}`,
        competitorAccountId: 'account-1',
        credentials: mockCredentials,
        problem: mockProblem,
      });
    }

    // 全ジョブ完了を待機
    await new Promise(resolve => setTimeout(resolve, 2000));

    expect(subscriber).toHaveBeenCalledTimes(5);
  });
});
