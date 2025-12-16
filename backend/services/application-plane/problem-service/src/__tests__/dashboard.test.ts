/**
 * Dashboard Module Tests
 *
 * ダッシュボード・リーダーボード機能の単体テスト
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockPrisma, type MockPrisma } from './helpers/prisma-mock';

// Prisma をモック
vi.mock('../repositories', () => ({
  prisma: createMockPrisma(),
}));

import {
  getLeaderboard,
  getTeamDashboard,
  getChallengeStatistics,
  getEventDashboard,
  saveLeaderboardSnapshot,
} from '../jam/dashboard';
import { prisma } from '../repositories';

describe('ダッシュボード・リーダーボード', () => {
  let mockPrisma: MockPrisma;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma = prisma as unknown as MockPrisma;
  });

  describe('getLeaderboard', () => {
    it('リーダーボードを取得できるべき', async () => {
      mockPrisma.teamChallengeAnswer.groupBy
        .mockResolvedValueOnce([
          { teamId: 'team-1', _sum: { score: 150 }, _count: { _all: 2 } },
          { teamId: 'team-2', _sum: { score: 100 }, _count: { _all: 2 } },
        ])
        .mockResolvedValueOnce([
          { teamId: 'team-1', _count: { _all: 1 } },
          { teamId: 'team-2', _count: { _all: 0 } },
        ]);

      mockPrisma.team.findMany.mockResolvedValue([
        { id: 'team-1', teamName: 'Team A' },
        { id: 'team-2', teamName: 'Team B' },
      ]);

      mockPrisma.challenge.count.mockResolvedValue(3);

      const result = await getLeaderboard('event-1');

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual(
        expect.objectContaining({
          rank: 1,
          teamId: 'team-1',
          teamName: 'Team A',
          score: 150,
          completedChallenges: 1,
          totalChallenges: 3,
        })
      );
      expect(result[1]).toEqual(
        expect.objectContaining({
          rank: 2,
          teamId: 'team-2',
          teamName: 'Team B',
          score: 100,
          completedChallenges: 0,
          totalChallenges: 3,
        })
      );
    });

    it('チームが見つからない場合は Unknown を表示するべき', async () => {
      mockPrisma.teamChallengeAnswer.groupBy
        .mockResolvedValueOnce([
          { teamId: 'team-1', _sum: { score: 100 }, _count: { _all: 1 } },
        ])
        .mockResolvedValueOnce([]);

      mockPrisma.team.findMany.mockResolvedValue([]);
      mockPrisma.challenge.count.mockResolvedValue(1);

      const result = await getLeaderboard('event-1');

      expect(result[0].teamName).toBe('Unknown');
    });

    it('limit パラメータが動作するべき', async () => {
      const teams = Array(10)
        .fill(null)
        .map((_, i) => ({
          teamId: `team-${i}`,
          _sum: { score: 100 - i * 10 },
          _count: { _all: 1 },
        }));

      mockPrisma.teamChallengeAnswer.groupBy
        .mockResolvedValueOnce(teams)
        .mockResolvedValueOnce([]);

      mockPrisma.team.findMany.mockResolvedValue(
        teams.map((t) => ({ id: t.teamId, teamName: `Team ${t.teamId}` }))
      );
      mockPrisma.challenge.count.mockResolvedValue(1);

      const result = await getLeaderboard('event-1', 5);

      expect(result).toHaveLength(5);
    });

    it('エラーが発生した場合は例外をスローするべき', async () => {
      mockPrisma.teamChallengeAnswer.groupBy.mockRejectedValue(
        new Error('Database error')
      );

      await expect(getLeaderboard('event-1')).rejects.toThrow('Database error');
    });
  });

  describe('getTeamDashboard', () => {
    beforeEach(() => {
      // getLeaderboard のモック設定
      mockPrisma.teamChallengeAnswer.groupBy
        .mockResolvedValueOnce([
          { teamId: 'team-1', _sum: { score: 100 }, _count: { _all: 1 } },
        ])
        .mockResolvedValueOnce([{ teamId: 'team-1', _count: { _all: 1 } }]);

      mockPrisma.team.findMany.mockResolvedValue([
        { id: 'team-1', teamName: 'Team A' },
      ]);
      mockPrisma.challenge.count.mockResolvedValue(2);
    });

    it('チームダッシュボードを取得できるべき', async () => {
      mockPrisma.team.findUnique.mockResolvedValue({
        id: 'team-1',
        teamName: 'Team A',
      });

      mockPrisma.challenge.findMany.mockResolvedValue([
        {
          challengeId: 'challenge-1',
          title: 'Challenge 1',
          category: 'security',
          taskScorings: [{ pointsPossible: 100 }],
          teamAnswers: [{ started: true, completed: false, score: 50 }],
        },
      ]);

      mockPrisma.eventLog.findMany.mockResolvedValue([
        {
          message: 'Activity 1',
          dateTimeUTC: BigInt(Date.now()),
        },
      ]);

      const result = await getTeamDashboard('event-1', 'team-1');

      expect(result.team.teamId).toBe('team-1');
      expect(result.team.teamName).toBe('Team A');
      expect(result.team.rank).toBe(1);
      expect(result.challenges).toHaveLength(1);
      expect(result.challenges[0]).toEqual(
        expect.objectContaining({
          challengeId: 'challenge-1',
          title: 'Challenge 1',
          started: true,
          completed: false,
          score: 50,
          maxScore: 100,
        })
      );
      expect(result.recentActivity).toHaveLength(1);
    });

    it('チームが見つからない場合はエラーをスローするべき', async () => {
      mockPrisma.team.findUnique.mockResolvedValue(null);

      await expect(getTeamDashboard('event-1', 'team-1')).rejects.toThrow(
        'Team not found'
      );
    });

    it('リーダーボードにチームがない場合はランク0を返すべき', async () => {
      // getLeaderboard が空のリストを返すようにモック
      mockPrisma.teamChallengeAnswer.groupBy
        .mockReset()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);
      mockPrisma.team.findMany.mockReset().mockResolvedValue([]);

      mockPrisma.team.findUnique.mockResolvedValue({
        id: 'team-1',
        teamName: 'Team A',
      });
      mockPrisma.challenge.findMany.mockResolvedValue([]);
      mockPrisma.eventLog.findMany.mockResolvedValue([]);

      const result = await getTeamDashboard('event-1', 'team-1');

      expect(result.team.rank).toBe(0);
      expect(result.team.score).toBe(0);
    });
  });

  describe('getChallengeStatistics', () => {
    it('チャレンジ統計を取得できるべき', async () => {
      mockPrisma.challengeStatistics.findMany.mockResolvedValue([
        {
          challengeId: 'challenge-db-1',
          title: 'Challenge 1',
          totalStartedChallenge: 5,
          totalCompletedChallenge: 3,
          averageScore: 75,
          teamsStartedChallenge: ['Team A', 'Team B'],
          teamsCompletedChallenge: ['Team A'],
          challenge: { challengeId: 'challenge-1' },
        },
      ]);

      const result = await getChallengeStatistics('event-1');

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        challengeId: 'challenge-1',
        title: 'Challenge 1',
        totalStarted: 5,
        totalCompleted: 3,
        averageScore: 75,
        teamsStarted: ['Team A', 'Team B'],
        teamsCompleted: ['Team A'],
      });
    });

    it('エラーが発生した場合は例外をスローするべき', async () => {
      mockPrisma.challengeStatistics.findMany.mockRejectedValue(
        new Error('Database error')
      );

      await expect(getChallengeStatistics('event-1')).rejects.toThrow(
        'Database error'
      );
    });
  });

  describe('getEventDashboard', () => {
    it('イベントダッシュボードを取得できるべき', async () => {
      // getLeaderboard のモック
      mockPrisma.teamChallengeAnswer.groupBy
        .mockResolvedValueOnce([
          { teamId: 'team-1', _sum: { score: 100 }, _count: { _all: 1 } },
        ])
        .mockResolvedValueOnce([{ teamId: 'team-1', _count: { _all: 1 } }]);

      mockPrisma.team.findMany.mockResolvedValue([
        { id: 'team-1', teamName: 'Team A' },
      ]);

      // getChallengeStatistics のモック
      mockPrisma.challengeStatistics.findMany.mockResolvedValue([]);

      // その他のモック
      mockPrisma.team.count.mockResolvedValue(5);
      mockPrisma.challenge.count.mockResolvedValue(3);
      mockPrisma.eventLog.findMany.mockResolvedValue([
        {
          teamName: 'Team A',
          message: 'Log 1',
          dateTimeUTC: BigInt(Date.now()),
        },
      ]);

      const result = await getEventDashboard('event-1');

      expect(result.eventId).toBe('event-1');
      expect(result.eventName).toBe('Event event-1');
      expect(result.leaderboard).toHaveLength(1);
      expect(result.totalTeams).toBe(5);
      expect(result.totalChallenges).toBe(3);
      expect(result.recentLogs).toHaveLength(1);
    });

    it('エラーが発生した場合は例外をスローするべき', async () => {
      mockPrisma.teamChallengeAnswer.groupBy.mockRejectedValue(
        new Error('Database error')
      );

      await expect(getEventDashboard('event-1')).rejects.toThrow(
        'Database error'
      );
    });
  });

  describe('saveLeaderboardSnapshot', () => {
    it('リーダーボードスナップショットを保存できるべき', async () => {
      // getLeaderboard のモック
      mockPrisma.teamChallengeAnswer.groupBy
        .mockResolvedValueOnce([
          { teamId: 'team-1', _sum: { score: 100 }, _count: { _all: 1 } },
        ])
        .mockResolvedValueOnce([{ teamId: 'team-1', _count: { _all: 1 } }]);

      mockPrisma.team.findMany.mockResolvedValue([
        { id: 'team-1', teamName: 'Team A' },
      ]);
      mockPrisma.challenge.count.mockResolvedValue(1);

      mockPrisma.teamLeaderboardEntry.upsert.mockResolvedValue({});
      mockPrisma.leaderboardEntryHistory.create.mockResolvedValue({});

      await saveLeaderboardSnapshot('event-1');

      expect(mockPrisma.teamLeaderboardEntry.upsert).toHaveBeenCalled();
      expect(mockPrisma.leaderboardEntryHistory.create).toHaveBeenCalled();
    });

    it('エラーが発生した場合は例外をスローするべき', async () => {
      mockPrisma.teamChallengeAnswer.groupBy.mockRejectedValue(
        new Error('Database error')
      );

      await expect(saveLeaderboardSnapshot('event-1')).rejects.toThrow(
        'Database error'
      );
    });
  });
});
