/**
 * Scoring Module Tests (jam/scoring.ts)
 *
 * クルーペナルティ採点ロジックの単体テスト
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockPrisma, type MockPrisma } from './helpers/prisma-mock';

// locking モジュールをモック
vi.mock('../jam/locking', () => ({
  withLock: vi.fn((teamId, challengeId, operation) => operation()),
  withSerializableTransaction: vi.fn((operation) =>
    operation(createMockPrisma())
  ),
}));

// Prisma をモック
vi.mock('../repositories', () => ({
  prisma: createMockPrisma(),
}));

import {
  calculatePointsEarned,
  openClue,
  validateAnswer,
} from '../jam/scoring';
import { prisma } from '../repositories';
import { withLock, withSerializableTransaction } from '../jam/locking';

describe('クルーペナルティ採点', () => {
  let mockPrisma: MockPrisma;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma = prisma as unknown as MockPrisma;
  });

  describe('calculatePointsEarned', () => {
    it('ポイント獲得を計算できるべき', async () => {
      mockPrisma.taskProgress.findUnique.mockResolvedValue({
        teamId: 'team-1',
        taskId: 'task-1',
        pointsPossible: 100,
        cluePenalties: [
          { order: 0, penalty: 10 },
          { order: 1, penalty: 20 },
        ],
        pointsEarned: 0,
      });
      mockPrisma.taskProgress.update.mockResolvedValue({});

      const result = await calculatePointsEarned('team-1', 'task-1');

      expect(result).toBe(70); // 100 - 10 - 20
      expect(mockPrisma.taskProgress.update).toHaveBeenCalledWith({
        where: { teamId_taskId: { teamId: 'team-1', taskId: 'task-1' } },
        data: { pointsEarned: 70 },
      });
    });

    it('TaskProgress が見つからない場合はエラーをスローするべき', async () => {
      mockPrisma.taskProgress.findUnique.mockResolvedValue(null);

      await expect(calculatePointsEarned('team-1', 'task-1')).rejects.toThrow(
        'TaskProgress not found'
      );
    });
  });

  describe('openClue', () => {
    it('クルーを開くことができるべき', async () => {
      const mockTx = {
        taskProgress: {
          findUnique: vi.fn().mockResolvedValue({
            teamId: 'team-1',
            taskId: 'task-1',
            pointsPossible: 100,
            usedClues: [],
            cluePenalties: [],
            pointsEarned: 100,
          }),
          update: vi.fn().mockResolvedValue({}),
          findMany: vi.fn().mockResolvedValue([{ pointsEarned: 90 }]),
        },
        teamChallengeAnswer: {
          findUnique: vi.fn().mockResolvedValue({
            teamId: 'team-1',
            challengeId: 'challenge-db-1',
            started: true,
            completed: false,
          }),
        },
        clue: {
          findFirst: vi.fn().mockResolvedValue({
            id: 'clue-1',
            taskId: 'task-1',
            description: 'Hint 1',
            order: 0,
          }),
        },
        challenge: {
          findFirst: vi.fn().mockResolvedValue({
            id: 'challenge-db-1',
            title: 'Test Challenge',
          }),
        },
        taskScoring: {
          findFirst: vi.fn().mockResolvedValue({
            titleId: 'task-1',
            clue1PenaltyPoints: 10,
            clue2PenaltyPoints: 20,
            clue3PenaltyPoints: 30,
          }),
        },
        challengeStatistics: {
          upsert: vi.fn().mockResolvedValue({}),
        },
        teamLeaderboardEntry: {
          updateMany: vi.fn().mockResolvedValue({}),
        },
        team: {
          findUnique: vi
            .fn()
            .mockResolvedValue({ id: 'team-1', teamName: 'Team A' }),
        },
        eventLog: {
          create: vi.fn().mockResolvedValue({}),
        },
      };

      vi.mocked(withSerializableTransaction).mockImplementation((fn) =>
        fn(mockTx as any)
      );

      const result = await openClue(
        'event-1',
        'team-1',
        'challenge-1',
        'task-1',
        0
      );

      expect(result.success).toBe(true);
      expect(result.message).toBe('Clue opened successfully');
    });

    it('TaskProgress が見つからない場合はエラーを返すべき', async () => {
      const mockTx = {
        taskProgress: {
          findUnique: vi.fn().mockResolvedValue(null),
        },
      };

      vi.mocked(withSerializableTransaction).mockImplementation((fn) =>
        fn(mockTx as any)
      );

      const result = await openClue(
        'event-1',
        'team-1',
        'challenge-1',
        'task-1',
        0
      );

      expect(result.success).toBe(false);
      expect(result.message).toBe('Task progress not found');
    });

    it('TeamChallengeAnswer が見つからない場合はエラーを返すべき', async () => {
      const mockTx = {
        taskProgress: {
          findUnique: vi.fn().mockResolvedValue({
            usedClues: [],
          }),
        },
        teamChallengeAnswer: {
          findUnique: vi.fn().mockResolvedValue(null),
        },
      };

      vi.mocked(withSerializableTransaction).mockImplementation((fn) =>
        fn(mockTx as any)
      );

      const result = await openClue(
        'event-1',
        'team-1',
        'challenge-1',
        'task-1',
        0
      );

      expect(result.success).toBe(false);
      expect(result.message).toBe('Team challenge answer not found');
    });

    it('既に開かれているクルーの場合はエラーを返すべき', async () => {
      const mockTx = {
        taskProgress: {
          findUnique: vi.fn().mockResolvedValue({
            usedClues: [{ order: 0, description: 'Hint' }],
          }),
        },
        teamChallengeAnswer: {
          findUnique: vi.fn().mockResolvedValue({
            started: true,
            completed: false,
          }),
        },
      };

      vi.mocked(withSerializableTransaction).mockImplementation((fn) =>
        fn(mockTx as any)
      );

      const result = await openClue(
        'event-1',
        'team-1',
        'challenge-1',
        'task-1',
        0
      );

      expect(result.success).toBe(false);
      expect(result.message).toBe('Clue already opened. Please reload.');
    });

    it('チャレンジが進行中でない場合はエラーを返すべき', async () => {
      const mockTx = {
        taskProgress: {
          findUnique: vi.fn().mockResolvedValue({
            usedClues: [],
          }),
        },
        teamChallengeAnswer: {
          findUnique: vi.fn().mockResolvedValue({
            started: true,
            completed: true, // 既に完了
          }),
        },
      };

      vi.mocked(withSerializableTransaction).mockImplementation((fn) =>
        fn(mockTx as any)
      );

      const result = await openClue(
        'event-1',
        'team-1',
        'challenge-1',
        'task-1',
        0
      );

      expect(result.success).toBe(false);
      expect(result.message).toBe('Challenge is not in progress');
    });
  });

  describe('validateAnswer', () => {
    it('正解の場合は正解処理を実行するべき', async () => {
      const mockTx = {
        teamChallengeAnswer: {
          findUnique: vi.fn().mockResolvedValue({
            teamId: 'team-1',
            challengeId: 'challenge-db-1',
            started: true,
            completed: false,
            score: 50,
          }),
          update: vi.fn().mockResolvedValue({}),
          findMany: vi.fn().mockResolvedValue([{ score: 100 }]),
        },
        taskProgress: {
          findUnique: vi.fn().mockResolvedValue({
            teamId: 'team-1',
            taskId: 'task-1',
            locked: false,
            completed: false,
            pointsEarned: 50,
          }),
          update: vi.fn().mockResolvedValue({}),
          updateMany: vi.fn().mockResolvedValue({}),
        },
        challenge: {
          findFirst: vi.fn().mockResolvedValue({
            id: 'challenge-db-1',
            title: 'Test Challenge',
          }),
        },
        answer: {
          findFirst: vi.fn().mockResolvedValue({
            answerKey: 'correct-answer',
          }),
        },
        taskScoring: {
          findMany: vi.fn().mockResolvedValue([
            { titleId: 'task-1', taskNumber: 1 },
            { titleId: 'task-2', taskNumber: 2 },
          ]),
        },
        teamLeaderboardEntry: {
          updateMany: vi.fn().mockResolvedValue({}),
        },
        leaderboardEntryHistory: {
          create: vi.fn().mockResolvedValue({}),
        },
        challengeStatistics: {
          update: vi.fn().mockResolvedValue({}),
        },
        team: {
          findUnique: vi
            .fn()
            .mockResolvedValue({ id: 'team-1', teamName: 'Team A' }),
        },
        eventLog: {
          create: vi.fn().mockResolvedValue({}),
        },
      };

      vi.mocked(withLock).mockImplementation(
        async (teamId, challengeId, operation) => {
          return { success: true, result: await operation() };
        }
      );
      vi.mocked(withSerializableTransaction).mockImplementation((fn) =>
        fn(mockTx as any)
      );

      const result = await validateAnswer(
        'event-1',
        'team-1',
        'challenge-1',
        'task-1',
        'correct-answer'
      );

      expect(result.success).toBe(true);
      expect(result.correct).toBe(true);
      expect(result.message).toBe('Answer correct!');
    });

    it('不正解の場合は不正解を返すべき', async () => {
      const mockTx = {
        teamChallengeAnswer: {
          findUnique: vi.fn().mockResolvedValue({
            started: true,
            completed: false,
          }),
        },
        taskProgress: {
          findUnique: vi.fn().mockResolvedValue({
            locked: false,
            completed: false,
          }),
        },
        challenge: {
          findFirst: vi.fn().mockResolvedValue({
            id: 'challenge-db-1',
          }),
        },
        answer: {
          findFirst: vi.fn().mockResolvedValue({
            answerKey: 'correct-answer',
          }),
        },
      };

      vi.mocked(withLock).mockImplementation(
        async (teamId, challengeId, operation) => {
          return { success: true, result: await operation() };
        }
      );
      vi.mocked(withSerializableTransaction).mockImplementation((fn) =>
        fn(mockTx as any)
      );

      const result = await validateAnswer(
        'event-1',
        'team-1',
        'challenge-1',
        'task-1',
        'wrong-answer'
      );

      expect(result.success).toBe(true);
      expect(result.correct).toBe(false);
      expect(result.message).toBe('Incorrect answer');
    });

    it('ロック取得に失敗した場合はエラーを返すべき', async () => {
      vi.mocked(withLock).mockResolvedValue({
        success: false,
        error: 'Lock failed',
      });

      const result = await validateAnswer(
        'event-1',
        'team-1',
        'challenge-1',
        'task-1',
        'answer'
      );

      expect(result.success).toBe(false);
      expect(result.correct).toBe(false);
      expect(result.message).toBe('Lock failed');
    });

    it('最後のタスクを完了するとチャレンジが完了になるべき', async () => {
      const mockTx = {
        teamChallengeAnswer: {
          findUnique: vi.fn().mockResolvedValue({
            teamId: 'team-1',
            challengeId: 'challenge-db-1',
            started: true,
            completed: false,
            score: 50,
          }),
          update: vi.fn().mockResolvedValue({}),
          findMany: vi.fn().mockResolvedValue([{ score: 100 }]),
        },
        taskProgress: {
          findUnique: vi.fn().mockResolvedValue({
            teamId: 'team-1',
            taskId: 'task-2', // 最後のタスク
            locked: false,
            completed: false,
            pointsEarned: 50,
          }),
          update: vi.fn().mockResolvedValue({}),
        },
        challenge: {
          findFirst: vi.fn().mockResolvedValue({
            id: 'challenge-db-1',
            title: 'Test Challenge',
          }),
        },
        answer: {
          findFirst: vi.fn().mockResolvedValue({
            answerKey: 'correct-answer',
          }),
        },
        taskScoring: {
          findMany: vi.fn().mockResolvedValue([
            { titleId: 'task-1', taskNumber: 1 },
            { titleId: 'task-2', taskNumber: 2 }, // 最後のタスク
          ]),
        },
        teamLeaderboardEntry: {
          updateMany: vi.fn().mockResolvedValue({}),
        },
        leaderboardEntryHistory: {
          create: vi.fn().mockResolvedValue({}),
        },
        challengeStatistics: {
          update: vi.fn().mockResolvedValue({}),
        },
        team: {
          findUnique: vi
            .fn()
            .mockResolvedValue({ id: 'team-1', teamName: 'Team A' }),
        },
        eventLog: {
          create: vi.fn().mockResolvedValue({}),
        },
      };

      vi.mocked(withLock).mockImplementation(
        async (teamId, challengeId, operation) => {
          return { success: true, result: await operation() };
        }
      );
      vi.mocked(withSerializableTransaction).mockImplementation((fn) =>
        fn(mockTx as any)
      );

      const result = await validateAnswer(
        'event-1',
        'team-1',
        'challenge-1',
        'task-2',
        'correct-answer'
      );

      expect(result.success).toBe(true);
      expect(result.correct).toBe(true);
      // チャレンジ完了の更新が呼ばれることを確認
      expect(mockTx.teamChallengeAnswer.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { completed: true },
        })
      );
    });

    it('タスクが既に完了している場合はエラーを返すべき', async () => {
      const mockTx = {
        teamChallengeAnswer: {
          findUnique: vi.fn().mockResolvedValue({
            started: true,
            completed: false,
          }),
        },
        taskProgress: {
          findUnique: vi.fn().mockResolvedValue({
            locked: false,
            completed: true, // 既に完了
          }),
        },
      };

      vi.mocked(withLock).mockImplementation(
        async (teamId, challengeId, operation) => {
          return { success: true, result: await operation() };
        }
      );
      vi.mocked(withSerializableTransaction).mockImplementation((fn) =>
        fn(mockTx as any)
      );

      const result = await validateAnswer(
        'event-1',
        'team-1',
        'challenge-1',
        'task-1',
        'answer'
      );

      expect(result.success).toBe(true);
      expect(result.correct).toBe(false);
      expect(result.message).toBe('Task is not available for submission');
    });

    it('タスクがロックされている場合はエラーを返すべき', async () => {
      const mockTx = {
        teamChallengeAnswer: {
          findUnique: vi.fn().mockResolvedValue({
            started: true,
            completed: false,
          }),
        },
        taskProgress: {
          findUnique: vi.fn().mockResolvedValue({
            locked: true, // ロックされている
            completed: false,
          }),
        },
      };

      vi.mocked(withLock).mockImplementation(
        async (teamId, challengeId, operation) => {
          return { success: true, result: await operation() };
        }
      );
      vi.mocked(withSerializableTransaction).mockImplementation((fn) =>
        fn(mockTx as any)
      );

      const result = await validateAnswer(
        'event-1',
        'team-1',
        'challenge-1',
        'task-1',
        'answer'
      );

      expect(result.success).toBe(true);
      expect(result.correct).toBe(false);
      expect(result.message).toBe('Task is not available for submission');
    });

    it('チャレンジが見つからない場合はエラーを返すべき', async () => {
      const mockTx = {
        teamChallengeAnswer: {
          findUnique: vi.fn().mockResolvedValue({
            started: true,
            completed: false,
          }),
        },
        taskProgress: {
          findUnique: vi.fn().mockResolvedValue({
            locked: false,
            completed: false,
          }),
        },
        challenge: {
          findFirst: vi.fn().mockResolvedValue(null), // チャレンジが見つからない
        },
      };

      vi.mocked(withLock).mockImplementation(
        async (teamId, challengeId, operation) => {
          return { success: true, result: await operation() };
        }
      );
      vi.mocked(withSerializableTransaction).mockImplementation((fn) =>
        fn(mockTx as any)
      );

      const result = await validateAnswer(
        'event-1',
        'team-1',
        'challenge-1',
        'task-1',
        'answer'
      );

      expect(result.success).toBe(true);
      expect(result.correct).toBe(false);
      expect(result.message).toBe('Challenge not found');
    });

    it('回答キーが見つからない場合はエラーを返すべき', async () => {
      const mockTx = {
        teamChallengeAnswer: {
          findUnique: vi.fn().mockResolvedValue({
            started: true,
            completed: false,
          }),
        },
        taskProgress: {
          findUnique: vi.fn().mockResolvedValue({
            locked: false,
            completed: false,
          }),
        },
        challenge: {
          findFirst: vi.fn().mockResolvedValue({
            id: 'challenge-db-1',
          }),
        },
        answer: {
          findFirst: vi.fn().mockResolvedValue(null), // 回答が見つからない
        },
      };

      vi.mocked(withLock).mockImplementation(
        async (teamId, challengeId, operation) => {
          return { success: true, result: await operation() };
        }
      );
      vi.mocked(withSerializableTransaction).mockImplementation((fn) =>
        fn(mockTx as any)
      );

      const result = await validateAnswer(
        'event-1',
        'team-1',
        'challenge-1',
        'task-1',
        'answer'
      );

      expect(result.success).toBe(true);
      expect(result.correct).toBe(false);
      expect(result.message).toBe('Answer not found');
    });
  });
});
