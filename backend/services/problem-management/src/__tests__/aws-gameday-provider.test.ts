/**
 * AWS GameDay Provider Tests
 *
 * AWS GameDay 採点プロバイダーの単体テスト
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  AWSGameDayScoringProvider,
  createAWSGameDayScoringProvider,
} from '../scoring/providers/aws-gameday';
import type { Problem, CloudCredentials, ScoringCriterion } from '../types';

// テスト用のモックデータ
const createMockProblem = (criteria: ScoringCriterion[]): Problem => ({
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
    criteria,
    timeoutMinutes: 10,
  },
});

const mockCredentials: CloudCredentials = {
  provider: 'aws',
  accountId: '123456789012',
  region: 'ap-northeast-1',
};

describe('AWSGameDayScoringProvider', () => {
  let provider: AWSGameDayScoringProvider;

  beforeEach(() => {
    provider = new AWSGameDayScoringProvider();
  });

  describe('createAWSGameDayScoringProvider', () => {
    it('ファクトリ関数でプロバイダーを作成できるべき', () => {
      const provider = createAWSGameDayScoringProvider();
      expect(provider).toBeInstanceOf(AWSGameDayScoringProvider);
      expect(provider.type).toBe('aws-gameday');
    });
  });

  describe('execute', () => {
    it('EC2 インスタンス検証を実行できるべき', async () => {
      const problem = createMockProblem([
        {
          name: 'EC2インスタンス構築',
          weight: 1,
          maxPoints: 100,
          validationType: 'ec2-instance',
          validationConfig: {
            minCount: 1,
            state: 'running',
          },
        },
      ]);

      const result = await provider.execute(problem, mockCredentials, 'account-1');

      expect(result.criteriaResults).toHaveLength(1);
      expect(result.criteriaResults[0].name).toBe('EC2インスタンス構築');
      expect(result.criteriaResults[0].maxPoints).toBe(100);
      expect(result.totalScore).toBeGreaterThanOrEqual(0);
      expect(result.totalScore).toBeLessThanOrEqual(result.maxPossibleScore);
    });

    it('S3 バケット検証を実行できるべき', async () => {
      const problem = createMockProblem([
        {
          name: 'S3バケット設定',
          weight: 1,
          maxPoints: 100,
          validationType: 's3-bucket',
          validationConfig: {
            versioning: true,
            encryption: true,
          },
        },
      ]);

      const result = await provider.execute(problem, mockCredentials, 'account-1');

      expect(result.criteriaResults).toHaveLength(1);
      expect(result.criteriaResults[0].name).toBe('S3バケット設定');
    });

    it('Lambda 関数検証を実行できるべき', async () => {
      const problem = createMockProblem([
        {
          name: 'Lambda関数デプロイ',
          weight: 1,
          maxPoints: 100,
          validationType: 'lambda-function',
          validationConfig: {
            runtime: 'nodejs20.x',
          },
        },
      ]);

      const result = await provider.execute(problem, mockCredentials, 'account-1');

      expect(result.criteriaResults).toHaveLength(1);
      expect(result.criteriaResults[0].passed).toBe(true);
    });

    it('CloudFormation スタック検証を実行できるべき', async () => {
      const problem = createMockProblem([
        {
          name: 'CloudFormationスタック',
          weight: 1,
          maxPoints: 100,
          validationType: 'cloudformation-stack',
        },
      ]);

      const result = await provider.execute(problem, mockCredentials, 'account-1');

      expect(result.criteriaResults).toHaveLength(1);
      expect(result.criteriaResults[0].passed).toBe(true);
    });

    it('VPC 設定検証を実行できるべき', async () => {
      const problem = createMockProblem([
        {
          name: 'VPC構成',
          weight: 1,
          maxPoints: 100,
          validationType: 'vpc-config',
          validationConfig: {
            minSubnets: 2,
          },
        },
      ]);

      const result = await provider.execute(problem, mockCredentials, 'account-1');

      expect(result.criteriaResults).toHaveLength(1);
      expect(result.totalScore).toBeGreaterThan(0);
    });

    it('セキュリティグループ検証を実行できるべき', async () => {
      const problem = createMockProblem([
        {
          name: 'セキュリティグループ',
          weight: 1,
          maxPoints: 100,
          validationType: 'security-group',
          validationConfig: {
            prohibitedPorts: [22, 3389],
          },
        },
      ]);

      const result = await provider.execute(problem, mockCredentials, 'account-1');

      expect(result.criteriaResults).toHaveLength(1);
      expect(result.criteriaResults[0].name).toBe('セキュリティグループ');
    });

    it('IAM ポリシー検証を実行できるべき', async () => {
      const problem = createMockProblem([
        {
          name: 'IAMロール設定',
          weight: 1,
          maxPoints: 100,
          validationType: 'iam-policy',
        },
      ]);

      const result = await provider.execute(problem, mockCredentials, 'account-1');

      expect(result.criteriaResults).toHaveLength(1);
    });

    it('CloudWatch アラーム検証を実行できるべき', async () => {
      const problem = createMockProblem([
        {
          name: 'CloudWatchアラーム',
          weight: 1,
          maxPoints: 100,
          validationType: 'cloudwatch-alarm',
          validationConfig: {
            minAlarms: 1,
            metrics: ['CPUUtilization'],
          },
        },
      ]);

      const result = await provider.execute(problem, mockCredentials, 'account-1');

      expect(result.criteriaResults).toHaveLength(1);
    });

    it('API Gateway 検証を実行できるべき', async () => {
      const problem = createMockProblem([
        {
          name: 'APIGateway設定',
          weight: 1,
          maxPoints: 100,
          validationType: 'api-gateway',
        },
      ]);

      const result = await provider.execute(problem, mockCredentials, 'account-1');

      expect(result.criteriaResults).toHaveLength(1);
      expect(result.criteriaResults[0].passed).toBe(true);
    });

    it('複数の採点基準を一度に処理できるべき', async () => {
      const problem = createMockProblem([
        {
          name: 'EC2インスタンス',
          weight: 1,
          maxPoints: 30,
          validationType: 'ec2-instance',
        },
        {
          name: 'S3バケット',
          weight: 1,
          maxPoints: 30,
          validationType: 's3-bucket',
        },
        {
          name: 'Lambda関数',
          weight: 1,
          maxPoints: 40,
          validationType: 'lambda-function',
        },
      ]);

      const result = await provider.execute(problem, mockCredentials, 'account-1');

      expect(result.criteriaResults).toHaveLength(3);
      expect(result.maxPossibleScore).toBe(100);
      expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('汎用検証（未知のタイプ）を処理できるべき', async () => {
      const problem = createMockProblem([
        {
          name: 'カスタム検証',
          weight: 1,
          maxPoints: 100,
          validationType: 'unknown-type',
        },
      ]);

      const result = await provider.execute(problem, mockCredentials, 'account-1');

      expect(result.criteriaResults).toHaveLength(1);
      expect(result.criteriaResults[0].feedback).toContain('Unknown validation type');
    });
  });

  describe('検証タイプ推測', () => {
    it('名前から EC2 を推測できるべき', async () => {
      const problem = createMockProblem([
        {
          name: 'EC2インスタンスの起動',
          weight: 1,
          maxPoints: 100,
        },
      ]);

      const result = await provider.execute(problem, mockCredentials, 'account-1');
      // EC2 バリデーターが使用されることを確認（フィードバックに「インスタンス」が含まれる）
      expect(result.criteriaResults[0].feedback).toMatch(/インスタンス/);
    });

    it('説明から S3 を推測できるべき', async () => {
      const problem = createMockProblem([
        {
          name: 'ストレージ設定',
          weight: 1,
          maxPoints: 100,
          description: 'S3バケットを作成してください',
        },
      ]);

      const result = await provider.execute(problem, mockCredentials, 'account-1');
      expect(result.criteriaResults[0].feedback).toMatch(/バケット/);
    });
  });

  describe('registerValidator', () => {
    it('カスタム検証関数を登録できるべき', async () => {
      provider.registerValidator('custom-check', async (criterion) => ({
        passed: true,
        score: criterion.maxPoints,
        maxScore: criterion.maxPoints,
        feedback: 'カスタム検証成功',
      }));

      const problem = createMockProblem([
        {
          name: 'カスタムチェック',
          weight: 1,
          maxPoints: 100,
          validationType: 'custom-check',
        },
      ]);

      const result = await provider.execute(problem, mockCredentials, 'account-1');

      expect(result.criteriaResults[0].passed).toBe(true);
      expect(result.criteriaResults[0].feedback).toBe('カスタム検証成功');
      expect(result.totalScore).toBe(100);
    });

    it('検証関数がエラーをスローした場合はエラー結果を返すべき', async () => {
      provider.registerValidator('error-check', async () => {
        throw new Error('Validation failed');
      });

      const problem = createMockProblem([
        {
          name: 'エラーチェック',
          weight: 1,
          maxPoints: 100,
          validationType: 'error-check',
        },
      ]);

      const result = await provider.execute(problem, mockCredentials, 'account-1');

      expect(result.criteriaResults[0].passed).toBe(false);
      expect(result.criteriaResults[0].points).toBe(0);
      expect(result.criteriaResults[0].feedback).toContain('Validation error');
    });
  });

  describe('検証タイプ推測（追加）', () => {
    it('名前から Lambda を推測できるべき', async () => {
      const problem = createMockProblem([
        {
          name: 'Lambda 関数のデプロイ',
          weight: 1,
          maxPoints: 100,
        },
      ]);

      const result = await provider.execute(problem, mockCredentials, 'account-1');
      expect(result.criteriaResults[0].feedback).toMatch(/関数/);
    });

    it('名前から RDS を推測できるべき（rds-instance は未登録）', async () => {
      const problem = createMockProblem([
        {
          name: 'RDS データベースの起動',
          weight: 1,
          maxPoints: 100,
        },
      ]);

      const result = await provider.execute(problem, mockCredentials, 'account-1');
      // RDS は未登録なので Unknown validation type を返す
      expect(result.criteriaResults[0].feedback).toContain('Unknown validation type');
    });

    it('名前から VPC を推測できるべき', async () => {
      const problem = createMockProblem([
        {
          name: 'VPC ネットワーク構成',
          weight: 1,
          maxPoints: 100,
        },
      ]);

      const result = await provider.execute(problem, mockCredentials, 'account-1');
      expect(result.criteriaResults[0].feedback).toMatch(/VPC|サブネット/);
    });

    it('名前から IAM を推測できるべき', async () => {
      const problem = createMockProblem([
        {
          name: 'IAM ポリシーの設定',
          weight: 1,
          maxPoints: 100,
        },
      ]);

      const result = await provider.execute(problem, mockCredentials, 'account-1');
      expect(result.criteriaResults[0].feedback).toMatch(/IAM|権限/);
    });

    it('名前から CloudWatch を推測できるべき', async () => {
      const problem = createMockProblem([
        {
          name: 'CloudWatch モニタリング設定',
          weight: 1,
          maxPoints: 100,
        },
      ]);

      const result = await provider.execute(problem, mockCredentials, 'account-1');
      expect(result.criteriaResults[0].feedback).toMatch(/アラーム/);
    });

    it('名前からセキュリティグループを推測できるべき', async () => {
      const problem = createMockProblem([
        {
          name: 'セキュリティグループの設定',
          weight: 1,
          maxPoints: 100,
        },
      ]);

      const result = await provider.execute(problem, mockCredentials, 'account-1');
      expect(result.criteriaResults[0].feedback).toMatch(/セキュリティグループ/);
    });

    it('名前から API Gateway を推測できるべき', async () => {
      const problem = createMockProblem([
        {
          name: 'API Gateway の作成',
          weight: 1,
          maxPoints: 100,
        },
      ]);

      const result = await provider.execute(problem, mockCredentials, 'account-1');
      expect(result.criteriaResults[0].feedback).toMatch(/API Gateway/);
    });

    it('名前から CloudFormation を推測できるべき', async () => {
      const problem = createMockProblem([
        {
          name: 'CloudFormation スタックのデプロイ',
          weight: 1,
          maxPoints: 100,
        },
      ]);

      const result = await provider.execute(problem, mockCredentials, 'account-1');
      expect(result.criteriaResults[0].feedback).toMatch(/スタック/);
    });
  });

  describe('S3 バケット検証（詳細）', () => {
    it('バケット名が見つからない場合はエラーを返すべき', async () => {
      const problem = createMockProblem([
        {
          name: 'S3バケット',
          weight: 1,
          maxPoints: 100,
          validationType: 's3-bucket',
          validationConfig: {
            bucketName: 'non-existent-bucket-name',
          },
        },
      ]);

      const result = await provider.execute(problem, mockCredentials, 'account-1');
      expect(result.criteriaResults[0].passed).toBe(false);
      expect(result.criteriaResults[0].feedback).toContain('見つかりません');
    });

    it('バージョニングのみ設定の場合も検証できるべき', async () => {
      const problem = createMockProblem([
        {
          name: 'S3バケット',
          weight: 1,
          maxPoints: 100,
          validationType: 's3-bucket',
          validationConfig: {
            versioning: true,
          },
        },
      ]);

      const result = await provider.execute(problem, mockCredentials, 'account-1');
      expect(result.criteriaResults[0].feedback).toContain('バージョニング');
    });

    it('暗号化のみ設定の場合も検証できるべき', async () => {
      const problem = createMockProblem([
        {
          name: 'S3バケット',
          weight: 1,
          maxPoints: 100,
          validationType: 's3-bucket',
          validationConfig: {
            encryption: true,
          },
        },
      ]);

      const result = await provider.execute(problem, mockCredentials, 'account-1');
      expect(result.criteriaResults[0].feedback).toContain('暗号化');
    });
  });

  describe('Lambda 検証（詳細）', () => {
    it('関数名が見つからない場合はエラーを返すべき', async () => {
      const problem = createMockProblem([
        {
          name: 'Lambda関数',
          weight: 1,
          maxPoints: 100,
          validationType: 'lambda-function',
          validationConfig: {
            functionName: 'non-existent-function',
          },
        },
      ]);

      const result = await provider.execute(problem, mockCredentials, 'account-1');
      expect(result.criteriaResults[0].passed).toBe(false);
      expect(result.criteriaResults[0].feedback).toContain('見つかりません');
    });

    it('ランタイムが異なる場合は減点するべき', async () => {
      const problem = createMockProblem([
        {
          name: 'Lambda関数',
          weight: 1,
          maxPoints: 100,
          validationType: 'lambda-function',
          validationConfig: {
            runtime: 'python3.12',
          },
        },
      ]);

      const result = await provider.execute(problem, mockCredentials, 'account-1');
      // 関数は存在するがランタイムが異なる
      expect(result.criteriaResults[0].feedback).toContain('期待ランタイム');
    });
  });

  describe('API Gateway 検証（詳細）', () => {
    it('API名が見つからない場合はエラーを返すべき', async () => {
      const problem = createMockProblem([
        {
          name: 'APIGateway',
          weight: 1,
          maxPoints: 100,
          validationType: 'api-gateway',
          validationConfig: {
            apiName: 'non-existent-api',
          },
        },
      ]);

      const result = await provider.execute(problem, mockCredentials, 'account-1');
      expect(result.criteriaResults[0].passed).toBe(false);
      expect(result.criteriaResults[0].feedback).toContain('見つかりません');
    });
  });

  describe('CloudWatch アラーム検証（詳細）', () => {
    it('アラーム数が不足している場合は減点するべき', async () => {
      const problem = createMockProblem([
        {
          name: 'CloudWatch',
          weight: 1,
          maxPoints: 100,
          validationType: 'cloudwatch-alarm',
          validationConfig: {
            minAlarms: 10,
          },
        },
      ]);

      const result = await provider.execute(problem, mockCredentials, 'account-1');
      expect(result.criteriaResults[0].feedback).toContain('アラーム不足');
    });

    it('必要なメトリクスがない場合は減点するべき', async () => {
      const problem = createMockProblem([
        {
          name: 'CloudWatch',
          weight: 1,
          maxPoints: 100,
          validationType: 'cloudwatch-alarm',
          validationConfig: {
            minAlarms: 1,
            metrics: ['CPUUtilization', 'MemoryUtilization'],
          },
        },
      ]);

      const result = await provider.execute(problem, mockCredentials, 'account-1');
      expect(result.criteriaResults[0].feedback).toContain('未設定メトリクス');
    });
  });

  describe('IAM ポリシー検証（詳細）', () => {
    it('ロール名が見つからない場合はエラーを返すべき', async () => {
      const problem = createMockProblem([
        {
          name: 'IAM',
          weight: 1,
          maxPoints: 100,
          validationType: 'iam-policy',
          validationConfig: {
            roleName: 'non-existent-role',
          },
        },
      ]);

      const result = await provider.execute(problem, mockCredentials, 'account-1');
      expect(result.criteriaResults[0].passed).toBe(false);
      expect(result.criteriaResults[0].feedback).toContain('見つかりません');
    });
  });

  describe('EC2 検証（詳細）', () => {
    it('特定のインスタンスタイプが要求される場合の検証', async () => {
      const problem = createMockProblem([
        {
          name: 'EC2',
          weight: 1,
          maxPoints: 100,
          validationType: 'ec2-instance',
          validationConfig: {
            minCount: 1,
            state: 'running',
            instanceType: 't3.micro',
          },
        },
      ]);

      const result = await provider.execute(problem, mockCredentials, 'account-1');
      expect(result.criteriaResults[0].passed).toBe(true);
    });

    it('インスタンス数が不足している場合は部分点を返すべき', async () => {
      const problem = createMockProblem([
        {
          name: 'EC2',
          weight: 1,
          maxPoints: 100,
          validationType: 'ec2-instance',
          validationConfig: {
            minCount: 5,
            state: 'running',
          },
        },
      ]);

      const result = await provider.execute(problem, mockCredentials, 'account-1');
      expect(result.criteriaResults[0].passed).toBe(false);
      expect(result.criteriaResults[0].points).toBeLessThan(100);
      expect(result.criteriaResults[0].feedback).toContain('以上の');
    });
  });

  describe('generic 検証', () => {
    it('generic タイプは常に部分点を返すべき', async () => {
      const problem = createMockProblem([
        {
          name: 'カスタム検証',
          weight: 1,
          maxPoints: 100,
          validationType: 'generic',
        },
      ]);

      const result = await provider.execute(problem, mockCredentials, 'account-1');
      expect(result.criteriaResults[0].passed).toBe(true);
      expect(result.criteriaResults[0].points).toBe(50); // 50% の部分点
      expect(result.criteriaResults[0].feedback).toContain('自動検証未対応');
    });
  });
});
