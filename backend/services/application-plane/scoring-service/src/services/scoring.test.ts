import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createEvaluationCriteria,
  getEvaluationCriteria,
  listEvaluationCriteria,
  updateEvaluationCriteria,
  deleteEvaluationCriteria,
  createScoringSession,
  getScoringSession,
  listScoringSessions,
  submitForEvaluation,
  evaluateSubmission,
  getSessionFeedback,
  checkRule,
  checkResourceExists,
  checkResourceAttribute,
  checkS3Encryption,
  checkSecurityGroupSSH,
  generateSuggestion,
  evaluateTerraformState,
  evaluateCriterion,
} from './scoring';
import { prisma } from '../lib/prisma';
import { EvaluationCategory, EvaluationStatus, Severity } from '@prisma/client';

vi.mock('../lib/prisma', () => ({
  prisma: {
    evaluationCriteria: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      count: vi.fn(),
    },
    criteriaDetail: {
      createMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    scoringSession: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
    },
    evaluationItem: {
      createMany: vi.fn(),
      findMany: vi.fn(),
    },
    feedback: {
      createMany: vi.fn(),
      findMany: vi.fn(),
    },
    terraformSnapshot: {
      create: vi.fn(),
    },
    $transaction: vi.fn((callback) => callback(prisma)),
  },
}));

describe('評価基準管理', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createEvaluationCriteria', () => {
    it('評価基準を作成できるべき', async () => {
      const input = {
        tenantId: 'tenant-123',
        name: 'VPC構成チェック',
        description: 'VPCが正しく構成されているか確認',
        category: EvaluationCategory.INFRASTRUCTURE,
        weight: 5,
        maxScore: 100,
      };

      const mockCriteria = {
        id: 'criteria-1',
        ...input,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      vi.mocked(prisma.evaluationCriteria.create).mockResolvedValue(
        mockCriteria as never
      );

      const result = await createEvaluationCriteria(input);

      expect(result).toEqual(mockCriteria);
      expect(prisma.evaluationCriteria.create).toHaveBeenCalledWith({
        data: input,
      });
    });
  });

  describe('getEvaluationCriteria', () => {
    it('評価基準を取得できるべき', async () => {
      const mockCriteria = {
        id: 'criteria-1',
        tenantId: 'tenant-123',
        name: 'VPC構成チェック',
        category: EvaluationCategory.INFRASTRUCTURE,
        criteriaDetails: [],
      };

      vi.mocked(prisma.evaluationCriteria.findUnique).mockResolvedValue(
        mockCriteria as never
      );

      const result = await getEvaluationCriteria('criteria-1', 'tenant-123');

      expect(result).toEqual(mockCriteria);
    });

    it('異なるテナントの評価基準はnullを返すべき', async () => {
      const mockCriteria = {
        id: 'criteria-1',
        tenantId: 'tenant-other',
        name: 'VPC構成チェック',
      };

      vi.mocked(prisma.evaluationCriteria.findUnique).mockResolvedValue(
        mockCriteria as never
      );

      const result = await getEvaluationCriteria('criteria-1', 'tenant-123');

      expect(result).toBeNull();
    });
  });

  describe('listEvaluationCriteria', () => {
    it('評価基準一覧を取得できるべき', async () => {
      const mockCriteria = [
        { id: 'criteria-1', name: 'VPC構成' },
        { id: 'criteria-2', name: 'セキュリティ' },
      ];

      vi.mocked(prisma.evaluationCriteria.findMany).mockResolvedValue(
        mockCriteria as never
      );
      vi.mocked(prisma.evaluationCriteria.count).mockResolvedValue(2);

      const result = await listEvaluationCriteria('tenant-123', {
        page: 1,
        limit: 10,
      });

      expect(result.data).toEqual(mockCriteria);
      expect(result.total).toBe(2);
    });

    it('カテゴリでフィルタリングできるべき', async () => {
      vi.mocked(prisma.evaluationCriteria.findMany).mockResolvedValue([]);
      vi.mocked(prisma.evaluationCriteria.count).mockResolvedValue(0);

      await listEvaluationCriteria('tenant-123', {
        page: 1,
        limit: 10,
        category: EvaluationCategory.SECURITY,
      });

      expect(prisma.evaluationCriteria.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            category: EvaluationCategory.SECURITY,
          }),
        })
      );
    });

    it('isActiveでフィルタリングできるべき', async () => {
      vi.mocked(prisma.evaluationCriteria.findMany).mockResolvedValue([]);
      vi.mocked(prisma.evaluationCriteria.count).mockResolvedValue(0);

      await listEvaluationCriteria('tenant-123', {
        page: 1,
        limit: 10,
        isActive: true,
      });

      expect(prisma.evaluationCriteria.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            isActive: true,
          }),
        })
      );
    });

    it('isActiveがfalseの場合もフィルタリングできるべき', async () => {
      vi.mocked(prisma.evaluationCriteria.findMany).mockResolvedValue([]);
      vi.mocked(prisma.evaluationCriteria.count).mockResolvedValue(0);

      await listEvaluationCriteria('tenant-123', {
        page: 1,
        limit: 10,
        isActive: false,
      });

      expect(prisma.evaluationCriteria.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            isActive: false,
          }),
        })
      );
    });
  });

  describe('updateEvaluationCriteria', () => {
    it('評価基準を更新できるべき', async () => {
      const existingCriteria = {
        id: 'criteria-1',
        tenantId: 'tenant-123',
        name: 'Old Name',
      };

      vi.mocked(prisma.evaluationCriteria.findUnique).mockResolvedValue(
        existingCriteria as never
      );
      vi.mocked(prisma.evaluationCriteria.update).mockResolvedValue({
        ...existingCriteria,
        name: 'New Name',
      } as never);

      const result = await updateEvaluationCriteria(
        'criteria-1',
        'tenant-123',
        { name: 'New Name' }
      );

      expect(result?.name).toBe('New Name');
    });

    it('存在しない評価基準の更新はnullを返すべき', async () => {
      vi.mocked(prisma.evaluationCriteria.findUnique).mockResolvedValue(null);

      const result = await updateEvaluationCriteria(
        'nonexistent',
        'tenant-123',
        { name: 'New Name' }
      );

      expect(result).toBeNull();
    });
  });

  describe('deleteEvaluationCriteria', () => {
    it('評価基準を削除できるべき', async () => {
      const existingCriteria = {
        id: 'criteria-1',
        tenantId: 'tenant-123',
      };

      vi.mocked(prisma.evaluationCriteria.findUnique).mockResolvedValue(
        existingCriteria as never
      );
      vi.mocked(prisma.evaluationCriteria.delete).mockResolvedValue(
        existingCriteria as never
      );

      await deleteEvaluationCriteria('criteria-1', 'tenant-123');

      expect(prisma.evaluationCriteria.delete).toHaveBeenCalledWith({
        where: { id: 'criteria-1' },
      });
    });

    it('異なるテナントの評価基準は削除しないべき', async () => {
      const existingCriteria = {
        id: 'criteria-1',
        tenantId: 'tenant-other',
      };

      vi.mocked(prisma.evaluationCriteria.findUnique).mockResolvedValue(
        existingCriteria as never
      );

      await deleteEvaluationCriteria('criteria-1', 'tenant-123');

      expect(prisma.evaluationCriteria.delete).not.toHaveBeenCalled();
    });
  });
});

describe('採点セッション管理', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createScoringSession', () => {
    it('採点セッションを作成できるべき', async () => {
      const input = {
        tenantId: 'tenant-123',
        battleId: 'battle-456',
        participantId: 'participant-789',
      };

      const mockSession = {
        id: 'session-1',
        ...input,
        status: EvaluationStatus.PENDING,
        totalScore: 0,
        maxPossibleScore: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      vi.mocked(prisma.scoringSession.create).mockResolvedValue(
        mockSession as never
      );

      const result = await createScoringSession(input);

      expect(result).toEqual(mockSession);
      expect(prisma.scoringSession.create).toHaveBeenCalledWith({
        data: input,
      });
    });
  });

  describe('getScoringSession', () => {
    it('採点セッションを取得できるべき', async () => {
      const mockSession = {
        id: 'session-1',
        tenantId: 'tenant-123',
        status: EvaluationStatus.PENDING,
        evaluationItems: [],
        feedbacks: [],
      };

      vi.mocked(prisma.scoringSession.findUnique).mockResolvedValue(
        mockSession as never
      );

      const result = await getScoringSession('session-1', 'tenant-123');

      expect(result).toEqual(mockSession);
    });

    it('異なるテナントのセッションはnullを返すべき', async () => {
      const mockSession = {
        id: 'session-1',
        tenantId: 'tenant-other',
      };

      vi.mocked(prisma.scoringSession.findUnique).mockResolvedValue(
        mockSession as never
      );

      const result = await getScoringSession('session-1', 'tenant-123');

      expect(result).toBeNull();
    });
  });

  describe('listScoringSessions', () => {
    it('採点セッション一覧を取得できるべき', async () => {
      const mockSessions = [
        { id: 'session-1', status: EvaluationStatus.PENDING },
        { id: 'session-2', status: EvaluationStatus.COMPLETED },
      ];

      vi.mocked(prisma.scoringSession.findMany).mockResolvedValue(
        mockSessions as never
      );
      vi.mocked(prisma.scoringSession.count).mockResolvedValue(2);

      const result = await listScoringSessions('tenant-123', {
        page: 1,
        limit: 10,
      });

      expect(result.data).toEqual(mockSessions);
      expect(result.total).toBe(2);
    });

    it('バトルIDでフィルタリングできるべき', async () => {
      vi.mocked(prisma.scoringSession.findMany).mockResolvedValue([]);
      vi.mocked(prisma.scoringSession.count).mockResolvedValue(0);

      await listScoringSessions('tenant-123', {
        page: 1,
        limit: 10,
        battleId: 'battle-456',
      });

      expect(prisma.scoringSession.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            battleId: 'battle-456',
          }),
        })
      );
    });

    it('参加者IDでフィルタリングできるべき', async () => {
      vi.mocked(prisma.scoringSession.findMany).mockResolvedValue([]);
      vi.mocked(prisma.scoringSession.count).mockResolvedValue(0);

      await listScoringSessions('tenant-123', {
        page: 1,
        limit: 10,
        participantId: 'participant-789',
      });

      expect(prisma.scoringSession.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            participantId: 'participant-789',
          }),
        })
      );
    });

    it('ステータスでフィルタリングできるべき', async () => {
      vi.mocked(prisma.scoringSession.findMany).mockResolvedValue([]);
      vi.mocked(prisma.scoringSession.count).mockResolvedValue(0);

      await listScoringSessions('tenant-123', {
        page: 1,
        limit: 10,
        status: EvaluationStatus.COMPLETED,
      });

      expect(prisma.scoringSession.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: EvaluationStatus.COMPLETED,
          }),
        })
      );
    });
  });
});

describe('採点実行', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('submitForEvaluation', () => {
    it('Terraform Stateを提出して評価を開始できるべき', async () => {
      const mockSession = {
        id: 'session-1',
        tenantId: 'tenant-123',
        status: EvaluationStatus.PENDING,
      };

      const terraformState = {
        version: 4,
        resources: [
          { type: 'aws_vpc', name: 'main' },
          { type: 'aws_subnet', name: 'public' },
        ],
      };

      vi.mocked(prisma.scoringSession.findUnique).mockResolvedValue(
        mockSession as never
      );
      vi.mocked(prisma.scoringSession.update).mockResolvedValue({
        ...mockSession,
        status: EvaluationStatus.IN_PROGRESS,
      } as never);
      vi.mocked(prisma.terraformSnapshot.create).mockResolvedValue({
        id: 'snapshot-1',
      } as never);

      const result = await submitForEvaluation(
        'session-1',
        'tenant-123',
        terraformState
      );

      expect(result?.status).toBe(EvaluationStatus.IN_PROGRESS);
      expect(prisma.terraformSnapshot.create).toHaveBeenCalled();
    });

    it('PENDING以外のセッションは提出できないべき', async () => {
      const mockSession = {
        id: 'session-1',
        tenantId: 'tenant-123',
        status: EvaluationStatus.IN_PROGRESS,
      };

      vi.mocked(prisma.scoringSession.findUnique).mockResolvedValue(
        mockSession as never
      );

      await expect(
        submitForEvaluation('session-1', 'tenant-123', { version: 4 })
      ).rejects.toThrow('評価待ちのセッションのみ提出できます');
    });

    it('resourcesがないterraformStateでもresourceCount=0で保存するべき', async () => {
      const mockSession = {
        id: 'session-1',
        tenantId: 'tenant-123',
        status: EvaluationStatus.PENDING,
      };

      const terraformState = { version: 4 };

      vi.mocked(prisma.scoringSession.findUnique).mockResolvedValue(
        mockSession as never
      );
      vi.mocked(prisma.scoringSession.update).mockResolvedValue({
        ...mockSession,
        status: EvaluationStatus.IN_PROGRESS,
      } as never);
      vi.mocked(prisma.terraformSnapshot.create).mockResolvedValue({
        id: 'snapshot-1',
      } as never);

      await submitForEvaluation('session-1', 'tenant-123', terraformState);

      expect(prisma.terraformSnapshot.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          resourceCount: 0,
        }),
      });
    });

    it('セッションが見つからない場合はnullを返すべき', async () => {
      vi.mocked(prisma.scoringSession.findUnique).mockResolvedValue(null);

      const result = await submitForEvaluation('nonexistent', 'tenant-123', {
        version: 4,
      });

      expect(result).toBeNull();
    });

    it('異なるテナントのセッションはnullを返すべき', async () => {
      const mockSession = {
        id: 'session-1',
        tenantId: 'tenant-other',
        status: EvaluationStatus.PENDING,
      };

      vi.mocked(prisma.scoringSession.findUnique).mockResolvedValue(
        mockSession as never
      );

      const result = await submitForEvaluation('session-1', 'tenant-123', {
        version: 4,
      });

      expect(result).toBeNull();
    });
  });

  describe('evaluateSubmission', () => {
    it('提出を評価してスコアを計算できるべき', async () => {
      const mockSession = {
        id: 'session-1',
        tenantId: 'tenant-123',
        status: EvaluationStatus.IN_PROGRESS,
      };

      const mockCriteria = [
        {
          id: 'criteria-1',
          name: 'VPC構成',
          maxScore: 100,
          weight: 1,
          criteriaDetails: [
            { ruleKey: 'vpc_exists', ruleValue: 'true', points: 50 },
            { ruleKey: 'vpc_cidr', ruleValue: '10.0.0.0/16', points: 50 },
          ],
        },
      ];

      const mockSnapshot = {
        stateData: {
          resources: [
            {
              type: 'aws_vpc',
              instances: [{ attributes: { cidr_block: '10.0.0.0/16' } }],
            },
          ],
        },
      };

      vi.mocked(prisma.scoringSession.findUnique).mockResolvedValue({
        ...mockSession,
        terraformSnapshot: mockSnapshot,
      } as never);
      vi.mocked(prisma.evaluationCriteria.findMany).mockResolvedValue(
        mockCriteria as never
      );
      vi.mocked(prisma.evaluationItem.createMany).mockResolvedValue({
        count: 1,
      });
      vi.mocked(prisma.feedback.createMany).mockResolvedValue({ count: 1 });
      vi.mocked(prisma.scoringSession.update).mockResolvedValue({
        ...mockSession,
        status: EvaluationStatus.COMPLETED,
        totalScore: 100,
      } as never);

      const result = await evaluateSubmission('session-1', 'tenant-123');

      expect(result?.status).toBe(EvaluationStatus.COMPLETED);
      expect(result?.totalScore).toBe(100);
    });

    it('IN_PROGRESS以外のセッションは評価できないべき', async () => {
      const mockSession = {
        id: 'session-1',
        tenantId: 'tenant-123',
        status: EvaluationStatus.PENDING,
      };

      vi.mocked(prisma.scoringSession.findUnique).mockResolvedValue(
        mockSession as never
      );

      await expect(
        evaluateSubmission('session-1', 'tenant-123')
      ).rejects.toThrow('評価中のセッションのみ採点できます');
    });

    it('セッションが見つからない場合はnullを返すべき', async () => {
      vi.mocked(prisma.scoringSession.findUnique).mockResolvedValue(null);

      const result = await evaluateSubmission('nonexistent', 'tenant-123');

      expect(result).toBeNull();
    });

    it('異なるテナントのセッションはnullを返すべき', async () => {
      const mockSession = {
        id: 'session-1',
        tenantId: 'tenant-other',
        status: EvaluationStatus.IN_PROGRESS,
      };

      vi.mocked(prisma.scoringSession.findUnique).mockResolvedValue(
        mockSession as never
      );

      const result = await evaluateSubmission('session-1', 'tenant-123');

      expect(result).toBeNull();
    });

    it('フィードバックがある場合に保存されるべき', async () => {
      const mockSession = {
        id: 'session-1',
        tenantId: 'tenant-123',
        status: EvaluationStatus.IN_PROGRESS,
        terraformSnapshot: {
          stateData: { version: 4, resources: [] },
        },
      };

      const mockCriteria = [
        {
          id: 'criteria-1',
          name: 'VPC構成',
          category: EvaluationCategory.INFRASTRUCTURE,
          maxScore: 100,
          weight: 1,
          criteriaDetails: [
            {
              ruleKey: 'vpc_exists',
              ruleValue: 'true',
              points: 100,
              severity: Severity.HIGH,
              description: 'VPCが必要です',
            },
          ],
        },
      ];

      vi.mocked(prisma.scoringSession.findUnique).mockResolvedValue(
        mockSession as never
      );
      vi.mocked(prisma.evaluationCriteria.findMany).mockResolvedValue(
        mockCriteria as never
      );
      vi.mocked(prisma.evaluationItem.createMany).mockResolvedValue({
        count: 1,
      });
      vi.mocked(prisma.feedback.createMany).mockResolvedValue({ count: 1 });
      vi.mocked(prisma.scoringSession.update).mockResolvedValue({
        ...mockSession,
        status: EvaluationStatus.COMPLETED,
        totalScore: 0,
      } as never);

      const result = await evaluateSubmission('session-1', 'tenant-123');

      expect(result?.status).toBe(EvaluationStatus.COMPLETED);
      expect(prisma.feedback.createMany).toHaveBeenCalled();
    });

    it('評価項目がない場合はcreateMany呼び出しをスキップするべき', async () => {
      const mockSession = {
        id: 'session-1',
        tenantId: 'tenant-123',
        status: EvaluationStatus.IN_PROGRESS,
        terraformSnapshot: {
          stateData: { version: 4, resources: [] },
        },
      };

      vi.mocked(prisma.scoringSession.findUnique).mockResolvedValue(
        mockSession as never
      );
      vi.mocked(prisma.evaluationCriteria.findMany).mockResolvedValue([]);
      vi.mocked(prisma.scoringSession.update).mockResolvedValue({
        ...mockSession,
        status: EvaluationStatus.COMPLETED,
        totalScore: 0,
      } as never);

      await evaluateSubmission('session-1', 'tenant-123');

      expect(prisma.evaluationItem.createMany).not.toHaveBeenCalled();
      expect(prisma.feedback.createMany).not.toHaveBeenCalled();
    });
  });
});

describe('フィードバック取得', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getSessionFeedback', () => {
    it('セッションのフィードバックを取得できるべき', async () => {
      const mockSession = {
        id: 'session-1',
        tenantId: 'tenant-123',
      };

      const mockFeedbacks = [
        {
          id: 'fb-1',
          category: EvaluationCategory.SECURITY,
          severity: Severity.HIGH,
          title: 'セキュリティグループが開放されています',
          message: 'ポート22が0.0.0.0/0に開放されています',
          suggestion: 'アクセス元IPを制限してください',
        },
      ];

      vi.mocked(prisma.scoringSession.findUnique).mockResolvedValue(
        mockSession as never
      );
      vi.mocked(prisma.feedback.findMany).mockResolvedValue(
        mockFeedbacks as never
      );

      const result = await getSessionFeedback('session-1', 'tenant-123');

      expect(result).toEqual(mockFeedbacks);
    });

    it('異なるテナントのフィードバックは取得できないべき', async () => {
      vi.mocked(prisma.scoringSession.findUnique).mockResolvedValue({
        id: 'session-1',
        tenantId: 'tenant-other',
      } as never);

      const result = await getSessionFeedback('session-1', 'tenant-123');

      expect(result).toBeNull();
    });
  });
});

describe('Terraform State 評価ヘルパー関数', () => {
  describe('checkRule', () => {
    it('リソースがない場合は失敗を返すべき', () => {
      const result = checkRule(undefined, 'vpc_exists', 'true');
      expect(result.passed).toBe(false);
      expect(result.actualValue).toBeUndefined();
    });

    it('resourcesが空の場合は失敗を返すべき', () => {
      const result = checkRule({ version: 4 }, 'vpc_exists', 'true');
      expect(result.passed).toBe(false);
    });

    it('vpc_exists ルールを評価できるべき', () => {
      const state = {
        version: 4,
        resources: [{ type: 'aws_vpc', name: 'main' }],
      };
      const result = checkRule(state, 'vpc_exists', 'true');
      expect(result.passed).toBe(true);
      expect(result.actualValue).toBe('exists');
    });

    it('vpc_cidr ルールを評価できるべき', () => {
      const state = {
        version: 4,
        resources: [
          {
            type: 'aws_vpc',
            name: 'main',
            instances: [{ attributes: { cidr_block: '10.0.0.0/16' } }],
          },
        ],
      };
      const result = checkRule(state, 'vpc_cidr', '10.0.0.0/16');
      expect(result.passed).toBe(true);
    });

    it('s3_encryption ルールを評価できるべき', () => {
      const state = {
        version: 4,
        resources: [
          { type: 'aws_s3_bucket', name: 'bucket1' },
          {
            type: 'aws_s3_bucket_server_side_encryption_configuration',
            name: 'enc1',
          },
        ],
      };
      const result = checkRule(state, 's3_encryption', 'true');
      expect(result.passed).toBe(true);
    });

    it('security_group_ssh ルールを評価できるべき', () => {
      const state = {
        version: 4,
        resources: [{ type: 'aws_security_group', name: 'sg1' }],
      };
      const result = checkRule(state, 'security_group_ssh', 'restricted');
      expect(result.passed).toBe(true);
    });

    it('不明なルールキーの場合は失敗を返すべき', () => {
      const state = { version: 4, resources: [] };
      const result = checkRule(state, 'unknown_rule', 'value');
      expect(result.passed).toBe(false);
      expect(result.actualValue).toBe('unknown rule');
    });
  });

  describe('checkResourceExists', () => {
    it('リソースが存在する場合に成功を返すべき', () => {
      const state = {
        version: 4,
        resources: [{ type: 'aws_vpc' }],
      };
      const result = checkResourceExists(state, 'aws_vpc', true);
      expect(result.passed).toBe(true);
      expect(result.actualValue).toBe('exists');
    });

    it('リソースが存在しない場合に期待通りの結果を返すべき', () => {
      const state = {
        version: 4,
        resources: [{ type: 'aws_subnet' }],
      };
      const result = checkResourceExists(state, 'aws_vpc', false);
      expect(result.passed).toBe(true);
      expect(result.actualValue).toBe('not exists');
    });

    it('リソースが存在するが期待しない場合は失敗を返すべき', () => {
      const state = {
        version: 4,
        resources: [{ type: 'aws_vpc' }],
      };
      const result = checkResourceExists(state, 'aws_vpc', false);
      expect(result.passed).toBe(false);
    });

    it('resourcesがundefinedの場合は存在しないとみなすべき', () => {
      const state = { version: 4 };
      const result = checkResourceExists(state, 'aws_vpc', false);
      expect(result.passed).toBe(true);
      expect(result.actualValue).toBe('not exists');
    });
  });

  describe('checkResourceAttribute', () => {
    it('属性が一致する場合に成功を返すべき', () => {
      const state = {
        version: 4,
        resources: [
          {
            type: 'aws_vpc',
            name: 'main',
            instances: [{ attributes: { cidr_block: '10.0.0.0/16' } }],
          },
        ],
      };
      const result = checkResourceAttribute(
        state,
        'aws_vpc',
        'cidr_block',
        '10.0.0.0/16'
      );
      expect(result.passed).toBe(true);
      expect(result.actualValue).toBe('10.0.0.0/16');
      expect(result.resourceRef).toBe('aws_vpc.main');
    });

    it('リソースが見つからない場合は失敗を返すべき', () => {
      const state = {
        version: 4,
        resources: [{ type: 'aws_subnet' }],
      };
      const result = checkResourceAttribute(
        state,
        'aws_vpc',
        'cidr_block',
        '10.0.0.0/16'
      );
      expect(result.passed).toBe(false);
      expect(result.actualValue).toBeUndefined();
    });

    it('インスタンスがない場合は失敗を返すべき', () => {
      const state = {
        version: 4,
        resources: [{ type: 'aws_vpc', name: 'main' }],
      };
      const result = checkResourceAttribute(
        state,
        'aws_vpc',
        'cidr_block',
        '10.0.0.0/16'
      );
      expect(result.passed).toBe(false);
    });

    it('属性が一致しない場合は失敗を返すべき', () => {
      const state = {
        version: 4,
        resources: [
          {
            type: 'aws_vpc',
            name: 'main',
            instances: [{ attributes: { cidr_block: '192.168.0.0/16' } }],
          },
        ],
      };
      const result = checkResourceAttribute(
        state,
        'aws_vpc',
        'cidr_block',
        '10.0.0.0/16'
      );
      expect(result.passed).toBe(false);
      expect(result.actualValue).toBe('192.168.0.0/16');
    });

    it('リソース名がない場合はunknownを使用するべき', () => {
      const state = {
        version: 4,
        resources: [
          {
            type: 'aws_vpc',
            instances: [{ attributes: { cidr_block: '10.0.0.0/16' } }],
          },
        ],
      };
      const result = checkResourceAttribute(
        state,
        'aws_vpc',
        'cidr_block',
        '10.0.0.0/16'
      );
      expect(result.resourceRef).toBe('aws_vpc.unknown');
    });

    it('属性がundefinedの場合は空文字列として比較するべき', () => {
      const state = {
        version: 4,
        resources: [
          {
            type: 'aws_vpc',
            name: 'main',
            instances: [{ attributes: { other_attr: 'value' } }],
          },
        ],
      };
      const result = checkResourceAttribute(state, 'aws_vpc', 'cidr_block', '');
      expect(result.passed).toBe(true);
      expect(result.actualValue).toBe('');
    });
  });

  describe('checkS3Encryption', () => {
    it('S3バケットがない場合は暗号化不要として成功を返すべき', () => {
      const state = { version: 4, resources: [] };
      const result = checkS3Encryption(state, false);
      expect(result.passed).toBe(true);
      expect(result.actualValue).toBe('no s3 buckets');
    });

    it('S3バケットがなく暗号化が必要な場合は失敗を返すべき', () => {
      const state = { version: 4, resources: [] };
      const result = checkS3Encryption(state, true);
      expect(result.passed).toBe(false);
    });

    it('resourcesがundefinedの場合はS3バケットなしとみなすべき', () => {
      const state = { version: 4 };
      const result = checkS3Encryption(state, false);
      expect(result.passed).toBe(true);
      expect(result.actualValue).toBe('no s3 buckets');
    });

    it('暗号化設定がある場合に成功を返すべき', () => {
      const state = {
        version: 4,
        resources: [
          { type: 'aws_s3_bucket', name: 'bucket1' },
          {
            type: 'aws_s3_bucket_server_side_encryption_configuration',
            name: 'enc1',
          },
        ],
      };
      const result = checkS3Encryption(state, true);
      expect(result.passed).toBe(true);
      expect(result.actualValue).toBe('encrypted');
    });

    it('暗号化設定がない場合は失敗を返すべき', () => {
      const state = {
        version: 4,
        resources: [{ type: 'aws_s3_bucket', name: 'bucket1' }],
      };
      const result = checkS3Encryption(state, true);
      expect(result.passed).toBe(false);
      expect(result.actualValue).toBe('not encrypted');
    });
  });

  describe('checkSecurityGroupSSH', () => {
    it('SSHが制限されている場合に成功を返すべき', () => {
      const state = {
        version: 4,
        resources: [
          {
            type: 'aws_security_group',
            name: 'sg1',
            instances: [
              {
                attributes: {
                  ingress: [{ from_port: 22, cidr_blocks: ['10.0.0.0/8'] }],
                },
              },
            ],
          },
        ],
      };
      const result = checkSecurityGroupSSH(state, true);
      expect(result.passed).toBe(true);
      expect(result.actualValue).toBe('restricted');
    });

    it('SSHが0.0.0.0/0に開放されている場合に失敗を返すべき', () => {
      const state = {
        version: 4,
        resources: [
          {
            type: 'aws_security_group',
            name: 'sg1',
            instances: [
              {
                attributes: {
                  ingress: [{ from_port: 22, cidr_blocks: ['0.0.0.0/0'] }],
                },
              },
            ],
          },
        ],
      };
      const result = checkSecurityGroupSSH(state, true);
      expect(result.passed).toBe(false);
      expect(result.actualValue).toBe('0.0.0.0/0');
      expect(result.resourceRef).toBe('aws_security_group.sg1');
    });

    it('ingressがない場合は制限されているとみなすべき', () => {
      const state = {
        version: 4,
        resources: [
          {
            type: 'aws_security_group',
            name: 'sg1',
            instances: [{ attributes: {} }],
          },
        ],
      };
      const result = checkSecurityGroupSSH(state, true);
      expect(result.passed).toBe(true);
    });

    it('セキュリティグループがない場合は成功を返すべき', () => {
      const state = { version: 4, resources: [] };
      const result = checkSecurityGroupSSH(state, true);
      expect(result.passed).toBe(true);
    });

    it('resourcesがundefinedの場合は成功を返すべき', () => {
      const state = { version: 4 };
      const result = checkSecurityGroupSSH(state, true);
      expect(result.passed).toBe(true);
    });

    it('SGの名前がない場合はunknownを使用するべき', () => {
      const state = {
        version: 4,
        resources: [
          {
            type: 'aws_security_group',
            instances: [
              {
                attributes: {
                  ingress: [{ from_port: 22, cidr_blocks: ['0.0.0.0/0'] }],
                },
              },
            ],
          },
        ],
      };
      const result = checkSecurityGroupSSH(state, true);
      expect(result.resourceRef).toBe('aws_security_group.unknown');
    });
  });

  describe('generateSuggestion', () => {
    it('vpc_existsの提案を返すべき', () => {
      const result = generateSuggestion('vpc_exists', 'true');
      expect(result).toBe('VPCを作成してください');
    });

    it('vpc_cidrの提案を返すべき', () => {
      const result = generateSuggestion('vpc_cidr', '10.0.0.0/16');
      expect(result).toBe('VPCのCIDRブロックを 10.0.0.0/16 に設定してください');
    });

    it('s3_encryptionの提案を返すべき', () => {
      const result = generateSuggestion('s3_encryption', 'true');
      expect(result).toBe(
        'S3バケットのサーバーサイド暗号化を有効にしてください'
      );
    });

    it('security_group_sshの提案を返すべき', () => {
      const result = generateSuggestion('security_group_ssh', 'restricted');
      expect(result).toBe(
        'SSHポート(22)へのアクセスを特定のIPアドレスに制限してください'
      );
    });

    it('不明なルールの場合はデフォルトの提案を返すべき', () => {
      const result = generateSuggestion('unknown_rule', 'value');
      expect(result).toBe('設定を見直してください');
    });
  });

  describe('evaluateTerraformState', () => {
    it('空の基準リストの場合は空の結果を返すべき', () => {
      const state = { version: 4, resources: [] };
      const result = evaluateTerraformState(state, []);
      expect(result.items).toEqual([]);
      expect(result.feedbacks).toEqual([]);
      expect(result.totalScore).toBe(0);
      expect(result.maxPossibleScore).toBe(0);
    });

    it('基準に基づいて評価結果を返すべき', () => {
      const state = {
        version: 4,
        resources: [{ type: 'aws_vpc', name: 'main' }],
      };
      const criteria = [
        {
          id: 'criteria-1',
          name: 'VPC構成',
          category: EvaluationCategory.INFRASTRUCTURE,
          maxScore: 100,
          weight: 1,
          criteriaDetails: [
            {
              ruleKey: 'vpc_exists',
              ruleValue: 'true',
              points: 100,
              severity: Severity.HIGH,
              description: 'VPCが存在すること',
            },
          ],
        },
      ];
      const result = evaluateTerraformState(state, criteria);
      expect(result.totalScore).toBe(100);
      expect(result.maxPossibleScore).toBe(100);
      expect(result.items).toHaveLength(1);
      expect(result.items[0].passed).toBe(true);
    });
  });

  describe('evaluateCriterion', () => {
    it('すべてのルールをパスした場合に満点を返すべき', () => {
      const state = {
        version: 4,
        resources: [{ type: 'aws_vpc', name: 'main' }],
      };
      const criterion = {
        id: 'criteria-1',
        name: 'VPC構成',
        category: EvaluationCategory.INFRASTRUCTURE,
        maxScore: 100,
        weight: 1,
        criteriaDetails: [
          {
            ruleKey: 'vpc_exists',
            ruleValue: 'true',
            points: 100,
            severity: Severity.HIGH,
            description: null,
          },
        ],
      };
      const result = evaluateCriterion(state, criterion);
      expect(result.item.score).toBe(100);
      expect(result.item.passed).toBe(true);
      expect(result.feedbacks).toHaveLength(0);
    });

    it('ルールに失敗した場合にフィードバックを生成するべき', () => {
      const state = {
        version: 4,
        resources: [],
      };
      const criterion = {
        id: 'criteria-1',
        name: 'VPC構成',
        category: EvaluationCategory.INFRASTRUCTURE,
        maxScore: 100,
        weight: 1,
        criteriaDetails: [
          {
            ruleKey: 'vpc_exists',
            ruleValue: 'true',
            points: 100,
            severity: Severity.HIGH,
            description: null,
          },
        ],
      };
      const result = evaluateCriterion(state, criterion);
      expect(result.item.score).toBe(0);
      expect(result.item.passed).toBe(false);
      expect(result.feedbacks).toHaveLength(1);
      expect(result.feedbacks[0].category).toBe(
        EvaluationCategory.INFRASTRUCTURE
      );
      expect(result.feedbacks[0].severity).toBe(Severity.HIGH);
    });

    it('descriptionがある場合はそれをメッセージに使用するべき', () => {
      const state = { version: 4, resources: [] };
      const criterion = {
        id: 'criteria-1',
        name: 'VPC構成',
        category: EvaluationCategory.INFRASTRUCTURE,
        maxScore: 100,
        weight: 1,
        criteriaDetails: [
          {
            ruleKey: 'vpc_exists',
            ruleValue: 'true',
            points: 100,
            severity: Severity.HIGH,
            description: 'カスタムメッセージ',
          },
        ],
      };
      const result = evaluateCriterion(state, criterion);
      expect(result.feedbacks[0].message).toBe('カスタムメッセージ');
    });

    it('actualValueがundefinedの場合は「なし」を使用するべき', () => {
      const state = undefined;
      const criterion = {
        id: 'criteria-1',
        name: 'VPC構成',
        category: EvaluationCategory.INFRASTRUCTURE,
        maxScore: 100,
        weight: 1,
        criteriaDetails: [
          {
            ruleKey: 'vpc_exists',
            ruleValue: 'true',
            points: 100,
            severity: Severity.HIGH,
            description: null,
          },
        ],
      };
      const result = evaluateCriterion(state, criterion);
      expect(result.feedbacks[0].message).toContain('なし');
    });
  });
});
