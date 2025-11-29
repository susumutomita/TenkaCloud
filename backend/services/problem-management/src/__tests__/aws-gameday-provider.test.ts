/**
 * AWS GameDay 採点プロバイダー
 *
 * GameDay 形式の問題における参加者のインフラ構築結果を評価する
 * 採点プロバイダーの振る舞いをテストする
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

describe('AWS GameDay 採点プロバイダー', () => {
  let provider: AWSGameDayScoringProvider;

  beforeEach(() => {
    provider = new AWSGameDayScoringProvider();
  });

  describe('プロバイダーを初期化する場合', () => {
    it('ファクトリ関数で作成するとaws-gamedayタイプのプロバイダーが返されるべき', () => {
      // Given: ファクトリ関数を使用する
      // When: プロバイダーを作成する
      const provider = createAWSGameDayScoringProvider();

      // Then: 正しい型のプロバイダーが返される
      expect(provider).toBeInstanceOf(AWSGameDayScoringProvider);
      expect(provider.type).toBe('aws-gameday');
    });
  });

  describe('参加者のインフラ構築を採点する場合', () => {
    describe('EC2 インスタンスの採点基準がある場合', () => {
      it('要件を満たす EC2 インスタンスが存在すれば採点結果にスコアが含まれるべき', async () => {
        // Given: EC2 インスタンス構築を要求する問題
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

        // When: 参加者のアカウントを採点する
        const result = await provider.execute(
          problem,
          mockCredentials,
          'account-1'
        );

        // Then: 採点結果が返される
        expect(result.criteriaResults).toHaveLength(1);
        expect(result.criteriaResults[0].name).toBe('EC2インスタンス構築');
        expect(result.criteriaResults[0].maxPoints).toBe(100);
        expect(result.totalScore).toBeGreaterThanOrEqual(0);
        expect(result.totalScore).toBeLessThanOrEqual(result.maxPossibleScore);
      });
    });

    describe('S3 バケットの採点基準がある場合', () => {
      it('バージョニングと暗号化が要求される問題で採点結果が返されるべき', async () => {
        // Given: S3 バケット設定を要求する問題
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

        // When: 参加者のアカウントを採点する
        const result = await provider.execute(
          problem,
          mockCredentials,
          'account-1'
        );

        // Then: S3バケット設定の採点結果が返される
        expect(result.criteriaResults).toHaveLength(1);
        expect(result.criteriaResults[0].name).toBe('S3バケット設定');
      });
    });

    describe('Lambda 関数の採点基準がある場合', () => {
      it('指定されたランタイムの Lambda 関数がデプロイされていれば合格となるべき', async () => {
        // Given: Lambda 関数デプロイを要求する問題
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

        // When: 参加者のアカウントを採点する
        const result = await provider.execute(
          problem,
          mockCredentials,
          'account-1'
        );

        // Then: 採点に合格する
        expect(result.criteriaResults).toHaveLength(1);
        expect(result.criteriaResults[0].passed).toBe(true);
      });
    });

    describe('CloudFormation スタックの採点基準がある場合', () => {
      it('スタックが正常にデプロイされていれば合格となるべき', async () => {
        // Given: CloudFormation スタックを要求する問題
        const problem = createMockProblem([
          {
            name: 'CloudFormationスタック',
            weight: 1,
            maxPoints: 100,
            validationType: 'cloudformation-stack',
          },
        ]);

        // When: 参加者のアカウントを採点する
        const result = await provider.execute(
          problem,
          mockCredentials,
          'account-1'
        );

        // Then: 採点に合格する
        expect(result.criteriaResults).toHaveLength(1);
        expect(result.criteriaResults[0].passed).toBe(true);
      });
    });

    describe('VPC 構成の採点基準がある場合', () => {
      it('要求されたサブネット数を満たしていればスコアが得られるべき', async () => {
        // Given: VPC 構成を要求する問題
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

        // When: 参加者のアカウントを採点する
        const result = await provider.execute(
          problem,
          mockCredentials,
          'account-1'
        );

        // Then: スコアが得られる
        expect(result.criteriaResults).toHaveLength(1);
        expect(result.totalScore).toBeGreaterThan(0);
      });
    });

    describe('セキュリティグループの採点基準がある場合', () => {
      it('禁止ポートが閉じられていれば採点結果が返されるべき', async () => {
        // Given: セキュリティグループ設定を要求する問題
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

        // When: 参加者のアカウントを採点する
        const result = await provider.execute(
          problem,
          mockCredentials,
          'account-1'
        );

        // Then: セキュリティグループの採点結果が返される
        expect(result.criteriaResults).toHaveLength(1);
        expect(result.criteriaResults[0].name).toBe('セキュリティグループ');
      });
    });

    describe('IAM ポリシーの採点基準がある場合', () => {
      it('適切な権限設定がされていれば採点結果が返されるべき', async () => {
        // Given: IAM ロール設定を要求する問題
        const problem = createMockProblem([
          {
            name: 'IAMロール設定',
            weight: 1,
            maxPoints: 100,
            validationType: 'iam-policy',
          },
        ]);

        // When: 参加者のアカウントを採点する
        const result = await provider.execute(
          problem,
          mockCredentials,
          'account-1'
        );

        // Then: 採点結果が返される
        expect(result.criteriaResults).toHaveLength(1);
      });
    });

    describe('CloudWatch アラームの採点基準がある場合', () => {
      it('要求されたメトリクスのアラームが設定されていれば採点結果が返されるべき', async () => {
        // Given: CloudWatch アラーム設定を要求する問題
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

        // When: 参加者のアカウントを採点する
        const result = await provider.execute(
          problem,
          mockCredentials,
          'account-1'
        );

        // Then: 採点結果が返される
        expect(result.criteriaResults).toHaveLength(1);
      });
    });

    describe('API Gateway の採点基準がある場合', () => {
      it('API Gateway が正しく設定されていれば合格となるべき', async () => {
        // Given: API Gateway 設定を要求する問題
        const problem = createMockProblem([
          {
            name: 'APIGateway設定',
            weight: 1,
            maxPoints: 100,
            validationType: 'api-gateway',
          },
        ]);

        // When: 参加者のアカウントを採点する
        const result = await provider.execute(
          problem,
          mockCredentials,
          'account-1'
        );

        // Then: 採点に合格する
        expect(result.criteriaResults).toHaveLength(1);
        expect(result.criteriaResults[0].passed).toBe(true);
      });
    });

    describe('複数の採点基準がある場合', () => {
      it('すべての基準が個別に採点され、合計スコアが計算されるべき', async () => {
        // Given: 複数のリソースを要求する問題
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

        // When: 参加者のアカウントを採点する
        const result = await provider.execute(
          problem,
          mockCredentials,
          'account-1'
        );

        // Then: すべての基準が採点され、合計が100点になる
        expect(result.criteriaResults).toHaveLength(3);
        expect(result.maxPossibleScore).toBe(100);
        expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
      });
    });

    describe('未知の採点基準タイプがある場合', () => {
      it('フィードバックにタイプが不明であることが示されるべき', async () => {
        // Given: 未知の検証タイプを持つ問題
        const problem = createMockProblem([
          {
            name: 'カスタム検証',
            weight: 1,
            maxPoints: 100,
            validationType: 'unknown-type',
          },
        ]);

        // When: 参加者のアカウントを採点する
        const result = await provider.execute(
          problem,
          mockCredentials,
          'account-1'
        );

        // Then: 不明なタイプであることがフィードバックに含まれる
        expect(result.criteriaResults).toHaveLength(1);
        expect(result.criteriaResults[0].feedback).toContain(
          'Unknown validation type'
        );
      });
    });
  });

  describe('採点基準名から検証タイプを推測する場合', () => {
    it('名前に EC2 が含まれていれば EC2 インスタンス検証が適用されるべき', async () => {
      // Given: 検証タイプ未指定だが名前に EC2 を含む基準
      const problem = createMockProblem([
        {
          name: 'EC2インスタンスの起動',
          weight: 1,
          maxPoints: 100,
        },
      ]);

      // When: 採点する
      const result = await provider.execute(
        problem,
        mockCredentials,
        'account-1'
      );

      // Then: EC2 に関連するフィードバックが返される
      expect(result.criteriaResults[0].feedback).toMatch(/インスタンス/);
    });

    it('説明に S3 が含まれていれば S3 バケット検証が適用されるべき', async () => {
      // Given: 説明に S3 を含む基準
      const problem = createMockProblem([
        {
          name: 'ストレージ設定',
          weight: 1,
          maxPoints: 100,
          description: 'S3バケットを作成してください',
        },
      ]);

      // When: 採点する
      const result = await provider.execute(
        problem,
        mockCredentials,
        'account-1'
      );

      // Then: S3 に関連するフィードバックが返される
      expect(result.criteriaResults[0].feedback).toMatch(/バケット/);
    });
  });

  describe('カスタム検証関数を登録する場合', () => {
    it('登録した検証関数が採点時に使用されるべき', async () => {
      // Given: カスタム検証関数を登録
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

      // When: 採点する
      const result = await provider.execute(
        problem,
        mockCredentials,
        'account-1'
      );

      // Then: カスタム検証関数の結果が返される
      expect(result.criteriaResults[0].passed).toBe(true);
      expect(result.criteriaResults[0].feedback).toBe('カスタム検証成功');
      expect(result.totalScore).toBe(100);
    });

    it('検証関数がエラーをスローした場合は0点とエラーメッセージが返されるべき', async () => {
      // Given: エラーをスローする検証関数を登録
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

      // When: 採点する
      const result = await provider.execute(
        problem,
        mockCredentials,
        'account-1'
      );

      // Then: 不合格となり0点が返される
      expect(result.criteriaResults[0].passed).toBe(false);
      expect(result.criteriaResults[0].points).toBe(0);
      expect(result.criteriaResults[0].feedback).toContain('Validation error');
    });
  });

  describe('さまざまな AWS サービス名から検証タイプを推測する場合', () => {
    it('名前に Lambda が含まれていれば Lambda 関数検証が適用されるべき', async () => {
      // Given: 名前に Lambda を含む基準
      const problem = createMockProblem([
        {
          name: 'Lambda 関数のデプロイ',
          weight: 1,
          maxPoints: 100,
        },
      ]);

      // When: 採点する
      const result = await provider.execute(
        problem,
        mockCredentials,
        'account-1'
      );

      // Then: Lambda に関連するフィードバックが返される
      expect(result.criteriaResults[0].feedback).toMatch(/関数/);
    });

    it('名前に RDS が含まれていても未対応サービスの場合は不明タイプとなるべき', async () => {
      // Given: 名前に RDS を含む基準（未対応サービス）
      const problem = createMockProblem([
        {
          name: 'RDS データベースの起動',
          weight: 1,
          maxPoints: 100,
        },
      ]);

      // When: 採点する
      const result = await provider.execute(
        problem,
        mockCredentials,
        'account-1'
      );

      // Then: 未対応のため Unknown validation type が返される
      expect(result.criteriaResults[0].feedback).toContain(
        'Unknown validation type'
      );
    });

    it('名前に VPC が含まれていれば VPC 構成検証が適用されるべき', async () => {
      // Given: 名前に VPC を含む基準
      const problem = createMockProblem([
        {
          name: 'VPC ネットワーク構成',
          weight: 1,
          maxPoints: 100,
        },
      ]);

      // When: 採点する
      const result = await provider.execute(
        problem,
        mockCredentials,
        'account-1'
      );

      // Then: VPC に関連するフィードバックが返される
      expect(result.criteriaResults[0].feedback).toMatch(/VPC|サブネット/);
    });

    it('名前に IAM が含まれていれば IAM ポリシー検証が適用されるべき', async () => {
      // Given: 名前に IAM を含む基準
      const problem = createMockProblem([
        {
          name: 'IAM ポリシーの設定',
          weight: 1,
          maxPoints: 100,
        },
      ]);

      // When: 採点する
      const result = await provider.execute(
        problem,
        mockCredentials,
        'account-1'
      );

      // Then: IAM に関連するフィードバックが返される
      expect(result.criteriaResults[0].feedback).toMatch(/IAM|権限/);
    });

    it('名前に CloudWatch が含まれていれば CloudWatch アラーム検証が適用されるべき', async () => {
      // Given: 名前に CloudWatch を含む基準
      const problem = createMockProblem([
        {
          name: 'CloudWatch モニタリング設定',
          weight: 1,
          maxPoints: 100,
        },
      ]);

      // When: 採点する
      const result = await provider.execute(
        problem,
        mockCredentials,
        'account-1'
      );

      // Then: CloudWatch に関連するフィードバックが返される
      expect(result.criteriaResults[0].feedback).toMatch(/アラーム/);
    });

    it('名前にセキュリティグループが含まれていればセキュリティグループ検証が適用されるべき', async () => {
      // Given: 名前にセキュリティグループを含む基準
      const problem = createMockProblem([
        {
          name: 'セキュリティグループの設定',
          weight: 1,
          maxPoints: 100,
        },
      ]);

      // When: 採点する
      const result = await provider.execute(
        problem,
        mockCredentials,
        'account-1'
      );

      // Then: セキュリティグループに関連するフィードバックが返される
      expect(result.criteriaResults[0].feedback).toMatch(
        /セキュリティグループ/
      );
    });

    it('名前に API Gateway が含まれていれば API Gateway 検証が適用されるべき', async () => {
      // Given: 名前に API Gateway を含む基準
      const problem = createMockProblem([
        {
          name: 'API Gateway の作成',
          weight: 1,
          maxPoints: 100,
        },
      ]);

      // When: 採点する
      const result = await provider.execute(
        problem,
        mockCredentials,
        'account-1'
      );

      // Then: API Gateway に関連するフィードバックが返される
      expect(result.criteriaResults[0].feedback).toMatch(/API Gateway/);
    });

    it('名前に CloudFormation が含まれていれば CloudFormation 検証が適用されるべき', async () => {
      // Given: 名前に CloudFormation を含む基準
      const problem = createMockProblem([
        {
          name: 'CloudFormation スタックのデプロイ',
          weight: 1,
          maxPoints: 100,
        },
      ]);

      // When: 採点する
      const result = await provider.execute(
        problem,
        mockCredentials,
        'account-1'
      );

      // Then: CloudFormation に関連するフィードバックが返される
      expect(result.criteriaResults[0].feedback).toMatch(/スタック/);
    });
  });

  describe('S3 バケットの詳細な採点ケース', () => {
    it('指定されたバケットが存在しない場合は不合格となりエラーメッセージが返されるべき', async () => {
      // Given: 存在しないバケット名を指定した問題
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

      // When: 採点する
      const result = await provider.execute(
        problem,
        mockCredentials,
        'account-1'
      );

      // Then: 不合格となりバケットが見つからないことが通知される
      expect(result.criteriaResults[0].passed).toBe(false);
      expect(result.criteriaResults[0].feedback).toContain('見つかりません');
    });

    it('バージョニングのみが要件の場合はバージョニング設定が評価されるべき', async () => {
      // Given: バージョニングのみを要求する問題
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

      // When: 採点する
      const result = await provider.execute(
        problem,
        mockCredentials,
        'account-1'
      );

      // Then: バージョニングに関するフィードバックが返される
      expect(result.criteriaResults[0].feedback).toContain('バージョニング');
    });

    it('暗号化のみが要件の場合は暗号化設定が評価されるべき', async () => {
      // Given: 暗号化のみを要求する問題
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

      // When: 採点する
      const result = await provider.execute(
        problem,
        mockCredentials,
        'account-1'
      );

      // Then: 暗号化に関するフィードバックが返される
      expect(result.criteriaResults[0].feedback).toContain('暗号化');
    });
  });

  describe('Lambda 関数の詳細な採点ケース', () => {
    it('指定された関数が存在しない場合は不合格となりエラーメッセージが返されるべき', async () => {
      // Given: 存在しない関数名を指定した問題
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

      // When: 採点する
      const result = await provider.execute(
        problem,
        mockCredentials,
        'account-1'
      );

      // Then: 不合格となり関数が見つからないことが通知される
      expect(result.criteriaResults[0].passed).toBe(false);
      expect(result.criteriaResults[0].feedback).toContain('見つかりません');
    });

    it('ランタイムが期待と異なる場合は減点されフィードバックが返されるべき', async () => {
      // Given: 特定のランタイムを要求する問題
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

      // When: 採点する
      const result = await provider.execute(
        problem,
        mockCredentials,
        'account-1'
      );

      // Then: 期待ランタイムに関するフィードバックが返される
      expect(result.criteriaResults[0].feedback).toContain('期待ランタイム');
    });
  });

  describe('API Gateway の詳細な採点ケース', () => {
    it('指定された API が存在しない場合は不合格となりエラーメッセージが返されるべき', async () => {
      // Given: 存在しない API 名を指定した問題
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

      // When: 採点する
      const result = await provider.execute(
        problem,
        mockCredentials,
        'account-1'
      );

      // Then: 不合格となり API が見つからないことが通知される
      expect(result.criteriaResults[0].passed).toBe(false);
      expect(result.criteriaResults[0].feedback).toContain('見つかりません');
    });
  });

  describe('CloudWatch アラームの詳細な採点ケース', () => {
    it('アラーム数が要件を満たさない場合は減点されフィードバックが返されるべき', async () => {
      // Given: 最低10個のアラームを要求する問題
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

      // When: 採点する
      const result = await provider.execute(
        problem,
        mockCredentials,
        'account-1'
      );

      // Then: アラーム不足のフィードバックが返される
      expect(result.criteriaResults[0].feedback).toContain('アラーム不足');
    });

    it('必要なメトリクスのアラームが設定されていない場合は減点されるべき', async () => {
      // Given: 複数のメトリクスを要求する問題
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

      // When: 採点する
      const result = await provider.execute(
        problem,
        mockCredentials,
        'account-1'
      );

      // Then: 未設定メトリクスのフィードバックが返される
      expect(result.criteriaResults[0].feedback).toContain('未設定メトリクス');
    });
  });

  describe('IAM ポリシーの詳細な採点ケース', () => {
    it('指定されたロールが存在しない場合は不合格となりエラーメッセージが返されるべき', async () => {
      // Given: 存在しないロール名を指定した問題
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

      // When: 採点する
      const result = await provider.execute(
        problem,
        mockCredentials,
        'account-1'
      );

      // Then: 不合格となりロールが見つからないことが通知される
      expect(result.criteriaResults[0].passed).toBe(false);
      expect(result.criteriaResults[0].feedback).toContain('見つかりません');
    });
  });

  describe('EC2 インスタンスの詳細な採点ケース', () => {
    it('インスタンスタイプと状態の要件を満たしていれば合格となるべき', async () => {
      // Given: 特定のインスタンスタイプと状態を要求する問題
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

      // When: 採点する
      const result = await provider.execute(
        problem,
        mockCredentials,
        'account-1'
      );

      // Then: 合格となる
      expect(result.criteriaResults[0].passed).toBe(true);
    });

    it('インスタンス数が要件を満たさない場合は部分点が与えられるべき', async () => {
      // Given: 5台以上のインスタンスを要求する問題
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

      // When: 採点する
      const result = await provider.execute(
        problem,
        mockCredentials,
        'account-1'
      );

      // Then: 不合格となり満点未満のスコアが与えられる
      expect(result.criteriaResults[0].passed).toBe(false);
      expect(result.criteriaResults[0].points).toBeLessThan(100);
      expect(result.criteriaResults[0].feedback).toContain('以上の');
    });
  });

  describe('汎用検証タイプの採点ケース', () => {
    it('自動検証が未対応の場合は50%の部分点と説明が返されるべき', async () => {
      // Given: generic タイプの問題
      const problem = createMockProblem([
        {
          name: 'カスタム検証',
          weight: 1,
          maxPoints: 100,
          validationType: 'generic',
        },
      ]);

      // When: 採点する
      const result = await provider.execute(
        problem,
        mockCredentials,
        'account-1'
      );

      // Then: 50%の部分点と自動検証未対応の説明が返される
      expect(result.criteriaResults[0].passed).toBe(true);
      expect(result.criteriaResults[0].points).toBe(50);
      expect(result.criteriaResults[0].feedback).toContain('自動検証未対応');
    });
  });
});
