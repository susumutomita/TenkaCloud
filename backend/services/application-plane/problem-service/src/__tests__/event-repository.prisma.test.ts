/**
 * DynamoEventRepository Tests
 *
 * イベントリポジトリの単体テスト（DynamoDB 実装）
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockDynamoRepo } = vi.hoisted(() => ({
  mockDynamoRepo: {
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    findById: vi.fn(),
    findByExternalId: vi.fn(),
    findByTenant: vi.fn(),
    list: vi.fn(),
    count: vi.fn(),
    updateStatus: vi.fn(),
    getEventWithProblems: vi.fn(),
    addProblemToEvent: vi.fn(),
    updateEventProblem: vi.fn(),
    removeProblemFromEvent: vi.fn(),
    registerParticipant: vi.fn(),
    isParticipantRegistered: vi.fn(),
    unregisterParticipant: vi.fn(),
    getParticipantCount: vi.fn(),
  },
}));

vi.mock('../lib/dynamodb', () => ({
  eventRepository: mockDynamoRepo,
  problemTemplateRepository: {},
}));

import {
  PrismaEventRepository,
  getEventWithProblems,
  addProblemToEvent,
  removeProblemFromEvent,
} from '../repositories/event-repository';

// DynamoDB 形式のイベントモックデータ
function makeDynamoEvent(overrides = {}) {
  return {
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
    ...overrides,
  };
}

describe('PrismaEventRepository', () => {
  let repository: PrismaEventRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    repository = new PrismaEventRepository(mockDynamoRepo as never);
  });

  describe('create', () => {
    it('新しいイベントを作成できるべき', async () => {
      mockDynamoRepo.create.mockResolvedValue(makeDynamoEvent());

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
      expect(mockDynamoRepo.create).toHaveBeenCalled();
    });

    it('デフォルト値でイベントを作成できるべき', async () => {
      mockDynamoRepo.create.mockResolvedValue(
        makeDynamoEvent({
          type: 'JAM',
          status: 'DRAFT',
          participantType: 'INDIVIDUAL',
          cloudProvider: 'LOCAL',
          scoringType: 'BATCH',
          minTeamSize: null,
          maxTeamSize: null,
          registrationDeadline: null,
          freezeLeaderboardMinutes: null,
          createdBy: null,
        })
      );

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
      mockDynamoRepo.update.mockResolvedValue(
        makeDynamoEvent({
          name: 'Updated Event',
          status: 'SCHEDULED',
          timezone: 'UTC',
          cloudProvider: 'GCP',
          scoringType: 'BATCH',
        })
      );

      const result = await repository.update('event-1', {
        name: 'Updated Event',
        status: 'scheduled',
        timezone: 'UTC',
        cloudProvider: 'gcp',
        scoringType: 'batch',
      });

      expect(result.name).toBe('Updated Event');
      expect(result.status).toBe('scheduled');
      expect(result.cloudProvider).toBe('gcp');
    });
  });

  describe('delete', () => {
    it('イベントを削除できるべき', async () => {
      mockDynamoRepo.delete.mockResolvedValue(undefined);

      await repository.delete('event-1');

      expect(mockDynamoRepo.delete).toHaveBeenCalledWith('event-1');
    });
  });

  describe('findById', () => {
    it('IDでイベントを取得できるべき', async () => {
      mockDynamoRepo.findById.mockResolvedValue(
        makeDynamoEvent({ status: 'ACTIVE' })
      );

      const result = await repository.findById('event-1');

      expect(result).not.toBeNull();
      expect(result?.id).toBe('event-1');
      expect(result?.status).toBe('active');
    });

    it('見つからない場合は null を返すべき', async () => {
      mockDynamoRepo.findById.mockResolvedValue(null);

      const result = await repository.findById('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('findByExternalId', () => {
    it('外部IDでイベントを取得できるべき', async () => {
      mockDynamoRepo.findByExternalId.mockResolvedValue(
        makeDynamoEvent({
          externalId: 'evt-external',
          type: 'JAM',
          status: 'COMPLETED',
          participantType: 'INDIVIDUAL',
          cloudProvider: 'AZURE',
          scoringType: 'BATCH',
          regions: ['eastus'],
        })
      );

      const result = await repository.findByExternalId('evt-external');

      expect(result).not.toBeNull();
      expect(result?.externalId).toBe('evt-external');
      expect(result?.cloudProvider).toBe('azure');
    });
  });

  describe('findByTenant', () => {
    it('テナントIDでイベント一覧を取得できるべき', async () => {
      mockDynamoRepo.findByTenant.mockResolvedValue([makeDynamoEvent()]);

      const result = await repository.findByTenant('tenant-1');

      expect(result).toHaveLength(1);
      expect(result[0].tenantId).toBe('tenant-1');
    });

    it('フィルター条件でイベントを取得できるべき', async () => {
      mockDynamoRepo.findByTenant.mockResolvedValue([]);

      await repository.findByTenant('tenant-1', {
        type: 'gameday',
        status: ['active', 'paused'],
        startAfter: new Date('2025-01-01'),
        startBefore: new Date('2025-12-31'),
        limit: 10,
        offset: 0,
      });

      expect(mockDynamoRepo.findByTenant).toHaveBeenCalledWith(
        'tenant-1',
        expect.objectContaining({
          type: 'GAMEDAY',
        })
      );
    });
  });

  describe('findAll', () => {
    it('すべてのイベントを取得できるべき', async () => {
      mockDynamoRepo.list.mockResolvedValue({ events: [] });

      await repository.findAll();

      expect(mockDynamoRepo.list).toHaveBeenCalled();
    });

    it('フィルター条件ですべてのイベントを取得できるべき', async () => {
      mockDynamoRepo.list.mockResolvedValue({ events: [] });

      await repository.findAll({
        tenantId: 'tenant-1',
        type: 'jam',
        status: 'draft',
        startAfter: new Date('2025-01-01'),
        startBefore: new Date('2025-06-30'),
      });

      expect(mockDynamoRepo.list).toHaveBeenCalled();
    });
  });

  describe('count', () => {
    it('イベント数をカウントできるべき', async () => {
      mockDynamoRepo.count.mockResolvedValue(10);

      const result = await repository.count();

      expect(result).toBe(10);
    });

    it('フィルター条件でカウントできるべき', async () => {
      mockDynamoRepo.count.mockResolvedValue(5);

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
      mockDynamoRepo.updateStatus.mockResolvedValue(undefined);

      await repository.updateStatus('event-1', 'active');

      expect(mockDynamoRepo.updateStatus).toHaveBeenCalledWith(
        'event-1',
        'ACTIVE'
      );
    });

    it('キャンセルステータスに更新できるべき', async () => {
      mockDynamoRepo.updateStatus.mockResolvedValue(undefined);

      await repository.updateStatus('event-1', 'cancelled');

      expect(mockDynamoRepo.updateStatus).toHaveBeenCalledWith(
        'event-1',
        'CANCELLED'
      );
    });
  });
});

describe('イベント関連ヘルパー関数', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getEventWithProblems', () => {
    it('問題を含むイベントを取得できるべき', async () => {
      mockDynamoRepo.getEventWithProblems.mockResolvedValue({
        event: { id: 'event-1', name: 'Test Event' },
        problems: [{ problemId: 'problem-1', order: 1 }],
      });

      const result = await getEventWithProblems('event-1');

      expect(result).not.toBeNull();
      expect(result?.problems).toHaveLength(1);
    });
  });

  describe('addProblemToEvent', () => {
    it('イベントに問題を追加できるべき', async () => {
      mockDynamoRepo.addProblemToEvent.mockResolvedValue({
        eventId: 'event-1',
        problemId: 'problem-1',
        order: 1,
        unlockTime: null,
        pointMultiplier: 1,
      });

      const result = await addProblemToEvent('event-1', 'problem-1');

      expect(result.order).toBe(1);
    });

    it('既存の問題をオプションで追加できるべき', async () => {
      mockDynamoRepo.addProblemToEvent.mockResolvedValue({
        eventId: 'event-1',
        problemId: 'problem-1',
        order: 2,
        unlockTime: null,
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
      mockDynamoRepo.removeProblemFromEvent.mockResolvedValue(undefined);

      await removeProblemFromEvent('event-1', 'problem-1');

      expect(mockDynamoRepo.removeProblemFromEvent).toHaveBeenCalledWith(
        'event-1',
        'problem-1'
      );
    });
  });
});
