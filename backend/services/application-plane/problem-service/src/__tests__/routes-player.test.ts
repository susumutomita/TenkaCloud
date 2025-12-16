/**
 * Player Routes Tests
 *
 * 競技者画面APIの統合テスト
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';

// 依存関係をモック
vi.mock('../auth', () => ({
  authenticateRequest: vi.fn(),
  hasAnyRole: vi.fn(),
  canAccessTeam: vi.fn(),
  UserRole: {
    PLATFORM_ADMIN: 'platform-admin',
    TENANT_ADMIN: 'tenant-admin',
    ORGANIZER: 'organizer',
    COMPETITOR: 'competitor',
  },
}));

vi.mock('../jam/challenge', () => ({
  startChallenge: vi.fn().mockResolvedValue({ success: true }),
  getChallengesForTeam: vi.fn().mockResolvedValue({ challenges: [] }),
  getChallengeDetail: vi
    .fn()
    .mockResolvedValue({ id: 'challenge-1', title: 'Test Challenge' }),
}));

vi.mock('../jam/scoring', () => ({
  validateAnswer: vi
    .fn()
    .mockResolvedValue({ isCorrect: true, pointsEarned: 100 }),
  openClue: vi
    .fn()
    .mockResolvedValue({ clueContent: 'Test clue', penaltyPoints: 10 }),
}));

vi.mock('../jam/dashboard', () => ({
  getTeamDashboard: vi
    .fn()
    .mockResolvedValue({ team: { teamId: 'team-1' }, challenges: [] }),
  getLeaderboard: vi.fn().mockResolvedValue([]),
}));

import { authenticateRequest, hasAnyRole, canAccessTeam } from '../auth';
import { playerRouter } from '../routes/player';
import {
  startChallenge,
  getChallengesForTeam,
  getChallengeDetail,
} from '../jam/challenge';
import { validateAnswer, openClue } from '../jam/scoring';
import { getTeamDashboard, getLeaderboard } from '../jam/dashboard';

describe('Player Routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono().route('/api/player', playerRouter);
  });

  describe('認証ミドルウェア', () => {
    it('認証されていない場合は 401 を返すべき', async () => {
      vi.mocked(authenticateRequest).mockResolvedValue({
        isValid: false,
        user: null,
      });

      const res = await app.request('/api/player/events/event-1/leaderboard');
      expect(res.status).toBe(401);
    });

    it('競技者権限がない場合は 403 を返すべき', async () => {
      vi.mocked(authenticateRequest).mockResolvedValue({
        isValid: true,
        user: { id: 'user-1', roles: [] },
      });
      vi.mocked(hasAnyRole).mockReturnValue(false);

      const res = await app.request('/api/player/events/event-1/leaderboard');
      expect(res.status).toBe(403);
    });
  });

  describe('チームアクセス検証ミドルウェア', () => {
    it('チームへのアクセス権がない場合は 403 を返すべき', async () => {
      vi.mocked(authenticateRequest).mockResolvedValue({
        isValid: true,
        user: { id: 'user-1', roles: ['competitor'] },
      });
      vi.mocked(hasAnyRole).mockReturnValue(true);
      vi.mocked(canAccessTeam).mockReturnValue(false);

      const res = await app.request(
        '/api/player/events/event-1/teams/team-1/challenges'
      );
      expect(res.status).toBe(403);
    });
  });

  describe('GET /events/:eventId/teams/:teamId/challenges', () => {
    beforeEach(() => {
      vi.mocked(authenticateRequest).mockResolvedValue({
        isValid: true,
        user: { id: 'user-1', tenantId: 'tenant-1', roles: ['competitor'] },
      });
      vi.mocked(hasAnyRole).mockReturnValue(true);
      vi.mocked(canAccessTeam).mockReturnValue(true);
    });

    it('チャレンジ一覧を取得できるべき', async () => {
      vi.mocked(getChallengesForTeam).mockResolvedValue({
        challenges: [
          {
            challengeId: 'challenge-1',
            title: 'Challenge 1',
            category: 'security',
            started: true,
            completed: false,
          },
        ],
      });

      const res = await app.request(
        '/api/player/events/event-1/teams/team-1/challenges'
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.challenges).toHaveLength(1);
      expect(getChallengesForTeam).toHaveBeenCalledWith('event-1', 'team-1');
    });
  });

  describe('GET /events/:eventId/teams/:teamId/challenges/:challengeId', () => {
    beforeEach(() => {
      vi.mocked(authenticateRequest).mockResolvedValue({
        isValid: true,
        user: { id: 'user-1', tenantId: 'tenant-1', roles: ['competitor'] },
      });
      vi.mocked(hasAnyRole).mockReturnValue(true);
      vi.mocked(canAccessTeam).mockReturnValue(true);
    });

    it('チャレンジ詳細を取得できるべき', async () => {
      vi.mocked(getChallengeDetail).mockResolvedValue({
        id: 'challenge-1',
        title: 'Test Challenge',
        description: 'Test description',
        tasks: [{ taskId: 'task-1', title: 'Task 1' }],
      });

      const res = await app.request(
        '/api/player/events/event-1/teams/team-1/challenges/challenge-1'
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe('challenge-1');
      expect(getChallengeDetail).toHaveBeenCalledWith(
        'event-1',
        'team-1',
        'challenge-1'
      );
    });
  });

  describe('POST /events/:eventId/teams/:teamId/challenges/:challengeId/start', () => {
    beforeEach(() => {
      vi.mocked(authenticateRequest).mockResolvedValue({
        isValid: true,
        user: { id: 'user-1', tenantId: 'tenant-1', roles: ['competitor'] },
      });
      vi.mocked(hasAnyRole).mockReturnValue(true);
      vi.mocked(canAccessTeam).mockReturnValue(true);
    });

    it('チャレンジを開始できるべき', async () => {
      vi.mocked(startChallenge).mockResolvedValue({
        success: true,
        startedAt: new Date().toISOString(),
      });

      const res = await app.request(
        '/api/player/events/event-1/teams/team-1/challenges/challenge-1/start',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ taskId: 'task-1' }),
        }
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(startChallenge).toHaveBeenCalledWith(
        'event-1',
        'team-1',
        'challenge-1',
        'task-1'
      );
    });

    it('taskId がない場合は 400 を返すべき', async () => {
      const res = await app.request(
        '/api/player/events/event-1/teams/team-1/challenges/challenge-1/start',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        }
      );
      expect(res.status).toBe(400);
    });
  });

  describe('POST /events/:eventId/teams/:teamId/challenges/:challengeId/tasks/:taskId/validate', () => {
    beforeEach(() => {
      vi.mocked(authenticateRequest).mockResolvedValue({
        isValid: true,
        user: { id: 'user-1', tenantId: 'tenant-1', roles: ['competitor'] },
      });
      vi.mocked(hasAnyRole).mockReturnValue(true);
      vi.mocked(canAccessTeam).mockReturnValue(true);
    });

    it('回答を検証できるべき', async () => {
      vi.mocked(validateAnswer).mockResolvedValue({
        isCorrect: true,
        pointsEarned: 100,
        message: 'Correct!',
      });

      const res = await app.request(
        '/api/player/events/event-1/teams/team-1/challenges/challenge-1/tasks/task-1/validate',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ answer: 'correct answer' }),
        }
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.isCorrect).toBe(true);
      expect(body.pointsEarned).toBe(100);
      expect(validateAnswer).toHaveBeenCalledWith(
        'event-1',
        'team-1',
        'challenge-1',
        'task-1',
        'correct answer'
      );
    });

    it('不正解の場合もステータス 200 で結果を返すべき', async () => {
      vi.mocked(validateAnswer).mockResolvedValue({
        isCorrect: false,
        pointsEarned: 0,
        message: 'Incorrect!',
      });

      const res = await app.request(
        '/api/player/events/event-1/teams/team-1/challenges/challenge-1/tasks/task-1/validate',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ answer: 'wrong answer' }),
        }
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.isCorrect).toBe(false);
    });

    it('answer がない場合は 400 を返すべき', async () => {
      const res = await app.request(
        '/api/player/events/event-1/teams/team-1/challenges/challenge-1/tasks/task-1/validate',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        }
      );
      expect(res.status).toBe(400);
    });
  });

  describe('POST /events/:eventId/teams/:teamId/challenges/:challengeId/tasks/:taskId/clue', () => {
    beforeEach(() => {
      vi.mocked(authenticateRequest).mockResolvedValue({
        isValid: true,
        user: { id: 'user-1', tenantId: 'tenant-1', roles: ['competitor'] },
      });
      vi.mocked(hasAnyRole).mockReturnValue(true);
      vi.mocked(canAccessTeam).mockReturnValue(true);
    });

    it('クルーを開示できるべき', async () => {
      vi.mocked(openClue).mockResolvedValue({
        clueContent: 'This is the clue content',
        penaltyPoints: 10,
      });

      const res = await app.request(
        '/api/player/events/event-1/teams/team-1/challenges/challenge-1/tasks/task-1/clue',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clueOrder: 1 }),
        }
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.clueContent).toBe('This is the clue content');
      expect(body.penaltyPoints).toBe(10);
      expect(openClue).toHaveBeenCalledWith(
        'event-1',
        'team-1',
        'challenge-1',
        'task-1',
        1
      );
    });

    it('clueOrder が範囲外の場合は 400 を返すべき', async () => {
      const res = await app.request(
        '/api/player/events/event-1/teams/team-1/challenges/challenge-1/tasks/task-1/clue',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clueOrder: 4 }),
        }
      );
      expect(res.status).toBe(400);
    });

    it('clueOrder が 0 以下の場合は 400 を返すべき', async () => {
      const res = await app.request(
        '/api/player/events/event-1/teams/team-1/challenges/challenge-1/tasks/task-1/clue',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clueOrder: 0 }),
        }
      );
      expect(res.status).toBe(400);
    });
  });

  describe('GET /events/:eventId/teams/:teamId/dashboard', () => {
    beforeEach(() => {
      vi.mocked(authenticateRequest).mockResolvedValue({
        isValid: true,
        user: { id: 'user-1', tenantId: 'tenant-1', roles: ['competitor'] },
      });
      vi.mocked(hasAnyRole).mockReturnValue(true);
      vi.mocked(canAccessTeam).mockReturnValue(true);
    });

    it('チームダッシュボードを取得できるべき', async () => {
      vi.mocked(getTeamDashboard).mockResolvedValue({
        team: {
          teamId: 'team-1',
          teamName: 'Test Team',
          rank: 1,
          score: 500,
        },
        challenges: [
          {
            challengeId: 'challenge-1',
            title: 'Challenge 1',
            started: true,
            completed: true,
            score: 100,
          },
        ],
        recentActivity: [],
      });

      const res = await app.request(
        '/api/player/events/event-1/teams/team-1/dashboard'
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.team.teamId).toBe('team-1');
      expect(body.team.rank).toBe(1);
      expect(body.challenges).toHaveLength(1);
      expect(getTeamDashboard).toHaveBeenCalledWith('event-1', 'team-1');
    });
  });

  describe('GET /events/:eventId/leaderboard', () => {
    beforeEach(() => {
      vi.mocked(authenticateRequest).mockResolvedValue({
        isValid: true,
        user: { id: 'user-1', tenantId: 'tenant-1', roles: ['competitor'] },
      });
      vi.mocked(hasAnyRole).mockReturnValue(true);
    });

    it('リーダーボードを取得できるべき', async () => {
      vi.mocked(getLeaderboard).mockResolvedValue([
        {
          rank: 1,
          teamId: 'team-1',
          teamName: 'Team A',
          score: 500,
          completedChallenges: 5,
          totalChallenges: 10,
        },
        {
          rank: 2,
          teamId: 'team-2',
          teamName: 'Team B',
          score: 400,
          completedChallenges: 4,
          totalChallenges: 10,
        },
        {
          rank: 3,
          teamId: 'team-3',
          teamName: 'Team C',
          score: 300,
          completedChallenges: 3,
          totalChallenges: 10,
        },
      ]);

      const res = await app.request('/api/player/events/event-1/leaderboard');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.leaderboard).toHaveLength(3);
      expect(body.leaderboard[0].rank).toBe(1);
      expect(body.leaderboard[0].teamName).toBe('Team A');
      // teamId は公開リーダーボードには含まれない
      expect(body.leaderboard[0].teamId).toBeUndefined();
    });

    it('limit パラメータでリーダーボードを制限できるべき', async () => {
      vi.mocked(getLeaderboard).mockResolvedValue([
        {
          rank: 1,
          teamId: 'team-1',
          teamName: 'Team A',
          score: 500,
          completedChallenges: 5,
          totalChallenges: 10,
        },
      ]);

      const res = await app.request(
        '/api/player/events/event-1/leaderboard?limit=10'
      );
      expect(res.status).toBe(200);
      expect(getLeaderboard).toHaveBeenCalledWith('event-1', 10);
    });

    it('limit パラメータがない場合はデフォルト 50 を使用するべき', async () => {
      vi.mocked(getLeaderboard).mockResolvedValue([]);

      const res = await app.request('/api/player/events/event-1/leaderboard');
      expect(res.status).toBe(200);
      expect(getLeaderboard).toHaveBeenCalledWith('event-1', 50);
    });
  });
});
