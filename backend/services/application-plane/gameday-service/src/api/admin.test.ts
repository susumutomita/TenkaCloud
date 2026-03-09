import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const mockGameController = vi.hoisted(() => {
  class GameNotFoundError extends Error {
    constructor() {
      super('ゲームが見つかりません');
      this.name = 'GameNotFoundError';
    }
  }
  class ConcurrentModificationError extends Error {
    constructor() {
      super('同時変更が検出されました。もう一度お試しください');
      this.name = 'ConcurrentModificationError';
    }
  }
  return {
    startGame: vi.fn(),
    stopGame: vi.fn(),
    getGameStatus: vi.fn(),
    toggleScoreWeight: vi.fn(),
    toggleBlackout: vi.fn(),
    executeFaultInjection: vi.fn(),
    listTeams: vi.fn(),
    listAttackLogs: vi.fn(),
    GameNotFoundError,
    ConcurrentModificationError,
  };
});

vi.mock('../services/game-controller', () => mockGameController);

import { adminRoutes } from './admin';

const mockAuth = {
  userId: 'admin-1',
  tenantId: 'tenant-1',
  roles: ['admin'],
};

describe('管理者 API', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.use('/*', async (c, next) => {
      c.set('auth' as never, mockAuth);
      await next();
    });
    app.route('/', adminRoutes);
  });

  describe('POST /game/start', () => {
    it('ゲームを開始できるべき', async () => {
      const gameState = {
        eventId: 'event-1',
        tenantId: 'tenant-1',
        isRunning: true,
        startedAt: '2026-03-09T00:00:00.000Z',
        scoreWeight: 'normal',
        blackout: false,
        durationMinutes: 240,
      };
      mockGameController.startGame.mockResolvedValue(gameState);

      const res = await app.request('/game/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId: 'event-1', durationMinutes: 240 }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.eventId).toBe('event-1');
      expect(body.isRunning).toBe(true);
      expect(mockGameController.startGame).toHaveBeenCalledWith(
        'event-1',
        'tenant-1',
        240
      );
    });

    it('eventId が空の場合 400 を返すべき', async () => {
      const res = await app.request('/game/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId: '' }),
      });
      expect(res.status).toBe(400);
    });

    it('不正な JSON の場合 400 を返すべき', async () => {
      const res = await app.request('/game/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'invalid-json',
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('JSON の解析に失敗しました');
    });
  });

  describe('POST /game/stop', () => {
    it('ゲームを停止できるべき', async () => {
      const gameState = {
        eventId: 'event-1',
        tenantId: 'tenant-1',
        isRunning: false,
        startedAt: '2026-03-09T00:00:00.000Z',
        scoreWeight: 'normal',
        blackout: false,
        durationMinutes: 240,
      };
      mockGameController.stopGame.mockResolvedValue(gameState);

      const res = await app.request('/game/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId: 'event-1' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.isRunning).toBe(false);
    });

    it('ゲームが見つからない場合 404 を返すべき', async () => {
      mockGameController.stopGame.mockRejectedValue(
        new mockGameController.GameNotFoundError()
      );

      const res = await app.request('/game/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId: 'nonexistent' }),
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('ゲームが見つかりません');
    });

    it('予期しないエラーの場合 500 を返すべき', async () => {
      mockGameController.stopGame.mockRejectedValue(new Error('DB接続エラー'));

      const res = await app.request('/game/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId: 'event-1' }),
      });

      expect(res.status).toBe(500);
    });

    it('eventId が空の場合 400 を返すべき', async () => {
      const res = await app.request('/game/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId: '' }),
      });
      expect(res.status).toBe(400);
    });

    it('不正な JSON の場合 400 を返すべき', async () => {
      const res = await app.request('/game/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'invalid-json',
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('JSON の解析に失敗しました');
    });
  });

  describe('GET /game/status', () => {
    it('ゲーム状態を取得できるべき', async () => {
      const gameState = {
        eventId: 'event-1',
        tenantId: 'tenant-1',
        isRunning: true,
        startedAt: '2026-03-09T00:00:00.000Z',
        scoreWeight: 'normal',
        blackout: false,
        durationMinutes: 240,
      };
      mockGameController.getGameStatus.mockResolvedValue(gameState);

      const res = await app.request('/game/status?eventId=event-1');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.eventId).toBe('event-1');
    });

    it('ゲームが見つからない場合 404 を返すべき', async () => {
      mockGameController.getGameStatus.mockResolvedValue(null);

      const res = await app.request('/game/status?eventId=nonexistent');

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('ゲームが見つかりません');
    });

    it('eventId がない場合 400 を返すべき', async () => {
      const res = await app.request('/game/status');
      expect(res.status).toBe(400);
    });
  });

  describe('POST /score-weight/toggle', () => {
    it('スコア重みを切替できるべき', async () => {
      const gameState = {
        eventId: 'event-1',
        tenantId: 'tenant-1',
        isRunning: true,
        startedAt: '2026-03-09T00:00:00.000Z',
        scoreWeight: 'high',
        blackout: false,
        durationMinutes: 240,
      };
      mockGameController.toggleScoreWeight.mockResolvedValue(gameState);

      const res = await app.request('/score-weight/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId: 'event-1' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.scoreWeight).toBe('high');
    });

    it('ゲームが見つからない場合 404 を返すべき', async () => {
      mockGameController.toggleScoreWeight.mockRejectedValue(
        new mockGameController.GameNotFoundError()
      );

      const res = await app.request('/score-weight/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId: 'nonexistent' }),
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('ゲームが見つかりません');
    });

    it('同時変更の場合 409 を返すべき', async () => {
      mockGameController.toggleScoreWeight.mockRejectedValue(
        new mockGameController.ConcurrentModificationError()
      );

      const res = await app.request('/score-weight/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId: 'event-1' }),
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toBe(
        '同時変更が検出されました。もう一度お試しください'
      );
    });

    it('予期しないエラーの場合 500 を返すべき', async () => {
      mockGameController.toggleScoreWeight.mockRejectedValue(
        new Error('DB接続エラー')
      );

      const res = await app.request('/score-weight/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId: 'event-1' }),
      });

      expect(res.status).toBe(500);
    });

    it('eventId が空の場合 400 を返すべき', async () => {
      const res = await app.request('/score-weight/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId: '' }),
      });
      expect(res.status).toBe(400);
    });

    it('不正な JSON の場合 400 を返すべき', async () => {
      const res = await app.request('/score-weight/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'invalid-json',
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('JSON の解析に失敗しました');
    });
  });

  describe('POST /blackout/toggle', () => {
    it('ブラックアウトを切替できるべき', async () => {
      const gameState = {
        eventId: 'event-1',
        tenantId: 'tenant-1',
        isRunning: true,
        startedAt: '2026-03-09T00:00:00.000Z',
        scoreWeight: 'normal',
        blackout: true,
        durationMinutes: 240,
      };
      mockGameController.toggleBlackout.mockResolvedValue(gameState);

      const res = await app.request('/blackout/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId: 'event-1' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.blackout).toBe(true);
    });

    it('ゲームが見つからない場合 404 を返すべき', async () => {
      mockGameController.toggleBlackout.mockRejectedValue(
        new mockGameController.GameNotFoundError()
      );

      const res = await app.request('/blackout/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId: 'nonexistent' }),
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('ゲームが見つかりません');
    });

    it('同時変更の場合 409 を返すべき', async () => {
      mockGameController.toggleBlackout.mockRejectedValue(
        new mockGameController.ConcurrentModificationError()
      );

      const res = await app.request('/blackout/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId: 'event-1' }),
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toBe(
        '同時変更が検出されました。もう一度お試しください'
      );
    });

    it('予期しないエラーの場合 500 を返すべき', async () => {
      mockGameController.toggleBlackout.mockRejectedValue(
        new Error('DB接続エラー')
      );

      const res = await app.request('/blackout/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId: 'event-1' }),
      });

      expect(res.status).toBe(500);
    });

    it('eventId が空の場合 400 を返すべき', async () => {
      const res = await app.request('/blackout/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId: '' }),
      });
      expect(res.status).toBe(400);
    });

    it('不正な JSON の場合 400 を返すべき', async () => {
      const res = await app.request('/blackout/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'invalid-json',
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('JSON の解析に失敗しました');
    });
  });

  describe('POST /fault-injection/execute', () => {
    it('障害注入を実行できるべき', async () => {
      const attackLog = {
        id: 'log-1',
        eventId: 'event-1',
        attackerTeamId: 'ADMIN',
        defenderTeamId: 'team-1',
        attackId: 'sql-injection',
        attackSlug: 'sql-injection',
        success: true,
        neutralized: false,
        damage: 0,
        reward: 0,
        details: '管理者による障害注入: sql-injection',
        createdAt: '2026-03-09T00:00:00.000Z',
      };
      mockGameController.executeFaultInjection.mockResolvedValue(attackLog);

      const res = await app.request('/fault-injection/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId: 'event-1',
          teamId: 'team-1',
          attackSlug: 'sql-injection',
        }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.attackerTeamId).toBe('ADMIN');
    });

    it('不正なリクエストで 400 を返すべき', async () => {
      const res = await app.request('/fault-injection/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId: 'event-1' }),
      });
      expect(res.status).toBe(400);
    });

    it('不正な JSON の場合 400 を返すべき', async () => {
      const res = await app.request('/fault-injection/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'invalid-json',
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('JSON の解析に失敗しました');
    });
  });

  describe('GET /teams', () => {
    it('チーム一覧を取得できるべき', async () => {
      const teams = [
        {
          eventId: 'event-1',
          teamId: 'team-1',
          teamName: 'チームA',
          score: 5000,
          isHealthy: true,
        },
      ];
      mockGameController.listTeams.mockResolvedValue(teams);

      const res = await app.request('/teams?eventId=event-1');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.teams).toHaveLength(1);
      expect(body.teams[0].teamName).toBe('チームA');
    });

    it('eventId がない場合 400 を返すべき', async () => {
      const res = await app.request('/teams');
      expect(res.status).toBe(400);
    });
  });

  describe('GET /attack-logs', () => {
    it('攻撃履歴を取得できるべき', async () => {
      const logs = [
        {
          id: 'log-1',
          eventId: 'event-1',
          attackerTeamId: 'team-1',
          defenderTeamId: 'team-2',
          attackId: 'atk-1',
          attackSlug: 'atk-1',
          success: true,
          neutralized: false,
          damage: 1000,
          reward: 1000,
          details: '',
          createdAt: '2026-03-09T00:00:00.000Z',
        },
      ];
      mockGameController.listAttackLogs.mockResolvedValue(logs);

      const res = await app.request('/attack-logs?eventId=event-1');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.logs).toHaveLength(1);
    });

    it('eventId がない場合 400 を返すべき', async () => {
      const res = await app.request('/attack-logs');
      expect(res.status).toBe(400);
    });
  });
});
