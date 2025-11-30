/**
 * Admin Routes Tests
 *
 * 管理画面APIの統合テスト
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';

// vi.hoisted でモックを作成（ホイスティングされても参照可能）
const {
  mockEventRepository,
  mockProblemRepository,
  mockMarketplaceRepository,
} = vi.hoisted(() => ({
  mockEventRepository: {
    findByTenant: vi.fn().mockResolvedValue([]),
    findAll: vi.fn().mockResolvedValue([]),
    count: vi.fn().mockResolvedValue(0),
    create: vi.fn().mockResolvedValue({ id: 'event-1', name: 'Test Event' }),
    update: vi.fn().mockResolvedValue({ id: 'event-1', name: 'Updated Event' }),
    delete: vi.fn().mockResolvedValue(undefined),
    updateStatus: vi.fn().mockResolvedValue(undefined),
  },
  mockProblemRepository: {
    findAll: vi.fn().mockResolvedValue([]),
    findById: vi.fn().mockResolvedValue(null),
    count: vi.fn().mockResolvedValue(0),
  },
  mockMarketplaceRepository: {
    search: vi.fn().mockResolvedValue({ problems: [], total: 0 }),
    incrementDownloads: vi.fn().mockResolvedValue(undefined),
    findById: vi.fn().mockResolvedValue(null),
  },
}));

// 依存関係をモック
vi.mock('../auth', () => ({
  authenticateRequest: vi.fn(),
  hasRole: vi.fn(),
  UserRole: {
    PLATFORM_ADMIN: 'platform-admin',
    TENANT_ADMIN: 'tenant-admin',
    ORGANIZER: 'organizer',
    COMPETITOR: 'competitor',
  },
}));

vi.mock('../repositories', () => ({
  PrismaEventRepository: class {
    findByTenant = mockEventRepository.findByTenant;
    findAll = mockEventRepository.findAll;
    count = mockEventRepository.count;
    create = mockEventRepository.create;
    update = mockEventRepository.update;
    delete = mockEventRepository.delete;
    updateStatus = mockEventRepository.updateStatus;
  },
  PrismaProblemRepository: class {
    findAll = mockProblemRepository.findAll;
    findById = mockProblemRepository.findById;
    count = mockProblemRepository.count;
  },
  PrismaMarketplaceRepository: class {
    search = mockMarketplaceRepository.search;
    incrementDownloads = mockMarketplaceRepository.incrementDownloads;
    findById = mockMarketplaceRepository.findById;
  },
  getEventWithProblems: vi.fn().mockResolvedValue(null),
  addProblemToEvent: vi
    .fn()
    .mockResolvedValue({ eventId: 'event-1', problemId: 'problem-1' }),
  removeProblemFromEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../jam/contest', () => ({
  startContest: vi.fn().mockResolvedValue({ success: true }),
  stopContest: vi.fn().mockResolvedValue({ success: true }),
  pauseContest: vi.fn().mockResolvedValue({ success: true }),
  resumeContest: vi.fn().mockResolvedValue({ success: true }),
  addChallengeToContest: vi.fn().mockResolvedValue({ success: true }),
  removeChallengeFromContest: vi.fn().mockResolvedValue({ success: true }),
  registerTeamToContest: vi
    .fn()
    .mockResolvedValue({ success: true, teamId: 'team-1' }),
  getContestTeams: vi.fn().mockResolvedValue([]),
}));

vi.mock('../jam/dashboard', () => ({
  getEventDashboard: vi.fn().mockResolvedValue({ eventId: 'event-1' }),
  getChallengeStatistics: vi.fn().mockResolvedValue([]),
  getLeaderboard: vi.fn().mockResolvedValue([]),
  saveLeaderboardSnapshot: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../jam/eventlog', () => ({
  getEventLogs: vi.fn().mockResolvedValue({ logs: [], total: 0 }),
}));

import { authenticateRequest, hasRole } from '../auth';
import { adminRouter } from '../routes/admin';
import {
  getEventWithProblems,
  addProblemToEvent,
  removeProblemFromEvent,
} from '../repositories';
import {
  addChallengeToContest,
  removeChallengeFromContest,
  registerTeamToContest,
} from '../jam/contest';

describe('Admin Routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono().route('/api/admin', adminRouter);
  });

  describe('認証ミドルウェア', () => {
    it('認証されていない場合は 401 を返すべき', async () => {
      vi.mocked(authenticateRequest).mockResolvedValue({
        isValid: false,
        user: null,
      });

      const res = await app.request('/api/admin/events');
      expect(res.status).toBe(401);
    });

    it('管理者権限がない場合は 403 を返すべき', async () => {
      vi.mocked(authenticateRequest).mockResolvedValue({
        isValid: true,
        user: { id: 'user-1', roles: ['competitor'] },
      });
      vi.mocked(hasRole).mockReturnValue(false);

      const res = await app.request('/api/admin/events');
      expect(res.status).toBe(403);
    });
  });

  describe('GET /events', () => {
    beforeEach(() => {
      vi.mocked(authenticateRequest).mockResolvedValue({
        isValid: true,
        user: { id: 'user-1', tenantId: 'tenant-1', roles: ['platform-admin'] },
      });
      vi.mocked(hasRole).mockReturnValue(true);
    });

    it('イベント一覧を取得できるべき', async () => {
      const res = await app.request('/api/admin/events');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty('events');
      expect(body).toHaveProperty('total');
    });
  });

  describe('POST /events/:eventId/contest/start', () => {
    beforeEach(() => {
      vi.mocked(authenticateRequest).mockResolvedValue({
        isValid: true,
        user: { id: 'user-1', tenantId: 'tenant-1', roles: ['platform-admin'] },
      });
      vi.mocked(hasRole).mockReturnValue(true);
    });

    it('コンテストを開始できるべき', async () => {
      const res = await app.request('/api/admin/events/event-1/contest/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contestName: 'Test Contest' }),
      });
      expect(res.status).toBe(200);
    });
  });

  describe('POST /events/:eventId/contest/stop', () => {
    beforeEach(() => {
      vi.mocked(authenticateRequest).mockResolvedValue({
        isValid: true,
        user: { id: 'user-1', tenantId: 'tenant-1', roles: ['platform-admin'] },
      });
      vi.mocked(hasRole).mockReturnValue(true);
    });

    it('コンテストを停止できるべき', async () => {
      const res = await app.request('/api/admin/events/event-1/contest/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contestName: 'Test Contest' }),
      });
      expect(res.status).toBe(200);
    });
  });

  describe('POST /events/:eventId/contest/pause', () => {
    beforeEach(() => {
      vi.mocked(authenticateRequest).mockResolvedValue({
        isValid: true,
        user: { id: 'user-1', tenantId: 'tenant-1', roles: ['platform-admin'] },
      });
      vi.mocked(hasRole).mockReturnValue(true);
    });

    it('コンテストを一時停止できるべき', async () => {
      const res = await app.request('/api/admin/events/event-1/contest/pause', {
        method: 'POST',
      });
      expect(res.status).toBe(200);
    });
  });

  describe('POST /events/:eventId/contest/resume', () => {
    beforeEach(() => {
      vi.mocked(authenticateRequest).mockResolvedValue({
        isValid: true,
        user: { id: 'user-1', tenantId: 'tenant-1', roles: ['platform-admin'] },
      });
      vi.mocked(hasRole).mockReturnValue(true);
    });

    it('コンテストを再開できるべき', async () => {
      const res = await app.request(
        '/api/admin/events/event-1/contest/resume',
        {
          method: 'POST',
        }
      );
      expect(res.status).toBe(200);
    });
  });

  describe('GET /events/:eventId/teams', () => {
    beforeEach(() => {
      vi.mocked(authenticateRequest).mockResolvedValue({
        isValid: true,
        user: { id: 'user-1', tenantId: 'tenant-1', roles: ['platform-admin'] },
      });
      vi.mocked(hasRole).mockReturnValue(true);
    });

    it('チーム一覧を取得できるべき', async () => {
      const res = await app.request('/api/admin/events/event-1/teams');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty('teams');
    });
  });

  describe('POST /events/:eventId/teams', () => {
    beforeEach(() => {
      vi.mocked(authenticateRequest).mockResolvedValue({
        isValid: true,
        user: { id: 'user-1', tenantId: 'tenant-1', roles: ['platform-admin'] },
      });
      vi.mocked(hasRole).mockReturnValue(true);
    });

    it('チームを登録できるべき', async () => {
      const res = await app.request('/api/admin/events/event-1/teams', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teamName: 'Test Team' }),
      });
      expect(res.status).toBe(201);
    });
  });

  describe('GET /events/:eventId/dashboard', () => {
    beforeEach(() => {
      vi.mocked(authenticateRequest).mockResolvedValue({
        isValid: true,
        user: { id: 'user-1', tenantId: 'tenant-1', roles: ['platform-admin'] },
      });
      vi.mocked(hasRole).mockReturnValue(true);
    });

    it('イベントダッシュボードを取得できるべき', async () => {
      const res = await app.request('/api/admin/events/event-1/dashboard');
      expect(res.status).toBe(200);
    });
  });

  describe('GET /events/:eventId/leaderboard', () => {
    beforeEach(() => {
      vi.mocked(authenticateRequest).mockResolvedValue({
        isValid: true,
        user: { id: 'user-1', tenantId: 'tenant-1', roles: ['platform-admin'] },
      });
      vi.mocked(hasRole).mockReturnValue(true);
    });

    it('リーダーボードを取得できるべき', async () => {
      const res = await app.request('/api/admin/events/event-1/leaderboard');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty('leaderboard');
    });
  });

  describe('POST /events/:eventId/leaderboard/snapshot', () => {
    beforeEach(() => {
      vi.mocked(authenticateRequest).mockResolvedValue({
        isValid: true,
        user: { id: 'user-1', tenantId: 'tenant-1', roles: ['platform-admin'] },
      });
      vi.mocked(hasRole).mockReturnValue(true);
    });

    it('リーダーボードスナップショットを保存できるべき', async () => {
      const res = await app.request(
        '/api/admin/events/event-1/leaderboard/snapshot',
        {
          method: 'POST',
        }
      );
      expect(res.status).toBe(200);
    });
  });

  describe('GET /events/:eventId/challenges/stats', () => {
    beforeEach(() => {
      vi.mocked(authenticateRequest).mockResolvedValue({
        isValid: true,
        user: { id: 'user-1', tenantId: 'tenant-1', roles: ['platform-admin'] },
      });
      vi.mocked(hasRole).mockReturnValue(true);
    });

    it('チャレンジ統計を取得できるべき', async () => {
      const res = await app.request(
        '/api/admin/events/event-1/challenges/stats'
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty('stats');
    });
  });

  describe('GET /events/:eventId/logs', () => {
    beforeEach(() => {
      vi.mocked(authenticateRequest).mockResolvedValue({
        isValid: true,
        user: { id: 'user-1', tenantId: 'tenant-1', roles: ['platform-admin'] },
      });
      vi.mocked(hasRole).mockReturnValue(true);
    });

    it('イベントログを取得できるべき', async () => {
      const res = await app.request('/api/admin/events/event-1/logs');
      expect(res.status).toBe(200);
    });
  });

  describe('GET /problems', () => {
    beforeEach(() => {
      vi.mocked(authenticateRequest).mockResolvedValue({
        isValid: true,
        user: { id: 'user-1', tenantId: 'tenant-1', roles: ['platform-admin'] },
      });
      vi.mocked(hasRole).mockReturnValue(true);
    });

    it('問題一覧を取得できるべき', async () => {
      const res = await app.request('/api/admin/problems');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty('problems');
    });
  });

  describe('GET /marketplace', () => {
    beforeEach(() => {
      vi.mocked(authenticateRequest).mockResolvedValue({
        isValid: true,
        user: { id: 'user-1', tenantId: 'tenant-1', roles: ['platform-admin'] },
      });
      vi.mocked(hasRole).mockReturnValue(true);
    });

    it('マーケットプレイスを検索できるべき', async () => {
      const res = await app.request('/api/admin/marketplace');
      expect(res.status).toBe(200);
    });

    it('クエリパラメータでフィルタできるべき', async () => {
      const res = await app.request(
        '/api/admin/marketplace?type=jam&category=security&difficulty=medium&provider=aws&sortBy=rating&page=1&limit=10'
      );
      expect(res.status).toBe(200);
    });

    it('エラー発生時に 500 を返すべき', async () => {
      mockMarketplaceRepository.search.mockRejectedValueOnce(
        new Error('Database error')
      );
      const res = await app.request('/api/admin/marketplace');
      expect(res.status).toBe(500);
    });
  });

  describe('GET /events/:eventId', () => {
    beforeEach(() => {
      vi.mocked(authenticateRequest).mockResolvedValue({
        isValid: true,
        user: { id: 'user-1', tenantId: 'tenant-1', roles: ['platform-admin'] },
      });
      vi.mocked(hasRole).mockReturnValue(true);
    });

    it('イベントが見つからない場合は 404 を返すべき', async () => {
      vi.mocked(getEventWithProblems).mockResolvedValue(null);
      const res = await app.request('/api/admin/events/event-1');
      expect(res.status).toBe(404);
    });

    it('イベント詳細を取得できるべき', async () => {
      vi.mocked(getEventWithProblems).mockResolvedValue({
        id: 'event-1',
        externalId: 'ext-1',
        name: 'Test Event',
        type: 'JAM',
        status: 'DRAFT',
        tenantId: 'tenant-1',
        startTime: new Date('2025-01-01'),
        endTime: new Date('2025-01-02'),
        timezone: 'Asia/Tokyo',
        participantType: 'TEAM',
        maxParticipants: 100,
        minTeamSize: 2,
        maxTeamSize: 5,
        cloudProvider: 'AWS',
        regions: ['ap-northeast-1'],
        scoringType: 'REALTIME',
        scoringIntervalMinutes: 5,
        leaderboardVisible: true,
        freezeLeaderboardMinutes: 30,
        problems: [
          {
            problemId: 'problem-1',
            order: 1,
            unlockTime: new Date('2025-01-01'),
            pointMultiplier: 1.5,
            problem: { title: 'Test Problem' },
          },
        ],
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);

      const res = await app.request('/api/admin/events/event-1');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe('event-1');
      expect(body.problems).toHaveLength(1);
    });

    it('エラー発生時に 500 を返すべき', async () => {
      vi.mocked(getEventWithProblems).mockRejectedValueOnce(
        new Error('Database error')
      );
      const res = await app.request('/api/admin/events/event-1');
      expect(res.status).toBe(500);
    });
  });

  describe('POST /events', () => {
    beforeEach(() => {
      vi.mocked(authenticateRequest).mockResolvedValue({
        isValid: true,
        user: { id: 'user-1', tenantId: 'tenant-1', roles: ['platform-admin'] },
      });
      vi.mocked(hasRole).mockReturnValue(true);
    });

    it('イベントを作成できるべき', async () => {
      const res = await app.request('/api/admin/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'New Event',
          type: 'jam',
          startTime: '2025-01-01T00:00:00Z',
          endTime: '2025-01-02T00:00:00Z',
          timezone: 'Asia/Tokyo',
          participantType: 'team',
          maxParticipants: 100,
          cloudProvider: 'aws',
          regions: ['ap-northeast-1'],
          scoringType: 'realtime',
          scoringIntervalMinutes: 5,
          leaderboardVisible: true,
        }),
      });
      expect(res.status).toBe(201);
    });

    it('問題ID付きでイベントを作成できるべき', async () => {
      const res = await app.request('/api/admin/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'New Event',
          type: 'jam',
          startTime: '2025-01-01T00:00:00Z',
          endTime: '2025-01-02T00:00:00Z',
          participantType: 'team',
          maxParticipants: 100,
          cloudProvider: 'aws',
          regions: ['ap-northeast-1'],
          scoringType: 'realtime',
          scoringIntervalMinutes: 5,
          problemIds: ['problem-1', 'problem-2'],
        }),
      });
      expect(res.status).toBe(201);
      expect(vi.mocked(addProblemToEvent)).toHaveBeenCalledTimes(2);
    });

    it('エラー発生時に 500 を返すべき', async () => {
      mockEventRepository.create.mockRejectedValueOnce(
        new Error('Database error')
      );
      const res = await app.request('/api/admin/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'New Event',
          type: 'jam',
          startTime: '2025-01-01T00:00:00Z',
          endTime: '2025-01-02T00:00:00Z',
          participantType: 'team',
          maxParticipants: 100,
          cloudProvider: 'aws',
          regions: ['ap-northeast-1'],
          scoringType: 'realtime',
          scoringIntervalMinutes: 5,
        }),
      });
      expect(res.status).toBe(500);
    });
  });

  describe('PUT /events/:eventId', () => {
    beforeEach(() => {
      vi.mocked(authenticateRequest).mockResolvedValue({
        isValid: true,
        user: { id: 'user-1', tenantId: 'tenant-1', roles: ['platform-admin'] },
      });
      vi.mocked(hasRole).mockReturnValue(true);
    });

    it('イベントを更新できるべき', async () => {
      const res = await app.request('/api/admin/events/event-1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Updated Event',
          status: 'active',
          startTime: '2025-01-01T00:00:00Z',
          endTime: '2025-01-02T00:00:00Z',
          timezone: 'UTC',
          participantType: 'individual',
          maxParticipants: 50,
          minTeamSize: 1,
          maxTeamSize: 3,
          cloudProvider: 'gcp',
          regions: ['us-central1'],
          scoringType: 'batch',
          scoringIntervalMinutes: 10,
          leaderboardVisible: false,
          freezeLeaderboardMinutes: 15,
        }),
      });
      expect(res.status).toBe(200);
    });

    it('エラー発生時に 500 を返すべき', async () => {
      mockEventRepository.update.mockRejectedValueOnce(
        new Error('Database error')
      );
      const res = await app.request('/api/admin/events/event-1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated Event' }),
      });
      expect(res.status).toBe(500);
    });
  });

  describe('DELETE /events/:eventId', () => {
    beforeEach(() => {
      vi.mocked(authenticateRequest).mockResolvedValue({
        isValid: true,
        user: { id: 'user-1', tenantId: 'tenant-1', roles: ['platform-admin'] },
      });
      vi.mocked(hasRole).mockReturnValue(true);
    });

    it('イベントを削除できるべき', async () => {
      const res = await app.request('/api/admin/events/event-1', {
        method: 'DELETE',
      });
      expect(res.status).toBe(200);
    });

    it('エラー発生時に 500 を返すべき', async () => {
      mockEventRepository.delete.mockRejectedValueOnce(
        new Error('Database error')
      );
      const res = await app.request('/api/admin/events/event-1', {
        method: 'DELETE',
      });
      expect(res.status).toBe(500);
    });
  });

  describe('PATCH /events/:eventId/status', () => {
    beforeEach(() => {
      vi.mocked(authenticateRequest).mockResolvedValue({
        isValid: true,
        user: { id: 'user-1', tenantId: 'tenant-1', roles: ['platform-admin'] },
      });
      vi.mocked(hasRole).mockReturnValue(true);
    });

    it('イベントステータスを更新できるべき', async () => {
      const res = await app.request('/api/admin/events/event-1/status', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'active' }),
      });
      expect(res.status).toBe(200);
    });

    it('エラー発生時に 500 を返すべき', async () => {
      mockEventRepository.updateStatus.mockRejectedValueOnce(
        new Error('Database error')
      );
      const res = await app.request('/api/admin/events/event-1/status', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'active' }),
      });
      expect(res.status).toBe(500);
    });
  });

  describe('POST /events/:eventId/problems', () => {
    beforeEach(() => {
      vi.mocked(authenticateRequest).mockResolvedValue({
        isValid: true,
        user: { id: 'user-1', tenantId: 'tenant-1', roles: ['platform-admin'] },
      });
      vi.mocked(hasRole).mockReturnValue(true);
    });

    it('イベントに問題を追加できるべき', async () => {
      const res = await app.request('/api/admin/events/event-1/problems', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          problemId: 'problem-1',
          order: 1,
          unlockTime: '2025-01-01T00:00:00Z',
          pointMultiplier: 1.5,
        }),
      });
      expect(res.status).toBe(201);
    });

    it('エラー発生時に 500 を返すべき', async () => {
      vi.mocked(addProblemToEvent).mockRejectedValueOnce(
        new Error('Database error')
      );
      const res = await app.request('/api/admin/events/event-1/problems', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ problemId: 'problem-1' }),
      });
      expect(res.status).toBe(500);
    });
  });

  describe('DELETE /events/:eventId/problems/:problemId', () => {
    beforeEach(() => {
      vi.mocked(authenticateRequest).mockResolvedValue({
        isValid: true,
        user: { id: 'user-1', tenantId: 'tenant-1', roles: ['platform-admin'] },
      });
      vi.mocked(hasRole).mockReturnValue(true);
    });

    it('イベントから問題を削除できるべき', async () => {
      const res = await app.request(
        '/api/admin/events/event-1/problems/problem-1',
        {
          method: 'DELETE',
        }
      );
      expect(res.status).toBe(200);
    });

    it('エラー発生時に 500 を返すべき', async () => {
      vi.mocked(removeProblemFromEvent).mockRejectedValueOnce(
        new Error('Database error')
      );
      const res = await app.request(
        '/api/admin/events/event-1/problems/problem-1',
        {
          method: 'DELETE',
        }
      );
      expect(res.status).toBe(500);
    });
  });

  describe('GET /problems/:problemId', () => {
    beforeEach(() => {
      vi.mocked(authenticateRequest).mockResolvedValue({
        isValid: true,
        user: { id: 'user-1', tenantId: 'tenant-1', roles: ['platform-admin'] },
      });
      vi.mocked(hasRole).mockReturnValue(true);
    });

    it('問題が見つからない場合は 404 を返すべき', async () => {
      mockProblemRepository.findById.mockResolvedValue(null);
      const res = await app.request('/api/admin/problems/problem-1');
      expect(res.status).toBe(404);
    });

    it('問題詳細を取得できるべき', async () => {
      mockProblemRepository.findById.mockResolvedValue({
        id: 'problem-1',
        title: 'Test Problem',
      });
      const res = await app.request('/api/admin/problems/problem-1');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe('problem-1');
    });

    it('エラー発生時に 500 を返すべき', async () => {
      mockProblemRepository.findById.mockRejectedValueOnce(
        new Error('Database error')
      );
      const res = await app.request('/api/admin/problems/problem-1');
      expect(res.status).toBe(500);
    });
  });

  describe('POST /marketplace/:marketplaceId/install', () => {
    beforeEach(() => {
      vi.mocked(authenticateRequest).mockResolvedValue({
        isValid: true,
        user: { id: 'user-1', tenantId: 'tenant-1', roles: ['platform-admin'] },
      });
      vi.mocked(hasRole).mockReturnValue(true);
    });

    it('問題をインストールできるべき', async () => {
      mockMarketplaceRepository.findById.mockResolvedValue({
        id: 'marketplace-1',
      });
      const res = await app.request(
        '/api/admin/marketplace/marketplace-1/install',
        {
          method: 'POST',
        }
      );
      expect(res.status).toBe(200);
    });

    it('問題が見つからない場合は 404 を返すべき', async () => {
      mockMarketplaceRepository.findById.mockResolvedValue(null);
      const res = await app.request(
        '/api/admin/marketplace/marketplace-1/install',
        {
          method: 'POST',
        }
      );
      expect(res.status).toBe(404);
    });

    it('エラー発生時に 500 を返すべき', async () => {
      mockMarketplaceRepository.incrementDownloads.mockRejectedValueOnce(
        new Error('Database error')
      );
      const res = await app.request(
        '/api/admin/marketplace/marketplace-1/install',
        {
          method: 'POST',
        }
      );
      expect(res.status).toBe(500);
    });
  });

  describe('POST /events/:eventId/challenges', () => {
    beforeEach(() => {
      vi.mocked(authenticateRequest).mockResolvedValue({
        isValid: true,
        user: { id: 'user-1', tenantId: 'tenant-1', roles: ['platform-admin'] },
      });
      vi.mocked(hasRole).mockReturnValue(true);
    });

    it('チャレンジを追加できるべき', async () => {
      const res = await app.request('/api/admin/events/event-1/challenges', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          problemId: 'problem-1',
          challengeId: 'challenge-1',
          title: 'Test Challenge',
          category: 'security',
          difficulty: 'medium',
          description: 'Test description',
          tasks: [
            {
              titleId: 'task-1',
              title: 'Task 1',
              content: 'Task content',
              taskNumber: 1,
              answerKey: 'answer',
              scoring: { pointsPossible: 100 },
            },
          ],
        }),
      });
      expect(res.status).toBe(201);
    });

    it('失敗時に 400 を返すべき', async () => {
      vi.mocked(addChallengeToContest).mockResolvedValueOnce({
        success: false,
        error: 'Error',
      });
      const res = await app.request('/api/admin/events/event-1/challenges', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          problemId: 'problem-1',
          challengeId: 'challenge-1',
          title: 'Test Challenge',
          category: 'security',
          difficulty: 'medium',
          description: 'Test description',
          tasks: [
            {
              titleId: 'task-1',
              title: 'Task 1',
              content: 'Task content',
              taskNumber: 1,
              answerKey: 'answer',
              scoring: { pointsPossible: 100 },
            },
          ],
        }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe('DELETE /events/:eventId/challenges/:challengeId', () => {
    beforeEach(() => {
      vi.mocked(authenticateRequest).mockResolvedValue({
        isValid: true,
        user: { id: 'user-1', tenantId: 'tenant-1', roles: ['platform-admin'] },
      });
      vi.mocked(hasRole).mockReturnValue(true);
    });

    it('チャレンジを削除できるべき', async () => {
      const res = await app.request(
        '/api/admin/events/event-1/challenges/challenge-1',
        {
          method: 'DELETE',
        }
      );
      expect(res.status).toBe(200);
    });

    it('失敗時に 400 を返すべき', async () => {
      vi.mocked(removeChallengeFromContest).mockResolvedValueOnce({
        success: false,
        error: 'Error',
      });
      const res = await app.request(
        '/api/admin/events/event-1/challenges/challenge-1',
        {
          method: 'DELETE',
        }
      );
      expect(res.status).toBe(400);
    });
  });

  describe('GET /events エラーハンドリング', () => {
    beforeEach(() => {
      vi.mocked(authenticateRequest).mockResolvedValue({
        isValid: true,
        user: { id: 'user-1', tenantId: 'tenant-1', roles: ['platform-admin'] },
      });
      vi.mocked(hasRole).mockReturnValue(true);
    });

    it('エラー発生時に 500 を返すべき', async () => {
      mockEventRepository.findByTenant.mockRejectedValueOnce(
        new Error('Database error')
      );
      const res = await app.request('/api/admin/events');
      expect(res.status).toBe(500);
    });
  });

  describe('GET /problems エラーハンドリング', () => {
    beforeEach(() => {
      vi.mocked(authenticateRequest).mockResolvedValue({
        isValid: true,
        user: { id: 'user-1', tenantId: 'tenant-1', roles: ['platform-admin'] },
      });
      vi.mocked(hasRole).mockReturnValue(true);
    });

    it('エラー発生時に 500 を返すべき', async () => {
      mockProblemRepository.findAll.mockRejectedValueOnce(
        new Error('Database error')
      );
      const res = await app.request('/api/admin/problems');
      expect(res.status).toBe(500);
    });
  });

  describe('チーム登録', () => {
    beforeEach(() => {
      vi.mocked(authenticateRequest).mockResolvedValue({
        isValid: true,
        user: { id: 'user-1', tenantId: 'tenant-1', roles: ['platform-admin'] },
      });
      vi.mocked(hasRole).mockReturnValue(true);
    });

    it('チーム登録失敗時に 400 を返すべき', async () => {
      vi.mocked(registerTeamToContest).mockResolvedValueOnce({
        success: false,
        error: 'Error',
      });
      const res = await app.request('/api/admin/events/event-1/teams', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teamName: 'Test Team' }),
      });
      expect(res.status).toBe(400);
    });
  });
});
