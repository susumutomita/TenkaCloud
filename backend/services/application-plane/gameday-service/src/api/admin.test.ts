import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StatusCodes } from 'http-status-codes';
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
  class CrossTenantAccessError extends Error {
    constructor(requestTenantId: string, resourceTenantId: string) {
      super(
        `クロステナントアクセスが拒否されました: リクエストテナント=${requestTenantId}, リソーステナント=${resourceTenantId}`
      );
      this.name = 'CrossTenantAccessError';
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
    seedAttackCatalog: vi.fn(),
    GameNotFoundError,
    ConcurrentModificationError,
    CrossTenantAccessError,
  };
});

const mockDashboardService = vi.hoisted(() => {
  class TeamAlreadyExistsError extends Error {
    constructor(teamId: string) {
      super(`チームは既に登録済みです: ${teamId}`);
      this.name = 'TeamAlreadyExistsError';
    }
  }
  return {
    registerTeam: vi.fn(),
    TeamAlreadyExistsError,
  };
});

const mockAuditorService = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
  isRunning: vi.fn().mockReturnValue(false),
}));

vi.mock('../services/game-controller', () => mockGameController);
vi.mock('../services/dashboard-service', () => mockDashboardService);
vi.mock('../services/auditor-service', () => ({
  auditorService: mockAuditorService,
}));

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
    describe('有効なリクエストの場合', () => {
      it('CREATED を返しゲーム状態を含むべき', async () => {
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

        expect(res.status).toBe(StatusCodes.CREATED);
        const body = await res.json();
        expect(body.eventId).toBe('event-1');
        expect(body.isRunning).toBe(true);
        expect(mockGameController.startGame).toHaveBeenCalledWith(
          'event-1',
          'tenant-1',
          240
        );
      });
    });

    describe('eventId が空の場合', () => {
      it('BAD_REQUEST を返すべき', async () => {
        const res = await app.request('/game/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ eventId: '' }),
        });
        expect(res.status).toBe(StatusCodes.BAD_REQUEST);
      });
    });

    describe('不正な JSON の場合', () => {
      it('BAD_REQUEST を返しエラーメッセージを含むべき', async () => {
        const res = await app.request('/game/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: 'invalid-json',
        });
        expect(res.status).toBe(StatusCodes.BAD_REQUEST);
        const body = await res.json();
        expect(body.error).toBe('JSON の解析に失敗しました');
      });
    });
  });

  describe('POST /game/stop', () => {
    describe('有効なリクエストの場合', () => {
      it('OK を返しゲーム停止状態を含むべき', async () => {
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

        expect(res.status).toBe(StatusCodes.OK);
        const body = await res.json();
        expect(body.isRunning).toBe(false);
      });
    });

    describe('ゲームが存在しない場合', () => {
      it('NOT_FOUND を返すべき', async () => {
        mockGameController.stopGame.mockRejectedValue(
          new mockGameController.GameNotFoundError()
        );

        const res = await app.request('/game/stop', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ eventId: 'nonexistent' }),
        });

        expect(res.status).toBe(StatusCodes.NOT_FOUND);
        const body = await res.json();
        expect(body.error).toBe('ゲームが見つかりません');
      });
    });

    describe('予期しないエラーが発生した場合', () => {
      it('INTERNAL_SERVER_ERROR を返すべき', async () => {
        mockGameController.stopGame.mockRejectedValue(
          new Error('DB接続エラー')
        );

        const res = await app.request('/game/stop', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ eventId: 'event-1' }),
        });

        expect(res.status).toBe(StatusCodes.INTERNAL_SERVER_ERROR);
      });
    });

    describe('eventId が空の場合', () => {
      it('BAD_REQUEST を返すべき', async () => {
        const res = await app.request('/game/stop', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ eventId: '' }),
        });
        expect(res.status).toBe(StatusCodes.BAD_REQUEST);
      });
    });

    describe('不正な JSON の場合', () => {
      it('BAD_REQUEST を返しエラーメッセージを含むべき', async () => {
        const res = await app.request('/game/stop', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: 'invalid-json',
        });
        expect(res.status).toBe(StatusCodes.BAD_REQUEST);
        const body = await res.json();
        expect(body.error).toBe('JSON の解析に失敗しました');
      });
    });
  });

  describe('GET /game/status', () => {
    describe('ゲームが存在する場合', () => {
      it('OK を返しゲーム状態を含むべき', async () => {
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

        expect(res.status).toBe(StatusCodes.OK);
        const body = await res.json();
        expect(body.eventId).toBe('event-1');
      });
    });

    describe('ゲームが存在しない場合', () => {
      it('NOT_FOUND を返すべき', async () => {
        mockGameController.getGameStatus.mockResolvedValue(null);

        const res = await app.request('/game/status?eventId=nonexistent');

        expect(res.status).toBe(StatusCodes.NOT_FOUND);
        const body = await res.json();
        expect(body.error).toBe('ゲームが見つかりません');
      });
    });

    describe('eventId が未指定の場合', () => {
      it('BAD_REQUEST を返すべき', async () => {
        const res = await app.request('/game/status');
        expect(res.status).toBe(StatusCodes.BAD_REQUEST);
      });
    });
  });

  describe('POST /score-weight/toggle', () => {
    describe('有効なリクエストの場合', () => {
      it('OK を返し切替後のスコア重みを含むべき', async () => {
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

        expect(res.status).toBe(StatusCodes.OK);
        const body = await res.json();
        expect(body.scoreWeight).toBe('high');
      });
    });

    describe('ゲームが存在しない場合', () => {
      it('NOT_FOUND を返すべき', async () => {
        mockGameController.toggleScoreWeight.mockRejectedValue(
          new mockGameController.GameNotFoundError()
        );

        const res = await app.request('/score-weight/toggle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ eventId: 'nonexistent' }),
        });

        expect(res.status).toBe(StatusCodes.NOT_FOUND);
        const body = await res.json();
        expect(body.error).toBe('ゲームが見つかりません');
      });
    });

    describe('同時変更が発生した場合', () => {
      it('CONFLICT を返すべき', async () => {
        mockGameController.toggleScoreWeight.mockRejectedValue(
          new mockGameController.ConcurrentModificationError()
        );

        const res = await app.request('/score-weight/toggle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ eventId: 'event-1' }),
        });

        expect(res.status).toBe(StatusCodes.CONFLICT);
        const body = await res.json();
        expect(body.error).toBe(
          '同時変更が検出されました。もう一度お試しください'
        );
      });
    });

    describe('予期しないエラーが発生した場合', () => {
      it('INTERNAL_SERVER_ERROR を返すべき', async () => {
        mockGameController.toggleScoreWeight.mockRejectedValue(
          new Error('DB接続エラー')
        );

        const res = await app.request('/score-weight/toggle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ eventId: 'event-1' }),
        });

        expect(res.status).toBe(StatusCodes.INTERNAL_SERVER_ERROR);
      });
    });

    describe('eventId が空の場合', () => {
      it('BAD_REQUEST を返すべき', async () => {
        const res = await app.request('/score-weight/toggle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ eventId: '' }),
        });
        expect(res.status).toBe(StatusCodes.BAD_REQUEST);
      });
    });

    describe('不正な JSON の場合', () => {
      it('BAD_REQUEST を返しエラーメッセージを含むべき', async () => {
        const res = await app.request('/score-weight/toggle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: 'invalid-json',
        });
        expect(res.status).toBe(StatusCodes.BAD_REQUEST);
        const body = await res.json();
        expect(body.error).toBe('JSON の解析に失敗しました');
      });
    });
  });

  describe('POST /blackout/toggle', () => {
    describe('有効なリクエストの場合', () => {
      it('OK を返し切替後のブラックアウト状態を含むべき', async () => {
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

        expect(res.status).toBe(StatusCodes.OK);
        const body = await res.json();
        expect(body.blackout).toBe(true);
      });
    });

    describe('ゲームが存在しない場合', () => {
      it('NOT_FOUND を返すべき', async () => {
        mockGameController.toggleBlackout.mockRejectedValue(
          new mockGameController.GameNotFoundError()
        );

        const res = await app.request('/blackout/toggle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ eventId: 'nonexistent' }),
        });

        expect(res.status).toBe(StatusCodes.NOT_FOUND);
        const body = await res.json();
        expect(body.error).toBe('ゲームが見つかりません');
      });
    });

    describe('同時変更が発生した場合', () => {
      it('CONFLICT を返すべき', async () => {
        mockGameController.toggleBlackout.mockRejectedValue(
          new mockGameController.ConcurrentModificationError()
        );

        const res = await app.request('/blackout/toggle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ eventId: 'event-1' }),
        });

        expect(res.status).toBe(StatusCodes.CONFLICT);
        const body = await res.json();
        expect(body.error).toBe(
          '同時変更が検出されました。もう一度お試しください'
        );
      });
    });

    describe('予期しないエラーが発生した場合', () => {
      it('INTERNAL_SERVER_ERROR を返すべき', async () => {
        mockGameController.toggleBlackout.mockRejectedValue(
          new Error('DB接続エラー')
        );

        const res = await app.request('/blackout/toggle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ eventId: 'event-1' }),
        });

        expect(res.status).toBe(StatusCodes.INTERNAL_SERVER_ERROR);
      });
    });

    describe('eventId が空の場合', () => {
      it('BAD_REQUEST を返すべき', async () => {
        const res = await app.request('/blackout/toggle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ eventId: '' }),
        });
        expect(res.status).toBe(StatusCodes.BAD_REQUEST);
      });
    });

    describe('不正な JSON の場合', () => {
      it('BAD_REQUEST を返しエラーメッセージを含むべき', async () => {
        const res = await app.request('/blackout/toggle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: 'invalid-json',
        });
        expect(res.status).toBe(StatusCodes.BAD_REQUEST);
        const body = await res.json();
        expect(body.error).toBe('JSON の解析に失敗しました');
      });
    });
  });

  describe('POST /fault-injection/execute', () => {
    describe('有効なリクエストの場合', () => {
      it('CREATED を返し攻撃ログを含むべき', async () => {
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

        expect(res.status).toBe(StatusCodes.CREATED);
        const body = await res.json();
        expect(body.attackerTeamId).toBe('ADMIN');
      });
    });

    describe('必須フィールドが不足している場合', () => {
      it('BAD_REQUEST を返すべき', async () => {
        const res = await app.request('/fault-injection/execute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ eventId: 'event-1' }),
        });
        expect(res.status).toBe(StatusCodes.BAD_REQUEST);
      });
    });

    describe('不正な JSON の場合', () => {
      it('BAD_REQUEST を返しエラーメッセージを含むべき', async () => {
        const res = await app.request('/fault-injection/execute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: 'invalid-json',
        });
        expect(res.status).toBe(StatusCodes.BAD_REQUEST);
        const body = await res.json();
        expect(body.error).toBe('JSON の解析に失敗しました');
      });
    });
  });

  describe('GET /teams', () => {
    describe('eventId が指定されている場合', () => {
      it('OK を返しチーム一覧を含むべき', async () => {
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

        expect(res.status).toBe(StatusCodes.OK);
        const body = await res.json();
        expect(body.teams).toHaveLength(1);
        expect(body.teams[0].teamName).toBe('チームA');
      });
    });

    describe('eventId が未指定の場合', () => {
      it('BAD_REQUEST を返すべき', async () => {
        const res = await app.request('/teams');
        expect(res.status).toBe(StatusCodes.BAD_REQUEST);
      });
    });
  });

  describe('GET /attack-logs', () => {
    describe('eventId が指定されている場合', () => {
      it('OK を返し攻撃履歴を含むべき', async () => {
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

        expect(res.status).toBe(StatusCodes.OK);
        const body = await res.json();
        expect(body.logs).toHaveLength(1);
      });
    });

    describe('eventId が未指定の場合', () => {
      it('BAD_REQUEST を返すべき', async () => {
        const res = await app.request('/attack-logs');
        expect(res.status).toBe(StatusCodes.BAD_REQUEST);
      });
    });
  });

  describe('POST /attacks/seed', () => {
    describe('有効なリクエストの場合', () => {
      it('CREATED を返しシード数を含むべき', async () => {
        mockGameController.seedAttackCatalog.mockResolvedValue(6);

        const res = await app.request('/attacks/seed', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ eventId: 'event-1' }),
        });

        expect(res.status).toBe(StatusCodes.CREATED);
        const body = await res.json();
        expect(body.seeded).toBe(6);
        expect(mockGameController.seedAttackCatalog).toHaveBeenCalledWith(
          'event-1',
          'tenant-1'
        );
      });
    });

    describe('eventId が空の場合', () => {
      it('BAD_REQUEST を返すべき', async () => {
        const res = await app.request('/attacks/seed', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ eventId: '' }),
        });
        expect(res.status).toBe(StatusCodes.BAD_REQUEST);
      });
    });

    describe('不正な JSON の場合', () => {
      it('BAD_REQUEST を返しエラーメッセージを含むべき', async () => {
        const res = await app.request('/attacks/seed', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: 'invalid-json',
        });
        expect(res.status).toBe(StatusCodes.BAD_REQUEST);
        const body = await res.json();
        expect(body.error).toBe('JSON の解析に失敗しました');
      });
    });
  });

  // === チーム登録 ===
  describe('POST /teams/register', () => {
    describe('有効なリクエストの場合', () => {
      it('CREATED を返しチーム情報を含むべき', async () => {
        const team = {
          eventId: 'event-1',
          teamId: 'team-1',
          teamName: 'チームA',
          score: 0,
          isHealthy: true,
          websiteUrl: 'https://example.com',
          apiUrl: 'https://api.example.com',
        };
        mockDashboardService.registerTeam.mockResolvedValue(team);

        const res = await app.request('/teams/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            eventId: 'event-1',
            teamId: 'team-1',
            teamName: 'チームA',
            websiteUrl: 'https://example.com',
            apiUrl: 'https://api.example.com',
          }),
        });

        expect(res.status).toBe(StatusCodes.CREATED);
        const body = await res.json();
        expect(body.teamId).toBe('team-1');
        expect(body.teamName).toBe('チームA');
      });
    });

    describe('重複チーム登録の場合', () => {
      it('CONFLICT を返すべき', async () => {
        mockDashboardService.registerTeam.mockRejectedValue(
          new mockDashboardService.TeamAlreadyExistsError('team-1')
        );

        const res = await app.request('/teams/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            eventId: 'event-1',
            teamId: 'team-1',
            teamName: 'チームA',
          }),
        });

        expect(res.status).toBe(StatusCodes.CONFLICT);
        const body = await res.json();
        expect(body.error).toContain('既に登録済み');
      });
    });

    describe('必須フィールドが不足している場合', () => {
      it('BAD_REQUEST を返すべき', async () => {
        const res = await app.request('/teams/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ eventId: 'event-1' }),
        });
        expect(res.status).toBe(StatusCodes.BAD_REQUEST);
      });
    });

    describe('不正な JSON の場合', () => {
      it('BAD_REQUEST を返しエラーメッセージを含むべき', async () => {
        const res = await app.request('/teams/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: 'invalid-json',
        });
        expect(res.status).toBe(StatusCodes.BAD_REQUEST);
        const body = await res.json();
        expect(body.error).toBe('JSON の解析に失敗しました');
      });
    });

    describe('予期しないエラーが発生した場合', () => {
      it('INTERNAL_SERVER_ERROR を返すべき', async () => {
        mockDashboardService.registerTeam.mockRejectedValue(
          new Error('DB接続エラー')
        );

        const res = await app.request('/teams/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            eventId: 'event-1',
            teamId: 'team-1',
            teamName: 'チームA',
          }),
        });

        expect(res.status).toBe(StatusCodes.INTERNAL_SERVER_ERROR);
      });
    });
  });

  // === Auditor ===
  describe('POST /auditor/start', () => {
    describe('正常な開始の場合', () => {
      it('OK を返し started ステータスを含むべき', async () => {
        mockAuditorService.isRunning.mockReturnValue(false);

        const res = await app.request('/auditor/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ eventId: 'event-1' }),
        });

        expect(res.status).toBe(StatusCodes.OK);
        const body = await res.json();
        expect(body.status).toBe('started');
        expect(body.eventId).toBe('event-1');
        expect(mockAuditorService.start).toHaveBeenCalledWith('event-1');
      });
    });

    describe('既に起動中の場合', () => {
      it('CONFLICT を返すべき', async () => {
        mockAuditorService.isRunning.mockReturnValue(true);

        const res = await app.request('/auditor/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ eventId: 'event-1' }),
        });

        expect(res.status).toBe(StatusCodes.CONFLICT);
        const body = await res.json();
        expect(body.error).toContain('既に起動');
      });
    });

    describe('eventId が空の場合', () => {
      it('BAD_REQUEST を返すべき', async () => {
        const res = await app.request('/auditor/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ eventId: '' }),
        });
        expect(res.status).toBe(StatusCodes.BAD_REQUEST);
      });
    });

    describe('不正な JSON の場合', () => {
      it('BAD_REQUEST を返しエラーメッセージを含むべき', async () => {
        const res = await app.request('/auditor/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: 'invalid-json',
        });
        expect(res.status).toBe(StatusCodes.BAD_REQUEST);
        const body = await res.json();
        expect(body.error).toBe('JSON の解析に失敗しました');
      });
    });
  });

  describe('POST /auditor/stop', () => {
    describe('起動中の場合', () => {
      it('OK を返し stopped ステータスを含むべき', async () => {
        mockAuditorService.isRunning.mockReturnValue(true);

        const res = await app.request('/auditor/stop', {
          method: 'POST',
        });

        expect(res.status).toBe(StatusCodes.OK);
        const body = await res.json();
        expect(body.status).toBe('stopped');
        expect(mockAuditorService.stop).toHaveBeenCalled();
      });
    });

    describe('起動していない場合', () => {
      it('CONFLICT を返すべき', async () => {
        mockAuditorService.isRunning.mockReturnValue(false);

        const res = await app.request('/auditor/stop', {
          method: 'POST',
        });

        expect(res.status).toBe(StatusCodes.CONFLICT);
        const body = await res.json();
        expect(body.error).toContain('起動していません');
      });
    });
  });
});
