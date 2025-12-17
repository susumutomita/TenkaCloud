/**
 * Event Log Module Tests
 *
 * イベントログモジュールの単体テスト
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockPrisma, type MockPrisma } from './helpers/prisma-mock';

// Prisma をモック
vi.mock('../repositories', () => ({
  prisma: createMockPrisma(),
}));

import {
  EventLogType,
  addEventLog,
  logChallengeStart,
  logChallengeComplete,
  logTaskComplete,
  logClueUsed,
  logAnswerCorrect,
  logAnswerIncorrect,
  logScoreUpdate,
  logContestStart,
  logContestEnd,
  getEventLogs,
  getRecentLogs,
} from '../jam/eventlog';
import { prisma } from '../repositories';

describe('イベントログ', () => {
  let mockPrisma: MockPrisma;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma = prisma as unknown as MockPrisma;
  });

  describe('EventLogType', () => {
    it('すべてのログタイプが定義されているべき', () => {
      expect(EventLogType.CHALLENGE_START).toBe('challenge_start');
      expect(EventLogType.CHALLENGE_COMPLETE).toBe('challenge_complete');
      expect(EventLogType.TASK_UNLOCK).toBe('task_unlock');
      expect(EventLogType.TASK_COMPLETE).toBe('task_complete');
      expect(EventLogType.CLUE_USED).toBe('clue_used');
      expect(EventLogType.ANSWER_CORRECT).toBe('answer_correct');
      expect(EventLogType.ANSWER_INCORRECT).toBe('answer_incorrect');
      expect(EventLogType.SCORE_UPDATE).toBe('score_update');
      expect(EventLogType.CONTEST_START).toBe('contest_start');
      expect(EventLogType.CONTEST_END).toBe('contest_end');
      expect(EventLogType.TEAM_REGISTER).toBe('team_register');
    });
  });

  describe('addEventLog', () => {
    it('イベントログを追加できるべき', async () => {
      const mockLog = {
        id: 'log-1',
        eventId: 'event-1',
        teamName: 'Team A',
        message: 'Test message',
        logType: EventLogType.CHALLENGE_START,
        metadata: { key: 'value' },
        dateTimeUTC: BigInt(Date.now()),
      };

      mockPrisma.eventLog.create.mockResolvedValue(mockLog);

      const result = await addEventLog(
        'event-1',
        'Team A',
        'Test message',
        EventLogType.CHALLENGE_START,
        { key: 'value' }
      );

      expect(result.id).toBe('log-1');
      expect(result.eventId).toBe('event-1');
      expect(result.teamName).toBe('Team A');
      expect(result.message).toBe('Test message');
      expect(result.logType).toBe(EventLogType.CHALLENGE_START);
      expect(result.metadata).toEqual({ key: 'value' });
    });

    it('logType と metadata がない場合は null を保存するべき', async () => {
      const mockLog = {
        id: 'log-1',
        eventId: 'event-1',
        teamName: 'Team A',
        message: 'Test message',
        logType: null,
        metadata: null,
        dateTimeUTC: BigInt(Date.now()),
      };

      mockPrisma.eventLog.create.mockResolvedValue(mockLog);

      const result = await addEventLog('event-1', 'Team A', 'Test message');

      expect(result.logType).toBeNull();
      expect(result.metadata).toBeNull();
      expect(mockPrisma.eventLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          logType: null,
          metadata: null,
        }),
      });
    });

    it('エラーが発生した場合は例外をスローするべき', async () => {
      mockPrisma.eventLog.create.mockRejectedValue(new Error('Database error'));

      await expect(
        addEventLog('event-1', 'Team A', 'Test message')
      ).rejects.toThrow('Database error');
    });
  });

  describe('logChallengeStart', () => {
    it('チャレンジ開始ログを記録できるべき', async () => {
      const mockLog = {
        id: 'log-1',
        eventId: 'event-1',
        teamName: 'Team A',
        message: 'Start Test Challenge',
        logType: EventLogType.CHALLENGE_START,
        metadata: { challengeTitle: 'Test Challenge' },
        dateTimeUTC: BigInt(Date.now()),
      };

      mockPrisma.eventLog.create.mockResolvedValue(mockLog);

      const result = await logChallengeStart(
        'event-1',
        'Team A',
        'Test Challenge'
      );

      expect(result.message).toBe('Start Test Challenge');
      expect(result.logType).toBe(EventLogType.CHALLENGE_START);
    });
  });

  describe('logChallengeComplete', () => {
    it('チャレンジ完了ログを記録できるべき', async () => {
      const mockLog = {
        id: 'log-1',
        eventId: 'event-1',
        teamName: 'Team A',
        message: 'Completed Test Challenge with score 100',
        logType: EventLogType.CHALLENGE_COMPLETE,
        metadata: { challengeTitle: 'Test Challenge', score: 100 },
        dateTimeUTC: BigInt(Date.now()),
      };

      mockPrisma.eventLog.create.mockResolvedValue(mockLog);

      const result = await logChallengeComplete(
        'event-1',
        'Team A',
        'Test Challenge',
        100
      );

      expect(result.message).toBe('Completed Test Challenge with score 100');
      expect(result.logType).toBe(EventLogType.CHALLENGE_COMPLETE);
    });
  });

  describe('logTaskComplete', () => {
    it('タスク完了ログを記録できるべき', async () => {
      const mockLog = {
        id: 'log-1',
        eventId: 'event-1',
        teamName: 'Team A',
        message: 'Completed task: Task 1 (+50 points)',
        logType: EventLogType.TASK_COMPLETE,
        metadata: { taskTitle: 'Task 1', pointsEarned: 50 },
        dateTimeUTC: BigInt(Date.now()),
      };

      mockPrisma.eventLog.create.mockResolvedValue(mockLog);

      const result = await logTaskComplete('event-1', 'Team A', 'Task 1', 50);

      expect(result.message).toBe('Completed task: Task 1 (+50 points)');
      expect(result.logType).toBe(EventLogType.TASK_COMPLETE);
    });
  });

  describe('logClueUsed', () => {
    it('クルー使用ログを記録できるべき', async () => {
      const mockLog = {
        id: 'log-1',
        eventId: 'event-1',
        teamName: 'Team A',
        message: 'Used clue 1 for Task 1 (-10 points penalty)',
        logType: EventLogType.CLUE_USED,
        metadata: { taskTitle: 'Task 1', clueNumber: 1, penaltyPoints: 10 },
        dateTimeUTC: BigInt(Date.now()),
      };

      mockPrisma.eventLog.create.mockResolvedValue(mockLog);

      const result = await logClueUsed('event-1', 'Team A', 'Task 1', 1, 10);

      expect(result.message).toBe(
        'Used clue 1 for Task 1 (-10 points penalty)'
      );
      expect(result.logType).toBe(EventLogType.CLUE_USED);
    });
  });

  describe('logAnswerCorrect', () => {
    it('正解ログを記録できるべき', async () => {
      const mockLog = {
        id: 'log-1',
        eventId: 'event-1',
        teamName: 'Team A',
        message: 'Correct answer for Task 1',
        logType: EventLogType.ANSWER_CORRECT,
        metadata: { taskTitle: 'Task 1' },
        dateTimeUTC: BigInt(Date.now()),
      };

      mockPrisma.eventLog.create.mockResolvedValue(mockLog);

      const result = await logAnswerCorrect('event-1', 'Team A', 'Task 1');

      expect(result.message).toBe('Correct answer for Task 1');
      expect(result.logType).toBe(EventLogType.ANSWER_CORRECT);
    });
  });

  describe('logAnswerIncorrect', () => {
    it('不正解ログを記録できるべき', async () => {
      const mockLog = {
        id: 'log-1',
        eventId: 'event-1',
        teamName: 'Team A',
        message: 'Incorrect answer for Task 1',
        logType: EventLogType.ANSWER_INCORRECT,
        metadata: { taskTitle: 'Task 1' },
        dateTimeUTC: BigInt(Date.now()),
      };

      mockPrisma.eventLog.create.mockResolvedValue(mockLog);

      const result = await logAnswerIncorrect('event-1', 'Team A', 'Task 1');

      expect(result.message).toBe('Incorrect answer for Task 1');
      expect(result.logType).toBe(EventLogType.ANSWER_INCORRECT);
    });
  });

  describe('logScoreUpdate', () => {
    it('スコア更新ログを記録できるべき（正の変化）', async () => {
      const mockLog = {
        id: 'log-1',
        eventId: 'event-1',
        teamName: 'Team A',
        message: 'Score updated: 150 (+50)',
        logType: EventLogType.SCORE_UPDATE,
        metadata: { newScore: 150, delta: 50 },
        dateTimeUTC: BigInt(Date.now()),
      };

      mockPrisma.eventLog.create.mockResolvedValue(mockLog);

      const result = await logScoreUpdate('event-1', 'Team A', 150, 50);

      expect(result.message).toBe('Score updated: 150 (+50)');
    });

    it('スコア更新ログを記録できるべき（負の変化）', async () => {
      const mockLog = {
        id: 'log-1',
        eventId: 'event-1',
        teamName: 'Team A',
        message: 'Score updated: 90 (-10)',
        logType: EventLogType.SCORE_UPDATE,
        metadata: { newScore: 90, delta: -10 },
        dateTimeUTC: BigInt(Date.now()),
      };

      mockPrisma.eventLog.create.mockResolvedValue(mockLog);

      const result = await logScoreUpdate('event-1', 'Team A', 90, -10);

      expect(result.message).toBe('Score updated: 90 (-10)');
    });
  });

  describe('logContestStart', () => {
    it('コンテスト開始ログを記録できるべき', async () => {
      const mockLog = {
        id: 'log-1',
        eventId: 'event-1',
        teamName: 'SYSTEM',
        message: 'Contest "Test Contest" has started',
        logType: EventLogType.CONTEST_START,
        metadata: { contestName: 'Test Contest' },
        dateTimeUTC: BigInt(Date.now()),
      };

      mockPrisma.eventLog.create.mockResolvedValue(mockLog);

      const result = await logContestStart('event-1', 'Test Contest');

      expect(result.teamName).toBe('SYSTEM');
      expect(result.message).toBe('Contest "Test Contest" has started');
      expect(result.logType).toBe(EventLogType.CONTEST_START);
    });
  });

  describe('logContestEnd', () => {
    it('コンテスト終了ログを記録できるべき', async () => {
      const mockLog = {
        id: 'log-1',
        eventId: 'event-1',
        teamName: 'SYSTEM',
        message: 'Contest "Test Contest" has ended',
        logType: EventLogType.CONTEST_END,
        metadata: { contestName: 'Test Contest' },
        dateTimeUTC: BigInt(Date.now()),
      };

      mockPrisma.eventLog.create.mockResolvedValue(mockLog);

      const result = await logContestEnd('event-1', 'Test Contest');

      expect(result.teamName).toBe('SYSTEM');
      expect(result.message).toBe('Contest "Test Contest" has ended');
      expect(result.logType).toBe(EventLogType.CONTEST_END);
    });
  });

  describe('getEventLogs', () => {
    it('イベントログを取得できるべき', async () => {
      const mockLogs = [
        {
          id: 'log-1',
          eventId: 'event-1',
          teamName: 'Team A',
          message: 'Log 1',
          logType: EventLogType.TASK_COMPLETE,
          metadata: {},
          dateTimeUTC: BigInt(Date.now()),
        },
        {
          id: 'log-2',
          eventId: 'event-1',
          teamName: 'Team B',
          message: 'Log 2',
          logType: null,
          metadata: null,
          dateTimeUTC: BigInt(Date.now() - 1000),
        },
      ];

      mockPrisma.eventLog.findMany.mockResolvedValue(mockLogs);
      mockPrisma.eventLog.count.mockResolvedValue(2);

      const result = await getEventLogs('event-1');

      expect(result.logs).toHaveLength(2);
      expect(result.total).toBe(2);
      expect(result.hasMore).toBe(false);
    });

    it('ページネーションが動作するべき', async () => {
      const mockLogs = Array(51)
        .fill(null)
        .map((_, i) => ({
          id: `log-${i}`,
          eventId: 'event-1',
          teamName: 'Team A',
          message: `Log ${i}`,
          logType: null,
          metadata: null,
          dateTimeUTC: BigInt(Date.now() - i * 1000),
        }));

      mockPrisma.eventLog.findMany.mockResolvedValue(mockLogs);
      mockPrisma.eventLog.count.mockResolvedValue(100);

      const result = await getEventLogs('event-1', { limit: 50, offset: 0 });

      expect(result.logs).toHaveLength(50);
      expect(result.hasMore).toBe(true);
    });

    it('teamName でフィルタリングできるべき', async () => {
      mockPrisma.eventLog.findMany.mockResolvedValue([]);
      mockPrisma.eventLog.count.mockResolvedValue(0);

      await getEventLogs('event-1', { teamName: 'Team A' });

      expect(mockPrisma.eventLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ teamName: 'Team A' }),
        })
      );
    });

    it('since でフィルタリングできるべき', async () => {
      const since = BigInt(Date.now() - 3600000);
      mockPrisma.eventLog.findMany.mockResolvedValue([]);
      mockPrisma.eventLog.count.mockResolvedValue(0);

      await getEventLogs('event-1', { since });

      expect(mockPrisma.eventLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ dateTimeUTC: { gte: since } }),
        })
      );
    });

    it('エラーが発生した場合は例外をスローするべき', async () => {
      mockPrisma.eventLog.findMany.mockRejectedValue(
        new Error('Database error')
      );

      await expect(getEventLogs('event-1')).rejects.toThrow('Database error');
    });
  });

  describe('getRecentLogs', () => {
    it('最近のログを取得できるべき', async () => {
      const since = BigInt(Date.now() - 60000);
      const mockLogs = [
        {
          id: 'log-1',
          eventId: 'event-1',
          teamName: 'Team A',
          message: 'Recent log',
          logType: EventLogType.TASK_COMPLETE,
          metadata: {},
          dateTimeUTC: BigInt(Date.now()),
        },
      ];

      mockPrisma.eventLog.findMany.mockResolvedValue(mockLogs);

      const result = await getRecentLogs('event-1', since);

      expect(result).toHaveLength(1);
      expect(result[0].message).toBe('Recent log');
      expect(mockPrisma.eventLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            eventId: 'event-1',
            dateTimeUTC: { gt: since },
          },
          orderBy: { dateTimeUTC: 'asc' },
        })
      );
    });

    it('エラーが発生した場合は例外をスローするべき', async () => {
      mockPrisma.eventLog.findMany.mockRejectedValue(
        new Error('Database error')
      );

      await expect(getRecentLogs('event-1', BigInt(0))).rejects.toThrow(
        'Database error'
      );
    });
  });
});
