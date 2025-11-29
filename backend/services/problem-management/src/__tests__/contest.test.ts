/**
 * Contest Module Tests
 *
 * コンテスト管理モジュールの単体テスト
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockPrisma, type MockPrisma } from './helpers/prisma-mock';

// eventlog モジュールをモック
vi.mock('../jam/eventlog', () => ({
  logContestStart: vi.fn().mockResolvedValue({}),
  logContestEnd: vi.fn().mockResolvedValue({}),
}));

// Prisma をモック
vi.mock('../repositories', () => ({
  prisma: createMockPrisma(),
}));

import {
  ContestStatus,
  createContest,
  startContest,
  stopContest,
  pauseContest,
  resumeContest,
  addChallengeToContest,
  removeChallengeFromContest,
  registerTeamToContest,
  getContestTeams,
} from '../jam/contest';
import { prisma } from '../repositories';
import { logContestStart, logContestEnd } from '../jam/eventlog';

describe('コンテスト管理', () => {
  let mockPrisma: MockPrisma;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma = prisma as unknown as MockPrisma;
  });

  describe('ContestStatus', () => {
    it('すべてのステータス値が定義されているべき', () => {
      expect(ContestStatus.DRAFT).toBe('draft');
      expect(ContestStatus.SCHEDULED).toBe('scheduled');
      expect(ContestStatus.RUNNING).toBe('running');
      expect(ContestStatus.PAUSED).toBe('paused');
      expect(ContestStatus.ENDED).toBe('ended');
    });
  });

  describe('createContest', () => {
    it('新しいコンテストを作成できるべき', async () => {
      const contestData = {
        eventId: 'event-1',
        name: 'Test Contest',
        description: 'Test Description',
        duration: 120,
        maxTeams: 50,
        challengeIds: ['challenge-1', 'challenge-2'],
      };

      const result = await createContest(contestData);

      expect(result.id).toBe('contest-event-1');
      expect(result.eventId).toBe('event-1');
      expect(result.name).toBe('Test Contest');
      expect(result.description).toBe('Test Description');
      expect(result.status).toBe(ContestStatus.DRAFT);
      expect(result.duration).toBe(120);
      expect(result.maxTeams).toBe(50);
      expect(result.challenges).toEqual(['challenge-1', 'challenge-2']);
      expect(result.createdAt).toBeInstanceOf(Date);
      expect(result.updatedAt).toBeInstanceOf(Date);
    });

    it('デフォルト値で作成できるべき', async () => {
      const contestData = {
        eventId: 'event-1',
        name: 'Test Contest',
        duration: 60,
      };

      const result = await createContest(contestData);

      expect(result.description).toBe('');
      expect(result.maxTeams).toBeUndefined();
      expect(result.challenges).toEqual([]);
    });
  });

  describe('startContest', () => {
    it('コンテストを開始できるべき', async () => {
      const result = await startContest('event-1', 'Test Contest');

      expect(result.success).toBe(true);
      expect(result.message).toBe(
        'Contest "Test Contest" started successfully'
      );
      expect(result.startTime).toBeInstanceOf(Date);
      expect(logContestStart).toHaveBeenCalledWith('event-1', 'Test Contest');
    });

    it('エラーが発生した場合はエラーを返すべき', async () => {
      vi.mocked(logContestStart).mockRejectedValueOnce(new Error('Log error'));

      const result = await startContest('event-1', 'Test Contest');

      expect(result.success).toBe(false);
      expect(result.message).toContain('Log error');
    });
  });

  describe('stopContest', () => {
    it('コンテストを停止できるべき', async () => {
      mockPrisma.teamChallengeAnswer.updateMany.mockResolvedValue({ count: 5 });
      mockPrisma.teamChallengeAnswer.groupBy.mockResolvedValue([
        { teamId: 'team-1', _sum: { score: 100 } },
        { teamId: 'team-2', _sum: { score: 80 } },
      ]);
      mockPrisma.team.findMany.mockResolvedValue([
        { id: 'team-1', teamName: 'Team A' },
        { id: 'team-2', teamName: 'Team B' },
      ]);

      const result = await stopContest('event-1', 'Test Contest');

      expect(result.success).toBe(true);
      expect(result.message).toBe('Contest "Test Contest" ended successfully');
      expect(result.endTime).toBeInstanceOf(Date);
      expect(result.finalLeaderboard).toHaveLength(2);
      expect(result.finalLeaderboard![0]).toEqual({
        rank: 1,
        teamName: 'Team A',
        score: 100,
      });
      expect(result.finalLeaderboard![1]).toEqual({
        rank: 2,
        teamName: 'Team B',
        score: 80,
      });
      expect(logContestEnd).toHaveBeenCalledWith('event-1', 'Test Contest');
    });

    it('チームが見つからない場合は Unknown を表示するべき', async () => {
      mockPrisma.teamChallengeAnswer.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.teamChallengeAnswer.groupBy.mockResolvedValue([
        { teamId: 'team-1', _sum: { score: 50 } },
      ]);
      mockPrisma.team.findMany.mockResolvedValue([]);

      const result = await stopContest('event-1', 'Test Contest');

      expect(result.finalLeaderboard![0].teamName).toBe('Unknown');
    });

    it('エラーが発生した場合はエラーを返すべき', async () => {
      mockPrisma.teamChallengeAnswer.updateMany.mockRejectedValue(
        new Error('Database error')
      );

      const result = await stopContest('event-1', 'Test Contest');

      expect(result.success).toBe(false);
      expect(result.message).toContain('Database error');
    });
  });

  describe('pauseContest', () => {
    it('コンテストを一時停止できるべき', async () => {
      const result = await pauseContest('event-1');

      expect(result.success).toBe(true);
      expect(result.message).toBe('Contest paused');
    });
  });

  describe('resumeContest', () => {
    it('コンテストを再開できるべき', async () => {
      const result = await resumeContest('event-1');

      expect(result.success).toBe(true);
      expect(result.message).toBe('Contest resumed');
    });
  });

  describe('addChallengeToContest', () => {
    it('チャレンジをコンテストに追加できるべき', async () => {
      const mockChallenge = { id: 'challenge-db-1' };

      mockPrisma.$transaction.mockImplementation(async (fn) => {
        const tx = {
          challenge: { create: vi.fn().mockResolvedValue(mockChallenge) },
          task: { create: vi.fn().mockResolvedValue({ id: 'task-1' }) },
          clue: { create: vi.fn().mockResolvedValue({}) },
          answer: { create: vi.fn().mockResolvedValue({}) },
          taskScoring: { create: vi.fn().mockResolvedValue({}) },
          challengeStatistics: { create: vi.fn().mockResolvedValue({}) },
        };
        return fn(tx);
      });

      const result = await addChallengeToContest('event-1', {
        problemId: 'problem-1',
        challengeId: 'challenge-1',
        title: 'Test Challenge',
        category: 'security',
        difficulty: 'medium',
        description: 'Test description',
        region: 'ap-northeast-1',
        sshKeyPairRequired: true,
        tasks: [
          {
            titleId: 'task-1',
            title: 'Task 1',
            content: 'Task content',
            taskNumber: 1,
            answerKey: 'answer123',
            clues: [{ title: 'Clue 1', description: 'Hint 1', order: 0 }],
            scoring: {
              pointsPossible: 100,
              clue1PenaltyPoints: 10,
              clue2PenaltyPoints: 20,
              clue3PenaltyPoints: 30,
            },
          },
        ],
      });

      expect(result.success).toBe(true);
      expect(result.challengeDbId).toBe('challenge-db-1');
    });

    it('エラーが発生した場合はエラーを返すべき', async () => {
      mockPrisma.$transaction.mockRejectedValue(new Error('Transaction error'));

      const result = await addChallengeToContest('event-1', {
        problemId: 'problem-1',
        challengeId: 'challenge-1',
        title: 'Test',
        category: 'test',
        difficulty: 'easy',
        description: 'Test',
        tasks: [],
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('Transaction error');
    });
  });

  describe('removeChallengeFromContest', () => {
    it('チャレンジをコンテストから削除できるべき', async () => {
      mockPrisma.challenge.findFirst.mockResolvedValue({
        id: 'challenge-db-1',
        challengeId: 'challenge-1',
      });
      mockPrisma.challenge.delete.mockResolvedValue({});

      const result = await removeChallengeFromContest('event-1', 'challenge-1');

      expect(result.success).toBe(true);
      expect(mockPrisma.challenge.delete).toHaveBeenCalledWith({
        where: { id: 'challenge-db-1' },
      });
    });

    it('チャレンジが見つからない場合はエラーを返すべき', async () => {
      mockPrisma.challenge.findFirst.mockResolvedValue(null);

      const result = await removeChallengeFromContest('event-1', 'challenge-1');

      expect(result.success).toBe(false);
      expect(result.message).toBe('Challenge not found');
    });

    it('エラーが発生した場合はエラーを返すべき', async () => {
      mockPrisma.challenge.findFirst.mockRejectedValue(
        new Error('Database error')
      );

      const result = await removeChallengeFromContest('event-1', 'challenge-1');

      expect(result.success).toBe(false);
      expect(result.message).toContain('Database error');
    });
  });

  describe('registerTeamToContest', () => {
    it('チームをコンテストに登録できるべき', async () => {
      const mockTeam = { id: 'team-1', teamName: 'Test Team' };
      const mockChallenges = [
        {
          id: 'challenge-db-1',
          tasks: [{ titleId: 'task-1', taskNumber: 1 }],
          taskScorings: [{ titleId: 'task-1', pointsPossible: 100 }],
        },
      ];

      mockPrisma.team.create.mockResolvedValue(mockTeam);
      mockPrisma.challenge.findMany.mockResolvedValue(mockChallenges);
      mockPrisma.teamChallengeAnswer.create.mockResolvedValue({});
      mockPrisma.taskProgress.create.mockResolvedValue({});

      const result = await registerTeamToContest('event-1', {
        teamName: 'Test Team',
        members: ['member-1'],
      });

      expect(result.success).toBe(true);
      expect(result.teamId).toBe('team-1');
      expect(mockPrisma.team.create).toHaveBeenCalled();
      expect(mockPrisma.teamChallengeAnswer.create).toHaveBeenCalled();
      expect(mockPrisma.taskProgress.create).toHaveBeenCalled();
    });

    it('タスクナンバーが1の場合はアンロック状態にするべき', async () => {
      const mockTeam = { id: 'team-1', teamName: 'Test Team' };
      const mockChallenges = [
        {
          id: 'challenge-db-1',
          tasks: [
            { titleId: 'task-1', taskNumber: 1 },
            { titleId: 'task-2', taskNumber: 2 },
          ],
          taskScorings: [
            { titleId: 'task-1', pointsPossible: 100 },
            { titleId: 'task-2', pointsPossible: 50 },
          ],
        },
      ];

      mockPrisma.team.create.mockResolvedValue(mockTeam);
      mockPrisma.challenge.findMany.mockResolvedValue(mockChallenges);
      mockPrisma.teamChallengeAnswer.create.mockResolvedValue({});
      mockPrisma.taskProgress.create.mockResolvedValue({});

      await registerTeamToContest('event-1', { teamName: 'Test Team' });

      // 最初のタスクはロック解除
      expect(mockPrisma.taskProgress.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            taskId: 'task-1',
            locked: false,
          }),
        })
      );

      // 2番目のタスクはロック状態
      expect(mockPrisma.taskProgress.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            taskId: 'task-2',
            locked: true,
          }),
        })
      );
    });

    it('エラーが発生した場合はエラーを返すべき', async () => {
      mockPrisma.team.create.mockRejectedValue(new Error('Database error'));

      const result = await registerTeamToContest('event-1', {
        teamName: 'Test Team',
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('Database error');
    });
  });

  describe('getContestTeams', () => {
    it('コンテストの参加チーム一覧を取得できるべき', async () => {
      mockPrisma.teamChallengeAnswer.findMany.mockResolvedValue([
        {
          teamId: 'team-1',
          team: { teamName: 'Team A' },
          score: 100,
          started: true,
          completed: true,
        },
        {
          teamId: 'team-1',
          team: { teamName: 'Team A' },
          score: 50,
          started: true,
          completed: false,
        },
        {
          teamId: 'team-2',
          team: { teamName: 'Team B' },
          score: 80,
          started: true,
          completed: true,
        },
      ]);

      const result = await getContestTeams('event-1');

      expect(result).toHaveLength(2);
      const teamA = result.find((t) => t.teamId === 'team-1');
      expect(teamA).toBeDefined();
      expect(teamA!.teamName).toBe('Team A');
      expect(teamA!.score).toBe(150); // 100 + 50
      expect(teamA!.startedChallenges).toBe(2);
      expect(teamA!.completedChallenges).toBe(1);
    });

    it('エラーが発生した場合は例外をスローするべき', async () => {
      mockPrisma.teamChallengeAnswer.findMany.mockRejectedValue(
        new Error('Database error')
      );

      await expect(getContestTeams('event-1')).rejects.toThrow(
        'Database error'
      );
    });
  });
});
