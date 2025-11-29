/**
 * Scoring Engine Tests
 *
 * 採点エンジンの振る舞いテスト（BDD スタイル）
 *
 * このテストは採点エンジンの外部仕様を検証する。
 * - 参加者のインフラ構築結果を採点する
 * - 複数の採点基準に基づいてスコアを算出する
 * - 採点結果を購読者にリアルタイム通知する
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

// =============================================================================
// テストフィクスチャ
// =============================================================================

/**
 * 採点基準付きの問題を作成する
 */
const createProblemWithCriteria = (
  criteria: Array<{ name: string; weight: number; maxPoints: number }>
): Problem => ({
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
    criteria,
    timeoutMinutes: 10,
  },
});

const mockProblem = createProblemWithCriteria([
  { name: 'EC2構築', weight: 1, maxPoints: 50 },
  { name: 'S3設定', weight: 1, maxPoints: 30 },
  { name: 'セキュリティ', weight: 1, maxPoints: 20 },
]);

const mockCredentials: CloudCredentials = {
  provider: 'aws',
  accountId: '123456789012',
  region: 'ap-northeast-1',
};

// =============================================================================
// 採点エンジンの初期化に関するテスト
// =============================================================================

describe('採点エンジンを初期化する場合', () => {
  describe('デフォルト設定で初期化した場合', () => {
    it('ローカル採点プロバイダーが自動的に登録されるべき', () => {
      // Given: デフォルト設定
      // When: 採点エンジンを作成する
      const engine = createScoringEngine();

      // Then: ローカルプロバイダーが利用可能
      const stats = engine.getStats();
      expect(stats.registeredProviders).toContain('local');
    });
  });

  describe('カスタム設定で初期化した場合', () => {
    it('指定した同時実行数とリトライ回数で動作するべき', () => {
      // Given: カスタム設定（同時実行数10、リトライ5回）
      // When: 採点エンジンを作成する
      const engine = createScoringEngine({
        maxConcurrency: 10,
        retryAttempts: 5,
      });

      // Then: エンジンが正常に初期化される
      const stats = engine.getStats();
      expect(stats.registeredProviders).toContain('local');
    });
  });
});

// =============================================================================
// 採点プロバイダーの登録に関するテスト
// =============================================================================

describe('採点プロバイダーを登録する場合', () => {
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

  describe('単一のプロバイダーを登録した場合', () => {
    it('そのプロバイダーで採点を実行できるようになるべき', () => {
      // Given: ローカル採点関数
      const localScoring = new LocalScoringFunction();

      // When: プロバイダーを登録する
      engine.registerScoringFunction('local', localScoring);

      // Then: 登録済みプロバイダーに含まれる
      const stats = engine.getStats();
      expect(stats.registeredProviders).toContain('local');
    });
  });

  describe('複数のプロバイダーを登録した場合', () => {
    it('すべてのプロバイダーで採点を実行できるようになるべき', () => {
      // Given: 複数の採点関数
      const localScoring = new LocalScoringFunction();
      const lambdaScoring = new LambdaScoringFunction('arn:aws:lambda:test');

      // When: 両方のプロバイダーを登録する
      engine.registerScoringFunction('local', localScoring);
      engine.registerScoringFunction('aws', lambdaScoring);

      // Then: 両方が登録済みプロバイダーに含まれる
      const stats = engine.getStats();
      expect(stats.registeredProviders).toContain('local');
      expect(stats.registeredProviders).toContain('aws');
    });
  });
});

// =============================================================================
// 採点結果の購読に関するテスト
// =============================================================================

describe('採点結果の通知を購読する場合', () => {
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

  describe('購読を開始した場合', () => {
    it('購読解除用の関数が返されるべき', () => {
      // Given: 採点エンジン
      // When: 結果を購読する
      const subscriber = vi.fn();
      const unsubscribe = engine.subscribe(subscriber);

      // Then: 購読解除関数が返される
      expect(typeof unsubscribe).toBe('function');
    });
  });

  describe('購読を解除した場合', () => {
    it('以降の採点結果は通知されないべき', () => {
      // Given: 購読中の状態
      const subscriber = vi.fn();
      const unsubscribe = engine.subscribe(subscriber);

      // When: 購読を解除する
      unsubscribe();

      // Then: エラーなく実行される（内部状態の確認は困難）
    });
  });
});

// =============================================================================
// 採点ジョブの登録に関するテスト
// =============================================================================

describe('参加者の採点をリクエストする場合', () => {
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

  describe('単一の参加者を採点する場合', () => {
    it('一意のジョブ ID が発行されるべき', () => {
      // Given: 採点可能な状態
      engine.registerScoringFunction('aws', new LocalScoringFunction());

      // When: 採点をリクエストする
      const jobId = engine.enqueue({
        eventId: 'event-1',
        problemId: 'problem-1',
        competitorAccountId: 'account-1',
        credentials: mockCredentials,
        problem: mockProblem,
      });

      // Then: ジョブ ID が発行される
      expect(jobId).toMatch(/^score-\d+-\d+$/);
    });

    it('ジョブの進捗状況を確認できるべき', () => {
      // Given: 採点ジョブを登録済み
      engine.registerScoringFunction('aws', new LocalScoringFunction());
      const jobId = engine.enqueue({
        eventId: 'event-1',
        problemId: 'problem-1',
        competitorAccountId: 'account-1',
        credentials: mockCredentials,
        problem: mockProblem,
      });

      // When: ジョブステータスを確認する
      const status = engine.getJobStatus(jobId);

      // Then: ステータスが取得できる
      expect(status).toBeDefined();
      expect(['pending', 'running', 'completed', 'failed']).toContain(
        status?.status
      );
    });
  });

  describe('複数の参加者を一括で採点する場合', () => {
    it('参加者ごとに異なるジョブ ID が発行されるべき', () => {
      // Given: 採点可能な状態と複数の採点リクエスト
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

      // When: 一括で採点をリクエストする
      const jobIds = engine.enqueueBatch(requests);

      // Then: すべてのリクエストに一意のジョブ ID が発行される
      expect(jobIds).toHaveLength(2);
      expect(jobIds[0]).not.toBe(jobIds[1]);
    });
  });
});

// =============================================================================
// 採点エンジンの統計情報に関するテスト
// =============================================================================

describe('採点エンジンの稼働状況を確認する場合', () => {
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

  it('キュー待ち・実行中のジョブ数と登録済みプロバイダーが確認できるべき', () => {
    // Given: プロバイダーを登録した状態
    engine.registerScoringFunction('local', new LocalScoringFunction());

    // When: 統計情報を取得する
    const stats = engine.getStats();

    // Then: 必要な情報が含まれている
    expect(stats).toHaveProperty('queuedJobs');
    expect(stats).toHaveProperty('activeJobs');
    expect(stats).toHaveProperty('registeredProviders');
    expect(typeof stats.queuedJobs).toBe('number');
    expect(typeof stats.activeJobs).toBe('number');
    expect(Array.isArray(stats.registeredProviders)).toBe(true);
  });
});

// =============================================================================
// ローカル採点関数の振る舞いテスト
// =============================================================================

describe('ローカル環境で採点を実行する場合', () => {
  describe('すべての採点基準が定義されている場合', () => {
    it('基準ごとに採点結果が含まれるべき', async () => {
      // Given: 3つの採点基準を持つ問題
      const scorer = new LocalScoringFunction();

      // When: 採点を実行する
      const result = await scorer.execute(
        mockProblem,
        mockCredentials,
        'account-1'
      );

      // Then: すべての基準の採点結果が含まれる
      expect(result.criteriaResults).toHaveLength(
        mockProblem.scoring.criteria.length
      );
      expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('ローカル環境ではすべての基準が合格として扱われるべき', async () => {
      // Given: ローカル採点関数（開発・テスト用）
      const scorer = new LocalScoringFunction();

      // When: 採点を実行する
      const result = await scorer.execute(
        mockProblem,
        mockCredentials,
        'account-1'
      );

      // Then: すべての基準が合格
      for (const criterion of result.criteriaResults) {
        expect(criterion.passed).toBe(true);
      }
      expect(result.totalScore).toBe(result.maxPossibleScore);
    });
  });

  it('採点タイプはローカルであるべき', () => {
    // Given: ローカル採点関数
    const scorer = new LocalScoringFunction();

    // Then: タイプが local
    expect(scorer.type).toBe('local');
  });
});

// =============================================================================
// Lambda 採点関数の振る舞いテスト
// =============================================================================

describe('Lambda 関数で採点を実行する場合', () => {
  it('採点タイプは Lambda であるべき', () => {
    // Given: Lambda 採点関数
    const scorer = new LambdaScoringFunction(
      'arn:aws:lambda:us-east-1:123456789012:function:scoring'
    );

    // Then: タイプが lambda
    expect(scorer.type).toBe('lambda');
  });

  describe('採点を実行した場合', () => {
    it('すべての基準に対するスコアと実行時間が返されるべき', async () => {
      // Given: Lambda 採点関数
      const scorer = new LambdaScoringFunction(
        'arn:aws:lambda:us-east-1:123456789012:function:scoring'
      );

      // When: 採点を実行する
      const result = await scorer.execute(
        mockProblem,
        mockCredentials,
        'account-1'
      );

      // Then: 採点結果が返される
      expect(result.totalScore).toBeGreaterThanOrEqual(0);
      expect(result.maxPossibleScore).toBe(100); // 50 + 30 + 20
      expect(result.criteriaResults).toHaveLength(3);
      expect(result.executionTimeMs).toBeGreaterThan(0);
    });
  });
});

// =============================================================================
// コンテナ採点関数の振る舞いテスト
// =============================================================================

describe('コンテナで採点を実行する場合', () => {
  it('採点タイプはコンテナであるべき', () => {
    // Given: コンテナ採点関数
    const scorer = new ContainerScoringFunction(
      '123456789012.dkr.ecr.us-east-1.amazonaws.com/scoring:latest'
    );

    // Then: タイプが container
    expect(scorer.type).toBe('container');
  });

  describe('採点を実行した場合', () => {
    it('すべての基準に対するスコアと実行時間が返されるべき', async () => {
      // Given: コンテナ採点関数
      const scorer = new ContainerScoringFunction(
        '123456789012.dkr.ecr.us-east-1.amazonaws.com/scoring:latest'
      );

      // When: 採点を実行する
      const result = await scorer.execute(
        mockProblem,
        mockCredentials,
        'account-1'
      );

      // Then: 採点結果が返される
      expect(result.totalScore).toBeGreaterThanOrEqual(0);
      expect(result.maxPossibleScore).toBe(100);
      expect(result.criteriaResults).toHaveLength(3);
      expect(result.executionTimeMs).toBeGreaterThan(0);
    });
  });
});

// =============================================================================
// 採点結果の通知に関するテスト
// =============================================================================

describe('採点が完了した場合', () => {
  describe('購読者がいる場合', () => {
    it('採点結果が即座に通知されるべき', async () => {
      // Given: 購読者がいる状態
      const engine = new ScoringEngine({
        maxConcurrency: 1,
        retryAttempts: 0,
        retryDelayMs: 0,
        timeoutMs: 10000,
      });
      engine.registerScoringFunction('aws', new LocalScoringFunction());
      const subscriber = vi.fn();
      engine.subscribe(subscriber);

      // When: 採点を実行する
      engine.enqueue({
        eventId: 'event-1',
        problemId: 'problem-1',
        competitorAccountId: 'account-1',
        credentials: mockCredentials,
        problem: mockProblem,
      });

      // Then: 採点完了後に購読者に通知される
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(subscriber).toHaveBeenCalled();
      const result = subscriber.mock.calls[0][0] as ScoringResult;
      expect(result.eventId).toBe('event-1');
      expect(result.problemId).toBe('problem-1');
      expect(result.competitorAccountId).toBe('account-1');
    });
  });

  describe('チーム対戦モードの場合', () => {
    it('チーム ID が採点結果に含まれるべき', async () => {
      // Given: チーム ID を指定した採点リクエスト
      const engine = new ScoringEngine({
        maxConcurrency: 1,
        retryAttempts: 0,
        retryDelayMs: 0,
        timeoutMs: 10000,
      });
      engine.registerScoringFunction('aws', new LocalScoringFunction());
      const subscriber = vi.fn();
      engine.subscribe(subscriber);

      // When: チーム ID 付きで採点する
      engine.enqueue({
        eventId: 'event-1',
        problemId: 'problem-1',
        competitorAccountId: 'account-1',
        teamId: 'team-1',
        credentials: mockCredentials,
        problem: mockProblem,
      });

      // Then: 結果にチーム ID が含まれる
      await new Promise((resolve) => setTimeout(resolve, 600));
      const result = subscriber.mock.calls[0][0] as ScoringResult;
      expect(result.teamId).toBe('team-1');
    });
  });

  describe('購読を解除した後の場合', () => {
    it('解除済みの購読者には通知されないべき', async () => {
      // Given: 購読を解除した状態
      const engine = new ScoringEngine({
        maxConcurrency: 1,
        retryAttempts: 0,
        retryDelayMs: 0,
        timeoutMs: 10000,
      });
      engine.registerScoringFunction('aws', new LocalScoringFunction());
      const subscriber = vi.fn();
      const unsubscribe = engine.subscribe(subscriber);
      unsubscribe();

      // When: 採点を実行する
      engine.enqueue({
        eventId: 'event-1',
        problemId: 'problem-1',
        competitorAccountId: 'account-1',
        credentials: mockCredentials,
        problem: mockProblem,
      });

      // Then: 通知されない
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(subscriber).not.toHaveBeenCalled();
    });
  });
});

// =============================================================================
// エラーハンドリングに関するテスト
// =============================================================================

describe('採点でエラーが発生した場合', () => {
  describe('採点プロバイダーが未登録の場合', () => {
    it('リトライ後に失敗としてログに記録されるべき', async () => {
      // Given: プロバイダー未登録の状態
      const engine = new ScoringEngine({
        maxConcurrency: 1,
        retryAttempts: 1,
        retryDelayMs: 10,
        timeoutMs: 5000,
      });
      const consoleSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      // When: 採点をリクエストする
      engine.enqueue({
        eventId: 'event-1',
        problemId: 'problem-1',
        competitorAccountId: 'account-1',
        credentials: mockCredentials,
        problem: mockProblem,
      });

      // Then: リトライ後に失敗ログが記録される
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('failed permanently'),
        expect.stringContaining('No scoring function registered')
      );

      consoleSpy.mockRestore();
      logSpy.mockRestore();
    });
  });

  describe('購読者がエラーを投げた場合', () => {
    it('他の購読者への通知は継続されるべき', async () => {
      // Given: エラーを投げる購読者と正常な購読者
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
      const consoleSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});

      // When: 採点を実行する
      engine.enqueue({
        eventId: 'event-1',
        problemId: 'problem-1',
        competitorAccountId: 'account-1',
        credentials: mockCredentials,
        problem: mockProblem,
      });

      // Then: 両方の購読者に通知される（エラーは記録されるが中断しない）
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(errorSubscriber).toHaveBeenCalled();
      expect(normalSubscriber).toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[ScoringEngine] Subscriber error'),
        expect.any(Error)
      );

      consoleSpy.mockRestore();
    });
  });
});

// =============================================================================
// 特殊なケースのテスト
// =============================================================================

describe('特殊な採点条件の場合', () => {
  describe('最大スコアが 0 点の問題の場合', () => {
    it('達成率は 0％ として計算されるべき', async () => {
      // Given: 最大スコアが 0 の問題
      const engine = new ScoringEngine({
        maxConcurrency: 1,
        retryAttempts: 0,
        retryDelayMs: 0,
        timeoutMs: 10000,
      });
      engine.registerScoringFunction('aws', new LocalScoringFunction());
      const subscriber = vi.fn();
      engine.subscribe(subscriber);
      const problemWithZeroScore = createProblemWithCriteria([
        { name: 'Test', weight: 0, maxPoints: 0 },
      ]);

      // When: 採点を実行する
      engine.enqueue({
        eventId: 'event-1',
        problemId: 'problem-1',
        competitorAccountId: 'account-1',
        credentials: mockCredentials,
        problem: problemWithZeroScore,
      });

      // Then: 達成率が 0％
      await new Promise((resolve) => setTimeout(resolve, 600));
      const result = subscriber.mock.calls[0][0] as ScoringResult;
      expect(result.percentage).toBe(0);
    });
  });

  describe('存在しないジョブ ID を問い合わせた場合', () => {
    it('undefined が返されるべき', () => {
      // Given: 採点エンジン
      const engine = new ScoringEngine();

      // When: 存在しないジョブ ID のステータスを確認する
      const status = engine.getJobStatus('non-existent-job-id');

      // Then: undefined が返される
      expect(status).toBeUndefined();
    });
  });
});

// =============================================================================
// 並行処理に関するテスト
// =============================================================================

describe('複数の採点を並行処理する場合', () => {
  it('設定された同時実行数に従って処理されるべき', async () => {
    // Given: 同時実行数 3 の採点エンジン
    const engine = new ScoringEngine({
      maxConcurrency: 3,
      retryAttempts: 0,
      retryDelayMs: 0,
      timeoutMs: 10000,
    });
    engine.registerScoringFunction('aws', new LocalScoringFunction());
    const subscriber = vi.fn();
    engine.subscribe(subscriber);

    // When: 5つの採点をリクエストする
    for (let i = 0; i < 5; i++) {
      engine.enqueue({
        eventId: 'event-1',
        problemId: `problem-${i}`,
        competitorAccountId: 'account-1',
        credentials: mockCredentials,
        problem: mockProblem,
      });
    }

    // Then: すべての採点が完了する
    await new Promise((resolve) => setTimeout(resolve, 2000));
    expect(subscriber).toHaveBeenCalledTimes(5);
  });
});
