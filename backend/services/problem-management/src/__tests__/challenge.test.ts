/**
 * Challenge Module Tests
 *
 * チャレンジ管理モジュールの単体テスト
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockPrisma, type MockPrisma } from './helpers/prisma-mock';

// Prisma をモック
vi.mock('../repositories', () => ({
  prisma: createMockPrisma(),
}));

import {
  startChallenge,
  getChallengesForTeam,
  getChallengeDetail,
} from '../jam/challenge';
import { prisma } from '../repositories';

describe('チャレンジ管理', () => {
  let mockPrisma: MockPrisma;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma = prisma as unknown as MockPrisma;
  });

  describe('startChallenge', () => {
    it('チームが見つからない場合はエラーを返すべき', async () => {
      mockPrisma.team.findUnique.mockResolvedValue(null);

      const result = await startChallenge(
        'event-1',
        'team-1',
        'challenge-1',
        'task-1'
      );

      expect(result.success).toBe(false);
      expect(result.message).toBe('Team not found');
    });

    it('チャレンジが見つからない場合はエラーを返すべき', async () => {
      mockPrisma.team.findUnique.mockResolvedValue({
        id: 'team-1',
        teamName: 'Test Team',
        eventId: 'event-1',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockPrisma.challenge.findFirst.mockResolvedValue(null);

      const result = await startChallenge(
        'event-1',
        'team-1',
        'challenge-1',
        'task-1'
      );

      expect(result.success).toBe(false);
      expect(result.message).toBe('Challenge not found');
    });

    it('チャレンジを正常に開始できるべき', async () => {
      const mockTeam = {
        id: 'team-1',
        teamName: 'Test Team',
        eventId: 'event-1',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const mockChallenge = {
        id: 'challenge-db-1',
        eventId: 'event-1',
        challengeId: 'challenge-1',
        title: 'Test Challenge',
        category: 'security',
        difficulty: 'medium',
        description: 'Test description',
        region: null,
        sshKeyPairRequired: false,
        problemId: 'problem-1',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockPrisma.team.findUnique.mockResolvedValue(mockTeam);
      mockPrisma.challenge.findFirst.mockResolvedValue(mockChallenge);
      mockPrisma.taskProgress.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.teamChallengeAnswer.upsert.mockResolvedValue({
        id: 'answer-1',
        teamId: 'team-1',
        challengeId: 'challenge-db-1',
        started: true,
        completed: false,
        score: 0,
        pessimisticLocking: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockPrisma.challengeStatistics.upsert.mockResolvedValue({});
      mockPrisma.eventLog.create.mockResolvedValue({});

      const result = await startChallenge(
        'event-1',
        'team-1',
        'challenge-1',
        'task-1'
      );

      expect(result.success).toBe(true);
      expect(result.message).toBe('Challenge started successfully');
      expect(mockPrisma.taskProgress.updateMany).toHaveBeenCalled();
      expect(mockPrisma.teamChallengeAnswer.upsert).toHaveBeenCalled();
      expect(mockPrisma.challengeStatistics.upsert).toHaveBeenCalled();
      expect(mockPrisma.eventLog.create).toHaveBeenCalled();
    });

    it('エラーが発生した場合はエラーを返すべき', async () => {
      mockPrisma.team.findUnique.mockRejectedValue(new Error('Database error'));

      const result = await startChallenge(
        'event-1',
        'team-1',
        'challenge-1',
        'task-1'
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('Database error');
    });
  });

  describe('getChallengesForTeam', () => {
    it('チャレンジ一覧を取得できるべき', async () => {
      const mockChallenges = [
        {
          id: 'challenge-db-1',
          eventId: 'event-1',
          challengeId: 'challenge-1',
          title: 'Challenge 1',
          category: 'security',
          difficulty: 'easy',
          description: 'Test',
          region: null,
          sshKeyPairRequired: false,
          problemId: 'problem-1',
          taskScorings: [{ pointsPossible: 100 }, { pointsPossible: 50 }],
          teamAnswers: [
            {
              started: true,
              completed: false,
              score: 50,
            },
          ],
        },
        {
          id: 'challenge-db-2',
          eventId: 'event-1',
          challengeId: 'challenge-2',
          title: 'Challenge 2',
          category: 'networking',
          difficulty: 'hard',
          description: 'Test 2',
          region: 'ap-northeast-1',
          sshKeyPairRequired: true,
          problemId: 'problem-2',
          taskScorings: [{ pointsPossible: 200 }],
          teamAnswers: [],
        },
      ];

      mockPrisma.challenge.findMany.mockResolvedValue(mockChallenges);

      const result = await getChallengesForTeam('event-1', 'team-1');

      expect(result.success).toBe(true);
      expect(result.challenges).toHaveLength(2);
      expect(result.challenges![0]).toEqual({
        challengeId: 'challenge-1',
        title: 'Challenge 1',
        category: 'security',
        difficulty: 'easy',
        taskScoring: 150, // 100 + 50
        started: true,
        completed: false,
        score: 50,
      });
      expect(result.challenges![1]).toEqual({
        challengeId: 'challenge-2',
        title: 'Challenge 2',
        category: 'networking',
        difficulty: 'hard',
        taskScoring: 200,
        started: false,
        completed: false,
        score: 0,
      });
    });

    it('エラーが発生した場合はエラーを返すべき', async () => {
      mockPrisma.challenge.findMany.mockRejectedValue(
        new Error('Database error')
      );

      const result = await getChallengesForTeam('event-1', 'team-1');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Database error');
    });
  });

  describe('getChallengeDetail', () => {
    it('チャレンジが見つからない場合はエラーを返すべき', async () => {
      mockPrisma.challenge.findFirst.mockResolvedValue(null);

      const result = await getChallengeDetail(
        'event-1',
        'team-1',
        'challenge-1'
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Challenge not found');
    });

    it('チャレンジ詳細を取得できるべき', async () => {
      const mockChallenge = {
        id: 'challenge-db-1',
        eventId: 'event-1',
        challengeId: 'challenge-1',
        title: 'Test Challenge',
        category: 'security',
        difficulty: 'medium',
        description: 'Test description',
        region: 'ap-northeast-1',
        sshKeyPairRequired: true,
        problemId: 'problem-1',
        tasks: [
          {
            titleId: 'task-1',
            title: 'Task 1',
            content: 'Task content',
            taskNumber: 1,
            clues: [
              { title: 'Clue 1', order: 0 },
              { title: 'Clue 2', order: 1 },
            ],
          },
        ],
        taskScorings: [
          {
            titleId: 'task-1',
            pointsPossible: 100,
            clue1PenaltyPoints: 10,
            clue2PenaltyPoints: 20,
            clue3PenaltyPoints: 30,
          },
        ],
        teamAnswers: [
          {
            completed: false,
            score: 50,
          },
        ],
      };

      const mockTaskProgress = [
        {
          taskId: 'task-1',
          locked: false,
          completed: false,
          usedClues: [{ description: 'Hint 1' }],
        },
      ];

      mockPrisma.challenge.findFirst.mockResolvedValue(mockChallenge);
      mockPrisma.taskProgress.findMany.mockResolvedValue(mockTaskProgress);

      const result = await getChallengeDetail(
        'event-1',
        'team-1',
        'challenge-1'
      );

      expect(result.success).toBe(true);
      expect(result.challenge).toBeDefined();
      expect(result.challenge!.title).toBe('Test Challenge');
      expect(result.challenge!.category).toBe('security');
      expect(result.challenge!.description).toBe('Test description');
      expect(result.challenge!.region).toBe('ap-northeast-1');
      expect(result.challenge!.sshKeyPairRequired).toBe(true);
      expect(result.challenge!.taskScoring).toBe(100);
      expect(result.challenge!.completed).toBe(false);
      expect(result.challenge!.score).toBe(50);
      expect(result.challenge!.tasks).toHaveLength(1);
      expect(result.challenge!.tasks[0].taskId).toBe('task-1');
      expect(result.challenge!.tasks[0].locked).toBe(false);
      expect(result.challenge!.tasks[0].usedClues).toEqual(['Hint 1']);
      expect(result.challenge!.tasks[0].clue1PenaltyPoints).toBe(10);
    });

    it('タスク進捗がない場合はデフォルト値を使用するべき', async () => {
      const mockChallenge = {
        id: 'challenge-db-1',
        eventId: 'event-1',
        challengeId: 'challenge-1',
        title: 'Test Challenge',
        category: 'security',
        difficulty: 'medium',
        description: 'Test description',
        region: null,
        sshKeyPairRequired: false,
        problemId: 'problem-1',
        tasks: [
          {
            titleId: 'task-1',
            title: 'Task 1',
            content: 'Task content',
            taskNumber: 1,
            clues: [],
          },
        ],
        taskScorings: [],
        teamAnswers: [],
      };

      mockPrisma.challenge.findFirst.mockResolvedValue(mockChallenge);
      mockPrisma.taskProgress.findMany.mockResolvedValue([]);

      const result = await getChallengeDetail(
        'event-1',
        'team-1',
        'challenge-1'
      );

      expect(result.success).toBe(true);
      expect(result.challenge!.tasks[0].locked).toBe(true);
      expect(result.challenge!.tasks[0].completed).toBe(false);
      expect(result.challenge!.tasks[0].usedClues).toEqual([]);
      expect(result.challenge!.completed).toBe(false);
      expect(result.challenge!.score).toBe(0);
    });

    it('エラーが発生した場合はエラーを返すべき', async () => {
      mockPrisma.challenge.findFirst.mockRejectedValue(
        new Error('Database error')
      );

      const result = await getChallengeDetail(
        'event-1',
        'team-1',
        'challenge-1'
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Database error');
    });
  });
});
