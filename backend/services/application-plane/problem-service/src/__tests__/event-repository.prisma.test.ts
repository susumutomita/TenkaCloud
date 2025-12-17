/**
 * PrismaEventRepository Tests
 *
 * イベントリポジトリの単体テスト
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockPrisma, type MockPrisma } from './helpers/prisma-mock';

// Prisma をモック
vi.mock('../repositories/prisma-client', () => ({
  prisma: createMockPrisma(),
}));

import {
  PrismaEventRepository,
  getEventWithProblems,
  addProblemToEvent,
  removeProblemFromEvent,
} from '../repositories/event-repository';
import { prisma } from '../repositories/prisma-client';

describe('PrismaEventRepository', () => {
  let mockPrisma: MockPrisma;
  let repository: PrismaEventRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma = prisma as unknown as MockPrisma;
    repository = new PrismaEventRepository();
  });

  describe('create', () => {
    it('新しいイベントを作成できるべき', async () => {
      const mockEvent = {
        id: 'event-1',
        externalId: 'evt-123',
        tenantId: 'tenant-1',
        name: 'Test Event',
        type: 'GAMEDAY',
        status: 'DRAFT',
        startTime: new Date('2025-01-01'),
        endTime: new Date('2025-01-02'),
        timezone: 'Asia/Tokyo',
        participantType: 'TEAM',
        maxParticipants: 100,
        minTeamSize: 2,
        maxTeamSize: 5,
        registrationDeadline: new Date('2024-12-31'),
        cloudProvider: 'AWS',
        regions: ['ap-northeast-1'],
        scoringType: 'REALTIME',
        scoringIntervalMinutes: 5,
        leaderboardVisible: true,
        freezeLeaderboardMinutes: 10,
        createdAt: new Date(),
        updatedAt: new Date(),
        createdBy: 'user-1',
      };

      mockPrisma.event.create.mockResolvedValue(mockEvent);

      const result = await repository.create({
        externalId: 'evt-123',
        tenantId: 'tenant-1',
        name: 'Test Event',
        type: 'gameday',
        status: 'draft',
        startTime: new Date('2025-01-01'),
        endTime: new Date('2025-01-02'),
        timezone: 'Asia/Tokyo',
        participantType: 'team',
        maxParticipants: 100,
        minTeamSize: 2,
        maxTeamSize: 5,
        registrationDeadline: new Date('2024-12-31'),
        cloudProvider: 'aws',
        regions: ['ap-northeast-1'],
        scoringType: 'realtime',
        scoringIntervalMinutes: 5,
        leaderboardVisible: true,
        freezeLeaderboardMinutes: 10,
        createdBy: 'user-1',
      });

      expect(result.id).toBe('event-1');
      expect(result.name).toBe('Test Event');
      expect(result.type).toBe('gameday');
      expect(result.status).toBe('draft');
      expect(mockPrisma.event.create).toHaveBeenCalled();
    });

    it('デフォルト値でイベントを作成できるべき', async () => {
      const mockEvent = {
        id: 'event-1',
        externalId: 'evt-123',
        tenantId: 'tenant-1',
        name: 'Test Event',
        type: 'JAM',
        status: 'DRAFT',
        startTime: new Date('2025-01-01'),
        endTime: new Date('2025-01-02'),
        timezone: 'Asia/Tokyo',
        participantType: 'INDIVIDUAL',
        maxParticipants: 50,
        minTeamSize: null,
        maxTeamSize: null,
        registrationDeadline: null,
        cloudProvider: 'LOCAL',
        regions: ['local'],
        scoringType: 'BATCH',
        scoringIntervalMinutes: 10,
        leaderboardVisible: true,
        freezeLeaderboardMinutes: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        createdBy: null,
      };

      mockPrisma.event.create.mockResolvedValue(mockEvent);

      const result = await repository.create({
        tenantId: 'tenant-1',
        name: 'Test Event',
        type: 'jam',
        startTime: new Date('2025-01-01'),
        endTime: new Date('2025-01-02'),
        participantType: 'individual',
        maxParticipants: 50,
        cloudProvider: 'local',
        regions: ['local'],
        scoringType: 'batch',
        scoringIntervalMinutes: 10,
      });

      expect(result.type).toBe('jam');
      expect(result.participantType).toBe('individual');
      expect(result.cloudProvider).toBe('local');
    });
  });

  describe('update', () => {
    it('イベントを更新できるべき', async () => {
      const mockEvent = {
        id: 'event-1',
        externalId: 'evt-123',
        tenantId: 'tenant-1',
        name: 'Updated Event',
        type: 'GAMEDAY',
        status: 'SCHEDULED',
        startTime: new Date('2025-01-01'),
        endTime: new Date('2025-01-02'),
        timezone: 'UTC',
        participantType: 'TEAM',
        maxParticipants: 200,
        minTeamSize: 3,
        maxTeamSize: 6,
        registrationDeadline: new Date('2024-12-30'),
        cloudProvider: 'GCP',
        regions: ['us-central1'],
        scoringType: 'BATCH',
        scoringIntervalMinutes: 10,
        leaderboardVisible: false,
        freezeLeaderboardMinutes: 20,
        createdAt: new Date(),
        updatedAt: new Date(),
        createdBy: 'user-1',
      };

      mockPrisma.event.update.mockResolvedValue(mockEvent);

      const result = await repository.update('event-1', {
        name: 'Updated Event',
        status: 'scheduled',
        timezone: 'UTC',
        participantType: 'team',
        maxParticipants: 200,
        minTeamSize: 3,
        maxTeamSize: 6,
        registrationDeadline: new Date('2024-12-30'),
        cloudProvider: 'gcp',
        regions: ['us-central1'],
        scoringType: 'batch',
        scoringIntervalMinutes: 10,
        leaderboardVisible: false,
        freezeLeaderboardMinutes: 20,
      });

      expect(result.name).toBe('Updated Event');
      expect(result.status).toBe('scheduled');
      expect(result.cloudProvider).toBe('gcp');
    });
  });

  describe('delete', () => {
    it('イベントを削除できるべき', async () => {
      mockPrisma.event.delete.mockResolvedValue({});

      await repository.delete('event-1');

      expect(mockPrisma.event.delete).toHaveBeenCalledWith({
        where: { id: 'event-1' },
      });
    });
  });

  describe('findById', () => {
    it('IDでイベントを取得できるべき', async () => {
      const mockEvent = {
        id: 'event-1',
        externalId: 'evt-123',
        tenantId: 'tenant-1',
        name: 'Test Event',
        type: 'GAMEDAY',
        status: 'ACTIVE',
        startTime: new Date('2025-01-01'),
        endTime: new Date('2025-01-02'),
        timezone: 'Asia/Tokyo',
        participantType: 'TEAM',
        maxParticipants: 100,
        minTeamSize: 2,
        maxTeamSize: 5,
        registrationDeadline: null,
        cloudProvider: 'AWS',
        regions: ['ap-northeast-1'],
        scoringType: 'REALTIME',
        scoringIntervalMinutes: 5,
        leaderboardVisible: true,
        freezeLeaderboardMinutes: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        createdBy: 'user-1',
      };

      mockPrisma.event.findUnique.mockResolvedValue(mockEvent);

      const result = await repository.findById('event-1');

      expect(result).not.toBeNull();
      expect(result?.id).toBe('event-1');
      expect(result?.status).toBe('active');
    });

    it('見つからない場合は null を返すべき', async () => {
      mockPrisma.event.findUnique.mockResolvedValue(null);

      const result = await repository.findById('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('findByExternalId', () => {
    it('外部IDでイベントを取得できるべき', async () => {
      const mockEvent = {
        id: 'event-1',
        externalId: 'evt-external',
        tenantId: 'tenant-1',
        name: 'Test Event',
        type: 'JAM',
        status: 'COMPLETED',
        startTime: new Date('2025-01-01'),
        endTime: new Date('2025-01-02'),
        timezone: 'Asia/Tokyo',
        participantType: 'INDIVIDUAL',
        maxParticipants: 50,
        minTeamSize: null,
        maxTeamSize: null,
        registrationDeadline: null,
        cloudProvider: 'AZURE',
        regions: ['eastus'],
        scoringType: 'BATCH',
        scoringIntervalMinutes: 10,
        leaderboardVisible: true,
        freezeLeaderboardMinutes: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        createdBy: null,
      };

      mockPrisma.event.findUnique.mockResolvedValue(mockEvent);

      const result = await repository.findByExternalId('evt-external');

      expect(result).not.toBeNull();
      expect(result?.externalId).toBe('evt-external');
      expect(result?.cloudProvider).toBe('azure');
    });
  });

  describe('findByTenant', () => {
    it('テナントIDでイベント一覧を取得できるべき', async () => {
      const mockEvents = [
        {
          id: 'event-1',
          externalId: 'evt-1',
          tenantId: 'tenant-1',
          name: 'Event 1',
          type: 'GAMEDAY',
          status: 'ACTIVE',
          startTime: new Date('2025-01-01'),
          endTime: new Date('2025-01-02'),
          timezone: 'Asia/Tokyo',
          participantType: 'TEAM',
          maxParticipants: 100,
          minTeamSize: null,
          maxTeamSize: null,
          registrationDeadline: null,
          cloudProvider: 'AWS',
          regions: ['ap-northeast-1'],
          scoringType: 'REALTIME',
          scoringIntervalMinutes: 5,
          leaderboardVisible: true,
          freezeLeaderboardMinutes: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          createdBy: null,
        },
      ];

      mockPrisma.event.findMany.mockResolvedValue(mockEvents);

      const result = await repository.findByTenant('tenant-1');

      expect(result).toHaveLength(1);
      expect(result[0].tenantId).toBe('tenant-1');
    });

    it('フィルター条件でイベントを取得できるべき', async () => {
      mockPrisma.event.findMany.mockResolvedValue([]);

      await repository.findByTenant('tenant-1', {
        type: 'gameday',
        status: ['active', 'paused'],
        startAfter: new Date('2025-01-01'),
        startBefore: new Date('2025-12-31'),
        limit: 10,
        offset: 0,
      });

      expect(mockPrisma.event.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            tenantId: 'tenant-1',
            type: 'GAMEDAY',
          }),
        })
      );
    });
  });

  describe('findAll', () => {
    it('すべてのイベントを取得できるべき', async () => {
      mockPrisma.event.findMany.mockResolvedValue([]);

      await repository.findAll();

      expect(mockPrisma.event.findMany).toHaveBeenCalled();
    });

    it('フィルター条件ですべてのイベントを取得できるべき', async () => {
      mockPrisma.event.findMany.mockResolvedValue([]);

      await repository.findAll({
        tenantId: 'tenant-1',
        type: 'jam',
        status: 'draft',
        startAfter: new Date('2025-01-01'),
        startBefore: new Date('2025-06-30'),
      });

      expect(mockPrisma.event.findMany).toHaveBeenCalled();
    });
  });

  describe('count', () => {
    it('イベント数をカウントできるべき', async () => {
      mockPrisma.event.count.mockResolvedValue(10);

      const result = await repository.count();

      expect(result).toBe(10);
    });

    it('フィルター条件でカウントできるべき', async () => {
      mockPrisma.event.count.mockResolvedValue(5);

      const result = await repository.count({
        tenantId: 'tenant-1',
        type: 'gameday',
        status: ['active'],
        startAfter: new Date('2025-01-01'),
        startBefore: new Date('2025-06-30'),
      });

      expect(result).toBe(5);
    });
  });

  describe('updateStatus', () => {
    it('イベントステータスを更新できるべき', async () => {
      mockPrisma.event.update.mockResolvedValue({});

      await repository.updateStatus('event-1', 'active');

      expect(mockPrisma.event.update).toHaveBeenCalledWith({
        where: { id: 'event-1' },
        data: { status: 'ACTIVE' },
      });
    });

    it('キャンセルステータスに更新できるべき', async () => {
      mockPrisma.event.update.mockResolvedValue({});

      await repository.updateStatus('event-1', 'cancelled');

      expect(mockPrisma.event.update).toHaveBeenCalledWith({
        where: { id: 'event-1' },
        data: { status: 'CANCELLED' },
      });
    });
  });
});

describe('イベント関連ヘルパー関数', () => {
  let mockPrisma: MockPrisma;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma = prisma as unknown as MockPrisma;
  });

  describe('getEventWithProblems', () => {
    it('問題を含むイベントを取得できるべき', async () => {
      const mockEvent = {
        id: 'event-1',
        name: 'Test Event',
        problems: [
          {
            problemId: 'problem-1',
            order: 1,
            problem: {
              title: 'Problem 1',
              criteria: [],
            },
          },
        ],
      };

      mockPrisma.event.findUnique.mockResolvedValue(mockEvent);

      const result = await getEventWithProblems('event-1');

      expect(result).not.toBeNull();
      expect(result?.problems).toHaveLength(1);
    });
  });

  describe('addProblemToEvent', () => {
    it('イベントに問題を追加できるべき', async () => {
      mockPrisma.eventProblem.findUnique.mockResolvedValue(null);
      mockPrisma.eventProblem.count.mockResolvedValue(0);
      mockPrisma.eventProblem.create.mockResolvedValue({
        eventId: 'event-1',
        problemId: 'problem-1',
        order: 1,
        unlockTime: null,
        pointMultiplier: 1,
      });

      const result = await addProblemToEvent('event-1', 'problem-1');

      expect(result.order).toBe(1);
    });

    it('既存の問題を更新できるべき', async () => {
      mockPrisma.eventProblem.findUnique.mockResolvedValue({
        eventId: 'event-1',
        problemId: 'problem-1',
        order: 1,
      });
      mockPrisma.eventProblem.update.mockResolvedValue({
        eventId: 'event-1',
        problemId: 'problem-1',
        order: 2,
        pointMultiplier: 1.5,
      });

      const result = await addProblemToEvent('event-1', 'problem-1', {
        order: 2,
        pointMultiplier: 1.5,
      });

      expect(result.order).toBe(2);
    });
  });

  describe('removeProblemFromEvent', () => {
    it('イベントから問題を削除できるべき', async () => {
      mockPrisma.eventProblem.delete.mockResolvedValue({});

      await removeProblemFromEvent('event-1', 'problem-1');

      expect(mockPrisma.eventProblem.delete).toHaveBeenCalledWith({
        where: {
          eventId_problemId: { eventId: 'event-1', problemId: 'problem-1' },
        },
      });
    });
  });
});
