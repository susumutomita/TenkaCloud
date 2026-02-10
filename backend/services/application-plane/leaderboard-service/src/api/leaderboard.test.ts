import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { leaderboardRoutes } from './leaderboard';
import * as leaderboardService from '../services/leaderboard';

vi.mock('../lib/dynamodb', () => ({
  battleRepository: {},
}));

vi.mock('../services/leaderboard', () => ({
  getLeaderboard: vi.fn(),
}));

function createApp() {
  const app = new Hono();
  // 認証ミドルウェアをスキップしてテスト用のauthをセット
  app.use('/*', async (c, next) => {
    c.set('auth', {
      userId: 'user-123',
      tenantId: 'tenant-456',
      roles: ['user'],
    });
    await next();
  });
  app.route('/', leaderboardRoutes);
  return app;
}

describe('リーダーボード API', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp();
  });

  describe('GET /api/leaderboards/:battleId', () => {
    it('リーダーボードを正常に取得するべき', async () => {
      const mockResult = {
        battleId: 'battle-1',
        battleTitle: 'テストバトル',
        status: 'RUNNING',
        frozen: false,
        entries: [
          { rank: 1, userId: 'user-1', score: 200, updatedAt: new Date() },
          { rank: 2, userId: 'user-2', score: 100, updatedAt: new Date() },
        ],
        updatedAt: new Date(),
      };

      vi.mocked(leaderboardService.getLeaderboard).mockResolvedValue(
        mockResult
      );

      const res = await app.request('/api/leaderboards/battle-1');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.battleId).toBe('battle-1');
      expect(body.entries).toHaveLength(2);
    });

    it('バトルが見つからない場合は404を返すべき', async () => {
      vi.mocked(leaderboardService.getLeaderboard).mockResolvedValue(null);

      const res = await app.request('/api/leaderboards/nonexistent');

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('バトルが見つかりません');
    });

    it('freezeMinutesクエリパラメータを渡すべき', async () => {
      const mockResult = {
        battleId: 'battle-1',
        battleTitle: 'テストバトル',
        status: 'RUNNING',
        frozen: true,
        entries: [],
        updatedAt: new Date(),
      };

      vi.mocked(leaderboardService.getLeaderboard).mockResolvedValue(
        mockResult
      );

      const res = await app.request(
        '/api/leaderboards/battle-1?freezeMinutes=15'
      );

      expect(res.status).toBe(200);
      expect(leaderboardService.getLeaderboard).toHaveBeenCalledWith(
        'battle-1',
        'tenant-456',
        expect.anything(),
        15
      );
    });

    it('freezeMinutesが無効な場合はundefinedを渡すべき', async () => {
      const mockResult = {
        battleId: 'battle-1',
        battleTitle: 'テストバトル',
        status: 'RUNNING',
        frozen: false,
        entries: [],
        updatedAt: new Date(),
      };

      vi.mocked(leaderboardService.getLeaderboard).mockResolvedValue(
        mockResult
      );

      const res = await app.request(
        '/api/leaderboards/battle-1?freezeMinutes=abc'
      );

      expect(res.status).toBe(200);
      expect(leaderboardService.getLeaderboard).toHaveBeenCalledWith(
        'battle-1',
        'tenant-456',
        expect.anything(),
        undefined
      );
    });

    it('サービスエラーの場合は500を返すべき', async () => {
      vi.mocked(leaderboardService.getLeaderboard).mockRejectedValue(
        new Error('DB接続エラー')
      );

      const res = await app.request('/api/leaderboards/battle-1');

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe('DB接続エラー');
    });

    it('Error以外のthrowの場合は500を返すべき', async () => {
      vi.mocked(leaderboardService.getLeaderboard).mockRejectedValue(
        'unexpected'
      );

      const res = await app.request('/api/leaderboards/battle-1');

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe('リーダーボードの取得に失敗しました');
    });
  });

  describe('GET /api/leaderboards/:battleId/stream', () => {
    it('SSEストリームでリーダーボードを配信するべき', async () => {
      const mockResult = {
        battleId: 'battle-1',
        battleTitle: 'テストバトル',
        status: 'FINISHED',
        frozen: false,
        entries: [
          { rank: 1, userId: 'user-1', score: 200, updatedAt: new Date() },
        ],
        updatedAt: new Date(),
      };

      vi.mocked(leaderboardService.getLeaderboard).mockResolvedValue(
        mockResult
      );

      const res = await app.request('/api/leaderboards/battle-1/stream');

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');

      const text = await res.text();
      expect(text).toContain('event: leaderboard');
      expect(text).toContain('"battleId":"battle-1"');
    });

    it('バトルが見つからない場合はerrorイベントを送信するべき', async () => {
      vi.mocked(leaderboardService.getLeaderboard).mockResolvedValue(null);

      const res = await app.request('/api/leaderboards/battle-1/stream');

      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('event: error');
      expect(text).toContain('バトルが見つかりません');
    });

    it('FINISHEDバトルでは1回送信後に終了するべき', async () => {
      const mockResult = {
        battleId: 'battle-1',
        battleTitle: 'テストバトル',
        status: 'FINISHED',
        frozen: false,
        entries: [],
        updatedAt: new Date(),
      };

      vi.mocked(leaderboardService.getLeaderboard).mockResolvedValue(
        mockResult
      );

      const res = await app.request('/api/leaderboards/battle-1/stream');

      const text = await res.text();
      const eventCount = (text.match(/event: leaderboard/g) ?? []).length;
      expect(eventCount).toBe(1);
    });

    it('ARCHIVEDバトルでは1回送信後に終了するべき', async () => {
      const mockResult = {
        battleId: 'battle-1',
        battleTitle: 'テストバトル',
        status: 'ARCHIVED',
        frozen: false,
        entries: [],
        updatedAt: new Date(),
      };

      vi.mocked(leaderboardService.getLeaderboard).mockResolvedValue(
        mockResult
      );

      const res = await app.request('/api/leaderboards/battle-1/stream');

      const text = await res.text();
      const eventCount = (text.match(/event: leaderboard/g) ?? []).length;
      expect(eventCount).toBe(1);
    });

    it('RUNNINGバトルはポーリング後に終了ステータスで停止するべき', async () => {
      const runningResult = {
        battleId: 'battle-1',
        battleTitle: 'テストバトル',
        status: 'RUNNING',
        frozen: false,
        entries: [],
        updatedAt: new Date(),
      };
      const finishedResult = {
        ...runningResult,
        status: 'FINISHED',
      };

      vi.mocked(leaderboardService.getLeaderboard)
        .mockResolvedValueOnce(runningResult)
        .mockResolvedValueOnce(finishedResult);

      const res = await app.request('/api/leaderboards/battle-1/stream');

      const text = await res.text();
      const eventCount = (text.match(/event: leaderboard/g) ?? []).length;
      expect(eventCount).toBe(2);
      expect(text).toContain('"status":"RUNNING"');
      expect(text).toContain('"status":"FINISHED"');
    }, 10000);
  });
});
