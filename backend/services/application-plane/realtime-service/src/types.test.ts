import { describe, it, expect } from 'vitest';
import {
  realtimeEventSchema,
  clientMessageSchema,
  leaderboardEntrySchema,
  scoreUpdateEventSchema,
  attackExecutedEventSchema,
  gameStateChangedEventSchema,
  leaderboardUpdateEventSchema,
  serverPongSchema,
  serverErrorSchema,
  serverJoinedSchema,
  serverLeftSchema,
} from './types';

describe('types', () => {
  describe('leaderboardEntrySchema', () => {
    it('有効なリーダーボードエントリをパースできるべき', () => {
      const entry = { teamId: 'team-1', teamName: 'Team A', score: 100, rank: 1 };
      expect(leaderboardEntrySchema.parse(entry)).toEqual(entry);
    });

    it('不足フィールドでエラーになるべき', () => {
      expect(() => leaderboardEntrySchema.parse({ teamId: 'team-1' })).toThrow();
    });

    it('型が不正な場合エラーになるべき', () => {
      expect(() =>
        leaderboardEntrySchema.parse({ teamId: 'team-1', teamName: 'A', score: 'not-number', rank: 1 }),
      ).toThrow();
    });
  });

  describe('realtimeEventSchema', () => {
    it('score_update イベントをパースできるべき', () => {
      const event = { type: 'score_update', teamId: 'team-1', score: 100, rank: 1 };
      const result = realtimeEventSchema.parse(event);
      expect(result).toEqual(event);
    });

    it('attack_executed イベントをパースできるべき', () => {
      const event = {
        type: 'attack_executed',
        attackerTeamId: 'team-1',
        defenderTeamId: 'team-2',
        attackSlug: 'cpu-stress',
      };
      const result = realtimeEventSchema.parse(event);
      expect(result).toEqual(event);
    });

    it('game_state_changed イベントをパースできるべき', () => {
      const event = {
        type: 'game_state_changed',
        isRunning: true,
        scoreWeight: '1.0',
        blackout: false,
      };
      const result = realtimeEventSchema.parse(event);
      expect(result).toEqual(event);
    });

    it('leaderboard_update イベントをパースできるべき', () => {
      const event = {
        type: 'leaderboard_update',
        entries: [{ teamId: 'team-1', teamName: 'Team A', score: 100, rank: 1 }],
      };
      const result = realtimeEventSchema.parse(event);
      expect(result).toEqual(event);
    });

    it('不正な type でエラーになるべき', () => {
      expect(() => realtimeEventSchema.parse({ type: 'unknown' })).toThrow();
    });

    it('必須フィールドが欠けている場合エラーになるべき', () => {
      expect(() => realtimeEventSchema.parse({ type: 'score_update', teamId: 'team-1' })).toThrow();
    });
  });

  describe('scoreUpdateEventSchema', () => {
    it('有効なスコア更新イベントをパースできるべき', () => {
      const event = { type: 'score_update' as const, teamId: 't1', score: 50, rank: 2 };
      expect(scoreUpdateEventSchema.parse(event)).toEqual(event);
    });
  });

  describe('attackExecutedEventSchema', () => {
    it('有効な攻撃実行イベントをパースできるべき', () => {
      const event = {
        type: 'attack_executed' as const,
        attackerTeamId: 'a',
        defenderTeamId: 'b',
        attackSlug: 'network-partition',
      };
      expect(attackExecutedEventSchema.parse(event)).toEqual(event);
    });
  });

  describe('gameStateChangedEventSchema', () => {
    it('有効なゲーム状態変更イベントをパースできるべき', () => {
      const event = { type: 'game_state_changed' as const, isRunning: false, scoreWeight: '0.5', blackout: true };
      expect(gameStateChangedEventSchema.parse(event)).toEqual(event);
    });
  });

  describe('leaderboardUpdateEventSchema', () => {
    it('空のエントリ配列でもパースできるべき', () => {
      const event = { type: 'leaderboard_update' as const, entries: [] };
      expect(leaderboardUpdateEventSchema.parse(event)).toEqual(event);
    });
  });

  describe('clientMessageSchema', () => {
    it('join メッセージをパースできるべき', () => {
      const msg = { action: 'join', eventId: 'event-1' };
      expect(clientMessageSchema.parse(msg)).toEqual(msg);
    });

    it('leave メッセージをパースできるべき', () => {
      const msg = { action: 'leave', eventId: 'event-1' };
      expect(clientMessageSchema.parse(msg)).toEqual(msg);
    });

    it('ping メッセージをパースできるべき', () => {
      const msg = { action: 'ping' };
      expect(clientMessageSchema.parse(msg)).toEqual(msg);
    });

    it('不正な action でエラーになるべき', () => {
      expect(() => clientMessageSchema.parse({ action: 'invalid' })).toThrow();
    });

    it('join で eventId が欠けている場合エラーになるべき', () => {
      expect(() => clientMessageSchema.parse({ action: 'join' })).toThrow();
    });
  });

  describe('serverPongSchema', () => {
    it('pong メッセージをパースできるべき', () => {
      expect(serverPongSchema.parse({ type: 'pong' })).toEqual({ type: 'pong' });
    });
  });

  describe('serverErrorSchema', () => {
    it('エラーメッセージをパースできるべき', () => {
      const msg = { type: 'error', message: 'テスト' };
      expect(serverErrorSchema.parse(msg)).toEqual(msg);
    });
  });

  describe('serverJoinedSchema', () => {
    it('joined メッセージをパースできるべき', () => {
      const msg = { type: 'joined', eventId: 'e1' };
      expect(serverJoinedSchema.parse(msg)).toEqual(msg);
    });
  });

  describe('serverLeftSchema', () => {
    it('left メッセージをパースできるべき', () => {
      const msg = { type: 'left', eventId: 'e1' };
      expect(serverLeftSchema.parse(msg)).toEqual(msg);
    });
  });
});
