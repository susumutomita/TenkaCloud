import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GameState, AttackLog } from '../types';

const { mockGamedayRepository } = vi.hoisted(() => ({
  mockGamedayRepository: {
    createGameState: vi.fn(),
    getGameState: vi.fn(),
    stopGame: vi.fn(),
    toggleScoreWeight: vi.fn(),
    toggleBlackout: vi.fn(),
    addAttackLog: vi.fn(),
    listAttackLogs: vi.fn(),
    listTeams: vi.fn(),
    getTeamState: vi.fn(),
  },
}));

vi.mock('../lib/dynamodb', () => ({
  gamedayRepository: mockGamedayRepository,
}));

import {
  startGame,
  stopGame,
  getGameStatus,
  toggleScoreWeight,
  toggleBlackout,
  executeFaultInjection,
  listTeams,
  listAttackLogs,
  GameNotFoundError,
} from './game-controller';

describe('ゲームコントローラーサービス', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('startGame', () => {
    describe('有効なパラメータの場合', () => {
      it('新しいゲームを作成して返すべき', async () => {
        const expected: GameState = {
          eventId: 'event-1',
          tenantId: 'tenant-1',
          isRunning: true,
          startedAt: '2026-03-09T00:00:00.000Z',
          scoreWeight: 'normal',
          blackout: false,
          durationMinutes: 240,
        };
        mockGamedayRepository.createGameState.mockResolvedValue(expected);

        const result = await startGame('event-1', 'tenant-1', 240);

        expect(result).toEqual(expected);
        expect(mockGamedayRepository.createGameState).toHaveBeenCalledWith({
          eventId: 'event-1',
          tenantId: 'tenant-1',
          durationMinutes: 240,
        });
      });
    });
  });

  describe('stopGame', () => {
    describe('ゲームが存在する場合', () => {
      it('ゲームを停止して返すべき', async () => {
        const expected: GameState = {
          eventId: 'event-1',
          tenantId: 'tenant-1',
          isRunning: false,
          startedAt: '2026-03-09T00:00:00.000Z',
          scoreWeight: 'normal',
          blackout: false,
          durationMinutes: 240,
        };
        mockGamedayRepository.stopGame.mockResolvedValue(expected);

        const result = await stopGame('event-1');

        expect(result).toEqual(expected);
        expect(mockGamedayRepository.stopGame).toHaveBeenCalledWith('event-1');
      });
    });

    describe('ゲームが存在しない場合', () => {
      it('GameNotFoundError を投げるべき', async () => {
        mockGamedayRepository.stopGame.mockResolvedValue(null);

        await expect(stopGame('nonexistent')).rejects.toThrow(
          GameNotFoundError
        );
        await expect(stopGame('nonexistent')).rejects.toThrow(
          'ゲームが見つかりません'
        );
      });
    });
  });

  describe('getGameStatus', () => {
    describe('ゲームが存在する場合', () => {
      it('ゲーム状態を返すべき', async () => {
        const expected: GameState = {
          eventId: 'event-1',
          tenantId: 'tenant-1',
          isRunning: true,
          startedAt: '2026-03-09T00:00:00.000Z',
          scoreWeight: 'normal',
          blackout: false,
          durationMinutes: 240,
        };
        mockGamedayRepository.getGameState.mockResolvedValue(expected);

        const result = await getGameStatus('event-1');

        expect(result).toEqual(expected);
      });
    });

    describe('ゲームが存在しない場合', () => {
      it('null を返すべき', async () => {
        mockGamedayRepository.getGameState.mockResolvedValue(null);

        const result = await getGameStatus('nonexistent');

        expect(result).toBeNull();
      });
    });
  });

  describe('toggleScoreWeight', () => {
    describe('ゲームが存在する場合', () => {
      it('切替後のゲーム状態を返すべき', async () => {
        const expected: GameState = {
          eventId: 'event-1',
          tenantId: 'tenant-1',
          isRunning: true,
          startedAt: '2026-03-09T00:00:00.000Z',
          scoreWeight: 'high',
          blackout: false,
          durationMinutes: 240,
        };
        mockGamedayRepository.toggleScoreWeight.mockResolvedValue(expected);

        const result = await toggleScoreWeight('event-1');

        expect(result).toEqual(expected);
      });
    });

    describe('ゲームが存在しない場合', () => {
      it('GameNotFoundError を投げるべき', async () => {
        mockGamedayRepository.toggleScoreWeight.mockResolvedValue(null);

        await expect(toggleScoreWeight('nonexistent')).rejects.toThrow(
          GameNotFoundError
        );
        await expect(toggleScoreWeight('nonexistent')).rejects.toThrow(
          'ゲームが見つかりません'
        );
      });
    });
  });

  describe('toggleBlackout', () => {
    describe('ゲームが存在する場合', () => {
      it('切替後のゲーム状態を返すべき', async () => {
        const expected: GameState = {
          eventId: 'event-1',
          tenantId: 'tenant-1',
          isRunning: true,
          startedAt: '2026-03-09T00:00:00.000Z',
          scoreWeight: 'normal',
          blackout: true,
          durationMinutes: 240,
        };
        mockGamedayRepository.toggleBlackout.mockResolvedValue(expected);

        const result = await toggleBlackout('event-1');

        expect(result).toEqual(expected);
      });
    });

    describe('ゲームが存在しない場合', () => {
      it('GameNotFoundError を投げるべき', async () => {
        mockGamedayRepository.toggleBlackout.mockResolvedValue(null);

        await expect(toggleBlackout('nonexistent')).rejects.toThrow(
          GameNotFoundError
        );
        await expect(toggleBlackout('nonexistent')).rejects.toThrow(
          'ゲームが見つかりません'
        );
      });
    });
  });

  describe('executeFaultInjection', () => {
    describe('有効なパラメータの場合', () => {
      it('管理者として攻撃ログを作成すべき', async () => {
        const expected: AttackLog = {
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
        mockGamedayRepository.addAttackLog.mockResolvedValue(expected);

        const result = await executeFaultInjection(
          'event-1',
          'team-1',
          'sql-injection'
        );

        expect(result).toEqual(expected);
        expect(mockGamedayRepository.addAttackLog).toHaveBeenCalledWith({
          eventId: 'event-1',
          attackerTeamId: 'ADMIN',
          defenderTeamId: 'team-1',
          attackId: 'sql-injection',
          attackSlug: 'sql-injection',
          success: true,
          damage: 0,
          reward: 0,
          details: '管理者による障害注入: sql-injection',
        });
      });
    });
  });

  describe('listTeams', () => {
    describe('チームが存在する場合', () => {
      it('チーム一覧を返すべき', async () => {
        const expected = [
          {
            eventId: 'event-1',
            teamId: 'team-1',
            teamName: 'チームA',
            score: 5000,
            isHealthy: true,
          },
        ];
        mockGamedayRepository.listTeams.mockResolvedValue(expected);

        const result = await listTeams('event-1');

        expect(result).toEqual(expected);
      });
    });
  });

  describe('listAttackLogs', () => {
    describe('攻撃履歴が存在する場合', () => {
      it('攻撃履歴一覧を返すべき', async () => {
        const expected: AttackLog[] = [
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
        mockGamedayRepository.listAttackLogs.mockResolvedValue(expected);

        const result = await listAttackLogs('event-1');

        expect(result).toEqual(expected);
      });
    });
  });
});
