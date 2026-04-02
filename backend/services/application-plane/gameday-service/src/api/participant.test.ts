import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StatusCodes } from 'http-status-codes';
import { Hono } from 'hono';

const mockParticipantService = vi.hoisted(() => {
  class GameNotRunningError extends Error {
    constructor() {
      super('ゲームが開始されていません');
      this.name = 'GameNotRunningError';
    }
  }
  class AttackNotFoundError extends Error {
    constructor(id: string) {
      super(`攻撃が見つかりません: ${id}`);
      this.name = 'AttackNotFoundError';
    }
  }
  class AttackNotPurchasedError extends Error {
    constructor() {
      super('この攻撃は購入されていません');
      this.name = 'AttackNotPurchasedError';
    }
  }
  class CooldownActiveError extends Error {
    remainingSeconds: number;
    constructor(seconds: number) {
      super(`クールダウン中です（残り${seconds}秒）`);
      this.name = 'CooldownActiveError';
      this.remainingSeconds = seconds;
    }
  }
  class SelfAttackError extends Error {
    constructor() {
      super('自チームへの攻撃はできません');
      this.name = 'SelfAttackError';
    }
  }
  class InsufficientScoreError extends Error {
    constructor() {
      super('スコアが不足しています');
      this.name = 'InsufficientScoreError';
    }
  }
  class TeamNotFoundError extends Error {
    constructor(id: string) {
      super(`チームが見つかりません: ${id}`);
      this.name = 'TeamNotFoundError';
    }
  }
  class AllianceNotFoundError extends Error {
    constructor(id: string) {
      super(`同盟が見つかりません: ${id}`);
      this.name = 'AllianceNotFoundError';
    }
  }
  class AllianceUnauthorizedError extends Error {
    constructor() {
      super('この同盟を操作する権限がありません');
      this.name = 'AllianceUnauthorizedError';
    }
  }
  class SelfVoteError extends Error {
    constructor() {
      super('自チームへの投票はできません');
      this.name = 'SelfVoteError';
    }
  }
  class AttackAlreadyPurchasedError extends Error {
    constructor() {
      super('この攻撃は既に購入済みです');
      this.name = 'AttackAlreadyPurchasedError';
    }
  }
  class VoteAlreadyExistsError extends Error {
    constructor() {
      super('既に投票済みです');
      this.name = 'VoteAlreadyExistsError';
    }
  }

  return {
    getAttackCatalog: vi.fn(),
    purchaseAttack: vi.fn(),
    executeAttack: vi.fn(),
    getAttackHistory: vi.fn(),
    getActiveAttacks: vi.fn(),
    purchaseHint: vi.fn(),
    reportFix: vi.fn(),
    listTeamAlliances: vi.fn(),
    requestAlliance: vi.fn(),
    acceptAlliance: vi.fn(),
    breakAlliance: vi.fn(),
    getMonitoringStatus: vi.fn(),
    castVote: vi.fn(),
    getVotingResults: vi.fn(),
    GameNotRunningError,
    AttackNotFoundError,
    AttackNotPurchasedError,
    CooldownActiveError,
    SelfAttackError,
    InsufficientScoreError,
    TeamNotFoundError,
    AllianceNotFoundError,
    AllianceUnauthorizedError,
    SelfVoteError,
    AttackAlreadyPurchasedError,
    VoteAlreadyExistsError,
  };
});

const mockDashboardService = vi.hoisted(() => {
  class BlackoutActiveError extends Error {
    constructor() {
      super('ブラックアウト中はリーダーボードを閲覧できません');
      this.name = 'BlackoutActiveError';
    }
  }
  class TeamNotFoundError extends Error {
    constructor(teamId: string) {
      super(`チームが見つかりません: ${teamId}`);
      this.name = 'TeamNotFoundError';
    }
  }
  class TeamAlreadyExistsError extends Error {
    constructor(teamId: string) {
      super(`チームは既に登録済みです: ${teamId}`);
      this.name = 'TeamAlreadyExistsError';
    }
  }
  return {
    updateTeamUrl: vi.fn(),
    listTeams: vi.fn(),
    getLeaderboard: vi.fn(),
    getAttackStatistics: vi.fn(),
    getTeamDashboard: vi.fn(),
    registerTeam: vi.fn(),
    joinTeamByInviteCode: vi.fn(),
    BlackoutActiveError,
    TeamNotFoundError,
    TeamAlreadyExistsError,
  };
});

const mockGameController = vi.hoisted(() => ({
  getGameStatus: vi.fn(),
}));

vi.mock('../services/participant-service', () => mockParticipantService);
vi.mock('../services/dashboard-service', () => mockDashboardService);
vi.mock('../services/game-controller', async () => {
  const actual = await vi.importActual('../services/game-controller');
  return {
    ...actual,
    getGameStatus: mockGameController.getGameStatus,
  };
});

import { participantRoutes } from './participant';

describe('プレーヤー API', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/', participantRoutes);
  });

  // === 攻撃カタログ ===
  describe('GET /attacks/catalog', () => {
    it('eventId ありで OK を返すべき', async () => {
      mockParticipantService.getAttackCatalog.mockResolvedValue([
        { id: 'atk-1', name: 'SQL Injection' },
      ]);
      const res = await app.request('/attacks/catalog?eventId=event-1');
      expect(res.status).toBe(StatusCodes.OK);
      const body = await res.json();
      expect(body.attacks).toHaveLength(1);
    });

    it('eventId なしで BAD_REQUEST を返すべき', async () => {
      const res = await app.request('/attacks/catalog');
      expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    });
  });

  describe('GET /teams', () => {
    it('eventId ありで参加対象チーム一覧を返すべき', async () => {
      mockDashboardService.listTeams.mockResolvedValue([
        {
          eventId: 'event-1',
          teamId: 'team-1',
          teamName: 'チームA',
          score: 100,
        },
      ]);

      const res = await app.request('/teams?eventId=event-1');

      expect(res.status).toBe(StatusCodes.OK);
      const body = await res.json();
      expect(body.teams).toEqual([
        {
          eventId: 'event-1',
          teamId: 'team-1',
          teamName: 'チームA',
          score: 100,
        },
      ]);
    });

    it('eventId なしで BAD_REQUEST を返すべき', async () => {
      const res = await app.request('/teams');

      expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    });
  });

  describe('GET /game/status', () => {
    it('eventId ありでゲーム状態を返すべき', async () => {
      mockGameController.getGameStatus.mockResolvedValue({
        eventId: 'event-1',
        tenantId: 'tenant-1',
        isRunning: true,
        startedAt: '2026-03-20T00:00:00.000Z',
        scoreWeight: 'normal',
        blackout: false,
        durationMinutes: 180,
      });

      const res = await app.request('/game/status?eventId=event-1');

      expect(res.status).toBe(StatusCodes.OK);
      const body = await res.json();
      expect(body.eventId).toBe('event-1');
      expect(body.isRunning).toBe(true);
    });

    it('eventId なしで BAD_REQUEST を返すべき', async () => {
      const res = await app.request('/game/status');

      expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    });

    it('ゲームが存在しない場合は NOT_FOUND を返すべき', async () => {
      mockGameController.getGameStatus.mockResolvedValue(null);

      const res = await app.request('/game/status?eventId=event-1');

      expect(res.status).toBe(StatusCodes.NOT_FOUND);
    });
  });

  // === 攻撃購入 ===
  describe('POST /attacks/purchase', () => {
    it('正常系で CREATED を返すべき', async () => {
      mockParticipantService.purchaseAttack.mockResolvedValue({
        id: 'p-1',
        attackId: 'atk-1',
      });
      const res = await app.request('/attacks/purchase', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId: 'event-1',
          teamId: 'team-1',
          attackId: 'atk-1',
        }),
      });
      expect(res.status).toBe(StatusCodes.CREATED);
    });

    it('バリデーション失敗で BAD_REQUEST を返すべき', async () => {
      const res = await app.request('/attacks/purchase', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    });

    it('不正な JSON で BAD_REQUEST を返すべき', async () => {
      const res = await app.request('/attacks/purchase', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'invalid-json',
      });
      expect(res.status).toBe(StatusCodes.BAD_REQUEST);
      const body = await res.json();
      expect(body.error).toBe('JSON の解析に失敗しました');
    });

    it('GameNotRunningError で CONFLICT を返すべき', async () => {
      mockParticipantService.purchaseAttack.mockRejectedValue(
        new mockParticipantService.GameNotRunningError()
      );
      const res = await app.request('/attacks/purchase', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId: 'event-1',
          teamId: 'team-1',
          attackId: 'atk-1',
        }),
      });
      expect(res.status).toBe(StatusCodes.CONFLICT);
    });

    it('AttackAlreadyPurchasedError で CONFLICT を返すべき', async () => {
      mockParticipantService.purchaseAttack.mockRejectedValue(
        new mockParticipantService.AttackAlreadyPurchasedError()
      );
      const res = await app.request('/attacks/purchase', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId: 'event-1',
          teamId: 'team-1',
          attackId: 'atk-1',
        }),
      });
      expect(res.status).toBe(StatusCodes.CONFLICT);
    });

    it('InsufficientScoreError で PAYMENT_REQUIRED を返すべき', async () => {
      mockParticipantService.purchaseAttack.mockRejectedValue(
        new mockParticipantService.InsufficientScoreError()
      );
      const res = await app.request('/attacks/purchase', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId: 'event-1',
          teamId: 'team-1',
          attackId: 'atk-1',
        }),
      });
      expect(res.status).toBe(StatusCodes.PAYMENT_REQUIRED);
    });

    it('予期しないエラーで INTERNAL_SERVER_ERROR を返すべき', async () => {
      mockParticipantService.purchaseAttack.mockRejectedValue(
        new Error('DB接続エラー')
      );
      const res = await app.request('/attacks/purchase', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId: 'event-1',
          teamId: 'team-1',
          attackId: 'atk-1',
        }),
      });
      expect(res.status).toBe(StatusCodes.INTERNAL_SERVER_ERROR);
    });
  });

  // === 攻撃実行 ===
  describe('POST /attacks/execute', () => {
    it('正常系で OK を返すべき', async () => {
      mockParticipantService.executeAttack.mockResolvedValue({
        id: 'log-1',
        success: true,
      });
      const res = await app.request('/attacks/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId: 'event-1',
          teamId: 'team-1',
          targetTeamId: 'team-2',
          attackId: 'atk-1',
        }),
      });
      expect(res.status).toBe(StatusCodes.OK);
    });

    it('バリデーション失敗で BAD_REQUEST を返すべき', async () => {
      const res = await app.request('/attacks/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId: 'event-1' }),
      });
      expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    });

    it('不正な JSON で BAD_REQUEST を返すべき', async () => {
      const res = await app.request('/attacks/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'invalid-json',
      });
      expect(res.status).toBe(StatusCodes.BAD_REQUEST);
      const body = await res.json();
      expect(body.error).toBe('JSON の解析に失敗しました');
    });

    it('SelfAttackError で BAD_REQUEST を返すべき', async () => {
      mockParticipantService.executeAttack.mockRejectedValue(
        new mockParticipantService.SelfAttackError()
      );
      const res = await app.request('/attacks/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId: 'event-1',
          teamId: 'team-1',
          targetTeamId: 'team-2',
          attackId: 'atk-1',
        }),
      });
      expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    });

    it('CooldownActiveError で TOO_MANY_REQUESTS を返すべき', async () => {
      mockParticipantService.executeAttack.mockRejectedValue(
        new mockParticipantService.CooldownActiveError(120)
      );
      const res = await app.request('/attacks/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId: 'event-1',
          teamId: 'team-1',
          targetTeamId: 'team-2',
          attackId: 'atk-1',
        }),
      });
      expect(res.status).toBe(StatusCodes.TOO_MANY_REQUESTS);
      const body = await res.json();
      expect(body.remainingSeconds).toBe(120);
    });

    it('AttackNotPurchasedError で PRECONDITION_FAILED を返すべき', async () => {
      mockParticipantService.executeAttack.mockRejectedValue(
        new mockParticipantService.AttackNotPurchasedError()
      );
      const res = await app.request('/attacks/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId: 'event-1',
          teamId: 'team-1',
          targetTeamId: 'team-2',
          attackId: 'atk-1',
        }),
      });
      expect(res.status).toBe(StatusCodes.PRECONDITION_FAILED);
    });

    it('TeamNotFoundError で NOT_FOUND を返すべき', async () => {
      mockParticipantService.executeAttack.mockRejectedValue(
        new mockParticipantService.TeamNotFoundError('team-2')
      );
      const res = await app.request('/attacks/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId: 'event-1',
          teamId: 'team-1',
          targetTeamId: 'team-2',
          attackId: 'atk-1',
        }),
      });
      expect(res.status).toBe(StatusCodes.NOT_FOUND);
    });

    it('AttackNotFoundError で NOT_FOUND を返すべき', async () => {
      mockParticipantService.executeAttack.mockRejectedValue(
        new mockParticipantService.AttackNotFoundError('atk-1')
      );
      const res = await app.request('/attacks/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId: 'event-1',
          teamId: 'team-1',
          targetTeamId: 'team-2',
          attackId: 'atk-1',
        }),
      });
      expect(res.status).toBe(StatusCodes.NOT_FOUND);
    });

    it('GameNotRunningError で CONFLICT を返すべき', async () => {
      mockParticipantService.executeAttack.mockRejectedValue(
        new mockParticipantService.GameNotRunningError()
      );
      const res = await app.request('/attacks/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId: 'event-1',
          teamId: 'team-1',
          targetTeamId: 'team-2',
          attackId: 'atk-1',
        }),
      });
      expect(res.status).toBe(StatusCodes.CONFLICT);
    });

    it('予期しないエラーで INTERNAL_SERVER_ERROR を返すべき', async () => {
      mockParticipantService.executeAttack.mockRejectedValue(
        new Error('DB接続エラー')
      );
      const res = await app.request('/attacks/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId: 'event-1',
          teamId: 'team-1',
          targetTeamId: 'team-2',
          attackId: 'atk-1',
        }),
      });
      expect(res.status).toBe(StatusCodes.INTERNAL_SERVER_ERROR);
    });
  });

  // === 攻撃履歴 ===
  describe('GET /attacks/history', () => {
    it('正常系で OK を返すべき', async () => {
      mockParticipantService.getAttackHistory.mockResolvedValue([]);
      const res = await app.request(
        '/attacks/history?eventId=event-1&teamId=team-1'
      );
      expect(res.status).toBe(StatusCodes.OK);
      const body = await res.json();
      expect(body.history).toEqual([]);
    });

    it('パラメータ不足で BAD_REQUEST を返すべき', async () => {
      const res = await app.request('/attacks/history');
      expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    });
  });

  // === 防御: 受攻撃一覧 ===
  describe('GET /defense/active', () => {
    it('正常系で OK を返すべき', async () => {
      mockParticipantService.getActiveAttacks.mockResolvedValue([]);
      const res = await app.request(
        '/defense/active?eventId=event-1&teamId=team-1'
      );
      expect(res.status).toBe(StatusCodes.OK);
      const body = await res.json();
      expect(body.attacks).toEqual([]);
    });

    it('パラメータ不足で BAD_REQUEST を返すべき', async () => {
      const res = await app.request('/defense/active');
      expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    });
  });

  // === ヒント購入 ===
  describe('POST /defense/hint', () => {
    it('正常系で OK を返すべき', async () => {
      mockParticipantService.purchaseHint.mockResolvedValue({
        hint: 'ヒント内容',
        cost: 0,
      });
      const res = await app.request('/defense/hint', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId: 'event-1',
          teamId: 'team-1',
          attackId: 'atk-1',
        }),
      });
      expect(res.status).toBe(StatusCodes.OK);
    });

    it('バリデーション失敗で BAD_REQUEST を返すべき', async () => {
      const res = await app.request('/defense/hint', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    });

    it('不正な JSON で BAD_REQUEST を返すべき', async () => {
      const res = await app.request('/defense/hint', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'invalid-json',
      });
      expect(res.status).toBe(StatusCodes.BAD_REQUEST);
      const body = await res.json();
      expect(body.error).toBe('JSON の解析に失敗しました');
    });

    it('AttackNotFoundError で NOT_FOUND を返すべき', async () => {
      mockParticipantService.purchaseHint.mockRejectedValue(
        new mockParticipantService.AttackNotFoundError('atk-1')
      );
      const res = await app.request('/defense/hint', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId: 'event-1',
          teamId: 'team-1',
          attackId: 'atk-1',
        }),
      });
      expect(res.status).toBe(StatusCodes.NOT_FOUND);
    });

    it('予期しないエラーで INTERNAL_SERVER_ERROR を返すべき', async () => {
      mockParticipantService.purchaseHint.mockRejectedValue(
        new Error('DB接続エラー')
      );
      const res = await app.request('/defense/hint', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId: 'event-1',
          teamId: 'team-1',
          attackId: 'atk-1',
        }),
      });
      expect(res.status).toBe(StatusCodes.INTERNAL_SERVER_ERROR);
    });
  });

  // === 脆弱性修正報告 ===
  describe('POST /defense/report-fix', () => {
    it('正常系で OK を返すべき', async () => {
      mockParticipantService.reportFix.mockResolvedValue({
        id: 'v-1',
        isFixed: true,
      });
      const res = await app.request('/defense/report-fix', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId: 'event-1',
          teamId: 'team-1',
          vulnerabilitySlug: 'sql-injection',
        }),
      });
      expect(res.status).toBe(StatusCodes.OK);
    });

    it('バリデーション失敗で BAD_REQUEST を返すべき', async () => {
      const res = await app.request('/defense/report-fix', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    });

    it('不正な JSON で BAD_REQUEST を返すべき', async () => {
      const res = await app.request('/defense/report-fix', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'invalid-json',
      });
      expect(res.status).toBe(StatusCodes.BAD_REQUEST);
      const body = await res.json();
      expect(body.error).toBe('JSON の解析に失敗しました');
    });

    it('GameNotRunningError で CONFLICT を返すべき', async () => {
      mockParticipantService.reportFix.mockRejectedValue(
        new mockParticipantService.GameNotRunningError()
      );
      const res = await app.request('/defense/report-fix', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId: 'event-1',
          teamId: 'team-1',
          vulnerabilitySlug: 'sql-injection',
        }),
      });
      expect(res.status).toBe(StatusCodes.CONFLICT);
    });

    it('予期しないエラーで INTERNAL_SERVER_ERROR を返すべき', async () => {
      mockParticipantService.reportFix.mockRejectedValue(
        new Error('DB接続エラー')
      );
      const res = await app.request('/defense/report-fix', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId: 'event-1',
          teamId: 'team-1',
          vulnerabilitySlug: 'sql-injection',
        }),
      });
      expect(res.status).toBe(StatusCodes.INTERNAL_SERVER_ERROR);
    });
  });

  // === 同盟一覧 ===
  describe('GET /alliances', () => {
    it('正常系で OK を返すべき', async () => {
      mockParticipantService.listTeamAlliances.mockResolvedValue([]);
      const res = await app.request('/alliances?eventId=event-1&teamId=team-1');
      expect(res.status).toBe(StatusCodes.OK);
      const body = await res.json();
      expect(body.alliances).toEqual([]);
    });

    it('パラメータ不足で BAD_REQUEST を返すべき', async () => {
      const res = await app.request('/alliances');
      expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    });
  });

  // === 同盟申請 ===
  describe('POST /alliances/request', () => {
    it('正常系で CREATED を返すべき', async () => {
      mockParticipantService.requestAlliance.mockResolvedValue({
        id: 'a-1',
        status: 'PENDING',
      });
      const res = await app.request('/alliances/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId: 'event-1',
          teamId: 'team-1',
          targetTeamId: 'team-2',
        }),
      });
      expect(res.status).toBe(StatusCodes.CREATED);
    });

    it('バリデーション失敗で BAD_REQUEST を返すべき', async () => {
      const res = await app.request('/alliances/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    });

    it('不正な JSON で BAD_REQUEST を返すべき', async () => {
      const res = await app.request('/alliances/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'invalid-json',
      });
      expect(res.status).toBe(StatusCodes.BAD_REQUEST);
      const body = await res.json();
      expect(body.error).toBe('JSON の解析に失敗しました');
    });

    it('GameNotRunningError で CONFLICT を返すべき', async () => {
      mockParticipantService.requestAlliance.mockRejectedValue(
        new mockParticipantService.GameNotRunningError()
      );
      const res = await app.request('/alliances/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId: 'event-1',
          teamId: 'team-1',
          targetTeamId: 'team-2',
        }),
      });
      expect(res.status).toBe(StatusCodes.CONFLICT);
    });

    it('予期しないエラーで INTERNAL_SERVER_ERROR を返すべき', async () => {
      mockParticipantService.requestAlliance.mockRejectedValue(
        new Error('DB接続エラー')
      );
      const res = await app.request('/alliances/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId: 'event-1',
          teamId: 'team-1',
          targetTeamId: 'team-2',
        }),
      });
      expect(res.status).toBe(StatusCodes.INTERNAL_SERVER_ERROR);
    });
  });

  // === 同盟承認 ===
  describe('POST /alliances/:id/accept', () => {
    it('正常系で OK を返すべき', async () => {
      mockParticipantService.acceptAlliance.mockResolvedValue({
        id: 'a-1',
        status: 'ACTIVE',
      });
      const res = await app.request('/alliances/a-1/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId: 'event-1',
          teamId: 'team-2',
        }),
      });
      expect(res.status).toBe(StatusCodes.OK);
    });

    it('不正な JSON で BAD_REQUEST を返すべき', async () => {
      const res = await app.request('/alliances/a-1/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'invalid-json',
      });
      expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    });

    it('AllianceNotFoundError で NOT_FOUND を返すべき', async () => {
      mockParticipantService.acceptAlliance.mockRejectedValue(
        new mockParticipantService.AllianceNotFoundError('a-1')
      );
      const res = await app.request('/alliances/a-1/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId: 'event-1',
          teamId: 'team-2',
        }),
      });
      expect(res.status).toBe(StatusCodes.NOT_FOUND);
    });

    it('AllianceUnauthorizedError で FORBIDDEN を返すべき', async () => {
      mockParticipantService.acceptAlliance.mockRejectedValue(
        new mockParticipantService.AllianceUnauthorizedError()
      );
      const res = await app.request('/alliances/a-1/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId: 'event-1',
          teamId: 'team-2',
        }),
      });
      expect(res.status).toBe(StatusCodes.FORBIDDEN);
    });

    it('予期しないエラーで INTERNAL_SERVER_ERROR を返すべき', async () => {
      mockParticipantService.acceptAlliance.mockRejectedValue(
        new Error('DB接続エラー')
      );
      const res = await app.request('/alliances/a-1/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId: 'event-1',
          teamId: 'team-2',
        }),
      });
      expect(res.status).toBe(StatusCodes.INTERNAL_SERVER_ERROR);
    });

    it('バリデーション失敗で BAD_REQUEST を返すべき', async () => {
      const res = await app.request('/alliances/a-1/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    });
  });

  // === 同盟破棄 ===
  describe('POST /alliances/:id/break', () => {
    it('正常系で OK を返すべき', async () => {
      mockParticipantService.breakAlliance.mockResolvedValue(undefined);
      const res = await app.request('/alliances/a-1/break', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId: 'event-1',
          teamId: 'team-1',
        }),
      });
      expect(res.status).toBe(StatusCodes.OK);
      const body = await res.json();
      expect(body.success).toBe(true);
    });

    it('バリデーション失敗で BAD_REQUEST を返すべき', async () => {
      const res = await app.request('/alliances/a-1/break', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    });

    it('不正な JSON で BAD_REQUEST を返すべき', async () => {
      const res = await app.request('/alliances/a-1/break', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'invalid-json',
      });
      expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    });

    it('AllianceNotFoundError で NOT_FOUND を返すべき', async () => {
      mockParticipantService.breakAlliance.mockRejectedValue(
        new mockParticipantService.AllianceNotFoundError('a-1')
      );
      const res = await app.request('/alliances/a-1/break', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId: 'event-1',
          teamId: 'team-1',
        }),
      });
      expect(res.status).toBe(StatusCodes.NOT_FOUND);
    });

    it('予期しないエラーで INTERNAL_SERVER_ERROR を返すべき', async () => {
      mockParticipantService.breakAlliance.mockRejectedValue(
        new Error('DB接続エラー')
      );
      const res = await app.request('/alliances/a-1/break', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId: 'event-1',
          teamId: 'team-1',
        }),
      });
      expect(res.status).toBe(StatusCodes.INTERNAL_SERVER_ERROR);
    });
  });

  // === モニタリング ===
  describe('GET /monitoring/status', () => {
    it('正常系で OK を返すべき', async () => {
      mockParticipantService.getMonitoringStatus.mockResolvedValue([]);
      const res = await app.request(
        '/monitoring/status?eventId=event-1&teamId=team-1'
      );
      expect(res.status).toBe(StatusCodes.OK);
      const body = await res.json();
      expect(body.checks).toEqual([]);
    });

    it('パラメータ不足で BAD_REQUEST を返すべき', async () => {
      const res = await app.request('/monitoring/status');
      expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    });
  });

  // === 投票 ===
  describe('POST /voting/vote', () => {
    it('正常系で CREATED を返すべき', async () => {
      mockParticipantService.castVote.mockResolvedValue({
        id: 'v-1',
        voterTeamId: 'team-1',
        votedForTeamId: 'team-2',
      });
      const res = await app.request('/voting/vote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId: 'event-1',
          teamId: 'team-1',
          votedForTeamId: 'team-2',
        }),
      });
      expect(res.status).toBe(StatusCodes.CREATED);
    });

    it('バリデーション失敗で BAD_REQUEST を返すべき', async () => {
      const res = await app.request('/voting/vote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    });

    it('不正な JSON で BAD_REQUEST を返すべき', async () => {
      const res = await app.request('/voting/vote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'invalid-json',
      });
      expect(res.status).toBe(StatusCodes.BAD_REQUEST);
      const body = await res.json();
      expect(body.error).toBe('JSON の解析に失敗しました');
    });

    it('SelfVoteError で BAD_REQUEST を返すべき', async () => {
      mockParticipantService.castVote.mockRejectedValue(
        new mockParticipantService.SelfVoteError()
      );
      const res = await app.request('/voting/vote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId: 'event-1',
          teamId: 'team-1',
          votedForTeamId: 'team-2',
        }),
      });
      expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    });

    it('VoteAlreadyExistsError で CONFLICT を返すべき', async () => {
      mockParticipantService.castVote.mockRejectedValue(
        new mockParticipantService.VoteAlreadyExistsError()
      );
      const res = await app.request('/voting/vote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId: 'event-1',
          teamId: 'team-1',
          votedForTeamId: 'team-2',
        }),
      });
      expect(res.status).toBe(StatusCodes.CONFLICT);
    });

    it('予期しないエラーで INTERNAL_SERVER_ERROR を返すべき', async () => {
      mockParticipantService.castVote.mockRejectedValue(
        new Error('DB接続エラー')
      );
      const res = await app.request('/voting/vote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId: 'event-1',
          teamId: 'team-1',
          votedForTeamId: 'team-2',
        }),
      });
      expect(res.status).toBe(StatusCodes.INTERNAL_SERVER_ERROR);
    });
  });

  // === 投票結果 ===
  describe('GET /voting/results', () => {
    it('正常系で OK を返すべき', async () => {
      mockParticipantService.getVotingResults.mockResolvedValue([
        { teamId: 'team-2', votes: 3 },
      ]);
      const res = await app.request('/voting/results?eventId=event-1');
      expect(res.status).toBe(StatusCodes.OK);
      const body = await res.json();
      expect(body.results).toHaveLength(1);
    });

    it('eventId なしで BAD_REQUEST を返すべき', async () => {
      const res = await app.request('/voting/results');
      expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    });
  });

  // === ダッシュボード: リーダーボード ===
  describe('GET /dashboard/leaderboard', () => {
    it('正常系でスコア降順の一覧を返すべき', async () => {
      mockDashboardService.getLeaderboard.mockResolvedValue([
        { teamId: 'team-2', score: 5000 },
        { teamId: 'team-1', score: 3000 },
      ]);
      const res = await app.request('/dashboard/leaderboard?eventId=event-1');
      expect(res.status).toBe(StatusCodes.OK);
      const body = await res.json();
      expect(body.leaderboard).toHaveLength(2);
      expect(body.leaderboard[0].teamId).toBe('team-2');
    });

    it('eventId なしで BAD_REQUEST を返すべき', async () => {
      const res = await app.request('/dashboard/leaderboard');
      expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    });

    it('ブラックアウト中で FORBIDDEN を返すべき', async () => {
      mockDashboardService.getLeaderboard.mockRejectedValue(
        new mockDashboardService.BlackoutActiveError()
      );
      const res = await app.request('/dashboard/leaderboard?eventId=event-1');
      expect(res.status).toBe(StatusCodes.FORBIDDEN);
      const body = await res.json();
      expect(body.error).toContain('ブラックアウト');
    });

    it('予期しないエラーで INTERNAL_SERVER_ERROR を返すべき', async () => {
      mockDashboardService.getLeaderboard.mockRejectedValue(
        new Error('DB接続エラー')
      );
      const res = await app.request('/dashboard/leaderboard?eventId=event-1');
      expect(res.status).toBe(StatusCodes.INTERNAL_SERVER_ERROR);
    });
  });

  // === ダッシュボード: 攻撃統計 ===
  describe('GET /dashboard/attack-stats', () => {
    it('正常系で OK を返すべき', async () => {
      mockDashboardService.getAttackStatistics.mockResolvedValue([
        {
          teamId: 'team-1',
          attacksSent: 2,
          attacksReceived: 1,
          successRate: 0.5,
        },
      ]);
      const res = await app.request('/dashboard/attack-stats?eventId=event-1');
      expect(res.status).toBe(StatusCodes.OK);
      const body = await res.json();
      expect(body.stats).toHaveLength(1);
    });

    it('eventId なしで BAD_REQUEST を返すべき', async () => {
      const res = await app.request('/dashboard/attack-stats');
      expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    });
  });

  // === ダッシュボード: チーム詳細 ===
  describe('GET /dashboard/team', () => {
    it('正常系で OK を返すべき', async () => {
      mockDashboardService.getTeamDashboard.mockResolvedValue({
        team: { teamId: 'team-1', score: 5000 },
        recentHealthChecks: [],
        attackHistory: [],
      });
      const res = await app.request(
        '/dashboard/team?eventId=event-1&teamId=team-1'
      );
      expect(res.status).toBe(StatusCodes.OK);
      const body = await res.json();
      expect(body.team.teamId).toBe('team-1');
    });

    it('チームが存在しない場合 NOT_FOUND を返すべき', async () => {
      mockDashboardService.getTeamDashboard.mockResolvedValue(null);
      const res = await app.request(
        '/dashboard/team?eventId=event-1&teamId=nonexistent'
      );
      expect(res.status).toBe(StatusCodes.NOT_FOUND);
    });

    it('パラメータ不足で BAD_REQUEST を返すべき', async () => {
      const res = await app.request('/dashboard/team');
      expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    });
  });

  // === チーム URL 更新 ===
  describe('POST /teams/update-url', () => {
    it('正常系で OK を返すべき', async () => {
      mockDashboardService.updateTeamUrl.mockResolvedValue(undefined);
      const res = await app.request('/teams/update-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId: 'event-1',
          teamId: 'team-1',
          websiteUrl: 'https://new.example.com',
        }),
      });
      expect(res.status).toBe(StatusCodes.OK);
      const body = await res.json();
      expect(body.success).toBe(true);
    });

    it('バリデーション失敗で BAD_REQUEST を返すべき', async () => {
      const res = await app.request('/teams/update-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    });

    it('不正な JSON で BAD_REQUEST を返すべき', async () => {
      const res = await app.request('/teams/update-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'invalid-json',
      });
      expect(res.status).toBe(StatusCodes.BAD_REQUEST);
      const body = await res.json();
      expect(body.error).toBe('JSON の解析に失敗しました');
    });

    it('不正な URL で BAD_REQUEST を返すべき', async () => {
      const res = await app.request('/teams/update-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId: 'event-1',
          teamId: 'team-1',
          websiteUrl: 'not-a-url',
        }),
      });
      expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    });

    it('チームが存在しない場合 NOT_FOUND を返すべき', async () => {
      mockDashboardService.updateTeamUrl.mockRejectedValue(
        new mockDashboardService.TeamNotFoundError('team-1')
      );
      const res = await app.request('/teams/update-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId: 'event-1',
          teamId: 'team-1',
          websiteUrl: 'https://example.com',
        }),
      });
      expect(res.status).toBe(StatusCodes.NOT_FOUND);
    });
  });

  // === チーム作成 ===
  describe('POST /teams/create', () => {
    it('正常なリクエストでチームを作成して CREATED を返すべき', async () => {
      mockDashboardService.registerTeam.mockResolvedValue({
        eventId: 'event-1',
        teamId: 'team-1',
        teamName: 'テストチーム',
        score: 0,
        isHealthy: true,
        websiteUrl: null,
        apiUrl: null,
        inviteCode: 'ABC123',
      });
      const res = await app.request('/teams/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId: 'event-1',
          teamId: 'team-1',
          teamName: 'テストチーム',
        }),
      });
      expect(res.status).toBe(StatusCodes.CREATED);
      const body = await res.json();
      expect(body.teamId).toBe('team-1');
      expect(body.teamName).toBe('テストチーム');
      expect(body.inviteCode).toBe('ABC123');
    });

    it('必須フィールドが欠けている場合 BAD_REQUEST を返すべき', async () => {
      const res = await app.request('/teams/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId: 'event-1' }),
      });
      expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    });

    it('チームが既に存在する場合 CONFLICT を返すべき', async () => {
      mockDashboardService.registerTeam.mockRejectedValue(
        new mockDashboardService.TeamAlreadyExistsError('team-1')
      );
      const res = await app.request('/teams/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId: 'event-1',
          teamId: 'team-1',
          teamName: 'テストチーム',
        }),
      });
      expect(res.status).toBe(StatusCodes.CONFLICT);
    });
  });

  // === 招待コードでチーム参加 ===
  describe('POST /teams/join', () => {
    it('有効な招待コードでチームを返すべき', async () => {
      mockDashboardService.joinTeamByInviteCode.mockResolvedValue({
        eventId: 'event-1',
        teamId: 'team-1',
        teamName: 'テストチーム',
        score: 0,
        isHealthy: true,
        websiteUrl: null,
        apiUrl: null,
        inviteCode: 'ABC123',
      });
      const res = await app.request('/teams/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId: 'event-1', inviteCode: 'ABC123' }),
      });
      expect(res.status).toBe(StatusCodes.OK);
      const body = await res.json();
      expect(body.teamId).toBe('team-1');
      expect(body.teamName).toBe('テストチーム');
    });

    it('無効な招待コードで NOT_FOUND を返すべき', async () => {
      mockDashboardService.joinTeamByInviteCode.mockResolvedValue(null);
      const res = await app.request('/teams/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId: 'event-1', inviteCode: 'XXXXXX' }),
      });
      expect(res.status).toBe(StatusCodes.NOT_FOUND);
    });

    it('必須フィールドが欠けている場合 BAD_REQUEST を返すべき', async () => {
      const res = await app.request('/teams/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId: 'event-1' }),
      });
      expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    });
  });

  // === チームダッシュボード (チームなし時の空状態) ===
  describe('GET /dashboard/team チームなし時', () => {
    it('チームが存在しない場合は空のダッシュボードを返すべき', async () => {
      mockDashboardService.getTeamDashboard.mockResolvedValue(null);
      const res = await app.request(
        '/dashboard/team?eventId=event-1&teamId=unknown'
      );
      expect(res.status).toBe(StatusCodes.OK);
      const body = await res.json();
      expect(body.team.teamId).toBe('unknown');
      expect(body.score).toBe(0);
      expect(body.recentAttacks).toEqual([]);
    });
  });
});
