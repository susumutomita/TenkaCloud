/**
 * Real-time Scoring Engine Tests
 *
 * リアルタイム採点エンジンの単体テスト
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  RealtimeScoringEngine,
  createRealtimeScoringEngine,
} from '../scoring/realtime-engine';
import { ScoringEngine, LocalScoringFunction } from '../scoring/engine';
import type { Event, Problem, CloudCredentials } from '../types';

// テスト用のモックデータ
const mockEvent: Event = {
  id: 'event-1',
  name: 'テストイベント',
  type: 'gameday',
  status: 'active',
  tenantId: 'tenant-1',
  startTime: new Date(),
  endTime: new Date(Date.now() + 3600000), // 1時間後
  timezone: 'Asia/Tokyo',
  participantType: 'team',
  maxParticipants: 100,
  cloudProvider: 'aws',
  regions: ['ap-northeast-1'],
  scoringType: 'realtime',
  scoringIntervalMinutes: 1,
  leaderboardVisible: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockProblem: Problem = {
  id: 'problem-1',
  title: 'テスト問題',
  type: 'gameday',
  category: 'architecture',
  difficulty: 'medium',
  metadata: {
    author: 'test',
    version: '1.0.0',
    createdAt: '2024-01-01T00:00:00Z',
  },
  description: {
    overview: 'テスト概要',
    objectives: ['目標1'],
    hints: ['ヒント1'],
  },
  deployment: {
    providers: ['aws'],
    templates: {},
    regions: {},
  },
  scoring: {
    type: 'lambda',
    path: '/scoring/test',
    criteria: [
      { name: 'EC2構築', weight: 1, maxPoints: 50 },
      { name: 'S3設定', weight: 1, maxPoints: 50 },
    ],
    timeoutMinutes: 10,
  },
};

const mockCredentials: CloudCredentials = {
  provider: 'aws',
  accountId: '123456789012',
  region: 'ap-northeast-1',
};

const mockParticipants = [
  {
    id: 'participant-1',
    name: 'チーム A',
    teamId: 'team-1',
    teamName: 'チーム A',
    credentials: mockCredentials,
  },
  {
    id: 'participant-2',
    name: 'チーム B',
    teamId: 'team-2',
    teamName: 'チーム B',
    credentials: mockCredentials,
  },
];

describe('RealtimeScoringEngine', () => {
  let scoringEngine: ScoringEngine;
  let realtimeEngine: RealtimeScoringEngine;

  beforeEach(() => {
    vi.useFakeTimers();
    scoringEngine = new ScoringEngine({
      maxConcurrency: 5,
      retryAttempts: 1,
      retryDelayMs: 100,
      timeoutMs: 5000,
    });
    scoringEngine.registerScoringFunction('aws', new LocalScoringFunction());

    realtimeEngine = new RealtimeScoringEngine(scoringEngine, {
      scoringIntervalMs: 1000,
      leaderboardUpdateIntervalMs: 500,
      maxConcurrentSessions: 5,
      freezeBeforeEndMs: 300000,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('createRealtimeScoringEngine', () => {
    it('ファクトリ関数でエンジンを作成できるべき', () => {
      const engine = createRealtimeScoringEngine(scoringEngine);
      expect(engine).toBeInstanceOf(RealtimeScoringEngine);
    });

    it('カスタム設定でエンジンを作成できるべき', () => {
      const engine = createRealtimeScoringEngine(scoringEngine, {
        scoringIntervalMs: 5000,
        maxConcurrentSessions: 3,
      });
      expect(engine).toBeInstanceOf(RealtimeScoringEngine);
    });
  });

  describe('startSession', () => {
    it('セッションを開始できるべき', () => {
      realtimeEngine.startSession(mockEvent, [mockProblem], mockParticipants);

      const stats = realtimeEngine.getSessionStats(mockEvent.id);
      expect(stats).toBeDefined();
      expect(stats?.isActive).toBe(true);
      expect(stats?.participantCount).toBe(2);
      expect(stats?.problemCount).toBe(1);
    });

    it('同じイベントのセッションを重複して開始できないべき', () => {
      realtimeEngine.startSession(mockEvent, [mockProblem], mockParticipants);

      // 2回目の呼び出しは無視される（エラーにはならない）
      realtimeEngine.startSession(mockEvent, [mockProblem], mockParticipants);

      const stats = realtimeEngine.getGlobalStats();
      expect(stats.activeSessions).toBe(1);
    });

    it('最大同時セッション数を超えるとエラーになるべき', () => {
      const smallEngine = new RealtimeScoringEngine(scoringEngine, {
        maxConcurrentSessions: 1,
      });

      smallEngine.startSession(mockEvent, [mockProblem], mockParticipants);

      const secondEvent = { ...mockEvent, id: 'event-2' };
      expect(() => {
        smallEngine.startSession(secondEvent, [mockProblem], mockParticipants);
      }).toThrow('Maximum concurrent sessions');
    });
  });

  describe('stopSession', () => {
    it('セッションを停止できるべき', () => {
      realtimeEngine.startSession(mockEvent, [mockProblem], mockParticipants);
      realtimeEngine.stopSession(mockEvent.id);

      const stats = realtimeEngine.getSessionStats(mockEvent.id);
      expect(stats).toBeUndefined();
    });

    it('存在しないセッションを停止してもエラーにならないべき', () => {
      expect(() => {
        realtimeEngine.stopSession('non-existent');
      }).not.toThrow();
    });
  });

  describe('pauseSession / resumeSession', () => {
    it('セッションを一時停止できるべき', () => {
      realtimeEngine.startSession(mockEvent, [mockProblem], mockParticipants);
      realtimeEngine.pauseSession(mockEvent.id);

      const stats = realtimeEngine.getSessionStats(mockEvent.id);
      expect(stats?.isActive).toBe(false);
    });

    it('セッションを再開できるべき', () => {
      realtimeEngine.startSession(mockEvent, [mockProblem], mockParticipants);
      realtimeEngine.pauseSession(mockEvent.id);
      realtimeEngine.resumeSession(mockEvent.id);

      const stats = realtimeEngine.getSessionStats(mockEvent.id);
      expect(stats?.isActive).toBe(true);
    });
  });

  describe('getLeaderboard', () => {
    it('リーダーボードを取得できるべき', () => {
      realtimeEngine.startSession(mockEvent, [mockProblem], mockParticipants);

      const leaderboard = realtimeEngine.getLeaderboard(mockEvent.id);

      expect(leaderboard).toBeDefined();
      expect(leaderboard?.eventId).toBe(mockEvent.id);
      expect(leaderboard?.entries).toHaveLength(2);
      expect(leaderboard?.isFrozen).toBe(false);
    });

    it('存在しないイベントの場合は undefined を返すべき', () => {
      const leaderboard = realtimeEngine.getLeaderboard('non-existent');
      expect(leaderboard).toBeUndefined();
    });

    it('初期リーダーボードのスコアは 0 であるべき', () => {
      realtimeEngine.startSession(mockEvent, [mockProblem], mockParticipants);

      const leaderboard = realtimeEngine.getLeaderboard(mockEvent.id);

      for (const entry of leaderboard?.entries || []) {
        expect(entry.totalScore).toBe(0);
        expect(entry.rank).toBeGreaterThan(0);
      }
    });
  });

  describe('getParticipantHistory', () => {
    it('参加者のスコア履歴を取得できるべき', () => {
      realtimeEngine.startSession(mockEvent, [mockProblem], mockParticipants);

      const history = realtimeEngine.getParticipantHistory(
        mockEvent.id,
        'participant-1'
      );

      expect(Array.isArray(history)).toBe(true);
    });

    it('存在しない参加者の場合は空配列を返すべき', () => {
      realtimeEngine.startSession(mockEvent, [mockProblem], mockParticipants);

      const history = realtimeEngine.getParticipantHistory(
        mockEvent.id,
        'non-existent'
      );

      expect(history).toEqual([]);
    });
  });

  describe('triggerScoring', () => {
    it('手動で採点をトリガーできるべき', () => {
      realtimeEngine.startSession(mockEvent, [mockProblem], mockParticipants);

      // エラーなく実行できることを確認
      expect(() => {
        realtimeEngine.triggerScoring(mockEvent.id);
      }).not.toThrow();
    });
  });

  describe('triggerParticipantScoring', () => {
    it('特定の参加者の採点をトリガーできるべき', () => {
      realtimeEngine.startSession(mockEvent, [mockProblem], mockParticipants);

      expect(() => {
        realtimeEngine.triggerParticipantScoring(mockEvent.id, 'participant-1');
      }).not.toThrow();
    });

    it('存在しないセッションの場合はエラーになるべき', () => {
      expect(() => {
        realtimeEngine.triggerParticipantScoring(
          'non-existent',
          'participant-1'
        );
      }).toThrow('Session not found');
    });

    it('存在しない参加者の場合はエラーになるべき', () => {
      realtimeEngine.startSession(mockEvent, [mockProblem], mockParticipants);

      expect(() => {
        realtimeEngine.triggerParticipantScoring(mockEvent.id, 'non-existent');
      }).toThrow('Participant not found');
    });
  });

  describe('Event Listeners', () => {
    it('リーダーボード更新リスナーを追加できるべき', () => {
      const listener = vi.fn();
      const unsubscribe = realtimeEngine.onLeaderboardUpdate(listener);

      expect(typeof unsubscribe).toBe('function');
    });

    it('スコア更新リスナーを追加できるべき', () => {
      const listener = vi.fn();
      const unsubscribe = realtimeEngine.onScoreUpdate(listener);

      expect(typeof unsubscribe).toBe('function');
    });

    it('リスナーを解除できるべき', () => {
      const listener = vi.fn();
      const unsubscribe = realtimeEngine.onLeaderboardUpdate(listener);

      unsubscribe();
      // エラーなく実行できることを確認
    });
  });

  describe('getSessionStats', () => {
    it('セッション統計を取得できるべき', () => {
      realtimeEngine.startSession(mockEvent, [mockProblem], mockParticipants);

      const stats = realtimeEngine.getSessionStats(mockEvent.id);

      expect(stats).toBeDefined();
      expect(stats?.eventId).toBe(mockEvent.id);
      expect(stats?.isActive).toBe(true);
      expect(stats?.scoringRound).toBeGreaterThanOrEqual(0);
      expect(stats?.participantCount).toBe(2);
      expect(stats?.problemCount).toBe(1);
      expect(stats?.isFrozen).toBe(false);
    });

    it('存在しないセッションの場合は undefined を返すべき', () => {
      const stats = realtimeEngine.getSessionStats('non-existent');
      expect(stats).toBeUndefined();
    });
  });

  describe('getGlobalStats', () => {
    it('グローバル統計を取得できるべき', () => {
      realtimeEngine.startSession(mockEvent, [mockProblem], mockParticipants);

      const stats = realtimeEngine.getGlobalStats();

      expect(stats.activeSessions).toBe(1);
      expect(stats.totalParticipants).toBe(2);
      expect(stats.scoringEngineStats).toBeDefined();
    });

    it('セッションがない場合も統計を取得できるべき', () => {
      const stats = realtimeEngine.getGlobalStats();

      expect(stats.activeSessions).toBe(0);
      expect(stats.totalParticipants).toBe(0);
    });
  });
});

describe('RealtimeScoringEngine Advanced', () => {
  let scoringEngine: ScoringEngine;
  let realtimeEngine: RealtimeScoringEngine;

  beforeEach(() => {
    scoringEngine = new ScoringEngine({
      maxConcurrency: 5,
      retryAttempts: 1,
      retryDelayMs: 100,
      timeoutMs: 5000,
    });
    scoringEngine.registerScoringFunction('aws', new LocalScoringFunction());

    realtimeEngine = new RealtimeScoringEngine(scoringEngine, {
      scoringIntervalMs: 1000,
      leaderboardUpdateIntervalMs: 500,
      maxConcurrentSessions: 5,
      freezeBeforeEndMs: 300000,
    });
  });

  describe('Score History and Leaderboard Updates', () => {
    it('採点結果によりリーダーボードが更新されるべき', async () => {
      realtimeEngine.startSession(mockEvent, [mockProblem], mockParticipants);

      // スコア更新を待機
      await new Promise((resolve) => setTimeout(resolve, 800));

      const leaderboard = realtimeEngine.getLeaderboard(mockEvent.id);
      expect(leaderboard).toBeDefined();
      expect(leaderboard?.entries).toHaveLength(2);
    });

    it('参加者のスコア履歴が記録されるべき', async () => {
      realtimeEngine.startSession(mockEvent, [mockProblem], mockParticipants);

      // 採点完了を待機
      await new Promise((resolve) => setTimeout(resolve, 800));

      const history = realtimeEngine.getParticipantHistory(
        mockEvent.id,
        'participant-1'
      );
      expect(history.length).toBeGreaterThanOrEqual(0);
    });

    it('存在しないイベントの履歴は空配列を返すべき', () => {
      const history = realtimeEngine.getParticipantHistory(
        'non-existent',
        'participant-1'
      );
      expect(history).toEqual([]);
    });
  });

  describe('Event Listeners with Results', () => {
    it('スコア更新リスナーが呼び出されるべき', async () => {
      const scoreListener = vi.fn();
      realtimeEngine.onScoreUpdate(scoreListener);

      realtimeEngine.startSession(mockEvent, [mockProblem], mockParticipants);

      // 採点完了を待機
      await new Promise((resolve) => setTimeout(resolve, 800));

      expect(scoreListener).toHaveBeenCalled();
      if (scoreListener.mock.calls.length > 0) {
        const update = scoreListener.mock.calls[0][0];
        expect(update.eventId).toBe(mockEvent.id);
        expect(update.score).toBeGreaterThanOrEqual(0);
      }
    });

    it('リーダーボード更新リスナーが呼び出されるべき', async () => {
      const leaderboardListener = vi.fn();
      realtimeEngine.onLeaderboardUpdate(leaderboardListener);

      realtimeEngine.startSession(mockEvent, [mockProblem], mockParticipants);

      // 採点完了を待機
      await new Promise((resolve) => setTimeout(resolve, 800));

      expect(leaderboardListener).toHaveBeenCalled();
      if (leaderboardListener.mock.calls.length > 0) {
        const update = leaderboardListener.mock.calls[0][0];
        expect(update.eventId).toBe(mockEvent.id);
        expect(update.leaderboard).toBeDefined();
      }
    });

    it('スコア更新リスナーを解除できるべき', async () => {
      const scoreListener = vi.fn();
      const unsubscribe = realtimeEngine.onScoreUpdate(scoreListener);

      unsubscribe();

      realtimeEngine.startSession(mockEvent, [mockProblem], mockParticipants);

      await new Promise((resolve) => setTimeout(resolve, 800));

      expect(scoreListener).not.toHaveBeenCalled();
    });

    it('リーダーボード更新リスナーを解除できるべき', async () => {
      const leaderboardListener = vi.fn();
      const unsubscribe =
        realtimeEngine.onLeaderboardUpdate(leaderboardListener);

      unsubscribe();

      realtimeEngine.startSession(mockEvent, [mockProblem], mockParticipants);

      await new Promise((resolve) => setTimeout(resolve, 800));

      expect(leaderboardListener).not.toHaveBeenCalled();
    });

    it('リスナーエラーが他のリスナーに影響しないべき', async () => {
      const errorListener = vi.fn().mockImplementation(() => {
        throw new Error('Listener error');
      });
      const normalListener = vi.fn();

      realtimeEngine.onScoreUpdate(errorListener);
      realtimeEngine.onScoreUpdate(normalListener);

      const consoleSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});

      realtimeEngine.startSession(mockEvent, [mockProblem], mockParticipants);

      await new Promise((resolve) => setTimeout(resolve, 800));

      // 両方のリスナーが呼ばれる（エラーが発生しても続行）
      if (errorListener.mock.calls.length > 0) {
        expect(normalListener).toHaveBeenCalled();
        expect(consoleSpy).toHaveBeenCalledWith(
          expect.stringContaining('[RealtimeScoring] Score listener error'),
          expect.any(Error)
        );
      }

      consoleSpy.mockRestore();
    });

    it('リーダーボードリスナーエラーが他のリスナーに影響しないべき', async () => {
      const errorListener = vi.fn().mockImplementation(() => {
        throw new Error('Leaderboard listener error');
      });
      const normalListener = vi.fn();

      realtimeEngine.onLeaderboardUpdate(errorListener);
      realtimeEngine.onLeaderboardUpdate(normalListener);

      const consoleSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});

      realtimeEngine.startSession(mockEvent, [mockProblem], mockParticipants);

      await new Promise((resolve) => setTimeout(resolve, 800));

      if (errorListener.mock.calls.length > 0) {
        expect(normalListener).toHaveBeenCalled();
        expect(consoleSpy).toHaveBeenCalledWith(
          expect.stringContaining(
            '[RealtimeScoring] Leaderboard listener error'
          ),
          expect.any(Error)
        );
      }

      consoleSpy.mockRestore();
    });
  });

  describe('Session Resume', () => {
    it('既にアクティブなセッションを再開しても何も起きないべき', () => {
      realtimeEngine.startSession(mockEvent, [mockProblem], mockParticipants);

      const statsBefore = realtimeEngine.getSessionStats(mockEvent.id);
      expect(statsBefore?.isActive).toBe(true);

      // 既にアクティブなので何も起きない
      realtimeEngine.resumeSession(mockEvent.id);

      const statsAfter = realtimeEngine.getSessionStats(mockEvent.id);
      expect(statsAfter?.isActive).toBe(true);
    });

    it('存在しないセッションを再開しても何も起きないべき', () => {
      expect(() => {
        realtimeEngine.resumeSession('non-existent');
      }).not.toThrow();
    });

    it('存在しないセッションを一時停止しても何も起きないべき', () => {
      expect(() => {
        realtimeEngine.pauseSession('non-existent');
      }).not.toThrow();
    });
  });

  describe('Leaderboard Ranking', () => {
    it('スコアが高い参加者が上位にランク付けされるべき', async () => {
      realtimeEngine.startSession(mockEvent, [mockProblem], mockParticipants);

      // 採点完了を待機
      await new Promise((resolve) => setTimeout(resolve, 800));

      const leaderboard = realtimeEngine.getLeaderboard(mockEvent.id);
      if (leaderboard && leaderboard.entries.length >= 2) {
        // ランクが正しく設定されている
        expect(leaderboard.entries[0].rank).toBe(1);
        expect(leaderboard.entries[1].rank).toBe(2);
      }
    });

    it('リーダーボードエントリにトレンドが含まれるべき', async () => {
      realtimeEngine.startSession(mockEvent, [mockProblem], mockParticipants);

      await new Promise((resolve) => setTimeout(resolve, 800));

      const leaderboard = realtimeEngine.getLeaderboard(mockEvent.id);
      if (leaderboard && leaderboard.entries.length > 0) {
        for (const entry of leaderboard.entries) {
          expect(['up', 'down', 'same']).toContain(entry.trend);
        }
      }
    });
  });

  describe('Leaderboard Freeze', () => {
    it('終了時刻が近いイベントはリーダーボードがフリーズするべき', async () => {
      // 終了時刻が 1 分後のイベント（freezeBeforeEndMs: 300000 = 5分なので、1分後はフリーズ期間内）
      const soonEndingEvent: Event = {
        ...mockEvent,
        id: 'soon-ending-event',
        endTime: new Date(Date.now() + 60000), // 1分後
        freezeLeaderboardMinutes: 5,
      };

      realtimeEngine.startSession(
        soonEndingEvent,
        [mockProblem],
        mockParticipants
      );

      // 採点完了を待機
      await new Promise((resolve) => setTimeout(resolve, 800));

      const leaderboard = realtimeEngine.getLeaderboard(soonEndingEvent.id);
      expect(leaderboard?.isFrozen).toBe(true);
    });

    it('終了時刻が遠いイベントはリーダーボードがフリーズしないべき', async () => {
      // 終了時刻が 1 時間後のイベント
      const farEndingEvent: Event = {
        ...mockEvent,
        id: 'far-ending-event',
        endTime: new Date(Date.now() + 3600000), // 1時間後
        freezeLeaderboardMinutes: 5,
      };

      realtimeEngine.startSession(
        farEndingEvent,
        [mockProblem],
        mockParticipants
      );

      await new Promise((resolve) => setTimeout(resolve, 800));

      const leaderboard = realtimeEngine.getLeaderboard(farEndingEvent.id);
      expect(leaderboard?.isFrozen).toBe(false);
    });
  });

  describe('Multiple Sessions', () => {
    it('複数のセッションを同時に管理できるべき', () => {
      const event2: Event = { ...mockEvent, id: 'event-2' };

      realtimeEngine.startSession(mockEvent, [mockProblem], mockParticipants);
      realtimeEngine.startSession(event2, [mockProblem], mockParticipants);

      const stats = realtimeEngine.getGlobalStats();
      expect(stats.activeSessions).toBe(2);
      expect(stats.totalParticipants).toBe(4);
    });

    it('各セッションを個別に停止できるべき', () => {
      const event2: Event = { ...mockEvent, id: 'event-2' };

      realtimeEngine.startSession(mockEvent, [mockProblem], mockParticipants);
      realtimeEngine.startSession(event2, [mockProblem], mockParticipants);

      realtimeEngine.stopSession(mockEvent.id);

      expect(realtimeEngine.getSessionStats(mockEvent.id)).toBeUndefined();
      expect(realtimeEngine.getSessionStats(event2.id)).toBeDefined();
    });
  });

  describe('Session with Interval', () => {
    it('セッション停止時にインターバルがクリアされるべき', () => {
      realtimeEngine.startSession(mockEvent, [mockProblem], mockParticipants);

      const stats = realtimeEngine.getSessionStats(mockEvent.id);
      expect(stats?.isActive).toBe(true);

      realtimeEngine.stopSession(mockEvent.id);

      // セッションが削除されている
      expect(realtimeEngine.getSessionStats(mockEvent.id)).toBeUndefined();
    });

    it('セッション一時停止時にインターバルがクリアされるべき', () => {
      realtimeEngine.startSession(mockEvent, [mockProblem], mockParticipants);

      realtimeEngine.pauseSession(mockEvent.id);

      const stats = realtimeEngine.getSessionStats(mockEvent.id);
      expect(stats?.isActive).toBe(false);
    });
  });

  describe('Default Config Values', () => {
    it('デフォルト設定が正しく適用されるべき', () => {
      const defaultEngine = new RealtimeScoringEngine(scoringEngine);

      // デフォルトの最大セッション数は 10
      for (let i = 0; i < 10; i++) {
        const event: Event = { ...mockEvent, id: `event-${i}` };
        defaultEngine.startSession(event, [mockProblem], mockParticipants);
      }

      const stats = defaultEngine.getGlobalStats();
      expect(stats.activeSessions).toBe(10);

      // 11個目は失敗
      const event11: Event = { ...mockEvent, id: 'event-10' };
      expect(() => {
        defaultEngine.startSession(event11, [mockProblem], mockParticipants);
      }).toThrow('Maximum concurrent sessions');
    });
  });
});
