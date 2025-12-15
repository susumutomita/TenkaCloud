import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { scoringRoutes } from './scoring';
import * as scoringService from '../services/scoring';
import { EvaluationCategory, EvaluationStatus, Severity } from '@prisma/client';

vi.mock('../services/scoring');

// テスト用のモック認証コンテキスト
const mockAuthMiddleware = vi.fn((c, next) => {
  c.set('auth', {
    userId: 'user-123',
    tenantId: 'tenant-456',
    roles: ['user'],
  });
  return next();
});

describe('採点 API', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.use('/*', mockAuthMiddleware);
    app.route('/', scoringRoutes);
  });

  describe('評価基準 API', () => {
    describe('POST /criteria', () => {
      it('評価基準を作成できるべき', async () => {
        const mockCriteria = {
          id: 'criteria-1',
          tenantId: 'tenant-456',
          name: 'VPC構成チェック',
          category: EvaluationCategory.INFRASTRUCTURE,
        };

        vi.mocked(scoringService.createEvaluationCriteria).mockResolvedValue(
          mockCriteria as never
        );

        const res = await app.request('/criteria', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'VPC構成チェック',
            category: 'INFRASTRUCTURE',
          }),
        });

        expect(res.status).toBe(201);
        const body = await res.json();
        expect(body.id).toBe('criteria-1');
      });

      it('名前が空の場合は400を返すべき', async () => {
        const res = await app.request('/criteria', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: '',
            category: 'INFRASTRUCTURE',
          }),
        });

        expect(res.status).toBe(400);
      });
    });

    describe('GET /criteria', () => {
      it('評価基準一覧を取得できるべき', async () => {
        const mockResult = {
          data: [{ id: 'criteria-1', name: 'VPC構成' }],
          total: 1,
          page: 1,
          limit: 10,
        };

        vi.mocked(scoringService.listEvaluationCriteria).mockResolvedValue(
          mockResult as never
        );

        const res = await app.request('/criteria?page=1&limit=10');

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.data).toHaveLength(1);
        expect(body.total).toBe(1);
      });
    });

    describe('GET /criteria/:id', () => {
      it('評価基準を取得できるべき', async () => {
        const mockCriteria = {
          id: 'criteria-1',
          tenantId: 'tenant-456',
          name: 'VPC構成チェック',
        };

        vi.mocked(scoringService.getEvaluationCriteria).mockResolvedValue(
          mockCriteria as never
        );

        const res = await app.request('/criteria/criteria-1');

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.id).toBe('criteria-1');
      });

      it('存在しない評価基準は404を返すべき', async () => {
        vi.mocked(scoringService.getEvaluationCriteria).mockResolvedValue(null);

        const res = await app.request('/criteria/nonexistent');

        expect(res.status).toBe(404);
      });
    });

    describe('PUT /criteria/:id', () => {
      it('評価基準を更新できるべき', async () => {
        const mockCriteria = {
          id: 'criteria-1',
          name: 'Updated Name',
        };

        vi.mocked(scoringService.updateEvaluationCriteria).mockResolvedValue(
          mockCriteria as never
        );

        const res = await app.request('/criteria/criteria-1', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Updated Name' }),
        });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.name).toBe('Updated Name');
      });

      it('存在しない評価基準の更新は404を返すべき', async () => {
        vi.mocked(scoringService.updateEvaluationCriteria).mockResolvedValue(
          null
        );

        const res = await app.request('/criteria/nonexistent', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Updated Name' }),
        });

        expect(res.status).toBe(404);
      });

      it('無効な更新データの場合は400を返すべき', async () => {
        const res = await app.request('/criteria/criteria-1', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ weight: 'invalid' }),
        });

        expect(res.status).toBe(400);
      });
    });

    describe('DELETE /criteria/:id', () => {
      it('評価基準を削除できるべき', async () => {
        vi.mocked(scoringService.deleteEvaluationCriteria).mockResolvedValue(
          undefined
        );

        const res = await app.request('/criteria/criteria-1', {
          method: 'DELETE',
        });

        expect(res.status).toBe(204);
      });
    });
  });

  describe('採点セッション API', () => {
    describe('POST /sessions', () => {
      it('採点セッションを作成できるべき', async () => {
        const mockSession = {
          id: 'session-1',
          tenantId: 'tenant-456',
          participantId: 'participant-789',
          status: EvaluationStatus.PENDING,
        };

        vi.mocked(scoringService.createScoringSession).mockResolvedValue(
          mockSession as never
        );

        const res = await app.request('/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            participantId: 'participant-789',
            battleId: 'battle-123',
          }),
        });

        expect(res.status).toBe(201);
        const body = await res.json();
        expect(body.id).toBe('session-1');
      });

      it('参加者IDがない場合は400を返すべき', async () => {
        const res = await app.request('/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });

        expect(res.status).toBe(400);
      });

      it('参加者IDが空の場合は400を返すべき', async () => {
        const res = await app.request('/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ participantId: '' }),
        });

        expect(res.status).toBe(400);
      });
    });

    describe('GET /sessions', () => {
      it('採点セッション一覧を取得できるべき', async () => {
        const mockResult = {
          data: [{ id: 'session-1', status: EvaluationStatus.PENDING }],
          total: 1,
          page: 1,
          limit: 10,
        };

        vi.mocked(scoringService.listScoringSessions).mockResolvedValue(
          mockResult as never
        );

        const res = await app.request('/sessions?page=1&limit=10');

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.data).toHaveLength(1);
      });
    });

    describe('GET /sessions/:id', () => {
      it('採点セッションを取得できるべき', async () => {
        const mockSession = {
          id: 'session-1',
          tenantId: 'tenant-456',
          status: EvaluationStatus.COMPLETED,
        };

        vi.mocked(scoringService.getScoringSession).mockResolvedValue(
          mockSession as never
        );

        const res = await app.request('/sessions/session-1');

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.id).toBe('session-1');
      });

      it('存在しないセッションは404を返すべき', async () => {
        vi.mocked(scoringService.getScoringSession).mockResolvedValue(null);

        const res = await app.request('/sessions/nonexistent');

        expect(res.status).toBe(404);
      });
    });

    describe('POST /sessions/:id/submit', () => {
      it('Terraform Stateを提出できるべき', async () => {
        const mockSession = {
          id: 'session-1',
          status: EvaluationStatus.IN_PROGRESS,
        };

        vi.mocked(scoringService.submitForEvaluation).mockResolvedValue(
          mockSession as never
        );

        const res = await app.request('/sessions/session-1/submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            terraformState: { version: 4, resources: [] },
          }),
        });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.status).toBe(EvaluationStatus.IN_PROGRESS);
      });

      it('terraformStateがない場合は400を返すべき', async () => {
        const res = await app.request('/sessions/session-1/submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });

        expect(res.status).toBe(400);
      });

      it('terraformState.versionがない場合は400を返すべき', async () => {
        const res = await app.request('/sessions/session-1/submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ terraformState: {} }),
        });

        expect(res.status).toBe(400);
      });

      it('存在しないセッションへの提出は404を返すべき', async () => {
        vi.mocked(scoringService.submitForEvaluation).mockResolvedValue(null);

        const res = await app.request('/sessions/nonexistent/submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            terraformState: { version: 4, resources: [] },
          }),
        });

        expect(res.status).toBe(404);
      });

      it('提出条件を満たさない場合は400を返すべき', async () => {
        vi.mocked(scoringService.submitForEvaluation).mockRejectedValue(
          new Error('評価待ちのセッションのみ提出できます')
        );

        const res = await app.request('/sessions/session-1/submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            terraformState: { version: 4, resources: [] },
          }),
        });

        expect(res.status).toBe(400);
      });
    });

    describe('POST /sessions/:id/evaluate', () => {
      it('採点を実行できるべき', async () => {
        const mockSession = {
          id: 'session-1',
          status: EvaluationStatus.COMPLETED,
          totalScore: 85,
        };

        vi.mocked(scoringService.evaluateSubmission).mockResolvedValue(
          mockSession as never
        );

        const res = await app.request('/sessions/session-1/evaluate', {
          method: 'POST',
        });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.totalScore).toBe(85);
      });

      it('評価条件を満たさない場合は400を返すべき', async () => {
        vi.mocked(scoringService.evaluateSubmission).mockRejectedValue(
          new Error('評価中のセッションのみ採点できます')
        );

        const res = await app.request('/sessions/session-1/evaluate', {
          method: 'POST',
        });

        expect(res.status).toBe(400);
      });

      it('存在しないセッションの評価は404を返すべき', async () => {
        vi.mocked(scoringService.evaluateSubmission).mockResolvedValue(null);

        const res = await app.request('/sessions/nonexistent/evaluate', {
          method: 'POST',
        });

        expect(res.status).toBe(404);
      });

      it('Error以外の例外は再スローするべき', async () => {
        vi.mocked(scoringService.evaluateSubmission).mockRejectedValue(
          'string error'
        );

        await expect(
          app.request('/sessions/session-1/evaluate', { method: 'POST' })
        ).rejects.toBe('string error');
      });
    });

    describe('POST /sessions/:id/submit', () => {
      it('Error以外の例外は再スローするべき', async () => {
        vi.mocked(scoringService.submitForEvaluation).mockRejectedValue(
          'string error'
        );

        await expect(
          app.request('/sessions/session-1/submit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              terraformState: { version: 4, resources: [] },
            }),
          })
        ).rejects.toBe('string error');
      });
    });

    describe('GET /sessions/:id/feedback', () => {
      it('フィードバックを取得できるべき', async () => {
        const mockFeedbacks = [
          {
            id: 'fb-1',
            category: EvaluationCategory.SECURITY,
            severity: Severity.HIGH,
            title: 'セキュリティグループが開放',
          },
        ];

        vi.mocked(scoringService.getSessionFeedback).mockResolvedValue(
          mockFeedbacks as never
        );

        const res = await app.request('/sessions/session-1/feedback');

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toHaveLength(1);
        expect(body[0].severity).toBe(Severity.HIGH);
      });

      it('存在しないセッションのフィードバックは404を返すべき', async () => {
        vi.mocked(scoringService.getSessionFeedback).mockResolvedValue(null);

        const res = await app.request('/sessions/nonexistent/feedback');

        expect(res.status).toBe(404);
      });
    });
  });
});
