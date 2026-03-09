import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { scoresRoutes } from './scores';

// モック設定
const mockAssumeRole = vi.fn();
const mockCreateS3Client = vi.fn();
const mockEvaluateBucket = vi.fn();

vi.mock('../lib/aws', () => ({
  assumeRole: (...args: unknown[]) => mockAssumeRole(...args),
  createS3Client: (...args: unknown[]) => mockCreateS3Client(...args),
}));

vi.mock('../scorers/s3-scorer', () => ({
  evaluateBucket: (...args: unknown[]) => mockEvaluateBucket(...args),
}));

const { mockScoringSessionRepository } = vi.hoisted(() => ({
  mockScoringSessionRepository: {
    create: vi.fn(),
    update: vi.fn(),
    listByTenant: vi.fn(),
  },
}));

vi.mock('../lib/dynamodb', () => ({
  scoringSessionRepository: mockScoringSessionRepository,
}));

const mockAuth = {
  userId: 'user-123',
  tenantId: 'tenant-456',
  roles: ['user'],
};

describe('スコア API', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.use('/*', async (c, next) => {
      c.set('auth', mockAuth);
      await next();
    });
    app.route('/', scoresRoutes);

    mockCreateS3Client.mockReturnValue({ send: vi.fn() });
  });

  describe('POST /api/scores/evaluate', () => {
    const validBody = {
      participantId: 'participant-1',
      battleId: 'battle-1',
      bucketName: 'test-bucket',
      criteria: [
        { check: 'encryption', weight: 25 },
        { check: 'public_access', weight: 25 },
        { check: 'versioning', weight: 25 },
        { check: 'logging', weight: 25 },
      ],
    };

    it('S3バケットを評価してスコアを返すべき', async () => {
      mockEvaluateBucket.mockResolvedValue({
        bucketName: 'test-bucket',
        totalScore: 75,
        maxScore: 100,
        results: [
          { check: 'encryption', passed: true, details: '暗号化あり' },
          {
            check: 'public_access',
            passed: true,
            details: 'ブロック済み',
          },
          { check: 'versioning', passed: true, details: '有効' },
          { check: 'logging', passed: false, details: 'ログなし' },
        ],
      });

      mockScoringSessionRepository.create.mockResolvedValue({
        id: 'session-1',
        tenantId: 'tenant-456',
        status: 'PENDING',
      });
      mockScoringSessionRepository.update.mockResolvedValue({
        id: 'session-1',
        status: 'COMPLETED',
        totalScore: 75,
      });

      const res = await app.request('/api/scores/evaluate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validBody),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.totalScore).toBe(75);
      expect(body.maxScore).toBe(100);
      expect(body.results).toHaveLength(4);
      expect(body.sessionId).toBe('session-1');
    });

    it('roleArnが指定された場合にAssumeRoleを使用するべき', async () => {
      mockAssumeRole.mockResolvedValue({
        accessKeyId: 'AKIA123',
        secretAccessKey: 'secret',
        sessionToken: 'token',
      });
      mockEvaluateBucket.mockResolvedValue({
        bucketName: 'test-bucket',
        totalScore: 100,
        maxScore: 100,
        results: [],
      });
      mockScoringSessionRepository.create.mockResolvedValue({
        id: 'session-1',
      });
      mockScoringSessionRepository.update.mockResolvedValue({
        id: 'session-1',
        totalScore: 100,
      });

      await app.request('/api/scores/evaluate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...validBody,
          roleArn: 'arn:aws:iam::123456:role/test',
        }),
      });

      expect(mockAssumeRole).toHaveBeenCalledWith(
        'arn:aws:iam::123456:role/test',
        'scoring-participant-1'
      );
      expect(mockCreateS3Client).toHaveBeenCalledWith(
        expect.objectContaining({ accessKeyId: 'AKIA123' })
      );
    });

    it('参加者IDがない場合に400を返すべき', async () => {
      const res = await app.request('/api/scores/evaluate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          battleId: 'battle-1',
          bucketName: 'test-bucket',
          criteria: [{ check: 'encryption', weight: 25 }],
        }),
      });

      expect(res.status).toBe(400);
    });

    it('バケット名がない場合に400を返すべき', async () => {
      const res = await app.request('/api/scores/evaluate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          participantId: 'p-1',
          battleId: 'battle-1',
          criteria: [{ check: 'encryption', weight: 25 }],
        }),
      });

      expect(res.status).toBe(400);
    });

    it('基準が空の場合に400を返すべき', async () => {
      const res = await app.request('/api/scores/evaluate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          participantId: 'p-1',
          battleId: 'battle-1',
          bucketName: 'test-bucket',
          criteria: [],
        }),
      });

      expect(res.status).toBe(400);
    });

    it('不正なJSONで400を返すべき', async () => {
      const res = await app.request('/api/scores/evaluate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'invalid json',
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('リクエストボディが不正です');
    });

    it('評価エラーで400を返すべき', async () => {
      mockEvaluateBucket.mockRejectedValue(
        new Error('バケットにアクセスできません')
      );
      mockScoringSessionRepository.create.mockResolvedValue({
        id: 'session-1',
      });

      const res = await app.request('/api/scores/evaluate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validBody),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('バケットにアクセスできません');
    });

    it('非Errorがスローされた場合は再スローするべき', async () => {
      mockEvaluateBucket.mockRejectedValue('string error');
      mockScoringSessionRepository.create.mockResolvedValue({
        id: 'session-1',
      });

      await expect(
        app.request('/api/scores/evaluate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(validBody),
        })
      ).rejects.toBe('string error');
    });
  });

  describe('GET /api/scores/:participantId', () => {
    it('参加者のスコア一覧を取得できるべき', async () => {
      const mockSessions = [
        {
          id: 'session-1',
          participantId: 'participant-1',
          totalScore: 75,
          status: 'COMPLETED',
        },
        {
          id: 'session-2',
          participantId: 'participant-1',
          totalScore: 100,
          status: 'COMPLETED',
        },
      ];

      mockScoringSessionRepository.listByTenant.mockResolvedValue({
        sessions: mockSessions,
      });

      const res = await app.request('/api/scores/participant-1');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.participantId).toBe('participant-1');
      expect(body.scores).toHaveLength(2);
    });

    it('battleIdでフィルタリングできるべき', async () => {
      mockScoringSessionRepository.listByTenant.mockResolvedValue({
        sessions: [],
      });

      await app.request('/api/scores/participant-1?battleId=battle-1');

      expect(mockScoringSessionRepository.listByTenant).toHaveBeenCalledWith(
        'tenant-456',
        {
          participantId: 'participant-1',
          battleId: 'battle-1',
        }
      );
    });

    it('battleIdがない場合はundefinedでフィルタリングするべき', async () => {
      mockScoringSessionRepository.listByTenant.mockResolvedValue({
        sessions: [],
      });

      await app.request('/api/scores/participant-1');

      expect(mockScoringSessionRepository.listByTenant).toHaveBeenCalledWith(
        'tenant-456',
        {
          participantId: 'participant-1',
          battleId: undefined,
        }
      );
    });
  });
});
